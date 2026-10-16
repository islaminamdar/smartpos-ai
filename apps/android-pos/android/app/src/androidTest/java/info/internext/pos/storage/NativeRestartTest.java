package info.internext.pos.storage;

import static org.junit.Assert.*;
import android.content.Context;
import android.util.Base64;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyStore;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Explicitly orchestrated phases; a synthetic DB survives force-stop/reboot between runs. */
@RunWith(AndroidJUnit4.class)
public class NativeRestartTest {
    private static final String DB = "native-restart-synthetic-v1.db";
    private static final String KEY = "internext.pos.test.restart.v1";
    private static final String INTENT = "11223344-5566-4778-8990-aabbccddeeff";
    private static final String RECEIPT = "22334455-6677-4889-9001-bbccddeeff00";
    private static final String TIME = "2026-10-16T00:00:00.000Z";
    private static final String REQUEST = "{\"synthetic\":true,\"totalFils\":1050}";
    private Context context() { return InstrumentationRegistry.getInstrumentation().getTargetContext(); }
    private String encoded(byte[] value) { return Base64.encodeToString(value, Base64.NO_WRAP | Base64.NO_PADDING | Base64.URL_SAFE); }
    @Test public void seed() throws Exception {
        assertFalse("Never overwrite an existing restart fixture", context().getDatabasePath(DB).exists());
        try (NativeJournal journal = new NativeJournal(context(), DB, () -> {})) {
            DeviceIdentity key = new DeviceIdentity(KEY); JSONObject identity = key.readOrCreate(journal);
            byte[] payload = REQUEST.getBytes(StandardCharsets.UTF_8);
            JSONObject envelope = new JSONObject().put("format", "pos-signed-v1").put("alg", "ECDSA-P256-SHA256-DER").put("keyId", identity.getString("deviceKeySha256")).put("payloadBase64Url", encoded(payload)).put("signatureBase64Url", encoded(key.sign(payload)));
            journal.beginIntent(INTENT, REQUEST, TIME);
            journal.commitVerifiedIssuance(INTENT, REQUEST, RECEIPT, "SYNTHETIC-0001", TIME, 1050, envelope.toString());
            assertEquals(1, journal.status().getLong("pendingCount"));
        }
    }
    @Test public void verify() throws Exception {
        assertTrue("Expected pre-existing restart fixture", context().getDatabasePath(DB).exists());
        try (NativeJournal journal = new NativeJournal(context(), DB, () -> {})) {
            JSONObject identity = new DeviceIdentity(KEY).readOrCreate(journal);
            JSONObject receipt = journal.receipt(RECEIPT);
            assertEquals(identity.getString("deviceKeySha256"), receipt.getString("keyId"));
            assertEquals(REQUEST, new String(Base64.decode(receipt.getString("payloadBase64Url"), Base64.URL_SAFE), StandardCharsets.UTF_8));
            Signature verifier = Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(Base64.decode(identity.getString("publicKeySpkiBase64Url"), Base64.URL_SAFE))));
            verifier.update(REQUEST.getBytes(StandardCharsets.UTF_8));
            assertTrue(verifier.verify(Base64.decode(receipt.getString("signatureBase64Url"), Base64.URL_SAFE)));
            assertEquals(1, journal.status().getLong("receiptCount")); assertEquals(1, journal.status().getLong("pendingCount"));
            assertFalse(journal.status().getBoolean("canIssue"));
            assertEquals(receipt.toString(), journal.commitVerifiedIssuance(INTENT, REQUEST, RECEIPT, "SYNTHETIC-0001", TIME, 1050, receipt.toString()));
        }
    }
    @Test public void cleanup() throws Exception {
        assertTrue(context().deleteDatabase(DB));
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null); store.deleteEntry(KEY);
        assertFalse(store.containsAlias(KEY)); assertFalse(context().getDatabasePath(DB).exists());
    }
}
