package info.internext.pos.storage;

import android.content.Context;
import info.internext.pos.offline.NativeClockBootstrapTime;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;

/** Pristine pre-enrollment time verification. No financial or credential state is changed. */
public final class NativeClockBootstrap {
    private final DeviceIdentity identity;private final NativeJournal journal;private final NativeSession session;private final NativeClockSource clock;
    private final NativeStaffUnlock unlock;private final Map<String,PublicKey> keys;private final String fingerprint;
    private final AtomicLong lifecycle=new AtomicLong();
    public NativeClockBootstrap(Context context,NativeJournal journal,NativeSession session,NativeOfflineCoordinator offline)throws Exception{this(journal,session,offline);}
    NativeClockBootstrap(NativeJournal journal,NativeSession session,NativeOfflineCoordinator offline)throws Exception{
        this.journal=journal;this.session=session;identity=offline.bootstrapIdentity();clock=offline.shiftCloseClock();unlock=offline.shiftCloseUnlock();keys=offline.shiftCloseKeys();
        fingerprint=info.internext.pos.offline.SignedProtocol.fingerprint(offline.shiftCloseDeviceKey());
    }
    public void invalidate(){lifecycle.incrementAndGet();}
    public synchronized JSONObject getState()throws Exception{
        try{synchronized(session){synchronized(journal){synchronized(NativeStaffUnlock.class){
            pristine();
            boolean completed=clock.bootstrapCompleted(keys,fingerprint);try{clock.read();}catch(Exception e){if(!clock.snapshot().getBoolean("blocked"))throw e;}
            JSONObject old=clock.snapshot();if(!old.getBoolean("blocked"))return display(completed?"completed":"not_available",false,completed?"clock_bootstrap_completed":"clock_healthy");
            if(keys.isEmpty())return display("blocked",false,"offline_not_configured");
            if(old.getLong("generation")>=9_007_199_254_740_991L)return display("blocked",false,"clock_signal_unavailable");clock.recoveryProbe();
            return display("ready",true,null);
        }}}}catch(Exception e){String code=code(e);return display(code.equals("clock_bootstrap_not_eligible")?"not_available":"blocked",false,code.equals("clock_bootstrap_uncertain")?"native_storage_unavailable":code);}
    }
    public synchronized JSONObject verify()throws Exception{
        long epoch=lifecycle.get();try{
            JSONObject request;NativeClockSource.Observation before;
            synchronized(session){synchronized(journal){synchronized(NativeStaffUnlock.class){
                pristine();if(keys.isEmpty())throw fail("offline_not_configured");clock.bootstrapCompleted(keys,fingerprint);
                JSONObject old=clock.snapshot();if(!old.getBoolean("blocked"))throw fail("clock_bootstrap_not_eligible");
                before=clock.recoveryProbe();request=new JSONObject().put("schemaVersion",1).put("installationId",journal.installationId()).put("deviceKeySha256",fingerprint).put("oldClockGeneration",old.getLong("generation")).put("oldClockSha256",NativeJournal.hash(NativeClockRetirement.canonical(old))).put("challenge",challenge());
                NativeClockBootstrapTime.request(request);active(epoch);unlock.lock();
            }}}
            JSONObject response=session.bootstrapTimeRequest(request);active(epoch);
            if(response.length()!=2||!"ready".equals(response.opt("status"))||!(response.opt("time") instanceof JSONObject))throw fail("clock_bootstrap_uncertain");
            String time=response.getJSONObject("time").toString();NativeClockBootstrapTime.verify(time,keys,request);
            synchronized(session){synchronized(journal){synchronized(NativeStaffUnlock.class){
                active(epoch);pristine();clock.bootstrapApply(request,time,before,keys,()->lifecycle.get()==epoch);unlock.lock();
            }}}
            return display("completed",false,"clock_bootstrap_completed");
        }catch(Exception e){throw fail(code(e));}
    }
    private void pristine()throws Exception{
        identity.requireExistingFingerprint(fingerprint);journal.requireBootstrapPristine(fingerprint);unlock.requireBootstrapPristine();JSONObject state=session.nativeState();
        if((!(state.get("schemaVersion") instanceof Integer)&&!(state.get("schemaVersion") instanceof Long))||state.getLong("schemaVersion")!=2)throw fail("native_storage_unavailable");
        for(String field:new String[]{"counter","offline"})if(!state.isNull(field)&&!(state.get(field) instanceof JSONObject))throw fail("native_storage_unavailable");
        if(state.isNull("actorId")&&state.getJSONObject("cookies").length()!=0)throw fail("clock_bootstrap_not_eligible");
        if(state.getBoolean("logoutPending")||!state.isNull("enrollment"))throw fail("clock_bootstrap_not_eligible");
        JSONObject counter=state.optJSONObject("counter"),saved=state.optJSONObject("offline");
        if(!state.isNull("actorId"))uuid(state.get("actorId"));
        if(counter!=null){fields(counter,"id","branchId","actorId","name");for(String k:new String[]{"id","branchId","actorId"})uuid(counter.get(k));if(!(counter.get("name") instanceof String)||counter.getString("name").isEmpty())throw fail("native_storage_unavailable");if(!state.isNull("actorId")&&!state.get("actorId").equals(counter.get("actorId")))throw fail("clock_bootstrap_not_eligible");}
        if(saved==null)return;
        fields(saved,"scope","shiftId","shiftRequest","shiftAcknowledged","enrollmentRequest","keyEpoch","reservation");
        if(!saved.isNull("enrollmentRequest")||!saved.isNull("keyEpoch")||!saved.isNull("reservation"))throw fail("clock_bootstrap_not_eligible");
        JSONObject scope=saved.getJSONObject("scope");fields(scope,"organizationId","branchId","deviceId","actorId");for(String k:new String[]{"organizationId","branchId","deviceId","actorId"})uuid(scope.get(k));
        if(counter==null||!scope.get("branchId").equals(counter.get("branchId"))||!scope.get("deviceId").equals(counter.get("id"))||!scope.get("actorId").equals(counter.get("actorId")))throw fail("clock_bootstrap_not_eligible");
        if(!(saved.get("shiftAcknowledged") instanceof Boolean))throw fail("native_storage_unavailable");
        if(saved.isNull("shiftRequest")){if(!saved.isNull("shiftId")||saved.getBoolean("shiftAcknowledged"))throw fail("clock_bootstrap_not_eligible");return;}
        JSONObject shift=saved.getJSONObject("shiftRequest");fields(shift,"id","type","branchId","deviceId","shiftId","openingCashFils");
        if(!saved.getBoolean("shiftAcknowledged")||saved.isNull("shiftId")||!"shift.open".equals(shift.opt("type"))||!shift.get("shiftId").equals(saved.get("shiftId"))||!shift.get("branchId").equals(scope.get("branchId"))||!shift.get("deviceId").equals(scope.get("deviceId")))throw fail("clock_bootstrap_not_eligible");
        uuid(shift.get("id"));uuid(shift.get("shiftId"));Object cash=shift.get("openingCashFils");if(!(cash instanceof Integer)&&!(cash instanceof Long)||shift.getLong("openingCashFils")<0||shift.getLong("openingCashFils")>100000000)throw fail("native_storage_unavailable");
    }
    private static void fields(JSONObject p,String... fields)throws Exception{if(p.length()!=fields.length)throw fail("clock_bootstrap_not_eligible");for(String k:fields)if(!p.has(k))throw fail("native_storage_unavailable");}
    private static void uuid(Object p)throws Exception{if(!(p instanceof String)||!((String)p).matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))throw fail("native_storage_unavailable");}
    private void active(long epoch)throws Exception{if(lifecycle.get()!=epoch)throw fail("clock_recovery_interrupted");}
    private static JSONObject display(String status,boolean can,String reason)throws Exception{return new JSONObject().put("schemaVersion",1).put("status",status).put("canVerify",can).put("reasonCode",reason==null?JSONObject.NULL:reason);}
    private static String code(Exception e){String c=e instanceof NativeAccessError?((NativeAccessError)e).code:e.getMessage();if(Arrays.asList("clock_bootstrap_uncertain","clock_bootstrap_not_eligible","clock_recovery_interrupted","clock_time_settings_required","clock_signal_unavailable","native_storage_unavailable","offline_not_configured").contains(c))return c;if(c!=null&&c.startsWith("clock_source"))return "clock_signal_unavailable";if(c!=null&&(c.startsWith("clock_state")||c.startsWith("native_security")||c.startsWith("pin_")))return "native_storage_unavailable";return "clock_bootstrap_uncertain";}
    private static String challenge(){byte[] b=new byte[32];new SecureRandom().nextBytes(b);StringBuilder s=new StringBuilder(64);for(byte v:b)s.append(String.format(java.util.Locale.ROOT,"%02x",v&255));return s.toString();}
    private static NativeAccessError fail(String code){return new NativeAccessError(code);}
}
