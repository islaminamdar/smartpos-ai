package info.internext.pos.storage;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.SystemClock;
import android.provider.Settings;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.NativeHandoff;
import info.internext.pos.offline.OfflineBundle;
import info.internext.pos.offline.OfflineClock;
import info.internext.pos.offline.SignedProtocol;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONObject;

/** Device-custody recovery of a persisted reservation whose signed bundle never arrived.
 * This is not preparation: even an unexpired bundle is atomically retained AND sealed.
 * It neither authenticates staff nor resets selling-clock/PIN state nor uploads the seal. */
public final class NativeBundleRecovery {
    interface Transport { JSONObject post(String path,JSONObject envelope)throws Exception; }
    interface ReadingSource { OfflineClock.Reading read()throws Exception; }
    private static final String PATH="/api/pos/offline/bundle-recovery";
    private final NativeJournal journal;
    private final NativeSession session;
    private final DeviceIdentity identity;
    private final Map<String,PublicKey> keys;
    private final Transport transport;
    private final ReadingSource readings;
    private final JSONObject deviceIdentity;
    private final PublicKey publicKey;
    private String lastNotice;

    public NativeBundleRecovery(Context context,NativeJournal journal,NativeSession session)throws Exception {
        this(journal,session,new DeviceIdentity(),NativeTrustKeys.load(context),session::historicalRequest,()->{
            try(NativeClockSource clock=new NativeClockSource(context,journal)){clock.requireNoRecovery();}
            int boot=Settings.Global.getInt(context.getContentResolver(),Settings.Global.BOOT_COUNT);
            return new OfflineClock.Reading(NativeClockSource.bootId(journal.installationId(),boot),SystemClock.elapsedRealtime(),System.currentTimeMillis());
        });
    }
    NativeBundleRecovery(NativeJournal journal,NativeSession session,DeviceIdentity identity,Map<String,PublicKey> keys,Transport transport,ReadingSource readings)throws Exception {
        this.journal=journal;this.session=session;this.identity=identity;
        this.keys=Collections.unmodifiableMap(new HashMap<>(keys));this.transport=transport;this.readings=readings;
        this.deviceIdentity=identity.readOrCreate(journal);
        this.publicKey=SignedProtocol.publicKey(SignedProtocol.decode(deviceIdentity.getString("publicKeySpkiBase64Url"),256));
    }
    public synchronized JSONObject getState()throws Exception {
        String authorityId=null;
        try {
            JSONObject state=session.nativeState(),offline=state.optJSONObject("offline");
            if(offline==null||offline.optJSONObject("reservation")==null)return display("not_needed",null,null);
            authorityId=uuid(offline.getJSONObject("reservation").getString("requestId"));
            OfflineBundle.Binding binding=binding(state,offline);
            if(keys.isEmpty())return display("blocked",authorityId,"offline_not_configured");
            synchronized(journal){
                NativeClockRetirement.requireNoPending(journal);
                SQLiteDatabase db=journal.getReadableDatabase();
                try(Cursor c=db.rawQuery("SELECT b.snapshot_envelope,b.authority_envelope,s.seal_envelope,s.blocked FROM offline_bundles b LEFT JOIN offline_authority_state s ON s.authority_id=b.id WHERE b.id=?",new String[]{authorityId})){
                    if(c.moveToFirst()){
                        OfflineBundle bundle=OfflineBundle.verify(c.getString(0),c.getString(1),keys,binding);
                        if(!authorityId.equals(bundle.authorityId)||c.isNull(3))throw fail("native_storage_unavailable");
                        if(!c.isNull(2)){
                            JSONObject seal=(JSONObject)SignedProtocol.verify(c.getString(2),Collections.singletonMap(deviceIdentity.getString("deviceKeySha256"),publicKey)).payload();
                            if(!"offline-seal".equals(seal.getString("kind"))||!authorityId.equals(seal.getString("authorityId"))||!binding.keyEpoch.equals(seal.getString("keyEpoch"))||!binding.deviceId.equals(seal.getString("deviceId")))throw fail("native_storage_unavailable");
                            return display("retained",authorityId,null);
                        }
                        return display(c.getInt(3)==0?"not_needed":"blocked",authorityId,c.getInt(3)==0?"offline_allocation_active":"offline_context_changed");
                    }
                }
                if(NativeCheckoutEngine.hasUncertainPayments(journal,keys,publicKey))return display("blocked",authorityId,"payment_reconciliation_required");
                if(exists(db,"SELECT 1 FROM offline_authority_state WHERE seal_envelope IS NULL"))return display("blocked",authorityId,"previous_authority_unresolved");
                try(Cursor c=db.rawQuery("SELECT id FROM offline_bundles",null)){while(c.moveToNext())new NativeAllocationLifecycle(journal,keys,publicKey).sealHash(c.getString(0),false);}
                try(Cursor c=db.rawQuery("SELECT key_epoch FROM offline_chain WHERE slot=1",null)){
                    if(c.moveToFirst()){
                        if(!binding.keyEpoch.equals(c.getString(0)))return display("blocked",authorityId,"offline_context_changed");
                    }else if(exists(db,"SELECT 1 FROM receipts"))return display("blocked",authorityId,"previous_authority_unresolved");
                }
            }
            return display("available",authorityId,lastNotice);
        }catch(NativeAccessError error){return display("blocked",authorityId,error.code);}
        catch(Exception error){return display("blocked",authorityId,"native_storage_unavailable");}
    }
    public synchronized JSONObject recover(String authorityId)throws Exception {
        uuid(authorityId);
        JSONObject current=getState();
        if(!authorityId.equals(current.optString("authorityId")))throw fail("offline_context_changed");
        if("retained".equals(current.getString("status")))return current;
        if(!current.getBoolean("canRecover"))throw fail(current.isNull("reasonCode")?"offline_context_changed":current.getString("reasonCode"));
        JSONObject state=session.nativeState(),offline=state.getJSONObject("offline");
        if(!authorityId.equals(uuid(offline.getJSONObject("reservation").getString("requestId"))))throw fail("offline_context_changed");
        OfflineBundle.Binding binding=binding(state,offline);
        byte[] original=CanonicalJson.bytes(offline);
        try {
            String challenge=challenge();
            JSONObject proof=new JSONObject().put("kind","offline-bundle-recovery").put("schemaVersion",1)
                .put("authorityId",authorityId).put("keyEpoch",binding.keyEpoch).put("deviceId",binding.deviceId).put("challenge",challenge);
            OfflineClock.Reading before=readings.read();
            JSONObject response=transport.post(PATH,sign(proof));
            OfflineClock.Reading after=readings.read();
            if(response==null||response.length()!=3||!response.has("snapshotEnvelope")||!response.has("authorityEnvelope")||!response.has("handoff"))throw fail("offline_context_changed");
            String snapshot=response.getJSONObject("snapshotEnvelope").toString(),authority=response.getJSONObject("authorityEnvelope").toString();
            OfflineBundle bundle=OfflineBundle.verify(snapshot,authority,keys,binding);
            NativeHandoff.Recovered recovered=NativeHandoff.verifyRecovered(response.getJSONObject("handoff").toString(),keys,challenge,binding,authorityId,bundle,before,after);
            // Session -> journal is the same lock order as custody reads. Recheck retained
            // reservation under this lock so a stale response cannot install in a new scope.
            synchronized(session){
                JSONObject latest=session.nativeState(),retained=latest.getJSONObject("offline");
                binding(latest,retained);
                if(!Arrays.equals(original,CanonicalJson.bytes(retained)))throw fail("offline_context_changed");
                NativeCheckoutEngine engine=new NativeCheckoutEngine(journal,keys,binding,publicKey,
                    ignored->{throw fail("pin_unlock_required");},()->{throw fail("clock_source_blocked");},identity::sign);
                engine.retainRecoveredUnusedBundle(snapshot,authority,recovered.freshTimeMs,after);
            }
            lastNotice=null;return getState();
        }catch(Exception error){lastNotice="offline_recovery_uncertain";throw fail("offline_recovery_uncertain");}
    }
    private OfflineBundle.Binding binding(JSONObject state,JSONObject offline)throws Exception {
        JSONObject scope=offline.getJSONObject("scope"),counter=state.getJSONObject("counter"),reservation=offline.getJSONObject("reservation");
        if(!counter.getString("actorId").equals(scope.getString("actorId"))||!counter.getString("id").equals(scope.getString("deviceId"))||!counter.getString("branchId").equals(scope.getString("branchId"))
            ||!reservation.getString("deviceId").equals(scope.getString("deviceId"))||!reservation.getString("branchId").equals(scope.getString("branchId"))||!reservation.getString("shiftId").equals(offline.getString("shiftId")))throw fail("offline_context_changed");
        // The retained actor is historical scope, not a claim that the current user is signed in.
        return new OfflineBundle.Binding(uuid(scope.getString("organizationId")),uuid(scope.getString("branchId")),uuid(scope.getString("deviceId")),uuid(scope.getString("actorId")),uuid(offline.getString("shiftId")),uuid(offline.getString("keyEpoch")),deviceIdentity.getString("deviceKeySha256"));
    }
    private JSONObject sign(JSONObject payload)throws Exception {
        byte[] bytes=CanonicalJson.bytes(payload),signature=identity.sign(bytes);SignedProtocol.requireDer(signature);
        JSONObject envelope=new JSONObject().put("format","pos-signed-v1").put("alg","ECDSA-P256-SHA256-DER").put("keyId",deviceIdentity.getString("deviceKeySha256"))
            .put("payloadBase64Url",SignedProtocol.encode(bytes)).put("signatureBase64Url",SignedProtocol.encode(signature));
        SignedProtocol.verify(envelope.toString(),Collections.singletonMap(deviceIdentity.getString("deviceKeySha256"),publicKey));return envelope;
    }
    private static JSONObject display(String status,String id,String reason)throws Exception {
        return new JSONObject().put("schemaVersion",1).put("status",status).put("authorityId",id==null?JSONObject.NULL:id).put("reasonCode",reason==null?JSONObject.NULL:reason).put("canRecover","available".equals(status));
    }
    private static boolean exists(SQLiteDatabase db,String sql){try(Cursor c=db.rawQuery(sql,null)){return c.moveToFirst();}}
    private static String uuid(String value)throws Exception {if(value==null||!value.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))throw fail("offline_context_changed");return value;}
    private static String challenge(){byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);StringBuilder value=new StringBuilder(64);for(byte b:bytes)value.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return value.toString();}
    private static NativeAccessError fail(String code){return new NativeAccessError(code);}
}
