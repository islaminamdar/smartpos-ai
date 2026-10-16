package info.internext.pos.storage;

import android.content.Context;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Base64;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import info.internext.pos.offline.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import javax.net.ssl.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.*;
import static org.junit.Assert.*;

/** Opt-in local commissioning: real TLS + production routes + isolated PostgreSQL.
 * Only synthetic auth transport is supplied by the runner. Never uses the production host.
 * A failed run retains its exact namespaced custody and cannot be blindly rerun. */
@RunWith(AndroidJUnit4.class)
public class NativeServerCommissioningTest {
    private static final String PIN="62849173";
    private Context context;private JSONObject config;private String runId,stage="not_started";private File configFile,marker;
    private CookieHandler previousCookies;private SSLSocketFactory tls;private Map<String,PublicKey> pins;
    private final List<Device> devices=new ArrayList<>();private boolean completed,cookieOwner,ownedRun;
    private static String uuid(){return UUID.randomUUID().toString();}
    @Before public void setup()throws Exception{
        String name=InstrumentationRegistry.getArguments().getString("commissioningConfig");
        Assume.assumeTrue("Explicit local HTTPS/PG commissioning config is required",name!=null);
        assertTrue(name.matches("commissioning-[a-f0-9-]{36}\\.json"));context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        configFile=new File(context.getNoBackupFilesDir(),name);assertTrue(configFile.isFile());assertTrue(configFile.length()<=65536);
        config=new JSONObject(read(configFile));runId=config.getString("runId");assertEquals(UUID.fromString(runId).toString(),runId);assertEquals("commissioning-"+runId+".json",name);assertEquals(9443,config.getInt("localPort"));assertEquals(2,config.getJSONArray("devices").length());
        marker=new File(context.getNoBackupFilesDir(),"commissioning-"+runId+".started");assertTrue("Never retry an uncertain commissioning run with the same ID",marker.createNewFile());ownedRun=true;
        X509Certificate ca=(X509Certificate)CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(Base64.decode(config.getString("caDerBase64"),Base64.DEFAULT)));assertTrue(ca.getBasicConstraints()>=0);
        KeyStore trust=KeyStore.getInstance(KeyStore.getDefaultType());trust.load(null);trust.setCertificateEntry("synthetic-local-ca",ca);TrustManagerFactory managers=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());managers.init(trust);SSLContext ssl=SSLContext.getInstance("TLSv1.2");ssl.init(null,managers.getTrustManagers(),new SecureRandom());tls=ssl.getSocketFactory();
        pins=Collections.singletonMap(config.getString("serverKeyId"),SignedProtocol.publicKey(SignedProtocol.decode(config.getString("serverPublicKeySpkiBase64Url"),256)));
        previousCookies=CookieHandler.getDefault();CookieHandler.setDefault(null);cookieOwner=true;
    }
    @After public void cleanup()throws Exception{
        if(context==null||!ownedRun)return;
        JSONObject evidence=new JSONObject().put("schemaVersion",1).put("runId",runId==null?JSONObject.NULL:runId).put("status",completed?"financial_completed":"failed").put("cleanup",completed?"pending":"retained_for_review").put("stage",stage).put("historicalRevocation",config.optBoolean("historicalRevocation",false)).put("physicalDevices",0).put("emulatorRuntimes",1).put("isolatedStorageNamespaces",devices.size());
        try{JSONArray rows=new JSONArray();for(Device d:devices){try{rows.put(d.evidence());}catch(Exception ignored){rows.put(new JSONObject().put("deviceId",d.scope.opt("deviceId")).put("status","evidence_unavailable"));}}evidence.put("devices",rows);
            if(runId!=null)try(FileOutputStream out=new FileOutputStream(new File(context.getCacheDir(),"commissioning-"+runId+"-result.json"))){out.write(evidence.toString().getBytes(StandardCharsets.UTF_8));}
        }finally{
            for(Device d:devices)d.close();if(cookieOwner)CookieHandler.setDefault(previousCookies);
            if(completed){for(Device d:devices)d.deleteOwned();assertTrue(configFile.delete());assertTrue(marker.delete());evidence.put("status","completed").put("cleanup","completed");try(FileOutputStream out=new FileOutputStream(new File(context.getCacheDir(),"commissioning-"+runId+"-result.json"))){out.write(evidence.toString().getBytes(StandardCharsets.UTF_8));}}
        }
    }
    @Test public void twoInstallationsIssueOfflineReconcileLostAckContinueAndCloseThroughRealServer()throws Exception{
        stage="tls_default_trust_refusal";HttpsURLConnection untrusted=(HttpsURLConnection)new URL("https://127.0.0.1:9443/api/pos/native/access").openConnection();untrusted.setConnectTimeout(5000);untrusted.setReadTimeout(5000);try{try{untrusted.getResponseCode();fail("The synthetic CA must not be trusted by platform defaults");}catch(SSLHandshakeException expected){/* No trust-all/global trust mutation. */}}finally{untrusted.disconnect();}
        stage="prepare_two_independent_installations";for(int i=0;i<2;i++){Device d=new Device(i,config.getJSONArray("devices").getJSONObject(i));devices.add(d);d.open(true);d.prepare(true);}
        assertNotEquals(devices.get(0).journal.installationId(),devices.get(1).journal.installationId());assertNotEquals(devices.get(0).identityJson.getString("deviceKeySha256"),devices.get(1).identityJson.getString("deviceKeySha256"));assertDisjointRanges();
        stage="offline_issuance_and_local_restart";for(Device d:devices){d.online=false;int sent=d.requests;d.issue();d.issue();assertEquals(sent,d.requests);assertEquals(2,d.count("outbox"));String saved=d.receipts.toString(),installation=d.journal.installationId();d.open(false);assertEquals(installation,d.journal.installationId());d.offline.unlockWithPin(PIN.toCharArray());for(int i=0;i<d.intents.size();i++){assertEquals("committed",d.checkout().confirmPaymentIntent(d.intents.get(i)).getString("state"));assertEquals(d.envelopes.get(i),d.text("SELECT envelope_json FROM receipts WHERE intent_id=?",d.intents.get(i)));}assertEquals(2,d.count("receipts"));assertEquals(saved,d.receipts.toString());d.offline.finishAuthorityWithPin(d.authority(),PIN.toCharArray());assertEquals(sent,d.requests);}
        if(config.optBoolean("historicalRevocation",false)){stage="revoke_current_access_after_offline_issuance";control("historical-revoke");for(Device d:devices){d.online=true;NativeAccessError denied=assertThrows(NativeAccessError.class,()->d.session.getAccessState());assertEquals("native_authentication_failed",denied.code);assertEquals(d.scope.getString("actorId"),d.store.read().getString("actorId"));}}
        stage="real_server_lost_ack_and_exact_replay";for(Device d:devices){d.online=true;d.loseImport=true;d.reconcile();assertTrue(d.lostImports==1);assertEquals(2,d.count("outbox"));assertEquals(0,d.count("acknowledgements"));d.open(false);d.reconcile();assertEquals(0,d.count("outbox"));assertEquals(2,d.count("acknowledgements"));assertEquals(1,d.count("offline_seal_confirmations"));d.assertOriginalReplay();}
        if(config.optBoolean("historicalRevocation",false)){stage="restore_current_access_after_historical_reconciliation";control("historical-restore");for(Device d:devices)assertEquals("signed_in",d.session.getAccessState().getString("status"));}
        stage="same_shift_next_allocation";for(Device d:devices){String previous=d.authority(),oldRows=d.rows("receipts"),oldAcks=d.rows("acknowledgements");assertEquals("completed",d.offline.continueAfterAllocationWithPin(previous,PIN.toCharArray()).getString("status"));d.prepare(false);assertNotEquals(previous,d.authority());assertEquals(oldRows,d.rows("receipts"));assertEquals(oldAcks,d.rows("acknowledgements"));d.online=false;int sent=d.requests;d.issue();assertEquals(sent,d.requests);assertEquals(3,d.count("receipts"));d.offline.finishAuthorityWithPin(d.authority(),PIN.toCharArray());d.online=true;d.reconcile();assertEquals(3,d.count("acknowledgements"));assertEquals(2,d.count("offline_seal_confirmations"));assertEquals(0,d.count("outbox"));}
        assertDisjointRanges();stage="close_exact_original_drawers";for(Device d:devices){NativeShiftClose close=new NativeShiftClose(d.journal,d.session,d.offline);assertEquals("ready",close.checkWithPin(PIN.toCharArray()).getString("status"));JSONObject result=close.closeWithPin(d.scope.getString("shiftId"),13000,PIN.toCharArray());assertEquals("closed",result.getString("status"));assertEquals(13000,result.getJSONObject("result").getLong("expectedCashFils"));assertEquals(0,result.getJSONObject("result").getLong("cashDifferenceFils"));d.closeResult=result;assertEquals(0,d.count("offline_upload_exceptions"));}
        stage="completed";completed=true;
    }
    /** Test runner controls only: never passes through the production transport or origin. */
    private void control(String action)throws Exception{
        assertTrue(config.getBoolean("historicalRevocation"));assertTrue(action.equals("historical-revoke")||action.equals("historical-restore"));String token=config.getString("testControlToken");assertTrue(token.matches("[a-f0-9]{64}"));
        byte[] body=new JSONObject().put("token",token).put("runId",runId).toString().getBytes(StandardCharsets.UTF_8);
        HttpsURLConnection c=(HttpsURLConnection)new URL("https://127.0.0.1:9443/__test/"+action).openConnection();c.setSSLSocketFactory(tls);c.setInstanceFollowRedirects(false);c.setConnectTimeout(5000);c.setReadTimeout(10000);c.setRequestMethod("POST");c.setRequestProperty("Content-Type","application/json");c.setDoOutput(true);c.setFixedLengthStreamingMode(body.length);
        try{try(OutputStream out=c.getOutputStream()){out.write(body);}assertEquals(200,c.getResponseCode());ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream in=c.getInputStream()){byte[] buffer=new byte[256];int n;while((n=in.read(buffer))!=-1){assertTrue(bytes.size()+n<=1024);bytes.write(buffer,0,n);}}JSONObject result=new JSONObject(bytes.toString("UTF-8"));assertEquals(1,result.length());assertEquals("applied",result.getString("status"));}finally{c.disconnect();Arrays.fill(body,(byte)0);}
    }
    private void assertDisjointRanges()throws Exception{List<long[]> all=new ArrayList<>();for(Device d:devices)for(int i=0;i<d.ranges.length();i++){JSONObject r=d.ranges.getJSONObject(i);long first=r.getLong("first"),last=r.getLong("last");for(long[] old:all)assertTrue(last<old[0]||first>old[1]);all.add(new long[]{first,last});}}
    private final class Device {
        final JSONObject scope;final String prefix;NativeJournal journal;DeviceIdentity identity;JSONObject identityJson;SecureSessionStore store;NativeSession session;NativeClockSource clock;NativeStaffUnlock unlock;NativeOfflineCoordinator offline;
        boolean online=true,loseImport;int requests,lostImports;final List<String> intents=new ArrayList<>(),envelopes=new ArrayList<>();final JSONArray receipts=new JSONArray(),ranges=new JSONArray();JSONObject closeResult;
        Device(int index,JSONObject scope){this.scope=scope;prefix="commissioning-"+runId+"-"+index;}
        String alias(String kind){return "internext.pos.test."+prefix+"."+kind;}
        void open(boolean fresh)throws Exception{
            close();journal=new NativeJournal(context,prefix+"-ledger.db",()->{});identity=new DeviceIdentity(alias("identity"));identityJson=identity.readOrCreate(journal);store=new SecureSessionStore(context,prefix+".bin",alias("session"));
            if(fresh){JSONObject state=store.read();state.put("actorId",scope.getString("actorId")).put("counter",new JSONObject().put("actorId",scope.get("actorId")).put("id",scope.get("deviceId")).put("branchId",config.get("branchId")).put("name","Synthetic local commissioning"));state.getJSONObject("cookies").put("pos-access",scope.getString("accessToken")).put("pos-device-"+scope.getString("actorId"),scope.getString("deviceToken"));store.write(state);}
            session=new NativeSession(store,new NativePosHttp(store,this::connection),journal);clock=new NativeClockSource(context,journal,prefix+"-clock.db",alias("clock"),()->new NativeClockSource.Observation(Settings.Global.getInt(context.getContentResolver(),Settings.Global.BOOT_COUNT),SystemClock.elapsedRealtime(),System.currentTimeMillis()));unlock=new NativeStaffUnlock(context,journal,clock,prefix+"-pin.db",alias("pin"),NativeStaffUnlock.mainScheduler(),SystemClock::elapsedRealtime);offline=new NativeOfflineCoordinator(journal,session,identity,clock,unlock,pins);
        }
        void prepare(boolean first)throws Exception{offline.beginPreparation();JSONObject state=offline.prepareWithPin(PIN.toCharArray(),first?PIN.toCharArray():null);assertEquals("prepared",state.getString("status"));JSONObject a=payload(text("SELECT authority_envelope FROM offline_bundles WHERE id=?",authority()),pins);ranges.put(new JSONObject().put("authorityId",a.getString("id")).put("first",a.getJSONObject("invoiceRange").getLong("first")).put("last",a.getJSONObject("invoiceRange").getLong("last")));}
        String authority()throws Exception{return store.read().getJSONObject("offline").getJSONObject("reservation").getString("requestId");}
        NativeCheckoutEngine engine()throws Exception{return offline.checkoutContext(false).engine;}
        NativeCheckoutCoordinator checkout(){return new NativeCheckoutCoordinator(journal,new NativeCheckoutCoordinator.ContextSource(){public NativeCheckoutCoordinator.CheckoutContext load(boolean required)throws Exception{return offline.checkoutContext(required);}public NativeCheckoutCoordinator.CheckoutContext historical(String authority,boolean required)throws Exception{return offline.historicalCheckoutContext(authority,required);}},true);}
        void issue()throws Exception{String id=uuid();JSONObject input=new JSONObject().put("authorityId",authority()).put("serviceType","takeaway").put("customer",JSONObject.NULL).put("lines",new JSONArray().put(new JSONObject().put("productId",config.getString("productId")).put("quantityMilli",1000))).put("cashTenderedFils",1000).put("recordedCardFils",0).put("presentedTotalFils",1000);NativeCheckoutCoordinator enabled=checkout(),production=new NativeCheckoutCoordinator(journal,offline);assertFalse(production.getState().getBoolean("canIssue"));assertEquals("native_checkout_not_enabled",production.getState().getString("reasonCode"));assertThrows(Exception.class,()->production.beginPaymentIntent(uuid(),input));JSONObject draft=new JSONObject(input.toString());draft.remove("presentedTotalFils");draft.put("tenderMode","cash");JSONObject quote=enabled.quoteBasket(draft);assertEquals(1000,quote.getJSONObject("totals").getLong("grossFils"));assertEquals("payment_confirmation_required",enabled.beginPaymentIntent(id,quote.getJSONObject("request")).getString("state"));assertEquals("committed",enabled.confirmPaymentIntent(id).getString("state"));String envelope=text("SELECT envelope_json FROM receipts WHERE intent_id=?",id);assertEquals("committed",enabled.confirmPaymentIntent(id).getString("state"));assertEquals(envelope,text("SELECT envelope_json FROM receipts WHERE intent_id=?",id));JSONObject p=payload(envelope,Collections.singletonMap(identityJson.getString("deviceKeySha256"),SignedProtocol.publicKey(SignedProtocol.decode(identityJson.getString("publicKeySpkiBase64Url"),256))));assertEquals(intents.size()+1,p.getLong("deviceSequence"));intents.add(id);envelopes.add(envelope);JSONObject doc=p.getJSONObject("document");receipts.put(new JSONObject().put("issuanceId",p.getString("id")).put("documentId",doc.getString("id")).put("documentNumber",doc.getString("documentNumber")).put("payloadSha256",NativeJournal.payloadHash(envelope)).put("authorityId",p.getString("authorityId")).put("deviceSequence",p.getLong("deviceSequence")));}
        void reconcile()throws Exception{new NativeReconciliation(journal,identity,pins,session::historicalRequest).reconcile();}
        void assertOriginalReplay()throws Exception{JSONObject response=session.historicalRequest("/api/pos/offline/import",new JSONObject(envelopes.get(0)));assertEquals("accepted",response.getString("status"));assertTrue(response.getBoolean("replayed"));String before=rows("acknowledgements");JSONObject ack=response.getJSONObject("acknowledgement");engine().acknowledgeIssuance(ack.toString());assertEquals(before,rows("acknowledgements"));}
        long count(String table){try(android.database.Cursor c=journal.getReadableDatabase().rawQuery("SELECT count(*) FROM "+table,null)){assertTrue(c.moveToFirst());return c.getLong(0);}}
        String text(String sql,String arg){try(android.database.Cursor c=journal.getReadableDatabase().rawQuery(sql,new String[]{arg})){assertTrue(c.moveToFirst());return c.getString(0);}}
        String rows(String table){JSONArray a=new JSONArray();try(android.database.Cursor c=journal.getReadableDatabase().rawQuery("SELECT * FROM "+table+" ORDER BY rowid",null)){while(c.moveToNext()){JSONArray r=new JSONArray();for(int i=0;i<c.getColumnCount();i++)r.put(c.getString(i));a.put(r);}}return a.toString();}
        JSONObject evidence()throws Exception{return new JSONObject().put("deviceId",scope.get("deviceId")).put("installationId",identityJson.get("installationId")).put("deviceKeySha256",identityJson.get("deviceKeySha256")).put("receipts",receipts).put("allocations",ranges).put("requestCount",requests).put("lostImportResponses",lostImports).put("acknowledgements",count("acknowledgements")).put("sealConfirmations",count("offline_seal_confirmations")).put("outbox",count("outbox")).put("close",closeResult==null?JSONObject.NULL:closeResult);}
        HttpsURLConnection connection(URL original)throws Exception{assertEquals("https",original.getProtocol());assertEquals("pos.internext.info",original.getHost());assertEquals(-1,original.getPort());assertNull(original.getQuery());assertTrue(original.getPath().startsWith("/api/pos/"));if(!online)throw new IOException("Synthetic network disconnected");requests++;HttpsURLConnection actual=(HttpsURLConnection)new URL("https://127.0.0.1:9443"+original.getPath()).openConnection();actual.setSSLSocketFactory(tls);return new LocalConnection(original,actual,this);}
        void close(){if(offline!=null){offline.close();offline=null;}if(journal!=null){journal.close();journal=null;}}
        void deleteOwned()throws Exception{for(String kind:new String[]{"ledger","clock","pin"})assertTrue(context.deleteDatabase(prefix+"-"+kind+".db"));for(String suffix:new String[]{"",".bak",".new"}){File f=new File(context.getNoBackupFilesDir(),prefix+".bin"+suffix);if(f.exists())assertTrue(f.delete());}KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);for(String kind:new String[]{"identity","session","clock","pin"}){ks.deleteEntry(alias(kind));assertFalse(ks.containsAlias(alias(kind)));}}
    }
    private static JSONObject payload(String envelope,Map<String,PublicKey> keys)throws Exception{return (JSONObject)SignedProtocol.verify(envelope,keys).payload();}
    private static String read(File file)throws IOException{try(InputStream in=new FileInputStream(file)){ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] b=new byte[4096];int n;while((n=in.read(b))!=-1)out.write(b,0,n);return out.toString("UTF-8");}}
    /** Delegates every byte to real TLS. The only fault is losing one already-committed response. */
    private final class LocalConnection extends HttpsURLConnection {
        final HttpsURLConnection actual;final Device device;LocalConnection(URL original,HttpsURLConnection actual,Device device){super(original);this.actual=actual;this.device=device;}
        @Override public InputStream getInputStream()throws IOException{InputStream in=actual.getInputStream();if(url.getPath().equals("/api/pos/offline/import")&&device.loseImport){device.loseImport=false;device.lostImports++;in.close();throw new IOException("Synthetic response lost after real server commit");}return in;}
        @Override public OutputStream getOutputStream()throws IOException{return actual.getOutputStream();}@Override public InputStream getErrorStream(){return actual.getErrorStream();}@Override public int getResponseCode()throws IOException{return actual.getResponseCode();}
        @Override public void setRequestMethod(String method)throws ProtocolException{actual.setRequestMethod(method);}@Override public void setRequestProperty(String name,String value){actual.setRequestProperty(name,value);}@Override public String getRequestProperty(String name){return actual.getRequestProperty(name);}
        @Override public void setInstanceFollowRedirects(boolean v){actual.setInstanceFollowRedirects(v);}@Override public void setConnectTimeout(int v){actual.setConnectTimeout(v);}@Override public void setReadTimeout(int v){actual.setReadTimeout(v);}@Override public void setUseCaches(boolean v){actual.setUseCaches(v);}@Override public void setDoOutput(boolean v){actual.setDoOutput(v);}@Override public void setFixedLengthStreamingMode(int v){actual.setFixedLengthStreamingMode(v);}
        @Override public Map<String,List<String>> getHeaderFields(){return actual.getHeaderFields();}@Override public String getHeaderField(String name){return actual.getHeaderField(name);}@Override public String getContentType(){return actual.getContentType();}@Override public long getContentLengthLong(){return actual.getContentLengthLong();}
        @Override public void disconnect(){actual.disconnect();}@Override public boolean usingProxy(){return actual.usingProxy();}@Override public void connect()throws IOException{actual.connect();}@Override public String getCipherSuite(){return actual.getCipherSuite();}@Override public Certificate[] getLocalCertificates(){return actual.getLocalCertificates();}@Override public Certificate[] getServerCertificates()throws SSLPeerUnverifiedException{return actual.getServerCertificates();}
    }
}
