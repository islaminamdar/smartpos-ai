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
public class NativeCheckoutCoordinatorTest {
    private Context context; private String dbName,alias; private NativeJournal journal; private DeviceIdentity identity;
    private NativeCheckoutEngine engine; private OfflineBundle.Binding binding; private KeyPair server; private PublicKey device;
    private JSONObject snapshot,authority; private String snapshotEnvelope,authorityEnvelope,boot=UUID.randomUUID().toString();
    private final long start=1_792_132_200_000L; private long wall=start,elapsed=1000; private boolean locked=false,failSigning=false,failCommit=false;
    private NativeCheckoutCoordinator checkout;private OfflineBundle currentBundle;private boolean signedOut;
    private AtomicInteger signatures=new AtomicInteger();
    @Before public void setUp() throws Exception {
        context=InstrumentationRegistry.getInstrumentation().getTargetContext(); dbName="checkout-bridge-audit-"+UUID.randomUUID()+".db";alias="internext.pos.test.checkoutbridge."+UUID.randomUUID();
        journal=new NativeJournal(context,dbName,()->{if(failCommit)throw new IllegalStateException("synthetic_full_disk");});
        identity=new DeviceIdentity(alias);JSONObject id=identity.readOrCreate(journal);device=SignedProtocol.publicKey(SignedProtocol.decode(id.getString("publicKeySpkiBase64Url"),256));
        KeyPairGenerator gen=KeyPairGenerator.getInstance("EC");gen.initialize(new ECGenParameterSpec("secp256r1"));server=gen.generateKeyPair();
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream in=InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("pos-offline-output.json")){byte[] b=new byte[4096];int n;while((n=in.read(b))!=-1)bytes.write(b,0,n);}
        JSONObject reservation=new JSONObject(bytes.toString("UTF-8")).getJSONObject("reservation");snapshot=reservation.getJSONObject("snapshot");authority=reservation.getJSONObject("authority");
        authority.put("deviceKeySha256",id.getString("deviceKeySha256")).put("issuedAt",NativeCheckoutEngine.iso(start)).put("notBefore",NativeCheckoutEngine.iso(start)).put("expiresAt",NativeCheckoutEngine.iso(start+3_600_000));
        snapshot.put("createdAt",NativeCheckoutEngine.iso(start));
        binding=new OfflineBundle.Binding(authority.getString("organizationId"),authority.getString("branchId"),authority.getString("deviceId"),authority.getString("actorId"),authority.getString("shiftId"),authority.getString("keyEpoch"),authority.getString("deviceKeySha256"));
        rebuild();engine=createEngine(journal);engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start);currentBundle=verifiedBundle();checkout=coordinator(true);
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
    private void reopen()throws Exception{journal.close();journal=new NativeJournal(context,dbName,()->{if(failCommit)throw new IllegalStateException("synthetic_full_disk");});engine=createEngine(journal);checkout=coordinator(true);}
    private OfflineBundle verifiedBundle()throws Exception{return OfflineBundle.verify(snapshotEnvelope,authorityEnvelope,Collections.singletonMap("synthetic-server",server.getPublic()),binding);}
    private NativeCheckoutCoordinator coordinator(boolean enabled){return new NativeCheckoutCoordinator(journal,required->{if(signedOut)throw new NativeAccessError("native_session_expired");if(required&&locked)throw new NativeAccessError("pin_unlock_required");return new NativeCheckoutCoordinator.CheckoutContext(currentBundle,engine);},enabled);}
    private JSONObject draft()throws Exception{JSONObject r=input();r.remove("presentedTotalFils");return r.put("tenderMode","cash").put("cashTenderedFils",JSONObject.NULL).put("recordedCardFils",JSONObject.NULL);}
    private String canonical(JSONObject value)throws Exception{return new String(CanonicalJson.bytes(value),java.nio.charset.StandardCharsets.UTF_8);}
    private void fails(org.junit.function.ThrowingRunnable run){assertThrows(Exception.class,run);}
    private void differentAuthority()throws Exception{authority.put("id",id());rebuild();currentBundle=verifiedBundle();}
    @Test public void disabledReleaseGateAllowsDisplayButNeverBeginsOrConfirmsPayment()throws Exception{
        checkout=coordinator(false);JSONObject quote=checkout.quoteBasket(draft());assertEquals(1000,quote.getJSONObject("totals").getLong("grossFils"));assertFalse(checkout.getState().getBoolean("canIssue"));
        fails(()->checkout.beginPaymentIntent(id(),quote.getJSONObject("request")));assertEquals(0,count("intents"));String pending=id();engine.beginPaymentIntent(pending,input());assertFalse(checkout.getPaymentIntent(pending).getBoolean("canConfirm"));fails(()->checkout.confirmPaymentIntent(pending));assertEquals(0,count("receipts"));assertEquals(1,count("intents"));assertEquals(1,value("SELECT next_number FROM offline_authority_state"));
    }
    @Test public void nativeQuoteThenExplicitConfirmationCreatesExactlyOneReceipt()throws Exception{
        JSONObject quote=checkout.quoteBasket(draft());assertEquals(1,quote.getInt("schemaVersion"));assertEquals(1000,quote.getJSONObject("request").getLong("cashTenderedFils"));assertEquals(48,quote.getJSONObject("totals").getLong("taxFils"));assertEquals(0,count("intents"));
        String pending=id();JSONObject begun=checkout.beginPaymentIntent(pending,quote.getJSONObject("request"));assertEquals("payment_confirmation_required",begun.getString("state"));assertTrue(begun.getBoolean("canConfirm"));assertEquals(0,count("receipts"));assertEquals(pending,checkout.getState().getString("pendingIntentId"));assertFalse(checkout.getState().getBoolean("canIssue"));
        JSONObject result=checkout.confirmPaymentIntent(pending),receipt=result.getJSONObject("receipt");assertEquals("committed",result.getString("state"));assertFalse(result.getBoolean("canConfirm"));assertEquals("TEST-INV-0000000001",receipt.getString("documentNumber"));assertEquals("pending",receipt.getString("syncState"));assertEquals(1000,receipt.getJSONObject("totals").getLong("grossFils"));assertEquals(1,count("outbox"));int signed=signatures.get();
        assertEquals(canonical(receipt),canonical(checkout.confirmPaymentIntent(pending).getJSONObject("receipt")));assertEquals(canonical(receipt),canonical(checkout.getReceipt(receipt.getString("id"))));assertEquals(signed,signatures.get());assertEquals(1,count("receipts"));
    }
    @Test public void preparedIntentSurvivesRestartWithoutAutomaticCollectionOrCommit()throws Exception{
        String pending=id();JSONObject first=checkout.beginPaymentIntent(pending,input());reopen();JSONObject state=checkout.getState();assertEquals(pending,state.getString("pendingIntentId"));assertEquals("payment_confirmation_required",state.getJSONObject("unresolvedIntent").getString("state"));assertEquals(canonical(first.getJSONObject("request")),canonical(checkout.getPaymentIntent(pending).getJSONObject("request")));assertEquals(0,count("receipts"));assertEquals(0,count("outbox"));assertEquals(0,signatures.get());fails(()->checkout.beginPaymentIntent(id(),input()));assertEquals(1,count("intents"));
    }
    @Test public void changedRequestCannotReplaceExistingIntentAndIdenticalRetryIsSafe()throws Exception{
        String pending=id();JSONObject request=input();checkout.beginPaymentIntent(pending,request);assertEquals(pending,checkout.beginPaymentIntent(pending,new JSONObject(request.toString())).getString("intentId"));JSONObject changed=input().put("cashTenderedFils",2000);fails(()->checkout.beginPaymentIntent(pending,changed));assertEquals(canonical(request),canonical(checkout.getPaymentIntent(pending).getJSONObject("request")));assertEquals(1,count("intents"));assertEquals(0,count("receipts"));
    }
    @Test public void lockedAndSignedOutStatesExposeRecoveryIdsButNoCustomerOrReceiptDetails()throws Exception{
        JSONObject secret=input().put("customer",new JSONObject().put("name","Synthetic private buyer").put("address","Synthetic private address").put("trn",JSONObject.NULL));String pending=id();checkout.beginPaymentIntent(pending,secret);locked=true;
        JSONObject state=checkout.getState();assertEquals(pending,state.getString("pendingIntentId"));assertTrue(state.isNull("unresolvedIntent"));assertTrue(state.isNull("lastReceipt"));assertFalse(state.toString().contains("Synthetic private"));assertFalse(state.getBoolean("canIssue"));fails(()->checkout.getPaymentIntent(pending));fails(()->checkout.confirmPaymentIntent(pending));fails(()->checkout.cancelUncollectedIntent(pending,"No payment collected"));
        signedOut=true;state=checkout.getState();assertEquals(pending,state.getString("pendingIntentId"));assertTrue(state.isNull("context"));assertTrue(state.isNull("unresolvedIntent"));assertFalse(state.toString().contains("Synthetic private"));fails(()->checkout.quoteBasket(draft()));assertEquals(0,count("receipts"));assertEquals(1,count("intents"));
    }
    @Test public void committedReplayAndReceiptDetailsRequireCurrentUnlockedScope()throws Exception{
        String pending=id();checkout.beginPaymentIntent(pending,input());JSONObject receipt=checkout.confirmPaymentIntent(pending).getJSONObject("receipt");String receiptId=receipt.getString("id");int signed=signatures.get();locked=true;
        JSONObject state=checkout.getState();assertEquals(receiptId,state.getString("lastReceiptId"));assertTrue(state.isNull("lastReceipt"));fails(()->checkout.confirmPaymentIntent(pending));fails(()->checkout.getReceipt(receiptId));fails(()->checkout.getPaymentIntent(pending));signedOut=true;fails(()->checkout.confirmPaymentIntent(pending));fails(()->checkout.getReceipt(receiptId));
        signedOut=false;locked=false;reopen();wall+=7_200_000;elapsed+=7_200_000;assertEquals(canonical(receipt),canonical(checkout.confirmPaymentIntent(pending).getJSONObject("receipt")));assertEquals(signed,signatures.get());assertEquals(1,count("receipts"));
    }
    @Test public void foreignAuthorityCannotReadCommitOrCancelAnotherPendingIntent()throws Exception{
        String pending=id();checkout.beginPaymentIntent(pending,input());differentAuthority();fails(()->checkout.getPaymentIntent(pending));fails(()->checkout.confirmPaymentIntent(pending));fails(()->checkout.cancelUncollectedIntent(pending,"No payment collected"));assertEquals(0,count("receipts"));assertEquals(0,count("offline_intent_cancellations"));assertTrue(checkout.getState().isNull("unresolvedIntent"));
    }
    @Test public void foreignAuthorityCannotReadCommittedOrReplayCancelledIntents()throws Exception{
        String committed=id();checkout.beginPaymentIntent(committed,input());String receipt=checkout.confirmPaymentIntent(committed).getJSONObject("receipt").getString("id");String cancelled=id();checkout.beginPaymentIntent(cancelled,input());checkout.cancelUncollectedIntent(cancelled,"No payment collected");differentAuthority();
        fails(()->checkout.getPaymentIntent(committed));fails(()->checkout.confirmPaymentIntent(committed));fails(()->checkout.getReceipt(receipt));fails(()->checkout.getPaymentIntent(cancelled));fails(()->checkout.cancelUncollectedIntent(cancelled,"No payment collected"));assertEquals(1,count("receipts"));assertEquals(1,count("offline_intent_cancellations"));
    }
    @Test public void stalePresentedTotalAndUnsignedPriceCannotReachIntent()throws Exception{
        JSONObject quote=checkout.quoteBasket(draft()),stale=new JSONObject(quote.getJSONObject("request").toString());stale.getJSONArray("lines").getJSONObject(0).put("quantityMilli",2000);fails(()->checkout.beginPaymentIntent(id(),stale));JSONObject forged=input();forged.getJSONArray("lines").getJSONObject(0).put("unitPriceFils",1);fails(()->checkout.beginPaymentIntent(id(),forged));fails(()->checkout.beginPaymentIntent(id(),input().put("presentedTotalFils",999)));assertEquals(0,count("intents"));assertEquals(0,count("receipts"));
    }
    @Test public void quoteRejectsUnknownProductsFractionalPiecesAndExtraFinancialFields()throws Exception{
        JSONObject unknown=draft();unknown.getJSONArray("lines").getJSONObject(0).put("productId",id());fails(()->checkout.quoteBasket(unknown));JSONObject fractional=draft();fractional.getJSONArray("lines").getJSONObject(0).put("quantityMilli",500);fails(()->checkout.quoteBasket(fractional));fails(()->checkout.quoteBasket(draft().put("unitPriceFils",1)));fails(()->checkout.quoteBasket(draft().put("presentedTotalFils",1)));JSONObject line=draft();line.getJSONArray("lines").getJSONObject(0).put("taxRateBps",0);fails(()->checkout.quoteBasket(line));assertEquals(0,count("intents"));
    }
    @Test public void cashCardAndWeightedMixedQuotesUseNativeTotalsAndRejectContradictoryTender()throws Exception{
        JSONObject card=checkout.quoteBasket(draft().put("tenderMode","card"));assertEquals(0,card.getJSONObject("request").getLong("cashTenderedFils"));assertEquals(1000,card.getJSONObject("request").getLong("recordedCardFils"));assertEquals("card",card.getJSONArray("payments").getJSONObject(0).getString("method"));
        JSONObject weighted=draft().put("tenderMode","mixed").put("cashTenderedFils",500).put("recordedCardFils",100).put("lines",new JSONArray().put(new JSONObject().put("productId",snapshot.getJSONArray("products").getJSONObject(1).getString("id")).put("quantityMilli",500)));JSONObject mixed=checkout.quoteBasket(weighted);assertEquals(501,mixed.getJSONObject("totals").getLong("grossFils"));assertEquals(99,mixed.getLong("changeFils"));assertEquals(401,mixed.getJSONArray("payments").getJSONObject(0).getLong("amountFils"));
        JSONObject exact=checkout.quoteBasket(new JSONObject(weighted.toString()).put("cashTenderedFils",JSONObject.NULL));assertEquals(401,exact.getLong("cashTenderedFils"));assertEquals(0,exact.getLong("changeFils"));fails(()->checkout.quoteBasket(draft().put("recordedCardFils",1)));fails(()->checkout.quoteBasket(draft().put("tenderMode","card").put("cashTenderedFils",1)));fails(()->checkout.quoteBasket(draft().put("tenderMode","card").put("recordedCardFils",999)));fails(()->checkout.quoteBasket(draft().put("tenderMode","mixed").put("recordedCardFils",0)));fails(()->checkout.quoteBasket(draft().put("tenderMode","mixed").put("recordedCardFils",1000)));assertEquals(0,count("intents"));
    }
    @Test public void expiryDuringCollectionRetainsOriginalIntentUntilExplicitTruthfulCancellation()throws Exception{
        String pending=id();checkout.beginPaymentIntent(pending,input());wall+=3_600_000;elapsed+=3_600_000;JSONObject unresolved=checkout.getPaymentIntent(pending);assertFalse(unresolved.getBoolean("canConfirm"));assertTrue(unresolved.getBoolean("canCancel"));fails(()->checkout.confirmPaymentIntent(pending));assertEquals("payment_confirmation_required",engine.getIntent(pending).getString("state"));assertEquals(0,count("receipts"));assertEquals(0,count("outbox"));assertEquals(1,value("SELECT next_number FROM offline_authority_state"));
        JSONObject result=checkout.cancelUncollectedIntent(pending,"No payment collected");assertEquals("cancelled",result.getString("state"));assertEquals(1,count("intents"));assertEquals(1,count("offline_intent_cancellations"));fails(()->checkout.confirmPaymentIntent(pending));fails(()->checkout.cancelUncollectedIntent(pending,"Different statement"));assertEquals(0,count("receipts"));
    }
    @Test public void signingFailurePreservesUncertainIntentAndRetryCreatesOnlyOneBill()throws Exception{
        String pending=id();checkout.beginPaymentIntent(pending,input());failSigning=true;fails(()->checkout.confirmPaymentIntent(pending));assertEquals(0,count("receipts"));assertEquals(1,count("intents"));assertEquals(pending,checkout.getState().getString("pendingIntentId"));failSigning=false;assertEquals("committed",checkout.confirmPaymentIntent(pending).getString("state"));assertEquals(1,count("receipts"));assertEquals(1,count("outbox"));
    }
    @Test public void largeNativeQuoteRequiresBuyerAtBeginAndQuoteCannotChangeSignedCatalogue()throws Exception{
        engine.sealAuthority(authority.getString("id"));authority.put("id",id()).put("maxInvoiceTotalFils",2_000_000).put("maxGrossFils",6_000_000);authority.getJSONObject("invoiceRange").put("first",4).put("last",6);snapshot.put("id",id());authority.put("snapshotId",snapshot.getString("id"));snapshot.getJSONArray("products").getJSONObject(0).put("unitPriceFils",2_000_000);rebuild();engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start);currentBundle=verifiedBundle();
        JSONObject quote=checkout.quoteBasket(draft());assertTrue(quote.getBoolean("requiresBuyerDetails"));assertEquals(2_000_000,quote.getJSONObject("totals").getLong("grossFils"));fails(()->checkout.beginPaymentIntent(id(),quote.getJSONObject("request")));assertEquals(0,count("intents"));
        quote.getJSONArray("lines").getJSONObject(0).put("unitPriceFils",1);quote.getJSONObject("totals").put("grossFils",1);assertEquals(2_000_000,checkout.quoteBasket(draft()).getJSONObject("totals").getLong("grossFils"));JSONObject buyer=draft().put("customer",new JSONObject().put("name","Synthetic buyer").put("address","Synthetic address").put("trn",JSONObject.NULL));String pending=id();checkout.beginPaymentIntent(pending,checkout.quoteBasket(buyer).getJSONObject("request"));assertEquals("committed",checkout.confirmPaymentIntent(pending).getString("state"));assertEquals(1,count("receipts"));
    }

    @Test public void exportsActualSyntheticCoordinatorResponsesForTypeScriptContractValidation()throws Exception{
        JSONObject samples=new JSONObject().put("initialState",checkout.getState()).put("quote",checkout.quoteBasket(draft()));String pending=id();samples.put("pendingIntent",checkout.beginPaymentIntent(pending,samples.getJSONObject("quote").getJSONObject("request"))).put("pendingState",checkout.getState());
        samples.put("committedIntent",checkout.confirmPaymentIntent(pending));String receiptId=samples.getJSONObject("committedIntent").getJSONObject("receipt").getString("id");samples.put("receipt",checkout.getReceipt(receiptId)).put("committedState",checkout.getState());locked=true;samples.put("lockedState",checkout.getState());signedOut=true;samples.put("signedOutState",checkout.getState());
        JSONObject export=new JSONObject().put("schemaVersion",1).put("provenance","Actual isolated Android NativeCheckoutCoordinator with synthetic merchant, ephemeral server key and package-private enabled test seam; production remains disabled").put("samples",samples);java.io.File file=new java.io.File(context.getCacheDir(),"native-counter-contract.json");try(java.io.FileOutputStream out=new java.io.FileOutputStream(file)){out.write(export.toString(2).getBytes(java.nio.charset.StandardCharsets.UTF_8));}assertTrue(file.isFile());assertEquals(1,count("receipts"));assertTrue(samples.getJSONObject("lockedState").isNull("lastReceipt"));assertTrue(samples.getJSONObject("signedOutState").isNull("context"));
    }

    @Test public void priorAuthorityReceiptDoesNotBlockCurrentAuthorityCheckoutState()throws Exception{
        String pending=id();checkout.beginPaymentIntent(pending,input());checkout.confirmPaymentIntent(pending);differentAuthority();checkout=coordinator(false);JSONObject state=checkout.getState();assertEquals("native_checkout_not_enabled",state.getString("reasonCode"));assertEquals(authority.getString("id"),state.getJSONObject("context").getString("authorityId"));assertTrue(state.isNull("lastReceipt"));assertTrue(state.isNull("lastReceiptId"));assertFalse(state.getBoolean("canIssue"));assertEquals(1,count("receipts"));
    }

}
