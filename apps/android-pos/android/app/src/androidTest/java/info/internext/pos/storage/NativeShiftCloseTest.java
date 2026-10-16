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
public class NativeShiftCloseTest {
    private Context context;private String prefix,vaultFile;private final List<String> aliases=new ArrayList<>(),databases=new ArrayList<>();
    private NativeShiftClose closer;private NativeJournal journal;private DeviceIdentity identity;private NativeClockSource clock;private NativeStaffUnlock unlock;
    private SecureSessionStore store;private NativeSession session;private NativeOfflineCoordinator coordinator;private CookieHandler priorCookies;
    private KeyPair server;private JSONObject snapshot,authority,deviceIdentity;private String actor,org,branch,device,epoch,shift;
    private long now=1_792_132_200_000L,elapsed=1000;private int boot=5;private boolean wrongContextChallenge,wrongContextScope,wrongPreparedChallenge,wrongPreparedScope;
    private int enrollmentErrorMode;private JSONObject acceptedEnrollment;private final List<Boolean> expiredFlagsAtSend=new ArrayList<>();
    private boolean rotateCookies;private String loseNextPath;private JSONObject preparedResponse;private final List<Sent> sent=new ArrayList<>();
    private static final String PIN="18473926";
    private static final class Sent {final String path;final JSONObject body;Sent(String p,JSONObject b){path=p;body=b;}}
    @Before public void setup()throws Exception{
        context=InstrumentationRegistry.getInstrumentation().getTargetContext();prefix="shift-close-test-"+UUID.randomUUID();vaultFile=prefix+".bin";
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
        coordinator=new NativeOfflineCoordinator(journal,session,identity,clock,unlock,Collections.singletonMap("synthetic-server",server.getPublic()));closer=new NativeShiftClose(journal,session,coordinator);
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
        if(path.equals("/api/pos/native/shift-close"))return closeResponse(request);
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















    private JSONObject paymentResponse(JSONObject freeze,String freezeHash,String nonce,JSONObject resolution)throws Exception{
        JSONObject h=new JSONObject().put("kind","native-payment-resolution-status").put("schemaVersion",1).put("purpose","reconciliation-only").put("challenge",nonce).put("serverTimeMs",now)
            .put("authorityId",freeze.getString("authorityId")).put("keyEpoch",epoch).put("deviceId",device).put("freezeId",freeze.getString("freezeId")).put("freezeSha256",freezeHash)
            .put("state",resolution==null?"conflict":"resolved").put("resolutionSha256",resolution==null?JSONObject.NULL:SignedProtocol.hash(CanonicalJson.bytes(resolution))).put("issuanceSha256",JSONObject.NULL);
        return new JSONObject().put("handoff",signed(h)).put("resolutionEnvelope",resolution==null?JSONObject.NULL:signed(resolution)).put("receipt",JSONObject.NULL).put("acknowledgement",JSONObject.NULL);
    }
    private String nonce(){return UUID.randomUUID().toString().replace("-","")+UUID.randomUUID().toString().replace("-","");}


    private JSONObject resolution(JSONObject f)throws Exception{
        JSONObject r=new JSONObject().put("kind","offline-payment-resolution").put("schemaVersion",1).put("purpose","reconciliation-only").put("resolutionId",UUID.randomUUID().toString()).put("requestId",UUID.randomUUID().toString()).put("freezeId",f.getString("freezeId")).put("freezeSha256",text("SELECT proof_payload_sha256 FROM offline_intent_freezes WHERE intent_id='"+f.getString("paymentIntentId")+"'"))
            .put("managerActorId",UUID.randomUUID().toString()).put("decision","funds_returned").put("evidenceSha256",nonce()).put("resolvedAt",NativeCheckoutEngine.iso(now)).put("replacement",JSONObject.NULL);
        for(String k:new String[]{"paymentIntentId","requestSha256","orderId","documentId","organizationId","branchId","deviceId","actorId","shiftId","keyEpoch","authorityId","authoritySha256","snapshotSha256"})r.put(k,f.get(k));return r;
    }
    private String rows(SQLiteDatabase db,String table)throws Exception{
        JSONArray rows=new JSONArray();try(Cursor c=db.rawQuery("SELECT * FROM "+table+" ORDER BY rowid",null)){while(c.moveToNext()){JSONObject row=new JSONObject();for(int i=0;i<c.getColumnCount();i++)row.put(c.getColumnName(i),c.isNull(i)?JSONObject.NULL:c.getString(i));rows.put(row);}}return new String(CanonicalJson.bytes(rows),StandardCharsets.UTF_8);
    }


    private JSONObject serverCommand,serverResult;private boolean cancelled,failBeforeExecute;private String corruptClose;private Runnable duringClose,duringExecute;
    private boolean loseExecuteResponse;private int executes,lookups;private final List<JSONObject> closeRequests=new ArrayList<>();
    private JSONObject closeResponse(JSONObject request)throws Exception{
        closeRequests.add(new JSONObject(request.toString()));String mode=request.getString("mode"),target=mode.equals("context")?request.getString("shiftId"):request.getJSONObject("command").getString("shiftId");
        JSONObject p=new JSONObject().put("kind",mode.equals("context")?"native-shift-close-context":"native-shift-close-result").put("schemaVersion",1).put("purpose","close-shift").put("challenge",request.getString("challenge")).put("serverTimeMs",now).put("actorId",actor).put("organizationId",org).put("branchId",branch).put("deviceId",device).put("shiftId",target);
        if(mode.equals("context")){boolean closed=serverCommand!=null&&serverCommand.getString("shiftId").equals(target);p.put("status",closed?"closed":"open").put("canClose",!closed).put("reasonCode",closed?"shift_already_closed":JSONObject.NULL);}
        else{
            JSONObject command=request.getJSONObject("command");
            if(mode.equals("execute")){executes++;if(failBeforeExecute){failBeforeExecute=false;throw new IOException("Synthetic request not committed");}if(serverCommand==null){serverCommand=new JSONObject(command.toString());serverResult=new JSONObject().put("commandId",command.getString("id")).put("shiftId",target).put("countedCashFils",command.getLong("countedCashFils")).put("expectedCashFils",1000).put("cashDifferenceFils",command.getLong("countedCashFils")-1000).put("closedAt",NativeCheckoutEngine.iso(now));shift=null;}else assertEquals(canonical(serverCommand),canonical(command));}
            else{assertEquals("lookup",mode);lookups++;}
            if(mode.equals("execute")&&loseExecuteResponse){loseExecuteResponse=false;loseNextPath="/api/pos/native/shift-close";}
            p.put("commandId",command.getString("id")).put("requestSha256",SignedProtocol.hash(CanonicalJson.bytes(command))).put("countedCashFils",command.getLong("countedCashFils")).put("status",cancelled?"cancelled":serverCommand==null?"not_found":"applied").put("result",cancelled||serverCommand==null?JSONObject.NULL:new JSONObject(serverResult.toString()));
        }
        if(mode.equals("execute")&&duringExecute!=null){Runnable r=duringExecute;duringExecute=null;r.run();}
        if(duringClose!=null){Runnable operation=duringClose;duringClose=null;operation.run();}
        if(corruptClose!=null&&!mode.equals("context")){
            if(corruptClose.equals("nonce"))p.put("challenge",nonce());else if(corruptClose.equals("actor"))p.put("actorId",UUID.randomUUID().toString());else if(corruptClose.equals("hash"))p.put("requestSha256",nonce());else if(corruptClose.equals("count"))p.getJSONObject("result").put("countedCashFils",123);else if(corruptClose.equals("difference"))p.getJSONObject("result").put("cashDifferenceFils",1);else if(corruptClose.equals("future"))p.getJSONObject("result").put("closedAt",NativeCheckoutEngine.iso(now+1));
        }
        JSONObject envelope=signed(p);if("key".equals(corruptClose)&&!mode.equals("context"))envelope.put("keyId","unknown-key");return new JSONObject().put("handoff",envelope);
    }
    private String emptyShift()throws Exception{shift=null;coordinator.beginPreparation();coordinator.openShift(1000);assertTrue(store.read().getJSONObject("offline").isNull("keyEpoch"));assertEquals(0,count("offline_bundles"));return shift;}
    private String pendingClose()throws Exception{String target=emptyShift();failBeforeExecute=true;fails(()->closer.closeWithPin(target,900,null));assertEquals(1,count("native_shift_close_requests"));assertEquals(0,count("native_shift_close_outcomes"));return closer.getState().getString("commandId");}
    @Test public void emptyShiftBeforeEnrollmentClosesWithoutPinAndPreservesExactCashResult()throws Exception{
        String target=emptyShift();assertFalse(closer.isPinRequired());assertEquals("ready",closer.checkWithPin(null).getString("status"));JSONObject closed=closer.closeWithPin(target,900,null);
        assertEquals("closed",closed.getString("status"));assertEquals(-100,closed.getJSONObject("result").getLong("cashDifferenceFils"));assertEquals(1000,closed.getJSONObject("result").getLong("expectedCashFils"));assertEquals(0,count("receipts"));assertEquals(0,count("offline_bundles"));assertEquals(1,count("native_shift_close_setup_transitions"));assertTrue(store.read().getJSONObject("offline").isNull("shiftId"));assertEquals("open_shift",coordinator.getState().getString("stage"));assertEquals(1,executes);
        String records=record("native_shift_close_outcomes","1=1");reopen();assertEquals("closed",closer.getState().getString("status"));assertEquals(records,record("native_shift_close_outcomes","1=1"));assertEquals(1,executes);
    }
    @Test public void preparedAllocationMustFinishAndUploadBeforePinProtectedClose()throws Exception{
        prepare();String target=shift;assertTrue(closer.isPinRequired());fails(()->closer.closeWithPin(target,1000,PIN.toCharArray()));assertEquals(0,executes);assertEquals(0,count("native_shift_close_requests"));sell();finish();fails(()->closer.closeWithPin(target,1000,PIN.toCharArray()));upload();String custody=record("receipts","1=1")+record("acknowledgements","1=1")+record("offline_authority_state","1=1");
        fails(()->closer.closeWithPin(target,1000,null));char[] pin=PIN.toCharArray();assertEquals("closed",closer.closeWithPin(target,1000,pin).getString("status"));for(char c:pin)assertEquals('\0',c);assertEquals(custody,record("receipts","1=1")+record("acknowledgements","1=1")+record("offline_authority_state","1=1"));assertEquals(0,count("native_shift_close_setup_transitions"));assertFalse(store.read().getJSONObject("offline").isNull("reservation"));
    }
    @Test public void sameOpenShiftAfterContinuationClosesAndStillUsesVerifiedContinuationToAdvance()throws Exception{
        prepare();String target=shift,old=finishUploaded();coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray());assertEquals("closed",closer.closeWithPin(target,1000,PIN.toCharArray()).getString("status"));assertEquals(target,store.read().getJSONObject("offline").getString("shiftId"));assertEquals(0,count("native_shift_close_setup_transitions"));
        coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray());assertTrue(store.read().getJSONObject("offline").isNull("shiftId"));assertEquals(1,count("offline_preparation_shift_closures"));assertEquals(1,count("offline_bundles"));
    }
    @Test public void lostCommittedResponseRecoversByLookupOnlyAfterRestart()throws Exception{
        String target=emptyShift();loseExecuteResponse=true;fails(()->closer.closeWithPin(target,900,null));assertEquals(1,executes);assertEquals(0,count("native_shift_close_outcomes"));String request=record("native_shift_close_requests","1=1");reopen();assertEquals("pending",closer.getState().getString("status"));
        assertEquals("closed",closer.checkWithPin(null).getString("status"));assertEquals(1,executes);assertEquals(1,lookups);assertEquals(request,record("native_shift_close_requests","1=1"));assertEquals(1,count("native_shift_close_outcomes"));
    }
    @Test public void absentLookupNeverResendsUntilExplicitRetryAndPreservesOriginalCount()throws Exception{
        String id=pendingClose(),request=record("native_shift_close_requests","1=1");reopen();assertEquals("pending",closer.checkWithPin(null).getString("status"));assertTrue(closer.getState().getBoolean("canRetry"));assertEquals(1,executes);assertEquals(1,lookups);fails(()->closer.closeWithPin(shift,901,null));assertEquals(request,record("native_shift_close_requests","1=1"));assertEquals("closed",closer.retryWithPin(id,null).getString("status"));assertEquals(2,executes);assertEquals(2,lookups);assertEquals(request,record("native_shift_close_requests","1=1"));
        JSONObject first=null;for(JSONObject r:closeRequests)if(r.getString("mode").equals("execute")){if(first==null)first=r.getJSONObject("command");else assertEquals(canonical(first),canonical(r.getJSONObject("command")));}
    }
    @Test public void pendingCloseBlocksNewPreparationShiftAndAnyNewPayment()throws Exception{
        String id=pendingClose();fails(()->coordinator.beginPreparation());fails(()->coordinator.openShift(1000));assertEquals("pending",closer.getState().getString("status"));assertEquals(id,closer.getState().getString("commandId"));assertEquals(0,count("receipts"));assertEquals(0,count("offline_bundles"));assertEquals(1,count("native_shift_close_requests"));
    }
    @Test public void wrongKeyNonceScopeRequestHashAndFinancialResultNeverBecomeOutcome()throws Exception{
        String target=emptyShift();corruptClose="nonce";fails(()->closer.closeWithPin(target,900,null));String id=closer.getState().getString("commandId"),request=record("native_shift_close_requests","1=1");
        for(String bad:new String[]{"key","nonce","actor","hash","count","difference","future"}){corruptClose=bad;fails(()->closer.retryWithPin(id,null));assertEquals(0,count("native_shift_close_outcomes"));assertEquals(request,record("native_shift_close_requests","1=1"));}
        corruptClose=null;assertEquals("closed",closer.retryWithPin(id,null).getString("status"));assertEquals(1,executes);
    }
    @Test public void validCommittedResultSurvivesNewUncertainPaymentButDoesNotClearItsHold()throws Exception{
        String target=emptyShift();corruptClose="nonce";fails(()->closer.closeWithPin(target,900,null));corruptClose=null;String id=closer.getState().getString("commandId");journal.beginIntent(UUID.randomUUID().toString(),"{}",NativeCheckoutEngine.iso(now));
        assertEquals("closed",closer.retryWithPin(id,null).getString("status"));assertEquals(1,count("intents"));assertEquals(0,count("receipts"));assertEquals(0,count("native_shift_close_setup_transitions"));assertEquals(target,store.read().getJSONObject("offline").getString("shiftId"));assertEquals(1,executes);
    }
    @Test public void localStorageFailureBeforeRequestPreventsNetworkExecution()throws Exception{
        String target=emptyShift();journal.getWritableDatabase().execSQL("CREATE TRIGGER synthetic_close_full BEFORE INSERT ON native_shift_close_requests BEGIN SELECT RAISE(ABORT,'synthetic_disk_full'); END");fails(()->closer.closeWithPin(target,1000,null));assertEquals(0,executes);assertEquals(0,count("native_shift_close_requests"));assertEquals(target,store.read().getJSONObject("offline").getString("shiftId"));
        journal.getWritableDatabase().execSQL("DROP TRIGGER synthetic_close_full");assertEquals("closed",closer.closeWithPin(target,1000,null).getString("status"));
    }
    @Test public void outcomeStorageFailureLeavesExactPendingRequestRecoverable()throws Exception{
        String target=emptyShift();journal.getWritableDatabase().execSQL("CREATE TRIGGER synthetic_outcome_full BEFORE INSERT ON native_shift_close_outcomes BEGIN SELECT RAISE(ABORT,'synthetic_disk_full'); END");fails(()->closer.closeWithPin(target,900,null));assertEquals(1,executes);String request=record("native_shift_close_requests","1=1");assertEquals(0,count("native_shift_close_outcomes"));journal.getWritableDatabase().execSQL("DROP TRIGGER synthetic_outcome_full");reopen();assertEquals("closed",closer.checkWithPin(null).getString("status"));assertEquals(1,executes);assertEquals(request,record("native_shift_close_requests","1=1"));
    }
    @Test public void emptySetupArchiveAndVaultInterruptionRetryDoesNotCloseAgain()throws Exception{
        String target=emptyShift();JSONObject previous=store.read();JSONObject closed=closer.closeWithPin(target,900,null);String archive=record("native_shift_close_setup_transitions","1=1");store.write(previous);reopen();assertEquals(target,store.read().getJSONObject("offline").getString("shiftId"));assertEquals("closed",closer.getState().getString("status"));assertEquals(target,store.read().getJSONObject("offline").getString("shiftId"));
        assertEquals("closed",closer.checkWithPin(null).getString("status"));assertTrue(store.read().getJSONObject("offline").isNull("shiftId"));assertEquals(1,executes);assertEquals(archive,record("native_shift_close_setup_transitions","1=1"));assertEquals(closed.getString("commandId"),closer.getState().getString("commandId"));
    }
    @Test public void signedCancellationNeverClosesOrClearsOriginalRequest()throws Exception{
        String id=pendingClose(),target=shift;cancelled=true;JSONObject state=closer.checkWithPin(null);assertEquals("blocked",state.getString("status"));assertEquals("shift_close_cancelled",state.getString("reasonCode"));assertEquals(1,count("native_shift_close_outcomes"));assertEquals(0,count("native_shift_close_setup_transitions"));assertEquals(target,store.read().getJSONObject("offline").getString("shiftId"));assertFalse(state.getBoolean("canRetry"));fails(()->coordinator.beginPreparation());assertEquals(1,executes);assertEquals(id,state.getString("commandId"));
    }
    @Test public void originalPinAndCurrentActorRequiredForProtectedCloseDetails()throws Exception{
        prepare();String target=shift;finishUploaded();JSONObject closed=closer.closeWithPin(target,900,PIN.toCharArray());coordinator.lock();JSONObject locked=closer.getState();assertTrue(locked.isNull("countedCashFils"));assertTrue(locked.isNull("result"));fails(()->closer.checkWithPin("00000000".toCharArray()));
        JSONObject state=store.read();state.put("actorId",UUID.randomUUID().toString());store.write(state);fails(()->closer.retryWithPin(closed.getString("commandId"),PIN.toCharArray()));assertTrue(closer.getState().isNull("result"));assertEquals(1,executes);
    }
    @Test public void closeRecordsCannotBeUpdatedDeletedOrReplaced()throws Exception{
        String target=emptyShift();closer.closeWithPin(target,900,null);for(String table:new String[]{"native_shift_close_requests","native_shift_close_outcomes","native_shift_close_setup_transitions"}){
            String original=record(table,"1=1");fails(()->journal.getWritableDatabase().execSQL("DELETE FROM "+table));String key=table.equals("native_shift_close_requests")?"id":"command_id";fails(()->journal.getWritableDatabase().execSQL("UPDATE "+table+" SET "+key+"="+key));fails(()->journal.getWritableDatabase().execSQL("INSERT OR REPLACE INTO "+table+" SELECT * FROM "+table));assertEquals(original,record(table,"1=1"));}
    }
    @Test public void exportActualShiftCloseStatesForTypeScriptContract()throws Exception{
        JSONObject states=new JSONObject();String target=emptyShift();states.put("needsCheck",closer.getState());states.put("ready",closer.checkWithPin(null));failBeforeExecute=true;fails(()->closer.closeWithPin(target,900,null));states.put("pending",closer.getState());states.put("retryReady",closer.checkWithPin(null));states.put("closed",closer.retryWithPin(states.getJSONObject("pending").getString("commandId"),null));JSONObject s=store.read();s.put("actorId",JSONObject.NULL);store.write(s);states.put("signedOut",closer.getState());
        File file=new File(context.getCacheDir(),"native-shift-close-contract.json");try(FileOutputStream out=new FileOutputStream(file)){out.write(new JSONObject().put("states",states).toString().getBytes(StandardCharsets.UTF_8));}assertTrue(file.length()>0);
    }

    @Test public void genuineVersionSixUpgradePreservesReceiptsAcknowledgementsAndTransitionArchive()throws Exception{
        prepare();sell();String old=finishUploaded();coordinator.continueAfterAllocationWithPin(old,PIN.toCharArray());String historical=prefix+"-v6.db";databases.add(historical);Map<String,String> expected=new LinkedHashMap<>();List<String> commands=new ArrayList<>(),tables=new ArrayList<>(),triggers=new ArrayList<>();
        // Versions7/8 add native_shift_close_* and native_clock_* objects. Reconstruct
        // the existing version6 schema without either addition, then migrate it.
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','trigger') ORDER BY rowid",null)){
            while(c.moveToNext()){String type=c.getString(0),name=c.getString(1),table=c.getString(2);if(name.startsWith("sqlite_")||name.equals("android_metadata")||table.startsWith("native_shift_close_")||table.startsWith("native_clock_"))continue;if(type.equals("table")){commands.add(c.getString(3));tables.add(name);}else triggers.add(c.getString(3));}
        }
        try(SQLiteDatabase legacy=SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(historical),null)){
            legacy.setForeignKeyConstraintsEnabled(true);for(String sql:commands)legacy.execSQL(sql);for(String table:tables){JSONArray data=new JSONArray(rows(journal.getReadableDatabase(),table));for(int i=0;i<data.length();i++){JSONObject row=data.getJSONObject(i);ContentValues values=new ContentValues();Iterator<String> names=row.keys();while(names.hasNext()){String name=names.next();if(row.isNull(name))values.putNull(name);else values.put(name,row.getString(name));}legacy.insertOrThrow(table,null,values);}expected.put(table,rows(legacy,table));}for(String sql:triggers)legacy.execSQL(sql);legacy.setVersion(6);assertEquals(6,legacy.getVersion());try(Cursor c=legacy.rawQuery("SELECT name FROM sqlite_master WHERE name LIKE 'native_shift_close_%'",null)){assertEquals(0,c.getCount());}
        }
        try(NativeJournal upgraded=new NativeJournal(context,historical,()->{})){
            assertEquals(8,upgraded.getReadableDatabase().getVersion());assertEquals(journal.installationId(),upgraded.installationId());assertEquals(deviceIdentity.getString("deviceKeySha256"),identity.readOrCreate(upgraded).getString("deviceKeySha256"));for(String table:tables)assertEquals(table,expected.get(table),rows(upgraded.getReadableDatabase(),table));
            NativeAllocationLifecycle lifecycle=new NativeAllocationLifecycle(upgraded,Collections.singletonMap("synthetic-server",server.getPublic()),publicKey());lifecycle.requireCandidate(old);assertNotNull(NativePreparationTransition.read(upgraded,lifecycle,Collections.singletonMap("synthetic-server",server.getPublic()),old));for(String table:new String[]{"native_shift_close_requests","native_shift_close_outcomes","native_shift_close_setup_transitions"})assertEquals("[]",rows(upgraded.getReadableDatabase(),table));
        }
    }

    @Test public void lifecycleInvalidationDuringReadCannotRestoreReadyPermission()throws Exception{
        emptyShift();assertEquals("ready",closer.checkWithPin(null).getString("status"));closer.invalidateCheck();assertEquals("needs_check",closer.getState().getString("status"));duringClose=()->closer.invalidateCheck();assertFalse(closer.checkWithPin(null).getBoolean("canClose"));assertFalse(closer.getState().getBoolean("canClose"));assertEquals(0,count("native_shift_close_requests"));assertEquals(0,executes);
    }
    @Test public void signOutDuringCommittedResponseRetainsOutcomeButNeverClearsSetupOrShowsCash()throws Exception{
        String target=emptyShift();duringExecute=()->{try{JSONObject s=store.read();s.put("actorId",JSONObject.NULL);store.write(s);}catch(Exception e){throw new RuntimeException(e);}};fails(()->closer.closeWithPin(target,900,null));assertEquals(1,count("native_shift_close_outcomes"));assertEquals(0,count("native_shift_close_setup_transitions"));assertTrue(closer.getState().isNull("result"));assertTrue(closer.getState().isNull("countedCashFils"));assertEquals(target,store.read().getJSONObject("offline").getString("shiftId"));assertEquals(1,executes);
    }
    @Test public void wrongShiftAndInvalidCashNeverPersistOrExecuteClose()throws Exception{
        String target=emptyShift();for(long cash:new long[]{-1,100000001,Long.MAX_VALUE})fails(()->closer.closeWithPin(target,cash,null));fails(()->closer.closeWithPin(UUID.randomUUID().toString(),0,null));fails(()->closer.closeWithPin(null,0,null));assertEquals(0,count("native_shift_close_requests"));assertEquals(0,executes);assertEquals(0,closeRequests.size());
    }
    @Test public void backgroundDuringCloseContextCannotPersistRequestOrExecute()throws Exception{
        String target=emptyShift();duringClose=()->closer.invalidateCheck();fails(()->closer.closeWithPin(target,900,null));assertEquals(0,count("native_shift_close_requests"));assertEquals(0,executes);assertEquals(target,store.read().getJSONObject("offline").getString("shiftId"));
    }
    @Test public void backgroundDuringAbsentRetryLookupCannotResendClose()throws Exception{
        String id=pendingClose(),request=record("native_shift_close_requests","1=1");duringClose=()->closer.invalidateCheck();fails(()->closer.retryWithPin(id,null));assertEquals(1,executes);assertEquals(1,lookups);assertEquals(request,record("native_shift_close_requests","1=1"));assertEquals(0,count("native_shift_close_outcomes"));
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
