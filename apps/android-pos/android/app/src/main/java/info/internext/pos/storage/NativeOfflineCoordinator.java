package info.internext.pos.storage;

import android.content.Context;
import android.database.Cursor;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.NativeHandoff;
import info.internext.pos.offline.OfflineBundle;
import info.internext.pos.offline.OfflineClock;
import info.internext.pos.offline.SignedProtocol;
import org.json.JSONArray;
import org.json.JSONObject;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Collections;
import java.util.Map;
import java.util.UUID;

/** Native preparation owner. It never exposes token/key/PIN input or offline sale issuance to JS.
 * Public state is display-only; every permission and monetary limit is verified natively. */
public final class NativeOfflineCoordinator implements AutoCloseable {
    private final NativeJournal journal;private final NativeSession session;private final DeviceIdentity identity;
    private final NativeClockSource clock;private final NativeStaffUnlock unlock;private final Map<String,PublicKey> keys;
    private final JSONObject deviceIdentity;private final PublicKey publicKey;
    public NativeOfflineCoordinator(Context context,NativeJournal journal,NativeSession session)throws Exception{
        this.journal=journal;this.session=session;this.identity=new DeviceIdentity();this.deviceIdentity=identity.readOrCreate(journal);
        this.publicKey=SignedProtocol.publicKey(SignedProtocol.decode(deviceIdentity.getString("publicKeySpkiBase64Url"),256));
        this.keys=NativeTrustKeys.load(context);this.clock=new NativeClockSource(context,journal);this.unlock=new NativeStaffUnlock(context,journal,clock);
    }
    NativeOfflineCoordinator(NativeJournal journal,NativeSession session,DeviceIdentity identity,NativeClockSource clock,NativeStaffUnlock unlock,Map<String,PublicKey> keys)throws Exception{
        this.journal=journal;this.session=session;this.identity=identity;this.clock=clock;this.unlock=unlock;this.keys=Collections.unmodifiableMap(new java.util.HashMap<>(keys));
        this.deviceIdentity=identity.readOrCreate(journal);this.publicKey=SignedProtocol.publicKey(SignedProtocol.decode(deviceIdentity.getString("publicKeySpkiBase64Url"),256));
    }
    public synchronized JSONObject getState()throws Exception{
        JSONObject state=session.nativeState(),offline=state.optJSONObject("offline");
        JSONObject display=new JSONObject().put("schemaVersion",1).put("status","not_prepared").put("stage","sign_in").put("canIssue",false).put("shiftId",JSONObject.NULL).put("authority",JSONObject.NULL).put("pinProvisioned",false).put("noticeCode",JSONObject.NULL).put("pendingAction",JSONObject.NULL).put("pendingOpeningCashFils",JSONObject.NULL);
        if(state.isNull("actorId")||state.getBoolean("logoutPending")){unlock.lock();return display;}
        if(state.isNull("counter"))return display.put("stage","enroll_counter");
        if(keys.isEmpty())return display.put("status","blocked").put("stage","recover").put("noticeCode","offline_not_configured");
        if(offline==null)return display.put("stage","prepare");
        checkStoredScope(state,offline);display.put("shiftId",offline.get("shiftId"));
        JSONObject shiftRequest=offline.optJSONObject("shiftRequest");
        if(shiftRequest!=null&&!offline.getBoolean("shiftAcknowledged"))return display.put("stage","recover").put("pendingAction","open_shift").put("pendingOpeningCashFils",shiftRequest.getLong("openingCashFils")).put("noticeCode","offline_preparation_uncertain");
        if(!offline.isNull("keyEpoch"))display.put("pinProvisioned",unlock.isProvisioned(binding(offline)));
        JSONObject reservation=offline.optJSONObject("reservation");
        if(reservation!=null){
            String authorityId=reservation.getString("requestId");OfflineBundle bundle=storedBundle(offline,authorityId);
            if(bundle==null)return display.put("stage","recover").put("pendingAction","prepare").put("noticeCode","offline_preparation_uncertain");
            display.put("authority",new JSONObject().put("id",authorityId).put("expiresAt",NativeCheckoutEngine.iso(bundle.expiresAtMs)).put("firstInvoice",bundle.firstInvoice).put("lastInvoice",bundle.lastInvoice));
            try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT clock_json,blocked,seal_envelope FROM offline_authority_state WHERE authority_id=?",new String[]{authorityId})){
                if(!c.moveToFirst())throw fail("native_storage_unavailable");
                if(c.getInt(1)!=0||!c.isNull(2))return display.put("status","blocked").put("stage","recover").put("noticeCode","offline_context_changed");
                try{OfflineClock.advance(OfflineClock.State.fromJson(c.getString(0)),clock.read(),bundle.notBeforeMs,bundle.expiresAtMs);}
                catch(Exception error){return display.put("status","blocked").put("stage","recover").put("noticeCode",error instanceof OfflineClock.ClockException&&((OfflineClock.ClockException)error).code.equals("clock_expired")?"offline_permission_expired":"clock_source_blocked");}
            }
            try{unlock.requireUnlocked(binding(offline));return display.put("status","prepared").put("stage","prepared");}
            catch(Exception error){return display.put("status","locked").put("stage","unlock").put("noticeCode","pin_unlock_required");}
        }
        if(offline.isNull("shiftId"))return display.put("stage","open_shift").put("noticeCode","offline_shift_required");
        if(offline.optJSONObject("enrollmentRequest")!=null&&offline.isNull("keyEpoch"))return display.put("stage","recover").put("pendingAction","prepare").put("noticeCode","offline_preparation_uncertain");
        return display.put("stage","prepare");
    }
    /** Native worker step before showing a PIN dialog. Does not reserve invoice numbers. */
    public synchronized JSONObject beginPreparation()throws Exception{
        JSONObject access=requireAccess(),offline=ensureScope(access);NativeHandoff.Context context=freshContext(offline);
        reconcileShift(offline,context.shiftId);session.saveOffline(offline);
        if(context.shiftId==null)return getState();
        JSONObject reservation=offline.optJSONObject("reservation");if(reservation!=null&&storedBundle(offline,reservation.getString("requestId"))!=null)return getState();
        if(offline.isNull("keyEpoch")){
            JSONObject request=offline.optJSONObject("enrollmentRequest");
            if(request==null){
                String requestId=UUID.randomUUID().toString();JSONObject scope=offline.getJSONObject("scope");
                JSONObject proof=new JSONObject().put("kind","offline-enrollment").put("schemaVersion",1).put("requestId",requestId).put("branchId",scope.getString("branchId")).put("deviceId",scope.getString("deviceId")).put("actorId",scope.getString("actorId")).put("deviceKeySha256",deviceIdentity.getString("deviceKeySha256")).put("issuedAt",NativeCheckoutEngine.iso(context.freshTimeMs));
                request=new JSONObject().put("requestId",requestId).put("branchId",scope.getString("branchId")).put("deviceId",scope.getString("deviceId")).put("publicKeySpki",deviceIdentity.getString("publicKeySpkiBase64Url")).put("deviceKeySha256",deviceIdentity.getString("deviceKeySha256")).put("proof",new JSONObject(sign(proof)));
                offline.put("enrollmentRequest",request);session.saveOffline(offline);
            }
            try{
                JSONObject result=session.nativeRequest("POST","/api/pos/offline/enroll",request);
                fields(result,"keyEpoch","deviceId","deviceKeySha256","publicKeySpki");uuid(result.getString("keyEpoch"));
                if(!request.getString("deviceId").equals(result.getString("deviceId"))||!request.getString("deviceKeySha256").equals(result.getString("deviceKeySha256"))||!request.getString("publicKeySpki").equals(result.getString("publicKeySpki")))throw fail("offline_context_changed");
                offline.put("keyEpoch",result.getString("keyEpoch"));session.saveOffline(offline);
            }catch(Exception error){throw fail("offline_preparation_uncertain");}
        }
        return getState();
    }
    /** Explicit native PIN confirmation. New PINs require matching confirmation; existing
     * PINs cannot be replaced. Password/PIN arrays are consumed on every path. */
    public synchronized JSONObject prepareWithPin(char[] pin,char[] confirmation)throws Exception{
        try{
            JSONObject access=requireAccess(),offline=ensureScope(access);OfflineBundle.Binding binding=binding(offline);
            if(!unlock.isProvisioned(binding)){
                if(pin==null||confirmation==null||!Arrays.equals(pin,confirmation))throw fail("pin_confirmation_mismatch");
                char[] provision=pin.clone();unlock.provisionVerifiedStaff(binding,provision);
            }
            unlock.unlock(binding,pin);pin=null;
            JSONObject reservation=offline.optJSONObject("reservation");
            if(reservation==null){
                reservation=new JSONObject().put("requestId",UUID.randomUUID().toString()).put("branchId",binding.branchId).put("deviceId",binding.deviceId).put("shiftId",binding.shiftId).put("count",100).put("lifetimeSeconds",28800).put("maxInvoiceTotalFils",1000000).put("maxGrossFils",10000000).put("permissions",new JSONObject().put("cash",true).put("recordedCard",true).put("mixedTender",true));
                offline.put("reservation",reservation);session.saveOffline(offline);
            }
            String challenge=challenge();OfflineClock.Reading before=clock.read();JSONObject response;
            try{response=session.nativeRequest("POST","/api/pos/native/prepare",new JSONObject().put("challenge",challenge).put("reservation",reservation));}
            catch(Exception error){unlock.lock();throw fail("offline_preparation_uncertain");}
            OfflineClock.Reading after=clock.read();fields(response,"snapshotEnvelope","authorityEnvelope","handoff");
            String snapshot=response.getJSONObject("snapshotEnvelope").toString(),authority=response.getJSONObject("authorityEnvelope").toString();
            OfflineBundle bundle=OfflineBundle.verify(snapshot,authority,keys,binding);
            NativeHandoff.Prepared prepared=NativeHandoff.verifyPrepared(response.getJSONObject("handoff").toString(),keys,challenge,binding,reservation.getString("requestId"),bundle,before,after);
            engine(binding).installVerifiedBundle(snapshot,authority,prepared.freshTimeMs,after);
            return getState();
        }catch(Exception error){unlock.lock();throw error;}finally{if(pin!=null)Arrays.fill(pin,'\0');if(confirmation!=null)Arrays.fill(confirmation,'\0');}
    }
    public synchronized JSONObject openShift(long openingCashFils)throws Exception{
        if(openingCashFils<0||openingCashFils>100000000)throw fail("native_access_unavailable");
        JSONObject access=requireAccess(),offline=ensureScope(access),request=offline.optJSONObject("shiftRequest");
        if(request!=null&&request.getLong("openingCashFils")!=openingCashFils)throw fail("offline_context_changed");
        NativeHandoff.Context context=freshContext(offline);
        if(request==null){
            if(context.shiftId!=null){reconcileShift(offline,context.shiftId);session.saveOffline(offline);return getState();}
            JSONObject scope=offline.getJSONObject("scope");request=new JSONObject().put("id",UUID.randomUUID().toString()).put("type","shift.open").put("branchId",scope.getString("branchId")).put("deviceId",scope.getString("deviceId")).put("shiftId",UUID.randomUUID().toString()).put("openingCashFils",openingCashFils);
            offline.put("shiftRequest",request).put("shiftAcknowledged",false);session.saveOffline(offline);
        }else if(context.shiftId!=null&&!context.shiftId.equals(request.getString("shiftId")))throw fail("offline_context_changed");
        try{
            JSONObject result=session.nativeRequest("POST","/api/pos/commands",new JSONObject().put("command",request));fields(result,"status","commandId","shiftId","replayed");
            if(!"applied".equals(result.getString("status"))||!request.getString("id").equals(result.getString("commandId"))||!request.getString("shiftId").equals(result.getString("shiftId"))||!(result.get("replayed") instanceof Boolean))throw fail("offline_context_changed");
            offline.put("shiftId",request.getString("shiftId")).put("shiftAcknowledged",true);session.saveOffline(offline);return getState();
        }catch(Exception error){throw fail("offline_preparation_uncertain");}
    }
    public synchronized JSONObject unlockWithPin(char[] pin)throws Exception{
        try{JSONObject state=session.nativeState(),offline=state.optJSONObject("offline");if(offline==null||state.isNull("actorId")||state.getBoolean("logoutPending"))throw fail("pin_unlock_required");checkStoredScope(state,offline);
            JSONObject reservation=offline.optJSONObject("reservation");if(reservation==null||storedBundle(offline,reservation.getString("requestId"))==null)throw fail("offline_preparation_uncertain");unlock.unlock(binding(offline),pin);pin=null;return getState();
        }finally{if(pin!=null)Arrays.fill(pin,'\0');}
    }
    public synchronized void lock(){unlock.lock();}
    @Override public synchronized void close(){unlock.close();clock.close();}
    private JSONObject requireAccess()throws Exception{
        if(keys.isEmpty())throw fail("offline_not_configured");JSONObject access=session.getAccessState();if(!"signed_in".equals(access.getString("status")))throw fail("native_session_expired");if(access.isNull("device"))throw fail("offline_context_changed");return access;
    }
    private JSONObject ensureScope(JSONObject access)throws Exception{
        JSONObject device=access.getJSONObject("device"),scope=null;JSONArray branches=access.getJSONArray("branches");for(int i=0;i<branches.length();i++){JSONObject branch=branches.getJSONObject(i);if(branch.getString("id").equals(device.getString("branchId")))scope=new JSONObject().put("actorId",access.getString("actorId")).put("organizationId",branch.getString("organizationId")).put("branchId",branch.getString("id")).put("deviceId",device.getString("id"));}
        if(scope==null)throw fail("offline_context_changed");JSONObject offline=session.nativeState().optJSONObject("offline");
        if(offline==null){offline=new JSONObject().put("scope",scope).put("shiftId",JSONObject.NULL).put("shiftRequest",JSONObject.NULL).put("shiftAcknowledged",false).put("enrollmentRequest",JSONObject.NULL).put("keyEpoch",JSONObject.NULL).put("reservation",JSONObject.NULL);session.saveOffline(offline);}
        else if(!Arrays.equals(CanonicalJson.bytes(scope),CanonicalJson.bytes(offline.getJSONObject("scope"))))throw fail("offline_context_changed");return offline;
    }
    private void checkStoredScope(JSONObject state,JSONObject offline)throws Exception{
        JSONObject counter=state.getJSONObject("counter"),scope=offline.getJSONObject("scope");
        if(!state.getString("actorId").equals(scope.getString("actorId"))||!counter.getString("actorId").equals(scope.getString("actorId"))||!counter.getString("id").equals(scope.getString("deviceId"))||!counter.getString("branchId").equals(scope.getString("branchId")))throw fail("offline_context_changed");
    }
    private NativeHandoff.Context freshContext(JSONObject offline)throws Exception{
        JSONObject scope=offline.getJSONObject("scope");String challenge=challenge();OfflineClock.Reading before=clock.read();JSONObject result=session.nativeRequest("POST","/api/pos/native/preparation",new JSONObject().put("challenge",challenge).put("branchId",scope.getString("branchId")).put("deviceId",scope.getString("deviceId")));OfflineClock.Reading after=clock.read();fields(result,"handoff");
        return NativeHandoff.verifyContext(result.getJSONObject("handoff").toString(),keys,challenge,new NativeHandoff.Scope(scope.getString("actorId"),scope.getString("organizationId"),scope.getString("branchId"),scope.getString("deviceId")),before,after);
    }
    private void reconcileShift(JSONObject offline,String shift)throws Exception{
        String prior=offline.isNull("shiftId")?null:offline.getString("shiftId");
        if(prior!=null&&!prior.equals(shift))throw fail("offline_context_changed");
        JSONObject pending=offline.optJSONObject("shiftRequest");if(pending!=null&&!offline.getBoolean("shiftAcknowledged")){if(shift!=null&&!shift.equals(pending.getString("shiftId")))throw fail("offline_context_changed");throw fail("offline_preparation_uncertain");}
        offline.put("shiftId",shift==null?JSONObject.NULL:shift);
    }
    private OfflineBundle.Binding binding(JSONObject offline)throws Exception{
        JSONObject scope=offline.getJSONObject("scope");return new OfflineBundle.Binding(scope.getString("organizationId"),scope.getString("branchId"),scope.getString("deviceId"),scope.getString("actorId"),offline.getString("shiftId"),offline.getString("keyEpoch"),deviceIdentity.getString("deviceKeySha256"));
    }
    private NativeCheckoutEngine engine(OfflineBundle.Binding binding)throws Exception{return new NativeCheckoutEngine(journal,keys,binding,publicKey,unlock,clock,identity::sign);}
    private OfflineBundle storedBundle(JSONObject offline,String authorityId)throws Exception{
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT snapshot_envelope,authority_envelope FROM offline_bundles WHERE id=?",new String[]{authorityId})){return c.moveToFirst()?OfflineBundle.verify(c.getString(0),c.getString(1),keys,binding(offline)):null;}
    }
    private String sign(JSONObject payload)throws Exception{byte[] bytes=CanonicalJson.bytes(payload),signature=identity.sign(bytes);SignedProtocol.requireDer(signature);String result=new JSONObject().put("format","pos-signed-v1").put("alg","ECDSA-P256-SHA256-DER").put("keyId",deviceIdentity.getString("deviceKeySha256")).put("payloadBase64Url",SignedProtocol.encode(bytes)).put("signatureBase64Url",SignedProtocol.encode(signature)).toString();SignedProtocol.verify(result,Collections.singletonMap(deviceIdentity.getString("deviceKeySha256"),publicKey));return result;}
    private static String challenge(){byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);StringBuilder value=new StringBuilder(64);for(byte b:bytes)value.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return value.toString();}
    private static void fields(JSONObject o,String... names)throws Exception{if(o.length()!=names.length)throw fail("offline_context_changed");for(String name:names)if(!o.has(name))throw fail("offline_context_changed");}
    private static void uuid(String id)throws Exception{if(!id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))throw fail("offline_context_changed");}
    private static NativeAccessError fail(String code){return new NativeAccessError(code);}
}
