package info.internext.pos.storage;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import info.internext.pos.offline.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import javax.net.ssl.HttpsURLConnection;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.Certificate;
import java.security.spec.ECGenParameterSpec;
import java.util.*;
import static org.junit.Assert.*;

/** Synthetic credentials only; actual SQLite, Android Keystore, PBKDF2, MAC and native transport. */
@RunWith(AndroidJUnit4.class)
public class NativePinRecoveryTest {
    private Context context;private String prefix;private NativeJournal journal;private DeviceIdentity identity;private NativeClockSource clock;private NativeStaffUnlock unlock;private SecureSessionStore store;private NativeSession session;private NativeOfflineCoordinator offline;private NativePinRecovery recovery;
    private String actor=id(),org=id(),branch=id(),device=id(),epoch=id(),shift=id();private JSONObject deviceIdentity;private OfflineBundle.Binding binding;private KeyPair server;private CookieHandler prior;
    private long wall=1_792_132_200_000L,elapsed=1000;private int boot=5;private final List<JSONObject> requests=new ArrayList<>();private final List<String> cookies=new ArrayList<>();private JSONObject accepted;private String acceptedProof;private int approves,lookups;private boolean lost,beforeFailure,expire,genericError,wrongExpiry,badApproval;private Runnable during,duringLookup;private String authError;private boolean wrongExpiryId;
    private static final String OLD="18473926",NEW="29641837",PASSWORD="synthetic-account-password";
    private static String id(){return UUID.randomUUID().toString();}
    @Before public void setup()throws Exception{
        context=InstrumentationRegistry.getInstrumentation().getTargetContext();prefix="pin-recovery-"+id();prior=CookieHandler.getDefault();CookieHandler.setDefault(null);
        journal=new NativeJournal(context,prefix+"-ledger.db",()->{});identity=new DeviceIdentity(alias("identity"));deviceIdentity=identity.readOrCreate(journal);
        KeyPairGenerator g=KeyPairGenerator.getInstance("EC");g.initialize(new ECGenParameterSpec("secp256r1"));server=g.generateKeyPair();store=new SecureSessionStore(context,prefix+".bin",alias("session"));
        JSONObject state=store.read();state.put("actorId",actor).put("counter",new JSONObject().put("actorId",actor).put("id",device).put("branchId",branch).put("name","Synthetic counter"));state.getJSONObject("cookies").put("pos-access","synthetic-access").put("pos-refresh","synthetic-refresh");
        state.put("offline",new JSONObject().put("scope",new JSONObject().put("actorId",actor).put("organizationId",org).put("branchId",branch).put("deviceId",device)).put("keyEpoch",epoch).put("shiftId",shift).put("shiftRequest",JSONObject.NULL).put("shiftAcknowledged",true).put("enrollmentRequest",JSONObject.NULL).put("reservation",JSONObject.NULL));store.write(state);reopen();
        binding=new OfflineBundle.Binding(org,branch,device,actor,shift,epoch,deviceIdentity.getString("deviceKeySha256"));unlock.provisionVerifiedStaff(binding,OLD.toCharArray());
    }
    private String alias(String kind){return "internext.pos.test."+prefix+"."+kind;}
    private void reopen()throws Exception{if(offline!=null)offline.close();store=new SecureSessionStore(context,prefix+".bin",alias("session"));session=new NativeSession(store,new NativePosHttp(store,Fake::new),journal);clock=new NativeClockSource(context,journal,prefix+"-clock.db",alias("clock"),()->new NativeClockSource.Observation(boot,elapsed,wall));unlock=new NativeStaffUnlock(context,journal,clock,prefix+"-pin.db",alias("pin"),NativeStaffUnlock.mainScheduler(),()->elapsed);offline=new NativeOfflineCoordinator(journal,session,identity,clock,unlock,Collections.singletonMap("synthetic-server",server.getPublic()));recovery=new NativePinRecovery(journal,session,offline);}
    @After public void cleanup()throws Exception{try{if(offline!=null)offline.close();if(journal!=null)journal.close();}finally{CookieHandler.setDefault(prior);for(String kind:new String[]{"ledger","clock","pin"})context.deleteDatabase(prefix+"-"+kind+".db");for(String suffix:new String[]{"",".bak",".new"})new File(context.getNoBackupFilesDir(),prefix+".bin"+suffix).delete();KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);for(String kind:new String[]{"identity","session","clock","pin"})ks.deleteEntry(alias(kind));}}
    private SQLiteDatabase auth()throws Exception{java.lang.reflect.Field f=NativeStaffUnlock.class.getDeclaredField("store");f.setAccessible(true);return((SQLiteOpenHelper)f.get(unlock)).getWritableDatabase();}
    private long count(String table)throws Exception{try(Cursor c=auth().rawQuery("SELECT count(*) FROM "+table,null)){c.moveToFirst();return c.getLong(0);}}
    private String rows(SQLiteDatabase db,String table){JSONArray a=new JSONArray();try(Cursor c=db.rawQuery("SELECT * FROM "+table+" ORDER BY rowid",null)){while(c.moveToNext()){JSONArray r=new JSONArray();for(int i=0;i<c.getColumnCount();i++)r.put(c.getString(i));a.put(r);}}return a.toString();}
    private interface Task{void run()throws Exception;}
    private static Exception fails(Task t)throws Exception{try{t.run();fail("Expected rejection");return null;}catch(AssertionError e){throw e;}catch(Exception e){return e;}}
    private JSONObject start()throws Exception{return recovery.startWithCredentials(PASSWORD.toCharArray(),NEW.toCharArray(),NEW.toCharArray());}
    private String pending()throws Exception{beforeFailure=true;fails(()->start());return recovery.getState().getString("requestId");}
    private JSONObject requestPayload(JSONObject envelope)throws Exception{return(JSONObject)SignedProtocol.verify(envelope.toString(),Collections.singletonMap(deviceIdentity.getString("deviceKeySha256"),SignedProtocol.publicKey(SignedProtocol.decode(deviceIdentity.getString("publicKeySpkiBase64Url"),256)))).payload();}
    private JSONObject approval(JSONObject proof)throws Exception{JSONObject payload=requestPayload(proof);JSONObject out=NativePinRecoveryProof.core(payload).put("kind","native-pin-recovery-approval").put("schemaVersion",1).put("proofSha256",NativePinRecoveryProof.payloadHash(proof.toString())).put("approvedAt",NativeCheckoutEngine.iso(wall));if(badApproval)out.put("actorId",id());return new JSONObject(SignedProtocol.sign(out,"synthetic-server",server.getPrivate(),server.getPublic()));}
    private JSONObject access()throws Exception{return new JSONObject().put("schemaVersion",1).put("status","signed_in").put("actorId",actor).put("canPrepareOffline",false).put("device",new JSONObject().put("id",device).put("branchId",branch).put("name","Synthetic counter")).put("branches",new JSONArray().put(new JSONObject().put("id",branch).put("organizationId",org).put("name","Synthetic branch").put("role","manager")));}

    @Test public void approvedResetRemainsLockedUsesNewPinAndNeverChangesFinancialCustody()throws Exception{
        journal.beginIntent(id(),"{}",NativeCheckoutEngine.iso(wall));String intents=rows(journal.getReadableDatabase(),"intents"),vault=store.read().getJSONObject("offline").toString();char[] password=PASSWORD.toCharArray(),pin=NEW.toCharArray(),confirmation=NEW.toCharArray();assertEquals("completed",recovery.startWithCredentials(password,pin,confirmation).getString("status"));
        for(char c:password)assertEquals(0,c);for(char c:pin)assertEquals(0,c);for(char c:confirmation)assertEquals(0,c);fails(()->unlock.requireUnlocked(binding));fails(()->unlock.unlock(binding,OLD.toCharArray()));unlock.unlock(binding,NEW.toCharArray());unlock.requireUnlocked(binding);
        assertEquals(intents,rows(journal.getReadableDatabase(),"intents"));assertEquals(vault,store.read().getJSONObject("offline").toString());assertEquals(1,count("pin_recovery_applied"));assertEquals(0,journal.getReadableDatabase().compileStatement("SELECT count(*) FROM receipts").simpleQueryForLong());
    }
    @Test public void lostApprovalAfterServerCommitRestartsWithExactProofAndLookupOnly()throws Exception{
        lost=true;fails(()->start());String id=recovery.getState().getString("requestId"),proof=unlock.recoveryProof(id);reopen();assertEquals("pending",recovery.getState().getString("status"));assertEquals("completed",recovery.retryWithPassword(id,null).getString("status"));assertEquals(1,approves);assertEquals(1,lookups);assertEquals(proof,unlock.recoveryProof(id));assertEquals(accepted.toString(),new JSONObject(unlock.recoveryApproval(id)).toString());
    }
    @Test public void pendingBlocksUnlockProvisionPreparationAndEnrollmentAcrossRestart()throws Exception{
        String id=pending();reopen();assertEquals(id,recovery.getState().getString("requestId"));assertEquals("pin_recovery_pending",fails(()->unlock.unlock(binding,OLD.toCharArray())).getMessage());fails(()->unlock.provisionVerifiedStaff(binding,NEW.toCharArray()));fails(()->offline.beginPreparation());fails(()->offline.openShift(0));fails(()->session.enrollCounter(branch,"Synthetic counter"));assertEquals(1,count("pin_recovery_requests"));assertEquals("pin_recovery_pending",offline.getState().getString("noticeCode"));assertEquals("blocked",offline.getNextAllocationState().getString("status"));assertFalse(offline.getNextAllocationState().getBoolean("canContinue"));assertEquals("pin_recovery_pending",offline.getNextAllocationState().getString("reasonCode"));
    }
    @Test public void exactAbsentRetryNeedsPasswordAndNeverChangesCandidateOrProof()throws Exception{
        String id=pending(),candidate=rows(auth(),"pin_recovery_requests"),proof=unlock.recoveryProof(id);assertEquals("pending",recovery.retryWithPassword(id,null).getString("status"));assertEquals(1,approves);assertEquals("completed",recovery.retryWithPassword(id,PASSWORD.toCharArray()).getString("status"));assertEquals(2,approves);assertEquals(candidate,rows(auth(),"pin_recovery_requests"));assertEquals(proof,unlock.recoveryProof(id));
    }
    @Test public void onlyBoundDefinitiveExpiryAllowsNewTimestampSameCoreAfterRestart()throws Exception{
        expire=true;assertEquals("pin_recovery_proof_expired",fails(()->start()).getMessage());String id=recovery.getState().getString("requestId"),old=unlock.recoveryProof(id),record=rows(auth(),"pin_recovery_requests");assertEquals(1,count("pin_recovery_expired"));wall+=301000;elapsed+=301000;reopen();assertEquals("completed",recovery.retryWithPassword(id,PASSWORD.toCharArray()).getString("status"));String newer=unlock.recoveryProof(id);assertNotEquals(old,newer);assertEquals(2,count("pin_recovery_proofs"));assertEquals(record,rows(auth(),"pin_recovery_requests"));assertEquals(NativePinRecoveryProof.core(requestPayload(new JSONObject(old))).toString(),NativePinRecoveryProof.core(requestPayload(new JSONObject(newer))).toString());
    }
    @Test public void genericAndWrongDigestExpiryNeverRefreshProof()throws Exception{
        genericError=true;fails(()->start());String id=recovery.getState().getString("requestId"),proof=unlock.recoveryProof(id);wall+=301000;elapsed+=301000;wrongExpiry=true;fails(()->recovery.retryWithPassword(id,PASSWORD.toCharArray()));assertEquals(0,count("pin_recovery_expired"));assertEquals(proof,unlock.recoveryProof(id));assertEquals(1,count("pin_recovery_proofs"));
    }
    @Test public void lostRefreshedApprovalRecoversExactNewProofWithoutAnotherPassword()throws Exception{
        expire=true;fails(()->start());String id=recovery.getState().getString("requestId");wall+=301000;elapsed+=301000;lost=true;fails(()->recovery.retryWithPassword(id,PASSWORD.toCharArray()));String exact=unlock.recoveryProof(id);reopen();assertEquals("completed",recovery.retryWithPassword(id,null).getString("status"));assertEquals(exact,unlock.recoveryProof(id));assertEquals(2,approves);assertEquals(2,count("pin_recovery_proofs"));
    }
    @Test public void backgroundRetainsValidApprovalButRequiresExplicitForegroundApply()throws Exception{
        during=()->recovery.invalidate();assertEquals("pin_recovery_interrupted",fails(()->start()).getMessage());String id=recovery.getState().getString("requestId");assertEquals("approved",recovery.getState().getString("status"));assertEquals(1,count("pin_recovery_approvals"));assertEquals(0,count("pin_recovery_applied"));reopen();assertEquals("completed",recovery.retryWithPassword(id,null).getString("status"));assertEquals(1,approves);assertEquals(0,lookups);
    }
    @Test public void signoutAfterApprovalPreservesGrantWithoutApplyAndLookupSendsNoCookies()throws Exception{
        lost=true;fails(()->start());String id=recovery.getState().getString("requestId");JSONObject state=store.read();state.put("actorId",JSONObject.NULL);store.write(state);String priorCookie=state.getJSONObject("cookies").getString("pos-access");fails(()->recovery.retryWithPassword(id,null));assertEquals("approved",recovery.getState().getString("status"));assertFalse(recovery.getState().getBoolean("canRetry"));assertEquals(0,count("pin_recovery_applied"));assertEquals(null,cookies.get(cookies.size()-1));assertEquals(priorCookie,store.read().getJSONObject("cookies").getString("pos-access"));state=store.read();state.put("actorId",actor);store.write(state);assertEquals("completed",recovery.retryWithPassword(id,null).getString("status"));
    }
    @Test public void foreignActorWrongRequestAndWrongSignedScopeCannotApply()throws Exception{
        String id=pending();fails(()->recovery.retryWithPassword(NativePinRecoveryTest.id(),PASSWORD.toCharArray()));JSONObject state=store.read();state.put("actorId",NativePinRecoveryTest.id());store.write(state);fails(()->recovery.retryWithPassword(id,PASSWORD.toCharArray()));state.put("actorId",actor);store.write(state);badApproval=true;fails(()->recovery.retryWithPassword(id,PASSWORD.toCharArray()));assertEquals(0,count("pin_recovery_approvals"));assertEquals(0,count("pin_recovery_applied"));
    }
    @Test public void durableApprovalSurvivesAtomicApplyAuditStorageFailure()throws Exception{
        auth().execSQL("CREATE TRIGGER synthetic_full BEFORE INSERT ON pin_recovery_applied BEGIN SELECT RAISE(ABORT,'synthetic_full'); END");String original=rows(auth(),"credentials");fails(()->start());String id=recovery.getState().getString("requestId");assertEquals(original,rows(auth(),"credentials"));assertEquals(1,count("pin_recovery_approvals"));assertEquals(0,count("pin_recovery_applied"));auth().execSQL("DROP TRIGGER synthetic_full");reopen();assertEquals("completed",recovery.retryWithPassword(id,null).getString("status"));assertEquals(1,approves);
    }
    @Test public void requestStorageFailureNeverSendsApprovalOrChangesCredential()throws Exception{
        auth().execSQL("CREATE TRIGGER synthetic_full BEFORE INSERT ON pin_recovery_requests BEGIN SELECT RAISE(ABORT,'synthetic_full'); END");String original=rows(auth(),"credentials");fails(()->start());assertEquals(0,approves);assertEquals(original,rows(auth(),"credentials"));assertEquals(0,count("pin_recovery_requests"));
    }
    @Test public void immutableRecoveryRowsRejectUpdateDeleteAndReplace()throws Exception{
        start();for(String table:new String[]{"pin_recovery_requests","pin_recovery_proofs","pin_recovery_approvals","pin_recovery_applied"}){String original=rows(auth(),table);fails(()->auth().execSQL("UPDATE "+table+" SET payload=payload"));fails(()->auth().execSQL("DELETE FROM "+table));fails(()->auth().execSQL("INSERT OR REPLACE INTO "+table+" SELECT * FROM "+table));assertEquals(original,rows(auth(),table));}
    }
    @Test public void consumedOldGrantNeverRollsBackLaterCredentialGeneration()throws Exception{
        start();String firstId=recovery.getState().getString("requestId"),firstApproval=unlock.recoveryApproval(firstId);accepted=null;acceptedProof=null;String second="38752946";assertEquals("completed",recovery.startWithCredentials(PASSWORD.toCharArray(),second.toCharArray(),second.toCharArray()).getString("status"));String latest=rows(auth(),"credentials");
        unlock.recoveryAccept(firstId,firstApproval,Collections.singletonMap("synthetic-server",server.getPublic()),SignedProtocol.publicKey(SignedProtocol.decode(deviceIdentity.getString("publicKeySpkiBase64Url"),256)));unlock.recoveryApply(firstId,binding,Collections.singletonMap("synthetic-server",server.getPublic()),SignedProtocol.publicKey(SignedProtocol.decode(deviceIdentity.getString("publicKeySpkiBase64Url"),256)),()->true);assertEquals(latest,rows(auth(),"credentials"));fails(()->unlock.unlock(binding,NEW.toCharArray()));unlock.unlock(binding,second.toCharArray());assertEquals(2,count("pin_recovery_applied"));
    }
    @Test public void rollbackClockCannotStartResetOrClearClockLatch()throws Exception{
        clock.read();wall--;assertEquals("blocked",recovery.getState().getString("status"));assertEquals("clock_source_blocked",recovery.getState().getString("reasonCode"));fails(()->start());assertEquals(0,count("pin_recovery_requests"));assertEquals(0,approves);wall+=1000;fails(()->clock.read());
    }
    @Test public void authenticVersionOneUpgradePreservesCredentialAndFailedAttempts()throws Exception{
        fails(()->unlock.unlock(binding,"00000000".toCharArray()));String original=rows(auth(),"credentials");for(String table:new String[]{"pin_recovery_requests","pin_recovery_proofs","pin_recovery_expired","pin_recovery_approvals","pin_recovery_applied"})auth().execSQL("DROP TABLE "+table);auth().setVersion(1);reopen();assertEquals(2,auth().getVersion());assertEquals(original,rows(auth(),"credentials"));assertEquals(0,count("pin_recovery_requests"));unlock.unlock(binding,OLD.toCharArray());
    }
    @Test public void corruptedPendingMacCannotLiftHoldOrReplaceCredential()throws Exception{
        String id=pending(),original=rows(auth(),"credentials");auth().execSQL("DROP TRIGGER pin_recovery_requests_no_update");auth().execSQL("UPDATE pin_recovery_requests SET mac='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'");assertEquals("blocked",recovery.getState().getString("status"));fails(()->unlock.unlock(binding,OLD.toCharArray()));fails(()->recovery.retryWithPassword(id,PASSWORD.toCharArray()));assertEquals(original,rows(auth(),"credentials"));
    }
    @Test public void nativeHistoricalTransportRejectsApproveAndUnknownBodyFields()throws Exception{
        String id=pending();JSONObject proof=new JSONObject(unlock.recoveryProof(id));fails(()->session.historicalRequest("/api/pos/native/pin-recovery",new JSONObject().put("mode","approve").put("proof",proof).put("password",PASSWORD)));fails(()->session.historicalRequest("/api/pos/native/pin-recovery",new JSONObject().put("mode","lookup").put("proof",proof).put("password",PASSWORD)));assertEquals(1,approves);assertEquals(0,lookups);
    }
    @Test public void exportActualMetadataAndDeviceProofForServerCompatibility()throws Exception{
        JSONObject states=new JSONObject().put("ready",recovery.getState());String id=pending();states.put("pending",recovery.getState());during=()->recovery.invalidate();fails(()->recovery.retryWithPassword(id,PASSWORD.toCharArray()));states.put("approved",recovery.getState());states.put("completed",recovery.retryWithPassword(id,null));JSONObject artifact=new JSONObject().put("states",states).put("publicKeySpki",deviceIdentity.getString("publicKeySpkiBase64Url")).put("serverPublicKeySpki",SignedProtocol.encode(server.getPublic().getEncoded())).put("proof",new JSONObject(unlock.recoveryProof(id))).put("approval",new JSONObject(unlock.recoveryApproval(id)));
        try(FileOutputStream out=new FileOutputStream(new File(context.getCacheDir(),"native-pin-recovery-contract.json"))){out.write(artifact.toString().getBytes(StandardCharsets.UTF_8));}assertEquals(1,count("pin_recovery_applied"));
    }

    @Test public void backgroundDuringAbsentLookupCannotApproveOrRefreshProof()throws Exception{
        String id=pending(),proof=unlock.recoveryProof(id);duringLookup=()->recovery.invalidate();assertEquals("pin_recovery_interrupted",fails(()->recovery.retryWithPassword(id,PASSWORD.toCharArray())).getMessage());assertEquals(1,approves);assertEquals(proof,unlock.recoveryProof(id));assertEquals(0,count("pin_recovery_applied"));
    }
    @Test public void staleRequestIdCannotTargetNewPendingRecovery()throws Exception{
        start();String old=recovery.getState().getString("requestId");accepted=null;beforeFailure=true;fails(()->start());String current=recovery.getState().getString("requestId");assertNotEquals(old,current);int queries=lookups;fails(()->recovery.retryWithPassword(old,PASSWORD.toCharArray()));assertEquals(queries,lookups);assertEquals(current,recovery.getState().getString("requestId"));assertEquals(1,count("pin_recovery_applied"));
    }
    @Test public void maximumFailedPinAttemptsCanRecoverWithoutOldPinAndResetOnlyCredential()throws Exception{
        for(int i=0;i<10;i++){fails(()->unlock.unlock(binding,"00000000".toCharArray()));if(i==4){wall+=NativeStaffUnlock.LOCKOUT_MS;elapsed+=NativeStaffUnlock.LOCKOUT_MS;}}
        assertEquals("pin_online_reset_required",fails(()->unlock.unlock(binding,OLD.toCharArray())).getMessage());assertEquals("completed",start().getString("status"));unlock.unlock(binding,NEW.toCharArray());unlock.requireUnlocked(binding);assertEquals(1,count("pin_recovery_applied"));
    }

    @Test public void passwordFailureDoesNotClaimSignedInSessionExpired()throws Exception{
        authError="current_password_incorrect";assertEquals("native_authentication_failed",fails(()->start()).getMessage());String id=recovery.getState().getString("requestId");assertEquals(actor,store.read().getString("actorId"));assertEquals("pending",recovery.getState().getString("status"));
        authError="authentication_required";assertEquals("native_session_expired",fails(()->recovery.retryWithPassword(id,PASSWORD.toCharArray())).getMessage());authError="unknown-untrusted-server-text";assertEquals("native_access_unavailable",fails(()->recovery.retryWithPassword(id,PASSWORD.toCharArray())).getMessage());assertEquals(0,count("pin_recovery_applied"));
    }
    @Test public void expiryForDifferentRequestNeverPermitsProofRefresh()throws Exception{
        wrongExpiryId=true;assertEquals("native_access_unavailable",fails(()->start()).getMessage());String id=recovery.getState().getString("requestId"),proof=unlock.recoveryProof(id);assertEquals(0,count("pin_recovery_expired"));assertEquals("completed",recovery.retryWithPassword(id,PASSWORD.toCharArray()).getString("status"));assertEquals(proof,unlock.recoveryProof(id));
    }

    private final class Fake extends HttpsURLConnection {
        private final ByteArrayOutputStream out=new ByteArrayOutputStream();private byte[] response;private boolean drop;
        Fake(URL url){super(url);}
        @Override public int getResponseCode()throws IOException{try{
            if(url.getPath().equals("/api/pos/native/access")){response=access().toString().getBytes(StandardCharsets.UTF_8);return 200;}
            assertEquals("/api/pos/native/pin-recovery",url.getPath());JSONObject body=new JSONObject(out.toString("UTF-8"));requests.add(body);cookies.add(getRequestProperty("Cookie"));String mode=body.getString("mode");JSONObject proof=body.getJSONObject("proof"),payload=requestPayload(proof);
            if(mode.equals("lookup")){lookups++;assertNull(getRequestProperty("Cookie"));if(duringLookup!=null){Runnable run=duringLookup;duringLookup=null;run.run();}response=(accepted==null?new JSONObject().put("status","not_found"):new JSONObject().put("status","approved").put("approval",accepted)).toString().getBytes(StandardCharsets.UTF_8);return 200;}
            approves++;assertNotNull(getRequestProperty("Cookie"));assertEquals(PASSWORD,body.getString("password"));assertNotNull(unlock.recoveryProof(payload.getString("requestId")));assertFalse(unlock.recoveryApplied(payload.getString("requestId")));
            if(authError!=null){response=new JSONObject().put("status","unavailable").put("code",authError).toString().getBytes(StandardCharsets.UTF_8);authError=null;return 401;}
            if(beforeFailure){beforeFailure=false;throw new IOException("Synthetic pre-accept failure");}
            if(expire||genericError||wrongExpiry||wrongExpiryId){JSONObject error=new JSONObject().put("status","not_approved").put("code","pin_recovery_proof_expired").put("requestId",wrongExpiryId?id():payload.getString("requestId")).put("proofSha256",wrongExpiry?String.join("",Collections.nCopies(64,"f")):NativePinRecoveryProof.payloadHash(proof.toString()));int status=genericError?503:409;expire=false;genericError=false;wrongExpiry=false;wrongExpiryId=false;response=error.toString().getBytes(StandardCharsets.UTF_8);return status;}
            if(accepted==null){accepted=approval(proof);acceptedProof=proof.toString();}response=new JSONObject().put("status","approved").put("approval",accepted).toString().getBytes(StandardCharsets.UTF_8);drop=lost;lost=false;if(during!=null){Runnable run=during;during=null;run.run();}return 200;
        }catch(IOException e){throw e;}catch(Exception e){throw new IOException("Synthetic HTTP fixture",e);}}
        @Override public Map<String,List<String>> getHeaderFields(){return Collections.singletonMap("Set-Cookie",Collections.singletonList("pos-access=synthetic-rotated; Secure; HttpOnly; Path=/"));}
        @Override public String getContentType(){return"application/json";}@Override public String getHeaderField(String name){return null;}@Override public long getContentLengthLong(){return -1;}
        @Override public InputStream getInputStream()throws IOException{if(drop)throw new IOException("Synthetic lost approval response");return new ByteArrayInputStream(response);}@Override public InputStream getErrorStream(){return new ByteArrayInputStream(response);}@Override public OutputStream getOutputStream(){return out;}@Override public void disconnect(){}@Override public boolean usingProxy(){return false;}@Override public void connect(){}@Override public String getCipherSuite(){return"TLS_SYNTHETIC";}@Override public Certificate[] getLocalCertificates(){return null;}@Override public Certificate[] getServerCertificates(){return new Certificate[0];}
    }
}
