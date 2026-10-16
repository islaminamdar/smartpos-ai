package info.internext.pos.offline;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.spec.ECGenParameterSpec;
import java.util.Collections;
import static org.junit.Assert.*;

/** Software-ephemeral synthetic keys only; no device enrollment, persisted key alias,
 * financial writes, network, production data or customer authority is touched. */
@RunWith(AndroidJUnit4.class)
public class OfflineBundleAndroidTest {
    private JSONObject fixture() throws Exception {
        try(var stream=InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("pos-offline-output.json")) {
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] chunk=new byte[4096];int length;
            while((length=stream.read(chunk))!=-1)bytes.write(chunk,0,length);
            return new JSONObject(new String(bytes.toByteArray(),StandardCharsets.UTF_8)).getJSONObject("bundle");
        }
    }
    private KeyPair keys() throws Exception {
        KeyPairGenerator generator=KeyPairGenerator.getInstance("EC");generator.initialize(new ECGenParameterSpec("secp256r1"));return generator.generateKeyPair();
    }
    private OfflineBundle verify(JSONObject snapshot,JSONObject authority,KeyPair keys) throws Exception {
        authority.put("snapshotSha256",SignedProtocol.hash(CanonicalJson.bytes(snapshot)));
        String s=SignedProtocol.sign(snapshot,"synthetic-server",keys.getPrivate(),keys.getPublic());
        String a=SignedProtocol.sign(authority,"synthetic-server",keys.getPrivate(),keys.getPublic());
        var binding=new OfflineBundle.Binding(authority.getString("organizationId"),authority.getString("branchId"),authority.getString("deviceId"),authority.getString("actorId"),authority.getString("shiftId"),authority.getString("keyEpoch"),authority.getString("deviceKeySha256"));
        return OfflineBundle.verify(s,a,Collections.singletonMap("synthetic-server",keys.getPublic()),binding);
    }
    @Test public void verifiesActualSqlShapeOnAndroidAndRejectsSignedUnknownProfileFields() throws Exception {
        JSONObject fixture=fixture(),snapshot=fixture.getJSONObject("snapshot"),authority=fixture.getJSONObject("authority");KeyPair keys=keys();
        OfflineBundle bundle=verify(snapshot,authority,keys);
        assertEquals(snapshot.getString("id"),bundle.snapshotId);assertEquals(3,bundle.lastInvoice);
        assertEquals(SignedProtocol.hash(CanonicalJson.bytes(snapshot)),bundle.snapshotSha256);
        bundle.snapshot().getJSONObject("profile").put("trn","mutated");bundle.snapshotBytes()[0]=0;
        assertArrayEquals(CanonicalJson.bytes(snapshot),bundle.snapshotBytes());
        assertEquals(snapshot.getJSONObject("profile").getString("trn"),bundle.profile().getString("trn"));
        snapshot.getJSONObject("profile").put("remotePermission",true);
        assertThrows(Exception.class,()->verify(snapshot,authority,keys));
    }
    @Test public void androidGregorianTimeSupportsYearZeroAndRejectsInvalidCalendarDates() throws Exception {
        JSONObject f=fixture(),s=f.getJSONObject("snapshot"),a=f.getJSONObject("authority");KeyPair keys=keys();
        s.put("createdAt","0000-01-01T00:00:00.000Z");
        a.put("issuedAt","0000-01-01T00:00:00.000Z").put("notBefore","0000-01-01T00:00:00.000Z").put("expiresAt","0000-01-02T00:00:00.000Z");
        OfflineBundle ancient=verify(s,a,keys);assertEquals(-62_167_219_200_000L,ancient.issuedAtMs);assertEquals(86_400_000L,ancient.expiresAtMs-ancient.issuedAtMs);
        s.put("createdAt","1900-02-29T00:00:00.000Z");
        assertThrows(Exception.class,()->verify(s,a,keys));
    }
}
