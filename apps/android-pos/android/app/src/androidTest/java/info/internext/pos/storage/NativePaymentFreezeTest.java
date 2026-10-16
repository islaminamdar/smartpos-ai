package info.internext.pos.storage;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.ContentValues;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
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
public class NativePaymentFreezeTest {
    private Context context; private String dbName,alias; private NativeJournal journal; private DeviceIdentity identity;
    private NativeCheckoutEngine engine; private OfflineBundle.Binding binding; private KeyPair server; private PublicKey device;
    private JSONObject snapshot,authority; private String snapshotEnvelope,authorityEnvelope,boot=UUID.randomUUID().toString();
    private final long start=1_792_132_200_000L; private long wall=start,elapsed=1000; private boolean locked=false,failSigning=false,failCommit=false,failObservation=false;
    private NativeCheckoutCoordinator checkout;private OfflineBundle currentBundle;private boolean signedOut;
    private AtomicInteger signatures=new AtomicInteger();
    private final List<String> migrationDbs=new ArrayList<>();
    @Before public void setUp() throws Exception {
        context=InstrumentationRegistry.getInstrumentation().getTargetContext(); dbName="payment-freeze-audit-"+UUID.randomUUID()+".db";alias="internext.pos.test.paymentfreeze."+UUID.randomUUID();
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
    private NativeCheckoutEngine createEngine(NativeJournal j)throws Exception{return new NativeCheckoutEngine(j,Collections.singletonMap("synthetic-server",server.getPublic()),binding,device,b->{if(locked)throw new IllegalStateException("locked");},()->{if(failObservation)throw new IllegalStateException("clock_source_blocked");return new OfflineClock.Reading(boot,elapsed,wall);},bytes->{signatures.incrementAndGet();if(failSigning)throw new IllegalStateException("signing_failed");return identity.sign(bytes);});}
    private void rebuild()throws Exception{authority.put("snapshotSha256",SignedProtocol.hash(CanonicalJson.bytes(snapshot)));snapshotEnvelope=SignedProtocol.sign(snapshot,"synthetic-server",server.getPrivate(),server.getPublic());authorityEnvelope=SignedProtocol.sign(authority,"synthetic-server",server.getPrivate(),server.getPublic());}
    @After public void tearDown()throws Exception{if(journal!=null)journal.close();assertTrue(context.deleteDatabase(dbName));for(String db:migrationDbs){context.deleteDatabase(db);assertFalse(context.getDatabasePath(db).exists());}KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);ks.deleteEntry(alias);assertFalse(ks.containsAlias(alias));}
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
    private String text(String query){try(Cursor c=journal.getReadableDatabase().rawQuery(query,null)){assertTrue(c.moveToFirst());return c.isNull(0)?null:c.getString(0);}}
    private String begin()throws Exception{String intent=id();engine.beginPaymentIntent(intent,input());return intent;}
    private String freeze(String intent)throws Exception{return engine.freezePaymentIntentForManager(intent);}
    private JSONObject freezeValues(String intent)throws Exception{
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT * FROM offline_intent_freezes WHERE intent_id=?",new String[]{intent})){
            assertTrue(c.moveToFirst());JSONObject row=new JSONObject();for(int i=0;i<c.getColumnCount();i++)row.put(c.getColumnName(i),c.isNull(i)?JSONObject.NULL:c.getString(i));return row;
        }
    }
    private ContentValues values(JSONObject row)throws Exception{
        ContentValues result=new ContentValues();java.util.Iterator<String> names=row.keys();while(names.hasNext()){String name=names.next();if(row.isNull(name))result.putNull(name);else result.put(name,row.getString(name));}return result;
    }
    private void assertFrozen(String intent)throws Exception{
        JSONObject view=checkout.getPaymentIntent(intent);assertEquals("frozen_for_manager",view.getString("state"));assertFalse(view.getBoolean("canConfirm"));assertFalse(view.getBoolean("canCancel"));assertEquals("payment_frozen",view.getString("reasonCode"));assertTrue(view.isNull("receipt"));
        JSONObject manager=view.getJSONObject("managerReview");assertEquals(3,manager.length());assertEquals("saved_locally",manager.getString("status"));
        JSONObject saved=freezeValues(intent);assertEquals(saved.getString("freeze_id"),manager.getString("freezeId"));assertEquals(saved.getString("proof_payload_sha256"),manager.getString("proofSha256"));
        assertFalse(view.toString().contains("payloadBase64Url"));assertFalse(view.toString().contains("signatureBase64Url"));assertFalse(engine.getIntent(intent).toString().contains("payloadBase64Url"));
    }
    @Test public void expiryAllowsOnlyPermanentFreezeWithOriginalRequestIdsAndNoInvoice()throws Exception{
        String intent=begin(),clock=text("SELECT clock_json FROM offline_authority_state"),created=text("SELECT created_at FROM intents");
        wall+=7_200_000;elapsed+=7_200_000;fails(()->engine.commitPaymentIntent(intent));
        String signed=freeze(intent);JSONObject proof=payload(signed);assertEquals(22,proof.length());assertEquals("offline-payment-freeze",proof.getString("kind"));assertEquals(1,proof.getInt("schemaVersion"));assertEquals("local-intent-unissued-and-permanently-frozen",proof.getString("declaration"));
        assertEquals(intent,proof.getString("paymentIntentId"));assertEquals(text("SELECT order_id FROM offline_intent_context"),proof.getString("orderId"));assertEquals(text("SELECT document_id FROM offline_intent_context"),proof.getString("documentId"));assertEquals(created,proof.getString("intentCreatedAt"));
        assertEquals(canonical(input()),canonical(proof.getJSONObject("request")));assertEquals(SignedProtocol.hash(CanonicalJson.bytes(input())),proof.getString("requestSha256"));assertEquals(currentBundle.authoritySha256,proof.getString("authoritySha256"));assertEquals(currentBundle.snapshotSha256,proof.getString("snapshotSha256"));
        assertEquals(binding.actorId,proof.getString("actorId"));assertEquals(binding.organizationId,proof.getString("organizationId"));assertEquals(binding.branchId,proof.getString("branchId"));assertEquals(binding.deviceId,proof.getString("deviceId"));assertEquals(binding.shiftId,proof.getString("shiftId"));assertEquals(binding.keyEpoch,proof.getString("keyEpoch"));assertEquals(binding.deviceKeySha256,proof.getString("deviceKeySha256"));assertEquals(currentBundle.authorityId,proof.getString("authorityId"));
        assertEquals(0,proof.getJSONObject("chainHead").getLong("sequence"));assertTrue(proof.getJSONObject("chainHead").isNull("eventSha256"));assertEquals(wall,proof.getJSONObject("observation").getLong("wallTimeMs"));assertEquals(elapsed,proof.getJSONObject("observation").getLong("elapsedRealtimeMs"));assertEquals(boot,proof.getJSONObject("observation").getString("bootId"));
        assertEquals(clock,text("SELECT clock_json FROM offline_authority_state"));assertEquals(1,value("SELECT next_number FROM offline_authority_state"));assertEquals(0,value("SELECT gross_fils FROM offline_authority_state"));assertEquals(0,count("receipts"));assertEquals(0,count("outbox"));assertFrozen(intent);
    }
    @Test public void exactFreezeReplaySurvivesRestartButStillRequiresCurrentScopeAndPin()throws Exception{
        String intent=begin(),first=freeze(intent);int signed=signatures.get();String row=canonical(freezeValues(intent));reopen();
        locked=true;fails(()->checkout.freezePaymentIntentForManager(intent));fails(()->engine.freezePaymentIntentForManager(intent));assertEquals(signed,signatures.get());
        locked=false;signedOut=true;fails(()->checkout.freezePaymentIntentForManager(intent));assertTrue(checkout.getState().isNull("unresolvedIntent"));signedOut=false;
        OfflineBundle original=currentBundle;differentAuthority();fails(()->checkout.freezePaymentIntentForManager(intent));currentBundle=original;
        wall+=7_200_000;elapsed+=7_200_000;assertEquals(first,freeze(intent));assertEquals(signed,signatures.get());assertEquals(row,canonical(freezeValues(intent)));assertFrozen(intent);
    }
    @Test public void signedOutLockedOrForeignAllocationCannotCreateFreeze()throws Exception{
        String intent=begin();signedOut=true;fails(()->checkout.freezePaymentIntentForManager(intent));signedOut=false;locked=true;fails(()->checkout.freezePaymentIntentForManager(intent));locked=false;
        OfflineBundle original=currentBundle;differentAuthority();fails(()->checkout.freezePaymentIntentForManager(intent));assertEquals(0,count("offline_intent_freezes"));currentBundle=original;
        assertEquals("frozen_for_manager",checkout.freezePaymentIntentForManager(intent).getString("state"));assertFrozen(intent);
    }
    @Test public void frozenIntentBlocksEngineCommitCancelNewCollectionAndSeal()throws Exception{
        String intent=begin();freeze(intent);fails(()->engine.commitPaymentIntent(intent));fails(()->engine.cancelUncollectedIntent(intent,"No funds collected"));fails(()->engine.beginPaymentIntent(id(),input()));fails(()->engine.sealAuthority(currentBundle.authorityId));
        assertEquals(1,count("intents"));assertEquals(0,count("receipts"));assertEquals(0,count("offline_intent_cancellations"));assertNull(text("SELECT seal_envelope FROM offline_authority_state"));assertFalse(checkout.getState().getBoolean("canIssue"));assertEquals(intent,checkout.getState().getString("pendingIntentId"));
        assertEquals("frozen_for_manager",engine.beginPaymentIntent(intent,input()).getString("state"));fails(()->engine.beginPaymentIntent(intent,input().put("cashTenderedFils",2000)));assertFrozen(intent);
    }
    @Test public void sqliteGuardsRejectDirectReceiptAssignmentInsertionAndCancellation()throws Exception{
        String intent=begin(),proof=freeze(intent),receipt=id();SQLiteDatabase db=journal.getWritableDatabase();
        SQLiteException assignment=assertThrows(SQLiteException.class,()->db.execSQL("UPDATE intents SET receipt_id=? WHERE id=?",new Object[]{receipt,intent}));assertTrue(assignment.getMessage().contains("frozen"));
        ContentValues row=new ContentValues();row.put("id",receipt);row.put("intent_id",intent);row.put("document_number","TEST-INV-0000000001");row.put("issued_at",NativeCheckoutEngine.iso(start));row.put("total_fils",1000);row.put("payload_hash",NativeJournal.payloadHash(proof));row.put("envelope_hash",NativeJournal.hash(proof));row.put("envelope_json",proof);
        SQLiteException insert=assertThrows(SQLiteException.class,()->db.insertOrThrow("receipts",null,row));assertTrue(insert.getMessage().contains("frozen"));
        SQLiteException cancel=assertThrows(SQLiteException.class,()->db.execSQL("INSERT INTO offline_intent_cancellations(intent_id,reason,cancelled_at) VALUES(?,?,?)",new Object[]{intent,"No funds collected",NativeCheckoutEngine.iso(start)}));assertTrue(cancel.getMessage().contains("frozen"));
        assertEquals(0,count("receipts"));assertEquals(0,count("outbox"));assertEquals(0,count("offline_intent_cancellations"));assertNull(text("SELECT receipt_id FROM intents"));assertFrozen(intent);
    }
    @Test public void freezeRowsCannotBeUpdatedDeletedOrReplaced()throws Exception{
        String intent=begin();freeze(intent);JSONObject row=freezeValues(intent);SQLiteDatabase db=journal.getWritableDatabase();
        assertThrows(SQLiteException.class,()->db.execSQL("UPDATE offline_intent_freezes SET freeze_id=? WHERE intent_id=?",new Object[]{id(),intent}));
        assertThrows(SQLiteException.class,()->db.delete("offline_intent_freezes","intent_id=?",new String[]{intent}));
        ContentValues same=values(row);assertThrows(SQLiteException.class,()->db.insertWithOnConflict("offline_intent_freezes",null,same,SQLiteDatabase.CONFLICT_REPLACE));assertEquals(canonical(row),canonical(freezeValues(intent)));
    }
    @Test public void committedOrCancelledIntentCannotBeFrozenEvenThroughDirectSql()throws Exception{
        String committed=begin(),receipt=engine.commitPaymentIntent(committed),cancelled=begin();engine.cancelUncollectedIntent(cancelled,"No money collected");String frozen=begin();freeze(frozen);
        fails(()->freeze(committed));fails(()->freeze(cancelled));assertEquals(receipt,engine.commitPaymentIntent(committed));
        JSONObject row=freezeValues(frozen);for(String target:new String[]{committed,cancelled}){JSONObject changed=new JSONObject(row.toString()).put("intent_id",target).put("freeze_id",id());ContentValues insert=values(changed);assertThrows(SQLiteException.class,()->journal.getWritableDatabase().insertOrThrow("offline_intent_freezes",null,insert));}
        assertEquals(1,count("offline_intent_freezes"));assertEquals(1,count("receipts"));assertEquals(1,count("offline_intent_cancellations"));
    }
    @Test public void signingAndStorageFailureRollbackFreezeWithoutLosingOriginalIntent()throws Exception{
        String intent=begin(),original=text("SELECT request_json FROM intents");failSigning=true;fails(()->freeze(intent));assertEquals(0,count("offline_intent_freezes"));failSigning=false;
        journal.getWritableDatabase().execSQL("CREATE TRIGGER synthetic_freeze_full BEFORE INSERT ON offline_intent_freezes BEGIN SELECT RAISE(ABORT,'synthetic_disk_full'); END");fails(()->freeze(intent));assertEquals(0,count("offline_intent_freezes"));
        journal.getWritableDatabase().execSQL("DROP TRIGGER synthetic_freeze_full");reopen();assertEquals(original,text("SELECT request_json FROM intents"));assertEquals("payment_confirmation_required",engine.getIntent(intent).getString("state"));freeze(intent);assertFrozen(intent);assertEquals(0,count("receipts"));assertEquals(1,value("SELECT next_number FROM offline_authority_state"));
    }
    @Test public void corruptStoredRequestCannotBeAuthenticatedAsNewFreeze()throws Exception{
        String intent=begin();SQLiteDatabase db=journal.getWritableDatabase();db.execSQL("DROP TRIGGER intents_immutable_update");db.execSQL("UPDATE intents SET request_json=? WHERE id=?",new Object[]{canonical(input().put("cashTenderedFils",2000)),intent});
        fails(()->freeze(intent));assertEquals(0,count("offline_intent_freezes"));assertEquals(0,signatures.get());assertEquals(0,count("receipts"));
    }
    @Test public void unavailableClockRecordsNullObservationWithoutInventingTimeOrResettingAnchor()throws Exception{
        String intent=begin(),anchor=text("SELECT clock_json FROM offline_authority_state"),created=text("SELECT created_at FROM intents");failObservation=true;
        JSONObject proof=payload(freeze(intent));assertTrue(proof.isNull("observation"));assertEquals(created,proof.getString("intentCreatedAt"));assertEquals(anchor,text("SELECT clock_json FROM offline_authority_state"));assertEquals(0,value("SELECT sequence FROM offline_chain"));assertFrozen(intent);
    }
    @Test public void clockFailureInMandatoryUnlockGuardCannotUseDiagnosticFallback()throws Exception{
        String intent=begin();NativeCheckoutEngine guarded=new NativeCheckoutEngine(journal,Collections.singletonMap("synthetic-server",server.getPublic()),binding,device,b->{throw new IllegalStateException("clock_source_blocked");},()->new OfflineClock.Reading(boot,elapsed,wall),identity::sign);
        assertEquals("clock_source_blocked",assertThrows(IllegalStateException.class,()->guarded.freezePaymentIntentForManager(intent)).getMessage());assertEquals(0,count("offline_intent_freezes"));assertEquals("payment_confirmation_required",engine.getIntent(intent).getString("state"));
    }
    @Test public void changedStoredFreezeDigestCannotBeReplayedOrDisplayed()throws Exception{
        String intent=begin();freeze(intent);int signed=signatures.get();journal.getWritableDatabase().execSQL("DROP TRIGGER offline_freeze_immutable_update");
        journal.getWritableDatabase().execSQL("UPDATE offline_intent_freezes SET proof_payload_sha256=? WHERE intent_id=?",new Object[]{String.join("",Collections.nCopies(64,"f")),intent});
        fails(()->freeze(intent));fails(()->checkout.getPaymentIntent(intent));fails(()->engine.commitPaymentIntent(intent));assertEquals(signed,signatures.get());assertEquals(1,count("offline_intent_freezes"));assertEquals(0,count("receipts"));
    }
    @Test public void freezeRetainsExactExistingReceiptHeadWithoutAdvancingChain()throws Exception{
        String receipt=sell(),intent=begin();JSONObject proof=payload(freeze(intent));assertEquals(1,proof.getJSONObject("chainHead").getLong("sequence"));
        assertEquals(SignedProtocol.verify(receipt,Collections.singletonMap(binding.deviceKeySha256,device)).payloadSha256,proof.getJSONObject("chainHead").getString("eventSha256"));assertEquals(1,value("SELECT sequence FROM offline_chain"));assertEquals(2,value("SELECT next_number FROM offline_authority_state"));assertEquals(1000,value("SELECT gross_fils FROM offline_authority_state"));assertEquals(1,count("receipts"));assertEquals(1,count("outbox"));assertFrozen(intent);
    }
    @Test public void concurrentCommitAndFreezeOnIndependentConnectionsHaveExactlyOneWinner()throws Exception{
        String intent=begin();NativeJournal other=new NativeJournal(context,dbName,()->{});NativeCheckoutEngine second=createEngine(other);CountDownLatch startRace=new CountDownLatch(1);
        AtomicReference<String> committed=new AtomicReference<>(),frozen=new AtomicReference<>();AtomicReference<Throwable> commitError=new AtomicReference<>(),freezeError=new AtomicReference<>();
        Thread a=new Thread(()->{try{startRace.await();committed.set(engine.commitPaymentIntent(intent));}catch(Throwable e){commitError.set(e);}}),b=new Thread(()->{try{startRace.await();frozen.set(second.freezePaymentIntentForManager(intent));}catch(Throwable e){freezeError.set(e);}});
        try{a.start();b.start();startRace.countDown();a.join(10000);b.join(10000);assertFalse(a.isAlive());assertFalse(b.isAlive());assertTrue((committed.get()!=null)^(frozen.get()!=null));assertEquals(1,count("receipts")+count("offline_intent_freezes"));
            if(frozen.get()!=null){assertNotNull(commitError.get());assertEquals(0,count("outbox"));assertEquals(0,value("SELECT sequence FROM offline_chain"));assertFrozen(intent);}else{assertNotNull(freezeError.get());assertEquals(committed.get(),engine.commitPaymentIntent(intent));assertEquals(1,count("outbox"));assertEquals(1,value("SELECT sequence FROM offline_chain"));}
        }finally{other.close();}
    }
    @Test public void concurrentFreezeReturnsFirstExactProofWithoutDuplicateSignatures()throws Exception{
        String intent=begin();NativeJournal other=new NativeJournal(context,dbName,()->{});NativeCheckoutEngine second=createEngine(other);CountDownLatch gate=new CountDownLatch(1);AtomicReference<String>a=new AtomicReference<>(),b=new AtomicReference<>();AtomicReference<Throwable>failure=new AtomicReference<>();
        Thread one=new Thread(()->{try{gate.await();a.set(freeze(intent));}catch(Throwable e){failure.set(e);}}),two=new Thread(()->{try{gate.await();b.set(second.freezePaymentIntentForManager(intent));}catch(Throwable e){failure.set(e);}});
        try{one.start();two.start();gate.countDown();one.join(10000);two.join(10000);assertFalse(one.isAlive());assertFalse(two.isAlive());if(failure.get()!=null)throw new AssertionError(failure.get());assertEquals(a.get(),b.get());assertEquals(1,signatures.get());assertEquals(1,count("offline_intent_freezes"));assertFrozen(intent);}finally{other.close();}
    }
    @Test public void disabledSalesGateStillAllowsExplicitScopedFreezeAndExportsSyntheticProof()throws Exception{
        String intent=begin();checkout=coordinator(false);JSONObject frozen=checkout.freezePaymentIntentForManager(intent);assertEquals("frozen_for_manager",frozen.getString("state"));assertFrozen(intent);assertFalse(checkout.getState().getBoolean("canIssue"));
        String envelope=freeze(intent);JSONObject proof=payload(envelope);byte[] nonce=new byte[32];new java.security.SecureRandom().nextBytes(nonce);StringBuilder challenge=new StringBuilder();for(byte b:nonce)challenge.append(String.format(java.util.Locale.ROOT,"%02x",b&255));
        JSONObject query=new JSONObject().put("kind","offline-payment-resolution-query").put("schemaVersion",1).put("authorityId",currentBundle.authorityId).put("keyEpoch",binding.keyEpoch).put("deviceId",binding.deviceId).put("freezeId",proof.getString("freezeId")).put("freezeSha256",NativeJournal.payloadHash(envelope)).put("challenge",challenge.toString());
        byte[] bytes=CanonicalJson.bytes(query),signature=identity.sign(bytes);SignedProtocol.requireDer(signature);
        JSONObject queryEnvelope=new JSONObject().put("format","pos-signed-v1").put("alg","ECDSA-P256-SHA256-DER").put("keyId",binding.deviceKeySha256).put("payloadBase64Url",SignedProtocol.encode(bytes)).put("signatureBase64Url",SignedProtocol.encode(signature));
        assertEquals(canonical(query),canonical(payload(queryEnvelope.toString())));
        JSONObject exported=new JSONObject().put("schemaVersion",1).put("publicKeySpki",SignedProtocol.encode(device.getEncoded())).put("deviceKeySha256",binding.deviceKeySha256)
            .put("serverPublicKeySpki",SignedProtocol.encode(server.getPublic().getEncoded())).put("snapshotEnvelope",new JSONObject(snapshotEnvelope)).put("authorityEnvelope",new JSONObject(authorityEnvelope)).put("freezeEnvelope",new JSONObject(envelope)).put("queryEnvelope",queryEnvelope).put("intentDisplay",frozen).put("counterState",checkout.getState());
        try(FileOutputStream out=new FileOutputStream(new File(context.getCacheDir(),"native-payment-freeze-contract.json"))){out.write(exported.toString().getBytes(StandardCharsets.UTF_8));}
        assertEquals(0,count("receipts"));assertEquals(0,count("outbox"));
    }
    private void acknowledge(String receipt)throws Exception{
        JSONObject proof=payload(receipt);JSONObject ack=new JSONObject().put("kind","offline-ack").put("schemaVersion",1).put("id",id()).put("issuanceId",proof.getString("id"))
            .put("payloadSha256",NativeJournal.payloadHash(receipt)).put("authorityId",proof.getString("authorityId")).put("keyEpoch",binding.keyEpoch).put("deviceSequence",proof.getLong("deviceSequence")).put("receivedAt",NativeCheckoutEngine.iso(start));
        engine.acknowledgeIssuance(SignedProtocol.sign(ack,"synthetic-server",server.getPrivate(),server.getPublic()));
    }
    private JSONObject asset(String name)throws Exception{
        ByteArrayOutputStream out=new ByteArrayOutputStream();try(InputStream in=InstrumentationRegistry.getInstrumentation().getContext().getAssets().open(name)){byte[] bytes=new byte[4096];int n;while((n=in.read(bytes))!=-1)out.write(bytes,0,n);}return new JSONObject(out.toString("UTF-8"));
    }
    private JSONArray tableRows(SQLiteDatabase db,String table)throws Exception{
        JSONArray rows=new JSONArray();try(Cursor c=db.rawQuery("SELECT * FROM "+table+" ORDER BY rowid",null)){
            while(c.moveToNext()){JSONObject row=new JSONObject();for(int i=0;i<c.getColumnCount();i++)switch(c.getType(i)){
                case Cursor.FIELD_TYPE_NULL:row.put(c.getColumnName(i),JSONObject.NULL);break;
                case Cursor.FIELD_TYPE_INTEGER:row.put(c.getColumnName(i),c.getLong(i));break;
                case Cursor.FIELD_TYPE_STRING:row.put(c.getColumnName(i),c.getString(i));break;
                default:throw new AssertionError("Unexpected historical column type");
            }rows.put(row);}
        }return rows;
    }
    private String exactRows(SQLiteDatabase db,String table)throws Exception{return new String(CanonicalJson.bytes(tableRows(db,table)),StandardCharsets.UTF_8);}
    private void migrateHistorical(int version)throws Exception{
        // Build meaningful original records using the real engine, then copy only the tables
        // that existed in the historical schema into a separate, genuinely old database.
        String first=sell();acknowledge(first);String second=sell();String cancelled=begin();engine.cancelUncollectedIntent(cancelled,"No money collected");String oldAuthority=currentBundle.authorityId,seal=engine.sealAuthority(oldAuthority);
        if(version>=3){
            JSONObject confirmation=new JSONObject().put("status","sealed").put("authorityId",oldAuthority).put("finalSequence",2);
            journal.getWritableDatabase().execSQL("INSERT INTO offline_seal_confirmations(authority_id,seal_payload_hash,response_json) VALUES(?,?,?)",new Object[]{oldAuthority,NativeJournal.payloadHash(seal),canonical(confirmation)});
            journal.getWritableDatabase().execSQL("INSERT INTO offline_upload_exceptions(receipt_id,exception_id,payload_hash,code) VALUES(?,?,?,?)",new Object[]{payload(second).getString("id"),id(),NativeJournal.payloadHash(second),"chain"});
        }
        authority.put("id",id());authority.getJSONObject("invoiceRange").put("first",4).put("last",6);rebuild();currentBundle=verifiedBundle();
        // Reconstruct the old v2/v3 state directly: those versions allowed another grant
        // while the second receipt remained unacknowledged. The v6 installer rightly refuses it.
        journal.getWritableDatabase().execSQL("INSERT INTO offline_bundles(id,snapshot_envelope,authority_envelope) VALUES(?,?,?)",new Object[]{currentBundle.authorityId,snapshotEnvelope,authorityEnvelope});
        journal.getWritableDatabase().execSQL("INSERT INTO offline_authority_state(authority_id,next_number,gross_fils,clock_json) VALUES(?,?,?,?)",new Object[]{currentBundle.authorityId,4,0,OfflineClock.anchor(start,new OfflineClock.Reading(boot,elapsed,wall)).toJson()});
        String pending=begin();
        List<String> tables=new ArrayList<>(java.util.Arrays.asList("installation","device_key","intents","receipts","outbox","acknowledgements"));
        if(version>=2)tables.addAll(java.util.Arrays.asList("offline_bundles","offline_authority_state","offline_chain","offline_intent_context","offline_intent_cancellations"));
        if(version>=3)tables.addAll(java.util.Arrays.asList("offline_seal_confirmations","offline_upload_exceptions"));
        JSONObject ddl=asset("native-ledger-historical-schema.json");assertTrue(ddl.getString("sourceCommit").matches("[a-f0-9]{40}"));
        String migratedName="payment-freeze-upgrade-v"+version+"-"+id()+".db";migrationDbs.add(migratedName);java.util.Map<String,String> expected=new java.util.HashMap<>();
        try(SQLiteDatabase old=SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(migratedName),null)){
            old.setForeignKeyConstraintsEnabled(true);old.execSQL("PRAGMA recursive_triggers=ON");
            for(int v=1;v<=version;v++){JSONArray sql=ddl.getJSONArray("version"+v);for(int i=0;i<sql.length();i++)old.execSQL(sql.getString(i));}
            for(String table:tables){JSONArray rows=tableRows(journal.getReadableDatabase(),table);for(int i=0;i<rows.length();i++)old.insertOrThrow(table,null,values(rows.getJSONObject(i)));expected.put(table,exactRows(old,table));}
            old.setVersion(version);assertEquals(version,old.getVersion());
            try(Cursor c=old.rawQuery("SELECT count(*) FROM sqlite_master WHERE name='offline_intent_freezes'",null)){assertTrue(c.moveToFirst());assertEquals(0,c.getInt(0));}
        }
        try(NativeJournal upgraded=new NativeJournal(context,migratedName,()->{})){
            assertEquals(6,upgraded.getReadableDatabase().getVersion());assertEquals(journal.installationId(),upgraded.installationId());
            assertEquals(binding.deviceKeySha256,identity.readOrCreate(upgraded).getString("deviceKeySha256"));
            for(String table:tables)assertEquals("Preserved v"+version+" "+table,expected.get(table),exactRows(upgraded.getReadableDatabase(),table));
            assertEquals("[]",exactRows(upgraded.getReadableDatabase(),"offline_intent_freezes"));
            assertEquals(2,upgraded.status().getLong("receiptCount"));assertEquals(1,upgraded.status().getLong("pendingCount"));
            NativeCheckoutEngine migratedEngine=createEngine(upgraded);
            if(version>=2){String proof=migratedEngine.freezePaymentIntentForManager(pending);assertEquals(pending,payload(proof).getString("paymentIntentId"));fails(()->migratedEngine.commitPaymentIntent(pending));}
            else{fails(()->migratedEngine.freezePaymentIntentForManager(pending));assertEquals("[]",exactRows(upgraded.getReadableDatabase(),"offline_intent_freezes"));}
            for(String table:tables)assertEquals("Still preserved after v"+version+" freeze "+table,expected.get(table),exactRows(upgraded.getReadableDatabase(),table));
        }
    }
    @Test public void actualVersionOneMigrationPreservesKeysReceiptsOutboxAndIntentHistory()throws Exception{migrateHistorical(1);}
    @Test public void actualVersionTwoMigrationPreservesBundlesClockChainSealsAndCancellations()throws Exception{migrateHistorical(2);}
    @Test public void actualVersionThreeMigrationAlsoPreservesUploadExceptionsAndSealConfirmations()throws Exception{migrateHistorical(3);}
}
