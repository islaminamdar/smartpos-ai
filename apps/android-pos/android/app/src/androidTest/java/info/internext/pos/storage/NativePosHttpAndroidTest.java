package info.internext.pos.storage;

import android.content.Context;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.SignedProtocol;
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
        for(String path:new String[]{"https://evil.invalid/","/api/pos/native/access?redirect=1","/api/pos/native/../devices","/api/pos/bootstrap","/api/pos/offline/import","/api/pos/offline/seal"})
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

    private JSONObject enrollmentBody()throws Exception{return new JSONObject().put("requestId",ACTOR).put("proof",new JSONObject().put("fixture","proof"));}
    private JSONObject definitive(JSONObject body)throws Exception{return new JSONObject().put("status","not_enrolled").put("code","offline_enrollment_proof_expired").put("requestId",ACTOR).put("requestSha256",SignedProtocol.hash(CanonicalJson.bytes(body)));}
    private JSONObject post(String path,JSONObject body)throws Exception{return new NativePosHttp(store,url->{opens++;assertEquals("https://pos.internext.info"+path,url.toString());return response;}).request("POST",path,body);}
    private void errorBody(JSONObject body)throws Exception{response.status=409;response.body=body.toString().getBytes(StandardCharsets.UTF_8);}
    private String postError(String path,JSONObject body){return assertThrows(NativeAccessError.class,()->post(path,body)).code;}
    @Test public void definitiveEnrollmentExpiryRequiresExactRequestDigestAndRetainsVault()throws Exception{
        JSONObject body=enrollmentBody();cookie("pos-refresh","before");JSONObject state=store.read();state.put("offline",new JSONObject().put("pendingFixture",body));store.write(state);errorBody(definitive(body));
        response.setCookie("pos-refresh=rotated; Secure; HttpOnly; Path=/");assertEquals("offline_enrollment_proof_expired",postError("/api/pos/offline/enroll",body));
        assertEquals("rotated",store.read().getJSONObject("cookies").getString("pos-refresh"));assertArrayEquals(CanonicalJson.bytes(body),CanonicalJson.bytes(store.read().getJSONObject("offline").getJSONObject("pendingFixture")));assertTrue(response.disconnected);
    }
    @Test public void enrollmentExpiryNeverTrustsWrongScopeDigestExtraFieldsOrGenericErrors()throws Exception{
        JSONObject body=enrollmentBody(),valid=definitive(body);
        for(JSONObject error:new JSONObject[]{new JSONObject(valid.toString()).put("requestId",UUID.randomUUID().toString()),new JSONObject(valid.toString()).put("requestSha256","b".repeat(64)),new JSONObject(valid.toString()).put("extra",true),new JSONObject(valid.toString()).put("status","unavailable"),new JSONObject(valid.toString()).put("code","pos_offline_proof_expired"),new JSONObject(valid.toString()).put("requestSha256",42)}){
            response=new FakeConnection();errorBody(error);assertEquals("native_access_unavailable",postError("/api/pos/offline/enroll",body));
        }
        response=new FakeConnection();errorBody(valid);response.status=503;assertEquals("native_access_unavailable",postError("/api/pos/offline/enroll",body));assertEquals(0,response.reads);
        response=new FakeConnection();errorBody(valid);assertEquals("native_access_unavailable",postError("/api/pos/offline/seal",body));assertEquals(0,response.reads);
        response=new FakeConnection();errorBody(valid);response.status=200;assertEquals("not_enrolled",post("/api/pos/offline/enroll",body).getString("status"));
    }
    @Test public void malformedOrLostDefinitiveErrorBodyStaysUncertain()throws Exception{
        JSONObject body=enrollmentBody();
        for(byte[] raw:new byte[][]{"{\"status\":\"not_enrolled\",\"status\":\"not_enrolled\"}".getBytes(StandardCharsets.UTF_8),new byte[]{(byte)0xc0,(byte)0xaf},new byte[1025]}){
            response=new FakeConnection();response.status=409;response.body=raw;assertEquals("native_access_unavailable",postError("/api/pos/offline/enroll",body));
        }
        response=new FakeConnection();errorBody(definitive(body));response.noErrorStream=true;assertEquals("native_access_unavailable",postError("/api/pos/offline/enroll",body));
        response=new FakeConnection();errorBody(definitive(body));response.errorReadFailure=true;assertEquals("native_network_unavailable",postError("/api/pos/offline/enroll",body));
        response=new FakeConnection();errorBody(definitive(body));response.type="text/html";assertEquals("native_access_unavailable",postError("/api/pos/offline/enroll",body));assertEquals(0,response.reads);
    }
    @Test public void historicalUploadsNeverSendCookiesOrApplyResponseCookiesEvenWhenLoggedOut()throws Exception{
        cookie("pos-access","private-session");cookie("pos-refresh","private-refresh");JSONObject before=store.read();before.put("logoutPending",true);store.write(before);
        for(String path:new String[]{"/api/pos/offline/import","/api/pos/offline/seal"}){
            response=new FakeConnection();response.setCookie("pos-access=unexpected; Domain=evil.invalid; Path=/");post(path,new JSONObject().put("signed","fixture"));assertNull(header("Cookie"));
            assertEquals(new String(CanonicalJson.bytes(before),StandardCharsets.UTF_8),new String(CanonicalJson.bytes(store.read()),StandardCharsets.UTF_8));
        }
        response=new FakeConnection();response.status=401;response.setCookie("pos-access=; Max-Age=0; Secure; HttpOnly; Path=/");assertEquals("native_access_unavailable",postError("/api/pos/offline/import",new JSONObject()));assertEquals("private-session",store.read().getJSONObject("cookies").getString("pos-access"));
    }
    @Test public void historicalImportReturnsOnlyStrictKnownReconciliationWithoutAcknowledgingAnything()throws Exception{
        JSONObject valid=new JSONObject().put("status","reconciliation_required").put("exceptionId",ACTOR).put("code","chain");errorBody(valid);
        assertArrayEquals(CanonicalJson.bytes(valid),CanonicalJson.bytes(post("/api/pos/offline/import",new JSONObject())));assertNull(header("Cookie"));
        for(JSONObject bad:new JSONObject[]{new JSONObject(valid.toString()).put("code","private backend content"),new JSONObject(valid.toString()).put("code","unknown_future_code"),new JSONObject(valid.toString()).put("extra",true),new JSONObject(valid.toString()).put("exceptionId","invalid"),new JSONObject(valid.toString()).put("status","accepted")}){
            response=new FakeConnection();errorBody(bad);assertEquals("native_access_unavailable",postError("/api/pos/offline/import",new JSONObject()));
        }
    }
    @Test public void historicalEnvelopeWrapperMayExceedOneMiBButEndpointLimitsRemainStrict()throws Exception{
        JSONObject large=new JSONObject().put("payloadBase64Url","a".repeat(1_100_000)).put("signatureBase64Url","unchanged");post("/api/pos/offline/import",large);
        JSONObject sent=new JSONObject(response.output.toString("UTF-8"));assertEquals(large.getString("payloadBase64Url"),sent.getString("payloadBase64Url"));assertEquals("unchanged",sent.getString("signatureBase64Url"));
        int prior=opens;assertEquals("native_access_unavailable",postError("/api/pos/offline/import",new JSONObject().put("payload","a".repeat(1_400_000))));assertEquals(prior,opens);
        assertEquals("native_access_unavailable",postError("/api/pos/offline/seal",new JSONObject().put("payload","a".repeat(16384))));assertEquals(prior,opens);
        response=new FakeConnection();response.body=new JSONObject().put("receipt","a".repeat(1_100_000)).toString().getBytes(StandardCharsets.UTF_8);assertEquals(1_100_000,post("/api/pos/offline/import",new JSONObject()).getString("receipt").length());
        for(String path:new String[]{"/api/pos/offline/import","/api/pos/offline/seal"}){
            response=new FakeConnection();response.length=path.endsWith("import")?1_400_001:16385;assertEquals("native_access_unavailable",postError(path,new JSONObject()));assertEquals(0,response.reads);
            response=new FakeConnection();response.body=new byte[path.endsWith("import")?1_400_001:16385];Arrays.fill(response.body,(byte)' ');assertEquals("native_access_unavailable",postError(path,new JSONObject()));
        }
    }

    private static final class FakeConnection extends HttpsURLConnection {
        int status=200,reads;long length=-1;boolean disconnected,noErrorStream,errorReadFailure;String type="application/json; charset=utf-8",encoding;
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
        @Override public InputStream getErrorStream(){reads++;if(noErrorStream)return null;if(errorReadFailure)return new InputStream(){@Override public int read()throws java.io.IOException{throw new java.io.IOException("synthetic lost body");}};return new ByteArrayInputStream(body);}
        @Override public OutputStream getOutputStream(){return output;}
        @Override public void disconnect(){disconnected=true;}
        @Override public boolean usingProxy(){return false;}
        @Override public void connect(){}
        @Override public String getCipherSuite(){return "TLS_SYNTHETIC_TEST_ONLY";}
        @Override public Certificate[] getLocalCertificates(){return null;}
        @Override public Certificate[] getServerCertificates(){return new Certificate[0];}
    }
}
