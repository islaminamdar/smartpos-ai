package info.internext.pos.storage;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import javax.net.ssl.HttpsURLConnection;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.CookieHandler;
import java.net.CookieManager;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import static org.junit.Assert.*;

/** No live HTTP or credentials: fake TLS connection with real Android encrypted atomic storage. */
@RunWith(AndroidJUnit4.class)
public class NativePosHttpAndroidTest {
    private Context context; private String name,alias; private SecureSessionStore store;
    private FakeConnection response; private NativePosHttp http; private int opens; private CookieHandler originalCookies;
    private static final String ACTOR="11111111-1111-4111-8111-111111111111";
    @Before public void setup()throws Exception{
        context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        name="http-test-"+UUID.randomUUID()+".bin";alias="internext.pos.test.http."+UUID.randomUUID();
        originalCookies=CookieHandler.getDefault();CookieHandler.setDefault(null);
        store=new SecureSessionStore(context,name,alias);response=new FakeConnection();
        http=new NativePosHttp(store,url->{opens++;assertEquals("https://pos.internext.info/api/pos/native/access",url.toString());return response;});
    }
    @After public void cleanup()throws Exception{
        CookieHandler.setDefault(originalCookies);
        for(String suffix:new String[]{"",".bak",".new"}){File file=new File(context.getNoBackupFilesDir(),name+suffix);if(file.exists())assertTrue(file.delete());}
        KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);keys.deleteEntry(alias);assertFalse(keys.containsAlias(alias));
    }
    private JSONObject get()throws Exception{return http.request("GET","/api/pos/native/access",null);}
    private void rejects(String code)throws Exception{NativeAccessError error=assertThrows(NativeAccessError.class,this::get);assertEquals(code,error.code);assertTrue(response.disconnected);}
    private void cookie(String name,String value)throws Exception{JSONObject data=store.read();data.getJSONObject("cookies").put(name,value);store.write(data);}
    private String header(String name){return response.getRequestProperty(name);}

    @Test public void exactOriginTimeoutsHeadersAndNoRedirects()throws Exception{
        assertTrue(get().getBoolean("ok"));assertEquals(1,opens);assertFalse(response.getInstanceFollowRedirects());
        assertEquals(15000,response.getConnectTimeout());assertEquals(15000,response.getReadTimeout());
        assertEquals("https://pos.internext.info",header("Origin"));assertEquals("identity",header("Accept-Encoding"));
        assertFalse(response.getUseCaches());assertTrue(response.disconnected);
    }
    @Test public void rejectsUnlistedPathsMethodsAndBodiesBeforeOpening()throws Exception{
        for(String path:new String[]{"https://evil.invalid/","/api/pos/native/access?redirect=1","/api/pos/native/../devices","/api/pos/bootstrap"})
            assertThrows(NativeAccessError.class,()->http.request("GET",path,null));
        assertThrows(NativeAccessError.class,()->http.request("PUT","/api/pos/native/access",null));
        assertThrows(NativeAccessError.class,()->http.request("GET","/api/pos/native/access",new JSONObject()));
        assertThrows(NativeAccessError.class,()->http.request("POST","/api/pos/session",null));assertEquals(0,opens);
    }
    @Test public void redirectsDoNotFollowOrApplyTheirCookies()throws Exception{
        response.status=302;response.headers.put("Location",Arrays.asList("https://evil.invalid/"));response.setCookie("pos-access=redirect-secret; Secure; HttpOnly; Path=/");
        rejects("native_access_unavailable");assertFalse(store.read().getJSONObject("cookies").has("pos-access"));assertEquals(0,response.reads);
    }
    @Test public void refusesGlobalCookieHandlerBeforeAnyConnection()throws Exception{
        CookieHandler.setDefault(new CookieManager());assertThrows(NativeAccessError.class,this::get);assertEquals(0,opens);
    }
    @Test public void rotationPersistsBeforeMalformedBodyAndSurvivesReopen()throws Exception{
        cookie("pos-access","old-access");cookie("pos-refresh","old-refresh");cookie("pos-device-"+ACTOR,"a".repeat(64));
        response.setCookie("pos-access=new-access; Path=/; HttpOnly; Secure","pos-refresh=new-refresh; Max-Age=604800; Path=/; Secure; HttpOnly");
        response.body="{\"ok\":true,\"ok\":false}".getBytes(StandardCharsets.UTF_8);rejects("native_access_unavailable");
        JSONObject saved=new SecureSessionStore(context,name,alias).read().getJSONObject("cookies");
        assertEquals("new-access",saved.getString("pos-access"));assertEquals("new-refresh",saved.getString("pos-refresh"));
        assertEquals("a".repeat(64),saved.getString("pos-device-"+ACTOR));assertTrue(header("Cookie").contains("pos-access=old-access"));
        byte[] raw=java.nio.file.Files.readAllBytes(new File(context.getNoBackupFilesDir(),name).toPath());
        assertFalse(new String(raw,StandardCharsets.ISO_8859_1).contains("new-refresh"));
    }
    @Test public void authErrorStillSavesRotationWithoutReturningErrorBody()throws Exception{
        response.status=401;response.setCookie("pos-refresh=rotated; Path=/; Secure; HttpOnly");response.body="sensitive server body".getBytes(StandardCharsets.UTF_8);
        rejects("native_session_expired");assertEquals("rotated",store.read().getJSONObject("cookies").getString("pos-refresh"));assertEquals(0,response.reads);
    }
    @Test public void unsafeCookieBatchCannotPartiallyMutateVault()throws Exception{
        cookie("pos-access","original");response.setCookie("pos-access=next; Path=/; Secure; HttpOnly","pos-refresh=bad; Domain=evil.invalid; Path=/; Secure; HttpOnly");
        rejects("native_access_unavailable");assertEquals("original",store.read().getJSONObject("cookies").getString("pos-access"));
    }
    @Test public void acceptsOnlyExpectedCookieNamesAndScopedSecureAttributes()throws Exception{
        response.setCookie("unrelated=ignored; Path=/", "pos-access=safe; Path=/; Secure; HttpOnly; SameSite=Strict");get();
        JSONObject saved=store.read().getJSONObject("cookies");assertEquals(1,saved.length());assertEquals("safe",saved.getString("pos-access"));
        for(String invalid:new String[]{"pos-access=x; Path=/; HttpOnly","pos-access=x; Secure; Path=/","pos-access=x; Secure; HttpOnly; Path=/other","pos-access=x y; Secure; HttpOnly; Path=/"}){
            response=new FakeConnection();response.setCookie(invalid);rejects("native_access_unavailable");assertEquals("safe",store.read().getJSONObject("cookies").getString("pos-access"));
        }
    }
    @Test public void logoutCookieDeletionKeepsDeviceBinding()throws Exception{
        cookie("pos-access","old");cookie("pos-refresh","old");cookie("pos-device-"+ACTOR,"b".repeat(64));
        response.setCookie("pos-access=; Max-Age=0; Path=/; Secure; HttpOnly","pos-refresh=; Max-Age=0; Path=/; Secure; HttpOnly");get();
        JSONObject saved=store.read().getJSONObject("cookies");assertEquals(1,saved.length());assertEquals("b".repeat(64),saved.getString("pos-device-"+ACTOR));
    }
    @Test public void rejectsOversizedDeclaredAndStreamedBodies()throws Exception{
        response.length=131073;rejects("native_access_unavailable");assertEquals(0,response.reads);
        response=new FakeConnection();response.body=new byte[131073];Arrays.fill(response.body,(byte)' ');rejects("native_access_unavailable");
    }
    @Test public void rejectsInvalidEncodingContentTypeUtf8AndLenientJson()throws Exception{
        response.encoding="gzip";rejects("native_access_unavailable");response=new FakeConnection();response.type="text/html";rejects("native_access_unavailable");
        response=new FakeConnection();response.type="application/jsonp";rejects("native_access_unavailable");
        for(byte[] bad:new byte[][]{new byte[]{(byte)0xc0,(byte)0xaf},"{'ok':true}".getBytes(StandardCharsets.UTF_8),"[]".getBytes(StandardCharsets.UTF_8)}){
            response=new FakeConnection();response.body=bad;rejects("native_access_unavailable");
        }
    }
    @Test public void missingVaultOrCiphertextCorruptionDoesNotRegenerateIdentity()throws Exception{
        File file=new File(context.getNoBackupFilesDir(),name);byte[] original=java.nio.file.Files.readAllBytes(file.toPath());
        byte[] corrupt=original.clone();corrupt[corrupt.length-1]^=1;java.nio.file.Files.write(file.toPath(),corrupt);
        assertThrows(NativeAccessError.class,()->new SecureSessionStore(context,name,alias));
        assertArrayEquals(corrupt,java.nio.file.Files.readAllBytes(file.toPath()));
        assertTrue(file.delete());assertThrows(NativeAccessError.class,()->new SecureSessionStore(context,name,alias));assertFalse(file.exists());
    }

    private static final class FakeConnection extends HttpsURLConnection {
        int status=200,reads;long length=-1;boolean disconnected;String type="application/json; charset=utf-8",encoding;
        byte[] body="{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
        final Map<String,List<String>> headers=new HashMap<>();final ByteArrayOutputStream output=new ByteArrayOutputStream();
        FakeConnection()throws Exception{super(new URL("https://pos.internext.info/api/pos/native/access"));}
        void setCookie(String... values){headers.put("Set-Cookie",Arrays.asList(values));}
        @Override public int getResponseCode(){return status;}
        @Override public Map<String,List<String>> getHeaderFields(){return headers;}
        @Override public String getContentType(){return type;}
        @Override public String getHeaderField(String name){return name.equals("Content-Encoding")?encoding:null;}
        @Override public long getContentLengthLong(){return length;}
        @Override public InputStream getInputStream(){reads++;return new ByteArrayInputStream(body);}
        @Override public OutputStream getOutputStream(){return output;}
        @Override public void disconnect(){disconnected=true;}
        @Override public boolean usingProxy(){return false;}
        @Override public void connect(){}
        @Override public String getCipherSuite(){return "TLS_SYNTHETIC_TEST_ONLY";}
        @Override public Certificate[] getLocalCertificates(){return null;}
        @Override public Certificate[] getServerCertificates(){return new Certificate[0];}
    }
}
