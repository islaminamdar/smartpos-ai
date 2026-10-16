package info.internext.pos.storage;

import android.content.Context;
import info.internext.pos.offline.NativeClockRecoveryProof;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;

/** Explicit original-device clock recovery. Clock, financial and PIN custody are never reset. */
public final class NativeClockRecovery {
    private static final String PATH="/api/pos/native/clock-recovery";
    private final NativeJournal journal;private final NativeSession session;private final NativeOfflineCoordinator offline;
    private final NativeClockSource clock;private final NativeStaffUnlock unlock;private final Map<String,PublicKey> keys;private final PublicKey device;
    private final AtomicLong lifecycle=new AtomicLong();private String notice;
    public NativeClockRecovery(Context context,NativeJournal journal,NativeSession session,NativeOfflineCoordinator offline){this(journal,session,offline);}
    NativeClockRecovery(NativeJournal journal,NativeSession session,NativeOfflineCoordinator offline){this.journal=journal;this.session=session;this.offline=offline;clock=offline.shiftCloseClock();unlock=offline.shiftCloseUnlock();keys=offline.shiftCloseKeys();device=offline.shiftCloseDeviceKey();}
    public void invalidate(){lifecycle.incrementAndGet();}
    public synchronized JSONObject getState()throws Exception{
        JSONObject record=null;try{
            securityIntegrity();record=clock.recoveryPending();boolean pending=record!=null;if(record==null)record=clock.recoveryLatest();JSONObject scope;
            try{scope=offline.recoveryScope(false);}catch(Exception missing){
                if(record==null&&!journal.hasCustody()){try{clock.read();}catch(Exception ignored){}if(!clock.snapshot().getBoolean("blocked"))return display("not_available",null,false,false,false,"clock_healthy");}
                throw missing;
            }
            if(record!=null){try{matches(scope,record.getJSONObject("core"));}catch(Exception e){if(pending)throw e;record=null;}}
            if(keys.isEmpty())return display("blocked",record,false,false,false,"offline_not_configured");
            boolean actor=true;try{offline.recoveryScope(true);}catch(Exception e){actor=false;}
            if(pending){boolean approved=!record.isNull("approval");return display(approved?"approved":"pending",record,false,approved?actor:true,!approved&&actor,notice!=null?notice:!actor?"native_session_expired":approved?"clock_recovery_approved":"clock_recovery_pending");}
            if(record!=null&&NativeClockRetirement.incomplete(journal,record.getString("requestId")))return display("approved",record,false,actor,false,actor?"clock_recovery_approved":"native_session_expired");
            detectFault();
            boolean blocked=clock.snapshot().getBoolean("blocked");
            if(!blocked)return display(record!=null?"completed":"not_available",record,false,false,false,record!=null?"clock_recovery_completed":"clock_healthy");
            if(!actor)return display("blocked",null,false,false,false,"native_session_expired");clock.recoveryProbe();
            return display("ready",null,true,false,true,null);
        }catch(Exception e){return display("blocked",record,false,false,false,code(e));}
    }
    public synchronized JSONObject startWithPassword(char[] password)throws Exception{
        long epoch=lifecycle.get();try{
            password(password);securityIntegrity();if(keys.isEmpty())throw fail("offline_not_configured");JSONObject scope=offline.recoveryScope(true);
            JSONObject access=session.getAccessState();if(!"signed_in".equals(access.opt("status"))||!scope.getString("actorId").equals(access.opt("actorId")))throw fail("native_session_expired");
            detectFault();clock.recoveryProbe();active(epoch);JSONObject record;
            synchronized(session){matches(offline.recoveryScope(true),scope);synchronized(journal){
                NativeClockRetirement.requireNoPending(journal);JSONObject state=clock.snapshot();if(!state.getBoolean("blocked"))throw fail("clock_healthy");
                JSONObject manifest=NativeClockRetirement.manifest(journal,session.nativeState().optJSONObject("offline"),keys,device);
                JSONObject core=new JSONObject();for(String k:new String[]{"organizationId","branchId","deviceId","actorId","keyEpoch","deviceKeySha256"})core.put(k,scope.get(k));
                core.put("requestId",UUID.randomUUID().toString()).put("installationId",journal.installationId()).put("oldClockGeneration",state.getLong("generation")).put("oldClockSha256",NativeJournal.hash(NativeClockRetirement.canonical(state))).put("retirementSha256",NativeJournal.hash(NativeClockRetirement.canonical(manifest)));
                String proof=offline.recoverySign(new JSONObject(core.toString()).put("kind","native-clock-recovery").put("schemaVersion",1));active(epoch);
                record=clock.recoveryStage(core,manifest,proof);NativeClockRetirement.stage(journal,record);unlock.lock();
            }}
            exchange(record,password,epoch,true);notice=null;return getState();
        }catch(Exception e){notice=code(e);throw e;}finally{wipe(password);}
    }
    public synchronized JSONObject retryWithPassword(String requestId,char[] password)throws Exception{
        long epoch=lifecycle.get();try{
            if(requestId==null||!requestId.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))throw fail("clock_recovery_invalid");
            JSONObject record=clock.recoveryPending();if(record==null){record=clock.recoveryLatest();if(record==null||!requestId.equals(record.getString("requestId"))||!record.getBoolean("applied"))throw fail("clock_recovery_invalid");
                synchronized(session){active(epoch);matches(offline.recoveryScope(true),record.getJSONObject("core"));synchronized(journal){NativeClockRetirement.complete(journal,record,keys,device);}}unlock.lock();return getState();}
            if(!requestId.equals(record.getString("requestId")))throw fail("clock_recovery_invalid");matches(offline.recoveryScope(false),record.getJSONObject("core"));
            synchronized(journal){NativeClockRetirement.stage(journal,record);}active(epoch);
            if(!exchange(record,null,epoch,false)&&password!=null){password(password);active(epoch);matches(offline.recoveryScope(true),record.getJSONObject("core"));exchange(record,password,epoch,true);}
            notice=null;return getState();
        }catch(Exception e){notice=code(e);throw e;}finally{wipe(password);}
    }
    private void securityIntegrity()throws Exception{
        // Authenticate retained PIN custody without unlocking, charging an attempt or
        // treating an authentic pending PIN replacement as a clock-recovery blocker.
        try{unlock.hasAnyProvisionedCredentials();unlock.recoveryPending();}catch(Exception corrupt){throw fail("native_storage_unavailable");}
    }
    private void detectFault()throws Exception{
        synchronized(journal){
            info.internext.pos.offline.OfflineClock.Reading reading;
            try{reading=clock.read();}catch(Exception e){return;}
            try(android.database.Cursor c=journal.getReadableDatabase().rawQuery("SELECT b.id,s.clock_json,s.seal_envelope FROM offline_bundles b JOIN offline_authority_state s ON s.authority_id=b.id",null)){
                while(c.moveToNext()){
                    if(!c.isNull(2)||NativeClockRetirement.retired(journal,c.getString(0),keys,device))continue;
                    info.internext.pos.offline.OfflineBundle b=new NativeAllocationLifecycle(journal,keys,device).bundle(c.getString(0));
                    try{info.internext.pos.offline.OfflineClock.advance(info.internext.pos.offline.OfflineClock.State.fromJson(c.getString(1)),reading,b.notBeforeMs,b.expiresAtMs);}
                    catch(info.internext.pos.offline.OfflineClock.ClockException e){if(e.isAnomaly()){clock.latchAuthorityAnomaly();return;}}
                }
            }
        }
    }
    private boolean exchange(JSONObject record,char[] password,long epoch,boolean approve)throws Exception{
        active(epoch);if(approve)matches(offline.recoveryScope(true),record.getJSONObject("core"));
        String challenge=challenge();NativeClockSource.Observation before=clock.recoveryProbe();JSONObject body=new JSONObject().put("mode",approve?"approve":"lookup").put("proof",new JSONObject(record.getString("proof"))).put("challenge",challenge);
        if(approve)body.put("password",new String(password));JSONObject response=approve?session.nativeRequest("POST",PATH,body):session.historicalRequest(PATH,body);
        if(!approve&&response.length()==1&&"not_found".equals(response.opt("status"))){if(!record.isNull("approval"))throw fail("clock_recovery_conflict");return false;}
        if(response.length()!=3||!"approved".equals(response.opt("status"))||!(response.opt("approval") instanceof JSONObject)||!(response.opt("time") instanceof JSONObject))throw fail("clock_recovery_uncertain");
        // An authentic approval received after pause is retained. No global clock CAS happens
        // until another explicit foreground action obtains a fresh nonce-bound time response.
        record=clock.recoveryAccept(record.getString("requestId"),response.getJSONObject("approval").toString(),keys,device);
        synchronized(journal){NativeClockRetirement.retire(journal,record,keys,device);}
        synchronized(session){active(epoch);matches(offline.recoveryScope(true),record.getJSONObject("core"));synchronized(journal){
            active(epoch);securityIntegrity();clock.recoveryApply(record.getString("requestId"),response.getJSONObject("time").toString(),challenge,before,keys,device,()->lifecycle.get()==epoch);
            NativeClockRetirement.complete(journal,clock.recoveryLatest(),keys,device);unlock.lock();
        }}return true;
    }
    private static void matches(JSONObject scope,JSONObject core)throws Exception{for(String k:new String[]{"organizationId","branchId","deviceId","actorId","keyEpoch","deviceKeySha256"})if(!scope.get(k).equals(core.get(k)))throw fail("offline_context_changed");}
    private void active(long epoch)throws Exception{if(lifecycle.get()!=epoch)throw fail("clock_recovery_interrupted");}
    private static JSONObject display(String status,JSONObject record,boolean start,boolean retry,boolean password,String reason)throws Exception{return new JSONObject().put("schemaVersion",1).put("status",status).put("requestId",record==null?JSONObject.NULL:record.getString("requestId")).put("canStart",start).put("canRetry",retry).put("passwordRequired",password).put("reasonCode",reason==null?JSONObject.NULL:reason);}
    private static String code(Exception e){String c=e instanceof NativeAccessError?((NativeAccessError)e).code:e.getMessage();if(Arrays.asList("clock_healthy","clock_recovery_pending","clock_recovery_approved","clock_recovery_completed","clock_recovery_conflict","clock_recovery_interrupted","clock_recovery_invalid","clock_recovery_uncertain","clock_time_settings_required","clock_signal_unavailable","offline_context_changed","native_session_expired","offline_not_configured","native_storage_unavailable").contains(c))return c;if("pin_not_provisioned".equals(c))return "offline_not_configured";return "clock_recovery_uncertain";}
    private static String challenge(){byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);StringBuilder s=new StringBuilder(64);for(byte b:bytes)s.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return s.toString();}
    private static void password(char[] p)throws Exception{if(p==null||p.length<1||p.length>256)throw fail("native_authentication_failed");}
    private static void wipe(char[] p){if(p!=null)Arrays.fill(p,'\0');}
    private static NativeAccessError fail(String c){return new NativeAccessError(c);}
}
