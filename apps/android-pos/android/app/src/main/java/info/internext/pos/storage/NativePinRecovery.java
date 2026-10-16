package info.internext.pos.storage;

import android.content.Context;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.NativePinRecoveryProof;
import info.internext.pos.offline.OfflineBundle;
import info.internext.pos.offline.OfflineClock;
import java.security.PublicKey;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;

/** Explicit original-actor PIN recovery. Auth DB owns the entire pending/CAS/audit
 * journal; no financial row, authority, clock fence or receipt is changed. */
public final class NativePinRecovery {
    private static final String PATH="/api/pos/native/pin-recovery";
    private final NativeJournal journal;private final NativeSession session;private final NativeOfflineCoordinator offline;
    private final NativeStaffUnlock unlock;private final NativeClockSource clock;private final Map<String,PublicKey> keys;private final PublicKey deviceKey;
    private final AtomicLong lifecycle=new AtomicLong();
    public NativePinRecovery(Context context,NativeJournal journal,NativeSession session,NativeOfflineCoordinator offline){this(journal,session,offline);}
    NativePinRecovery(NativeJournal journal,NativeSession session,NativeOfflineCoordinator offline){this.journal=journal;this.session=session;this.offline=offline;unlock=offline.shiftCloseUnlock();clock=offline.shiftCloseClock();keys=offline.shiftCloseKeys();deviceKey=offline.shiftCloseDeviceKey();}
    /** Must be called synchronously by pause/lock/sign-out, never queued behind HTTP. */
    public void invalidate(){lifecycle.incrementAndGet();}
    public synchronized JSONObject getState()throws Exception{
        JSONObject pending=null;try{
            pending=unlock.recoveryPending();JSONObject record=pending!=null?pending:unlock.recoveryLatest();JSONObject scope=offline.recoveryScope(false);if(record!=null){try{matches(scope,record.getJSONObject("core"));}catch(Exception mismatch){if(pending!=null)throw mismatch;record=null;}}
            if(keys.isEmpty())return display("blocked",record,false,false,false,"offline_not_configured");
            boolean signedIn=true;try{offline.recoveryScope(true);}catch(Exception e){signedIn=false;}
            // Pending discovery remains possible with a blocked clock; only a historical lookup
            // may proceed. No new proof, approval execution or credential apply is permitted.
            boolean healthy=true;try{clock.read();}catch(Exception e){healthy=false;}
            if(pending!=null){boolean approved=unlock.recoveryApproval(pending.getString("requestId"))!=null;
                return display(approved?"approved":"pending",pending,false,!approved||signedIn&&healthy,!approved&&signedIn&&healthy,!healthy?"clock_source_blocked":!signedIn?"native_session_expired":approved?"pin_recovery_approved":"pin_recovery_pending");}
            if(record!=null&&unlock.recoveryApplied(record.getString("requestId"))){if(!unlock.isProvisioned(binding(scope)))throw fail("native_storage_unavailable");return display("completed",record,signedIn&&healthy,false,false,!healthy?"clock_source_blocked":!signedIn?"native_session_expired":"pin_recovery_completed");}
            if(!signedIn)return display("blocked",null,false,false,false,"native_session_expired");if(!healthy)return display("blocked",null,false,false,false,"clock_source_blocked");
            if(!unlock.isProvisioned(binding(scope)))return display("not_available",null,false,false,false,"pin_not_provisioned");
            return display("ready",null,true,false,true,null);
        }catch(Exception e){String reason=code(e);return display(pending==null&&reason.equals("pin_not_provisioned")?"not_available":"blocked",pending,false,false,false,reason);}
    }
    public synchronized JSONObject startWithCredentials(char[] password,char[] pin,char[] confirmation)throws Exception{
        long epoch=lifecycle.get();try{
            password(password);if(keys.isEmpty())throw fail("offline_not_configured");clock.read();JSONObject scope=offline.recoveryScope(true);
            // An online access check precedes staging a replacement. Password authorization is
            // still independently performed by the approval endpoint for this exact proof.
            JSONObject access=session.getAccessState();if(!"signed_in".equals(access.opt("status"))||!scope.getString("actorId").equals(access.opt("actorId")))throw fail("native_session_expired");
            active(epoch);JSONObject record;
            synchronized(journal){record=unlock.recoveryStart(binding(scope),pin,confirmation,()->lifecycle.get()==epoch);}pin=null;confirmation=null;
            String proof=proof(record);active(epoch);approve(record,proof,password,epoch);return getState();
        }finally{wipe(password);wipe(pin);wipe(confirmation);}
    }
    /** Exact UI request identity prevents a stale dialog from approving a later recovery. */
    public synchronized JSONObject retryWithPassword(String expectedRequestId,char[] password)throws Exception{
        long epoch=lifecycle.get();try{
            if(expectedRequestId==null||!expectedRequestId.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))throw fail("pin_recovery_invalid");
            JSONObject record=unlock.recoveryPending();if(record==null){JSONObject latest=unlock.recoveryLatest();if(latest!=null&&(expectedRequestId==null||expectedRequestId.equals(latest.getString("requestId")))&&unlock.recoveryApplied(latest.getString("requestId")))return getState();throw fail("pin_recovery_invalid");}
            String id=record.getString("requestId");if(expectedRequestId!=null&&!id.equals(expectedRequestId))throw fail("pin_recovery_invalid");matches(offline.recoveryScope(false),record.getJSONObject("core"));if(keys.isEmpty())throw fail("offline_not_configured");
            if(unlock.recoveryApproval(id)!=null){apply(record,epoch);return getState();}
            String old=unlock.recoveryProof(id);
            if(old==null){clock.read();offline.recoveryScope(true);active(epoch);old=proof(record);}
            JSONObject response=session.historicalRequest(PATH,new JSONObject().put("mode","lookup").put("proof",new JSONObject(old)));
            if(approved(response)){retain(record,response);apply(record,epoch);return getState();}
            if(response.length()!=1||!"not_found".equals(response.opt("status")))throw fail("pin_recovery_uncertain");
            if(password==null)return getState();password(password);clock.read();offline.recoveryScope(true);active(epoch);
            // Only a definitive bound expired-negative permits a new timestamp. An ambiguous
            // upload or ordinary not_found never discards or replaces the exact old proof.
            if(unlock.recoveryProofExpired(old))old=proof(record);
            approve(record,old,password,epoch);return getState();
        }finally{wipe(password);}
    }
    private String proof(JSONObject record)throws Exception{
        String id=record.getString("requestId"),existing=unlock.recoveryProof(id);if(existing!=null&&!unlock.recoveryProofExpired(existing))return existing;
        JSONObject payload=new JSONObject(record.getJSONObject("core").toString()).put("kind","native-pin-recovery").put("schemaVersion",1).put("signedAt",NativeCheckoutEngine.iso(clock.read().wallTimeMs));
        String envelope=offline.recoverySign(payload);unlock.recoveryAddProof(id,envelope,deviceKey);return unlock.recoveryProof(id);
    }
    private void approve(JSONObject record,String proof,char[] password,long epoch)throws Exception{
        active(epoch);matches(offline.recoveryScope(true),record.getJSONObject("core"));clock.read();JSONObject response;
        try{response=session.nativeRequest("POST",PATH,new JSONObject().put("mode","approve").put("proof",new JSONObject(proof)).put("password",new String(password)));}
        catch(NativeAccessError e){if(e.code.equals("pin_recovery_proof_expired"))unlock.recoveryMarkExpired(record.getString("requestId"),proof);throw e;}
        if(!approved(response))throw fail("pin_recovery_uncertain");retain(record,response);apply(record,epoch);
    }
    private static boolean approved(JSONObject response){return response.length()==2&&"approved".equals(response.opt("status"))&&response.opt("approval") instanceof JSONObject;}
    private void retain(JSONObject record,JSONObject response)throws Exception{unlock.recoveryAccept(record.getString("requestId"),response.getJSONObject("approval").toString(),keys,deviceKey);}
    private void apply(JSONObject record,long epoch)throws Exception{
        synchronized(session){active(epoch);JSONObject scope=offline.recoveryScope(true);matches(scope,record.getJSONObject("core"));clock.read();
        synchronized(journal){active(epoch);unlock.recoveryApply(record.getString("requestId"),binding(scope),keys,deviceKey,()->lifecycle.get()==epoch);}unlock.lock();}
    }
    private static void matches(JSONObject scope,JSONObject core)throws Exception{for(String k:new String[]{"organizationId","branchId","deviceId","actorId","keyEpoch","deviceKeySha256"})if(!scope.getString(k).equals(core.getString(k)))throw fail("offline_context_changed");}
    private static OfflineBundle.Binding binding(JSONObject s)throws Exception{return new OfflineBundle.Binding(s.getString("organizationId"),s.getString("branchId"),s.getString("deviceId"),s.getString("actorId"),s.getString("shiftId"),s.getString("keyEpoch"),s.getString("deviceKeySha256"));}
    private void active(long epoch)throws Exception{if(lifecycle.get()!=epoch)throw fail("pin_recovery_interrupted");}
    private static JSONObject display(String status,JSONObject record,boolean start,boolean retry,boolean password,String reason)throws Exception{return new JSONObject().put("schemaVersion",1).put("status",status).put("requestId",record==null?JSONObject.NULL:record.getString("requestId")).put("canStart",start).put("canRetry",retry).put("passwordRequired",password).put("reasonCode",reason==null?JSONObject.NULL:reason);}
    private static String code(Exception e){String c=e instanceof NativeAccessError?((NativeAccessError)e).code:e.getMessage();if(c!=null&&c.startsWith("clock_"))return "clock_source_blocked";return Arrays.asList("pin_not_provisioned","native_session_expired","offline_context_changed","offline_not_configured","pin_recovery_pending","pin_recovery_invalid","pin_recovery_conflict").contains(c)?c:"native_storage_unavailable";}
    private static void password(char[] password)throws Exception{if(password==null||password.length<1||password.length>256)throw fail("native_authentication_failed");}
    private static void wipe(char[] secret){if(secret!=null)Arrays.fill(secret,'\0');}
    private static NativeAccessError fail(String code){return new NativeAccessError(code);}
}
