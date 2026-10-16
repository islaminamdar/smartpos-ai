package info.internext.pos.storage;

import static org.junit.Assert.*;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.OfflineBundle;
import info.internext.pos.offline.OfflineClock;
import info.internext.pos.offline.SignedProtocol;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real Android SQLite and Keystore, synthetic profiles and ephemeral server signing key only. */
@RunWith(AndroidJUnit4.class)
public class NativeUnsupportedTextTest {
    private Context context; private String dbName,alias; private NativeJournal journal; private DeviceIdentity identity;
    private NativeCheckoutEngine engine; private OfflineBundle.Binding binding; private KeyPair server; private PublicKey device;
    private JSONObject snapshot,authority; private String snapshotEnvelope,authorityEnvelope,boot=UUID.randomUUID().toString();
    private final long start=1_792_132_200_000L; private long wall=start,elapsed=1000; private boolean locked=false,failSigning=false,failCommit=false;
    private NativeCheckoutCoordinator checkout;private OfflineBundle currentBundle;private boolean signedOut;
    private AtomicInteger signatures=new AtomicInteger();
    @Before public void setUp() throws Exception {
        context=InstrumentationRegistry.getInstrumentation().getTargetContext(); dbName="unsupported-text-audit-"+UUID.randomUUID()+".db";alias="internext.pos.test.unsupportedtext."+UUID.randomUUID();
        journal=new NativeJournal(context,dbName,()->{if(failCommit)throw new IllegalStateException("synthetic_full_disk");});
        identity=new DeviceIdentity(alias);JSONObject id=identity.readOrCreate(journal);device=SignedProtocol.publicKey(SignedProtocol.decode(id.getString("publicKeySpkiBase64Url"),256));
        KeyPairGenerator gen=KeyPairGenerator.getInstance("EC");gen.initialize(new ECGenParameterSpec("secp256r1"));server=gen.generateKeyPair();
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream in=InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("pos-offline-output.json")){byte[] b=new byte[4096];int n;while((n=in.read(b))!=-1)bytes.write(b,0,n);}
        JSONObject reservation=new JSONObject(bytes.toString("UTF-8")).getJSONObject("reservation");snapshot=reservation.getJSONObject("snapshot");authority=reservation.getJSONObject("authority");
        authority.put("deviceKeySha256",id.getString("deviceKeySha256")).put("issuedAt",NativeCheckoutEngine.iso(start)).put("notBefore",NativeCheckoutEngine.iso(start)).put("expiresAt",NativeCheckoutEngine.iso(start+3_600_000));
        snapshot.put("createdAt",NativeCheckoutEngine.iso(start));
        binding=new OfflineBundle.Binding(authority.getString("organizationId"),authority.getString("branchId"),authority.getString("deviceId"),authority.getString("actorId"),authority.getString("shiftId"),authority.getString("keyEpoch"),authority.getString("deviceKeySha256"));
        rebuild();engine=createEngine(journal);engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start);currentBundle=verifiedBundle();checkout=coordinator(true);
    }
    private NativeCheckoutEngine createEngine(NativeJournal j)throws Exception{return new NativeCheckoutEngine(j,Collections.singletonMap("synthetic-server",server.getPublic()),binding,device,b->{if(locked)throw new IllegalStateException("locked");},()->new OfflineClock.Reading(boot,elapsed,wall),bytes->{signatures.incrementAndGet();if(failSigning)throw new IllegalStateException("signing_failed");return identity.sign(bytes);});}
    private void rebuild()throws Exception{authority.put("snapshotSha256",SignedProtocol.hash(CanonicalJson.bytes(snapshot)));snapshotEnvelope=SignedProtocol.sign(snapshot,"synthetic-server",server.getPrivate(),server.getPublic());authorityEnvelope=SignedProtocol.sign(authority,"synthetic-server",server.getPrivate(),server.getPublic());}
    @After public void tearDown()throws Exception{if(journal!=null)journal.close();assertTrue(context.deleteDatabase(dbName));KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);ks.deleteEntry(alias);assertFalse(ks.containsAlias(alias));}
    private String id(){return UUID.randomUUID().toString();}
    private JSONObject input()throws Exception{return new JSONObject().put("authorityId",authority.getString("id")).put("serviceType","takeaway").put("customer",JSONObject.NULL).put("lines",new JSONArray().put(new JSONObject().put("productId",snapshot.getJSONArray("products").getJSONObject(0).getString("id")).put("quantityMilli",1000))).put("cashTenderedFils",1000).put("recordedCardFils",0).put("presentedTotalFils",1000);}
    private JSONObject payload(String envelope)throws Exception{return (JSONObject)SignedProtocol.verify(envelope,Collections.singletonMap(SignedProtocol.fingerprint(device),device)).payload();}
    private long value(String query){try(Cursor c=journal.getReadableDatabase().rawQuery(query,null)){assertTrue(c.moveToFirst());return c.getLong(0);}}
    private long count(String table){return value("SELECT count(*) FROM "+table);}
    private String sell()throws Exception{String id=id();engine.beginPaymentIntent(id,input());return engine.commitPaymentIntent(id);}
    private void reopen()throws Exception{journal.close();journal=new NativeJournal(context,dbName,()->{if(failCommit)throw new IllegalStateException("synthetic_full_disk");});engine=createEngine(journal);checkout=coordinator(true);}
    private OfflineBundle verifiedBundle()throws Exception{return OfflineBundle.verify(snapshotEnvelope,authorityEnvelope,Collections.singletonMap("synthetic-server",server.getPublic()),binding);}
    private NativeCheckoutCoordinator coordinator(boolean enabled){return new NativeCheckoutCoordinator(journal,required->{if(signedOut)throw new NativeAccessError("native_session_expired");if(required&&locked)throw new NativeAccessError("pin_unlock_required");return new NativeCheckoutCoordinator.CheckoutContext(currentBundle,engine);},enabled);}
    private JSONObject draft()throws Exception{JSONObject r=input();r.remove("presentedTotalFils");return r.put("tenderMode","cash").put("cashTenderedFils",JSONObject.NULL).put("recordedCardFils",JSONObject.NULL);}
    private String canonical(JSONObject value)throws Exception{return new String(CanonicalJson.bytes(value),java.nio.charset.StandardCharsets.UTF_8);}
    private void fails(org.junit.function.ThrowingRunnable run){assertThrows(Exception.class,run);}
    private void differentAuthority()throws Exception{authority.put("id",id());rebuild();currentBundle=verifiedBundle();}
    private JSONObject buyer(String name,String address)throws Exception{return new JSONObject().put("name",name).put("address",address).put("trn",JSONObject.NULL);}
    private String nul(){return String.valueOf((char)0);}
    private String text(String sql){try(Cursor c=journal.getReadableDatabase().rawQuery(sql,null)){assertTrue(c.moveToFirst());return c.isNull(0)?null:c.getString(0);}}
    private String financialState()throws Exception{return new JSONObject().put("next",value("SELECT next_number FROM offline_authority_state")).put("gross",value("SELECT gross_fils FROM offline_authority_state")).put("clock",text("SELECT clock_json FROM offline_authority_state")).put("sequence",value("SELECT sequence FROM offline_chain")).put("event",text("SELECT event_hash FROM offline_chain")==null?JSONObject.NULL:text("SELECT event_hash FROM offline_chain")).toString();}
    private String legacyIntent(JSONObject request)throws Exception{
        // Test-only historical fixture: use the pre-existing journal seam, never a production bypass.
        String pending=id();SQLiteDatabase db=journal.getWritableDatabase();db.beginTransaction();try{
            journal.beginIntent(pending,canonical(request),NativeCheckoutEngine.iso(start));
            db.execSQL("INSERT INTO offline_intent_context(intent_id,authority_id,order_id,document_id) VALUES(?,?,?,?)",new Object[]{pending,currentBundle.authorityId,id(),id()});db.setTransactionSuccessful();
        }finally{db.endTransaction();}return pending;
    }
    private String signLegacy(JSONObject sale)throws Exception{
        byte[] exact=CanonicalJson.bytes(sale);return new JSONObject().put("format","pos-signed-v1").put("alg","ECDSA-P256-SHA256-DER").put("keyId",SignedProtocol.fingerprint(device)).put("payloadBase64Url",SignedProtocol.encode(exact)).put("signatureBase64Url",SignedProtocol.encode(identity.sign(exact))).toString();
    }
    @Test public void newQuotesRejectNulBuyerNameAndAddressBeforeAnyLedgerWrite()throws Exception{
        String before=financialState();for(String field:new String[]{"name","address"}){
            JSONObject customer=buyer("Synthetic buyer","Synthetic address").put(field,"before"+nul()+"after");
            Exception failure=assertThrows(Exception.class,()->checkout.quoteBasket(draft().put("customer",customer)));assertEquals("unsupported_text",failure.getMessage());
        }
        assertEquals(before,financialState());assertEquals(0,count("intents"));assertEquals(0,count("receipts"));assertEquals(0,count("outbox"));assertEquals(0,signatures.get());
    }
    @Test public void newBeginRejectsNulEvenWhenQuoteIsBypassed()throws Exception{
        String before=financialState();for(String field:new String[]{"name","address"}){
            JSONObject request=input().put("customer",buyer("Synthetic buyer","Synthetic address").put(field,"before"+nul()+"after"));
            assertEquals("unsupported_text",assertThrows(Exception.class,()->engine.beginPaymentIntent(id(),request)).getMessage());
            assertEquals("unsupported_text",assertThrows(Exception.class,()->checkout.beginPaymentIntent(id(),request)).getMessage());
        }
        assertEquals(before,financialState());assertEquals(0,count("intents"));assertEquals(0,count("offline_intent_context"));assertEquals(0,count("receipts"));assertEquals(0,count("outbox"));
    }
    @Test public void historicalUnissuedNulRemainsReadableButCannotIssueAndCanFreezeExactBytes()throws Exception{
        JSONObject request=input().put("customer",buyer("Old"+nul()+"buyer","Old"+nul()+"address"));String pending=legacyIntent(request),before=financialState(),exact=canonical(request);
        JSONObject view=checkout.getPaymentIntent(pending);assertEquals(exact,canonical(view.getJSONObject("request")));assertFalse(view.getBoolean("canConfirm"));assertEquals("unsupported_text",view.getString("reasonCode"));
        assertEquals("payment_confirmation_required",engine.beginPaymentIntent(pending,request).getString("state"));
        assertEquals("unsupported_text",assertThrows(Exception.class,()->engine.commitPaymentIntent(pending)).getMessage());
        assertEquals("unsupported_text",assertThrows(Exception.class,()->checkout.confirmPaymentIntent(pending)).getMessage());
        assertEquals(before,financialState());assertEquals(0,count("receipts"));assertEquals(0,count("outbox"));
        String signed=engine.freezePaymentIntentForManager(pending);JSONObject proof=payload(signed);assertEquals(exact,canonical(proof.getJSONObject("request")));assertEquals(NativeJournal.hash(exact),proof.getString("requestSha256"));
        assertEquals(before,financialState());assertEquals("frozen_for_manager",checkout.getPaymentIntent(pending).getString("state"));reopen();assertEquals(signed,engine.freezePaymentIntentForManager(pending));assertEquals(exact,text("SELECT request_json FROM intents"));
        locked=true;fails(()->checkout.getPaymentIntent(pending));fails(()->checkout.freezePaymentIntentForManager(pending));assertEquals(0,count("receipts"));assertEquals(1,count("offline_intent_freezes"));
    }
    @Test public void historicalIssuedNulRetainsOriginalSignatureReceiptAndExactReplay()throws Exception{
        // Generate a genuine signed first receipt, then seed a second historical record with
        // the same valid arithmetic and a NUL customer that older native code accepted.
        String first=sell();JSONObject prior=payload(first),request=input().put("customer",buyer("Old"+nul()+"buyer","Old"+nul()+"address"));String pending=legacyIntent(request);
        String order,document;try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT order_id,document_id FROM offline_intent_context WHERE intent_id=?",new String[]{pending})){assertTrue(c.moveToFirst());order=c.getString(0);document=c.getString(1);}
        JSONObject sale=new JSONObject(prior.toString()).put("id",order).put("paymentIntentId",pending).put("deviceSequence",2).put("previousEventSha256",SignedProtocol.hash(CanonicalJson.bytes(prior)));
        sale.getJSONObject("document").put("id",document).put("orderId",order).put("documentNumber","TEST-INV-0000000002").put("customer",request.get("customer"));String signed=signLegacy(sale);
        SQLiteDatabase db=journal.getWritableDatabase();db.beginTransaction();try{
            journal.commitVerifiedIssuance(pending,canonical(request),order,"TEST-INV-0000000002",NativeCheckoutEngine.iso(start),1000,signed);
            db.execSQL("UPDATE offline_chain SET sequence=2,event_hash=? WHERE slot=1",new Object[]{SignedProtocol.hash(CanonicalJson.bytes(sale))});db.execSQL("UPDATE offline_authority_state SET next_number=3,gross_fils=2000");db.setTransactionSuccessful();
        }finally{db.endTransaction();}
        String before=financialState();int signedCount=signatures.get();reopen();wall+=7_200_000;elapsed+=7_200_000;
        assertEquals(signed,engine.commitPaymentIntent(pending));assertEquals("committed",engine.beginPaymentIntent(pending,request).getString("state"));assertEquals("Old"+nul()+"buyer",checkout.getReceipt(order).getJSONObject("customer").getString("name"));
        assertEquals("committed",checkout.confirmPaymentIntent(pending).getString("state"));assertEquals(canonical(request),canonical(checkout.getPaymentIntent(pending).getJSONObject("request")));
        assertEquals(before,financialState());assertEquals(signedCount,signatures.get());assertEquals(2,count("receipts"));assertEquals(2,count("outbox"));assertEquals(0,count("acknowledgements"));fails(()->engine.freezePaymentIntentForManager(pending));
    }
    private void acceptedText(String name,String address)throws Exception{
        JSONObject quote=checkout.quoteBasket(draft().put("customer",buyer(name,address)));String pending=id();checkout.beginPaymentIntent(pending,quote.getJSONObject("request"));JSONObject receipt=checkout.confirmPaymentIntent(pending).getJSONObject("receipt");
        assertEquals(name,receipt.getJSONObject("customer").getString("name"));assertEquals(address,receipt.getJSONObject("customer").getString("address"));assertEquals(1,count("receipts"));assertEquals(1,count("outbox"));assertEquals(1,signatures.get());
    }
    @Test public void literalBackslashUnicodeEscapeIsOrdinaryText()throws Exception{acceptedText("Literal "+((char)92)+"u0000 buyer","Literal "+((char)92)+"u0000 address");}
    @Test public void arabicAndEmojiRemainValidAndUnmodified()throws Exception{acceptedText("عميل تجريبي 🍰","دبي 🏠 شارع تجريبي");}
    @Test public void OtherEmbeddedControlsAreNotMistakenForNul()throws Exception{acceptedText("Synthetic\tbuyer","Line one\nLine two");}
}
