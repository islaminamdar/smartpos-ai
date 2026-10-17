package info.internext.pos.storage;

import android.content.Context;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.NativeClockBootstrapTime;
import info.internext.pos.offline.SignedProtocol;
import java.io.File;
import java.net.CookieHandler;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

/** Explicit opt-in, real deployed HTTPS/authentication acceptance. Never enrolls a
 * counter, opens a shift, creates an allocation or calls a financial endpoint.
 * The only remote writes are its synthetic auth session and existing rate limits.
 * No connection factory, TLS override, incoming trust key or fixture token is used. */
@RunWith(AndroidJUnit4.class)
public final class NativeDeployedAccessTest {
    @Test public void syntheticAuthenticationRefreshLogoutAndPinnedTime() throws Exception {
        String filename=InstrumentationRegistry.getArguments().getString("deployedAccessConfig");
        assumeTrue("Explicit private deployed-access fixture required",filename!=null);
        assertTrue("Invalid fixture filename",filename.matches("deployed-access-[a-f0-9-]{36}\\.json"));
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        File configuration=new File(context.getNoBackupFilesDir(),filename);
        assertTrue("Private fixture missing or oversized",configuration.isFile()&&configuration.length()<=4096);
        byte[] bytes=Files.readAllBytes(configuration.toPath());
        JSONObject config;
        try { config=(JSONObject)CanonicalJson.parse(bytes); }
        finally { Arrays.fill(bytes,(byte)0); }
        assertEquals("Unexpected fixture fields",9,config.length());
        assertEquals(1,config.getInt("schemaVersion"));
        assertTrue(config.getBoolean("syntheticOnly"));
        String run=UUID.fromString(config.getString("runId")).toString();
        assertEquals("deployed-access-"+run+".json",filename);
        long age=System.currentTimeMillis()-config.getLong("createdAtMs");
        assertTrue("Fixture must be newly prepared",age>=0&&age<=30*60*1000L);
        String email=config.getString("email"),actor=config.getString("actorId"),branch=config.getString("branchId"),organization=config.getString("organizationId");
        assertTrue("Only synthetic accounts are permitted",email.matches("integration-pos-[a-f0-9]+@example\\.invalid"));
        for(String id:new String[]{actor,branch,organization})assertEquals(id,UUID.fromString(id).toString());
        assertNotEquals("Customer organization is forbidden","8feaa1e9-c27d-44e7-94ae-60944c131c14",organization);
        assertNotEquals("Customer branch is forbidden","79d4b844-1fd4-4cdf-a32f-db9329d75f3a",branch);
        char[] password=config.getString("password").toCharArray();config.remove("password");
        assertTrue("Invalid secret length",password.length>0&&password.length<=256);
        assertNull("Global cookies must not be changed by this test",CookieHandler.getDefault());
        String prefix="deployed-access-"+run,alias="internext.pos.test."+prefix;
        assertFalse("Existing test database must not be reused",context.getDatabasePath(prefix+".db").exists());
        for(String suffix:new String[]{"",".bak",".new"})assertFalse("Existing vault must not be reused",new File(context.getNoBackupFilesDir(),prefix+".bin"+suffix).exists());
        KeyStore existingKeys=KeyStore.getInstance("AndroidKeyStore");existingKeys.load(null);
        assertFalse("Existing session key must not be reused",existingKeys.containsAlias(alias));
        File marker=new File(context.getNoBackupFilesDir(),prefix+".started");
        assertTrue("An uncertain run must not be replayed",marker.createNewFile());
        JSONObject result=new JSONObject().put("schemaVersion",1).put("runId",run).put("status","running")
            .put("origin",NativePosHttp.ORIGIN).put("financialEndpointsCalled",false).put("cleanup","pending");
        File report=new File(context.getCacheDir(),prefix+"-result.json");
        write(report,result);
        NativeJournal journal=null;NativeSession session=null;boolean signedOut=false,passed=false;
        String stage="create_isolated_storage";
        try {
            journal=new NativeJournal(context,prefix+".db",()->{});
            SecureSessionStore store=new SecureSessionStore(context,prefix+".bin",alias);
            NativePosHttp http=new NativePosHttp(store);
            session=new NativeSession(store,http,journal);
            assertFalse(journal.hasCustody());
            stage="real_authentication";
            assertScope(session.signIn(email,password),actor,branch,organization);
            assertTrue("Password was not consumed",allZero(password));
            JSONObject cookies=store.read().getJSONObject("cookies");
            assertTrue("Both native auth cookies required",cookies.has("pos-access")&&cookies.has("pos-refresh"));
            result.put("authenticated",true);
            stage="encrypted_vault_reopen";
            journal.close();journal=new NativeJournal(context,prefix+".db",()->{});
            store=new SecureSessionStore(context,prefix+".bin",alias);
            http=new NativePosHttp(store);session=new NativeSession(store,http,journal);
            assertScope(session.getAccessState(),actor,branch,organization);
            result.put("vaultReopened",true);
            stage="real_refresh";
            JSONObject before=store.read();String originalRefresh=before.getJSONObject("cookies").getString("pos-refresh");
            before.getJSONObject("cookies").remove("pos-access");store.write(before);
            assertScope(session.getAccessState(),actor,branch,organization);
            JSONObject rotated=store.read().getJSONObject("cookies");
            assertTrue("Refresh did not restore access",rotated.has("pos-access")&&rotated.has("pos-refresh"));
            assertTrue("Refresh token did not rotate",!originalRefresh.equals(rotated.getString("pos-refresh")));
            result.put("refreshRotated",true);
            stage="deployed_signer_pin";
            JSONObject request=new JSONObject().put("schemaVersion",1).put("installationId",UUID.randomUUID().toString())
                .put("deviceKeySha256",randomHash()).put("oldClockGeneration",0).put("oldClockSha256",randomHash()).put("challenge",randomHash());
            String vaultBefore=store.read().toString();long start=System.currentTimeMillis(),elapsed=SystemClock.elapsedRealtime();
            JSONObject response=http.request("POST","/api/pos/native/clock-bootstrap",request);
            assertEquals(2,response.length());assertEquals("ready",response.getString("status"));
            long serverTime=NativeClockBootstrapTime.verify(response.getJSONObject("time").toString(),NativeTrustKeys.load(context),request);
            assertTrue("Unexpected deployed signed time",serverTime>=start-120000&&serverTime<=start+(SystemClock.elapsedRealtime()-elapsed)+120000);
            JSONObject differentChallenge=new JSONObject(request.toString()).put("challenge",randomHash());
            assertThrows("Signed response must not satisfy a different request",Exception.class,()->NativeClockBootstrapTime.verify(response.getJSONObject("time").toString(),NativeTrustKeys.load(context),differentChallenge));
            assertEquals("Historical time request changed native session",vaultBefore,store.read().toString());
            result.put("packagedTrustVerified",true).put("signedServerTimeMs",serverTime);
            stage="real_logout";
            assertEquals("signed_out",session.signOut().getString("status"));signedOut=true;
            assertEquals(0,store.read().getJSONObject("cookies").length());
            NativeAccessError error=assertThrows(NativeAccessError.class,()->new NativePosHttp(new SecureSessionStore(context,prefix+".bin",alias)).request("GET","/api/pos/native/access",null));
            assertEquals("native_session_expired",error.code);
            assertFalse("Unexpected financial custody",journal.hasCustody());
            result.put("loggedOut",true).put("noLocalCustody",true);passed=true;
        } catch(Throwable error) {
            result.put("status","failed").put("failedStage",stage)
                .put("errorCode",error instanceof NativeAccessError?((NativeAccessError)error).code:error.getClass().getSimpleName());
            throw error;
        } finally {
            Arrays.fill(password,'\0');
            if(!signedOut&&session!=null)try { session.signOut();signedOut=true; }catch(Exception ignored){ /* Preserve encrypted session for controlled cleanup. */ }
            if(journal!=null)journal.close();
            result.put("logoutConfirmed",signedOut);
            // Never retain the plaintext password, even when remote cleanup needs attention.
            boolean configDeleted=!configuration.exists()||configuration.delete();
            if(passed&&signedOut&&configDeleted){
                boolean cleaned=context.deleteDatabase(prefix+".db");
                for(String suffix:new String[]{"",".bak",".new"}){File f=new File(context.getNoBackupFilesDir(),prefix+".bin"+suffix);if(f.exists())cleaned&=f.delete();}
                KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);keys.deleteEntry(alias);cleaned&=!keys.containsAlias(alias);
                if(cleaned){cleaned=marker.delete();}
                result.put("cleanup",cleaned?"completed":"failed").put("status",cleaned?"completed":"failed");
                write(report,result);assertTrue("Owned local cleanup incomplete",cleaned);
            } else {result.put("configurationDeleted",configDeleted).put("cleanup","retained_for_investigation");write(report,result);}
        }
        assertEquals("Commissioning requires verified cleanup","completed",result.getString("status"));
    }
    private static void assertScope(JSONObject access,String actor,String branch,String organization)throws Exception{
        assertEquals("signed_in",access.getString("status"));assertEquals(actor,access.getString("actorId"));
        assertFalse("Commissioning must not enable offline sales",access.getBoolean("canPrepareOffline"));
        assertTrue("Unexpected device binding",access.isNull("device"));
        JSONArray branches=access.getJSONArray("branches");assertEquals("Synthetic account must have one branch",1,branches.length());
        assertEquals(branch,branches.getJSONObject(0).getString("id"));assertEquals(organization,branches.getJSONObject(0).getString("organizationId"));
    }
    private static boolean allZero(char[] value){for(char c:value)if(c!='\0')return false;return true;}
    private static String randomHash()throws Exception{byte[] data=new byte[32];new SecureRandom().nextBytes(data);return SignedProtocol.hash(data);}
    private static void write(File file,JSONObject value)throws Exception{Files.write(file.toPath(),value.toString(2).getBytes(StandardCharsets.UTF_8));}
}
