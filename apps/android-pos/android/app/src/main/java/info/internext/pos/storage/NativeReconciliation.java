package info.internext.pos.storage;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.OfflineBundle;
import info.internext.pos.offline.SignedProtocol;
import org.json.JSONArray;
import org.json.JSONObject;
import java.security.PublicKey;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/** Historical evidence upload only. Never opens a shift, creates an intent, takes payment,
 * seals a new allocation, or changes current staff access. All retries are explicit. */
public final class NativeReconciliation {
    interface Transport { JSONObject post(String path,JSONObject envelope)throws Exception; }
    private final NativeJournal journal;
    private final Map<String,PublicKey> serverKeys,deviceKeys;
    private final PublicKey deviceKey;
    private final String fingerprint;
    private final Transport transport;
    private String lastNotice;
    public NativeReconciliation(Context context,NativeJournal journal,NativeSession session)throws Exception{
        this(journal,new DeviceIdentity(),NativeTrustKeys.load(context),session::historicalRequest);
    }
    NativeReconciliation(NativeJournal journal,DeviceIdentity identity,Map<String,PublicKey> keys,Transport transport)throws Exception{
        this.journal=journal;this.serverKeys=Collections.unmodifiableMap(new HashMap<>(keys));this.transport=transport;
        JSONObject key=identity.readOrCreate(journal);fingerprint=key.getString("deviceKeySha256");
        deviceKey=SignedProtocol.publicKey(SignedProtocol.decode(key.getString("publicKeySpkiBase64Url"),256));
        if(!fingerprint.equals(SignedProtocol.fingerprint(deviceKey)))throw invalid();
        deviceKeys=Collections.singletonMap(fingerprint,deviceKey);
    }
    static void createTables(SQLiteDatabase db){
        db.execSQL("CREATE TABLE offline_seal_confirmations (authority_id TEXT PRIMARY KEY NOT NULL REFERENCES offline_bundles(id), seal_payload_hash TEXT NOT NULL, response_json TEXT NOT NULL)");
        db.execSQL("CREATE TABLE offline_upload_exceptions (receipt_id TEXT NOT NULL REFERENCES receipts(id), exception_id TEXT NOT NULL, payload_hash TEXT NOT NULL, code TEXT NOT NULL, PRIMARY KEY(receipt_id,exception_id))");
        for(String table:new String[]{"offline_seal_confirmations","offline_upload_exceptions"}){
            db.execSQL("CREATE TRIGGER "+table+"_immutable_update BEFORE UPDATE ON "+table+" BEGIN SELECT RAISE(ABORT,'immutable_record'); END");
            db.execSQL("CREATE TRIGGER "+table+"_immutable_delete BEFORE DELETE ON "+table+" BEGIN SELECT RAISE(ABORT,'immutable_record'); END");
        }
        db.execSQL("CREATE TRIGGER offline_seal_confirmation_insert_guard BEFORE INSERT ON offline_seal_confirmations WHEN EXISTS(SELECT 1 FROM offline_seal_confirmations WHERE authority_id=NEW.authority_id) BEGIN SELECT RAISE(ABORT,'confirmation_exists'); END");
        db.execSQL("CREATE TRIGGER offline_upload_exception_insert_guard BEFORE INSERT ON offline_upload_exceptions WHEN EXISTS(SELECT 1 FROM offline_upload_exceptions WHERE receipt_id=NEW.receipt_id AND exception_id=NEW.exception_id) BEGIN SELECT RAISE(ABORT,'exception_exists'); END");
    }
    public synchronized JSONObject getState()throws Exception{
        synchronized(journal){
            SQLiteDatabase db=journal.getReadableDatabase();long pending=count(db,"SELECT count(*) FROM outbox"),unsealed=count(db,"SELECT count(*) FROM offline_authority_state WHERE seal_envelope IS NULL"),seals=count(db,"SELECT count(*) FROM offline_authority_state s LEFT JOIN offline_seal_confirmations c ON c.authority_id=s.authority_id WHERE s.seal_envelope IS NOT NULL AND c.authority_id IS NULL"),confirmed=count(db,"SELECT count(*) FROM offline_seal_confirmations");
            boolean attention=count(db,"SELECT count(*) FROM offline_upload_exceptions x JOIN outbox o ON o.receipt_id=x.receipt_id")>0||count(db,"SELECT count(*) FROM outbox o JOIN receipts r ON r.id=o.receipt_id LEFT JOIN offline_intent_context i ON i.intent_id=r.intent_id WHERE i.intent_id IS NULL")>0;
            String notice=attention?"offline_reconciliation_required":lastNotice;
            return new JSONObject().put("schemaVersion",1).put("pendingReceipts",pending).put("unsealedAuthorities",unsealed).put("pendingSeals",seals).put("confirmedSeals",confirmed).put("status",notice!=null?"attention":pending+unsealed+seals>0?"pending":"idle").put("noticeCode",notice==null?JSONObject.NULL:notice);
        }
    }
    /** Bounded foreground batch. Receipt chain first; no terminal declaration while uploads remain. */
    public synchronized JSONObject reconcile()throws Exception{
        lastNotice=null;
        JSONArray receipts=new JSONArray();
        synchronized(journal){try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT r.id,r.envelope_json,r.envelope_hash,r.payload_hash FROM receipts r JOIN outbox o ON o.receipt_id=r.id JOIN offline_intent_context i ON i.intent_id=r.intent_id ORDER BY r.rowid LIMIT 100",null)){
            while(c.moveToNext())receipts.put(new JSONObject().put("id",c.getString(0)).put("envelope",c.getString(1)).put("envelopeHash",c.getString(2)).put("payloadHash",c.getString(3)));
        }}
        for(int i=0;i<receipts.length();i++){
            JSONObject row=receipts.getJSONObject(i);
            try{
                String raw=row.getString("envelope");SignedProtocol.Verified proof=SignedProtocol.verify(raw,deviceKeys);JSONObject issued=(JSONObject)proof.payload();
                if(!NativeJournal.hash(raw).equals(row.getString("envelopeHash"))||!proof.payloadSha256.equals(row.getString("payloadHash"))||!row.getString("id").equals(issued.getString("id"))||!"offline-sale".equals(issued.getString("kind")))throw invalid();
                NativeCheckoutEngine engine=historicalEngine(issued.getString("authorityId"));
                JSONObject response=transport.post("/api/pos/offline/import",new JSONObject(raw));
                if("reconciliation_required".equals(response.optString("status"))){recordException(row.getString("id"),proof.payloadSha256,response);lastNotice="offline_reconciliation_required";return getState();}
                fields(response,"status","acknowledgement","receipt","replayed");
                if(!"accepted".equals(response.getString("status"))||!(response.get("replayed") instanceof Boolean)||!Arrays.equals(CanonicalJson.bytes(response.get("receipt")),CanonicalJson.bytes(issued.get("document"))))throw invalid();
                String acknowledgement=response.getJSONObject("acknowledgement").toString();
                JSONObject ack=(JSONObject)SignedProtocol.verify(acknowledgement,serverKeys).payload();
                if(!row.getString("id").equals(ack.getString("issuanceId"))||!proof.payloadSha256.equals(ack.getString("payloadSha256"))||!issued.getString("authorityId").equals(ack.getString("authorityId"))||integer(issued,"deviceSequence")!=integer(ack,"deviceSequence"))throw invalid();
                engine.acknowledgeIssuance(acknowledgement);
            }catch(Exception error){lastNotice="offline_upload_uncertain";return getState();}
        }
        JSONArray seals=new JSONArray();
        synchronized(journal){
            SQLiteDatabase db=journal.getReadableDatabase();if(count(db,"SELECT count(*) FROM outbox")>0)return getState();
            try(Cursor c=db.rawQuery("SELECT s.authority_id,s.seal_envelope FROM offline_authority_state s JOIN offline_bundles b ON b.id=s.authority_id LEFT JOIN offline_seal_confirmations c ON c.authority_id=s.authority_id WHERE s.seal_envelope IS NOT NULL AND c.authority_id IS NULL ORDER BY b.rowid LIMIT 100",null)){
                while(c.moveToNext())seals.put(new JSONObject().put("authorityId",c.getString(0)).put("envelope",c.getString(1)));
            }
        }
        for(int i=0;i<seals.length();i++){
            JSONObject row=seals.getJSONObject(i);
            try{
                String raw=row.getString("envelope");SignedProtocol.Verified proof=SignedProtocol.verify(raw,deviceKeys);JSONObject seal=(JSONObject)proof.payload();
                fields(seal,"kind","schemaVersion","id","authorityId","keyEpoch","deviceId","finalSequence","finalEventSha256");
                OfflineBundle bundle=historicalBundle(row.getString("authorityId"));
                if(!"offline-seal".equals(seal.getString("kind"))||integer(seal,"schemaVersion")!=1||!bundle.authorityId.equals(seal.getString("authorityId"))||!bundle.keyEpoch.equals(seal.getString("keyEpoch"))||!bundle.deviceId.equals(seal.getString("deviceId")))throw invalid();
                uuid(seal.getString("id"));long sequence=integer(seal,"finalSequence");Object hash=seal.get("finalEventSha256");if((sequence==0)!=(hash==JSONObject.NULL)||(hash!=JSONObject.NULL&&(!(hash instanceof String)||!((String)hash).matches("[a-f0-9]{64}"))))throw invalid();
                JSONObject response=transport.post("/api/pos/offline/seal",new JSONObject(raw));fields(response,"status","authorityId","finalSequence","finalEventSha256");
                if(!"sealed".equals(response.getString("status"))||!bundle.authorityId.equals(response.getString("authorityId"))||integer(response,"finalSequence")!=sequence||!hash.equals(response.get("finalEventSha256")))throw invalid();
                recordSealConfirmation(bundle.authorityId,proof.payloadSha256,response);
            }catch(Exception error){lastNotice="offline_seal_uncertain";return getState();}
        }
        return getState();
    }
    private NativeCheckoutEngine historicalEngine(String id)throws Exception{
        OfflineBundle b=historicalBundle(id);
        OfflineBundle.Binding binding=new OfflineBundle.Binding(b.organizationId,b.branchId,b.deviceId,b.actorId,b.shiftId,b.keyEpoch,b.deviceKeySha256);
        return new NativeCheckoutEngine(journal,serverKeys,binding,deviceKey,x->{throw invalid();},()->{throw invalid();},bytes->{throw invalid();});
    }
    private OfflineBundle historicalBundle(String id)throws Exception{
        uuid(id);synchronized(journal){try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT snapshot_envelope,authority_envelope FROM offline_bundles WHERE id=?",new String[]{id})){
            if(!c.moveToFirst())throw invalid();JSONObject a=(JSONObject)SignedProtocol.verify(c.getString(1),serverKeys).payload();
            OfflineBundle.Binding expected=new OfflineBundle.Binding(a.getString("organizationId"),a.getString("branchId"),a.getString("deviceId"),a.getString("actorId"),a.getString("shiftId"),a.getString("keyEpoch"),fingerprint);
            OfflineBundle bundle=OfflineBundle.verify(c.getString(0),c.getString(1),serverKeys,expected);if(!id.equals(bundle.authorityId))throw invalid();return bundle;
        }}
    }
    private void recordException(String receiptId,String payloadHash,JSONObject response)throws Exception{
        fields(response,"status","exceptionId","code");String id=response.getString("exceptionId"),code=response.getString("code");uuid(id);
        if(!Arrays.asList("bundle","collision","state","sealed","scope","time","chain","number","calculation","budget","payment","ack","storage_conflict","invalid_historical_receipt").contains(code))throw invalid();
        synchronized(journal){SQLiteDatabase db=journal.getWritableDatabase();db.beginTransaction();try{
            try(Cursor c=db.rawQuery("SELECT payload_hash,code FROM offline_upload_exceptions WHERE receipt_id=? AND exception_id=?",new String[]{receiptId,id})){
                if(c.moveToFirst()){if(!payloadHash.equals(c.getString(0))||!code.equals(c.getString(1)))throw invalid();db.setTransactionSuccessful();return;}
            }
            ContentValues row=new ContentValues();row.put("receipt_id",receiptId);row.put("exception_id",id);row.put("payload_hash",payloadHash);row.put("code",code);db.insertOrThrow("offline_upload_exceptions",null,row);db.setTransactionSuccessful();
        }finally{db.endTransaction();}}
    }
    private void recordSealConfirmation(String id,String hash,JSONObject response)throws Exception{
        String canonical=new String(CanonicalJson.bytes(response),java.nio.charset.StandardCharsets.UTF_8);
        synchronized(journal){SQLiteDatabase db=journal.getWritableDatabase();db.beginTransaction();try{
            try(Cursor c=db.rawQuery("SELECT seal_payload_hash,response_json FROM offline_seal_confirmations WHERE authority_id=?",new String[]{id})){
                if(c.moveToFirst()){if(!hash.equals(c.getString(0))||!canonical.equals(c.getString(1)))throw invalid();db.setTransactionSuccessful();return;}
            }
            ContentValues row=new ContentValues();row.put("authority_id",id);row.put("seal_payload_hash",hash);row.put("response_json",canonical);db.insertOrThrow("offline_seal_confirmations",null,row);db.setTransactionSuccessful();
        }finally{db.endTransaction();}}
    }
    private static long count(SQLiteDatabase db,String sql){try(Cursor c=db.rawQuery(sql,null)){if(!c.moveToFirst())throw invalid();return c.getLong(0);}}
    private static void fields(JSONObject value,String...names){if(value.length()!=names.length)throw invalid();for(String name:names)if(!value.has(name))throw invalid();}
    private static void uuid(String id){if(!id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))throw invalid();}
    private static long integer(JSONObject value,String key)throws Exception{Object raw=value.get(key);if(!(raw instanceof Integer)&&!(raw instanceof Long))throw invalid();long n=((Number)raw).longValue();if(n<0||n>9007199254740991L)throw invalid();return n;}
    private static IllegalStateException invalid(){return new IllegalStateException("native_storage_unavailable");}
}
