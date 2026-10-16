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
        Store(Context c,String name) { super(c,name,null,1);setWriteAheadLoggingEnabled(true); }
        @Override public void onConfigure(SQLiteDatabase db) { db.execSQL("PRAGMA synchronous=FULL"); }
        @Override public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE clock_state(slot INTEGER PRIMARY KEY CHECK(slot=1),payload TEXT NOT NULL,mac TEXT NOT NULL)");
            db.execSQL("CREATE TRIGGER clock_no_delete BEFORE DELETE ON clock_state BEGIN SELECT RAISE(ABORT,'clock_custody_delete'); END");
            db.execSQL("CREATE TRIGGER clock_no_replace BEFORE INSERT ON clock_state WHEN EXISTS(SELECT 1 FROM clock_state) BEGIN SELECT RAISE(ABORT,'clock_custody_replace'); END");
            try { Observation now=checked(os.sample());JSONObject state=state(now,false);ContentValues row=values(state);row.put("slot",1);db.insertOrThrow("clock_state",null,row); }
            catch(Exception e) { throw failure("clock_source_unavailable"); }
        }
        @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion) { throw failure("clock_migration_required"); }
    }
    @Override public synchronized OfflineClock.Reading read() throws Exception {
        SQLiteDatabase db=store.getWritableDatabase();db.beginTransaction();String failure=null;OfflineClock.Reading result=null;
        try {
            JSONObject old=load(db);
            if(old.getBoolean("blocked"))throw failure("clock_source_blocked");
            Observation now=null;
            try { now=checked(os.sample()); } catch(Exception error) { failure="clock_source_unavailable"; }
            if(now!=null) {
                int boot=old.getInt("bootCount");
                if(now.bootCount<boot||now.wallMs<old.getLong("wallMs")||(now.bootCount==boot&&now.elapsedMs<old.getLong("elapsedMs")))failure="clock_rollback";
            }
            JSONObject next;
            if(failure!=null) {next=old;next.put("blocked",true);}
            else {next=state(now,false);result=new OfflineClock.Reading(bootId(installationId,now.bootCount),now.elapsedMs,now.wallMs);}
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
            if(state.length()!=6||state.getLong("schemaVersion")!=1||!installationId.equals(state.getString("installationId"))||!(state.get("blocked") instanceof Boolean))throw failure("clock_state_invalid");
            checked(new Observation(state.getInt("bootCount"),state.getLong("elapsedMs"),state.getLong("wallMs")));return state;
        }
    }
    private JSONObject state(Observation now,boolean blocked) throws Exception { return new JSONObject().put("schemaVersion",1).put("installationId",installationId).put("bootCount",now.bootCount).put("elapsedMs",now.elapsedMs).put("wallMs",now.wallMs).put("blocked",blocked); }
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
    @Override public synchronized void close() { store.close(); }
    private static IllegalStateException failure(String code) { return new IllegalStateException(code); }
}
