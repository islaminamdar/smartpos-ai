package info.internext.pos.offline;

import org.json.JSONObject;
import java.math.BigInteger;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Map;

/** Cryptographic verification only. A valid signature never grants permission to issue a bill.
 * Trusted keys must come from controlled enrollment/configuration, never from the envelope. */
public final class SignedProtocol {
    private static final String ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    private static final BigInteger ORDER = new BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16);
    private SignedProtocol() {}

    public static final class Verified {
        public final String keyId;
        public final String payloadSha256;
        private final byte[] payloadBytes;
        private Verified(String keyId, byte[] bytes) throws Exception {
            this.keyId = keyId; this.payloadBytes = bytes.clone(); this.payloadSha256 = hash(bytes);
        }
        public byte[] bytes() { return payloadBytes.clone(); }
        /** Return a new parse so callers cannot mutate the authenticated result. */
        public Object payload() throws Exception { return CanonicalJson.parse(payloadBytes); }
    }

    public static Verified verify(String raw, Map<String, PublicKey> trustedKeys) throws Exception {
        if (raw == null || raw.length() > 1_400_000) throw invalid();
        Object parsed = CanonicalJson.transport(raw, 1_400_000);
        if (!(parsed instanceof JSONObject)) throw invalid();
        JSONObject envelope = (JSONObject)parsed;
        if (envelope.length() != 5 || !"pos-signed-v1".equals(exactString(envelope, "format")) ||
            !"ECDSA-P256-SHA256-DER".equals(exactString(envelope, "alg"))) throw invalid();
        String keyId = exactString(envelope, "keyId");
        if (!keyId.matches("[A-Za-z0-9._-]{1,120}") || !trustedKeys.containsKey(keyId)) throw invalid();
        PublicKey key = trustedKeys.get(keyId); requireP256(key);
        byte[] payload = decode(exactString(envelope, "payloadBase64Url"), CanonicalJson.MAX_BYTES);
        byte[] signature = decode(exactString(envelope, "signatureBase64Url"), 72);
        requireDer(signature);
        Signature verifier = Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(key); verifier.update(payload);
        if (!verifier.verify(signature)) throw invalid();
        CanonicalJson.parse(payload);
        return new Verified(keyId, payload);
    }

    public static String sign(Object payload, String keyId, PrivateKey privateKey, PublicKey publicKey) throws Exception {
        if (keyId == null || !keyId.matches("[A-Za-z0-9._-]{1,120}")) throw invalid();
        requireP256(publicKey);
        byte[] bytes = CanonicalJson.bytes(payload);
        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(privateKey); signer.update(bytes); byte[] signature = signer.sign();
        requireDer(signature);
        Signature verifier = Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(publicKey); verifier.update(bytes);
        if (!verifier.verify(signature)) throw invalid();
        JSONObject envelope = new JSONObject();
        envelope.put("format", "pos-signed-v1").put("alg", "ECDSA-P256-SHA256-DER")
            .put("keyId", keyId).put("payloadBase64Url", encode(bytes)).put("signatureBase64Url", encode(signature));
        // The payload is canonical; the unsigned transport envelope may be larger after base64.
        return envelope.toString();
    }

    public static PublicKey publicKey(byte[] spki) throws Exception {
        if (spki.length > 256) throw invalid();
        PublicKey key = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(spki));
        requireP256(key);
        if (!Arrays.equals(spki, key.getEncoded())) throw invalid();
        return key;
    }

    public static String fingerprint(PublicKey key) throws Exception { requireP256(key); return hash(key.getEncoded()); }

    public static String hash(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder out = new StringBuilder(64);
        for (byte b : digest) out.append("0123456789abcdef".charAt((b & 255) >> 4)).append("0123456789abcdef".charAt(b & 15));
        return out.toString();
    }

    public static byte[] decode(String encoded, int maxBytes) {
        if (encoded == null || maxBytes < 1 || maxBytes > CanonicalJson.MAX_BYTES || encoded.isEmpty() ||
            encoded.length() > (maxBytes * 4 + 2) / 3 || encoded.length() % 4 == 1) throw invalid();
        byte[] bytes = new byte[encoded.length() * 6 / 8]; int accumulator = 0, bits = 0, offset = 0;
        for (int i = 0; i < encoded.length(); i++) {
            int value = ALPHABET.indexOf(encoded.charAt(i)); if (value < 0) throw invalid();
            accumulator = (accumulator << 6) | value; bits += 6;
            if (bits >= 8) { bits -= 8; bytes[offset++] = (byte)(accumulator >> bits); }
        }
        if (bytes.length > maxBytes || !encode(bytes).equals(encoded)) throw invalid();
        return bytes;
    }

    public static String encode(byte[] bytes) {
        StringBuilder out = new StringBuilder((bytes.length * 4 + 2) / 3);
        int accumulator = 0, bits = 0;
        for (byte b : bytes) {
            accumulator = (accumulator << 8) | (b & 255); bits += 8;
            while (bits >= 6) { bits -= 6; out.append(ALPHABET.charAt((accumulator >> bits) & 63)); }
        }
        if (bits > 0) out.append(ALPHABET.charAt((accumulator << (6 - bits)) & 63));
        return out.toString();
    }

    public static void requireDer(byte[] signature) {
        if (signature.length < 8 || signature.length > 72 || signature[0] != 0x30 || (signature[1] & 255) != signature.length - 2) throw invalid();
        int offset = 2;
        for (int part = 0; part < 2; part++) {
            if (offset + 2 > signature.length || signature[offset++] != 2) throw invalid();
            int length = signature[offset++] & 255;
            if (length < 1 || length > 33 || offset + length > signature.length || (signature[offset] & 128) != 0 ||
                (length > 1 && signature[offset] == 0 && (signature[offset + 1] & 128) == 0)) throw invalid();
            BigInteger scalar = new BigInteger(1, Arrays.copyOfRange(signature, offset, offset + length));
            if (scalar.signum() == 0 || scalar.compareTo(ORDER) >= 0) throw invalid();
            offset += length;
        }
        if (offset != signature.length) throw invalid();
    }

    private static void requireP256(PublicKey key) throws Exception {
        if (!(key instanceof ECPublicKey)) throw invalid();
        AlgorithmParameters expected = AlgorithmParameters.getInstance("EC");
        expected.init(new ECGenParameterSpec("secp256r1"));
        ECParameterSpec p = ((ECPublicKey)key).getParams(), e = expected.getParameterSpec(ECParameterSpec.class);
        if (!p.getCurve().equals(e.getCurve()) || !p.getGenerator().equals(e.getGenerator()) ||
            !p.getOrder().equals(e.getOrder()) || p.getCofactor() != e.getCofactor()) throw invalid();
    }

    private static String exactString(JSONObject object, String key) throws Exception {
        Object value = object.get(key); if (!(value instanceof String)) throw invalid(); return (String)value;
    }
    private static IllegalArgumentException invalid() { return new IllegalArgumentException("invalid_signed_protocol"); }
}
