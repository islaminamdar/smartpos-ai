package info.internext.pos.offline;

import org.junit.Test;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.Collections;
import static org.junit.Assert.*;

public class SignedProtocolTest {
    private JSONObject fixtures() throws Exception {
        try (java.io.InputStream stream = getClass().getResourceAsStream("/offline-signed-protocol.json")) {
            assertNotNull(stream); return new JSONObject(new String(stream.readAllBytes(), StandardCharsets.UTF_8));
        }
    }
    private KeyPair keys(String curve) throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC"); generator.initialize(new ECGenParameterSpec(curve));
        return generator.generateKeyPair();
    }

    @Test public void verifiesActualNodeSignaturesAndRejectsSignedNoncanonicalPayloads() throws Exception {
        JSONObject fixture = fixtures();
        var key = SignedProtocol.publicKey(SignedProtocol.decode(fixture.getString("publicKeyBase64Url"),256));
        assertEquals(fixture.getString("fingerprint"), SignedProtocol.fingerprint(key));
        JSONArray cases = fixture.getJSONArray("cases");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject row = cases.getJSONObject(i); String envelope = row.getJSONObject("envelope").toString();
            if (row.getBoolean("valid")) {
                var verified = SignedProtocol.verify(envelope, Collections.singletonMap("synthetic-node-v1", key));
                assertEquals(row.getString("payload"), new String(verified.bytes(),StandardCharsets.UTF_8));
                assertEquals(row.getString("payloadSha256"), verified.payloadSha256);
                verified.bytes()[0] = 0; ((JSONObject)verified.payload()).put("injected", true);
                assertEquals(row.getString("payload"), new String(verified.bytes(),StandardCharsets.UTF_8));
                assertFalse(((JSONObject)verified.payload()).has("injected"));
            } else assertThrows(Exception.class, () -> SignedProtocol.verify(envelope,Collections.singletonMap("synthetic-node-v1",key)));
        }
    }

    @Test public void rejectsUnknownKeyAlteredPayloadWrongCurveAndMismatchedPair() throws Exception {
        KeyPair pair=keys("secp256r1"), other=keys("secp256r1"), wrongCurve=keys("secp384r1");
        JSONObject payload=new JSONObject().put("amount",300);
        String signed=SignedProtocol.sign(payload,"device",pair.getPrivate(),pair.getPublic());
        assertThrows(Exception.class,()->SignedProtocol.verify(signed,Collections.emptyMap()));
        assertThrows(Exception.class,()->SignedProtocol.verify(signed,Collections.singletonMap("device",other.getPublic())));
        assertThrows(Exception.class,()->SignedProtocol.verify(signed,Collections.singletonMap("device",wrongCurve.getPublic())));
        assertThrows(Exception.class,()->SignedProtocol.sign(payload,"device",pair.getPrivate(),other.getPublic()));
        JSONObject altered=new JSONObject(signed).put("payloadBase64Url",SignedProtocol.encode("{\"amount\":301}".getBytes(StandardCharsets.UTF_8)));
        assertThrows(Exception.class,()->SignedProtocol.verify(altered.toString(),Collections.singletonMap("device",pair.getPublic())));
        JSONObject extra=new JSONObject(signed).put("publicKey", "not_trusted");
        assertThrows(Exception.class,()->SignedProtocol.verify(extra.toString(),Collections.singletonMap("device",pair.getPublic())));
    }

    @Test public void signsCanonicalPayloadAndAllowsProviderToVerifyDer() throws Exception {
        KeyPair pair=keys("secp256r1"); JSONObject payload=new JSONObject().put("z",2).put("a","مثال");
        String first=SignedProtocol.sign(payload,"device",pair.getPrivate(),pair.getPublic());
        String second=SignedProtocol.sign(payload,"device",pair.getPrivate(),pair.getPublic());
        var a=SignedProtocol.verify(first,Collections.singletonMap("device",pair.getPublic()));
        var b=SignedProtocol.verify(second,Collections.singletonMap("device",pair.getPublic()));
        assertEquals(a.payloadSha256,b.payloadSha256);
        Signature verifier=Signature.getInstance("SHA256withECDSA");verifier.initVerify(pair.getPublic());verifier.update(a.bytes());
        assertTrue(verifier.verify(SignedProtocol.decode(new JSONObject(first).getString("signatureBase64Url"),72)));
    }

    @Test public void rejectsMalformedDerIncludingNonminimalZeroNegativeAndTrailingScalars() {
        byte[] shortValid={48,6,2,1,1,2,1,2}; SignedProtocol.requireDer(shortValid);
        byte[][] invalid={{48,6,2,1,0,2,1,1},{48,7,2,2,0,1,2,1,1},{48,6,2,1,(byte)128,2,1,1},{48,6,2,1,1,2,1,2,0},{48,6,2,5,1,2,1,2},{48,6,2,1,1,2,0,2}};
        for(byte[] bytes:invalid)assertThrows(Exception.class,()->SignedProtocol.requireDer(bytes));
    }

    @Test public void base64CodecRejectsAlternateEncodingsAndEnforcesSize() {
        for (int length=1;length<257;length++) {
            byte[] bytes=new byte[length]; for(int i=0;i<length;i++)bytes[i]=(byte)i;
            assertArrayEquals(bytes,SignedProtocol.decode(SignedProtocol.encode(bytes),length));
            assertEquals(java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes),SignedProtocol.encode(bytes));
        }
        for(String invalid:new String[]{"Zh","Zg==","Z+","A","","AA\n"})
            assertThrows(Exception.class,()->SignedProtocol.decode(invalid,10));
        assertThrows(Exception.class,()->SignedProtocol.decode("AAAA",1));
    }

    @Test public void canonicalBoundsCyclesUnicodeAndIntegerRules() throws Exception {
        for(String value:new String[]{"{\"x\":1e2}"," {\"x\":1}","{\"x\":1,}","{x:1}","\ufeff{}","null\n"})
            assertThrows(Exception.class,()->CanonicalJson.parse(value.getBytes(StandardCharsets.UTF_8)));
        assertThrows(Exception.class,()->CanonicalJson.parse(new byte[]{(byte)255}));
        assertThrows(Exception.class,()->CanonicalJson.bytes(new JSONObject().put("x",-0.0)));
        assertThrows(Exception.class,()->CanonicalJson.bytes(new JSONObject().put("x","\ud800")));
        assertThrows(Exception.class,()->CanonicalJson.bytes(new JSONObject().put("x",9_007_199_254_740_992L)));
        JSONObject cycle=new JSONObject();cycle.put("self",cycle);
        assertThrows(Exception.class,()->CanonicalJson.bytes(cycle));
        assertThrows(Exception.class,()->CanonicalJson.parse(("[".repeat(10000)+"]".repeat(10000)).getBytes(StandardCharsets.UTF_8)));
        assertThrows(Exception.class,()->CanonicalJson.bytes("a".repeat(CanonicalJson.MAX_BYTES)));
        assertArrayEquals("{\"a\":null,\"z\":[3,1]}".getBytes(StandardCharsets.UTF_8),CanonicalJson.bytes(new JSONObject().put("z",new JSONArray().put(3).put(1)).put("a",JSONObject.NULL)));
    }

    @Test public void transportRejectsDeepEnvelopesAndLenientParserBypassesBeforeRecursing() throws Exception {
        KeyPair pair=keys("secp256r1");
        for(String raw:new String[]{"[".repeat(10000)+"]".repeat(10000), "/*\"*/"+"[".repeat(10000),
            "{'a':1}","{\"a\":1,\"a\":1}","{a:1}","[1,,2]","[01]","[truefalse]","[1e0]","[1.]", "{\"a\":\"\\uＦＦＦＦ\"}"}) {
            assertThrows(Exception.class,()->CanonicalJson.transport(raw,1_400_000));
            assertThrows(Exception.class,()->SignedProtocol.verify(raw,Collections.singletonMap("device",pair.getPublic())));
        }
        assertEquals(1L,((JSONObject)CanonicalJson.transport(" { \"a\" : 1 } \n",100)).getLong("a"));
    }

    @Test public void rejectsBalancedCommentAndUnquotedNameDepthScannerBypasses() throws Exception {
        // Both hid deep arrays from the former double-quote-only depth pre-scan.
        // Android's lenient JSONTokener interpreted them and recursively descended.
        String arrays = "[".repeat(10000) + "0" + "]".repeat(10000);
        String[] attacks = { "{\"a\":/*\"*/" + arrays + "/*\"*/}", "{a\":" + arrays + ",b\":0}" };
        for (String attack : attacks) {
            assertThrows(IllegalArgumentException.class, () -> CanonicalJson.parse(attack.getBytes(StandardCharsets.UTF_8)));
            assertThrows(IllegalArgumentException.class, () -> SignedProtocol.verify(attack, Collections.emptyMap()));
        }
    }

    @Test public void acceptsMaximumPayloadEvenThoughItsBase64EnvelopeIsLarger() throws Exception {
        KeyPair pair = keys("secp256r1");
        // Quotes consume two bytes: exact 1MiB canonical payload must be supported end to end.
        String payload = "a".repeat(CanonicalJson.MAX_BYTES - 2);
        String signed = SignedProtocol.sign(payload, "device", pair.getPrivate(), pair.getPublic());
        assertTrue(signed.length() > CanonicalJson.MAX_BYTES);
        var verified = SignedProtocol.verify(signed, Collections.singletonMap("device", pair.getPublic()));
        assertEquals(CanonicalJson.MAX_BYTES, verified.bytes().length);
        assertEquals(payload, verified.payload());
        assertThrows(IllegalArgumentException.class, () -> SignedProtocol.sign(payload + "a", "device", pair.getPrivate(), pair.getPublic()));
    }

}
