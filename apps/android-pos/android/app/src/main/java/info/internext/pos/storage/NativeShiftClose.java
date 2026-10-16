package info.internext.pos.storage;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import info.internext.pos.offline.NativeShiftCloseProof;
import info.internext.pos.offline.OfflineBundle;
import info.internext.pos.offline.OfflineClock;
import info.internext.pos.offline.SignedProtocol;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Map;
import java.util.UUID;
import org.json.JSONObject;

/** Online drawer closure with durable exact-request custody. Never opens a shift or grants sales. */
public final class NativeShiftClose {
    private static final String PATH="/api/pos/native/shift-close";
    private final NativeJournal journal;private final NativeSession session;private final NativeOfflineCoordinator offline;
    private final NativeStaffUnlock unlock;private final NativeClockSource clock;private final Map<String,PublicKey> keys;private final PublicKey deviceKey;
    private final java.util.concurrent.atomic.AtomicLong lifecycleEpoch=new java.util.concurrent.atomic.AtomicLong();
    private long checkedEpoch=-1;
    private String checkedShift,checkedCommand;private OfflineClock.Reading checkedAt;private boolean checkedRetry,checkedReady;
    public NativeShiftClose(Context context,NativeJournal journal,NativeSession session,NativeOfflineCoordinator offline){this(journal,session,offline);}
    NativeShiftClose(NativeJournal journal,NativeSession session,NativeOfflineCoordinator offline){this.journal=journal;this.session=session;this.offline=offline;unlock=offline.shiftCloseUnlock();clock=offline.shiftCloseClock();keys=offline.shiftCloseKeys();deviceKey=offline.shiftCloseDeviceKey();}
    private static final class Local {
        final JSONObject value,scope;final String shift;final OfflineBundle.Binding binding;final boolean pin;
        Local(JSONObject value,JSONObject scope,String shift,OfflineBundle.Binding binding,boolean pin){this.value=value;this.scope=scope;this.shift=shift;this.binding=binding;this.pin=pin;}
    }
    private Local local(NativeShiftCloseJournal.Request original)throws Exception{
        JSONObject state=session.nativeState(),value=state.optJSONObject("offline"),counter=state.optJSONObject("counter");
        if(state.isNull("actorId")||state.getBoolean("logoutPending"))throw fail("native_session_expired");
        if(value==null||counter==null)throw fail("offline_context_changed");JSONObject s=value.getJSONObject("scope");
        if(!state.getString("actorId").equals(s.getString("actorId"))||!counter.getString("actorId").equals(s.getString("actorId"))||!counter.getString("id").equals(s.getString("deviceId"))||!counter.getString("branchId").equals(s.getString("branchId")))throw fail("offline_context_changed");
        String shift=original==null?(value.isNull("shiftId")?null:value.getString("shiftId")):original.shiftId;
        if(original!=null)for(String k:new String[]{"actorId","organizationId","branchId","deviceId"})if(!s.getString(k).equals(original.scope.getString(k)))throw fail("offline_context_changed");
        JSONObject scope=new JSONObject(s.toString()).put("shiftId",shift==null?JSONObject.NULL:shift);OfflineBundle.Binding binding=null;boolean pin=false;
        if(value.isNull("keyEpoch")){
            synchronized(journal){try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT 1 FROM offline_bundles LIMIT 1",null)){if(c.moveToFirst())throw fail("native_storage_unavailable");}}
            if(unlock.hasAnyProvisionedCredentials()||(original!=null&&original.pinRequired))throw fail("native_storage_unavailable");
        }else if(shift!=null){
            if(original!=null&&!original.offline.isNull("keyEpoch")&&!value.getString("keyEpoch").equals(original.offline.getString("keyEpoch")))throw fail("offline_context_changed");
            binding=new OfflineBundle.Binding(s.getString("organizationId"),s.getString("branchId"),s.getString("deviceId"),s.getString("actorId"),shift,value.getString("keyEpoch"),SignedProtocol.fingerprint(deviceKey));pin=unlock.isProvisioned(binding);
            if(!pin&&(unlock.hasAnyProvisionedCredentials()||(original!=null&&original.pinRequired)))throw fail("native_storage_unavailable");
            if(!pin)synchronized(journal){try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT 1 FROM offline_bundles LIMIT 1",null)){if(c.moveToFirst())throw fail("native_storage_unavailable");}}
        }
        return new Local(value,scope,shift,binding,pin);
    }
    private NativeShiftCloseJournal.Request selected()throws Exception{
        JSONObject state=session.nativeState(),value=state.optJSONObject("offline");synchronized(journal){
            if(value!=null&&!value.isNull("shiftId"))return NativeShiftCloseJournal.forShift(journal,value.getString("shiftId"));
            return NativeShiftCloseJournal.latest(journal);
        }
    }
    /** Nonblocking lifecycle invalidation; never removes a durable request or accepted outcome. */
    public void invalidateCheck(){lifecycleEpoch.incrementAndGet();}
    public synchronized boolean isPinRequired()throws Exception{synchronized(offline){return local(selected()).pin;}}
    public synchronized JSONObject getState()throws Exception{synchronized(offline){return state();}}
    private JSONObject state()throws Exception{
        NativeShiftCloseJournal.Request r=null;String shift=null;boolean pin=false;
        try{
            r=selected();Local l=local(r);shift=l.shift;pin=l.pin;
            if(shift==null)return display("not_available",null,null,false,false,false,null,null,null);
            if(keys.isEmpty())throw fail("offline_not_configured");boolean unlocked=readAllowed(l);
            if(r!=null){
                JSONObject outcome;synchronized(journal){outcome=NativeShiftCloseJournal.outcome(journal,keys,r);}
                if(outcome!=null){boolean applied="applied".equals(outcome.getString("status"));return display(applied?"closed":"blocked",shift,r.id,pin,false,false,!unlocked?"pin_unlock_required":applied?null:"shift_close_cancelled",unlocked?r.command.get("countedCashFils"):null,unlocked&&applied?outcome.getJSONObject("result"):null);}
                String reason=null;boolean clear=false;try{requireClear(l);clear=true;}catch(Exception e){reason=code(e);}
                boolean retry=clear&&unlocked&&fresh(l.shift,r.id)&&checkedRetry;
                return display("pending",shift,r.id,pin,false,retry,!unlocked?"pin_unlock_required":reason!=null?reason:"native_shift_close_uncertain",unlocked?r.command.get("countedCashFils"):null,null);
            }
            try{requireClear(l);}catch(Exception e){return display("blocked",shift,null,pin,false,false,code(e),null,null);}
            if(!unlocked)return display("needs_check",shift,null,pin,false,false,"pin_unlock_required",null,null);
            boolean ready=fresh(shift,null)&&checkedReady;return display(ready?"ready":"needs_check",shift,null,pin,ready,false,null,null,null);
        }catch(Exception e){
            if(r!=null)return display("pending",r.shiftId,r.id,true,false,false,code(e),null,null);
            return display("blocked",shift,null,pin,false,false,code(e),null,null);
        }
    }
    public synchronized JSONObject checkWithPin(char[] pin)throws Exception{synchronized(offline){
        try{
            long operationEpoch=lifecycleEpoch.get();clearCheck();NativeShiftCloseJournal.Request r=selected();Local l=local(r);authenticate(l,pin);pin=null;
            if(l.shift==null)return state();
            if(r!=null){
                JSONObject known;synchronized(journal){known=NativeShiftCloseJournal.outcome(journal,keys,r);}
                if(known==null){JSONObject found=requestResult("lookup",r);if(!"not_found".equals(found.getString("status"))){finishEmptySetup(r);return state();}}
                else{finishEmptySetup(r);return state();}
                try{requireClear(l);}catch(Exception held){return state();}
                JSONObject context=requestContext(l);if(context.getBoolean("canClose")){checked(l.shift,r.id,true,operationEpoch);return state();}
                return pendingContext(l,r,context);
            }
            requireClear(l);JSONObject context=requestContext(l);
            if(context.getBoolean("canClose")){checked(l.shift,null,false,operationEpoch);return state();}
            return display("blocked",l.shift,null,l.pin,false,false,context.getString("reasonCode"),null,null);
        }finally{wipe(pin);}
    }}
    public synchronized JSONObject closeWithPin(String shiftId,long countedCashFils,char[] pin)throws Exception{synchronized(offline){
        try{
            long operationEpoch=lifecycleEpoch.get();if(countedCashFils<0||countedCashFils>100000000)throw fail("offline_context_changed");Local l=local(null);if(shiftId==null||!shiftId.equals(l.shift))throw fail("offline_context_changed");authenticate(l,pin);pin=null;clearCheck();
            NativeShiftCloseJournal.Request r;synchronized(journal){r=NativeShiftCloseJournal.forShift(journal,shiftId);}
            if(r!=null){if(r.command.getLong("countedCashFils")!=countedCashFils)throw fail("offline_context_changed");return state();}
            requireClear(l);JSONObject context=requestContext(l);if(!context.getBoolean("canClose"))return display("blocked",l.shift,null,l.pin,false,false,context.getString("reasonCode"),null,null);
            synchronized(session){Local current=local(null);same(l,current);synchronized(journal){SQLiteDatabase db=journal.getWritableDatabase();db.beginTransaction();try{
                requireEpoch(operationEpoch);requireClear(current);requireRead(current);NativeShiftCloseJournal.requireNoPending(journal,keys);
                r=NativeShiftCloseJournal.forShift(journal,shiftId);if(r!=null)throw fail("native_shift_close_pending");
                JSONObject command=new JSONObject().put("id",UUID.randomUUID().toString()).put("type","shift.close").put("branchId",current.scope.getString("branchId")).put("deviceId",current.scope.getString("deviceId")).put("shiftId",shiftId).put("countedCashFils",countedCashFils);
                r=NativeShiftCloseJournal.insert(journal,current.scope,command,current.value,current.pin);db.setTransactionSuccessful();
            }finally{db.endTransaction();}}}
            // Once persisted, every uncertain path retains this exact request; never mint another ID.
            return execute(r,operationEpoch);
        }finally{wipe(pin);}
    }}
    public synchronized JSONObject retryWithPin(String commandId,char[] pin)throws Exception{synchronized(offline){
        try{
            long operationEpoch=lifecycleEpoch.get();NativeShiftCloseJournal.Request r;synchronized(journal){r=NativeShiftCloseJournal.read(journal,commandId);}if(r==null)throw fail("offline_context_changed");Local l=local(r);authenticate(l,pin);pin=null;
            // Retry always reads first. A committed result is recoverable despite new local holds.
            JSONObject found=requestResult("lookup",r);if(!"not_found".equals(found.getString("status"))){finishEmptySetup(r);return stateFor(r);}
            requireClear(l);JSONObject context=requestContext(l);if(!context.getBoolean("canClose"))return pendingContext(l,r,context);
            return execute(r,operationEpoch);
        }finally{wipe(pin);}
    }}
    private JSONObject execute(NativeShiftCloseJournal.Request r,long operationEpoch)throws Exception{
        requireEpoch(operationEpoch);
        Local l=local(r);requireClear(l);requireRead(l);if(!canonical(l.value).equals(canonical(r.offline)))throw fail("offline_context_changed");
        requireEpoch(operationEpoch);JSONObject outcome=requestResult("execute",r);clearCheck();if("not_found".equals(outcome.getString("status")))throw fail("native_shift_close_uncertain");finishEmptySetup(r);return stateFor(r);
    }
    private JSONObject stateFor(NativeShiftCloseJournal.Request r)throws Exception{
        Local l=local(r);JSONObject outcome;synchronized(journal){outcome=NativeShiftCloseJournal.outcome(journal,keys,r);}if(outcome==null)return state();boolean applied="applied".equals(outcome.getString("status"));boolean unlocked=readAllowed(l);
        return display(applied?"closed":"blocked",r.shiftId,r.id,l.pin,false,false,!unlocked?"pin_unlock_required":applied?null:"shift_close_cancelled",unlocked?r.command.get("countedCashFils"):null,unlocked&&applied?outcome.getJSONObject("result"):null);
    }
    private JSONObject pendingContext(Local l,NativeShiftCloseJournal.Request r,JSONObject context)throws Exception{return display("pending",l.shift,r.id,l.pin,false,false,context.getString("reasonCode"),readAllowed(l)?r.command.get("countedCashFils"):null,null);}
    private JSONObject requestContext(Local l)throws Exception{
        String nonce=nonce();OfflineClock.Reading before=clock.read();JSONObject response=session.nativeRequest("POST",PATH,new JSONObject().put("mode","context").put("challenge",nonce).put("branchId",l.scope.getString("branchId")).put("deviceId",l.scope.getString("deviceId")).put("shiftId",l.shift));OfflineClock.Reading after=clock.read();String envelope=envelope(response);
        JSONObject result=NativeShiftCloseProof.context(envelope,keys,nonce,l.scope,before,after);localCheck(l);return result;
    }
    private JSONObject requestResult(String mode,NativeShiftCloseJournal.Request r)throws Exception{
        Local l=local(r);String nonce=nonce();OfflineClock.Reading before=clock.read();JSONObject response;
        try{response=session.nativeRequest("POST",PATH,new JSONObject().put("mode",mode).put("challenge",nonce).put("command",r.command));}catch(Exception error){throw fail("native_shift_close_uncertain");}
        OfflineClock.Reading after=clock.read();String envelope=envelope(response);JSONObject result=NativeShiftCloseProof.result(envelope,keys,nonce,r.scope,r.command,before,after);
        // Save authenticated custody even if sign-out/holds arrived during HTTP. Display still rechecks scope/PIN.
        if(!"not_found".equals(result.getString("status")))synchronized(journal){SQLiteDatabase db=journal.getWritableDatabase();db.beginTransaction();try{NativeShiftCloseJournal.retain(journal,keys,r,envelope,nonce,before,after);db.setTransactionSuccessful();}finally{db.endTransaction();}}
        return result;
    }
    private void finishEmptySetup(NativeShiftCloseJournal.Request r)throws Exception{
        synchronized(session){Local l;try{l=local(r);}catch(Exception signedOut){return;}synchronized(journal){
            JSONObject outcome=NativeShiftCloseJournal.outcome(journal,keys,r);if(outcome==null||!"applied".equals(outcome.getString("status")))return;
            if(r.id.equals(l.value.optString("nativeShiftClosureId")))return;
            if(!canonical(l.value).equals(canonical(r.offline)))return;
            if(!l.value.isNull("reservation")||hasBundleForShift(r.shiftId))return;
            try{requireClear(l);requireRead(l);}catch(Exception held){return;}
            SQLiteDatabase db=journal.getWritableDatabase();db.beginTransaction();JSONObject next;try{next=NativeShiftCloseJournal.archiveSetup(journal,keys,r);db.setTransactionSuccessful();}finally{db.endTransaction();}
            if(!session.compareAndSetOffline(r.offline,next))throw fail("native_shift_close_uncertain");
        }}
    }
    private boolean hasBundleForShift(String shift)throws Exception{try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT id FROM offline_bundles",null)){NativeAllocationLifecycle lifecycle=new NativeAllocationLifecycle(journal,keys,deviceKey);while(c.moveToNext())if(lifecycle.bundle(c.getString(0)).shiftId.equals(shift))return true;return false;}}
    private void requireClear(Local l)throws Exception{
        if(l.shift==null)throw fail("offline_context_changed");JSONObject pending=l.value.optJSONObject("shiftRequest");if(pending!=null&&!l.value.getBoolean("shiftAcknowledged"))throw fail("offline_preparation_uncertain");
        synchronized(journal){
            try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT id FROM native_shift_close_requests WHERE shift_id<>?",new String[]{l.shift})){while(c.moveToNext()){NativeShiftCloseJournal.Request r=NativeShiftCloseJournal.read(journal,c.getString(0));JSONObject outcome=NativeShiftCloseJournal.outcome(journal,keys,r);if(outcome==null||!"applied".equals(outcome.getString("status")))throw fail("native_shift_close_pending");}}
            NativeAllocationLifecycle lifecycle=new NativeAllocationLifecycle(journal,keys,deviceKey);lifecycle.requireClear();
            JSONObject reservation=l.value.optJSONObject("reservation");if(reservation!=null){OfflineBundle b=lifecycle.bundle(reservation.getString("requestId"));if(!b.shiftId.equals(l.shift))throw fail("offline_context_changed");lifecycle.requireCandidate(b.authorityId);}
        }
    }
    private void authenticate(Local l,char[] pin)throws Exception{try{if(l.pin){if(pin==null)throw fail("pin_unlock_required");unlock.unlock(l.binding,pin);}else{if(pin!=null)throw fail("offline_context_changed");}}finally{wipe(pin);}}
    private boolean readAllowed(Local l)throws Exception{if(!l.pin)return true;try{unlock.requireUnlocked(l.binding);return true;}catch(Exception locked){return false;}}
    private void requireRead(Local l)throws Exception{if(l.pin)unlock.requireUnlocked(l.binding);}
    private void localCheck(Local l)throws Exception{Local now=local(null);same(l,now);}
    private void same(Local a,Local b)throws Exception{if(!canonical(a.value).equals(canonical(b.value))||!canonical(a.scope).equals(canonical(b.scope)))throw fail("offline_context_changed");}
    private void checked(String shift,String command,boolean retry,long epoch)throws Exception{if(epoch!=lifecycleEpoch.get()){clearCheck();return;}checkedShift=shift;checkedCommand=command;checkedRetry=retry;checkedReady=!retry;checkedAt=clock.read();checkedEpoch=epoch;}
    private boolean fresh(String shift,String command)throws Exception{if(checkedAt==null||checkedEpoch!=lifecycleEpoch.get()||!shift.equals(checkedShift)||!(command==null?checkedCommand==null:command.equals(checkedCommand)))return false;OfflineClock.Reading now=clock.read();return now.bootId.equals(checkedAt.bootId)&&now.elapsedRealtimeMs>=checkedAt.elapsedRealtimeMs&&now.elapsedRealtimeMs-checkedAt.elapsedRealtimeMs<=30000&&now.wallTimeMs>=checkedAt.wallTimeMs&&Math.abs((now.wallTimeMs-checkedAt.wallTimeMs)-(now.elapsedRealtimeMs-checkedAt.elapsedRealtimeMs))<=OfflineClock.MAX_DRIFT_MS;}
    private void requireEpoch(long epoch)throws NativeAccessError{if(epoch!=lifecycleEpoch.get())throw fail("native_shift_close_uncertain");}
    private void clearCheck(){checkedAt=null;checkedReady=false;checkedRetry=false;checkedShift=null;checkedCommand=null;}
    private static String canonical(Object o)throws Exception{return NativeShiftCloseJournal.canonical(o);}
    private static String envelope(JSONObject o)throws Exception{if(o.length()!=1||!(o.get("handoff") instanceof JSONObject))throw fail("offline_context_changed");return o.getJSONObject("handoff").toString();}
    private static String nonce(){byte[] value=new byte[32];new SecureRandom().nextBytes(value);StringBuilder text=new StringBuilder();for(byte b:value)text.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return text.toString();}
    private static JSONObject display(String status,String shift,String command,boolean pin,boolean close,boolean retry,String reason,Object counted,JSONObject result)throws Exception{return new JSONObject().put("schemaVersion",1).put("status",status).put("shiftId",shift==null?JSONObject.NULL:shift).put("commandId",command==null?JSONObject.NULL:command).put("countedCashFils",counted==null?JSONObject.NULL:counted).put("result",result==null?JSONObject.NULL:result).put("pinRequired",pin).put("canClose",close).put("canRetry",retry).put("reasonCode",reason==null?JSONObject.NULL:reason);}
    private static String code(Exception e){String c=e instanceof NativeAccessError?((NativeAccessError)e).code:e.getMessage();return Arrays.asList("pin_recovery_pending","offline_allocation_active","payment_reconciliation_required","offline_upload_required","shift_close_unavailable","shift_already_closed","offline_preparation_uncertain","native_shift_close_uncertain","native_session_expired","offline_context_changed","native_storage_unavailable","pin_unlock_required","offline_not_configured","shift_close_cancelled","native_shift_close_pending").contains(c)?c:"native_storage_unavailable";}
    private static void wipe(char[] pin){if(pin!=null)Arrays.fill(pin,'\0');}
    private static NativeAccessError fail(String code){return new NativeAccessError(code);}
}
