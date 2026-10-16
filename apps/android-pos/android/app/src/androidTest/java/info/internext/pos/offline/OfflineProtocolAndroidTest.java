package info.internext.pos.offline;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Collections;
import java.util.UUID;
import static org.junit.Assert.*;

/** Run actual Android JSON and crypto providers, which differ from desktop JVM providers. */
public class OfflineProtocolAndroidTest {
    private JSONObject fixture(String name) throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getContext();
        try(java.io.InputStream stream=context.getAssets().open(name); ByteArrayOutputStream out=new ByteArrayOutputStream()) {
            byte[] buffer=new byte[4096]; int n; while((n=stream.read(buffer))!=-1)out.write(buffer,0,n);
            return new JSONObject(out.toString("UTF-8"));
        }
    }

    @Test public void actualAndroidProviderAcceptsSameNodeSignaturesAndCanonicalBytes() throws Exception {
        JSONObject fixture=fixture("offline-signed-protocol.json");
        var key=SignedProtocol.publicKey(SignedProtocol.decode(fixture.getString("publicKeyBase64Url"),256));
        assertEquals(fixture.getString("fingerprint"),SignedProtocol.fingerprint(key));
        JSONArray cases=fixture.getJSONArray("cases");
        for(int i=0;i<cases.length();i++) {
            JSONObject row=cases.getJSONObject(i);String envelope=row.getJSONObject("envelope").toString();
            if(row.getBoolean("valid")) {
                var verified=SignedProtocol.verify(envelope,Collections.singletonMap("synthetic-node-v1",key));
                assertEquals(row.getString("payload"),new String(verified.bytes(),StandardCharsets.UTF_8));
                assertEquals(row.getString("payloadSha256"),verified.payloadSha256);
            } else assertThrows(Exception.class,()->SignedProtocol.verify(envelope,Collections.singletonMap("synthetic-node-v1",key)));
        }
        String attack="{\"a\":/*\"*/"+"[".repeat(10000)+"0"+"]".repeat(10000)+"/*\"*/}";
        assertThrows(Exception.class,()->CanonicalJson.parse(attack.getBytes(StandardCharsets.UTF_8)));
        assertThrows(Exception.class,()->SignedProtocol.verify(attack,Collections.singletonMap("synthetic-node-v1",key)));
    }

    @Test public void signsWithNonExportableAndroidKeystoreKeyAndDeletesTestAlias() throws Exception {
        String alias="internext.pos.test.protocol."+UUID.randomUUID();
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        try {
            KeyPairGenerator generator=KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC,"AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_SIGN|KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build());
            var pair=generator.generateKeyPair(); assertNull(pair.getPrivate().getEncoded());
            String fingerprint=SignedProtocol.fingerprint(pair.getPublic());
            String envelope=SignedProtocol.sign(new JSONObject().put("amountFils",12345).put("name","مثال 🍰"),fingerprint,pair.getPrivate(),pair.getPublic());
            var verified=SignedProtocol.verify(envelope,Collections.singletonMap(fingerprint,pair.getPublic()));
            assertEquals(12345,((JSONObject)verified.payload()).getLong("amountFils"));
        } finally { store.deleteEntry(alias); }
        assertFalse(store.containsAlias(alias));
    }

    @Test public void androidCalculatorMatchesAllSharedFinancialFixtures() throws Exception {
        JSONObject fixture=fixture("offline-line-v1.json");
        JSONArray cases=fixture.getJSONArray("vectors");
        for(int i=0;i<cases.length();i++) {
            JSONObject row=cases.getJSONObject(i), input=row.getJSONObject("input"), expected=row.getJSONObject("expected");
            JSONArray lines=input.getJSONArray("lines"); ArrayList<OfflineCalculator.InputLine> inputs=new ArrayList<>();
            for(int j=0;j<lines.length();j++) {
                JSONObject line=lines.getJSONObject(j);
                inputs.add(new OfflineCalculator.InputLine(line.getString("productId"),line.getString("name"),OfflineCalculator.Unit.valueOf(line.getString("unit")),line.getLong("quantityMilli"),line.getLong("unitPriceFils"),line.getLong("taxRateBps")));
            }
            var result=OfflineCalculator.calculate(input.getString("calculationVersion"),input.getBoolean("taxInclusive"),inputs,input.getLong("cashTenderedFils"),input.getLong("recordedCardFils"));
            JSONObject totals=expected.getJSONObject("totals");
            assertEquals(totals.getLong("grossFils"),result.grossFils);assertEquals(totals.getLong("netFils"),result.netFils);assertEquals(totals.getLong("taxFils"),result.taxFils);
            assertEquals(expected.getLong("changeFils"),result.changeFils);assertEquals(expected.getBoolean("requiresBuyerDetails"),result.requiresBuyerDetails);
            for(int j=0;j<result.lines.size();j++) { JSONObject line=expected.getJSONArray("lines").getJSONObject(j);assertEquals(line.getLong("grossFils"),result.lines.get(j).grossFils);assertEquals(line.getLong("taxFils"),result.lines.get(j).taxFils); }
        }
    }
}
