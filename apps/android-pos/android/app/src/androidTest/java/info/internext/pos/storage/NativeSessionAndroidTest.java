package info.internext.pos.storage;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import javax.net.ssl.HttpsURLConnection;
import java.io.*;
import java.net.CookieHandler;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.util.*;
import static org.junit.Assert.*;

/** Synthetic HTTP only; session, enrollment and uncertain outcomes use real private storage. */
@RunWith(AndroidJUnit4.class)
public class NativeSessionAndroidTest {
    private static final String ACTOR="11111111-1111-4111-8111-111111111111",BRANCH="22222222-2222-4222-8222-222222222222",OTHER="33333333-3333-4333-8333-333333333333",DEVICE="44444444-4444-4444-8444-444444444444";
    private Context context;private String file,alias,db;private NativeJournal journal;private SecureSessionStore store;private NativeSession session;
    private final ArrayDeque<Reply> replies=new ArrayDeque<>();private final List<Reply> sent=new ArrayList<>();private CookieHandler oldHandler;
    @Before public void setup()throws Exception{
        context=InstrumentationRegistry.getInstrumentation().getTargetContext();file="session-test-"+UUID.randomUUID()+".bin";alias="internext.pos.test.session."+UUID.randomUUID();db="session-test-"+UUID.randomUUID()+".db";
        oldHandler=CookieHandler.getDefault();CookieHandler.setDefault(null);store=new SecureSessionStore(context,file,alias);journal=new NativeJournal(context,db,()->{});reopen();
    }
    private void reopen()throws Exception{
        store=new SecureSessionStore(context,file,alias);NativePosHttp http=new NativePosHttp(store,url->{Reply r=replies.remove();assertEquals(r.expectedPath,url.getPath());sent.add(r);return r;});session=new NativeSession(store,http,journal);
    }
    @After public void cleanup()throws Exception{
        CookieHandler.setDefault(oldHandler);if(journal!=null)journal.close();context.deleteDatabase(db);
        for(String suffix:new String[]{"",".bak",".new"}){File f=new File(context.getNoBackupFilesDir(),file+suffix);if(f.exists())assertTrue(f.delete());}
        KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);keys.deleteEntry(alias);assertFalse(keys.containsAlias(alias));
    }
    private JSONObject device(String id,String branch)throws Exception{return new JSONObject().put("id",id).put("branchId",branch).put("name","Counter 1");}
    private JSONObject access(String actor,JSONObject device)throws Exception{return new JSONObject().put("schemaVersion",1).put("status","signed_in").put("actorId",actor).put("branches",new JSONArray().put(new JSONObject().put("id",BRANCH).put("organizationId",OTHER).put("name","Synthetic branch").put("role","manager"))).put("device",device==null?JSONObject.NULL:device).put("canPrepareOffline",false);}
    private Reply queue(String path,JSONObject body)throws Exception{Reply r=new Reply(path,body.toString());replies.add(r);return r;}
    private Reply access(JSONObject device)throws Exception{return queue("/api/pos/native/access",access(ACTOR,device));}
    private Reply login(String actor)throws Exception{return queue("/api/pos/session",new JSONObject().put("status","authenticated").put("userId",actor)).cookies("pos-access=synthetic-access; Secure; HttpOnly; Path=/","pos-refresh=synthetic-refresh; Secure; HttpOnly; Path=/");}
    private void signedIn()throws Exception{login(ACTOR);access(null);session.signIn("Synthetic@Example.invalid","synthetic-password".toCharArray());}
    private Reply enrolled()throws Exception{return queue("/api/pos/native/device",new JSONObject().put("status","enrolled").put("device",device(DEVICE,BRANCH)));}
    private void enrolledCounter()throws Exception{signedIn();access(null);enrolled();access(device(DEVICE,BRANCH));session.enrollCounter(BRANCH,"Counter 1");}
    private Reply logout()throws Exception{return queue("/api/pos/session",new JSONObject().put("status","signed_out")).cookies("pos-access=; Max-Age=0; Secure; HttpOnly; Path=/","pos-refresh=; Max-Age=0; Secure; HttpOnly; Path=/");}
    private void code(String expected,org.junit.function.ThrowingRunnable operation)throws Exception{assertEquals(expected,assertThrows(NativeAccessError.class,operation).code);}

    @Test public void loginWipesCallerPasswordAndNeverPersistsItOrReturnsCookies()throws Exception{
        Reply post=login(ACTOR);access(null);char[] password="synthetic-password".toCharArray();JSONObject result=session.signIn(" Synthetic@Example.invalid ",password);
        for(char c:password)assertEquals('\0',c);JSONObject body=new JSONObject(post.output.toString("UTF-8"));assertEquals("synthetic@example.invalid",body.getString("email"));
        assertFalse(store.read().toString().contains("synthetic-password"));assertFalse(result.toString().contains("synthetic-access"));assertFalse(result.has("cookies"));
        assertEquals(ACTOR,store.read().getString("actorId"));assertFalse(result.getBoolean("canPrepareOffline"));
    }
    @Test public void failedLoginWipesPasswordAndUncertainCookieOutcomeRequiresLogout()throws Exception{
        Reply post=login(ACTOR);post.raw="broken";char[] password="synthetic-password".toCharArray();code("native_sign_out_pending",()->session.signIn("synthetic@example.invalid",password));
        for(char c:password)assertEquals('\0',c);assertTrue(store.read().getBoolean("logoutPending"));reopen();assertEquals("signed_out",session.getAccessState().getString("status"));
        int count=sent.size();code("native_sign_out_pending",()->session.signIn("synthetic@example.invalid",new char[]{'x'}));assertEquals(count,sent.size());
        logout();session.signOut();assertTrue(store.read().isNull("actorId"));assertFalse(store.read().getBoolean("logoutPending"));
    }
    @Test public void lostEnrollmentResponseRecoversSameBindingFromFreshAccess()throws Exception{
        signedIn();access(null);Reply failed=enrolled();failed.raw="broken";code("native_enrollment_uncertain",()->session.enrollCounter(BRANCH,"Counter 1"));
        JSONObject saved=store.read();String token=saved.getJSONObject("cookies").getString("pos-device-"+ACTOR);assertTrue(token.matches("[a-f0-9]{64}"));assertTrue(failed.getRequestProperty("Cookie").contains(token));
        assertEquals("Counter 1",saved.getJSONObject("enrollment").getString("name"));assertTrue(saved.isNull("counter"));
        reopen();access(device(DEVICE,BRANCH));assertEquals(DEVICE,session.getAccessState().getJSONObject("device").getString("id"));
        assertEquals(token,store.read().getJSONObject("cookies").getString("pos-device-"+ACTOR));assertTrue(store.read().isNull("enrollment"));assertEquals(1,sent.stream().filter(r->r.expectedPath.endsWith("/device")).count());
    }
    @Test public void uncertainEnrollmentRetryPreservesTokenAndFrozenBody()throws Exception{
        signedIn();access(null);Reply failed=enrolled();failed.raw="broken";code("native_enrollment_uncertain",()->session.enrollCounter(BRANCH,"Counter 1"));
        access(null);code("native_enrollment_uncertain",()->session.enrollCounter(BRANCH,"Changed name"));
        access(null);Reply retry=enrolled();access(device(DEVICE,BRANCH));session.enrollCounter(BRANCH,"Counter 1");
        assertEquals(failed.getRequestProperty("Cookie"),retry.getRequestProperty("Cookie"));assertEquals(failed.output.toString("UTF-8"),retry.output.toString("UTF-8"));
    }
    @Test public void explicitSignoutFailureLocksDisplayAndRetriesWithoutLosingCounter()throws Exception{
        enrolledCounter();String token=store.read().getJSONObject("cookies").getString("pos-device-"+ACTOR);Reply lost=logout();lost.raw="broken";
        code("native_sign_out_pending",session::signOut);reopen();assertEquals("signed_out",session.getAccessState().getString("status"));assertEquals(DEVICE,store.read().getJSONObject("counter").getString("id"));
        logout();session.signOut();assertFalse(store.read().getBoolean("logoutPending"));assertTrue(store.read().isNull("actorId"));assertEquals(token,store.read().getJSONObject("cookies").getString("pos-device-"+ACTOR));
        login(ACTOR);access(device(DEVICE,BRANCH));assertEquals("signed_in",session.signIn("synthetic@example.invalid",new char[]{'x'}).getString("status"));
    }
    @Test public void differentActorCannotAdoptCounterAndFailedRemoteLogoutStaysPending()throws Exception{
        enrolledCounter();logout();session.signOut();login(OTHER);Reply failed=logout();failed.fail=true;
        code("native_counter_account_required",()->session.signIn("other@example.invalid",new char[]{'x'}));assertTrue(store.read().getBoolean("logoutPending"));assertEquals(ACTOR,store.read().getJSONObject("counter").getString("actorId"));
        assertEquals("signed_out",session.getAccessState().getString("status"));logout();session.signOut();assertEquals(ACTOR,store.read().getJSONObject("counter").getString("actorId"));
    }
    @Test public void refreshRotationIsNotOverwrittenByCounterReconciliation()throws Exception{
        enrolledCounter();access(device(DEVICE,BRANCH)).cookies("pos-access=rotated-access; Secure; HttpOnly; Path=/","pos-refresh=rotated-refresh; Secure; HttpOnly; Path=/");session.getAccessState();reopen();
        assertEquals("rotated-refresh",store.read().getJSONObject("cookies").getString("pos-refresh"));assertEquals(DEVICE,store.read().getJSONObject("counter").getString("id"));
    }
    @Test public void changedOrMissingServerDeviceCannotReplaceCounter()throws Exception{
        enrolledCounter();access(device(OTHER,BRANCH));code("native_counter_account_required",session::getAccessState);access(null);code("native_counter_account_required",session::getAccessState);
        assertEquals(DEVICE,store.read().getJSONObject("counter").getString("id"));assertEquals(1,sent.stream().filter(r->r.expectedPath.endsWith("/device")).count());
    }
    @Test public void foreignEnrollmentBranchCannotBeStoredAsCounter()throws Exception{
        signedIn();access(null);queue("/api/pos/native/device",new JSONObject().put("status","enrolled").put("device",device(DEVICE,OTHER)));
        code("native_enrollment_uncertain",()->session.enrollCounter(BRANCH,"Counter 1"));assertTrue(store.read().isNull("counter"));assertEquals(BRANCH,store.read().getJSONObject("enrollment").getString("branchId"));
    }
    @Test public void expiredSessionClearsOnlyAuthAndPreservesCounter()throws Exception{
        enrolledCounter();Reply expired=access(null);expired.status=401;code("native_session_expired",session::getAccessState);
        JSONObject state=store.read();assertTrue(state.isNull("actorId"));assertFalse(state.getJSONObject("cookies").has("pos-access"));assertTrue(state.getJSONObject("cookies").has("pos-device-"+ACTOR));assertEquals(DEVICE,state.getJSONObject("counter").getString("id"));
    }
    @Test public void orphanCookiesOrLedgerCustodyCannotBeSilentlyAdopted()throws Exception{
        JSONObject data=store.read();data.getJSONObject("cookies").put("pos-access","orphan");store.write(data);reopen();assertEquals("signed_out",session.getAccessState().getString("status"));assertTrue(store.read().getBoolean("logoutPending"));assertEquals(0,sent.size());
        journal.getWritableDatabase().execSQL("INSERT INTO intents(id,request_hash,request_json,created_at) VALUES('synthetic-intent','synthetic-hash','{}','synthetic-time')");
        code("native_storage_unavailable",this::reopen);assertTrue(journal.hasCustody());
    }
    @Test public void cashierCannotEnrollAndUnanticipatedExistingBindingRequiresReview()throws Exception{
        signedIn();JSONObject cashier=access(ACTOR,null);cashier.getJSONArray("branches").getJSONObject(0).put("role","cashier");queue("/api/pos/native/access",cashier);
        code("native_authentication_failed",()->session.enrollCounter(BRANCH,"Counter 1"));assertTrue(store.read().isNull("enrollment"));
        access(device(DEVICE,BRANCH));code("native_counter_account_required",session::getAccessState);assertTrue(store.read().isNull("counter"));
    }
    @Test public void unicodeWhitespaceNameCannotFreezeUnfulfillableEnrollment()throws Exception{
        for(String name:new String[]{"\u00a0","\ufeff","\u2003"," \u00a0\ufeff\u2003 "})
            code("native_access_unavailable",()->session.enrollCounter(BRANCH,name));
        assertEquals(0,sent.size());assertTrue(store.read().isNull("enrollment"));assertEquals(0,store.read().getJSONObject("cookies").length());
    }
    @Test public void unicodeBoundaryWhitespaceUsesServerNormalizationBeforeFreezingBody()throws Exception{
        signedIn();access(null);Reply post=enrolled();post.raw="broken";
        code("native_enrollment_uncertain",()->session.enrollCounter(BRANCH,"\u00a0\ufeffCounter 1\u2003\ufeff"));
        assertEquals("Counter 1",new JSONObject(post.output.toString("UTF-8")).getString("name"));
        assertEquals("Counter 1",store.read().getJSONObject("enrollment").getString("name"));
        access(null);Reply retry=enrolled();access(device(DEVICE,BRANCH));session.enrollCounter(BRANCH,"Counter 1");
        assertEquals(post.output.toString("UTF-8"),retry.output.toString("UTF-8"));assertTrue(store.read().isNull("enrollment"));
    }
    private static final class Reply extends HttpsURLConnection{
        final String expectedPath;String raw;int status=200;boolean fail;final ByteArrayOutputStream output=new ByteArrayOutputStream();final Map<String,List<String>> headers=new HashMap<>();
        Reply(String path,String raw)throws Exception{super(new URL("https://pos.internext.info"+path));this.expectedPath=path;this.raw=raw;}
        Reply cookies(String... cookies){headers.put("Set-Cookie",Arrays.asList(cookies));return this;}
        @Override public int getResponseCode()throws IOException{if(fail)throw new IOException("synthetic-network-failure");return status;}
        @Override public Map<String,List<String>> getHeaderFields(){return headers;}
        @Override public String getContentType(){return "application/json";}
        @Override public String getHeaderField(String name){return null;}
        @Override public long getContentLengthLong(){return -1;}
        @Override public InputStream getInputStream(){return new ByteArrayInputStream(raw.getBytes(StandardCharsets.UTF_8));}
        @Override public OutputStream getOutputStream(){return output;}
        @Override public void disconnect(){}
        @Override public boolean usingProxy(){return false;}
        @Override public void connect(){}
        @Override public String getCipherSuite(){return "TLS_SYNTHETIC_ONLY";}
        @Override public Certificate[] getLocalCertificates(){return null;}
        @Override public Certificate[] getServerCertificates(){return new Certificate[0];}
    }
}
