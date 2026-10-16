package info.internext.pos.storage;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.NativeClockRecoveryProof;
import info.internext.pos.offline.OfflineBundle;
import info.internext.pos.offline.SignedProtocol;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/** Immutable financial-side fences. A retirement never deletes a grant or clears a payment hold. */
final class NativeClockRetirement {
    private NativeClockRetirement(){}
    static void createTables(SQLiteDatabase db){
        db.execSQL("CREATE TABLE native_clock_holds(id TEXT PRIMARY KEY NOT NULL,proof TEXT NOT NULL,manifest TEXT NOT NULL)");
        db.execSQL("CREATE TABLE native_clock_retirements(id TEXT PRIMARY KEY NOT NULL REFERENCES native_clock_holds(id),approval TEXT NOT NULL)");
        db.execSQL("CREATE TABLE native_clock_completions(id TEXT PRIMARY KEY NOT NULL REFERENCES native_clock_retirements(id))");
        for(String table:new String[]{"native_clock_holds","native_clock_retirements","native_clock_completions"}){
            for(String op:new String[]{"UPDATE","DELETE"})db.execSQL("CREATE TRIGGER "+table+"_immutable_"+op+" BEFORE "+op+" ON "+table+" BEGIN SELECT RAISE(ABORT,'immutable_clock_custody'); END");
            db.execSQL("CREATE TRIGGER "+table+"_no_replace BEFORE INSERT ON "+table+" WHEN EXISTS(SELECT 1 FROM "+table+" WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'clock_custody_exists'); END");
        }
    }
    static JSONObject manifest(NativeJournal journal,JSONObject saved,Map<String,PublicKey> keys,PublicKey device)throws Exception{
        JSONArray installed=new JSONArray();NativeAllocationLifecycle lifecycle=new NativeAllocationLifecycle(journal,keys,device);
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT id FROM offline_bundles ORDER BY id",null)){
            while(c.moveToNext()){OfflineBundle b=lifecycle.bundle(c.getString(0));installed.put(new JSONObject().put("authorityId",b.authorityId).put("snapshotSha256",b.snapshotSha256).put("authoritySha256",b.authoritySha256));}
        }
        return new JSONObject().put("schemaVersion",1).put("installed",installed).put("pendingReservation",saved==null||saved.optJSONObject("reservation")==null?JSONObject.NULL:new JSONObject(saved.getJSONObject("reservation").toString()));
    }
    static void stage(NativeJournal journal,JSONObject record)throws Exception{
        SQLiteDatabase db=journal.getWritableDatabase();String id=record.getString("requestId"),proof=record.getString("proof"),manifest=canonical(record.getJSONObject("manifest"));
        try(Cursor c=db.rawQuery("SELECT proof,manifest FROM native_clock_holds WHERE id=?",new String[]{id})){if(c.moveToFirst()){if(!proof.equals(c.getString(0))||!manifest.equals(c.getString(1)))throw fail();return;}}
        requireNoPending(journal);ContentValues v=new ContentValues();v.put("id",id);v.put("proof",proof);v.put("manifest",manifest);db.insertOrThrow("native_clock_holds",null,v);
    }
    static void retire(NativeJournal journal,JSONObject record,Map<String,PublicKey> keys,PublicKey device)throws Exception{
        NativeClockSource.verify(record,record.getString("approval"),keys,device);
        SQLiteDatabase db=journal.getWritableDatabase();db.beginTransaction();try{
            stage(journal,record);String id=record.getString("requestId");
            try(Cursor c=db.rawQuery("SELECT approval FROM native_clock_retirements WHERE id=?",new String[]{id})){
                if(c.moveToFirst()){if(!NativeClockRecoveryProof.payloadHash(record.getString("approval")).equals(NativeClockRecoveryProof.payloadHash(c.getString(0))))throw fail();db.setTransactionSuccessful();return;}
            }
            JSONObject manifest=record.getJSONObject("manifest");if(!NativeJournal.hash(canonical(manifest)).equals(record.getJSONObject("core").getString("retirementSha256")))throw fail();
            JSONArray bundles=manifest.getJSONArray("installed");
            for(int i=0;i<bundles.length();i++){
                JSONObject entry=bundles.getJSONObject(i);OfflineBundle b=new NativeAllocationLifecycle(journal,keys,device).bundle(entry.getString("authorityId"));
                if(!b.snapshotSha256.equals(entry.getString("snapshotSha256"))||!b.authoritySha256.equals(entry.getString("authoritySha256")))throw fail();
                ContentValues update=new ContentValues();update.put("blocked",1);if(db.update("offline_authority_state",update,"authority_id=?",new String[]{b.authorityId})!=1)throw fail();
            }
            // Nothing may have installed after the durable pending hold was staged.
            try(Cursor c=db.rawQuery("SELECT count(*) FROM offline_bundles",null)){if(!c.moveToFirst()||c.getInt(0)!=bundles.length())throw fail();}
            ContentValues v=new ContentValues();v.put("id",id);v.put("approval",record.getString("approval"));db.insertOrThrow("native_clock_retirements",null,v);db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    static void complete(NativeJournal journal,JSONObject applied,Map<String,PublicKey> keys,PublicKey device)throws Exception{
        if(!applied.getBoolean("applied"))throw fail();NativeClockSource.verify(applied,applied.getString("approval"),keys,device);
        String id=applied.getString("requestId");SQLiteDatabase db=journal.getWritableDatabase();
        try(Cursor c=db.rawQuery("SELECT approval FROM native_clock_retirements WHERE id=?",new String[]{id})){if(!c.moveToFirst()||!NativeClockRecoveryProof.payloadHash(c.getString(0)).equals(NativeClockRecoveryProof.payloadHash(applied.getString("approval"))))throw fail();}
        if(!incomplete(journal,id))return;ContentValues v=new ContentValues();v.put("id",id);db.insertOrThrow("native_clock_completions",null,v);
    }
    static boolean incomplete(NativeJournal journal,String id){try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT 1 FROM native_clock_holds h LEFT JOIN native_clock_completions c ON c.id=h.id WHERE h.id=? AND c.id IS NULL",new String[]{id})){return c.moveToFirst();}}
    static void requireNoPending(NativeJournal journal){try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT 1 FROM native_clock_holds h LEFT JOIN native_clock_completions c ON c.id=h.id WHERE c.id IS NULL LIMIT 1",null)){if(c.moveToFirst())throw new IllegalStateException("clock_recovery_pending");}}
    static boolean retired(NativeJournal journal,String authorityId,Map<String,PublicKey> keys,PublicKey device)throws Exception{
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT h.proof,h.manifest,r.approval FROM native_clock_holds h JOIN native_clock_retirements r ON r.id=h.id ORDER BY h.rowid",null)){
            while(c.moveToNext()){
                JSONObject proof=NativeClockRecoveryProof.request(c.getString(0),java.util.Collections.singletonMap(SignedProtocol.fingerprint(device),device));
                NativeClockRecoveryProof.approval(c.getString(2),keys,proof,NativeClockRecoveryProof.payloadHash(c.getString(0)));
                if(!NativeJournal.hash(c.getString(1)).equals(proof.getString("retirementSha256"))||!journal.installationId().equals(proof.getString("installationId")))throw fail();
                JSONObject m=(JSONObject)CanonicalJson.parse(c.getString(1).getBytes(StandardCharsets.UTF_8));JSONArray all=m.getJSONArray("installed");
                for(int i=0;i<all.length();i++)if(authorityId.equals(all.getJSONObject(i).getString("authorityId"))){OfflineBundle b=new NativeAllocationLifecycle(journal,keys,device).bundle(authorityId);if(!b.authoritySha256.equals(all.getJSONObject(i).getString("authoritySha256"))||!b.snapshotSha256.equals(all.getJSONObject(i).getString("snapshotSha256")))throw fail();return true;}
                JSONObject pending=m.optJSONObject("pendingReservation");if(pending!=null&&authorityId.equals(pending.getString("requestId")))return true;
            }
        }return false;
    }
    static String canonical(JSONObject value)throws Exception{return new String(CanonicalJson.bytes(value),StandardCharsets.UTF_8);}
    private static IllegalStateException fail(){return new IllegalStateException("clock_recovery_conflict");}
}
