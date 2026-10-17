package info.internext.pos.storage;

import static org.junit.Assert.*;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteFullException;
import android.os.Bundle;
import android.os.Process;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.OfflineBundle;
import info.internext.pos.offline.OfflineClock;
import info.internext.pos.offline.SignedProtocol;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.Collections;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Explicit test-only capacity/process-death phases. Never operates on the application ledger.
 * No network or production issuance permission. Failed fixtures remain for investigation. */
@RunWith(AndroidJUnit4.class)
public final class NativeStorageFailureTest {
    private static final long START = 1_792_132_200_000L;
    private Context context;
    private String run, mode, stem, alias;
    private File record, signal;
    private JSONObject state;
    private NativeJournal journal;
    private NativeCheckoutEngine engine;
    private DeviceIdentity identity;

    @Test public void orchestratedStorageFailure() throws Exception {
        Bundle args = InstrumentationRegistry.getArguments();
        String phase = args.getString("storageFailurePhase", "");
        // Ordinary test discovery is a read-only skip, before even obtaining a storage path.
        Assume.assumeTrue("Explicit storage failure phase required", !phase.isEmpty());
        assertTrue("Unknown phase", phase.matches("(?:capacity|crash)_(?:seed|verify)|cleanup"));
        run = args.getString("storageFailureRun", "");
        assertTrue("Use a fresh 32-character lowercase hexadecimal run ID", run.matches("[a-f0-9]{32}"));
        mode = phase.equals("cleanup") ? args.getString("storageFailureMode", "") : phase.split("_")[0];
        assertTrue(mode.equals("capacity") || mode.equals("crash"));
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("Only the isolated engineering package is eligible", "info.internext.pos", context.getPackageName());
        stem = "native-storage-failure-" + mode + "-" + run;
        alias = "internext.pos.test.storagefailure." + mode + "." + run;
        record = new File(context.getNoBackupFilesDir(), stem + ".json");
        signal = new File(context.getNoBackupFilesDir(), stem + "-signal.json");
        try {
            if (phase.endsWith("_seed")) seed();
            else if (phase.endsWith("_verify")) verifyAfterRestart();
            else cleanup();
        } finally {
            if (journal != null) journal.close();
        }
    }

    private void seed() throws Exception {
        assertFalse("Never overwrite an existing fixture", record.exists());
        assertFalse(signal.exists());
        for (String suffix : new String[]{"", "-wal", "-shm", "-journal"})
            assertFalse(context.getDatabasePath(stem + ".db" + suffix).exists());
        assertFalse(keys().containsAlias(alias));
        assertTrue("Reserve the run before creating any custody", record.createNewFile());
        state = new JSONObject().put("schemaVersion", 1).put("runId", run).put("mode", mode)
                .put("status", "preparing").put("seedPid", Process.myPid())
                .put("intentId", UUID.randomUUID().toString()).put("boot", UUID.randomUUID().toString());
        write(record, state);
        journal = new NativeJournal(context, stem + ".db", () -> {
            if (mode.equals("crash")) stopAtUncommittedReceipt();
        });
        identity = new DeviceIdentity(alias);
        JSONObject device = identity.readOrCreate(journal);
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair server = generator.generateKeyPair();
        JSONObject reservation;
        try (InputStream in = InstrumentationRegistry.getInstrumentation().getContext()
                .getAssets().open("pos-offline-output.json")) {
            reservation = new JSONObject(read(in)).getJSONObject("reservation");
        }
        JSONObject snapshot = reservation.getJSONObject("snapshot");
        JSONObject authority = reservation.getJSONObject("authority");
        snapshot.put("createdAt", NativeCheckoutEngine.iso(START));
        authority.put("deviceKeySha256", device.getString("deviceKeySha256"))
                .put("issuedAt", NativeCheckoutEngine.iso(START)).put("notBefore", NativeCheckoutEngine.iso(START))
                .put("expiresAt", NativeCheckoutEngine.iso(START + 3_600_000))
                .put("snapshotSha256", SignedProtocol.hash(CanonicalJson.bytes(snapshot)));
        String snapshotEnvelope = SignedProtocol.sign(snapshot, "storage-test-server", server.getPrivate(), server.getPublic());
        String authorityEnvelope = SignedProtocol.sign(authority, "storage-test-server", server.getPrivate(), server.getPublic());
        state.put("device", device).put("authority", authority)
                .put("serverPublicKeySpki", SignedProtocol.encode(server.getPublic().getEncoded()));
        engine = engine();
        engine.installVerifiedBundle(snapshotEnvelope, authorityEnvelope, START);
        JSONObject input = new JSONObject().put("authorityId", authority.getString("id"))
                .put("serviceType", "takeaway").put("customer", JSONObject.NULL)
                .put("lines", new JSONArray().put(new JSONObject()
                        .put("productId", snapshot.getJSONArray("products").getJSONObject(0).getString("id"))
                        .put("quantityMilli", 1000)))
                .put("cashTenderedFils", 1000).put("recordedCardFils", 0).put("presentedTotalFils", 1000);
        assertEquals("payment_confirmation_required", engine.beginPaymentIntent(state.getString("intentId"), input).getString("state"));
        state.put("input", input).put("installationId", journal.installationId())
                .put("beforeSha256", fingerprint()).put("status", "intent_saved");
        write(record, state);
        if (mode.equals("capacity")) exhaustCapacity();
        else {
            engine.commitPaymentIntent(state.getString("intentId"));
            fail("The host must kill this process at the uncommitted-receipt signal");
        }
    }

    private void exhaustCapacity() throws Exception {
        SQLiteDatabase db = journal.getWritableDatabase();
        // Force genuine SQLITE_FULL without filling the emulator or host filesystem.
        // This test-only trigger allocates 1 MiB inside the real receipt transaction.
        db.execSQL("CREATE TABLE qa_capacity_padding(payload BLOB NOT NULL)");
        db.execSQL("CREATE TRIGGER qa_capacity_pressure BEFORE INSERT ON receipts BEGIN INSERT INTO qa_capacity_padding(payload) VALUES(zeroblob(1048576)); END");
        long pages = scalar("PRAGMA page_count");
        long pageSize = scalar("PRAGMA page_size");
        assertTrue("Bound the synthetic allocation below one MiB", pageSize * 16 < 1048576);
        assertTrue("Keep the production WAL storage mode", db.isWriteAheadLoggingEnabled());
        long limit = setWriterCapacity((pages + 16) * pageSize) / pageSize;
        assertEquals(pages + 16, limit);
        Throwable failure = null;
        try { engine.commitPaymentIntent(state.getString("intentId")); }
        catch (Exception error) { failure = error; }
        assertNotNull("Receipt insertion must fail under actual SQLite capacity pressure", failure);
        Throwable cause = failure;
        while (!(cause instanceof SQLiteFullException) && cause.getCause() != null && cause.getCause() != cause)
            cause = cause.getCause();
        assertTrue("Require real SQLiteFullException, got " + failure.getClass().getSimpleName(), cause instanceof SQLiteFullException);
        assertEquals(state.getString("beforeSha256"), fingerprint());
        assertUnissued();
        assertEquals(0, scalar("SELECT count(*) FROM qa_capacity_padding"));
        state.put("status", "capacity_failed").put("exception", cause.getClass().getName())
                .put("pageSize", pageSize).put("maxPageCount", limit)
                .put("afterFailureSha256", fingerprint());
        write(record, state);
        write(signal, checkpoint("capacity_failed"));
    }

    private void stopAtUncommittedReceipt() {
        try {
            assertTrue(journal.getWritableDatabase().inTransaction());
            assertEquals(1, scalar("SELECT count(*) FROM receipts"));
            assertEquals(0, scalar("SELECT count(*) FROM outbox"));
            JSONObject checkpoint = checkpoint("receipt_inserted_transaction_open")
                    .put("receiptRowsVisibleInsideTransaction", 1).put("outboxRows", 0)
                    .put("inTransaction", true).put("waitLimitMs", 180000);
            write(signal, checkpoint);
            // The external orchestrator must observe this file and force-stop the live PID.
            // Timeout throws and rolls back, but does NOT qualify for crash verification.
            Thread.sleep(180000);
            state.put("status", "crash_timeout"); write(record, state);
            write(signal, checkpoint("crash_timeout"));
            throw new IllegalStateException("Host did not kill the process before the test deadline");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            try {
                state.put("status", "crash_interrupted"); write(record, state);
                write(signal, checkpoint("crash_interrupted"));
            } catch (Exception evidenceError) {
                interrupted.addSuppressed(evidenceError);
            }
            throw new IllegalStateException("Crash checkpoint interrupted without host evidence", interrupted);
        } catch (Exception error) {
            throw new IllegalStateException("Crash checkpoint failed", error);
        }
    }

    private void verifyAfterRestart() throws Exception {
        state = load();
        assertEquals(mode.equals("capacity") ? "capacity_failed" : "intent_saved", state.getString("status"));
        assertNotEquals("Use a newly started instrumentation process", state.getInt("seedPid"), Process.myPid());
        JSONObject checkpoint;
        try (InputStream in = new FileInputStream(signal)) { checkpoint = new JSONObject(read(in)); }
        assertEquals(run, checkpoint.getString("runId"));
        assertEquals(mode.equals("capacity") ? "capacity_failed" : "receipt_inserted_transaction_open", checkpoint.getString("phase"));
        assertEquals(state.getInt("seedPid"), checkpoint.getInt("pid"));
        if (mode.equals("crash")) {
            assertEquals("Host must attest it independently observed and force-stopped this PID",
                    String.valueOf(state.getInt("seedPid")), InstrumentationRegistry.getArguments().getString("storageFailureKilledPid", ""));
            assertTrue(checkpoint.getBoolean("inTransaction"));
        }
        assertTrue(context.getDatabasePath(stem + ".db").exists());
        assertTrue(keys().containsAlias(alias));
        journal = new NativeJournal(context, stem + ".db", () -> {});
        assertEquals(state.getString("installationId"), journal.installationId());
        assertEquals(state.getString("beforeSha256"), fingerprint());
        assertUnissued();
        identity = new DeviceIdentity(alias);
        JSONObject device = identity.readOrCreate(journal);
        assertEquals(state.getJSONObject("device").getString("deviceKeySha256"), device.getString("deviceKeySha256"));
        if (mode.equals("capacity")) {
            journal.getWritableDatabase().execSQL("DROP TRIGGER qa_capacity_pressure");
            assertTrue(setWriterCapacity(1048576L * state.getLong("pageSize"))
                    / state.getLong("pageSize") > state.getLong("maxPageCount"));
        }
        engine = engine();
        assertEquals("payment_confirmation_required", engine.getIntent(state.getString("intentId")).getString("state"));
        String envelope = engine.commitPaymentIntent(state.getString("intentId"));
        assertEquals(envelope, engine.commitPaymentIntent(state.getString("intentId")));
        JSONObject payload = (JSONObject) SignedProtocol.verify(envelope,
                Collections.singletonMap(device.getString("deviceKeySha256"),
                        SignedProtocol.publicKey(SignedProtocol.decode(device.getString("publicKeySpkiBase64Url"), 256)))).payload();
        assertEquals(1, payload.getLong("deviceSequence"));
        assertEquals("TEST-INV-0000000001", payload.getJSONObject("document").getString("documentNumber"));
        assertEquals(1000, payload.getJSONObject("document").getJSONObject("totals").getLong("grossFils"));
        assertEquals(1, scalar("SELECT count(*) FROM receipts"));
        assertEquals(1, scalar("SELECT count(*) FROM outbox"));
        assertEquals(1, scalar("SELECT count(*) FROM intents"));
        assertEquals(2, scalar("SELECT next_number FROM offline_authority_state"));
        assertEquals(1000, scalar("SELECT gross_fils FROM offline_authority_state"));
        assertEquals(1, scalar("SELECT sequence FROM offline_chain"));
        assertFalse(journal.status().getBoolean("canIssue"));
        state.put("status", "verified").put("verifyPid", Process.myPid())
                .put("recoveredReceiptSha256", SignedProtocol.hash(CanonicalJson.bytes(payload)))
                .put("documentNumber", payload.getJSONObject("document").getString("documentNumber"))
                .put("recoveredLedgerSha256", fingerprint());
        write(record, state);
        write(new File(context.getCacheDir(), stem + "-result.json"), state);
    }

    private void cleanup() throws Exception {
        state = load();
        assertEquals("Only a verified fixture can be cleaned up automatically", "verified", state.getString("status"));
        assertTrue(context.deleteDatabase(stem + ".db"));
        KeyStore store = keys(); store.deleteEntry(alias); assertFalse(store.containsAlias(alias));
        assertFalse(context.getDatabasePath(stem + ".db").exists());
        assertTrue(signal.delete());
        assertTrue(record.delete());
        state.put("cleanup", "completed");
        write(new File(context.getCacheDir(), stem + "-result.json"), state);
    }

    private NativeCheckoutEngine engine() throws Exception {
        JSONObject authority = state.getJSONObject("authority"), device = state.getJSONObject("device");
        OfflineBundle.Binding binding = new OfflineBundle.Binding(authority.getString("organizationId"),
                authority.getString("branchId"), authority.getString("deviceId"), authority.getString("actorId"),
                authority.getString("shiftId"), authority.getString("keyEpoch"), authority.getString("deviceKeySha256"));
        PublicKey server = SignedProtocol.publicKey(SignedProtocol.decode(state.getString("serverPublicKeySpki"), 256));
        return new NativeCheckoutEngine(journal, Collections.singletonMap("storage-test-server", server), binding,
                SignedProtocol.publicKey(SignedProtocol.decode(device.getString("publicKeySpkiBase64Url"), 256)),
                ignored -> {}, () -> new OfflineClock.Reading(state.getString("boot"), 1000, START), identity::sign);
    }

    private void assertUnissued() throws Exception {
        assertEquals(0, scalar("SELECT count(*) FROM receipts"));
        assertEquals(0, scalar("SELECT count(*) FROM outbox"));
        assertEquals(1, scalar("SELECT count(*) FROM intents"));
        assertEquals(1, scalar("SELECT next_number FROM offline_authority_state"));
        assertEquals(0, scalar("SELECT gross_fils FROM offline_authority_state"));
        assertEquals(0, scalar("SELECT sequence FROM offline_chain"));
        assertEquals(1, scalar("SELECT count(*) FROM intents WHERE receipt_id IS NULL"));
    }

    private JSONObject load() throws Exception {
        assertTrue("Expected the original fixture", record.exists());
        JSONObject value;
        try (InputStream in = new FileInputStream(record)) { value = new JSONObject(read(in)); }
        assertEquals(1, value.getInt("schemaVersion"));
        assertEquals(run, value.getString("runId")); assertEquals(mode, value.getString("mode"));
        return value;
    }

    private JSONObject checkpoint(String phase) throws Exception {
        return new JSONObject().put("schemaVersion", 1).put("runId", run).put("mode", mode)
                .put("phase", phase).put("pid", Process.myPid()).put("intentId", state.getString("intentId"))
                .put("beforeSha256", state.getString("beforeSha256"));
    }

    private long scalar(String sql) {
        try (Cursor cursor = journal.getReadableDatabase().rawQuery(sql, null)) {
            assertTrue(cursor.moveToFirst()); return cursor.getLong(0);
        }
    }

    private long setWriterCapacity(long bytes) {
        // max_page_count is connection-local. Pin its setup to the same primary
        // WAL connection that will execute the subsequent real checkout write.
        SQLiteDatabase db = journal.getWritableDatabase();
        db.beginTransaction();
        try {
            long actual = db.setMaximumSize(bytes);
            db.setTransactionSuccessful();
            return actual;
        } finally { db.endTransaction(); }
    }

    /** Fingerprint every production table and every value, excluding only test padding. */
    private String fingerprint() throws Exception {
        JSONArray tables = new JSONArray();
        try (Cursor names = journal.getReadableDatabase().rawQuery(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'qa_%' ORDER BY name", null)) {
            while (names.moveToNext()) {
                String name = names.getString(0); assertTrue(name.matches("[a-z_]+"));
                JSONArray rows = new JSONArray();
                try (Cursor values = journal.getReadableDatabase().rawQuery("SELECT * FROM " + name + " ORDER BY rowid", null)) {
                    while (values.moveToNext()) {
                        JSONArray row = new JSONArray();
                        for (int i = 0; i < values.getColumnCount(); i++) {
                            assertNotEquals("Unexpected blob in production ledger", Cursor.FIELD_TYPE_BLOB, values.getType(i));
                            row.put(values.isNull(i) ? JSONObject.NULL : values.getString(i));
                        }
                        rows.put(row);
                    }
                }
                tables.put(new JSONObject().put("table", name).put("rows", rows));
            }
        }
        return SignedProtocol.hash(tables.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static KeyStore keys() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null); return store;
    }

    private static String read(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int count;
        while ((count = in.read(buffer)) != -1) {
            assertTrue("Bound test evidence size", out.size() + count <= 2_000_000);
            out.write(buffer, 0, count);
        }
        return out.toString("UTF-8");
    }

    private static void write(File target, JSONObject value) throws Exception {
        File temporary = new File(target.getParentFile(), target.getName() + ".tmp");
        assertFalse("Do not overwrite uncertain evidence", temporary.exists());
        try (FileOutputStream out = new FileOutputStream(temporary)) {
            out.write(value.toString(2).getBytes(StandardCharsets.UTF_8)); out.getFD().sync();
        }
        assertTrue("Publish complete checkpoint atomically", temporary.renameTo(target));
    }
}
