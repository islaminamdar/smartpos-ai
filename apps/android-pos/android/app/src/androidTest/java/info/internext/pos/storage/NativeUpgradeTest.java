package info.internext.pos.storage;

import static org.junit.Assert.*;
import android.content.Context;
import android.database.Cursor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.security.KeyStore;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Ordered explicit phases only. seedLegacy runs against archived v1 APK; verifyUpgrade after
 * installing the new APK with -r. Do not run this class as an unordered test suite. */
@RunWith(AndroidJUnit4.class)
public class NativeUpgradeTest {
    private static final String DB="native-upgrade-synthetic-v1.db",KEY="internext.pos.test.upgrade.v1";
    private static final String INTENT="00000000-0000-4000-8000-000000000001",RECEIPT="00000000-0000-4000-8000-000000000002";
    private static final String REQUEST="{\"synthetic\":true}",TIME="2026-10-16T12:00:00.000Z";
    private static final String ENVELOPE="{\"format\":\"pos-signed-v1\",\"alg\":\"ECDSA-P256-SHA256-DER\",\"keyId\":\"synthetic\",\"payloadBase64Url\":\"e30\",\"signatureBase64Url\":\"AQ\"}";
    private Context context(){return InstrumentationRegistry.getInstrumentation().getTargetContext();}
    @Test public void seedLegacy()throws Exception{
        assertFalse("do not overwrite uncertain fixture",context().getDatabasePath(DB).exists());
        try(NativeJournal j=new NativeJournal(context(),DB,()->{})){
            assertEquals("must run seed against actual archived APK",1,j.getWritableDatabase().getVersion());
            JSONObject identity=new DeviceIdentity(KEY).readOrCreate(j);
            j.beginIntent(INTENT,REQUEST,TIME);j.commitVerifiedIssuance(INTENT,REQUEST,RECEIPT,"TEST-INV-0000000001",TIME,1000,ENVELOPE);
            context().getSharedPreferences("native-upgrade-test",0).edit().putString("identity",identity.toString()).commit();
        }
    }
    @Test public void verifyUpgrade()throws Exception{
        assertTrue(context().getDatabasePath(DB).exists());
        try(NativeJournal j=new NativeJournal(context(),DB,()->{})){
            assertEquals(6,j.getWritableDatabase().getVersion());
            JSONObject before=new JSONObject(context().getSharedPreferences("native-upgrade-test",0).getString("identity","{}"));
            JSONObject after=new DeviceIdentity(KEY).readOrCreate(j);
            assertEquals(before.getString("installationId"),after.getString("installationId"));assertEquals(before.getString("deviceKeySha256"),after.getString("deviceKeySha256"));
            assertEquals(ENVELOPE,j.commitVerifiedIssuance(INTENT,REQUEST,RECEIPT,"TEST-INV-0000000001",TIME,1000,ENVELOPE));
            assertEquals(1,j.status().getLong("receiptCount"));assertEquals(1,j.status().getLong("pendingCount"));
            try(Cursor c=j.getReadableDatabase().rawQuery("SELECT count(*) FROM offline_bundles",null)){assertTrue(c.moveToFirst());assertEquals(0,c.getInt(0));}
        }
    }
    @Test public void cleanup()throws Exception{
        assertTrue(context().deleteDatabase(DB));context().getSharedPreferences("native-upgrade-test",0).edit().clear().commit();
        KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);keys.deleteEntry(KEY);assertFalse(keys.containsAlias(KEY));assertFalse(context().getDatabasePath(DB).exists());
    }
}
