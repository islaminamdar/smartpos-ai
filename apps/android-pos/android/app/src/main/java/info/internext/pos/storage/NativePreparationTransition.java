package info.internext.pos.storage;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.NativeContinuation;
import info.internext.pos.offline.OfflineBundle;
import info.internext.pos.offline.OfflineClock;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.util.Map;
import java.util.UUID;
import org.json.JSONObject;

/** Append-only preparation pointer transitions. Neither tokens nor PINs enter this ledger. */
final class NativePreparationTransition {
    final String id,priorAuthorityId;final JSONObject previous,next;final String nextShiftId;
    private NativePreparationTransition(String id,String prior,JSONObject previous,JSONObject next,String nextShift){this.id=id;priorAuthorityId=prior;this.previous=previous;this.next=next;nextShiftId=nextShift;}
    static void createTables(SQLiteDatabase db){
        db.execSQL("CREATE TABLE offline_preparation_transitions (prior_authority_id TEXT PRIMARY KEY NOT NULL REFERENCES offline_bundles(id),transition_id TEXT UNIQUE NOT NULL CHECK(length(transition_id)=36),previous_json TEXT NOT NULL,previous_sha256 TEXT NOT NULL CHECK(length(previous_sha256)=64),next_json TEXT NOT NULL,next_sha256 TEXT NOT NULL CHECK(length(next_sha256)=64),handoff_envelope TEXT NOT NULL,handoff_sha256 TEXT NOT NULL CHECK(length(handoff_sha256)=64),challenge TEXT NOT NULL CHECK(length(challenge)=64),before_json TEXT NOT NULL,after_json TEXT NOT NULL)");
        db.execSQL("CREATE TABLE offline_preparation_shift_closures (transition_id TEXT PRIMARY KEY NOT NULL REFERENCES offline_preparation_transitions(transition_id),previous_json TEXT NOT NULL,previous_sha256 TEXT NOT NULL,next_json TEXT NOT NULL,next_sha256 TEXT NOT NULL,handoff_envelope TEXT NOT NULL,handoff_sha256 TEXT NOT NULL,challenge TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL)");
        db.execSQL("CREATE TRIGGER offline_preparation_closure_update BEFORE UPDATE ON offline_preparation_shift_closures BEGIN SELECT RAISE(ABORT,'immutable_transition'); END");
        db.execSQL("CREATE TRIGGER offline_preparation_closure_delete BEFORE DELETE ON offline_preparation_shift_closures BEGIN SELECT RAISE(ABORT,'immutable_transition'); END");
        db.execSQL("CREATE TRIGGER offline_preparation_closure_insert BEFORE INSERT ON offline_preparation_shift_closures WHEN EXISTS(SELECT 1 FROM offline_preparation_shift_closures WHERE transition_id=NEW.transition_id) BEGIN SELECT RAISE(ABORT,'transition_conflict'); END");
        db.execSQL("CREATE TRIGGER offline_preparation_transition_update BEFORE UPDATE ON offline_preparation_transitions BEGIN SELECT RAISE(ABORT,'immutable_transition'); END");
        db.execSQL("CREATE TRIGGER offline_preparation_transition_delete BEFORE DELETE ON offline_preparation_transitions BEGIN SELECT RAISE(ABORT,'immutable_transition'); END");
        db.execSQL("CREATE TRIGGER offline_preparation_transition_insert BEFORE INSERT ON offline_preparation_transitions WHEN EXISTS(SELECT 1 FROM offline_preparation_transitions WHERE prior_authority_id=NEW.prior_authority_id OR transition_id=NEW.transition_id) OR NOT EXISTS(SELECT 1 FROM offline_authority_state s JOIN offline_seal_confirmations c ON c.authority_id=s.authority_id WHERE s.authority_id=NEW.prior_authority_id AND s.seal_envelope IS NOT NULL AND s.blocked=0) BEGIN SELECT RAISE(ABORT,'transition_conflict'); END");
    }
    static NativePreparationTransition read(NativeJournal journal,NativeAllocationLifecycle lifecycle,Map<String,PublicKey> keys,String prior)throws Exception{
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT transition_id,previous_json,previous_sha256,next_json,next_sha256,handoff_envelope,handoff_sha256,challenge,before_json,after_json FROM offline_preparation_transitions WHERE prior_authority_id=?",new String[]{prior})){
            if(!c.moveToFirst())return null;
            String id=c.getString(0);uuid(id);JSONObject previous=parse(c.getString(1)),next=parse(c.getString(3));
            if(!NativeJournal.hash(c.getString(1)).equals(c.getString(2))||!NativeJournal.hash(c.getString(3)).equals(c.getString(4)))throw invalid();
            OfflineBundle bundle=lifecycle.bundle(prior);String sealHash=lifecycle.sealHash(prior,true);
            NativeContinuation.Verified proof=NativeContinuation.verify(c.getString(5),keys,c.getString(7),NativeAllocationLifecycle.binding(bundle),prior,sealHash,reading(c.getString(8)),reading(c.getString(9)));
            if(!proof.payloadSha256.equals(c.getString(6))||!prior.equals(previous.getJSONObject("reservation").getString("requestId")))throw invalid();
            checkOriginal(previous,bundle);
            if(!canonical(next).equals(canonical(next(previous,id,proof.nextShiftId))))throw invalid();
            return new NativePreparationTransition(id,prior,previous,next,proof.nextShiftId);
        }
    }
    static NativePreparationTransition insert(NativeJournal journal,NativeAllocationLifecycle lifecycle,Map<String,PublicKey> keys,JSONObject previous,String envelope,String challenge,OfflineClock.Reading before,OfflineClock.Reading after)throws Exception{
        String prior=previous.getJSONObject("reservation").getString("requestId");OfflineBundle bundle=lifecycle.bundle(prior);checkOriginal(previous,bundle);
        NativeContinuation.Verified proof=NativeContinuation.verify(envelope,keys,challenge,NativeAllocationLifecycle.binding(bundle),prior,lifecycle.sealHash(prior,true),before,after);
        String id=UUID.randomUUID().toString();JSONObject next=next(previous,id,proof.nextShiftId);String oldText=canonical(previous),newText=canonical(next);
        ContentValues row=new ContentValues();row.put("prior_authority_id",prior);row.put("transition_id",id);row.put("previous_json",oldText);row.put("previous_sha256",NativeJournal.hash(oldText));row.put("next_json",newText);row.put("next_sha256",NativeJournal.hash(newText));row.put("handoff_envelope",envelope);row.put("handoff_sha256",proof.payloadSha256);row.put("challenge",challenge);row.put("before_json",reading(before));row.put("after_json",reading(after));journal.getWritableDatabase().insertOrThrow("offline_preparation_transitions",null,row);
        return read(journal,lifecycle,keys,prior);
    }
    static final class Closure {final JSONObject previous,next;Closure(JSONObject p,JSONObject n){previous=p;next=n;}}
    static Closure readClosure(NativeJournal journal,NativeAllocationLifecycle lifecycle,Map<String,PublicKey> keys,NativePreparationTransition t)throws Exception{
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT previous_json,previous_sha256,next_json,next_sha256,handoff_envelope,handoff_sha256,challenge,before_json,after_json FROM offline_preparation_shift_closures WHERE transition_id=?",new String[]{t.id})){
            if(!c.moveToFirst())return null;JSONObject previous=parse(c.getString(0)),next=parse(c.getString(2));
            if(!NativeJournal.hash(c.getString(0)).equals(c.getString(1))||!NativeJournal.hash(c.getString(2)).equals(c.getString(3)))throw invalid();
            OfflineBundle b=lifecycle.bundle(t.priorAuthorityId);NativeContinuation.Verified proof=NativeContinuation.verify(c.getString(4),keys,c.getString(6),NativeAllocationLifecycle.binding(b),t.priorAuthorityId,lifecycle.sealHash(t.priorAuthorityId,true),reading(c.getString(7)),reading(c.getString(8)));
            if(proof.nextShiftId!=null||!proof.payloadSha256.equals(c.getString(5))||!canonical(next).equals(canonical(closed(previous,t))))throw invalid();
            return new Closure(previous,next);
        }
    }
    static Closure insertClosure(NativeJournal journal,NativeAllocationLifecycle lifecycle,Map<String,PublicKey> keys,NativePreparationTransition t,JSONObject previous,String envelope,String challenge,OfflineClock.Reading before,OfflineClock.Reading after)throws Exception{
        OfflineBundle b=lifecycle.bundle(t.priorAuthorityId);NativeContinuation.Verified proof=NativeContinuation.verify(envelope,keys,challenge,NativeAllocationLifecycle.binding(b),t.priorAuthorityId,lifecycle.sealHash(t.priorAuthorityId,true),before,after);if(proof.nextShiftId!=null)throw invalid();
        String old=canonical(previous),next=canonical(closed(previous,t));ContentValues row=new ContentValues();row.put("transition_id",t.id);row.put("previous_json",old);row.put("previous_sha256",NativeJournal.hash(old));row.put("next_json",next);row.put("next_sha256",NativeJournal.hash(next));row.put("handoff_envelope",envelope);row.put("handoff_sha256",proof.payloadSha256);row.put("challenge",challenge);row.put("before_json",reading(before));row.put("after_json",reading(after));journal.getWritableDatabase().insertOrThrow("offline_preparation_shift_closures",null,row);return readClosure(journal,lifecycle,keys,t);
    }
    private static JSONObject closed(JSONObject previous,NativePreparationTransition t)throws Exception{
        if(t.nextShiftId==null||!t.nextShiftId.equals(previous.getString("shiftId"))||!previous.isNull("reservation")||!t.id.equals(previous.getString("preparationTransitionId"))||!canonical(t.previous.getJSONObject("scope")).equals(canonical(previous.getJSONObject("scope")))||!t.previous.getString("keyEpoch").equals(previous.getString("keyEpoch")))throw invalid();
        if(!previous.isNull("shiftRequest")&&!previous.getBoolean("shiftAcknowledged"))throw invalid();
        return parse(canonical(previous)).put("shiftId",JSONObject.NULL).put("shiftRequest",JSONObject.NULL).put("shiftAcknowledged",false).put("preparationClosureId",t.id);
    }
    static String priorForMarker(NativeJournal journal,String marker)throws Exception{
        uuid(marker);try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT prior_authority_id FROM offline_preparation_transitions WHERE transition_id=?",new String[]{marker})){if(!c.moveToFirst())throw invalid();return c.getString(0);}
    }
    static JSONObject next(JSONObject previous,String id,String nextShift)throws Exception{
        JSONObject value=parse(canonical(previous));value.remove("preparationClosureId");value.put("preparationTransitionId",id).put("reservation",JSONObject.NULL);
        if(nextShift==null)value.put("shiftId",JSONObject.NULL).put("shiftRequest",JSONObject.NULL).put("shiftAcknowledged",false);
        else if(!nextShift.equals(previous.getString("shiftId")))throw invalid();
        return value;
    }
    private static void checkOriginal(JSONObject state,OfflineBundle b)throws Exception{
        JSONObject s=state.getJSONObject("scope"),r=state.getJSONObject("reservation");
        if(!b.organizationId.equals(s.getString("organizationId"))||!b.branchId.equals(s.getString("branchId"))||!b.deviceId.equals(s.getString("deviceId"))||!b.actorId.equals(s.getString("actorId"))||!b.shiftId.equals(state.getString("shiftId"))||!b.keyEpoch.equals(state.getString("keyEpoch"))||!b.authorityId.equals(r.getString("requestId"))||!b.branchId.equals(r.getString("branchId"))||!b.deviceId.equals(r.getString("deviceId"))||!b.shiftId.equals(r.getString("shiftId")))throw invalid();
    }
    static String canonical(JSONObject o)throws Exception{return new String(CanonicalJson.bytes(o),StandardCharsets.UTF_8);}
    private static JSONObject parse(String raw)throws Exception{return (JSONObject)CanonicalJson.parse(raw.getBytes(StandardCharsets.UTF_8));}
    private static String reading(OfflineClock.Reading r)throws Exception{return canonical(new JSONObject().put("bootId",r.bootId).put("elapsedRealtimeMs",r.elapsedRealtimeMs).put("wallTimeMs",r.wallTimeMs));}
    private static OfflineClock.Reading reading(String raw)throws Exception{JSONObject r=parse(raw);if(r.length()!=3||!r.has("bootId")||!r.has("elapsedRealtimeMs")||!r.has("wallTimeMs"))throw invalid();if(!(r.get("bootId") instanceof String)||!(r.get("elapsedRealtimeMs") instanceof Long)||!(r.get("wallTimeMs") instanceof Long))throw invalid();return new OfflineClock.Reading(r.getString("bootId"),r.getLong("elapsedRealtimeMs"),r.getLong("wallTimeMs"));}
    private static void uuid(String id){if(id==null||!id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))throw invalid();}
    private static IllegalStateException invalid(){return new IllegalStateException("native_storage_unavailable");}
}
