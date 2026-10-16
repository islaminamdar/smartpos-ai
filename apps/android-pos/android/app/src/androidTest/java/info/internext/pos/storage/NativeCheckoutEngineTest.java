package info.internext.pos.storage;

import static org.junit.Assert.*;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.OfflineBundle;
import info.internext.pos.offline.OfflineClock;
import info.internext.pos.offline.SignedProtocol;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real Android SQLite and Keystore, synthetic profiles and ephemeral server signing key only. */
@RunWith(AndroidJUnit4.class)
public class NativeCheckoutEngineTest {
    private Context context; private String dbName,alias; private NativeJournal journal; private DeviceIdentity identity;
    private NativeCheckoutEngine engine; private OfflineBundle.Binding binding; private KeyPair server; private PublicKey device;
    private JSONObject snapshot,authority; private String snapshotEnvelope,authorityEnvelope,boot=UUID.randomUUID().toString();
    private final long start=1_792_132_200_000L; private long wall=start,elapsed=1000; private boolean locked=false,failSigning=false,failCommit=false;
    private AtomicInteger signatures=new AtomicInteger();
    @Before public void setUp() throws Exception {
        context=InstrumentationRegistry.getInstrumentation().getTargetContext(); dbName="checkout-audit-"+UUID.randomUUID()+".db";alias="internext.pos.test.checkout."+UUID.randomUUID();
        journal=new NativeJournal(context,dbName,()->{if(failCommit)throw new IllegalStateException("synthetic_full_disk");});
        identity=new DeviceIdentity(alias);JSONObject id=identity.readOrCreate(journal);device=SignedProtocol.publicKey(SignedProtocol.decode(id.getString("publicKeySpkiBase64Url"),256));
        KeyPairGenerator gen=KeyPairGenerator.getInstance("EC");gen.initialize(new ECGenParameterSpec("secp256r1"));server=gen.generateKeyPair();
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream in=InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("pos-offline-output.json")){byte[] b=new byte[4096];int n;while((n=in.read(b))!=-1)bytes.write(b,0,n);}
        JSONObject reservation=new JSONObject(bytes.toString("UTF-8")).getJSONObject("reservation");snapshot=reservation.getJSONObject("snapshot");authority=reservation.getJSONObject("authority");
        authority.put("deviceKeySha256",id.getString("deviceKeySha256")).put("issuedAt",NativeCheckoutEngine.iso(start)).put("notBefore",NativeCheckoutEngine.iso(start)).put("expiresAt",NativeCheckoutEngine.iso(start+3_600_000));
        snapshot.put("createdAt",NativeCheckoutEngine.iso(start));
        binding=new OfflineBundle.Binding(authority.getString("organizationId"),authority.getString("branchId"),authority.getString("deviceId"),authority.getString("actorId"),authority.getString("shiftId"),authority.getString("keyEpoch"),authority.getString("deviceKeySha256"));
        rebuild();engine=createEngine(journal);engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start);
    }
    private NativeCheckoutEngine createEngine(NativeJournal j)throws Exception{return new NativeCheckoutEngine(j,Collections.singletonMap("synthetic-server",server.getPublic()),binding,device,b->{if(locked)throw new IllegalStateException("locked");},()->new OfflineClock.Reading(boot,elapsed,wall),bytes->{signatures.incrementAndGet();if(failSigning)throw new IllegalStateException("signing_failed");return identity.sign(bytes);});}
    private void rebuild()throws Exception{authority.put("snapshotSha256",SignedProtocol.hash(CanonicalJson.bytes(snapshot)));snapshotEnvelope=SignedProtocol.sign(snapshot,"synthetic-server",server.getPrivate(),server.getPublic());authorityEnvelope=SignedProtocol.sign(authority,"synthetic-server",server.getPrivate(),server.getPublic());}
    @After public void tearDown()throws Exception{if(journal!=null)journal.close();assertTrue(context.deleteDatabase(dbName));KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);ks.deleteEntry(alias);assertFalse(ks.containsAlias(alias));}
    private String id(){return UUID.randomUUID().toString();}
    private JSONObject input()throws Exception{return new JSONObject().put("authorityId",authority.getString("id")).put("serviceType","takeaway").put("customer",JSONObject.NULL).put("lines",new JSONArray().put(new JSONObject().put("productId",snapshot.getJSONArray("products").getJSONObject(0).getString("id")).put("quantityMilli",1000))).put("cashTenderedFils",1000).put("recordedCardFils",0).put("presentedTotalFils",1000);}
    private JSONObject payload(String envelope)throws Exception{return (JSONObject)SignedProtocol.verify(envelope,Collections.singletonMap(SignedProtocol.fingerprint(device),device)).payload();}
    private long value(String query){try(Cursor c=journal.getReadableDatabase().rawQuery(query,null)){assertTrue(c.moveToFirst());return c.getLong(0);}}
    private long count(String table){return value("SELECT count(*) FROM "+table);}
    private String sell()throws Exception{String id=id();engine.beginPaymentIntent(id,input());return engine.commitPaymentIntent(id);}
    private void reopen()throws Exception{journal.close();journal=new NativeJournal(context,dbName,()->{if(failCommit)throw new IllegalStateException("synthetic_full_disk");});engine=createEngine(journal);}
    @Test public void commitsExactReceiptChainAndOutboxAndReplaysAfterLockExpiryAndReopen()throws Exception{
        String intent=id();JSONObject begun=engine.beginPaymentIntent(intent,input());assertEquals("payment_confirmation_required",begun.getString("state"));assertEquals(0,count("receipts"));
        String first=engine.commitPaymentIntent(intent);JSONObject p=payload(first),d=p.getJSONObject("document");assertEquals("TEST-INV-0000000001",d.getString("documentNumber"));assertEquals(1000,d.getJSONObject("totals").getLong("grossFils"));assertEquals(48,d.getJSONObject("totals").getLong("taxFils"));assertEquals(1,p.getLong("deviceSequence"));assertTrue(p.isNull("previousEventSha256"));
        assertEquals(1,count("outbox"));assertEquals(2,value("SELECT next_number FROM offline_authority_state"));assertEquals(1000,value("SELECT gross_fils FROM offline_authority_state"));
        int signed=signatures.get();reopen();locked=true;wall+=7_200_000;elapsed+=7_200_000;assertEquals(first,engine.commitPaymentIntent(intent));assertEquals(signed,signatures.get());assertEquals(1,count("receipts"));assertEquals("committed",engine.getIntent(intent).getString("state"));
    }
    @Test public void weightedMixedTenderAndConsecutiveHashAreDerivedFromSnapshot()throws Exception{
        String first=sell();JSONObject r=input().put("lines",new JSONArray().put(new JSONObject().put("productId",snapshot.getJSONArray("products").getJSONObject(1).getString("id")).put("quantityMilli",500))).put("cashTenderedFils",500).put("recordedCardFils",100).put("presentedTotalFils",501);
        String id=id();engine.beginPaymentIntent(id,r);JSONObject p=payload(engine.commitPaymentIntent(id)),d=p.getJSONObject("document");assertEquals(2,p.getLong("deviceSequence"));assertEquals(SignedProtocol.verify(first,Collections.singletonMap(SignedProtocol.fingerprint(device),device)).payloadSha256,p.getString("previousEventSha256"));assertEquals(501,d.getJSONObject("totals").getLong("grossFils"));assertEquals(99,d.getLong("changeFils"));assertEquals(401,d.getJSONArray("payments").getJSONObject(0).getLong("amountFils"));assertEquals(2,engine.listPendingIssuances().length());
    }
    @Test public void unsignedPriceUnknownFieldsWrongTotalsAndDuplicateProductsCannotReachIntent()throws Exception{
        JSONObject wrong=input();wrong.getJSONArray("lines").getJSONObject(0).put("unitPriceFils",1);assertThrows(IllegalStateException.class,()->engine.beginPaymentIntent(id(),wrong));
        JSONObject price=input().put("presentedTotalFils",1);assertThrows(IllegalStateException.class,()->engine.beginPaymentIntent(id(),price));
        JSONObject duplicate=input();duplicate.getJSONArray("lines").put(duplicate.getJSONArray("lines").getJSONObject(0));assertThrows(IllegalArgumentException.class,()->engine.beginPaymentIntent(id(),duplicate));assertEquals(0,count("intents"));
    }
    @Test public void unicodeBuyerWhitespaceAndInvalidNativeClockRejectBeforePayment()throws Exception{
        JSONObject buyer=new JSONObject().put("name","\u00a0Buyer").put("address","Synthetic address").put("trn",JSONObject.NULL);
        assertThrows(IllegalStateException.class,()->engine.beginPaymentIntent(id(),input().put("customer",buyer)));assertEquals(0,count("intents"));
        boot="invalid-boot";assertThrows(OfflineClock.ClockException.class,()->engine.beginPaymentIntent(id(),input()));assertEquals(1,value("SELECT blocked FROM offline_authority_state"));assertEquals(0,count("intents"));
    }
    @Test public void oneUncertainIntentBlocksNewCollectionAndSurvivesReopen()throws Exception{
        String id=id();JSONObject request=input();engine.beginPaymentIntent(id,request);reopen();assertEquals("payment_confirmation_required",engine.getIntent(id).getString("state"));assertThrows(IllegalStateException.class,()->engine.beginPaymentIntent(id(),input()));assertThrows(IllegalStateException.class,()->engine.beginPaymentIntent(id,input().put("cashTenderedFils",2000)));assertEquals(0,signatures.get());
        engine.cancelUncollectedIntent(id,"Cashier confirmed no money collected");assertEquals("cancelled",engine.getIntent(id).getString("state"));assertThrows(IllegalStateException.class,()->engine.commitPaymentIntent(id));assertEquals(1,count("offline_intent_cancellations"));sell();assertEquals(1,count("receipts"));
    }
    @Test public void interruptedCommitRollsBackReceiptCounterChainOutboxButKeepsIntent()throws Exception{
        String id=id();engine.beginPaymentIntent(id,input());failCommit=true;assertThrows(IllegalStateException.class,()->engine.commitPaymentIntent(id));assertEquals(0,count("receipts"));assertEquals(0,count("outbox"));assertEquals(1,count("intents"));assertEquals(1,value("SELECT next_number FROM offline_authority_state"));assertEquals(0,value("SELECT sequence FROM offline_chain"));assertEquals(0,value("SELECT gross_fils FROM offline_authority_state"));
        failCommit=false;reopen();assertEquals("TEST-INV-0000000001",payload(engine.commitPaymentIntent(id)).getJSONObject("document").getString("documentNumber"));
    }
    @Test public void signingFailureCannotIssueOrConsumeNumber()throws Exception{String id=id();engine.beginPaymentIntent(id,input());failSigning=true;assertThrows(IllegalStateException.class,()->engine.commitPaymentIntent(id));assertEquals(0,count("receipts"));assertEquals(1,value("SELECT next_number FROM offline_authority_state"));failSigning=false;assertEquals(1,payload(engine.commitPaymentIntent(id)).getLong("deviceSequence"));}
    @Test public void elapsedAndWallRollbackLatchAcrossReopenAndBundleReplay()throws Exception{
        elapsed+=1000;wall+=1000;sell();elapsed-=500;wall-=500;assertThrows(OfflineClock.ClockException.class,()->engine.beginPaymentIntent(id(),input()));assertEquals(1,value("SELECT blocked FROM offline_authority_state"));reopen();wall+=1000;elapsed+=1000;engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,wall);assertThrows(IllegalStateException.class,()->engine.beginPaymentIntent(id(),input()));assertEquals(1,count("receipts"));
    }
    @Test public void conservativeRebootCanContinueWithinGrantAndExpiryPreventsCollection()throws Exception{
        sell();reopen();boot=id();wall+=60_000;elapsed=30_000;JSONObject second=payload(sell());assertEquals(boot,second.getJSONObject("clock").getString("bootId"));assertEquals(2,second.getLong("deviceSequence"));
        wall=start+3_600_000;elapsed=3_570_000;assertThrows(OfflineClock.ClockException.class,()->engine.beginPaymentIntent(id(),input()));assertEquals(2,count("intents"));assertEquals(0,value("SELECT blocked FROM offline_authority_state"));
    }
    @Test public void authorityCountAndAggregateBudgetPreventExtraPayments()throws Exception{sell();sell();sell();assertThrows(IllegalStateException.class,()->engine.beginPaymentIntent(id(),input()));assertEquals(3,count("intents"));assertEquals(3,count("receipts"));}
    @Test public void aggregateBudgetAndTenderPermissionsAreCheckedBeforeCollectingMoney()throws Exception{
        engine.sealAuthority(authority.getString("id"));reconcilePrior();authority.put("id",id()).put("maxGrossFils",1500);authority.getJSONObject("invoiceRange").put("first",4).put("last",6);
        authority.getJSONObject("permissions").put("recordedCard",false).put("mixedTender",false);rebuild();engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start);
        assertThrows(IllegalStateException.class,()->engine.beginPaymentIntent(id(),input().put("cashTenderedFils",0).put("recordedCardFils",1000)));assertEquals(0,count("intents"));sell();
        assertThrows(IllegalStateException.class,()->engine.beginPaymentIntent(id(),input()));assertEquals(1,count("intents"));assertEquals(1,count("receipts"));
    }
    @Test public void localUnlockIsRequiredAgainAtCommitAndBuyerDetailsAreEnforced()throws Exception{
        locked=true;assertThrows(IllegalStateException.class,()->engine.beginPaymentIntent(id(),input()));assertEquals(0,count("intents"));locked=false;
        String pending=id();engine.beginPaymentIntent(pending,input());locked=true;assertThrows(IllegalStateException.class,()->engine.commitPaymentIntent(pending));assertEquals(0,count("receipts"));locked=false;engine.cancelUncollectedIntent(pending,"No payment collected");
        engine.sealAuthority(authority.getString("id"));reconcilePrior();authority.put("id",id()).put("maxInvoiceTotalFils",2_000_000).put("maxGrossFils",6_000_000);authority.getJSONObject("invoiceRange").put("first",4).put("last",6);
        snapshot.put("id",id());authority.put("snapshotId",snapshot.getString("id"));snapshot.getJSONArray("products").getJSONObject(0).put("unitPriceFils",2_000_000);rebuild();engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start);
        JSONObject large=input().put("cashTenderedFils",2_000_000).put("presentedTotalFils",2_000_000);assertThrows(IllegalStateException.class,()->engine.beginPaymentIntent(id(),large));assertEquals(1,count("intents"));
        large.put("customer",new JSONObject().put("name","Synthetic buyer").put("address","Synthetic buyer address").put("trn",JSONObject.NULL));String intent=id();engine.beginPaymentIntent(intent,large);assertEquals(2_000_000,payload(engine.commitPaymentIntent(intent)).getJSONObject("document").getJSONObject("totals").getLong("grossFils"));
    }
    @Test public void sealedAuthorityStopsIssuanceAndNextGrantContinuesEpochChain()throws Exception{
        String first=sell();String seal=engine.sealAuthority(authority.getString("id"));assertEquals(seal,engine.sealAuthority(authority.getString("id")));assertEquals(1,payload(seal).getLong("finalSequence"));assertThrows(IllegalStateException.class,()->engine.beginPaymentIntent(id(),input()));
        reconcilePrior();authority.put("id",id());authority.getJSONObject("invoiceRange").put("first",4).put("last",6);rebuild();engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start);JSONObject next=payload(sell());assertEquals(2,next.getLong("deviceSequence"));assertEquals("TEST-INV-0000000004",next.getJSONObject("document").getString("documentNumber"));assertEquals(SignedProtocol.verify(first,Collections.singletonMap(SignedProtocol.fingerprint(device),device)).payloadSha256,next.getString("previousEventSha256"));
    }
    @Test public void validExactServerAckRemovesOnlyMatchingOutboxAndPreservesFirstBytes()throws Exception{
        String receipt=sell();JSONObject p=payload(receipt);JSONObject ack=new JSONObject().put("kind","offline-ack").put("schemaVersion",1).put("id",id()).put("issuanceId",p.getString("id")).put("payloadSha256",SignedProtocol.verify(receipt,Collections.singletonMap(SignedProtocol.fingerprint(device),device)).payloadSha256).put("authorityId",authority.getString("id")).put("keyEpoch",authority.getString("keyEpoch")).put("deviceSequence",1).put("receivedAt",NativeCheckoutEngine.iso(start));
        JSONObject bad=new JSONObject(ack.toString()).put("deviceSequence",2);assertThrows(IllegalStateException.class,()->engine.acknowledgeIssuance(SignedProtocol.sign(bad,"synthetic-server",server.getPrivate(),server.getPublic())));assertEquals(1,count("outbox"));
        String signed=SignedProtocol.sign(ack,"synthetic-server",server.getPrivate(),server.getPublic());locked=true;engine.acknowledgeIssuance(signed);engine.acknowledgeIssuance(SignedProtocol.sign(ack,"synthetic-server",server.getPrivate(),server.getPublic()));assertEquals(0,count("outbox"));assertEquals(1,count("acknowledgements"));assertEquals(1,count("receipts"));
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT ack_json FROM acknowledgements",null)){assertTrue(c.moveToFirst());assertEquals(signed,c.getString(0));}
    }
    @Test public void concurrentCommitOnSeparateConnectionsReturnsOneOriginalReceipt()throws Exception{
        String id=id();engine.beginPaymentIntent(id,input());NativeJournal other=new NativeJournal(context,dbName,()->{});NativeCheckoutEngine second=createEngine(other);CountDownLatch startLatch=new CountDownLatch(1);AtomicReference<String>a=new AtomicReference<>(),b=new AtomicReference<>();AtomicReference<Throwable>error=new AtomicReference<>();
        Thread one=new Thread(()->{try{startLatch.await();a.set(engine.commitPaymentIntent(id));}catch(Throwable e){error.set(e);}}),two=new Thread(()->{try{startLatch.await();b.set(second.commitPaymentIntent(id));}catch(Throwable e){error.set(e);}});
        try{one.start();two.start();startLatch.countDown();one.join(10_000);two.join(10_000);assertFalse(one.isAlive());assertFalse(two.isAlive());if(error.get()!=null)throw new AssertionError(error.get());assertEquals(a.get(),b.get());assertEquals(1,count("receipts"));assertEquals(1,value("SELECT sequence FROM offline_chain"));}finally{other.close();}
    }
    @Test public void newGrantCannotReplaceOpenGrantAndReplayDoesNotResetUsedBudget()throws Exception{
        sell();engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start);assertEquals(2,value("SELECT next_number FROM offline_authority_state"));authority.put("id",id());authority.getJSONObject("invoiceRange").put("first",4).put("last",6);rebuild();assertThrows(IllegalStateException.class,()->engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start));assertEquals(1,count("offline_bundles"));
    }
    @Test public void exportsActualNativeReceiptsForIndependentServerValidation()throws Exception{
        JSONArray receipts=new JSONArray();receipts.put(new JSONObject(sell()));
        JSONObject weighted=input().put("lines",new JSONArray().put(new JSONObject().put("productId",snapshot.getJSONArray("products").getJSONObject(1).getString("id")).put("quantityMilli",500))).put("cashTenderedFils",500).put("recordedCardFils",100).put("presentedTotalFils",501);
        String intent=id();engine.beginPaymentIntent(intent,weighted);receipts.put(new JSONObject(engine.commitPaymentIntent(intent)));
        JSONObject card=input().put("cashTenderedFils",0).put("recordedCardFils",1000);intent=id();engine.beginPaymentIntent(intent,card);receipts.put(new JSONObject(engine.commitPaymentIntent(intent)));
        JSONObject fixture=new JSONObject().put("provenance","Actual isolated Android SQLite/Keystore NativeCheckoutEngineTest; synthetic merchant, ephemeral public keys only")
            .put("serverPublicKeySpki",SignedProtocol.encode(server.getPublic().getEncoded())).put("devicePublicKeySpki",SignedProtocol.encode(device.getEncoded()))
            .put("snapshotEnvelope",new JSONObject(snapshotEnvelope)).put("authorityEnvelope",new JSONObject(authorityEnvelope)).put("issuances",receipts)
            .put("sealEnvelope",new JSONObject(engine.sealAuthority(authority.getString("id"))));
        try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(context.getCacheDir(),"native-checkout-output.json"))){out.write(fixture.toString(2).getBytes(java.nio.charset.StandardCharsets.UTF_8));}
        assertEquals(3,count("receipts"));
    }
    @Test public void immutableAuthorityAndIntentEvidenceCannotBeReplaced()throws Exception{
        String id=id();engine.beginPaymentIntent(id,input());assertThrows(SQLiteException.class,()->journal.getWritableDatabase().execSQL("UPDATE offline_bundles SET authority_envelope='{}'"));assertThrows(SQLiteException.class,()->journal.getWritableDatabase().execSQL("DELETE FROM offline_intent_context"));assertThrows(SQLiteException.class,()->journal.getWritableDatabase().execSQL("DELETE FROM offline_authority_state"));
        sellAfterCancellation(id);assertThrows(SQLiteException.class,()->journal.getWritableDatabase().execSQL("UPDATE offline_authority_state SET next_number=1"));assertThrows(SQLiteException.class,()->journal.getWritableDatabase().execSQL("UPDATE offline_chain SET sequence=0"));
    }
    private void reconcilePrior()throws Exception{
        NativeReconciliation reconciliation=new NativeReconciliation(journal,identity,Collections.singletonMap("synthetic-server",server.getPublic()),(path,envelope)->{
            JSONObject p=payload(envelope.toString());
            if(path.equals("/api/pos/offline/seal"))return new JSONObject().put("status","sealed").put("authorityId",p.getString("authorityId")).put("finalSequence",p.getLong("finalSequence")).put("finalEventSha256",p.get("finalEventSha256"));
            assertEquals("/api/pos/offline/import",path);JSONObject ack=new JSONObject().put("kind","offline-ack").put("schemaVersion",1).put("id",id()).put("issuanceId",p.getString("id"))
                .put("payloadSha256",NativeJournal.payloadHash(envelope.toString())).put("authorityId",p.getString("authorityId")).put("keyEpoch",binding.keyEpoch).put("deviceSequence",p.getLong("deviceSequence")).put("receivedAt",NativeCheckoutEngine.iso(wall));
            return new JSONObject().put("status","accepted").put("acknowledgement",new JSONObject(SignedProtocol.sign(ack,"synthetic-server",server.getPrivate(),server.getPublic()))).put("receipt",p.getJSONObject("document")).put("replayed",false);
        });
        JSONObject state=reconciliation.reconcile();assertEquals(0,state.getLong("pendingReceipts"));assertEquals(0,state.getLong("pendingSeals"));assertEquals("idle",state.getString("status"));
    }
    private void prepareNextGrant()throws Exception{
        engine.sealAuthority(authority.getString("id"));reconcilePrior();authority.put("id",id());authority.getJSONObject("invoiceRange").put("first",4).put("last",6);rebuild();
    }
    private String currentGrantClock()throws Exception{
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT clock_json FROM offline_authority_state WHERE authority_id=?",new String[]{authority.getString("id")})){assertTrue(c.moveToFirst());return c.getString(0);}
    }
    @Test public void freshHandoffIncludesDelayInsideInstallTransactionAndThirtySecondBoundary()throws Exception{
        prepareNextGrant();OfflineClock.Reading reference=new OfflineClock.Reading(boot,elapsed,wall);elapsed+=30000;wall+=30000;
        engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start,reference);
        OfflineClock.State clock=OfflineClock.State.fromJson(currentGrantClock());assertEquals(start+30000,clock.anchorServerMs);assertEquals(elapsed,clock.anchorElapsedMs);
        JSONObject issued=payload(sell());assertEquals(NativeCheckoutEngine.iso(start+30000),issued.getJSONObject("document").getString("issuedAt"));assertEquals(2,count("offline_bundles"));
    }
    @Test public void changedBootElapsedRollbackWallRollbackAndStaleInstallCannotPersistGrant()throws Exception{
        prepareNextGrant();String originalBoot=boot;OfflineClock.Reading reference=new OfflineClock.Reading(boot,elapsed,wall);
        boot=id();assertThrows(IllegalStateException.class,()->engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start,reference));assertEquals(1,count("offline_bundles"));
        boot=originalBoot;elapsed=999;assertThrows(IllegalStateException.class,()->engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start,reference));assertEquals(1,count("offline_bundles"));
        elapsed=1250;wall=start-1;assertThrows(IllegalStateException.class,()->engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start,reference));assertEquals(1,count("offline_bundles"));
        elapsed=31001;wall=start+30001;assertThrows(IllegalStateException.class,()->engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start,reference));assertEquals(1,count("offline_bundles"));
        elapsed=1250;wall=start+250;engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start,reference);assertEquals(start+250,OfflineClock.State.fromJson(currentGrantClock()).anchorServerMs);
    }
    @Test public void handoffDelayCannotExtendExpiredGrantAndOverflowRollsBack()throws Exception{
        prepareNextGrant();authority.put("expiresAt",NativeCheckoutEngine.iso(start+1000));rebuild();OfflineClock.Reading reference=new OfflineClock.Reading(boot,elapsed,wall);elapsed+=1000;wall+=1000;
        OfflineClock.ClockException expired=assertThrows(OfflineClock.ClockException.class,()->engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start,reference));assertEquals("clock_expired",expired.code);assertEquals(1,count("offline_bundles"));
        assertThrows(ArithmeticException.class,()->engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,Long.MAX_VALUE,reference));assertEquals(1,count("offline_bundles"));assertEquals(1,count("offline_authority_state"));assertEquals(0,count("receipts"));
    }
    @Test public void repeatedPreparedBundleCannotResetClockDespiteLaterReferenceOrLock()throws Exception{
        prepareNextGrant();OfflineClock.Reading reference=new OfflineClock.Reading(boot,elapsed,wall);elapsed+=250;wall+=250;engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start,reference);sell();String saved=currentGrantClock();
        locked=true;elapsed+=4_000_000;wall+=4_000_000;engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,wall,new OfflineClock.Reading(boot,elapsed,wall));
        assertEquals(saved,currentGrantClock());assertEquals(1,count("receipts"));assertEquals(2,count("offline_bundles"));assertEquals(5,value("SELECT next_number FROM offline_authority_state WHERE seal_envelope IS NULL"));
    }
    @Test public void publicPreparedInstallRequiresNativeReferenceReading()throws Exception{
        prepareNextGrant();assertThrows(IllegalStateException.class,()->engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start,null));assertEquals(1,count("offline_bundles"));assertEquals(1,count("offline_authority_state"));
    }
    private OfflineClock.Reading expireNow(){wall=start+3_600_000;elapsed=3_601_000;return new OfflineClock.Reading(boot,elapsed,wall);}
    private String currentSeal()throws Exception{
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT seal_envelope FROM offline_authority_state WHERE authority_id=?",new String[]{authority.getString("id")})){assertTrue(c.moveToFirst());return c.getString(0);}
    }
    @Test public void expiredUnusedGrantRetainsNonzeroHeadAndCannotIssueOrResetOnReplay()throws Exception{
        String first=sell();String hash=SignedProtocol.verify(first,Collections.singletonMap(SignedProtocol.fingerprint(device),device)).payloadSha256;
        String priorId=authority.getString("id"),priorClock=currentGrantClock(),priorSeal=engine.sealAuthority(priorId);
        authority.put("id",id());authority.getJSONObject("invoiceRange").put("first",4).put("last",6);rebuild();
        // Active issuance cannot skip uploads, but terminal-only expired retention must
        // keep the original unacknowledged receipt and its exact outbox entry recoverable.
        assertThrows(IllegalStateException.class,()->engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start,new OfflineClock.Reading(boot,elapsed,wall)));
        assertEquals(1,count("offline_bundles"));assertEquals(1,count("outbox"));assertEquals(0,count("acknowledgements"));assertEquals(0,count("offline_seal_confirmations"));
        OfflineClock.Reading reference=expireNow();engine.retainExpiredUnusedBundle(snapshotEnvelope,authorityEnvelope,wall,reference);
        String seal=currentSeal(),savedClock=currentGrantClock();JSONObject p=payload(seal);assertEquals(1,p.getLong("finalSequence"));assertEquals(hash,p.getString("finalEventSha256"));assertEquals(0,value("SELECT sum(blocked) FROM offline_authority_state"));assertEquals(0,value("SELECT gross_fils FROM offline_authority_state WHERE next_number=4"));
        assertThrows(IllegalStateException.class,()->engine.beginPaymentIntent(id(),input()));assertEquals(1,count("receipts"));assertEquals(1,count("outbox"));assertEquals(0,count("acknowledgements"));int signed=signatures.get();
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT clock_json,seal_envelope FROM offline_authority_state WHERE authority_id=?",new String[]{priorId})){assertTrue(c.moveToFirst());assertEquals(priorClock,c.getString(0));assertEquals(priorSeal,c.getString(1));}
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT r.envelope_json FROM receipts r JOIN outbox o ON o.receipt_id=r.id",null)){assertTrue(c.moveToFirst());assertEquals(first,c.getString(0));assertFalse(c.moveToNext());}
        locked=true;wall+=9999;elapsed+=9999;engine.retainExpiredUnusedBundle(snapshotEnvelope,authorityEnvelope,wall,new OfflineClock.Reading(boot,elapsed,wall));assertEquals(seal,currentSeal());assertEquals(savedClock,currentGrantClock());assertEquals(signed,signatures.get());
        locked=false;reconcilePrior();authority.put("id",id()).put("issuedAt",NativeCheckoutEngine.iso(wall)).put("notBefore",NativeCheckoutEngine.iso(wall)).put("expiresAt",NativeCheckoutEngine.iso(wall+3_600_000));authority.getJSONObject("invoiceRange").put("first",7).put("last",9);rebuild();engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,wall,new OfflineClock.Reading(boot,elapsed,wall));assertEquals(2,payload(sell()).getLong("deviceSequence"));
    }
    @Test public void existingExpiredActiveGrantIsNeverSealedOrReanchoredByRetentionReplay()throws Exception{
        String saved=currentGrantClock();int signed=signatures.get();OfflineClock.Reading reference=expireNow();locked=true;engine.retainExpiredUnusedBundle(snapshotEnvelope,authorityEnvelope,wall,reference);
        assertNull(currentSeal());assertEquals(saved,currentGrantClock());assertEquals(signed,signatures.get());assertEquals(1,count("offline_bundles"));assertEquals(0,count("receipts"));
    }
    @Test public void unexpiredRetentionAndMissingReferenceCannotPersistBundle()throws Exception{
        prepareNextGrant();assertThrows(IllegalStateException.class,()->engine.retainExpiredUnusedBundle(snapshotEnvelope,authorityEnvelope,start,new OfflineClock.Reading(boot,elapsed,wall)));assertThrows(IllegalStateException.class,()->engine.retainExpiredUnusedBundle(snapshotEnvelope,authorityEnvelope,start,null));assertEquals(1,count("offline_bundles"));assertEquals(1,count("offline_authority_state"));
    }
    @Test public void expiredRetentionRejectsWrongScopeLockAndChangedClockWithoutWrites()throws Exception{
        prepareNextGrant();OfflineClock.Reading reference=expireNow();String shift=authority.getString("shiftId");authority.put("shiftId",id());rebuild();assertThrows(IllegalArgumentException.class,()->engine.retainExpiredUnusedBundle(snapshotEnvelope,authorityEnvelope,wall,reference));authority.put("shiftId",shift);rebuild();
        locked=true;assertThrows(IllegalStateException.class,()->engine.retainExpiredUnusedBundle(snapshotEnvelope,authorityEnvelope,wall,reference));locked=false;String originalBoot=boot;boot=id();assertThrows(IllegalStateException.class,()->engine.retainExpiredUnusedBundle(snapshotEnvelope,authorityEnvelope,wall,reference));boot=originalBoot;elapsed--;assertThrows(IllegalStateException.class,()->engine.retainExpiredUnusedBundle(snapshotEnvelope,authorityEnvelope,wall,reference));elapsed++;wall--;assertThrows(IllegalStateException.class,()->engine.retainExpiredUnusedBundle(snapshotEnvelope,authorityEnvelope,start+3_600_000,reference));wall++;elapsed+=30001;assertThrows(IllegalStateException.class,()->engine.retainExpiredUnusedBundle(snapshotEnvelope,authorityEnvelope,wall,reference));assertEquals(1,count("offline_bundles"));assertEquals(1,count("offline_authority_state"));
    }
    @Test public void uncertainPriorPaymentPreventsExpiredRetention()throws Exception{
        prepareNextGrant();journal.beginIntent(id(),"{}",NativeCheckoutEngine.iso(start));OfflineClock.Reading reference=expireNow();assertThrows(IllegalStateException.class,()->engine.retainExpiredUnusedBundle(snapshotEnvelope,authorityEnvelope,wall,reference));assertEquals(1,count("intents"));assertEquals(1,count("offline_bundles"));assertEquals(0,count("receipts"));
    }
    @Test public void expiredRetentionSigningFailureRollsBackEntireBundleAndRetriesZeroHead()throws Exception{
        prepareNextGrant();OfflineClock.Reading reference=expireNow();failSigning=true;assertThrows(IllegalStateException.class,()->engine.retainExpiredUnusedBundle(snapshotEnvelope,authorityEnvelope,wall,reference));assertEquals(1,count("offline_bundles"));assertEquals(1,count("offline_authority_state"));assertEquals(0,value("SELECT sequence FROM offline_chain"));
        failSigning=false;engine.retainExpiredUnusedBundle(snapshotEnvelope,authorityEnvelope,wall,reference);assertEquals(2,count("offline_bundles"));JSONObject seal=payload(currentSeal());assertEquals(0,seal.getLong("finalSequence"));assertTrue(seal.isNull("finalEventSha256"));assertEquals(0,count("receipts"));assertEquals(0,count("outbox"));
    }
    private void sellAfterCancellation(String id)throws Exception{engine.cancelUncollectedIntent(id,"No payment collected");sell();}
}
