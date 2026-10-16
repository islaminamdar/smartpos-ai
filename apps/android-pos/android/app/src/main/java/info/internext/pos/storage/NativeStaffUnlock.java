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
import java.util.UUID;
import java.util.Map;
import java.security.PublicKey;
import info.internext.pos.offline.NativePinRecoveryProof;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/** Internal native PIN guard, never a web credential cache. Host must call provisioning
 * only after fresh verified native online identity/device authorization and native PIN
 * confirmation. Only signed original-actor recovery may replace a credential; no delete API exists. All PIN arrays are consumed and wiped.
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
    private final NativeSessionExpiry expiry;
    private String sessionBinding,sessionScope,sessionBoot;
    private long sessionExpires,sessionRevision;

    NativeStaffUnlock(Context context,NativeJournal journal,NativeClockSource clock) throws Exception {
        this(context,journal,clock,DATABASE,KEY_PREFIX+journal.installationId());
    }
    // Package-private isolated test seam; native host is the trust boundary, never JS.
    NativeStaffUnlock(Context context,NativeJournal journal,NativeCheckoutEngine.ClockSource clock,String database,String alias) throws Exception {
        this(context,journal,clock,database,alias,mainScheduler(),android.os.SystemClock::elapsedRealtime);
    }
    NativeStaffUnlock(Context context,NativeJournal journal,NativeCheckoutEngine.ClockSource clock,String database,String alias,NativeSessionExpiry.Scheduler scheduler,java.util.function.LongSupplier elapsed) throws Exception {
        if(clock==null)throw failure("pin_clock_unavailable");this.journal=journal;this.clock=clock;installationId=journal.installationId();
        expiry=new NativeSessionExpiry(scheduler,elapsed);
        if(Build.VERSION.SDK_INT<26)throw failure("pin_kdf_unsupported");
        try { SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256"); } catch(Exception e) { throw failure("pin_kdf_unsupported"); }
        key=new NativeSecurityKey(alias,context.getDatabasePath(database).exists(),!journal.hasCustody());
        store=new Store(context,database);try {store.getWritableDatabase();}catch(Exception error){store.close();throw error;}
    }
    static NativeSessionExpiry.Scheduler mainScheduler(){
        android.os.Handler handler=new android.os.Handler(android.os.Looper.getMainLooper());
        return new NativeSessionExpiry.Scheduler(){
            public void post(Runnable task,long delay){if(!handler.postDelayed(task,delay))throw failure("pin_unlock_required");}
            public void remove(Runnable task){handler.removeCallbacks(task);}
        };
    }
    void sessionExpiryCallbacks(Runnable invalidate,Runnable notify){expiry.callbacks(invalidate,notify);}
    private final class Store extends SQLiteOpenHelper {
        Store(Context c,String name) {super(c,name,null,2);setWriteAheadLoggingEnabled(true);}
        @Override public void onConfigure(SQLiteDatabase db) {db.execSQL("PRAGMA synchronous=FULL");db.execSQL("PRAGMA recursive_triggers=ON");}
        @Override public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE auth_identity(slot INTEGER PRIMARY KEY CHECK(slot=1),installation TEXT NOT NULL,mac TEXT NOT NULL)");
            db.execSQL("CREATE TABLE credentials(scope TEXT PRIMARY KEY NOT NULL,payload TEXT NOT NULL,mac TEXT NOT NULL)");
            for(String table:new String[]{"auth_identity","credentials"}) {
                db.execSQL("CREATE TRIGGER "+table+"_no_delete BEFORE DELETE ON "+table+" BEGIN SELECT RAISE(ABORT,'auth_custody_delete'); END");
                db.execSQL("CREATE TRIGGER "+table+"_no_replace BEFORE INSERT ON "+table+" WHEN EXISTS(SELECT 1 FROM "+table+(table.equals("credentials")?" WHERE scope=NEW.scope":"")+") BEGIN SELECT RAISE(ABORT,'auth_custody_replace'); END");
            }
            db.execSQL("CREATE TRIGGER auth_identity_no_update BEFORE UPDATE ON auth_identity BEGIN SELECT RAISE(ABORT,'auth_custody_update'); END");
            recoverySchema(db);
            try {ContentValues row=new ContentValues();row.put("slot",1);row.put("installation",installationId);row.put("mac",SignedProtocol.encode(key.mac("auth-identity-v1",installationId.getBytes(StandardCharsets.UTF_8))));db.insertOrThrow("auth_identity",null,row);}
            catch(Exception error){throw failure("pin_store_unavailable");}
        }
        @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion) {if(oldVersion==1&&newVersion==2)recoverySchema(db);else throw failure("pin_migration_required");}
        private void recoverySchema(SQLiteDatabase db){
            for(String table:RECOVERY_TABLES){
                db.execSQL("CREATE TABLE "+table+"(id TEXT PRIMARY KEY NOT NULL,request_id TEXT NOT NULL,payload TEXT NOT NULL,mac TEXT NOT NULL)");
                db.execSQL("CREATE INDEX "+table+"_request ON "+table+"(request_id)");
                db.execSQL("CREATE TRIGGER "+table+"_no_update BEFORE UPDATE ON "+table+" BEGIN SELECT RAISE(ABORT,'auth_recovery_immutable'); END");
                db.execSQL("CREATE TRIGGER "+table+"_no_delete BEFORE DELETE ON "+table+" BEGIN SELECT RAISE(ABORT,'auth_recovery_immutable'); END");
                db.execSQL("CREATE TRIGGER "+table+"_no_replace BEFORE INSERT ON "+table+" WHEN EXISTS(SELECT 1 FROM "+table+" WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'auth_recovery_immutable'); END");
            }
        }
    }

    boolean isProvisioned(OfflineBundle.Binding binding) throws Exception {
        assertDevice(binding);synchronized(NativeStaffUnlock.class){return load(store.getReadableDatabase(),scope(binding))!=null;}
    }
    /** Verified credential-presence check for an empty pre-enrollment drawer. No reset/fallback. */
    boolean hasAnyProvisionedCredentials()throws Exception{
        synchronized(NativeStaffUnlock.class){SQLiteDatabase db=store.getReadableDatabase();load(db,"absent-probe");
            try(Cursor c=db.rawQuery("SELECT scope FROM credentials",null)){boolean found=false;while(c.moveToNext()){if(load(db,c.getString(0))==null)throw failure("pin_state_missing");found=true;}return found;}}
    }
    /** One-time provisioning ONLY. Same-actor retries do not replace an existing PIN. */
    void provisionVerifiedStaff(OfflineBundle.Binding binding,char[] pin) throws Exception {
        try {
            assertDevice(binding);validPin(pin);
            synchronized(NativeStaffUnlock.class) {
                String scope=scope(binding);SQLiteDatabase db=store.getWritableDatabase();requireNoRecovery();db.beginTransaction();
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
                // Keep the previous notification deadline through a failed attempt;
                // only a successful unlock may replace it. Authorization fields clear now.
                clearSessionFields();requireNoRecovery();String scope=scope(binding);SQLiteDatabase db=store.getWritableDatabase();JSONObject charged;
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
                expiry.arm(finish.elapsedRealtimeMs,SESSION_MS);
                if(!expiry.active())throw failure("pin_unlock_required");
            }
        }catch(Exception error){synchronized(NativeStaffUnlock.class){clearSessionFields();}throw error;}finally{wipe(pin);}
    }

    @Override public void requireUnlocked(OfflineBundle.Binding binding) throws Exception {
        assertDevice(binding);
        synchronized(NativeStaffUnlock.class) {
            boolean expired=false;
            try {
                requireNoRecovery();OfflineClock.Reading now=clock.read();
                expired=sessionBinding!=null&&(!now.bootId.equals(sessionBoot)||now.elapsedRealtimeMs>=sessionExpires||!expiry.active());
                if(expired||sessionBinding==null||!sessionBinding.equals(bindingKey(binding)))throw failure("pin_unlock_required");
                JSONObject current=load(store.getReadableDatabase(),sessionScope);
                if(current==null||current.getLong("revision")!=sessionRevision||current.getLong("failures")!=0)throw failure("pin_unlock_required");
            }catch(Exception error){clearSessionFields();if(expired)expiry.expire();throw error;}
        }
    }
    void lock(){synchronized(NativeStaffUnlock.class){clearSession();}}
    private void clearSessionFields(){sessionBinding=null;sessionScope=null;sessionBoot=null;sessionExpires=0;sessionRevision=0;}
    private void clearSession(){clearSessionFields();expiry.clear();}
    @Override public void close(){synchronized(NativeStaffUnlock.class){clearSession();expiry.close();store.close();}}

    private static final String[] RECOVERY_TABLES={"pin_recovery_requests","pin_recovery_proofs","pin_recovery_expired","pin_recovery_approvals","pin_recovery_applied"};
    /** All methods use the existing auth monitor. Never call journal while holding it. */
    void requireNoRecovery()throws Exception{synchronized(NativeStaffUnlock.class){if(recoveryPending()!=null)throw failure("pin_recovery_pending");}}
    JSONObject recoveryPending()throws Exception{
        synchronized(NativeStaffUnlock.class){SQLiteDatabase db=store.getReadableDatabase();load(db,"identity-probe");JSONObject pending=null;
            try(Cursor c=db.rawQuery("SELECT id FROM pin_recovery_requests ORDER BY rowid",null)){while(c.moveToNext()){
                JSONObject r=recoveryRead(db,"pin_recovery_requests",c.getString(0));JSONObject audit=recoveryRead(db,"pin_recovery_applied",c.getString(0));
                if(audit==null){if(pending!=null)throw failure("pin_store_invalid");pending=r;}
                else {
                    JSONObject approval=recoveryRead(db,"pin_recovery_approvals",r.getString("requestId"));
                    if(approval==null||!audit.getString("approvalSha256").equals(NativePinRecoveryProof.payloadHash(approval.getString("envelope")))||!audit.getString("requestId").equals(r.getString("requestId"))||!audit.getString("oldPayloadSha256").equals(r.getString("oldPayloadSha256"))||!audit.getString("newPayloadSha256").equals(SignedProtocol.hash(CanonicalJson.bytes(r.getJSONObject("candidate")))))throw failure("pin_store_invalid");
                }
            }}return pending;}
    }
    JSONObject recoveryLatest()throws Exception{synchronized(NativeStaffUnlock.class){SQLiteDatabase db=store.getReadableDatabase();load(db,"identity-probe");try(Cursor c=db.rawQuery("SELECT id FROM pin_recovery_requests ORDER BY rowid DESC LIMIT 1",null)){return c.moveToFirst()?recoveryRead(db,"pin_recovery_requests",c.getString(0)):null;}}}
    JSONObject recoveryStart(OfflineBundle.Binding binding,char[] pin,char[] confirmation,java.util.function.BooleanSupplier foreground)throws Exception{
        try{assertDevice(binding);validPin(pin);if(confirmation==null||!Arrays.equals(pin,confirmation))throw failure("pin_confirmation_mismatch");
            synchronized(NativeStaffUnlock.class){requireNoRecovery();clearSession();SQLiteDatabase db=store.getWritableDatabase();String scope=scope(binding);JSONObject old=load(db,scope);if(old==null)throw failure("pin_not_provisioned");
                OfflineClock.Reading now=clock.read();byte[] salt=new byte[32];new SecureRandom().nextBytes(salt);byte[] verifier=derive(pin,salt,scope);JSONObject candidate;
                try{candidate=new JSONObject(new String(CanonicalJson.bytes(old),StandardCharsets.UTF_8)).put("salt",SignedProtocol.encode(salt)).put("verifier",SignedProtocol.encode(verifier)).put("failures",0).put("lockBoot",now.bootId).put("lockUntilElapsed",0).put("revision",Math.addExact(old.getLong("revision"),1));}finally{Arrays.fill(verifier,(byte)0);}
                String id=UUID.randomUUID().toString();JSONObject core=new JSONObject().put("requestId",id).put("organizationId",binding.organizationId).put("branchId",binding.branchId).put("deviceId",binding.deviceId).put("actorId",binding.actorId).put("keyEpoch",binding.keyEpoch).put("deviceKeySha256",binding.deviceKeySha256).put("oldCredentialSha256",generation(old)).put("newCredentialSha256",generation(candidate));
                JSONObject record=new JSONObject().put("requestId",id).put("scope",scope).put("oldPayloadSha256",SignedProtocol.hash(CanonicalJson.bytes(old))).put("candidate",candidate).put("core",core).put("createdAt",NativeCheckoutEngine.iso(now.wallTimeMs));
                db.beginTransaction();try{if(!foreground.getAsBoolean())throw failure("pin_recovery_interrupted");requireNoRecovery();JSONObject check=load(db,scope);if(check==null||!SignedProtocol.hash(CanonicalJson.bytes(check)).equals(record.getString("oldPayloadSha256")))throw failure("pin_state_changed");recoveryInsert(db,"pin_recovery_requests",id,id,record);db.setTransactionSuccessful();}finally{db.endTransaction();}return record;
            }
        }finally{wipe(pin);wipe(confirmation);lock();}
    }
    String recoveryProof(String requestId)throws Exception{synchronized(NativeStaffUnlock.class){SQLiteDatabase db=store.getReadableDatabase();try(Cursor c=db.rawQuery("SELECT id FROM pin_recovery_proofs WHERE request_id=? ORDER BY rowid DESC LIMIT 1",new String[]{requestId})){return c.moveToFirst()?recoveryRead(db,"pin_recovery_proofs",c.getString(0)).getString("envelope"):null;}}}
    void recoveryAddProof(String requestId,String envelope,PublicKey deviceKey)throws Exception{synchronized(NativeStaffUnlock.class){SQLiteDatabase db=store.getWritableDatabase();JSONObject r=recoveryRead(db,"pin_recovery_requests",requestId);if(r==null||recoveryRead(db,"pin_recovery_applied",requestId)!=null)throw failure("pin_recovery_invalid");
        JSONObject proof=NativePinRecoveryProof.request(envelope,java.util.Collections.singletonMap(r.getJSONObject("core").getString("deviceKeySha256"),deviceKey));if(!Arrays.equals(CanonicalJson.bytes(r.getJSONObject("core")),CanonicalJson.bytes(NativePinRecoveryProof.core(proof))))throw failure("pin_recovery_invalid");
        String hash=NativePinRecoveryProof.payloadHash(envelope);JSONObject row=new JSONObject().put("requestId",requestId).put("envelope",envelope);if(recoveryRead(db,"pin_recovery_proofs",hash)==null)recoveryInsert(db,"pin_recovery_proofs",hash,requestId,row);
    }}
    boolean recoveryProofExpired(String envelope)throws Exception{synchronized(NativeStaffUnlock.class){return recoveryRead(store.getReadableDatabase(),"pin_recovery_expired",NativePinRecoveryProof.payloadHash(envelope))!=null;}}
    void recoveryMarkExpired(String requestId,String envelope)throws Exception{synchronized(NativeStaffUnlock.class){SQLiteDatabase db=store.getWritableDatabase();String hash=NativePinRecoveryProof.payloadHash(envelope);JSONObject proof=recoveryRead(db,"pin_recovery_proofs",hash);if(proof==null||!proof.getString("requestId").equals(requestId))throw failure("pin_recovery_invalid");if(recoveryRead(db,"pin_recovery_expired",hash)==null)recoveryInsert(db,"pin_recovery_expired",hash,requestId,new JSONObject().put("requestId",requestId).put("proofSha256",hash));}}
    String recoveryApproval(String requestId)throws Exception{synchronized(NativeStaffUnlock.class){JSONObject r=recoveryRead(store.getReadableDatabase(),"pin_recovery_approvals",requestId);return r==null?null:r.getString("envelope");}}
    void recoveryAccept(String requestId,String envelope,Map<String,PublicKey> serverKeys,PublicKey deviceKey)throws Exception{synchronized(NativeStaffUnlock.class){SQLiteDatabase db=store.getWritableDatabase();verifyApproval(db,requestId,envelope,serverKeys,deviceKey);String original=recoveryApproval(requestId);
        if(original==null)recoveryInsert(db,"pin_recovery_approvals",requestId,requestId,new JSONObject().put("requestId",requestId).put("envelope",envelope));
        else if(!NativePinRecoveryProof.payloadHash(original).equals(NativePinRecoveryProof.payloadHash(envelope)))throw failure("pin_recovery_conflict");
    }}
    boolean recoveryApplied(String requestId)throws Exception{synchronized(NativeStaffUnlock.class){return recoveryRead(store.getReadableDatabase(),"pin_recovery_applied",requestId)!=null;}}
    void recoveryApply(String requestId,OfflineBundle.Binding binding,Map<String,PublicKey> serverKeys,PublicKey deviceKey,java.util.function.BooleanSupplier foreground)throws Exception{
        assertDevice(binding);synchronized(NativeStaffUnlock.class){clearSession();SQLiteDatabase db=store.getWritableDatabase();clock.read();db.beginTransaction();try{
            JSONObject r=recoveryRead(db,"pin_recovery_requests",requestId);if(r==null||!scope(binding).equals(r.getString("scope")))throw failure("pin_recovery_invalid");
            String envelope=recoveryApproval(requestId);if(envelope==null)throw failure("pin_recovery_pending");verifyApproval(db,requestId,envelope,serverKeys,deviceKey);
            if(recoveryRead(db,"pin_recovery_applied",requestId)!=null){db.setTransactionSuccessful();return;}
            JSONObject current=load(db,r.getString("scope"));if(current==null||!SignedProtocol.hash(CanonicalJson.bytes(current)).equals(r.getString("oldPayloadSha256")))throw failure("pin_state_changed");
            JSONObject candidate=r.getJSONObject("candidate");if(!generation(current).equals(r.getJSONObject("core").getString("oldCredentialSha256"))||!generation(candidate).equals(r.getJSONObject("core").getString("newCredentialSha256")))throw failure("pin_recovery_invalid");
            if(!foreground.getAsBoolean())throw failure("pin_recovery_interrupted");save(db,r.getString("scope"),candidate);recoveryInsert(db,"pin_recovery_applied",requestId,requestId,new JSONObject().put("requestId",requestId).put("oldPayloadSha256",r.getString("oldPayloadSha256")).put("newPayloadSha256",SignedProtocol.hash(CanonicalJson.bytes(candidate))).put("approvalSha256",NativePinRecoveryProof.payloadHash(envelope)).put("appliedAt",NativeCheckoutEngine.iso(clock.read().wallTimeMs)));db.setTransactionSuccessful();
        }finally{db.endTransaction();}}
    }
    private JSONObject verifyApproval(SQLiteDatabase db,String id,String envelope,Map<String,PublicKey> keys,PublicKey deviceKey)throws Exception{
        JSONObject r=recoveryRead(db,"pin_recovery_requests",id);if(r==null)throw failure("pin_recovery_invalid");Object decoded=SignedProtocol.verify(envelope,keys).payload();if(!(decoded instanceof JSONObject))throw failure("pin_recovery_invalid");String hash=((JSONObject)decoded).getString("proofSha256");JSONObject version=recoveryRead(db,"pin_recovery_proofs",hash);
        if(version==null||!id.equals(version.getString("requestId")))throw failure("pin_recovery_invalid");JSONObject proof=NativePinRecoveryProof.request(version.getString("envelope"),java.util.Collections.singletonMap(r.getJSONObject("core").getString("deviceKeySha256"),deviceKey));
        if(!Arrays.equals(CanonicalJson.bytes(r.getJSONObject("core")),CanonicalJson.bytes(NativePinRecoveryProof.core(proof))))throw failure("pin_recovery_invalid");return NativePinRecoveryProof.approval(envelope,keys,proof,hash);
    }
    private String generation(JSONObject credential)throws Exception{JSONObject g=new JSONObject();for(String k:new String[]{"installationId","scope","salt","verifier","iterations"})g.put(k,credential.get(k));return SignedProtocol.hash(CanonicalJson.bytes(g));}
    private JSONObject recoveryRead(SQLiteDatabase db,String table,String id)throws Exception{
        load(db,"identity-probe");try(Cursor c=db.rawQuery("SELECT request_id,payload,mac FROM "+table+" WHERE id=?",new String[]{id})){if(!c.moveToFirst())return null;byte[] bytes=c.getString(1).getBytes(StandardCharsets.UTF_8);if(!key.verify("pin-recovery-v1:"+table+":"+id,bytes,SignedProtocol.decode(c.getString(2),32)))throw failure("pin_store_invalid");Object parsed=CanonicalJson.parse(bytes);if(!(parsed instanceof JSONObject))throw failure("pin_store_invalid");JSONObject r=(JSONObject)parsed;if(!r.getString("requestId").equals(c.getString(0)))throw failure("pin_store_invalid");return r;}
    }
    private void recoveryInsert(SQLiteDatabase db,String table,String id,String requestId,JSONObject payload)throws Exception{byte[] bytes=CanonicalJson.bytes(payload);ContentValues values=new ContentValues();values.put("id",id);values.put("request_id",requestId);values.put("payload",new String(bytes,StandardCharsets.UTF_8));values.put("mac",SignedProtocol.encode(key.mac("pin-recovery-v1:"+table+":"+id,bytes)));db.insertOrThrow(table,null,values);}

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
