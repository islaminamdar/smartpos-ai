package info.internext.pos.storage;

import static org.junit.Assert.*;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteException;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.UUID;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Independent synthetic storage checks. No authority, server, payment, or real merchant data. */
@RunWith(AndroidJUnit4.class)
public class NativeJournalAuditTest {
    private Context context;
    private String database;
    private NativeJournal journal;
    private final String intent = UUID.randomUUID().toString();
    private final String receipt = UUID.randomUUID().toString();
    private static final String REQUEST = "{\"synthetic\":true,\"amountFils\":1050}";
    private static String envelope(String payload, String signature, String key) {
        String encoded = Base64.encodeToString(payload.getBytes(StandardCharsets.UTF_8), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        return "{\"format\":\"pos-signed-v1\",\"alg\":\"ECDSA-P256-SHA256-DER\",\"keyId\":\"" + key + "\",\"payloadBase64Url\":\"" + encoded + "\",\"signatureBase64Url\":\"" + signature + "\"}";
    }
    private static final String ENVELOPE = envelope(REQUEST, "AQ", "fixture-key");
    private static final String TIME = "2026-10-16T12:00:00.000Z";
    private static final String NUMBER = "TEST-000001";

    @Before public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        database = "native-audit-" + UUID.randomUUID() + ".db";
        journal = new NativeJournal(context, database, () -> {});
    }
    @After public void tearDown() {
        if (journal != null) journal.close();
        assertTrue("synthetic database removed", context.deleteDatabase(database));
    }
    private String commit(String envelope) {
        return journal.commitVerifiedIssuance(intent, REQUEST, receipt, NUMBER, TIME, 1050, envelope);
    }
    private void prepare() {
        journal.beginIntent(intent, REQUEST, TIME);
        commit(ENVELOPE);
    }
    private long count(String table) {
        try (Cursor c = journal.getReadableDatabase().rawQuery("SELECT count(*) FROM " + table, null)) {
            assertTrue(c.moveToFirst()); return c.getLong(0);
        }
    }
    @Test public void rollbackAndReopenRetainUncertainIntentWithoutPartialReceipt() throws Exception {
        journal.close();
        journal = new NativeJournal(context, database, () -> { throw new IllegalStateException("synthetic_commit_interruption"); });
        journal.beginIntent(intent, REQUEST, TIME);
        String installation = journal.installationId();
        assertThrows(IllegalStateException.class, () -> commit(ENVELOPE));
        journal.close();
        journal = new NativeJournal(context, database, () -> {});
        assertEquals(installation, journal.installationId());
        assertEquals(1, count("intents"));
        assertEquals(0, count("receipts"));
        assertEquals(0, count("outbox"));
        try (Cursor c = journal.getReadableDatabase().rawQuery("SELECT receipt_id FROM intents WHERE id=?", new String[]{intent})) {
            assertTrue(c.moveToFirst()); assertTrue(c.isNull(0));
        }
        assertEquals(ENVELOPE, commit(ENVELOPE));
        assertEquals(1, count("receipts")); assertEquals(1, count("outbox"));
        assertFalse(journal.status().getBoolean("canIssue"));
    }
    @Test public void exactRetryAfterReopenKeepsOneReceiptAndOutbox() throws Exception {
        prepare(); journal.close(); journal = new NativeJournal(context, database, () -> {});
        journal.beginIntent(intent, REQUEST, TIME);
        assertEquals(ENVELOPE, commit(ENVELOPE));
        assertEquals(1, count("receipts")); assertEquals(1, count("outbox"));
        assertThrows(IllegalStateException.class, () -> journal.beginIntent(intent, "{\"amountFils\":99}", TIME));
        assertThrows(IllegalStateException.class, () -> journal.commitVerifiedIssuance(intent, REQUEST, receipt, "TEST-000002", TIME, 1050, ENVELOPE));
    }
    @Test public void changedEnvelopeCannotBeAdoptedAsExactRetry() {
        prepare();
        assertThrows(IllegalStateException.class, () -> commit(envelope("{\"amountFils\":999}", "Ag", "fixture-key")));
        assertThrows(IllegalStateException.class, () -> commit(envelope(REQUEST, "Ag", "another-key")));
        assertEquals(ENVELOPE, commit(envelope(REQUEST, "Ag", "fixture-key")));
        assertEquals(ENVELOPE, commit(ENVELOPE));
    }
    @Test public void replaceCannotRewriteCommittedReceiptOrAcknowledgement() {
        prepare();
        assertThrows(SQLiteException.class, () -> journal.getWritableDatabase().execSQL(
            "INSERT OR REPLACE INTO receipts(id,intent_id,document_number,issued_at,total_fils,payload_hash,envelope_hash,envelope_json) VALUES(?,?,?,?,?,?,?,?)",
            new Object[]{receipt, intent, NUMBER, TIME, 9999, NativeJournal.hash("{}"), NativeJournal.hash("{}"), "{}"}));
        journal.acknowledgeVerified(receipt, NativeJournal.payloadHash(ENVELOPE), "{\"ack\":1}", TIME);
        assertThrows(SQLiteException.class, () -> journal.getWritableDatabase().execSQL(
            "INSERT OR REPLACE INTO acknowledgements(receipt_id,payload_hash,ack_json,acknowledged_at) VALUES(?,?,?,?)",
            new Object[]{receipt, NativeJournal.payloadHash(ENVELOPE), "{\"ack\":2}", TIME}));
        assertEquals(ENVELOPE, commit(ENVELOPE));
    }
    @Test public void uncertainIntentIdentityCannotBecomeNullOrBeReplaced() {
        journal.beginIntent(intent, REQUEST, TIME);
        assertThrows(SQLiteException.class, () -> journal.getWritableDatabase().execSQL("UPDATE intents SET id=NULL WHERE id=?", new Object[]{intent}));
        assertThrows(SQLiteException.class, () -> journal.getWritableDatabase().execSQL("INSERT OR REPLACE INTO intents(id,request_hash,request_json,created_at) VALUES(?,?,?,?)", new Object[]{intent, NativeJournal.hash("{}"), "{}", TIME}));
        assertEquals(ENVELOPE, commit(ENVELOPE));
    }
    @Test public void committedIntentCannotBeRewrittenOrUnbound() {
        prepare();
        assertThrows(SQLiteException.class, () -> journal.getWritableDatabase().execSQL("UPDATE intents SET request_json='{}' WHERE id=?", new Object[]{intent}));
        assertThrows(SQLiteException.class, () -> journal.getWritableDatabase().execSQL("UPDATE intents SET receipt_id=NULL WHERE id=?", new Object[]{intent}));
        assertThrows(SQLiteException.class, () -> journal.getWritableDatabase().execSQL("DELETE FROM intents WHERE id=?", new Object[]{intent}));
        assertEquals(ENVELOPE, commit(ENVELOPE));
    }
    @Test public void wrongAcknowledgementHashPreservesPendingEvidenceAndExactAckSurvivesReopen() throws Exception {
        prepare();
        assertThrows(IllegalStateException.class, () -> journal.acknowledgeVerified(receipt, NativeJournal.hash("other"), "{\"ack\":1}", TIME));
        assertEquals(0, count("acknowledgements")); assertEquals(1, count("outbox"));
        journal.acknowledgeVerified(receipt, NativeJournal.payloadHash(ENVELOPE), "{\"ack\":1}", TIME);
        journal.close(); journal = new NativeJournal(context, database, () -> {});
        journal.acknowledgeVerified(receipt, NativeJournal.payloadHash(ENVELOPE), "{\"ack\":1}", TIME);
        assertThrows(IllegalStateException.class, () -> journal.acknowledgeVerified(receipt, NativeJournal.payloadHash(ENVELOPE), "{\"ack\":2}", TIME));
        assertEquals(1, count("acknowledgements")); assertEquals(0, count("outbox"));
        assertEquals(1, count("receipts")); assertEquals(ENVELOPE, commit(ENVELOPE));
    }
    @Test public void acknowledgementInsertionRollsBackIfOutboxCustodyIsMissing() {
        prepare();
        journal.getWritableDatabase().delete("outbox", "receipt_id=?", new String[]{receipt});
        assertThrows(IllegalStateException.class, () -> journal.acknowledgeVerified(receipt, NativeJournal.payloadHash(ENVELOPE), "{\"ack\":1}", TIME));
        assertEquals(0, count("acknowledgements")); assertEquals(1, count("receipts"));
    }
    @Test public void anotherIntentCannotReuseReceiptOrDocumentNumber() {
        prepare(); String otherIntent = UUID.randomUUID().toString(); journal.beginIntent(otherIntent, REQUEST, TIME);
        assertThrows(SQLiteException.class, () -> journal.commitVerifiedIssuance(otherIntent, REQUEST, receipt, NUMBER, TIME, 1050, ENVELOPE));
        assertThrows(SQLiteException.class, () -> journal.commitVerifiedIssuance(otherIntent, REQUEST, UUID.randomUUID().toString(), NUMBER, TIME, 1050, ENVELOPE));
        assertEquals(1, count("receipts")); assertEquals(1, count("outbox"));
        assertEquals(ENVELOPE, commit(ENVELOPE));
    }
}
