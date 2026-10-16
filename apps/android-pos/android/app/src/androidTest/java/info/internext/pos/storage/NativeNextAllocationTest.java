package info.internext.pos.storage;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.content.ContentValues;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.SignedProtocol;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import javax.net.ssl.HttpsURLConnection;
import java.io.*;
import java.net.CookieHandler;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.Certificate;
import java.security.spec.ECGenParameterSpec;
import java.util.*;
import static org.junit.Assert.*;

/** Real native custody/crypto/PIN, isolated synthetic resources; HTTP is a deterministic fake. */
@RunWith(AndroidJUnit4.class)
public class NativeNextAllocationTest {
    private Context context;private String prefix,vaultFile;private final List<String> aliases=new ArrayList<>(),databases=new ArrayList<>();
    private NativeJournal journal;private DeviceIdentity identity;private NativeClockSource clock;private NativeStaffUnlock unlock;
    private SecureSessionStore store;private NativeSession session;private NativeOfflineCoordinator coordinator;private CookieHandler priorCookies;
    private KeyPair server;private JSONObject snapshot,authority,deviceIdentity;private String actor,org,branch,device,epoch,shift;
    private long now=1_792_132_200_000L,elapsed=1000;private int boot=5;private boolean wrongContextChallenge,wrongContextScope,wrongPreparedChallenge,wrongPreparedScope;
    private int enrollmentErrorMode;private JSONObject acceptedEnrollment;private final List<Boolean> expiredFlagsAtSend=new ArrayList<>();
    private boolean rotateCookies;private String loseNextPath;private JSONObject preparedResponse;private final List<Sent> sent=new ArrayList<>();
    private static final String PIN="18473926";
    private static final class Sent {final String path;final JSONObject body;Sent(String p,JSONObject b){path=p;body=b;}}
    @Before public void setup()throws Exception{
        context=InstrumentationRegistry.getInstrumentation().getTargetContext();prefix="next-allocation-test-"+UUID.randomUUID();vaultFile=prefix+".bin";
        priorCookies=CookieHandler.getDefault();CookieHandler.setDefault(null);
        for(String suffix:new String[]{"ledger","clock","pin"})databases.add(prefix+"-"+suffix+".db");
        for(String suffix:new String[]{"session","identity","clock","pin"})aliases.add("internext.pos.test."+prefix+"."+suffix);
        journal=new NativeJournal(context,databases.get(0),()->{});identity=new DeviceIdentity(aliases.get(1));deviceIdentity=identity.readOrCreate(journal);
        KeyPairGenerator generator=KeyPairGenerator.getInstance("EC");generator.initialize(new ECGenParameterSpec("secp256r1"));server=generator.generateKeyPair();
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream in=InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("pos-offline-output.json")){byte[] buffer=new byte[4096];int n;while((n=in.read(buffer))!=-1)bytes.write(buffer,0,n);}
        JSONObject fixture=new JSONObject(bytes.toString("UTF-8")).getJSONObject("reservation");snapshot=fixture.getJSONObject("snapshot");authority=fixture.getJSONObject("authority");
        actor=authority.getString("actorId");org=authority.getString("organizationId");branch=authority.getString("branchId");device=authority.getString("deviceId");epoch=authority.getString("keyEpoch");shift=authority.getString("shiftId");
        store=new SecureSessionStore(context,vaultFile,aliases.get(0));seedSignedIn();reopen();
    }
    private void seedSignedIn()throws Exception{
        JSONObject state=store.read();state.put("actorId",actor).put("counter",new JSONObject().put("actorId",actor).put("id",device).put("branchId",branch).put("name","Synthetic counter"));
        state.getJSONObject("cookies").put("pos-access","synthetic-access").put("pos-refresh","synthetic-refresh").put("pos-device-"+actor,String.join("",Collections.nCopies(64,"a")));store.write(state);
    }
    private void reopen()throws Exception{
        if(coordinator!=null)coordinator.close();store=new SecureSessionStore(context,vaultFile,aliases.get(0));
        session=new NativeSession(store,new NativePosHttp(store,Fake::new),journal);
        clock=new NativeClockSource(context,journal,databases.get(1),aliases.get(2),()->new NativeClockSource.Observation(boot,elapsed,now));
        unlock=new NativeStaffUnlock(context,journal,clock,databases.get(2),aliases.get(3),NativeStaffUnlock.mainScheduler(),()->elapsed);
        coordinator=new NativeOfflineCoordinator(journal,session,identity,clock,unlock,Collections.singletonMap("synthetic-server",server.getPublic()));
    }
    @After public void cleanup()throws Exception{
        try{if(coordinator!=null)coordinator.close();else{if(unlock!=null)unlock.close();if(clock!=null)clock.close();}if(journal!=null)journal.close();}
        finally{
            CookieHandler.setDefault(priorCookies);
            for(String db:databases){context.deleteDatabase(db);assertFalse(context.getDatabasePath(db).exists());}
            for(String suffix:new String[]{"",".bak",".new"}){File file=new File(context.getNoBackupFilesDir(),vaultFile+suffix);if(file.exists())assertTrue(file.delete());assertFalse(file.exists());}
            KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);for(String alias:aliases){if(keys.containsAlias(alias))keys.deleteEntry(alias);assertFalse(keys.containsAlias(alias));}
        }
    }
    private JSONObject access()throws Exception{return new JSONObject().put("schemaVersion",1).put("status","signed_in").put("actorId",actor).put("branches",new JSONArray().put(new JSONObject().put("id",branch).put("organizationId",org).put("name","Synthetic branch").put("role","manager"))).put("device",new JSONObject().put("id",device).put("branchId",branch).put("name","Synthetic counter")).put("canPrepareOffline",false);}
    private JSONObject handoff(String kind,String challenge)throws Exception{return new JSONObject().put("kind",kind).put("schemaVersion",1).put("challenge",challenge).put("serverTimeMs",now).put("actorId",actor).put("organizationId",org).put("branchId",branch).put("deviceId",device).put("shiftId",shift==null?JSONObject.NULL:shift);}
    private JSONObject signed(JSONObject payload)throws Exception{return new JSONObject(SignedProtocol.sign(payload,"synthetic-server",server.getPrivate(),server.getPublic()));}
    private JSONObject respondOriginal(String path,JSONObject request)throws Exception{
        if(path.equals("/api/pos/native/access"))return access();
        if(path.equals("/api/pos/native/preparation")){
            assertEquals(branch,request.getString("branchId"));assertEquals(device,request.getString("deviceId"));
            JSONObject payload=handoff("native-offline-context",wrongContextChallenge?String.join("",Collections.nCopies(64,"f")):request.getString("challenge"));
            if(wrongContextScope)payload.put("actorId",UUID.randomUUID().toString());return new JSONObject().put("handoff",signed(payload));
        }
        if(path.equals("/api/pos/commands")){
            JSONObject command=request.getJSONObject("command");assertEquals("shift.open",command.getString("type"));boolean replay=shift!=null;shift=command.getString("shiftId");
            return new JSONObject().put("status","applied").put("commandId",command.getString("id")).put("shiftId",shift).put("replayed",replay);
        }
        if(path.equals("/api/pos/offline/enroll")){
            if(acceptedEnrollment!=null)assertEquals(canonical(acceptedEnrollment),canonical(request));else acceptedEnrollment=new JSONObject(request.toString());
            JSONObject proof=(JSONObject)SignedProtocol.verify(request.getJSONObject("proof").toString(),Collections.singletonMap(deviceIdentity.getString("deviceKeySha256"),SignedProtocol.publicKey(SignedProtocol.decode(deviceIdentity.getString("publicKeySpkiBase64Url"),256)))).payload();
            assertEquals(actor,proof.getString("actorId"));assertEquals(request.getString("requestId"),proof.getString("requestId"));
            return new JSONObject().put("keyEpoch",epoch).put("deviceId",device).put("deviceKeySha256",deviceIdentity.getString("deviceKeySha256")).put("publicKeySpki",deviceIdentity.getString("publicKeySpkiBase64Url"));
        }
        if(path.equals("/api/pos/native/prepare")){
            JSONObject reservation=request.getJSONObject("reservation");
            if(preparedResponse!=null&&!authority.getString("id").equals(reservation.getString("requestId"))){authority.getJSONObject("invoiceRange").put("first",authority.getJSONObject("invoiceRange").getLong("last")+1);preparedResponse=null;}
            if(preparedResponse==null){
                snapshot.put("createdAt",NativeCheckoutEngine.iso(now));
                authority.put("id",reservation.getString("requestId")).put("shiftId",shift).put("deviceKeySha256",deviceIdentity.getString("deviceKeySha256")).put("issuedAt",NativeCheckoutEngine.iso(now)).put("notBefore",NativeCheckoutEngine.iso(now)).put("expiresAt",NativeCheckoutEngine.iso(now+reservation.getLong("lifetimeSeconds")*1000)).put("snapshotSha256",SignedProtocol.hash(CanonicalJson.bytes(snapshot))).put("maxInvoiceTotalFils",reservation.getLong("maxInvoiceTotalFils")).put("maxGrossFils",reservation.getLong("maxGrossFils")).put("permissions",reservation.getJSONObject("permissions"));
                authority.getJSONObject("invoiceRange").put("last",authority.getJSONObject("invoiceRange").getLong("first")+reservation.getLong("count")-1);
                preparedResponse=new JSONObject().put("snapshotEnvelope",signed(snapshot)).put("authorityEnvelope",signed(authority));
            }
            JSONObject payload=handoff("native-offline-prepared",wrongPreparedChallenge?String.join("",Collections.nCopies(64,"f")):request.getString("challenge")).put("keyEpoch",epoch).put("deviceKeySha256",deviceIdentity.getString("deviceKeySha256")).put("authorityId",authority.getString("id")).put("snapshotSha256",SignedProtocol.hash(CanonicalJson.bytes(snapshot))).put("authoritySha256",SignedProtocol.hash(CanonicalJson.bytes(authority)));
            if(wrongPreparedScope)payload.put("organizationId",UUID.randomUUID().toString());
            return new JSONObject(preparedResponse.toString()).put("handoff",signed(payload));
        }
        throw new AssertionError("Unexpected synthetic path: "+path);
    }
    private List<JSONObject> bodies(String path){List<JSONObject> list=new ArrayList<>();for(Sent item:sent)if(item.path.equals(path))list.add(item.body);return list;}
    private String canonical(JSONObject value)throws Exception{return new String(CanonicalJson.bytes(value),StandardCharsets.UTF_8);}
    private long count(String table){try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT count(*) FROM "+table,null)){assertTrue(c.moveToFirst());return c.getLong(0);}}
    private String savedClock(){try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT clock_json FROM offline_authority_state",null)){assertTrue(c.moveToFirst());return c.getString(0);}}
    private void code(String expected,org.junit.function.ThrowingRunnable op){assertEquals(expected,assertThrows(NativeAccessError.class,op).code);}
    private void prepare()throws Exception{coordinator.beginPreparation();assertEquals("prepared",coordinator.prepareWithPin(PIN.toCharArray(),PIN.toCharArray()).getString("status"));}



    private boolean wrongContinuationScope,wrongContinuationHash,wrongContinuationNonce;
    private Runnable duringContinuation;
    private JSONObject respond(String path,JSONObject request)throws Exception{
        if(path.equals("/api/pos/native/continuation")){
            String prior=request.getString("authorityId");JSONObject a=storedPayload("SELECT authority_envelope FROM offline_bundles WHERE id='"+prior+"'");
            JSONObject p=handoff("native-offline-continuation",wrongContinuationNonce?String.join("",Collections.nCopies(64,"f")):request.getString("challenge"))
                .put("purpose","prepare-next").put("shiftId",a.getString("shiftId")).put("keyEpoch",epoch).put("deviceKeySha256",deviceIdentity.getString("deviceKeySha256"))
                .put("priorAuthorityId",prior).put("sealSha256",wrongContinuationHash?String.join("",Collections.nCopies(64,"f")):request.getString("sealSha256"))
                .put("nextShiftId",shift==null?JSONObject.NULL:shift);
            if(wrongContinuationScope)p.put("actorId",UUID.randomUUID().toString());if(duringContinuation!=null){Runnable r=duringContinuation;duringContinuation=null;r.run();}
            return new JSONObject().put("handoff",signed(p));
        }
        if(path.equals("/api/pos/offline/seal")){
            JSONObject p=devicePayload(request);return new JSONObject().put("status","sealed").put("authorityId",p.getString("authorityId")).put("finalSequence",p.getLong("finalSequence")).put("finalEventSha256",p.get("finalEventSha256"));
        }
        if(path.equals("/api/pos/offline/import")){
            JSONObject p=devicePayload(request);JSONObject ack=new JSONObject().put("kind","offline-ack").put("schemaVersion",1).put("id",UUID.randomUUID().toString()).put("issuanceId",p.getString("id"))
                .put("payloadSha256",NativeJournal.payloadHash(request.toString())).put("authorityId",p.getString("authorityId")).put("keyEpoch",epoch).put("deviceSequence",p.getLong("deviceSequence")).put("receivedAt",NativeCheckoutEngine.iso(now));
            return new JSONObject().put("status","accepted").put("acknowledgement",signed(ack)).put("receipt",p.getJSONObject("document")).put("replayed",false);
        }
        return respondOriginal(path,request);
    }
    private PublicKey publicKey()throws Exception{return SignedProtocol.publicKey(SignedProtocol.decode(deviceIdentity.getString("publicKeySpkiBase64Url"),256));}
    private JSONObject devicePayload(JSONObject envelope)throws Exception{return (JSONObject)SignedProtocol.verify(envelope.toString(),Collections.singletonMap(deviceIdentity.getString("deviceKeySha256"),publicKey())).payload();}
    private String text(String sql){try(Cursor c=journal.getReadableDatabase().rawQuery(sql,null)){assertTrue(c.moveToFirst());return c.isNull(0)?null:c.getString(0);}}
    private JSONObject storedPayload(String sql)throws Exception{return (JSONObject)SignedProtocol.verify(text(sql),Collections.singletonMap("synthetic-server",server.getPublic())).payload();}
    private NativeCheckoutEngine engine()throws Exception{return coordinator.checkoutContext(false).engine;}
    private JSONObject input()throws Exception{return new JSONObject().put("authorityId",store.read().getJSONObject("offline").getJSONObject("reservation").getString("requestId")).put("serviceType","takeaway").put("customer",JSONObject.NULL)
        .put("lines",new JSONArray().put(new JSONObject().put("productId",snapshot.getJSONArray("products").getJSONObject(0).getString("id")).put("quantityMilli",1000))).put("cashTenderedFils",1000).put("recordedCardFils",0).put("presentedTotalFils",1000);}
    private String sell()throws Exception{String id=UUID.randomUUID().toString();engine().beginPaymentIntent(id,input());return engine().commitPaymentIntent(id);}
    private String prior()throws Exception{return store.read().getJSONObject("offline").getJSONObject("reservation").getString("requestId");}
    private void upload()throws Exception{new NativeReconciliation(journal,identity,Collections.singletonMap("synthetic-server",server.getPublic()),this::respond).reconcile();}
    private void finish()throws Exception{coordinator.finishAuthorityWithPin(prior(),PIN.toCharArray());}
    private String finishUploaded()throws Exception{String id=prior();finish();upload();assertEquals(0,count("outbox"));assertEquals(1,count("offline_seal_confirmations"));return id;}
    private void fails(org.junit.function.ThrowingRunnable r){assertThrows(Exception.class,r);}
    private String record(String table,String where)throws Exception{JSONArray rows=new JSONArray();try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT * FROM "+table+" WHERE "+where+" ORDER BY rowid",null)){while(c.moveToNext()){JSONObject row=new JSONObject();for(int i=0;i<c.getColumnCount();i++)row.put(c.getColumnName(i),c.isNull(i)?JSONObject.NULL:c.getString(i));rows.put(row);}}return new String(CanonicalJson.bytes(rows),StandardCharsets.UTF_8);}
    @Test public void enrolledOpenShiftBeforeFirstReservationHasNoPreviousAllocationMetadata()throws Exception{
        coordinator.beginPreparation();JSONObject offline=store.read().getJSONObject("offline");
        assertEquals(epoch,offline.getString("keyEpoch"));assertEquals(shift,offline.getString("shiftId"));assertTrue(offline.isNull("reservation"));
        assertEquals(0,count("offline_bundles"));String before=canonical(offline);int requests=sent.size();
        JSONObject state=coordinator.getNextAllocationState();
        assertEquals(7,state.length());assertEquals(1,state.getInt("schemaVersion"));assertEquals("not_available",state.getString("status"));
        assertTrue(state.isNull("previousAuthorityId"));assertTrue(state.isNull("shiftId"));assertTrue(state.isNull("nextShiftId"));assertTrue(state.isNull("reasonCode"));assertFalse(state.getBoolean("canContinue"));
        assertEquals(before,canonical(store.read().getJSONObject("offline")));assertEquals(requests,sent.size());
        reopen();state=coordinator.getNextAllocationState();assertEquals("not_available",state.getString("status"));assertTrue(state.isNull("previousAuthorityId"));assertTrue(state.isNull("shiftId"));assertEquals(before,canonical(store.read().getJSONObject("offline")));
    }
    @Test public void sameOpenShiftNextAllocationPreservesReceiptAckSealClockAndChainAndNeverReusesNumbers()throws Exception{
        prepare();String first=sell(),old=finishUploaded(),oldAuthority=record("offline_authority_state","authority_id='"+old+"'"),oldBundle=record("offline_bundles","id='"+old+"'"),receipts=record("receipts","1=1"),acks=record("acknowledgements","1=1"),chain=record("offline_chain","1=1"),key=record("device_key","1=1");
        assertTrue(coordinator.getNextAllocationState().getBoolean("canContinue"));char[] pin=PIN.toCharArray();JSONObject completed=coordinator.continueAfterAllocationWithPin(old,pin);for(char c:pin)assertEquals('\0',c);assertEquals("completed",completed.getString("status"));
        assertEquals(old,completed.getString("previousAuthorityId"));assertEquals(1,count("offline_bundles"));assertEquals(0,bodies("/api/pos/native/prepare").size()-1);reopen();
        coordinator.beginPreparation();coordinator.prepareWithPin(PIN.toCharArray(),null);String next=prior();assertNotEquals(old,next);assertEquals(2,count("offline_bundles"));assertEquals(epoch,store.read().getJSONObject("offline").getString("keyEpoch"));assertEquals(1,bodies("/api/pos/offline/enroll").size());
        assertEquals(oldAuthority,record("offline_authority_state","authority_id='"+old+"'"));assertEquals(oldBundle,record("offline_bundles","id='"+old+"'"));assertEquals(receipts,record("receipts","1=1"));assertEquals(acks,record("acknowledgements","1=1"));assertEquals(chain,record("offline_chain","1=1"));assertEquals(key,record("device_key","1=1"));
        JSONObject issued=devicePayload(new JSONObject(sell()));assertEquals(2,issued.getLong("deviceSequence"));assertEquals(NativeJournal.payloadHash(first),issued.getString("previousEventSha256"));assertTrue(issued.getJSONObject("document").getString("documentNumber").endsWith("0000000101"));
    }
    @Test public void expiredAuthorityMustBeExplicitlySealedAndUploadedBeforeContinuation()throws Exception{
        prepare();String old=prior();now+=90000000;elapsed+=90000000;assertFalse(coordinator.getNextAllocationState().getBoolean("canContinue"));fails(()->coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()));assertEquals(0,bodies("/api/pos/native/continuation").size());
        finish();assertFalse(coordinator.getNextAllocationState().getBoolean("canContinue"));fails(()->coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()));upload();assertTrue(coordinator.getNextAllocationState().getBoolean("canContinue"));
        assertEquals("completed",coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()).getString("status"));
    }
    @Test public void pendingReceiptAndMissingSealConfirmationCannotAdvancePointer()throws Exception{
        prepare();sell();String old=prior();finish();String saved=canonical(store.read().getJSONObject("offline"));assertEquals(1,count("outbox"));assertFalse(coordinator.getNextAllocationState().getBoolean("canContinue"));fails(()->coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()));assertEquals(saved,canonical(store.read().getJSONObject("offline")));assertEquals(0,bodies("/api/pos/native/continuation").size());
        upload();assertEquals("completed",coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()).getString("status"));assertEquals(1,count("acknowledgements"));
    }
    @Test public void pendingAndFrozenIntentsCannotFinishOrContinueAndNoNetworkIsSent()throws Exception{
        prepare();String old=prior(),id=UUID.randomUUID().toString();engine().beginPaymentIntent(id,input());fails(this::finish);assertFalse(coordinator.getNextAllocationState().getBoolean("canContinue"));
        coordinator.unlockWithPin(PIN.toCharArray());engine().freezePaymentIntentForManager(id);fails(this::finish);fails(()->coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()));assertEquals(0,bodies("/api/pos/native/continuation").size());assertEquals(1,count("offline_intent_freezes"));assertEquals(old,prior());
    }
    @Test public void invalidPinWrongAuthorityAndSignedOutCannotContinue()throws Exception{
        prepare();String old=finishUploaded(),saved=canonical(store.read().getJSONObject("offline"));fails(()->coordinator.continueAfterAllocationWithPin(old,"00000000".toCharArray()));fails(()->coordinator.continueAfterAllocationWithPin(UUID.randomUUID().toString(),PIN.toCharArray()));assertEquals(saved,canonical(store.read().getJSONObject("offline")));
        JSONObject state=store.read();state.put("actorId",JSONObject.NULL);store.write(state);fails(()->coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()));assertEquals(0,bodies("/api/pos/native/continuation").size());
    }
    @Test public void signedWrongChallengeScopeAndSealHashNeverChangePointer()throws Exception{
        prepare();String old=finishUploaded(),saved=canonical(store.read().getJSONObject("offline"));wrongContinuationNonce=true;fails(()->coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()));wrongContinuationNonce=false;wrongContinuationScope=true;fails(()->coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()));wrongContinuationScope=false;wrongContinuationHash=true;fails(()->coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()));assertEquals(saved,canonical(store.read().getJSONObject("offline")));assertEquals(1,count("offline_bundles"));
    }
    @Test public void lostContinuationResponseDoesNotClearPriorAndRetriesFreshNonceAfterRestart()throws Exception{
        prepare();String old=finishUploaded(),saved=canonical(store.read().getJSONObject("offline"));loseNextPath="/api/pos/native/continuation";fails(()->coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()));assertEquals(saved,canonical(store.read().getJSONObject("offline")));JSONObject first=bodies("/api/pos/native/continuation").get(0);reopen();
        assertEquals("completed",coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()).getString("status"));JSONObject retry=bodies("/api/pos/native/continuation").get(1);assertEquals(first.getString("authorityId"),retry.getString("authorityId"));assertEquals(first.getString("sealSha256"),retry.getString("sealSha256"));assertNotEquals(first.getString("challenge"),retry.getString("challenge"));
    }
    @Test public void completedTransitionRetryAfterNewGrantNeverClearsNewReservation()throws Exception{
        prepare();String old=finishUploaded();coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray());coordinator.beginPreparation();coordinator.prepareWithPin(PIN.toCharArray(),null);String next=prior(),saved=canonical(store.read().getJSONObject("offline"));int sentBefore=bodies("/api/pos/native/continuation").size();
        reopen();assertEquals("completed",coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()).getString("status"));assertEquals(next,prior());assertEquals(saved,canonical(store.read().getJSONObject("offline")));assertEquals(sentBefore,bodies("/api/pos/native/continuation").size());assertEquals(2,count("offline_bundles"));
    }
    @Test public void exactClosedOriginalShiftCanOpenNewShiftWithoutReenrollmentOrPinReset()throws Exception{
        prepare();String old=finishUploaded(),previousShift=shift;shift=null;assertEquals("completed",coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()).getString("status"));reopen();assertEquals("open_shift",coordinator.getState().getString("stage"));coordinator.beginPreparation();coordinator.openShift(12300);assertNotEquals(previousShift,shift);coordinator.beginPreparation();coordinator.prepareWithPin(PIN.toCharArray(),null);
        assertEquals(2,count("offline_bundles"));assertEquals(1,bodies("/api/pos/offline/enroll").size());assertEquals(epoch,store.read().getJSONObject("offline").getString("keyEpoch"));assertTrue(coordinator.getState().getBoolean("pinProvisioned"));assertEquals(previousShift,storedPayload("SELECT authority_envelope FROM offline_bundles WHERE id='"+old+"'").getString("shiftId"));
    }
    @Test public void unrelatedOpenShiftInFreshHandoffCannotBeAdopted()throws Exception{
        prepare();String old=finishUploaded(),saved=canonical(store.read().getJSONObject("offline"));shift=UUID.randomUUID().toString();fails(()->coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()));assertEquals(saved,canonical(store.read().getJSONObject("offline")));assertEquals(old,prior());
    }

    @Test public void restartWithCommittedArchiveAndOldVaultFinishesExactTransitionWithoutAnotherNetworkCall()throws Exception{
        prepare();String old=finishUploaded();JSONObject previous=store.read();coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray());String archive=record("offline_preparation_transitions","1=1");JSONObject completed=store.read().getJSONObject("offline");int calls=bodies("/api/pos/native/continuation").size();
        // Recreate the precise durable state after archive commit but before vault CAS.
        store.write(previous);reopen();assertEquals("pending",coordinator.getNextAllocationState().getString("status"));assertEquals(canonical(previous.getJSONObject("offline")),canonical(store.read().getJSONObject("offline")));
        assertEquals("completed",coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()).getString("status"));assertEquals(canonical(completed),canonical(store.read().getJSONObject("offline")));assertEquals(archive,record("offline_preparation_transitions","1=1"));assertEquals(calls,bodies("/api/pos/native/continuation").size());assertEquals(1,count("offline_preparation_transitions"));
    }
    @Test public void archiveStorageFailureNeverChangesVaultAndRetryPreservesOriginalIdentity()throws Exception{
        prepare();String old=finishUploaded(),saved=canonical(store.read().getJSONObject("offline"));journal.getWritableDatabase().execSQL("CREATE TRIGGER synthetic_transition_full BEFORE INSERT ON offline_preparation_transitions BEGIN SELECT RAISE(ABORT,'synthetic_disk_full'); END");
        fails(()->coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()));assertEquals(saved,canonical(store.read().getJSONObject("offline")));assertEquals(0,count("offline_preparation_transitions"));journal.getWritableDatabase().execSQL("DROP TRIGGER synthetic_transition_full");reopen();assertEquals("completed",coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()).getString("status"));assertEquals(1,count("offline_preparation_transitions"));
    }
    @Test public void signOutDuringFreshServerExchangeCannotCommitTransition()throws Exception{
        prepare();String old=finishUploaded(),saved=canonical(store.read().getJSONObject("offline"));duringContinuation=()->{try{JSONObject state=store.read();state.put("actorId",JSONObject.NULL);store.write(state);}catch(Exception e){throw new RuntimeException(e);}};
        fails(()->coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()));assertEquals(saved,canonical(store.read().getJSONObject("offline")));assertEquals(0,count("offline_preparation_transitions"));assertEquals(1,count("offline_bundles"));
    }
    private JSONObject paymentResponse(JSONObject freeze,String freezeHash,String nonce,JSONObject resolution)throws Exception{
        JSONObject h=new JSONObject().put("kind","native-payment-resolution-status").put("schemaVersion",1).put("purpose","reconciliation-only").put("challenge",nonce).put("serverTimeMs",now)
            .put("authorityId",freeze.getString("authorityId")).put("keyEpoch",epoch).put("deviceId",device).put("freezeId",freeze.getString("freezeId")).put("freezeSha256",freezeHash)
            .put("state",resolution==null?"conflict":"resolved").put("resolutionSha256",resolution==null?JSONObject.NULL:SignedProtocol.hash(CanonicalJson.bytes(resolution))).put("issuanceSha256",JSONObject.NULL);
        return new JSONObject().put("handoff",signed(h)).put("resolutionEnvelope",resolution==null?JSONObject.NULL:signed(resolution)).put("receipt",JSONObject.NULL).put("acknowledgement",JSONObject.NULL);
    }
    private String nonce(){return UUID.randomUUID().toString().replace("-","")+UUID.randomUUID().toString().replace("-","");}
    @Test public void lateAuthenticatedPaymentConflictDuringNetworkPreventsVaultTransition()throws Exception{
        prepare();NativeCheckoutEngine e=engine();String intent=UUID.randomUUID().toString();e.beginPaymentIntent(intent,input());String proof=e.freezePaymentIntentForManager(intent);JSONObject f=devicePayload(new JSONObject(proof));String fh=NativeJournal.payloadHash(proof);
        JSONObject r=new JSONObject().put("kind","offline-payment-resolution").put("schemaVersion",1).put("purpose","reconciliation-only").put("resolutionId",UUID.randomUUID().toString()).put("requestId",UUID.randomUUID().toString()).put("freezeId",f.getString("freezeId")).put("freezeSha256",fh).put("managerActorId",UUID.randomUUID().toString()).put("decision","funds_returned").put("evidenceSha256",nonce()).put("resolvedAt",NativeCheckoutEngine.iso(now)).put("replacement",JSONObject.NULL);
        for(String k:new String[]{"paymentIntentId","requestSha256","orderId","documentId","organizationId","branchId","deviceId","actorId","shiftId","keyEpoch","authorityId","authoritySha256","snapshotSha256"})r.put(k,f.get(k));String n=nonce();e.acceptPaymentResolution(intent,paymentResponse(f,fh,n,r),n);
        String old=finishUploaded(),saved=canonical(store.read().getJSONObject("offline"));duringContinuation=()->{try{String challenge=nonce();e.acceptPaymentResolution(intent,paymentResponse(f,fh,challenge,null),challenge);}catch(Exception error){throw new RuntimeException(error);}};
        fails(()->coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()));assertEquals(saved,canonical(store.read().getJSONObject("offline")));assertEquals(0,count("offline_preparation_transitions"));assertEquals(1,count("offline_payment_conflicts"));assertFalse(coordinator.getNextAllocationState().getBoolean("canContinue"));assertEquals(0,count("receipts"));
    }
    @Test public void completedSameShiftCanRecheckClosedShiftWithoutLosingOriginalTransition()throws Exception{
        prepare();String old=finishUploaded(),originalShift=shift;coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray());String archive=record("offline_preparation_transitions","1=1");
        JSONObject beforeClose=store.read();shift=null;assertEquals("completed",coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()).getString("status"));assertEquals(1,count("offline_preparation_shift_closures"));assertEquals(archive,record("offline_preparation_transitions","1=1"));
        JSONObject closed=store.read().getJSONObject("offline");assertTrue(closed.isNull("shiftId"));assertTrue(closed.isNull("shiftRequest"));int calls=bodies("/api/pos/native/continuation").size();
        // Exact crash boundary: closure proof committed, encrypted pointer still old.
        store.write(beforeClose);reopen();assertEquals("pending",coordinator.getNextAllocationState().getString("status"));assertEquals(originalShift,store.read().getJSONObject("offline").getString("shiftId"));
        assertEquals("completed",coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()).getString("status"));assertEquals(canonical(closed),canonical(store.read().getJSONObject("offline")));assertEquals(calls,bodies("/api/pos/native/continuation").size());assertEquals("open_shift",coordinator.getState().getString("stage"));
    }
    private JSONObject resolution(JSONObject f)throws Exception{
        JSONObject r=new JSONObject().put("kind","offline-payment-resolution").put("schemaVersion",1).put("purpose","reconciliation-only").put("resolutionId",UUID.randomUUID().toString()).put("requestId",UUID.randomUUID().toString()).put("freezeId",f.getString("freezeId")).put("freezeSha256",text("SELECT proof_payload_sha256 FROM offline_intent_freezes WHERE intent_id='"+f.getString("paymentIntentId")+"'"))
            .put("managerActorId",UUID.randomUUID().toString()).put("decision","funds_returned").put("evidenceSha256",nonce()).put("resolvedAt",NativeCheckoutEngine.iso(now)).put("replacement",JSONObject.NULL);
        for(String k:new String[]{"paymentIntentId","requestSha256","orderId","documentId","organizationId","branchId","deviceId","actorId","shiftId","keyEpoch","authorityId","authoritySha256","snapshotSha256"})r.put(k,f.get(k));return r;
    }
    private String rows(SQLiteDatabase db,String table)throws Exception{
        JSONArray rows=new JSONArray();try(Cursor c=db.rawQuery("SELECT * FROM "+table+" ORDER BY rowid",null)){while(c.moveToNext()){JSONObject row=new JSONObject();for(int i=0;i<c.getColumnCount();i++)row.put(c.getColumnName(i),c.isNull(i)?JSONObject.NULL:c.getString(i));rows.put(row);}}return new String(CanonicalJson.bytes(rows),StandardCharsets.UTF_8);
    }
    @Test public void genuineVersionFiveUpgradePreservesSignedResolutionAndPendingReceiptCustody()throws Exception{
        prepare();sell();upload();sell();NativeCheckoutEngine e=engine();String intent=UUID.randomUUID().toString();e.beginPaymentIntent(intent,input());String proof=e.freezePaymentIntentForManager(intent);JSONObject f=devicePayload(new JSONObject(proof));String n=nonce();e.acceptPaymentResolution(intent,paymentResponse(f,NativeJournal.payloadHash(proof),n,resolution(f)),n);
        String historical=prefix+"-v5.db";databases.add(historical);String[] tables={"installation","device_key","intents","receipts","outbox","acknowledgements","offline_bundles","offline_authority_state","offline_chain","offline_intent_context","offline_intent_cancellations","offline_seal_confirmations","offline_upload_exceptions","offline_intent_freezes","offline_payment_results","offline_payment_statuses","offline_payment_conflicts"};Map<String,String> expected=new HashMap<>();
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream in=InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("native-ledger-historical-schema.json")){byte[] b=new byte[4096];int read;while((read=in.read(b))!=-1)bytes.write(b,0,read);}JSONObject ddl=new JSONObject(bytes.toString("UTF-8"));
        try(SQLiteDatabase old=SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(historical),null)){
            old.setForeignKeyConstraintsEnabled(true);old.execSQL("PRAGMA recursive_triggers=ON");for(int v=1;v<=3;v++){JSONArray commands=ddl.getJSONArray("version"+v);for(int i=0;i<commands.length();i++)old.execSQL(commands.getString(i));}
            // The unchanged version-4 and version-5 helpers create the genuine prior schema.
            NativeCheckoutEngine.createFreezeTables(old);NativeCheckoutEngine.createResolutionTables(old);
            for(String table:tables){JSONArray data=new JSONArray(rows(journal.getReadableDatabase(),table));for(int i=0;i<data.length();i++){JSONObject row=data.getJSONObject(i);ContentValues values=new ContentValues();Iterator<String> keys=row.keys();while(keys.hasNext()){String key=keys.next();if(row.isNull(key))values.putNull(key);else values.put(key,row.getString(key));}old.insertOrThrow(table,null,values);}expected.put(table,rows(old,table));}
            try(Cursor c=old.rawQuery("SELECT name FROM sqlite_master WHERE name LIKE 'offline_preparation_%'",null)){assertEquals(0,c.getCount());}old.setVersion(5);assertEquals(5,old.getVersion());
        }
        try(NativeJournal upgraded=new NativeJournal(context,historical,()->{})){
            assertEquals(7,upgraded.getReadableDatabase().getVersion());assertEquals(journal.installationId(),upgraded.installationId());assertEquals(deviceIdentity.getString("deviceKeySha256"),identity.readOrCreate(upgraded).getString("deviceKeySha256"));
            for(String table:tables)assertEquals(table,expected.get(table),rows(upgraded.getReadableDatabase(),table));assertEquals("[]",rows(upgraded.getReadableDatabase(),"offline_preparation_transitions"));assertEquals("[]",rows(upgraded.getReadableDatabase(),"offline_preparation_shift_closures"));
            NativeCheckoutEngine historicalEngine=NativeCheckoutEngine.forHistorical(upgraded,Collections.singletonMap("synthetic-server",server.getPublic()),publicKey(),identity::sign,intent);assertEquals("manager_resolved",historicalEngine.getIntent(intent).getString("state"));assertEquals(proof,historicalEngine.paymentResolutionRequest(intent,nonce()).getJSONObject("freezeEnvelope").toString());
            for(String table:tables)assertEquals(table,expected.get(table),rows(upgraded.getReadableDatabase(),table));
        }
        assertEquals(1,count("outbox"));assertEquals(1,count("acknowledgements"));assertEquals(1,count("offline_payment_results"));
    }
    @Test public void exportActualNextAllocationStatesForTypeScriptContract()throws Exception{
        JSONObject states=new JSONObject();states.put("unprepared",coordinator.getNextAllocationState());prepare();states.put("active",coordinator.getNextAllocationState());String old=prior();sell();finish();states.put("uploadPending",coordinator.getNextAllocationState());upload();states.put("ready",coordinator.getNextAllocationState());JSONObject previous=store.read();
        states.put("completed",coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()));store.write(previous);reopen();states.put("archivePending",coordinator.getNextAllocationState());coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray());shift=null;states.put("closedCompleted",coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray()));JSONObject preparation=coordinator.getState();
        JSONObject state=store.read();state.put("actorId",JSONObject.NULL);store.write(state);states.put("signedOut",coordinator.getNextAllocationState());JSONObject output=new JSONObject().put("nextAllocationStates",states).put("closedPreparation",preparation);
        File file=new File(context.getCacheDir(),"native-next-allocation-contract.json");try(FileOutputStream out=new FileOutputStream(file)){out.write(output.toString().getBytes(StandardCharsets.UTF_8));}assertTrue(file.length()>0);
    }
    private final class Fake extends HttpsURLConnection{
        private final ByteArrayOutputStream output=new ByteArrayOutputStream();private byte[] response;private boolean lose;
        Fake(URL url){super(url);}
        @Override public int getResponseCode()throws IOException{
            try{JSONObject body=output.size()==0?null:new JSONObject(output.toString("UTF-8"));sent.add(new Sent(url.getPath(),body));
                if(url.getPath().equals("/api/pos/offline/enroll")){
                    JSONObject persisted=store.read().getJSONObject("offline");assertEquals(canonical(body),canonical(persisted.getJSONObject("enrollmentRequest")));expiredFlagsAtSend.add(persisted.optBoolean("enrollmentProofExpired",false));
                    if(enrollmentErrorMode!=0){int mode=enrollmentErrorMode;enrollmentErrorMode=0;JSONObject error=new JSONObject().put("status","not_enrolled").put("code","offline_enrollment_proof_expired").put("requestId",body.getString("requestId")).put("requestSha256",SignedProtocol.hash(CanonicalJson.bytes(body)));
                        if(mode!=1)respond(url.getPath(),body);if(mode==2)error=new JSONObject().put("status","unavailable").put("code","pos_offline_proof_expired");response=error.toString().getBytes(StandardCharsets.UTF_8);return mode==3?503:409;}
                }
                response=respond(url.getPath(),body).toString().getBytes(StandardCharsets.UTF_8);lose=url.getPath().equals(loseNextPath);if(lose)loseNextPath=null;return 200;}
            catch(Exception error){throw new IOException("Synthetic handler failure",error);}
        }
        @Override public Map<String,List<String>> getHeaderFields(){return rotateCookies?Collections.singletonMap("Set-Cookie",Arrays.asList("pos-access=synthetic-rotated-access; Secure; HttpOnly; Path=/","pos-refresh=synthetic-rotated-refresh; Secure; HttpOnly; Path=/")):Collections.emptyMap();}
        @Override public String getContentType(){return "application/json";}
        @Override public String getHeaderField(String name){return null;}
        @Override public long getContentLengthLong(){return -1;}
        @Override public InputStream getInputStream()throws IOException{if(lose)throw new IOException("Synthetic lost response after server commit");return new ByteArrayInputStream(response);}
        @Override public InputStream getErrorStream(){return new ByteArrayInputStream(response);}
        @Override public OutputStream getOutputStream(){return output;}
        @Override public void disconnect(){}@Override public boolean usingProxy(){return false;}@Override public void connect(){}
        @Override public String getCipherSuite(){return "TLS_SYNTHETIC_ONLY";}@Override public Certificate[] getLocalCertificates(){return null;}@Override public Certificate[] getServerCertificates(){return new Certificate[0];}
    }
}
