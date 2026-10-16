package info.internext.pos.storage;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.NativeShiftCloseProof;
import info.internext.pos.offline.OfflineClock;
import info.internext.pos.offline.SignedProtocol;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.util.Map;
import org.json.JSONObject;

/** Append-only drawer-close custody. No fiscal/payment row or preparation pointer is removed. */
final class NativeShiftCloseJournal {
    static void createTables(SQLiteDatabase db){
        db.execSQL("CREATE TABLE native_shift_close_requests (id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),shift_id TEXT UNIQUE NOT NULL CHECK(length(shift_id)=36),scope_json TEXT NOT NULL,scope_sha256 TEXT NOT NULL CHECK(length(scope_sha256)=64),command_json TEXT NOT NULL,command_sha256 TEXT NOT NULL CHECK(length(command_sha256)=64),offline_json TEXT NOT NULL,offline_sha256 TEXT NOT NULL CHECK(length(offline_sha256)=64),pin_required INTEGER NOT NULL CHECK(pin_required IN(0,1)))");
        db.execSQL("CREATE TABLE native_shift_close_outcomes (command_id TEXT PRIMARY KEY NOT NULL REFERENCES native_shift_close_requests(id),envelope TEXT NOT NULL,payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),challenge TEXT NOT NULL CHECK(length(challenge)=64),before_json TEXT NOT NULL,after_json TEXT NOT NULL)");
        db.execSQL("CREATE TABLE native_shift_close_setup_transitions (command_id TEXT PRIMARY KEY NOT NULL REFERENCES native_shift_close_outcomes(command_id),previous_json TEXT NOT NULL,previous_sha256 TEXT NOT NULL CHECK(length(previous_sha256)=64),next_json TEXT NOT NULL,next_sha256 TEXT NOT NULL CHECK(length(next_sha256)=64),outcome_sha256 TEXT NOT NULL CHECK(length(outcome_sha256)=64))");
        for(String table:new String[]{"native_shift_close_requests","native_shift_close_outcomes","native_shift_close_setup_transitions"}){
            db.execSQL("CREATE TRIGGER "+table+"_update BEFORE UPDATE ON "+table+" BEGIN SELECT RAISE(ABORT,'immutable_shift_close'); END");
            db.execSQL("CREATE TRIGGER "+table+"_delete BEFORE DELETE ON "+table+" BEGIN SELECT RAISE(ABORT,'immutable_shift_close'); END");
            String duplicate=table.equals("native_shift_close_requests")?"id=NEW.id OR shift_id=NEW.shift_id":"command_id=NEW.command_id";
            db.execSQL("CREATE TRIGGER "+table+"_replace BEFORE INSERT ON "+table+" WHEN EXISTS(SELECT 1 FROM "+table+" WHERE "+duplicate+") BEGIN SELECT RAISE(ABORT,'shift_close_exists'); END");
        }
    }
    static final class Request {
        final String id,shiftId,hash;final JSONObject scope,command,offline;final boolean pinRequired;
        Request(String id,String shift,String hash,JSONObject scope,JSONObject command,JSONObject offline,boolean pin){this.id=id;shiftId=shift;this.hash=hash;this.scope=scope;this.command=command;this.offline=offline;pinRequired=pin;}
    }
    static Request read(NativeJournal j,String id)throws Exception{
        try(Cursor c=j.getReadableDatabase().rawQuery("SELECT id,shift_id,scope_json,scope_sha256,command_json,command_sha256,offline_json,offline_sha256,pin_required FROM native_shift_close_requests WHERE id=?",new String[]{id})){
            if(!c.moveToFirst())return null;JSONObject scope=checked(c.getString(2),c.getString(3)),command=checked(c.getString(4),c.getString(5)),offline=checked(c.getString(6),c.getString(7));NativeShiftCloseProof.command(command);
            if(scope.length()!=5||!c.getString(0).equals(command.getString("id"))||!c.getString(1).equals(command.getString("shiftId"))||!scope.getString("shiftId").equals(command.getString("shiftId"))||!scope.getString("branchId").equals(command.getString("branchId"))||!scope.getString("deviceId").equals(command.getString("deviceId")))throw fail();
            JSONObject saved=offline.getJSONObject("scope");for(String k:new String[]{"actorId","organizationId","branchId","deviceId"})if(!scope.getString(k).equals(saved.getString(k)))throw fail();if(!scope.getString("shiftId").equals(offline.getString("shiftId")))throw fail();
            return new Request(c.getString(0),c.getString(1),c.getString(5),scope,command,offline,c.getInt(8)==1);
        }
    }
    static Request forShift(NativeJournal j,String shift)throws Exception{try(Cursor c=j.getReadableDatabase().rawQuery("SELECT id FROM native_shift_close_requests WHERE shift_id=?",new String[]{shift})){return c.moveToFirst()?read(j,c.getString(0)):null;}}
    static Request latest(NativeJournal j)throws Exception{try(Cursor c=j.getReadableDatabase().rawQuery("SELECT id FROM native_shift_close_requests ORDER BY rowid DESC LIMIT 1",null)){return c.moveToFirst()?read(j,c.getString(0)):null;}}
    static Request insert(NativeJournal j,JSONObject scope,JSONObject command,JSONObject offline,boolean pin)throws Exception{
        NativeShiftCloseProof.command(command);ContentValues v=new ContentValues();v.put("id",command.getString("id"));v.put("shift_id",command.getString("shiftId"));put(v,"scope",scope);put(v,"command",command);put(v,"offline",offline);v.put("pin_required",pin?1:0);j.getWritableDatabase().insertOrThrow("native_shift_close_requests",null,v);return read(j,command.getString("id"));
    }
    static JSONObject outcome(NativeJournal j,Map<String,PublicKey> keys,Request r)throws Exception{
        try(Cursor c=j.getReadableDatabase().rawQuery("SELECT envelope,payload_sha256,challenge,before_json,after_json FROM native_shift_close_outcomes WHERE command_id=?",new String[]{r.id})){
            if(!c.moveToFirst())return null;JSONObject p=NativeShiftCloseProof.result(c.getString(0),keys,c.getString(2),r.scope,r.command,reading(c.getString(3)),reading(c.getString(4)));
            if(!SignedProtocol.hash(CanonicalJson.bytes(p)).equals(c.getString(1))||"not_found".equals(p.getString("status")))throw fail();return p;
        }
    }
    static void retain(NativeJournal j,Map<String,PublicKey> keys,Request r,String envelope,String challenge,OfflineClock.Reading before,OfflineClock.Reading after)throws Exception{
        JSONObject p=NativeShiftCloseProof.result(envelope,keys,challenge,r.scope,r.command,before,after);if("not_found".equals(p.getString("status")))throw fail();JSONObject old=outcome(j,keys,r);
        if(old!=null){if(!old.getString("status").equals(p.getString("status"))||!canonical(old.get("result")).equals(canonical(p.get("result"))))throw fail();return;}
        ContentValues v=new ContentValues();v.put("command_id",r.id);v.put("envelope",envelope);v.put("payload_sha256",SignedProtocol.hash(CanonicalJson.bytes(p)));v.put("challenge",challenge);v.put("before_json",reading(before));v.put("after_json",reading(after));j.getWritableDatabase().insertOrThrow("native_shift_close_outcomes",null,v);
    }
    static void requireNoPending(NativeJournal j,Map<String,PublicKey> keys)throws Exception{
        synchronized(j){try(Cursor c=j.getReadableDatabase().rawQuery("SELECT id FROM native_shift_close_requests",null)){while(c.moveToNext()){Request r=read(j,c.getString(0));JSONObject p=outcome(j,keys,r);if(p==null||!"applied".equals(p.getString("status")))throw new IllegalStateException("native_shift_close_pending");}}}
    }
    static void requireNoCloseForShift(SQLiteDatabase db,String shift){try(Cursor c=db.rawQuery("SELECT 1 FROM native_shift_close_requests WHERE shift_id=?",new String[]{shift})){if(c.moveToFirst())throw new IllegalStateException("native_shift_close_pending");}}
    static JSONObject closedSetup(JSONObject previous,String commandId)throws Exception{
        if(!previous.isNull("reservation")||(!previous.isNull("shiftRequest")&&!previous.getBoolean("shiftAcknowledged")))throw fail();return parse(canonical(previous)).put("shiftId",JSONObject.NULL).put("shiftRequest",JSONObject.NULL).put("shiftAcknowledged",false).put("nativeShiftClosureId",commandId);
    }
    static JSONObject setupTransition(NativeJournal j,Map<String,PublicKey> keys,Request r)throws Exception{
        try(Cursor c=j.getReadableDatabase().rawQuery("SELECT previous_json,previous_sha256,next_json,next_sha256,outcome_sha256 FROM native_shift_close_setup_transitions WHERE command_id=?",new String[]{r.id})){
            if(!c.moveToFirst())return null;JSONObject previous=checked(c.getString(0),c.getString(1)),next=checked(c.getString(2),c.getString(3)),outcome=outcome(j,keys,r);
            if(outcome==null||!"applied".equals(outcome.getString("status"))||!SignedProtocol.hash(CanonicalJson.bytes(outcome)).equals(c.getString(4))||!canonical(previous).equals(canonical(r.offline))||!canonical(next).equals(canonical(closedSetup(previous,r.id))))throw fail();return next;
        }
    }
    static JSONObject archiveSetup(NativeJournal j,Map<String,PublicKey> keys,Request r)throws Exception{
        JSONObject saved=setupTransition(j,keys,r);if(saved!=null)return saved;JSONObject outcome=outcome(j,keys,r);if(outcome==null||!"applied".equals(outcome.getString("status")))throw fail();JSONObject next=closedSetup(r.offline,r.id);ContentValues v=new ContentValues();v.put("command_id",r.id);put(v,"previous",r.offline);put(v,"next",next);v.put("outcome_sha256",SignedProtocol.hash(CanonicalJson.bytes(outcome)));j.getWritableDatabase().insertOrThrow("native_shift_close_setup_transitions",null,v);return setupTransition(j,keys,r);
    }
    static String canonical(Object o)throws Exception{return new String(CanonicalJson.bytes(o),StandardCharsets.UTF_8);}
    private static void put(ContentValues v,String prefix,JSONObject o)throws Exception{String raw=canonical(o);v.put(prefix+"_json",raw);v.put(prefix+"_sha256",NativeJournal.hash(raw));}
    private static JSONObject checked(String raw,String hash)throws Exception{if(!NativeJournal.hash(raw).equals(hash))throw fail();JSONObject o=parse(raw);if(!canonical(o).equals(raw))throw fail();return o;}
    private static JSONObject parse(String raw)throws Exception{return (JSONObject)CanonicalJson.parse(raw.getBytes(StandardCharsets.UTF_8));}
    static String reading(OfflineClock.Reading r)throws Exception{return canonical(new JSONObject().put("bootId",r.bootId).put("elapsedRealtimeMs",r.elapsedRealtimeMs).put("wallTimeMs",r.wallTimeMs));}
    private static OfflineClock.Reading reading(String raw)throws Exception{JSONObject r=parse(raw);if(r.length()!=3)throw fail();return new OfflineClock.Reading(r.getString("bootId"),NativeShiftCloseProof.integer(r,"elapsedRealtimeMs",0,9007199254740991L),NativeShiftCloseProof.integer(r,"wallTimeMs",0,OfflineClock.MAX_TIME_MS));}
    private static IllegalStateException fail(){return new IllegalStateException("native_storage_unavailable");}
}
