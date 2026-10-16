package info.internext.pos.storage;

import android.content.ContentValues;
import android.content.Context;
import android.util.Base64;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;

/** Durable storage boundary. Only the internal verified native issuance engine may write receipts.
 * No write method is exported through the WebView plugin. This is not an issuance authorizer. */
public final class NativeJournal extends SQLiteOpenHelper {
    public static final String DATABASE = "internext-pos-ledger-v1.db";
    interface CommitProbe { void afterReceiptInserted(); }
    private final CommitProbe probe;
    public NativeJournal(Context context) { this(context, DATABASE, () -> {}); }
    NativeJournal(Context context, String name, CommitProbe probe) {
        super(context, name, null, 8);
        this.probe = probe;
        setWriteAheadLoggingEnabled(true);
    }
    @Override public void onConfigure(SQLiteDatabase db) {
        db.setForeignKeyConstraintsEnabled(true);
        db.execSQL("PRAGMA synchronous=FULL");
        db.execSQL("PRAGMA recursive_triggers=ON");
    }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE installation (id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36))");
        ContentValues identity = new ContentValues(); identity.put("id", UUID.randomUUID().toString());
        db.insertOrThrow("installation", null, identity);
        db.execSQL("CREATE TABLE device_key (slot INTEGER PRIMARY KEY CHECK(slot=1), fingerprint TEXT NOT NULL)");
        db.execSQL("CREATE TABLE intents (id TEXT PRIMARY KEY NOT NULL, request_hash TEXT NOT NULL, request_json TEXT NOT NULL, created_at TEXT NOT NULL, receipt_id TEXT UNIQUE)");
        db.execSQL("CREATE TABLE receipts (id TEXT PRIMARY KEY NOT NULL, intent_id TEXT NOT NULL UNIQUE REFERENCES intents(id), document_number TEXT NOT NULL UNIQUE, issued_at TEXT NOT NULL, total_fils INTEGER NOT NULL CHECK(total_fils>0), payload_hash TEXT NOT NULL, envelope_hash TEXT NOT NULL, envelope_json TEXT NOT NULL)");
        db.execSQL("CREATE TABLE outbox (receipt_id TEXT PRIMARY KEY NOT NULL REFERENCES receipts(id))");
        db.execSQL("CREATE TABLE acknowledgements (receipt_id TEXT PRIMARY KEY NOT NULL REFERENCES receipts(id), payload_hash TEXT NOT NULL, ack_json TEXT NOT NULL, acknowledged_at TEXT NOT NULL)");
        for (String table : new String[]{"receipts", "acknowledgements", "installation", "device_key"}) {
            db.execSQL("CREATE TRIGGER " + table + "_immutable_update BEFORE UPDATE ON " + table + " BEGIN SELECT RAISE(ABORT,'immutable_record'); END");
            db.execSQL("CREATE TRIGGER " + table + "_immutable_delete BEFORE DELETE ON " + table + " BEGIN SELECT RAISE(ABORT,'immutable_record'); END");
        }
        db.execSQL("CREATE TRIGGER device_key_insert_guard BEFORE INSERT ON device_key WHEN EXISTS(SELECT 1 FROM device_key) BEGIN SELECT RAISE(ABORT,'device_key_exists'); END");
        db.execSQL("CREATE TRIGGER installation_insert_guard BEFORE INSERT ON installation WHEN EXISTS(SELECT 1 FROM installation) BEGIN SELECT RAISE(ABORT,'installation_exists'); END");
        db.execSQL("CREATE TRIGGER receipts_insert_guard BEFORE INSERT ON receipts WHEN EXISTS(SELECT 1 FROM receipts WHERE id=NEW.id OR intent_id=NEW.intent_id OR document_number=NEW.document_number) BEGIN SELECT RAISE(ABORT,'receipt_exists'); END");
        db.execSQL("CREATE TRIGGER acknowledgements_insert_guard BEFORE INSERT ON acknowledgements WHEN EXISTS(SELECT 1 FROM acknowledgements WHERE receipt_id=NEW.receipt_id) BEGIN SELECT RAISE(ABORT,'ack_exists'); END");
        db.execSQL("CREATE TRIGGER intents_immutable_update BEFORE UPDATE ON intents WHEN NEW.id IS NOT OLD.id OR NEW.request_hash IS NOT OLD.request_hash OR NEW.request_json IS NOT OLD.request_json OR NEW.created_at IS NOT OLD.created_at OR (OLD.receipt_id IS NOT NULL AND (NEW.receipt_id IS NULL OR NEW.receipt_id IS NOT OLD.receipt_id)) BEGIN SELECT RAISE(ABORT,'immutable_intent'); END");
        db.execSQL("CREATE TRIGGER intents_immutable_delete BEFORE DELETE ON intents BEGIN SELECT RAISE(ABORT,'immutable_intent'); END");
        db.execSQL("CREATE TRIGGER intents_insert_guard BEFORE INSERT ON intents WHEN EXISTS(SELECT 1 FROM intents WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'intent_exists'); END");
        NativeCheckoutEngine.createTables(db);
        NativeReconciliation.createTables(db);
        NativeCheckoutEngine.createFreezeTables(db);
        NativeCheckoutEngine.createResolutionTables(db);
        NativePreparationTransition.createTables(db);
        NativeShiftCloseJournal.createTables(db);
        NativeClockRetirement.createTables(db);
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion >= 1 && oldVersion <= 7 && newVersion == 8) {
            if(oldVersion==1)NativeCheckoutEngine.createTables(db);
            if(oldVersion<=2)NativeReconciliation.createTables(db);
            if(oldVersion<=3)NativeCheckoutEngine.createFreezeTables(db);
            if(oldVersion<=4)NativeCheckoutEngine.createResolutionTables(db);
            if(oldVersion<=5)NativePreparationTransition.createTables(db);
            if(oldVersion<=6)NativeShiftCloseJournal.createTables(db);
            NativeClockRetirement.createTables(db);return;
        }
        throw new IllegalStateException("A reviewed ledger migration is required");
    }
    public synchronized String installationId() {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT id FROM installation", null)) {
            if (!c.moveToFirst()) throw new IllegalStateException("installation_missing");
            return c.getString(0);
        }
    }
    public synchronized boolean hasCustody() { return count("intents") > 0 || count("receipts") > 0 || count("offline_bundles") > 0 || count("native_shift_close_requests") > 0 || count("native_clock_holds") > 0; }
    synchronized String storedDeviceFingerprint() {
        try(Cursor c=getReadableDatabase().rawQuery("SELECT fingerprint FROM device_key WHERE slot=1",null)){return c.moveToFirst()?c.getString(0):null;}
    }
    /** Bootstrap admission is intentionally stricter than the historical hasCustody helper. */
    synchronized void requireBootstrapPristine(String fingerprint)throws Exception {
        SQLiteDatabase db=getReadableDatabase();
        String[] empty={"intents","receipts","outbox","acknowledgements","offline_bundles","offline_authority_state","offline_chain","offline_intent_context","offline_intent_cancellations","offline_intent_freezes","offline_payment_results","offline_payment_statuses","offline_payment_conflicts","offline_seal_confirmations","offline_upload_exceptions","offline_preparation_transitions","offline_preparation_shift_closures","native_shift_close_requests","native_shift_close_outcomes","native_shift_close_setup_transitions","native_clock_holds","native_clock_retirements","native_clock_completions"};
        java.util.Set<String> expected=new java.util.HashSet<>(java.util.Arrays.asList(empty));expected.add("installation");expected.add("device_key");
        try(Cursor c=db.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'android_metadata'",null)){
            while(c.moveToNext())if(!expected.remove(c.getString(0)))throw new NativeAccessError("native_storage_unavailable");
        }
        if(!expected.isEmpty())throw new NativeAccessError("native_storage_unavailable");
        for(String table:empty)try(Cursor c=db.rawQuery("SELECT 1 FROM "+table+" LIMIT 1",null)){if(c.moveToFirst())throw new NativeAccessError("clock_bootstrap_not_eligible");}
        try(Cursor c=db.rawQuery("SELECT id FROM installation",null)){if(!c.moveToFirst()||!java.util.UUID.fromString(c.getString(0)).toString().equals(c.getString(0))||c.moveToNext())throw new NativeAccessError("native_storage_unavailable");}
        try(Cursor c=db.rawQuery("SELECT slot,fingerprint FROM device_key",null)){if(!c.moveToFirst()||c.getInt(0)!=1||!fingerprint.equals(c.getString(1))||c.moveToNext())throw new NativeAccessError("native_storage_unavailable");}
    }
    public synchronized void bindDeviceKey(String fingerprint) {
        if (!fingerprint.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("invalid_key_fingerprint");
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            try (Cursor c = db.rawQuery("SELECT fingerprint FROM device_key WHERE slot=1", null)) {
                if (c.moveToFirst()) {
                    if (!fingerprint.equals(c.getString(0))) throw new IllegalStateException("device_key_changed");
                    db.setTransactionSuccessful(); return;
                }
            }
            if (hasCustody()) throw new IllegalStateException("device_key_custody_missing");
            ContentValues row = new ContentValues(); row.put("slot", 1); row.put("fingerprint", fingerprint); db.insertOrThrow("device_key", null, row); db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    static String hash(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(64);
            for (byte b : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
            return result.toString();
        } catch (Exception e) { throw new IllegalStateException("hash_unavailable", e); }
    }
    static JSONObject envelope(String value) {
        try {
            JSONObject e = new JSONObject(value);
            if (e.length()!=5 || !"pos-signed-v1".equals(e.getString("format")) || !"ECDSA-P256-SHA256-DER".equals(e.getString("alg")) || !e.getString("keyId").matches("[A-Za-z0-9._-]{1,120}")) throw new IllegalArgumentException("invalid_envelope");
            for (String key : new String[]{"payloadBase64Url", "signatureBase64Url"}) {
                String encoded = e.getString(key);
                if (!encoded.matches("[A-Za-z0-9_-]+")) throw new IllegalArgumentException("invalid_base64url");
                byte[] decoded = Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
                if (!encoded.equals(Base64.encodeToString(decoded, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING)) || decoded.length > (key.equals("payloadBase64Url") ? 1048576 : 72)) throw new IllegalArgumentException("invalid_base64url");
            }
            return e;
        } catch (Exception error) { throw new IllegalArgumentException("invalid_envelope", error); }
    }
    static String payloadHash(String value) {
        try {
            byte[] decoded = Base64.decode(envelope(value).getString("payloadBase64Url"), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(decoded); StringBuilder result = new StringBuilder();
            for (byte b : digest) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
            return result.toString();
        } catch (Exception error) { throw new IllegalArgumentException("invalid_envelope", error); }
    }
    private static void uuid(String value) {
        if (value == null || !value.equals(UUID.fromString(value).toString())) throw new IllegalArgumentException("invalid_id");
    }
    private static void bounded(String value, int max) {
        if (value == null || value.isEmpty() || value.getBytes(StandardCharsets.UTF_8).length > max) throw new IllegalArgumentException("invalid_payload_size");
    }
    synchronized void beginIntent(String id, String canonicalRequest, String createdAt) {
        uuid(id); bounded(canonicalRequest, 131072); bounded(createdAt, 32);
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            try (Cursor c = db.rawQuery("SELECT request_hash,request_json FROM intents WHERE id=?", new String[]{id})) {
                if (c.moveToFirst()) {
                    if (!hash(canonicalRequest).equals(c.getString(0)) || !canonicalRequest.equals(c.getString(1))) throw new IllegalStateException("intent_conflict");
                    db.setTransactionSuccessful(); return;
                }
            }
            ContentValues row = new ContentValues(); row.put("id", id); row.put("request_hash", hash(canonicalRequest)); row.put("request_json", canonicalRequest); row.put("created_at", createdAt);
            db.insertOrThrow("intents", null, row); db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    /** Caller must already verify authority, calculate the complete invoice, and sign its payload.
     * Exact retries return the originally stored envelope; no caller may modify a committed receipt. */
    synchronized String commitVerifiedIssuance(String intentId, String exactRequest, String receiptId,
            String documentNumber, String issuedAt, long totalFils, String signedEnvelope) {
        uuid(intentId); uuid(receiptId); bounded(exactRequest, 131072); bounded(signedEnvelope, 1500000);
        bounded(documentNumber, 80); bounded(issuedAt, 32);
        if (totalFils < 1 || totalFils > 100000000L) throw new IllegalArgumentException("invalid_total");
        JSONObject candidateEnvelope = envelope(signedEnvelope);
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            String existingId;
            try (Cursor c = db.rawQuery("SELECT request_hash,request_json,receipt_id FROM intents WHERE id=?", new String[]{intentId})) {
                if (!c.moveToFirst()) throw new IllegalStateException("intent_missing");
                if (!hash(exactRequest).equals(c.getString(0)) || !exactRequest.equals(c.getString(1))) throw new IllegalStateException("intent_conflict");
                existingId = c.isNull(2) ? null : c.getString(2);
            }
            if (existingId != null) {
                try (Cursor c = db.rawQuery("SELECT envelope_json,id,document_number,issued_at,total_fils FROM receipts WHERE id=?", new String[]{existingId})) {
                    if (!c.moveToFirst()) throw new IllegalStateException("receipt_missing");
                    if (!receiptId.equals(c.getString(1)) || !documentNumber.equals(c.getString(2)) || !issuedAt.equals(c.getString(3)) || totalFils != c.getLong(4)) throw new IllegalStateException("issuance_conflict");
                    // Signatures may differ for the same payload: the caller receives the original bytes.
                    String stored = c.getString(0);
                    try {
                        JSONObject previous = envelope(stored);
                        if (!previous.getString("payloadBase64Url").equals(candidateEnvelope.getString("payloadBase64Url")) || !previous.getString("keyId").equals(candidateEnvelope.getString("keyId"))) throw new IllegalStateException("issuance_conflict");
                    } catch (org.json.JSONException error) { throw new IllegalStateException("invalid_envelope", error); }
                    db.setTransactionSuccessful(); return stored;
                }
            }
            ContentValues row = new ContentValues(); row.put("id", receiptId); row.put("intent_id", intentId); row.put("document_number", documentNumber); row.put("issued_at", issuedAt); row.put("total_fils", totalFils); row.put("payload_hash", payloadHash(signedEnvelope)); row.put("envelope_hash", hash(signedEnvelope)); row.put("envelope_json", signedEnvelope);
            db.insertOrThrow("receipts", null, row);
            probe.afterReceiptInserted();
            ContentValues outbox = new ContentValues(); outbox.put("receipt_id", receiptId); db.insertOrThrow("outbox", null, outbox);
            ContentValues intent = new ContentValues(); intent.put("receipt_id", receiptId);
            if (db.update("intents", intent, "id=? AND receipt_id IS NULL", new String[]{intentId}) != 1) throw new IllegalStateException("intent_conflict");
            db.setTransactionSuccessful(); return signedEnvelope;
        } finally { db.endTransaction(); }
    }
    synchronized void acknowledgeVerified(String receiptId, String expectedPayloadHash, String canonicalAck, String acknowledgedAt) {
        uuid(receiptId); bounded(canonicalAck, 131072); bounded(acknowledgedAt, 32);
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            try (Cursor c = db.rawQuery("SELECT payload_hash FROM receipts WHERE id=?", new String[]{receiptId})) {
                if (!c.moveToFirst() || !c.getString(0).equals(expectedPayloadHash)) throw new IllegalStateException("ack_mismatch");
            }
            try (Cursor c = db.rawQuery("SELECT ack_json FROM acknowledgements WHERE receipt_id=?", new String[]{receiptId})) {
                if (c.moveToFirst()) {
                    if (!c.getString(0).equals(canonicalAck)) throw new IllegalStateException("ack_conflict");
                    db.setTransactionSuccessful(); return;
                }
            }
            ContentValues row = new ContentValues(); row.put("receipt_id", receiptId); row.put("payload_hash", expectedPayloadHash); row.put("ack_json", canonicalAck); row.put("acknowledged_at", acknowledgedAt); db.insertOrThrow("acknowledgements", null, row);
            if (db.delete("outbox", "receipt_id=?", new String[]{receiptId}) != 1) throw new IllegalStateException("outbox_missing");
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    private long count(String table) {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT count(*) FROM " + table, null)) { c.moveToFirst(); return c.getLong(0); }
    }
    public synchronized JSONObject status() throws Exception {
        JSONObject result = new JSONObject(); result.put("schemaVersion", 1); result.put("receiptCount", count("receipts")); result.put("pendingCount", count("outbox"));
        try (Cursor c = getReadableDatabase().rawQuery("SELECT max(acknowledged_at) FROM acknowledgements", null)) { c.moveToFirst(); result.put("lastAcknowledgedAt", c.isNull(0) ? JSONObject.NULL : c.getString(0)); }
        result.put("canIssue", false); result.put("reason", "authority_not_configured"); return result;
    }
    public synchronized JSONObject listReceipts() throws Exception {
        JSONArray rows = new JSONArray(); boolean more = false;
        try (Cursor c = getReadableDatabase().rawQuery("SELECT r.id,r.document_number,r.issued_at,r.total_fils,CASE WHEN a.receipt_id IS NULL THEN 'pending' ELSE 'acknowledged' END FROM receipts r LEFT JOIN acknowledgements a ON a.receipt_id=r.id ORDER BY r.issued_at DESC,r.id DESC LIMIT 101", null)) {
            while (c.moveToNext()) {
                if (rows.length() == 100) { more = true; break; }
                JSONObject row = new JSONObject(); row.put("id", c.getString(0)); row.put("documentNumber", c.getString(1)); row.put("issuedAt", c.getString(2)); row.put("totalFils", c.getLong(3)); row.put("syncState", c.getString(4)); rows.put(row);
            }
        }
        return new JSONObject().put("receipts", rows).put("hasMore", more);
    }
    public synchronized JSONObject receipt(String id) throws Exception {
        uuid(id);
        try (Cursor c = getReadableDatabase().rawQuery("SELECT envelope_json,envelope_hash FROM receipts WHERE id=?", new String[]{id})) {
            if (!c.moveToFirst()) throw new IllegalStateException("receipt_not_found");
            String value = c.getString(0); if (!hash(value).equals(c.getString(1))) throw new IllegalStateException("receipt_integrity_failed");
            return new JSONObject(value);
        }
    }
}
