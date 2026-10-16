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
public class NativeReconciliationTest {
    private Context context; private String dbName,alias; private NativeJournal journal; private DeviceIdentity identity;
    private NativeCheckoutEngine engine; private OfflineBundle.Binding binding; private KeyPair server; private PublicKey device;
    private JSONObject snapshot,authority; private String snapshotEnvelope,authorityEnvelope,boot=UUID.randomUUID().toString();
    private final long start=1_792_132_200_000L; private long wall=start,elapsed=1000; private boolean locked=false,failSigning=false,failCommit=false;
    private AtomicInteger signatures=new AtomicInteger();
    @Before public void setUp() throws Exception {
        context=InstrumentationRegistry.getInstrumentation().getTargetContext(); dbName="reconciliation-audit-"+UUID.randomUUID()+".db";alias="internext.pos.test.reconciliation."+UUID.randomUUID();
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
    private NativeReconciliation reconciler(NativeReconciliation.Transport transport)throws Exception{return new NativeReconciliation(journal,identity,Collections.singletonMap("synthetic-server",server.getPublic()),transport);}
    private JSONObject accepted(JSONObject envelope)throws Exception{
        SignedProtocol.Verified proof=SignedProtocol.verify(envelope.toString(),Collections.singletonMap(SignedProtocol.fingerprint(device),device));JSONObject issued=(JSONObject)proof.payload();
        JSONObject ack=new JSONObject().put("kind","offline-ack").put("schemaVersion",1).put("id",id()).put("issuanceId",issued.getString("id")).put("payloadSha256",proof.payloadSha256).put("authorityId",issued.getString("authorityId")).put("keyEpoch",binding.keyEpoch).put("deviceSequence",issued.getLong("deviceSequence")).put("receivedAt",NativeCheckoutEngine.iso(start));
        return new JSONObject().put("status","accepted").put("acknowledgement",new JSONObject(SignedProtocol.sign(ack,"synthetic-server",server.getPrivate(),server.getPublic()))).put("receipt",issued.get("document")).put("replayed",false);
    }
    private JSONObject sealed(JSONObject envelope)throws Exception{
        JSONObject p=payload(envelope.toString());return new JSONObject().put("status","sealed").put("authorityId",p.getString("authorityId")).put("finalSequence",p.getLong("finalSequence")).put("finalEventSha256",p.get("finalEventSha256"));
    }
    private String textValue(String sql){try(Cursor c=journal.getReadableDatabase().rawQuery(sql,null)){assertTrue(c.moveToFirst());return c.getString(0);}}
    @Test public void validHistoricalUploadsWorkLockedExpiredAndNeverImplicitlySeal()throws Exception{
        sell();sell();locked=true;wall+=9_000_000;elapsed+=9_000_000;int signed=signatures.get();AtomicInteger calls=new AtomicInteger();
        NativeReconciliation r=reconciler((path,envelope)->{assertEquals("/api/pos/offline/import",path);assertEquals(calls.incrementAndGet(),payload(envelope.toString()).getLong("deviceSequence"));return accepted(envelope);});
        JSONObject result=r.reconcile();assertEquals(2,calls.get());assertEquals(0,result.getInt("pendingReceipts"));assertEquals(1,result.getInt("unsealedAuthorities"));assertEquals(0,result.getInt("pendingSeals"));assertEquals("pending",result.getString("status"));assertTrue(result.isNull("noticeCode"));assertEquals(2,count("receipts"));assertEquals(2,count("acknowledgements"));assertEquals(signed,signatures.get());
    }
    @Test public void lostAcceptedResponseRetriesOriginalEnvelopeAndPreservesOneAck()throws Exception{
        String original=sell();AtomicInteger calls=new AtomicInteger();AtomicReference<JSONObject> response=new AtomicReference<>();
        NativeReconciliation r=reconciler((path,envelope)->{assertArrayEquals(CanonicalJson.bytes(new JSONObject(original)),CanonicalJson.bytes(envelope));if(calls.incrementAndGet()==1){response.set(accepted(envelope));throw new java.io.IOException("synthetic response lost");}return new JSONObject(response.get().toString()).put("replayed",true);});
        assertEquals("offline_upload_uncertain",r.reconcile().getString("noticeCode"));assertEquals(1,count("outbox"));assertEquals(0,count("acknowledgements"));assertEquals(0,r.reconcile().getInt("pendingReceipts"));assertEquals(1,count("receipts"));assertEquals(1,count("acknowledgements"));String first=textValue("SELECT ack_json FROM acknowledgements");r.reconcile();assertEquals(2,calls.get());assertEquals(first,textValue("SELECT ack_json FROM acknowledgements"));
    }
    @Test public void signedAckForAnotherPendingReceiptCannotRemoveEitherOutbox()throws Exception{
        sell();String second=sell();JSONObject otherAck=accepted(new JSONObject(second)).getJSONObject("acknowledgement");AtomicInteger calls=new AtomicInteger();
        JSONObject state=reconciler((path,envelope)->{calls.incrementAndGet();return accepted(envelope).put("acknowledgement",otherAck);}).reconcile();
        assertEquals("offline_upload_uncertain",state.getString("noticeCode"));assertEquals(1,calls.get());assertEquals(2,count("outbox"));assertEquals(0,count("acknowledgements"));
    }
    @Test public void WrongReceiptUntrustedAckAndExtraResponseFieldsNeverDropCustody()throws Exception{
        sell();NativeReconciliation r=reconciler((path,envelope)->accepted(envelope).put("receipt",new JSONObject().put("wrong",true)));assertEquals("attention",r.reconcile().getString("status"));assertEquals(1,count("outbox"));
        KeyPairGenerator gen=KeyPairGenerator.getInstance("EC");gen.initialize(new ECGenParameterSpec("secp256r1"));KeyPair alien=gen.generateKeyPair();
        r=reconciler((path,envelope)->{JSONObject response=accepted(envelope);JSONObject ack=(JSONObject)SignedProtocol.verify(response.getJSONObject("acknowledgement").toString(),Collections.singletonMap("synthetic-server",server.getPublic())).payload();return response.put("acknowledgement",new JSONObject(SignedProtocol.sign(ack,"synthetic-server",alien.getPrivate(),alien.getPublic())));});r.reconcile();assertEquals(1,count("outbox"));
        reconciler((path,envelope)->accepted(envelope).put("unexpected",true)).reconcile();assertEquals(1,count("outbox"));assertEquals(0,count("acknowledgements"));
    }
    @Test public void ExceptionEvidenceSurvivesRestartAndOnlySignedAckResolvesAttention()throws Exception{
        sell();String exception=id();AtomicInteger calls=new AtomicInteger();NativeReconciliation.Transport rejected=(path,envelope)->{calls.incrementAndGet();return new JSONObject().put("status","reconciliation_required").put("exceptionId",exception).put("code","chain");};
        NativeReconciliation r=reconciler(rejected);assertEquals("offline_reconciliation_required",r.reconcile().getString("noticeCode"));assertEquals(1,count("offline_upload_exceptions"));assertEquals(1,count("outbox"));assertEquals(1,calls.get());r.getState();assertEquals(1,calls.get());
        reopen();r=reconciler(rejected);assertEquals("attention",r.getState().getString("status"));assertEquals(1,calls.get());r.reconcile();assertEquals(1,count("offline_upload_exceptions"));assertEquals(2,calls.get());assertEquals(1,count("outbox"));
        r=reconciler((path,envelope)->accepted(envelope));JSONObject after=r.reconcile();assertTrue(after.isNull("noticeCode"));assertEquals(0,count("outbox"));assertEquals(1,count("offline_upload_exceptions"));assertEquals(1,count("acknowledgements"));assertThrows(SQLiteException.class,()->journal.getWritableDatabase().execSQL("DELETE FROM offline_upload_exceptions"));
    }
    @Test public void FirstFailedReceiptStopsLaterChainAndAllSeals()throws Exception{
        sell();sell();engine.sealAuthority(authority.getString("id"));AtomicInteger calls=new AtomicInteger();JSONObject state=reconciler((path,envelope)->{assertEquals("/api/pos/offline/import",path);assertEquals(1,payload(envelope.toString()).getLong("deviceSequence"));calls.incrementAndGet();throw new java.io.IOException("synthetic outage");}).reconcile();
        assertEquals(1,calls.get());assertEquals(2,state.getInt("pendingReceipts"));assertEquals(1,state.getInt("pendingSeals"));assertEquals(0,count("offline_seal_confirmations"));
    }
    @Test public void StoredSealUploadsOnlyAfterReceiptsAndConfirmationPersists()throws Exception{
        sell();sell();String originalSeal=engine.sealAuthority(authority.getString("id"));AtomicInteger calls=new AtomicInteger();int signed=signatures.get();locked=true;
        NativeReconciliation r=reconciler((path,envelope)->{int n=calls.incrementAndGet();if(n<3){assertEquals("/api/pos/offline/import",path);return accepted(envelope);}assertEquals("/api/pos/offline/seal",path);assertEquals(0,count("outbox"));assertArrayEquals(CanonicalJson.bytes(new JSONObject(originalSeal)),CanonicalJson.bytes(envelope));return sealed(envelope);});
        JSONObject result=r.reconcile();assertEquals("idle",result.getString("status"));assertEquals(1,result.getInt("confirmedSeals"));assertEquals(0,result.getInt("pendingSeals"));assertEquals(3,calls.get());assertEquals(signed,signatures.get());String confirmation=textValue("SELECT response_json FROM offline_seal_confirmations");reopen();reconciler((path,envelope)->{throw new AssertionError("confirmed evidence must not upload again");}).reconcile();assertEquals(confirmation,textValue("SELECT response_json FROM offline_seal_confirmations"));assertThrows(SQLiteException.class,()->journal.getWritableDatabase().execSQL("UPDATE offline_seal_confirmations SET response_json='{}'"));assertThrows(SQLiteException.class,()->journal.getWritableDatabase().execSQL("DELETE FROM offline_seal_confirmations"));
    }
    @Test public void MalformedOrLostSealConfirmationLeavesOriginalSealForExactRetry()throws Exception{
        String original=engine.sealAuthority(authority.getString("id"));AtomicInteger calls=new AtomicInteger();NativeReconciliation r=reconciler((path,envelope)->{assertArrayEquals(CanonicalJson.bytes(new JSONObject(original)),CanonicalJson.bytes(envelope));int n=calls.incrementAndGet();if(n==1)return sealed(envelope).put("authorityId",id());if(n==2)return sealed(envelope).put("finalSequence",0.0);if(n==3)throw new java.io.IOException("lost seal result");return sealed(envelope);});
        for(int i=0;i<3;i++){assertEquals("offline_seal_uncertain",r.reconcile().getString("noticeCode"));assertEquals(0,count("offline_seal_confirmations"));assertEquals(original,textValue("SELECT seal_envelope FROM offline_authority_state"));}assertEquals("idle",r.reconcile().getString("status"));assertEquals(1,count("offline_seal_confirmations"));
    }
    @Test public void UnsupportedLegacyOutboxIsVisibleAndBlocksSealUpload()throws Exception{
        String intent=id(),receipt=id(),request="{}";journal.beginIntent(intent,request,NativeCheckoutEngine.iso(start));String envelope=SignedProtocol.sign(new JSONObject().put("synthetic",true),"synthetic-server",server.getPrivate(),server.getPublic());journal.commitVerifiedIssuance(intent,request,receipt,"LEGACY-1",NativeCheckoutEngine.iso(start),1000,envelope);engine.sealAuthority(authority.getString("id"));
        JSONObject state=reconciler((path,e)->{throw new AssertionError("legacy evidence must not be interpreted or skipped for seal");}).reconcile();assertEquals("attention",state.getString("status"));assertEquals(1,state.getInt("pendingReceipts"));assertEquals(1,state.getInt("pendingSeals"));assertEquals(0,count("offline_seal_confirmations"));
    }
    @Test public void MigrationFromExactVersionTwoSchemaPreservesReceiptsClockChainAndSeal()throws Exception{
        String receipt=sell(),seal=engine.sealAuthority(authority.getString("id")),installation=journal.installationId();String clock=textValue("SELECT clock_json FROM offline_authority_state"),hash=textValue("SELECT event_hash FROM offline_chain");
        // Version 3 adds only these two tables and their triggers. Removing them from this
        // isolated fixture reconstructs v2 schema; no production database is downgraded.
        SQLiteDatabase db=journal.getWritableDatabase();db.execSQL("DROP TABLE offline_seal_confirmations");db.execSQL("DROP TABLE offline_upload_exceptions");db.setVersion(2);journal.close();journal=new NativeJournal(context,dbName,()->{});engine=createEngine(journal);
        assertEquals(3,journal.getReadableDatabase().getVersion());assertEquals(installation,journal.installationId());assertEquals(receipt,textValue("SELECT envelope_json FROM receipts"));assertEquals(seal,textValue("SELECT seal_envelope FROM offline_authority_state"));assertEquals(clock,textValue("SELECT clock_json FROM offline_authority_state"));assertEquals(hash,textValue("SELECT event_hash FROM offline_chain"));assertEquals(1,count("outbox"));assertEquals(0,count("offline_seal_confirmations"));assertEquals(0,count("offline_upload_exceptions"));
        JSONObject result=reconciler((path,envelope)->path.endsWith("/import")?accepted(envelope):sealed(envelope)).reconcile();assertEquals("idle",result.getString("status"));assertEquals(1,count("receipts"));assertEquals(1,count("acknowledgements"));assertEquals(1,count("offline_seal_confirmations"));
    }
}
