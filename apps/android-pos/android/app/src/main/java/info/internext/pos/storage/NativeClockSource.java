package info.internext.pos.storage;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.SystemClock;
import android.provider.Settings;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.OfflineClock;
import info.internext.pos.offline.SignedProtocol;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.security.PublicKey;
import java.util.Map;
import java.util.Collections;
import info.internext.pos.offline.NativeClockRecoveryProof;

/** Native OS readings with authenticated persistent high-water marks. BOOT_COUNT is
 * an OS signal, not tamper-proof hardware time. A detected rollback is latched; neither
 * restarting the app nor moving wall time forward silently resets it. */
public final class NativeClockSource implements NativeCheckoutEngine.ClockSource,AutoCloseable {
    static final String DATABASE="internext-pos-clock-v1.db";
    static final String KEY_PREFIX="internext.pos.clock.v1.";
    interface ObservationSource { Observation sample() throws Exception; }
    static final class Observation {
        final int bootCount;final long elapsedMs,wallMs;
        Observation(int bootCount,long elapsedMs,long wallMs) { this.bootCount=bootCount;this.elapsedMs=elapsedMs;this.wallMs=wallMs; }
    }
    private final String installationId;
    private final NativeSecurityKey key;
    private final ObservationSource os;
    private final Store store;

    NativeClockSource(Context context,NativeJournal journal) throws Exception {
        this(context,journal,DATABASE,KEY_PREFIX+journal.installationId(),()->new Observation(
            Settings.Global.getInt(context.getContentResolver(),Settings.Global.BOOT_COUNT),SystemClock.elapsedRealtime(),System.currentTimeMillis()));
    }
    // Package-private isolated instrumentation seam; never exposed by a WebView method.
    NativeClockSource(Context context,NativeJournal journal,String database,String alias,ObservationSource source) throws Exception {
        installationId=journal.installationId();if(source==null)throw failure("clock_source_unavailable");os=source;
        boolean existing=context.getDatabasePath(database).exists();
        key=new NativeSecurityKey(alias,existing,!journal.hasCustody());
        store=new Store(context,database);
        try { store.getWritableDatabase(); } catch(Exception e) { store.close();throw e; }
    }
    private final class Store extends SQLiteOpenHelper {
        Store(Context c,String name) { super(c,name,null,2);setWriteAheadLoggingEnabled(true); }
        @Override public void onConfigure(SQLiteDatabase db) { db.execSQL("PRAGMA synchronous=FULL"); }
        @Override public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE clock_state(slot INTEGER PRIMARY KEY CHECK(slot=1),payload TEXT NOT NULL,mac TEXT NOT NULL)");
            db.execSQL("CREATE TRIGGER clock_no_delete BEFORE DELETE ON clock_state BEGIN SELECT RAISE(ABORT,'clock_custody_delete'); END");
            db.execSQL("CREATE TRIGGER clock_no_replace BEFORE INSERT ON clock_state WHEN EXISTS(SELECT 1 FROM clock_state) BEGIN SELECT RAISE(ABORT,'clock_custody_replace'); END");
            try { Observation now=checked(os.sample());JSONObject state=state(now,false,0);ContentValues row=values(state);row.put("slot",1);db.insertOrThrow("clock_state",null,row); }
            catch(Exception e) { throw failure("clock_source_unavailable"); }
            recoveryTables(db);
        }
        @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion) {
            if(oldVersion!=1||newVersion!=2)throw failure("clock_migration_required");
            try { JSONObject old=load(db);old.put("schemaVersion",2).put("generation",0);if(db.update("clock_state",values(old),"slot=1",null)!=1)throw failure("clock_state_missing");recoveryTables(db); }
            catch(Exception e){throw failure("clock_state_invalid");}
        }
    }
    @Override public synchronized OfflineClock.Reading read() throws Exception {
        SQLiteDatabase db=store.getWritableDatabase();db.beginTransaction();String failure=null;OfflineClock.Reading result=null;
        try {
            JSONObject old=load(db);
            requireNoRecovery(db);
            if(old.getBoolean("blocked"))throw failure("clock_source_blocked");
            Observation now=null;
            try { now=checked(os.sample()); } catch(Exception error) { failure="clock_source_unavailable"; }
            if(now!=null) {
                int boot=old.getInt("bootCount");
                if(now.bootCount<boot||now.wallMs<old.getLong("wallMs")||(now.bootCount==boot&&now.elapsedMs<old.getLong("elapsedMs")))failure="clock_rollback";
            }
            JSONObject next;
            if(failure!=null) {next=old;next.put("blocked",true);}
            else {next=state(now,false,old.getLong("generation"));result=new OfflineClock.Reading(bootId(installationId,now.bootCount,old.getLong("generation")),now.elapsedMs,now.wallMs);}
            if(db.update("clock_state",values(next),"slot=1",null)!=1)throw failure("clock_state_missing");
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        if(failure!=null)throw failure(failure);return result;
    }
    private JSONObject load(SQLiteDatabase db) throws Exception {
        try(Cursor c=db.rawQuery("SELECT payload,mac FROM clock_state WHERE slot=1",null)) {
            if(!c.moveToFirst())throw failure("clock_state_missing");
            byte[] bytes=c.getString(0).getBytes(StandardCharsets.UTF_8);
            if(!key.verify("clock-state-v1",bytes,SignedProtocol.decode(c.getString(1),32)))throw failure("clock_state_invalid");
            Object parsed=CanonicalJson.parse(bytes);if(!(parsed instanceof JSONObject))throw failure("clock_state_invalid");JSONObject state=(JSONObject)parsed;
            long version=state.getLong("schemaVersion");
            if((version==1?state.length()!=6:version!=2||state.length()!=7)||!installationId.equals(state.getString("installationId"))||!(state.get("blocked") instanceof Boolean))throw failure("clock_state_invalid");
            if(version==1)state.put("generation",0);Object g=state.get("generation");if(!(g instanceof Integer)&&!(g instanceof Long)||state.getLong("generation")<0||state.getLong("generation")>9_007_199_254_740_991L)throw failure("clock_state_invalid");
            checked(new Observation(state.getInt("bootCount"),state.getLong("elapsedMs"),state.getLong("wallMs")));return state;
        }
    }
    private JSONObject state(Observation now,boolean blocked,long generation) throws Exception { return new JSONObject().put("schemaVersion",2).put("generation",generation).put("installationId",installationId).put("bootCount",now.bootCount).put("elapsedMs",now.elapsedMs).put("wallMs",now.wallMs).put("blocked",blocked); }
    private ContentValues values(JSONObject state) throws Exception {
        byte[] bytes=CanonicalJson.bytes(state);ContentValues row=new ContentValues();row.put("payload",new String(bytes,StandardCharsets.UTF_8));row.put("mac",SignedProtocol.encode(key.mac("clock-state-v1",bytes)));return row;
    }
    private static Observation checked(Observation now) {
        if(now==null||now.bootCount<0||now.elapsedMs<0||now.elapsedMs>9_007_199_254_740_991L||now.wallMs<0||now.wallMs>OfflineClock.MAX_TIME_MS)throw failure("clock_source_unavailable");return now;
    }
    static String bootId(String installationId,int bootCount) {
        if(installationId==null||!UUID.fromString(installationId).toString().equals(installationId)||bootCount<0)throw failure("clock_source_unavailable");
        return UUID.nameUUIDFromBytes(("internext-pos-boot-v1:"+installationId+":"+bootCount).getBytes(StandardCharsets.UTF_8)).toString();
    }
    private static String bootId(String installation,int boot,long generation){return generation==0?bootId(installation,boot):UUID.nameUUIDFromBytes(("internext-pos-boot-v2:"+installation+":"+boot+":"+generation).getBytes(StandardCharsets.UTF_8)).toString();}
    private static void recoveryTables(SQLiteDatabase db){
        db.execSQL("CREATE TABLE clock_recoveries(id TEXT PRIMARY KEY NOT NULL,record TEXT NOT NULL,mac TEXT NOT NULL)");
        db.execSQL("CREATE TABLE clock_recovery_audits(id TEXT PRIMARY KEY NOT NULL,record TEXT NOT NULL,mac TEXT NOT NULL)");
        for(String table:new String[]{"clock_recoveries","clock_recovery_audits"}){
            db.execSQL("CREATE TRIGGER "+table+"_no_delete BEFORE DELETE ON "+table+" BEGIN SELECT RAISE(ABORT,'clock_custody_delete'); END");
            db.execSQL("CREATE TRIGGER "+table+"_no_replace BEFORE INSERT ON "+table+" WHEN EXISTS(SELECT 1 FROM "+table+" WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'clock_custody_replace'); END");
        }
        db.execSQL("CREATE TRIGGER clock_recovery_audits_no_update BEFORE UPDATE ON clock_recovery_audits BEGIN SELECT RAISE(ABORT,'immutable_clock_audit'); END");
    }
    synchronized void latchAuthorityAnomaly()throws Exception{SQLiteDatabase db=store.getWritableDatabase();JSONObject old=load(db);old.put("blocked",true);if(db.update("clock_state",values(old),"slot=1",null)!=1)throw failure("clock_state_missing");}
    synchronized JSONObject snapshot()throws Exception{return load(store.getReadableDatabase());}
    synchronized JSONObject recoveryPending()throws Exception{return pending(store.getReadableDatabase());}
    synchronized JSONObject recoveryLatest()throws Exception{
        try(Cursor c=store.getReadableDatabase().rawQuery("SELECT record,mac FROM clock_recoveries ORDER BY rowid DESC LIMIT 1",null)){return c.moveToFirst()?record(c):null;}
    }
    synchronized void requireNoRecovery()throws Exception{requireNoRecovery(store.getReadableDatabase());}
    private void requireNoRecovery(SQLiteDatabase db)throws Exception{if(pending(db)!=null)throw failure("clock_recovery_pending");}
    private JSONObject pending(SQLiteDatabase db)throws Exception{
        JSONObject result=null;try(Cursor c=db.rawQuery("SELECT record,mac FROM clock_recoveries ORDER BY rowid",null)){while(c.moveToNext()){JSONObject r=record(c);if(!r.getBoolean("applied")){if(result!=null)throw failure("clock_recovery_conflict");result=r;}}}return result;
    }
    private JSONObject record(Cursor c)throws Exception{
        byte[] bytes=c.getString(0).getBytes(StandardCharsets.UTF_8);if(!key.verify("clock-recovery-v1",bytes,SignedProtocol.decode(c.getString(1),32)))throw failure("clock_recovery_invalid");
        JSONObject r=(JSONObject)CanonicalJson.parse(bytes);if(r.length()!=7||!(r.get("applied") instanceof Boolean))throw failure("clock_recovery_invalid");
        NativeClockRecoveryProof.core(r.getJSONObject("core"));if(!r.getString("requestId").equals(r.getJSONObject("core").getString("requestId"))||!installationId.equals(r.getJSONObject("core").getString("installationId"))||!NativeJournal.hash(canonical(r.getJSONObject("manifest"))).equals(r.getJSONObject("core").getString("retirementSha256"))||!NativeJournal.hash(canonical(r.getJSONObject("oldState"))).equals(r.getJSONObject("core").getString("oldClockSha256")))throw failure("clock_recovery_invalid");return r;
    }
    private ContentValues recordValues(JSONObject r)throws Exception{byte[] bytes=CanonicalJson.bytes(r);ContentValues v=new ContentValues();v.put("record",new String(bytes,StandardCharsets.UTF_8));v.put("mac",SignedProtocol.encode(key.mac("clock-recovery-v1",bytes)));return v;}
    synchronized JSONObject recoveryStage(JSONObject core,JSONObject manifest,String proof)throws Exception{
        SQLiteDatabase db=store.getWritableDatabase();db.beginTransaction();try{
            requireNoRecovery(db);JSONObject old=load(db);if(!old.getBoolean("blocked"))throw failure("clock_healthy");if(old.getLong("generation")>=9_007_199_254_740_991L)throw failure("clock_signal_unavailable");
            if(!NativeJournal.hash(canonical(old)).equals(core.getString("oldClockSha256"))||old.getLong("generation")!=core.getLong("oldClockGeneration"))throw failure("clock_recovery_conflict");
            JSONObject r=new JSONObject().put("requestId",core.getString("requestId")).put("core",core).put("manifest",manifest).put("oldState",old).put("proof",proof).put("approval",JSONObject.NULL).put("applied",false);
            ContentValues v=recordValues(r);v.put("id",r.getString("requestId"));db.insertOrThrow("clock_recoveries",null,v);db.setTransactionSuccessful();return r;
        }finally{db.endTransaction();}
    }
    synchronized JSONObject recoveryAccept(String id,String approval,Map<String,PublicKey> keys,PublicKey device)throws Exception{
        SQLiteDatabase db=store.getWritableDatabase();db.beginTransaction();try{JSONObject r=pending(db);if(r==null||!id.equals(r.getString("requestId")))throw failure("clock_recovery_conflict");
            verify(r,approval,keys,device);if(!r.isNull("approval")){if(!NativeClockRecoveryProof.payloadHash(approval).equals(NativeClockRecoveryProof.payloadHash(r.getString("approval"))))throw failure("clock_recovery_conflict");}
            else{r.put("approval",approval);if(db.update("clock_recoveries",recordValues(r),"id=?",new String[]{id})!=1)throw failure("clock_recovery_invalid");}db.setTransactionSuccessful();return r;
        }finally{db.endTransaction();}
    }
    static JSONObject verify(JSONObject r,String approval,Map<String,PublicKey> keys,PublicKey device)throws Exception{
        JSONObject proof=NativeClockRecoveryProof.request(r.getString("proof"),Collections.singletonMap(SignedProtocol.fingerprint(device),device));
        if(!canonical(NativeClockRecoveryProof.core(proof)).equals(canonical(r.getJSONObject("core"))))throw failure("clock_recovery_invalid");
        return NativeClockRecoveryProof.approval(approval,keys,proof,NativeClockRecoveryProof.payloadHash(r.getString("proof")));
    }
    /** Only recovery can observe OS signals without advancing a blocked clock. It never tolerates
     * boot-counter or same-boot monotonic rollback, even when wall-clock rollback is repairable. */
    synchronized Observation recoveryProbe()throws Exception{
        JSONObject old=load(store.getReadableDatabase());if(!old.getBoolean("blocked")&&pending(store.getReadableDatabase())==null)throw failure("clock_healthy");
        Observation now=checked(os.sample());if(now.bootCount<old.getInt("bootCount")||now.bootCount==old.getInt("bootCount")&&now.elapsedMs<old.getLong("elapsedMs"))throw failure("clock_signal_unavailable");return now;
    }
    synchronized void recoveryApply(String id,String time,String challenge,Observation before,Map<String,PublicKey> keys,PublicKey device,java.util.function.BooleanSupplier active)throws Exception{
        SQLiteDatabase db=store.getWritableDatabase();db.beginTransaction();try{
            JSONObject r=pending(db);if(r==null||!id.equals(r.getString("requestId"))||r.isNull("approval"))throw failure("clock_recovery_conflict");verify(r,r.getString("approval"),keys,device);
            JSONObject old=load(db);if(!canonical(old).equals(canonical(r.getJSONObject("oldState"))))throw failure("clock_recovery_conflict");
            long server=NativeClockRecoveryProof.time(time,keys,r.getJSONObject("core"),NativeClockRecoveryProof.payloadHash(r.getString("approval")),challenge);
            Observation now=recoveryProbe();long rtt=now.elapsedMs-before.elapsedMs;
            if(now.bootCount!=before.bootCount||rtt<0||rtt>30000)throw failure("clock_recovery_interrupted");
            long estimated=Math.addExact(server,rtt);if(estimated>OfflineClock.MAX_TIME_MS||Math.abs(now.wallMs-estimated)>OfflineClock.MAX_DRIFT_MS)throw failure("clock_time_settings_required");
            if(!active.getAsBoolean())throw failure("clock_recovery_interrupted");
            JSONObject next=state(now,false,Math.addExact(old.getLong("generation"),1));
            JSONObject audit=new JSONObject().put("recovery",r).put("previous",old).put("replacement",next).put("time",time).put("challenge",challenge).put("elapsedStart",before.elapsedMs).put("elapsedEnd",now.elapsedMs);
            ContentValues a=recordValues(audit);a.put("id",id);db.insertOrThrow("clock_recovery_audits",null,a);
            if(db.update("clock_state",values(next),"slot=1",null)!=1)throw failure("clock_state_missing");r.put("applied",true);if(db.update("clock_recoveries",recordValues(r),"id=?",new String[]{id})!=1)throw failure("clock_recovery_invalid");db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    private static String canonical(JSONObject value)throws Exception{return new String(CanonicalJson.bytes(value),StandardCharsets.UTF_8);}
    @Override public synchronized void close() { store.close(); }
    private static IllegalStateException failure(String code) { return new IllegalStateException(code); }
}
