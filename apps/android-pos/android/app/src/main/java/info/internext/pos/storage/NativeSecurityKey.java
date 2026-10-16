package info.internext.pos.storage;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import javax.crypto.KeyGenerator;
import javax.crypto.Mac;
import javax.crypto.SecretKey;

/** Internal nonexportable HMAC key. Never substitutes a software key after loss. */
final class NativeSecurityKey {
    private final SecretKey key;
    NativeSecurityKey(String alias,boolean existingStorage,boolean mayCreate) throws Exception {
        synchronized(NativeSecurityKey.class) {
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        boolean exists=store.containsAlias(alias);
        if(exists!=existingStorage)throw new IllegalStateException("native_security_custody_mismatch");
        if(!exists) {
            if(!mayCreate)throw new IllegalStateException("native_security_initialization_requires_review");
            KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256,"AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_SIGN|KeyProperties.PURPOSE_VERIFY).setKeySize(256).setDigests(KeyProperties.DIGEST_SHA256).build());
            generator.generateKey();
        }
        key=(SecretKey)store.getKey(alias,null);
        if(key==null||key.getEncoded()!=null)throw new IllegalStateException("native_security_key_unavailable");
        }
    }
    byte[] mac(String domain,byte[] payload) throws Exception {
        Mac mac=Mac.getInstance("HmacSHA256");mac.init(key);mac.update(domain.getBytes(StandardCharsets.UTF_8));mac.update((byte)0);return mac.doFinal(payload);
    }
    boolean verify(String domain,byte[] payload,byte[] expected) throws Exception { return expected.length==32&&MessageDigest.isEqual(mac(domain,payload),expected); }
}
