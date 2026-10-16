package info.internext.pos.storage;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.OfflineBundle;
import info.internext.pos.offline.SignedProtocol;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.util.Collections;
import java.util.Map;

/** Read-only historical checks shared by preparation transitions and new-bundle installation. */
final class NativeAllocationLifecycle {
    private final NativeJournal journal;private final Map<String,PublicKey> keys;private final PublicKey device;
    NativeAllocationLifecycle(NativeJournal journal,Map<String,PublicKey> keys,PublicKey device){this.journal=journal;this.keys=keys;this.device=device;}
    OfflineBundle bundle(String id)throws Exception{
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT snapshot_envelope,authority_envelope FROM offline_bundles WHERE id=?",new String[]{id})){
            if(!c.moveToFirst())throw failure("offline_preparation_uncertain");
            JSONObject a=(JSONObject)SignedProtocol.verify(c.getString(1),keys).payload();
            OfflineBundle.Binding binding=new OfflineBundle.Binding(a.getString("organizationId"),a.getString("branchId"),a.getString("deviceId"),a.getString("actorId"),a.getString("shiftId"),a.getString("keyEpoch"),SignedProtocol.fingerprint(device));
            OfflineBundle b=OfflineBundle.verify(c.getString(0),c.getString(1),keys,binding);if(!id.equals(b.authorityId))throw failure("native_storage_unavailable");return b;
        }
    }
    static OfflineBundle.Binding binding(OfflineBundle b){return new OfflineBundle.Binding(b.organizationId,b.branchId,b.deviceId,b.actorId,b.shiftId,b.keyEpoch,b.deviceKeySha256);}
    String sealHash(String id,boolean confirmed)throws Exception{
        OfflineBundle b=bundle(id);
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT s.seal_envelope,s.blocked,c.seal_payload_hash,c.response_json FROM offline_authority_state s LEFT JOIN offline_seal_confirmations c ON c.authority_id=s.authority_id WHERE s.authority_id=?",new String[]{id})){
            if(!c.moveToFirst())throw failure("native_storage_unavailable");if(c.getInt(1)!=0&&!NativeClockRetirement.retired(journal,id,keys,device))throw failure("previous_authority_unresolved");if(c.isNull(0))throw failure("offline_allocation_active");
            SignedProtocol.Verified signed=SignedProtocol.verify(c.getString(0),Collections.singletonMap(SignedProtocol.fingerprint(device),device));JSONObject p=(JSONObject)signed.payload();
            fields(p,"kind","schemaVersion","id","authorityId","keyEpoch","deviceId","finalSequence","finalEventSha256");
            if(!"offline-seal".equals(p.get("kind"))||integer(p,"schemaVersion")!=1||!id.equals(p.get("authorityId"))||!b.deviceId.equals(p.get("deviceId"))||!b.keyEpoch.equals(p.get("keyEpoch")))throw failure("native_storage_unavailable");uuid(p.getString("id"));long seq=integer(p,"finalSequence");Object hash=p.get("finalEventSha256");if((seq==0)!=(hash==JSONObject.NULL)||(hash!=JSONObject.NULL&&(!(hash instanceof String)||!((String)hash).matches("[a-f0-9]{64}"))))throw failure("native_storage_unavailable");
            if(confirmed){
                if(c.isNull(2)||c.isNull(3))throw failure("offline_seal_confirmation_required");if(!signed.payloadSha256.equals(c.getString(2)))throw failure("native_storage_unavailable");
                JSONObject response=(JSONObject)CanonicalJson.parse(c.getString(3).getBytes(StandardCharsets.UTF_8));fields(response,"status","authorityId","finalSequence","finalEventSha256");
                if(!"sealed".equals(response.get("status"))||!id.equals(response.get("authorityId"))||seq!=integer(response,"finalSequence")||!hash.equals(response.get("finalEventSha256")))throw failure("native_storage_unavailable");
            }
            return signed.payloadSha256;
        }
    }
    void requireCandidate(String prior)throws Exception{
        requireClear();OfflineBundle candidate=bundle(prior);
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT id FROM offline_bundles",null)){
            while(c.moveToNext()){OfflineBundle other=bundle(c.getString(0));if(!other.authorityId.equals(prior)&&other.firstInvoice>=candidate.firstInvoice)throw failure("offline_context_changed");}
        }
        requireHead(prior);
    }
    private void requireHead(String id)throws Exception{
        OfflineBundle b=bundle(id);JSONObject p;
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT seal_envelope FROM offline_authority_state WHERE authority_id=?",new String[]{id})){
            if(!c.moveToFirst()||c.isNull(0))throw failure("offline_allocation_active");p=(JSONObject)SignedProtocol.verify(c.getString(0),Collections.singletonMap(SignedProtocol.fingerprint(device),device)).payload();
        }
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT key_epoch,sequence,event_hash FROM offline_chain WHERE slot=1",null)){
            if(!c.moveToFirst()||!b.keyEpoch.equals(c.getString(0))||c.getLong(1)!=integer(p,"finalSequence")||!(c.isNull(2)?JSONObject.NULL:c.getString(2)).equals(p.get("finalEventSha256")))throw failure("offline_context_changed");
        }
    }
    void requireNewRange(OfflineBundle next)throws Exception{
        String latest=null;long latestFirst=-1;
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT id FROM offline_bundles",null)){
            while(c.moveToNext()){OfflineBundle prior=bundle(c.getString(0));if(next.firstInvoice<=prior.lastInvoice)throw failure("offline_context_changed");if(prior.firstInvoice>latestFirst){latestFirst=prior.firstInvoice;latest=prior.authorityId;}}
        }
        if(latest!=null)requireHead(latest);
    }
    void requireClear()throws Exception{
        NativeClockRetirement.requireNoPending(journal);
        SQLiteDatabase db=journal.getReadableDatabase();
        if(exists(db,"SELECT 1 FROM outbox"))throw failure("offline_upload_required");
        if(NativeCheckoutEngine.hasUncertainPayments(journal,keys,device))throw failure("payment_reconciliation_required");
        try(Cursor c=db.rawQuery("SELECT id FROM offline_bundles ORDER BY rowid",null)){while(c.moveToNext())sealHash(c.getString(0),true);}
        // An empty outbox alone is not proof of server receipt custody.
        try(Cursor c=db.rawQuery("SELECT r.id,r.envelope_json,r.envelope_hash,r.payload_hash,a.ack_json FROM receipts r LEFT JOIN acknowledgements a ON a.receipt_id=r.id",null)){
            while(c.moveToNext()){
                if(c.isNull(4))throw failure("offline_upload_required");String raw=c.getString(1);
                SignedProtocol.Verified issued=SignedProtocol.verify(raw,Collections.singletonMap(SignedProtocol.fingerprint(device),device));JSONObject p=(JSONObject)issued.payload();
                if(!NativeJournal.hash(raw).equals(c.getString(2))||!issued.payloadSha256.equals(c.getString(3))||!c.getString(0).equals(p.get("id"))||!"offline-sale".equals(p.get("kind")))throw failure("native_storage_unavailable");
                OfflineBundle b=bundle(p.getString("authorityId"));JSONObject a=(JSONObject)SignedProtocol.verify(c.getString(4),keys).payload();
                fields(a,"kind","schemaVersion","id","issuanceId","payloadSha256","authorityId","keyEpoch","deviceSequence","receivedAt");uuid(a.getString("id"));NativeCheckoutEngine.strictIso(a.getString("receivedAt"));
                if(!b.authoritySha256.equals(p.get("authoritySha256"))||!b.snapshotSha256.equals(p.get("snapshotSha256")))throw failure("native_storage_unavailable");
                if(!"offline-ack".equals(a.get("kind"))||integer(a,"schemaVersion")!=1||!c.getString(0).equals(a.get("issuanceId"))||!issued.payloadSha256.equals(a.get("payloadSha256"))||!b.authorityId.equals(a.get("authorityId"))||!b.keyEpoch.equals(a.get("keyEpoch"))||integer(p,"deviceSequence")!=integer(a,"deviceSequence"))throw failure("native_storage_unavailable");
            }
        }
    }
    private static boolean exists(SQLiteDatabase db,String sql){try(Cursor c=db.rawQuery(sql,null)){return c.moveToFirst();}}
    private static void fields(JSONObject o,String...names){if(o.length()!=names.length)throw failure("native_storage_unavailable");for(String n:names)if(!o.has(n))throw failure("native_storage_unavailable");}
    private static void uuid(String s){if(!s.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))throw failure("native_storage_unavailable");}
    private static long integer(JSONObject o,String key)throws Exception{Object n=o.get(key);if(!(n instanceof Long)&&!(n instanceof Integer))throw failure("native_storage_unavailable");long v=((Number)n).longValue();if(v<0||v>9007199254740991L)throw failure("native_storage_unavailable");return v;}
    private static IllegalStateException failure(String code){return new IllegalStateException(code);}
}
