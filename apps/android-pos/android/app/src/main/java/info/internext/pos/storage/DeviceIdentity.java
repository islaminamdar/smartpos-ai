package info.internext.pos.storage;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;

/** Nonexportable device identity; no signing or private-key operation crosses the JS bridge. */
public final class DeviceIdentity {
    private static final String ALIAS = "internext.pos.signing.v1";
    private final KeyStore keys;
    private final String alias;
    public DeviceIdentity() throws Exception { this(ALIAS); }
    DeviceIdentity(String alias) throws Exception { this.alias = alias; keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null); }
    public synchronized JSONObject readOrCreate(NativeJournal journal) throws Exception {
        // Never recreate a lost key or adopt an existing key into a recreated ledger.
        // A commissioning crash between initial key creation and binding requires review.
        boolean exists=keys.containsAlias(alias);String stored=journal.storedDeviceFingerprint();
        if(exists!=(stored!=null))throw new IllegalStateException("device_key_custody_mismatch");
        if (!keys.containsAlias(alias)) {
            if (journal.hasCustody()) throw new IllegalStateException("device_key_missing");
            KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256).build());
            generator.generateKeyPair();
        }
        byte[] spki = keys.getCertificate(alias).getPublicKey().getEncoded();
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(spki); StringBuilder sha = new StringBuilder();
        for (byte b : digest) sha.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        journal.bindDeviceKey(sha.toString());
        return new JSONObject().put("installationId", journal.installationId())
            .put("publicKeySpkiBase64Url", Base64.encodeToString(spki, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING))
            .put("deviceKeySha256", sha.toString());
    }
    void requireExistingFingerprint(String expected)throws Exception{
        if(!keys.containsAlias(alias)||keys.getCertificate(alias)==null||keys.getKey(alias,null)==null)throw new NativeAccessError("native_storage_unavailable");
        String actual=info.internext.pos.offline.SignedProtocol.fingerprint(keys.getCertificate(alias).getPublicKey());
        if(!actual.equals(expected))throw new NativeAccessError("native_storage_unavailable");
    }
    byte[] sign(byte[] exactCanonicalPayload) throws Exception {
        if (!keys.containsAlias(alias)) throw new IllegalStateException("device_key_missing");
        Signature signature = Signature.getInstance("SHA256withECDSA");
        signature.initSign((java.security.PrivateKey) keys.getKey(alias, null)); signature.update(exactCanonicalPayload); return signature.sign();
    }
}
