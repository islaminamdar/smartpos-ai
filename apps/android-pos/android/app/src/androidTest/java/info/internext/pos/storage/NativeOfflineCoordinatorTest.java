package info.internext.pos.storage;

import android.content.Context;
import android.database.Cursor;
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
public class NativeOfflineCoordinatorTest {
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
        context=InstrumentationRegistry.getInstrumentation().getTargetContext();prefix="coordinator-test-"+UUID.randomUUID();vaultFile=prefix+".bin";
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
    private JSONObject respond(String path,JSONObject request)throws Exception{
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

    @Test public void baselineIsDisplayOnlyAndNoTrustedKeysBlocksBeforeNetwork()throws Exception{
        assertEquals("prepare",coordinator.getState().getString("stage"));assertFalse(coordinator.getState().getBoolean("canIssue"));assertEquals(0,sent.size());
        JSONObject original=store.read();JSONObject out=new JSONObject(original.toString()).put("actorId",JSONObject.NULL);store.write(out);assertEquals("sign_in",coordinator.getState().getString("stage"));store.write(original);
        NativeOfflineCoordinator noKeys=new NativeOfflineCoordinator(journal,session,identity,clock,unlock,Collections.emptyMap());assertEquals("offline_not_configured",noKeys.getState().getString("noticeCode"));code("offline_not_configured",noKeys::beginPreparation);assertEquals(0,sent.size());
    }
    @Test public void verifiedContextDeviceProofAndConfirmedPinInstallRealImmutableBundle()throws Exception{
        assertEquals("prepare",coordinator.beginPreparation().getString("stage"));assertEquals(1,bodies("/api/pos/offline/enroll").size());assertEquals(0,count("offline_bundles"));
        char[] pin=PIN.toCharArray(),confirmation=PIN.toCharArray();JSONObject state=coordinator.prepareWithPin(pin,confirmation);
        for(char c:pin)assertEquals('\0',c);for(char c:confirmation)assertEquals('\0',c);
        assertEquals("prepared",state.getString("status"));assertTrue(state.getBoolean("pinProvisioned"));assertFalse(state.getBoolean("canIssue"));assertEquals(1,count("offline_bundles"));assertEquals(1,count("offline_authority_state"));assertEquals(0,count("receipts"));
        coordinator.lock();assertEquals("unlock",coordinator.getState().getString("stage"));assertEquals("prepared",coordinator.unlockWithPin(PIN.toCharArray()).getString("status"));
        reopen();assertEquals("locked",coordinator.getState().getString("status"));assertEquals(1,count("offline_bundles"));
    }
    @Test public void mismatchedPinConfirmationWipesBothInputsWithoutReservation()throws Exception{
        coordinator.beginPreparation();char[] pin=PIN.toCharArray(),confirmation="87654321".toCharArray();code("pin_confirmation_mismatch",()->coordinator.prepareWithPin(pin,confirmation));for(char c:pin)assertEquals('\0',c);for(char c:confirmation)assertEquals('\0',c);
        assertFalse(coordinator.getState().getBoolean("pinProvisioned"));assertEquals(0,bodies("/api/pos/native/prepare").size());assertEquals(0,count("offline_bundles"));
    }
    @Test public void lostShiftResponsePersistsExactCommandAndOpeningAmountAcrossRestart()throws Exception{
        shift=null;assertEquals("open_shift",coordinator.beginPreparation().getString("stage"));loseNextPath="/api/pos/commands";code("offline_preparation_uncertain",()->coordinator.openShift(12300));
        JSONObject first=bodies("/api/pos/commands").get(0);reopen();assertEquals("open_shift",coordinator.getState().getString("pendingAction"));assertEquals(12300,coordinator.getState().getLong("pendingOpeningCashFils"));
        code("offline_context_changed",()->coordinator.openShift(12301));assertEquals(1,bodies("/api/pos/commands").size());
        coordinator.openShift(12300);assertEquals(canonical(first),canonical(bodies("/api/pos/commands").get(1)));assertTrue(store.read().getJSONObject("offline").getBoolean("shiftAcknowledged"));
        coordinator.beginPreparation();assertEquals(1,bodies("/api/pos/offline/enroll").size());
    }
    @Test public void lostKeyEnrollmentResponseReusesOriginalProofAndRequestAfterRestart()throws Exception{
        loseNextPath="/api/pos/offline/enroll";code("offline_preparation_uncertain",coordinator::beginPreparation);JSONObject first=bodies("/api/pos/offline/enroll").get(0);assertEquals("prepare",coordinator.getState().getString("pendingAction"));
        now+=600000;elapsed+=600000;reopen();coordinator.beginPreparation();assertEquals(canonical(first),canonical(bodies("/api/pos/offline/enroll").get(1)));assertEquals(epoch,store.read().getJSONObject("offline").getString("keyEpoch"));assertEquals(0,count("offline_bundles"));
    }
    @Test public void lostReservationResponseReusesExactRequestButFreshChallengeAfterRestart()throws Exception{
        coordinator.beginPreparation();loseNextPath="/api/pos/native/prepare";code("offline_preparation_uncertain",()->coordinator.prepareWithPin(PIN.toCharArray(),PIN.toCharArray()));
        JSONObject first=bodies("/api/pos/native/prepare").get(0);assertEquals(0,count("offline_bundles"));reopen();assertEquals("prepare",coordinator.getState().getString("pendingAction"));
        now+=1000;elapsed+=1000;coordinator.prepareWithPin(PIN.toCharArray(),null);JSONObject second=bodies("/api/pos/native/prepare").get(1);
        assertEquals(canonical(first.getJSONObject("reservation")),canonical(second.getJSONObject("reservation")));assertNotEquals(first.getString("challenge"),second.getString("challenge"));assertEquals(1,count("offline_bundles"));assertEquals("prepared",coordinator.getState().getString("status"));
    }
    @Test public void wrongSignedContextChallengeOrScopeNeverEnrollsOrInstalls()throws Exception{
        wrongContextChallenge=true;assertThrows(IllegalArgumentException.class,coordinator::beginPreparation);wrongContextChallenge=false;wrongContextScope=true;assertThrows(IllegalArgumentException.class,coordinator::beginPreparation);
        assertEquals(0,bodies("/api/pos/offline/enroll").size());assertEquals(0,count("offline_bundles"));assertTrue(store.read().getJSONObject("offline").isNull("keyEpoch"));
    }
    @Test public void wrongPreparedChallengeOrScopeLeavesDurableReservationButNoInstalledAuthority()throws Exception{
        coordinator.beginPreparation();wrongPreparedChallenge=true;assertThrows(IllegalArgumentException.class,()->coordinator.prepareWithPin(PIN.toCharArray(),PIN.toCharArray()));assertEquals(0,count("offline_bundles"));
        wrongPreparedChallenge=false;wrongPreparedScope=true;assertThrows(IllegalArgumentException.class,()->coordinator.prepareWithPin(PIN.toCharArray(),null));assertEquals(0,count("offline_bundles"));
        wrongPreparedScope=false;coordinator.prepareWithPin(PIN.toCharArray(),null);assertEquals(1,count("offline_bundles"));
        List<JSONObject> requests=bodies("/api/pos/native/prepare");for(JSONObject r:requests)assertEquals(canonical(requests.get(0).getJSONObject("reservation")),canonical(r.getJSONObject("reservation")));
    }
    @Test public void replayDoesNotReanchorExistingAuthorityClockOrReserveNewIdentity()throws Exception{
        prepare();String firstClock=savedClock(),firstRequest=canonical(bodies("/api/pos/native/prepare").get(0).getJSONObject("reservation"));
        now+=60000;elapsed+=60000;coordinator.prepareWithPin(PIN.toCharArray(),null);
        assertEquals(firstClock,savedClock());assertEquals(firstRequest,canonical(bodies("/api/pos/native/prepare").get(1).getJSONObject("reservation")));assertEquals(1,count("offline_bundles"));assertEquals(0,count("receipts"));
        shift=UUID.randomUUID().toString();code("offline_context_changed",coordinator::beginPreparation);assertEquals(firstClock,savedClock());
    }
    @Test public void incorrectExistingPinCannotMakePreparationHttpRequest()throws Exception{
        prepare();coordinator.lock();int calls=bodies("/api/pos/native/prepare").size();char[] wrong="00000000".toCharArray();
        assertEquals("pin_incorrect",assertThrows(IllegalStateException.class,()->coordinator.prepareWithPin(wrong,null)).getMessage());
        for(char c:wrong)assertEquals('\0',c);assertEquals(calls,bodies("/api/pos/native/prepare").size());assertEquals("locked",coordinator.getState().getString("status"));assertEquals(1,count("offline_bundles"));
    }
    @Test public void rotatingCookiesSurviveOfflineStatePersistenceAndProcessReopen()throws Exception{
        rotateCookies=true;coordinator.beginPreparation();assertEquals("synthetic-rotated-refresh",store.read().getJSONObject("cookies").getString("pos-refresh"));
        coordinator.prepareWithPin(PIN.toCharArray(),PIN.toCharArray());reopen();assertEquals("synthetic-rotated-access",store.read().getJSONObject("cookies").getString("pos-access"));assertEquals("synthetic-rotated-refresh",store.read().getJSONObject("cookies").getString("pos-refresh"));assertEquals(epoch,store.read().getJSONObject("offline").getString("keyEpoch"));assertEquals(1,count("offline_bundles"));
    }
    @Test public void encryptedV1MigrationPreservesActorTokensCounterAndPendingEnrollment()throws Exception{
        JSONObject original=store.read(),legacy=new JSONObject(original.toString());legacy.remove("offline");legacy.put("schemaVersion",1).put("enrollment",new JSONObject().put("actorId",actor).put("branchId",branch).put("name","Synthetic pending"));store.write(legacy);
        SecureSessionStore migrated=new SecureSessionStore(context,vaultFile,aliases.get(0));JSONObject actual=migrated.read();assertEquals(2,actual.getInt("schemaVersion"));assertTrue(actual.isNull("offline"));
        for(String field:new String[]{"actorId","cookies","counter","enrollment","logoutPending"})assertEquals(legacy.get(field).toString(),actual.get(field).toString());
        JSONObject again=new SecureSessionStore(context,vaultFile,aliases.get(0)).read();assertEquals(canonical(actual),canonical(again));
        File disk=new File(context.getNoBackupFilesDir(),vaultFile);byte[] raw=new byte[(int)disk.length()];try(InputStream in=new FileInputStream(disk)){assertEquals(raw.length,in.read(raw));}assertFalse(new String(raw,StandardCharsets.UTF_8).contains("synthetic-refresh"));
    }
    private JSONObject proof(JSONObject request)throws Exception{return (JSONObject)SignedProtocol.verify(request.getJSONObject("proof").toString(),Collections.singletonMap(deviceIdentity.getString("deviceKeySha256"),SignedProtocol.publicKey(SignedProtocol.decode(deviceIdentity.getString("publicKeySpkiBase64Url"),256)))).payload();}
    private String seal(){try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT seal_envelope FROM offline_authority_state",null)){assertTrue(c.moveToFirst());return c.isNull(0)?null:c.getString(0);}}
    @Test public void definitiveExpiredProofSurvivesRestartAndRefreshesOnlyAfterFreshVerifiedContext()throws Exception{
        enrollmentErrorMode=1;code("offline_preparation_uncertain",coordinator::beginPreparation);JSONObject first=bodies("/api/pos/offline/enroll").get(0);assertTrue(store.read().getJSONObject("offline").getBoolean("enrollmentProofExpired"));assertTrue(store.read().getJSONObject("offline").isNull("keyEpoch"));
        reopen();now+=600000;elapsed+=600000;wrongContextChallenge=true;assertThrows(IllegalArgumentException.class,coordinator::beginPreparation);assertEquals(1,bodies("/api/pos/offline/enroll").size());assertTrue(store.read().getJSONObject("offline").getBoolean("enrollmentProofExpired"));
        wrongContextChallenge=false;coordinator.beginPreparation();JSONObject refreshed=bodies("/api/pos/offline/enroll").get(1);
        for(String field:new String[]{"requestId","branchId","deviceId","publicKeySpki","deviceKeySha256"})assertEquals(first.get(field),refreshed.get(field));
        assertNotEquals(proof(first).getString("issuedAt"),proof(refreshed).getString("issuedAt"));assertEquals(NativeCheckoutEngine.iso(now),proof(refreshed).getString("issuedAt"));
        assertEquals(Arrays.asList(false,false),expiredFlagsAtSend);assertFalse(store.read().getJSONObject("offline").getBoolean("enrollmentProofExpired"));assertEquals(epoch,store.read().getJSONObject("offline").getString("keyEpoch"));
    }
    @Test public void lostRefreshedEnrollmentResponseKeepsNewProofExactlyAcrossFurtherRestart()throws Exception{
        enrollmentErrorMode=1;code("offline_preparation_uncertain",coordinator::beginPreparation);JSONObject old=bodies("/api/pos/offline/enroll").get(0);reopen();now+=600000;elapsed+=600000;loseNextPath="/api/pos/offline/enroll";
        code("offline_preparation_uncertain",coordinator::beginPreparation);JSONObject fresh=bodies("/api/pos/offline/enroll").get(1);assertFalse(store.read().getJSONObject("offline").getBoolean("enrollmentProofExpired"));assertTrue(store.read().getJSONObject("offline").isNull("keyEpoch"));
        reopen();now+=600000;elapsed+=600000;coordinator.beginPreparation();JSONObject replay=bodies("/api/pos/offline/enroll").get(2);assertEquals(canonical(fresh),canonical(replay));assertEquals(old.getString("requestId"),fresh.getString("requestId"));assertNotEquals(proof(old).getString("issuedAt"),proof(fresh).getString("issuedAt"));assertEquals(Arrays.asList(false,false,false),expiredFlagsAtSend);
    }
    @Test public void genericExpiredLookingFailureNeverPermitsRefreshingPendingProof()throws Exception{
        enrollmentErrorMode=2;code("offline_preparation_uncertain",coordinator::beginPreparation);JSONObject original=bodies("/api/pos/offline/enroll").get(0);assertFalse(store.read().getJSONObject("offline").getBoolean("enrollmentProofExpired"));
        reopen();now+=600000;elapsed+=600000;enrollmentErrorMode=3;code("offline_preparation_uncertain",coordinator::beginPreparation);assertFalse(store.read().getJSONObject("offline").getBoolean("enrollmentProofExpired"));assertEquals(canonical(original),canonical(bodies("/api/pos/offline/enroll").get(1)));
        coordinator.beginPreparation();assertEquals(canonical(original),canonical(bodies("/api/pos/offline/enroll").get(2)));assertEquals(epoch,store.read().getJSONObject("offline").getString("keyEpoch"));
    }
    @Test public void successfulOldEnrollmentReplayNeverChangesProofOrCreatesRecoveryFlag()throws Exception{
        loseNextPath="/api/pos/offline/enroll";code("offline_preparation_uncertain",coordinator::beginPreparation);JSONObject first=bodies("/api/pos/offline/enroll").get(0);reopen();now+=86400000;elapsed+=86400000;coordinator.beginPreparation();
        assertEquals(canonical(first),canonical(bodies("/api/pos/offline/enroll").get(1)));assertFalse(store.read().getJSONObject("offline").getBoolean("enrollmentProofExpired"));coordinator.beginPreparation();assertEquals(2,bodies("/api/pos/offline/enroll").size());
    }
    @Test public void finishCorrectAuthoritySignsOneStableLocalSealWithoutNetworkAndLocksStaff()throws Exception{
        prepare();String authorityId=authority.getString("id");int requests=sent.size();char[] pin=PIN.toCharArray();coordinator.finishAuthorityWithPin(authorityId,pin);for(char c:pin)assertEquals('\0',c);assertEquals(requests,sent.size());String first=seal();assertNotNull(first);
        JSONObject payload=(JSONObject)SignedProtocol.verify(first,Collections.singletonMap(deviceIdentity.getString("deviceKeySha256"),SignedProtocol.publicKey(SignedProtocol.decode(deviceIdentity.getString("publicKeySpkiBase64Url"),256)))).payload();assertEquals(authorityId,payload.getString("authorityId"));assertEquals(0,payload.getLong("finalSequence"));assertTrue(payload.isNull("finalEventSha256"));
        coordinator.finishAuthorityWithPin(authorityId,PIN.toCharArray());assertEquals(first,seal());assertEquals("blocked",coordinator.getState().getString("status"));assertEquals(0,count("receipts"));assertEquals(1,count("offline_bundles"));
    }
    @Test public void finishRejectsWrongAuthorityIncorrectPinAndSignedOutOrPendingLogoutWithoutSeal()throws Exception{
        prepare();String authorityId=authority.getString("id");char[] wrongIdPin=PIN.toCharArray();code("offline_context_changed",()->coordinator.finishAuthorityWithPin(UUID.randomUUID().toString(),wrongIdPin));for(char c:wrongIdPin)assertEquals('\0',c);assertNull(seal());
        char[] wrongPin="00000000".toCharArray();assertEquals("pin_incorrect",assertThrows(IllegalStateException.class,()->coordinator.finishAuthorityWithPin(authorityId,wrongPin)).getMessage());for(char c:wrongPin)assertEquals('\0',c);assertNull(seal());
        int requests=sent.size();JSONObject saved=store.read();for(boolean pending:new boolean[]{false,true}){JSONObject state=new JSONObject(saved.toString());if(pending)state.put("logoutPending",true);else state.put("actorId",JSONObject.NULL);store.write(state);char[] pin=PIN.toCharArray();code("pin_unlock_required",()->coordinator.finishAuthorityWithPin(authorityId,pin));for(char c:pin)assertEquals('\0',c);assertNull(seal());}
        assertEquals(requests,sent.size());assertEquals(0,count("receipts"));
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
