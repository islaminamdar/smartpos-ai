package info.internext.pos.storage;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.Build;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.OfflineBundle;
import info.internext.pos.offline.OfflineClock;
import info.internext.pos.offline.SignedProtocol;
import org.json.JSONObject;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/** Internal native PIN guard, never a web credential cache. Host must call provisioning
 * only after fresh verified native online identity/device authorization and native PIN
 * confirmation. No reset/delete API exists. All PIN arrays are consumed and wiped.
 * Call expensive PIN methods on the native worker, not the UI thread. */
public final class NativeStaffUnlock implements NativeCheckoutEngine.UnlockGuard,AutoCloseable {
    static final String DATABASE="internext-pos-local-auth-v1.db";
    static final String KEY_PREFIX="internext.pos.local-auth.v1.";
    static final int ITERATIONS=600_000,MAX_FAILURES=10;
    static final long LOCKOUT_MS=15*60_000L,SESSION_MS=5*60_000L;
    private final NativeJournal journal;
    private final NativeCheckoutEngine.ClockSource clock;
    private final NativeSecurityKey key;
    private final Store store;
    private final String installationId;
    private String sessionBinding,sessionScope,sessionBoot;
    private long sessionExpires,sessionRevision;

    NativeStaffUnlock(Context context,NativeJournal journal,NativeClockSource clock) throws Exception {
        this(context,journal,clock,DATABASE,KEY_PREFIX+journal.installationId());
    }
    // Package-private isolated test seam; native host is the trust boundary, never JS.
    NativeStaffUnlock(Context context,NativeJournal journal,NativeCheckoutEngine.ClockSource clock,String database,String alias) throws Exception {
        if(clock==null)throw failure("pin_clock_unavailable");this.journal=journal;this.clock=clock;installationId=journal.installationId();
        if(Build.VERSION.SDK_INT<26)throw failure("pin_kdf_unsupported");
        try { SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256"); } catch(Exception e) { throw failure("pin_kdf_unsupported"); }
        key=new NativeSecurityKey(alias,context.getDatabasePath(database).exists(),!journal.hasCustody());
        store=new Store(context,database);try {store.getWritableDatabase();}catch(Exception error){store.close();throw error;}
    }
    private final class Store extends SQLiteOpenHelper {
        Store(Context c,String name) {super(c,name,null,1);setWriteAheadLoggingEnabled(true);}
        @Override public void onConfigure(SQLiteDatabase db) {db.execSQL("PRAGMA synchronous=FULL");db.execSQL("PRAGMA recursive_triggers=ON");}
        @Override public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE auth_identity(slot INTEGER PRIMARY KEY CHECK(slot=1),installation TEXT NOT NULL,mac TEXT NOT NULL)");
            db.execSQL("CREATE TABLE credentials(scope TEXT PRIMARY KEY NOT NULL,payload TEXT NOT NULL,mac TEXT NOT NULL)");
            for(String table:new String[]{"auth_identity","credentials"}) {
                db.execSQL("CREATE TRIGGER "+table+"_no_delete BEFORE DELETE ON "+table+" BEGIN SELECT RAISE(ABORT,'auth_custody_delete'); END");
                db.execSQL("CREATE TRIGGER "+table+"_no_replace BEFORE INSERT ON "+table+" WHEN EXISTS(SELECT 1 FROM "+table+(table.equals("credentials")?" WHERE scope=NEW.scope":"")+") BEGIN SELECT RAISE(ABORT,'auth_custody_replace'); END");
            }
            db.execSQL("CREATE TRIGGER auth_identity_no_update BEFORE UPDATE ON auth_identity BEGIN SELECT RAISE(ABORT,'auth_custody_update'); END");
            try {ContentValues row=new ContentValues();row.put("slot",1);row.put("installation",installationId);row.put("mac",SignedProtocol.encode(key.mac("auth-identity-v1",installationId.getBytes(StandardCharsets.UTF_8))));db.insertOrThrow("auth_identity",null,row);}
            catch(Exception error){throw failure("pin_store_unavailable");}
        }
        @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion) {throw failure("pin_migration_required");}
    }

    boolean isProvisioned(OfflineBundle.Binding binding) throws Exception {
        assertDevice(binding);synchronized(NativeStaffUnlock.class){return load(store.getReadableDatabase(),scope(binding))!=null;}
    }
    /** One-time provisioning ONLY. Same-actor retries do not replace an existing PIN. */
    void provisionVerifiedStaff(OfflineBundle.Binding binding,char[] pin) throws Exception {
        try {
            assertDevice(binding);validPin(pin);
            synchronized(NativeStaffUnlock.class) {
                String scope=scope(binding);SQLiteDatabase db=store.getWritableDatabase();db.beginTransaction();
                try {
                    if(load(db,scope)!=null)throw failure("pin_already_provisioned");
                    try(Cursor count=db.rawQuery("SELECT count(*) FROM credentials",null)){count.moveToFirst();if(count.getLong(0)>=32)throw failure("pin_staff_limit");}
                    OfflineClock.Reading now=clock.read();byte[] salt=new byte[32];new SecureRandom().nextBytes(salt);
                    byte[] verifier=derive(pin,salt,scope);
                    JSONObject row=new JSONObject().put("schemaVersion",1).put("installationId",installationId).put("scope",scope)
                        .put("salt",SignedProtocol.encode(salt)).put("verifier",SignedProtocol.encode(verifier)).put("iterations",ITERATIONS)
                        .put("failures",0).put("lockBoot",now.bootId).put("lockUntilElapsed",0).put("revision",1);
                    Arrays.fill(verifier,(byte)0);ContentValues values=values(row);values.put("scope",scope);db.insertOrThrow("credentials",null,values);db.setTransactionSuccessful();
                }finally{db.endTransaction();}
            }
        }finally{wipe(pin);lock();}
    }

    void unlock(OfflineBundle.Binding binding,char[] pin) throws Exception {
        try {
            assertDevice(binding);
            synchronized(NativeStaffUnlock.class) {
                clearSession();String scope=scope(binding);SQLiteDatabase db=store.getWritableDatabase();JSONObject charged;
                OfflineClock.Reading start=clock.read();String rejected=null;
                // Charge the attempt durably BEFORE KDF verification. Killing the process at
                // any subsequent point cannot grant free guesses or erase failed attempts.
                db.beginTransaction();
                try {
                    charged=load(db,scope);if(charged==null)throw failure("pin_not_provisioned");
                    long failures=charged.getLong("failures"),until=charged.getLong("lockUntilElapsed");
                    if(failures>=MAX_FAILURES)throw failure("pin_online_reset_required");
                    if(until>0&&!start.bootId.equals(charged.getString("lockBoot"))) {
                        until=Math.addExact(start.elapsedRealtimeMs,LOCKOUT_MS);charged.put("lockBoot",start.bootId).put("lockUntilElapsed",until);
                    }
                    if(until>start.elapsedRealtimeMs)rejected="pin_locked";
                    else {
                        failures++;charged.put("failures",failures).put("revision",Math.addExact(charged.getLong("revision"),1)).put("lockBoot",start.bootId)
                            .put("lockUntilElapsed",failures==5?Math.addExact(start.elapsedRealtimeMs,LOCKOUT_MS):0);
                    }
                    save(db,scope,charged);db.setTransactionSuccessful();
                }finally{db.endTransaction();}
                if(rejected!=null)throw failure(rejected);
                boolean match=false;byte[] actual=null;
                try {
                    validPin(pin);actual=derive(pin,SignedProtocol.decode(charged.getString("salt"),32),scope);
                    match=MessageDigest.isEqual(actual,SignedProtocol.decode(charged.getString("verifier"),32));
                }finally{if(actual!=null)Arrays.fill(actual,(byte)0);}
                if(!match)throw failure(charged.getLong("failures")>=MAX_FAILURES?"pin_online_reset_required":"pin_incorrect");
                OfflineClock.Reading finish=clock.read();
                if(!start.bootId.equals(finish.bootId)||finish.elapsedRealtimeMs<start.elapsedRealtimeMs)throw failure("pin_clock_changed");
                db.beginTransaction();
                try {
                    JSONObject current=load(db,scope);
                    if(current==null||current.getLong("revision")!=charged.getLong("revision"))throw failure("pin_state_changed");
                    current.put("failures",0).put("lockUntilElapsed",0).put("lockBoot",finish.bootId).put("revision",Math.addExact(current.getLong("revision"),1));
                    save(db,scope,current);db.setTransactionSuccessful();sessionRevision=current.getLong("revision");
                }finally{db.endTransaction();}
                sessionScope=scope;sessionBinding=bindingKey(binding);sessionBoot=finish.bootId;sessionExpires=Math.addExact(finish.elapsedRealtimeMs,SESSION_MS);
            }
        }catch(Exception error){lock();throw error;}finally{wipe(pin);}
    }

    @Override public void requireUnlocked(OfflineBundle.Binding binding) throws Exception {
        assertDevice(binding);
        synchronized(NativeStaffUnlock.class) {
            try {
                OfflineClock.Reading now=clock.read();
                if(sessionBinding==null||!sessionBinding.equals(bindingKey(binding))||!now.bootId.equals(sessionBoot)||now.elapsedRealtimeMs>=sessionExpires)throw failure("pin_unlock_required");
                JSONObject current=load(store.getReadableDatabase(),sessionScope);
                if(current==null||current.getLong("revision")!=sessionRevision||current.getLong("failures")!=0)throw failure("pin_unlock_required");
            }catch(Exception error){clearSession();throw error;}
        }
    }
    void lock(){synchronized(NativeStaffUnlock.class){clearSession();}}
    private void clearSession(){sessionBinding=null;sessionScope=null;sessionBoot=null;sessionExpires=0;sessionRevision=0;}
    @Override public void close(){synchronized(NativeStaffUnlock.class){clearSession();store.close();}}

    private void assertDevice(OfflineBundle.Binding binding) throws Exception {
        if(binding==null)throw failure("pin_binding_invalid");
        // Outside the auth monitor: financial operations already hold journal before guard.
        // Native dialog calls must not invert journal -> auth lock ordering.
        synchronized(journal){try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT fingerprint FROM device_key WHERE slot=1",null)) {
            if(!c.moveToFirst()||!binding.deviceKeySha256.equals(c.getString(0)))throw failure("pin_device_unbound");
        }}
    }
    private String scope(OfflineBundle.Binding b) throws Exception {
        return SignedProtocol.hash(CanonicalJson.bytes(new JSONObject().put("installationId",installationId).put("organizationId",b.organizationId).put("branchId",b.branchId).put("deviceId",b.deviceId).put("actorId",b.actorId).put("keyEpoch",b.keyEpoch).put("deviceKeySha256",b.deviceKeySha256)));
    }
    private String bindingKey(OfflineBundle.Binding b) throws Exception {return scope(b)+":"+b.shiftId;}
    private static void validPin(char[] pin) {
        if(pin==null||pin.length<8||pin.length>12)throw failure("pin_format_invalid");for(char c:pin)if(c<'0'||c>'9')throw failure("pin_format_invalid");
    }
    private static void wipe(char[] pin){if(pin!=null)Arrays.fill(pin,'\0');}
    private byte[] derive(char[] pin,byte[] salt,String scope) throws Exception {
        PBEKeySpec spec=new PBEKeySpec(pin,salt,ITERATIONS,256);byte[] derived=null,joined=null;
        try {
            derived=SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
            if(derived==null||derived.length!=32)throw failure("pin_kdf_unavailable");
            joined=ByteBuffer.allocate(64+1+32+32).put(scope.getBytes(StandardCharsets.UTF_8)).put((byte)0).put(salt).put(derived).array();
            return key.mac("pin-verifier-v1",joined);
        }finally{spec.clearPassword();if(derived!=null)Arrays.fill(derived,(byte)0);if(joined!=null)Arrays.fill(joined,(byte)0);}
    }
    private JSONObject load(SQLiteDatabase db,String scope) throws Exception {
        try(Cursor identity=db.rawQuery("SELECT installation,mac FROM auth_identity WHERE slot=1",null)) {
            if(!identity.moveToFirst()||!installationId.equals(identity.getString(0))||!key.verify("auth-identity-v1",installationId.getBytes(StandardCharsets.UTF_8),SignedProtocol.decode(identity.getString(1),32)))throw failure("pin_store_invalid");
        }
        try(Cursor c=db.rawQuery("SELECT payload,mac FROM credentials WHERE scope=?",new String[]{scope})) {
            if(!c.moveToFirst())return null;byte[] bytes=c.getString(0).getBytes(StandardCharsets.UTF_8);
            if(!key.verify("pin-state-v1",bytes,SignedProtocol.decode(c.getString(1),32)))throw failure("pin_state_invalid");
            Object parsed=CanonicalJson.parse(bytes);if(!(parsed instanceof JSONObject))throw failure("pin_state_invalid");JSONObject p=(JSONObject)parsed;
            if(p.length()!=10||p.getLong("schemaVersion")!=1||!installationId.equals(p.getString("installationId"))||!scope.equals(p.getString("scope"))||p.getLong("iterations")!=ITERATIONS
                ||p.getLong("failures")<0||p.getLong("failures")>MAX_FAILURES||p.getLong("revision")<1||p.getLong("lockUntilElapsed")<0
                ||SignedProtocol.decode(p.getString("salt"),32).length!=32||SignedProtocol.decode(p.getString("verifier"),32).length!=32)throw failure("pin_state_invalid");
            new OfflineClock.Reading(p.getString("lockBoot"),p.getLong("lockUntilElapsed"),0);return p;
        }
    }
    private ContentValues values(JSONObject p) throws Exception {byte[] bytes=CanonicalJson.bytes(p);ContentValues row=new ContentValues();row.put("payload",new String(bytes,StandardCharsets.UTF_8));row.put("mac",SignedProtocol.encode(key.mac("pin-state-v1",bytes)));return row;}
    private void save(SQLiteDatabase db,String scope,JSONObject p) throws Exception {if(db.update("credentials",values(p),"scope=?",new String[]{scope})!=1)throw failure("pin_state_missing");}
    private static IllegalStateException failure(String code){return new IllegalStateException(code);}
}
