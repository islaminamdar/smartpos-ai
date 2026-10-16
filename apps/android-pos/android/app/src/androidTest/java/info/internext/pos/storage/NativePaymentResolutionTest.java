package info.internext.pos.storage;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.ContentValues;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
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
public class NativePaymentResolutionTest {
    private Context context; private String dbName,alias; private NativeJournal journal; private DeviceIdentity identity;
    private NativeCheckoutEngine engine; private OfflineBundle.Binding binding; private KeyPair server; private PublicKey device;
    private JSONObject snapshot,authority; private String snapshotEnvelope,authorityEnvelope,boot=UUID.randomUUID().toString();
    private final long start=1_792_132_200_000L; private long wall=start,elapsed=1000; private boolean locked=false,failSigning=false,failCommit=false,failObservation=false;
    private NativeCheckoutCoordinator checkout;private OfflineBundle currentBundle;private boolean signedOut;
    private AtomicInteger signatures=new AtomicInteger();
    private final List<String> migrationDbs=new ArrayList<>();
    @Before public void setUp() throws Exception {
        context=InstrumentationRegistry.getInstrumentation().getTargetContext(); dbName="payment-resolution-audit-"+UUID.randomUUID()+".db";alias="internext.pos.test.paymentresolution."+UUID.randomUUID();
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
    private NativeCheckoutEngine createEngine(NativeJournal j)throws Exception{return new NativeCheckoutEngine(j,Collections.singletonMap("synthetic-server",server.getPublic()),binding,device,b->{if(locked)throw new IllegalStateException("locked");},()->{if(failObservation)throw new IllegalStateException("clock_source_blocked");return new OfflineClock.Reading(boot,elapsed,wall);},bytes->{signatures.incrementAndGet();if(failSigning)throw new IllegalStateException("signing_failed");return identity.sign(bytes);});}
    private void rebuild()throws Exception{authority.put("snapshotSha256",SignedProtocol.hash(CanonicalJson.bytes(snapshot)));snapshotEnvelope=SignedProtocol.sign(snapshot,"synthetic-server",server.getPrivate(),server.getPublic());authorityEnvelope=SignedProtocol.sign(authority,"synthetic-server",server.getPrivate(),server.getPublic());}
    @After public void tearDown()throws Exception{if(journal!=null)journal.close();assertTrue(context.deleteDatabase(dbName));for(String db:migrationDbs){context.deleteDatabase(db);assertFalse(context.getDatabasePath(db).exists());}KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);ks.deleteEntry(alias);assertFalse(ks.containsAlias(alias));}
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
    private String text(String query){try(Cursor c=journal.getReadableDatabase().rawQuery(query,null)){assertTrue(c.moveToFirst());return c.isNull(0)?null:c.getString(0);}}
    private String begin()throws Exception{String intent=id();engine.beginPaymentIntent(intent,input());return intent;}
    private String freeze(String intent)throws Exception{return engine.freezePaymentIntentForManager(intent);}
    private JSONObject freezeValues(String intent)throws Exception{
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT * FROM offline_intent_freezes WHERE intent_id=?",new String[]{intent})){
            assertTrue(c.moveToFirst());JSONObject row=new JSONObject();for(int i=0;i<c.getColumnCount();i++)row.put(c.getColumnName(i),c.isNull(i)?JSONObject.NULL:c.getString(i));return row;
        }
    }
    private ContentValues values(JSONObject row)throws Exception{
        ContentValues result=new ContentValues();java.util.Iterator<String> names=row.keys();while(names.hasNext()){String name=names.next();if(row.isNull(name))result.putNull(name);else result.put(name,row.getString(name));}return result;
    }
    private String challenge(){return UUID.randomUUID().toString().replace("-","")+UUID.randomUUID().toString().replace("-","");}
    private String frozen()throws Exception{String id=begin();freeze(id);return id;}
    private JSONObject result(String intent,String decision)throws Exception{
        JSONObject f=payload(text("SELECT proof_envelope FROM offline_intent_freezes WHERE intent_id='"+intent+"'"));
        JSONObject r=new JSONObject().put("kind","offline-payment-resolution").put("schemaVersion",1).put("purpose","reconciliation-only")
            .put("resolutionId",id()).put("requestId",id()).put("freezeId",f.getString("freezeId")).put("freezeSha256",text("SELECT proof_payload_sha256 FROM offline_intent_freezes WHERE intent_id='"+intent+"'"))
            .put("managerActorId",id()).put("decision",decision).put("evidenceSha256",SignedProtocol.hash(CanonicalJson.bytes(new JSONArray())))
            .put("resolvedAt",NativeCheckoutEngine.iso(start+7200000)).put("replacement",JSONObject.NULL);
        for(String key:new String[]{"paymentIntentId","requestSha256","orderId","documentId","organizationId","branchId","deviceId","actorId","shiftId","keyEpoch","authorityId","authoritySha256","snapshotSha256"})r.put(key,f.get(key));
        return r;
    }
    private JSONObject handoff(String intent,String nonce,String state,Object resolutionHash,Object issuanceHash)throws Exception{
        JSONObject f=payload(text("SELECT proof_envelope FROM offline_intent_freezes WHERE intent_id='"+intent+"'"));
        return new JSONObject().put("kind","native-payment-resolution-status").put("schemaVersion",1).put("purpose","reconciliation-only")
            .put("challenge",nonce).put("serverTimeMs",start+7200000).put("authorityId",f.getString("authorityId")).put("keyEpoch",f.getString("keyEpoch"))
            .put("deviceId",f.getString("deviceId")).put("freezeId",f.getString("freezeId")).put("freezeSha256",text("SELECT proof_payload_sha256 FROM offline_intent_freezes WHERE intent_id='"+intent+"'"))
            .put("state",state).put("resolutionSha256",resolutionHash).put("issuanceSha256",issuanceHash);
    }
    private JSONObject signed(JSONObject p)throws Exception{return new JSONObject(SignedProtocol.sign(p,"synthetic-server",server.getPrivate(),server.getPublic()));}
    private JSONObject response(String intent,JSONObject resolution,String nonce)throws Exception{
        return new JSONObject().put("handoff",signed(handoff(intent,nonce,"resolved",SignedProtocol.hash(CanonicalJson.bytes(resolution)),JSONObject.NULL)))
            .put("resolutionEnvelope",signed(resolution)).put("receipt",JSONObject.NULL).put("acknowledgement",JSONObject.NULL);
    }
    private JSONObject status(String intent,String nonce,String state)throws Exception{
        return new JSONObject().put("handoff",signed(handoff(intent,nonce,state,JSONObject.NULL,JSONObject.NULL)))
            .put("resolutionEnvelope",JSONObject.NULL).put("receipt",JSONObject.NULL).put("acknowledgement",JSONObject.NULL);
    }
    private NativeCheckoutEngine historical(String intent)throws Exception{return NativeCheckoutEngine.forHistorical(journal,Collections.singletonMap("synthetic-server",server.getPublic()),device,identity::sign,intent);}
    private String preserved()throws Exception{
        JSONObject all=new JSONObject();
        for(String table:new String[]{"intents","offline_intent_context","offline_intent_freezes","receipts","outbox","acknowledgements","offline_authority_state","offline_chain","offline_bundles","offline_intent_cancellations"}){
            JSONArray rows=new JSONArray();try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT * FROM "+table+" ORDER BY rowid",null)){while(c.moveToNext()){JSONObject row=new JSONObject();for(int i=0;i<c.getColumnCount();i++)row.put(c.getColumnName(i),c.isNull(i)?JSONObject.NULL:c.getString(i));rows.put(row);}}all.put(table,rows);
        }return canonical(all);
    }
    @Test public void signedFullReturnPersistsTerminalOutcomeAcrossRestartWithoutFinancialOrClockChanges()throws Exception{
        String intent=frozen(),original=preserved(),nonce=challenge();JSONObject terminal=result(intent,"funds_returned"),wire=response(intent,terminal,nonce);
        JSONObject accepted=engine.acceptPaymentResolution(intent,wire,nonce);assertEquals("resolved_funds_returned",accepted.getString("status"));assertEquals(intent,accepted.getString("intentId"));assertEquals(terminal.getString("resolutionId"),accepted.getString("resolutionId"));
        assertEquals(original,preserved());reopen();JSONObject view=engine.getIntent(intent);assertEquals("manager_resolved",view.getString("state"));JSONObject review=view.getJSONObject("managerReview");assertEquals("accepted_on_device",review.getString("status"));assertEquals("funds_returned",review.getString("decision"));assertFalse(view.toString().contains("payloadBase64Url"));
        fails(()->engine.commitPaymentIntent(intent));fails(()->engine.cancelUncollectedIntent(intent,"No money collected"));assertEquals(original,preserved());
        assertEquals("payment_confirmation_required",engine.beginPaymentIntent(id(),input()).getString("state"));
    }
    @Test public void cardAuthorizationVoidRequiresOriginalCardOnlyTender()throws Exception{
        String cash=frozen(),n=challenge();fails(()->engine.acceptPaymentResolution(cash,response(cash,result(cash,"payment_voided"),n),n));assertEquals("frozen_for_manager",engine.getIntent(cash).getString("state"));
    }
    @Test public void validCardOnlyVoidIsTerminalAndNeverCreatesReceipt()throws Exception{
        String intent=id();engine.beginPaymentIntent(intent,input().put("cashTenderedFils",0).put("recordedCardFils",1000));freeze(intent);String original=preserved(),n=challenge();
        assertEquals("resolved_payment_voided",engine.acceptPaymentResolution(intent,response(intent,result(intent,"payment_voided"),n),n).getString("status"));assertEquals(original,preserved());assertEquals(0,count("receipts"));
    }
    @Test public void historicalQueryAndAcceptanceNeedNoCurrentLoginPinOrSellingClock()throws Exception{
        String intent=frozen(),n=challenge(),original=preserved();locked=true;signedOut=true;failObservation=true;
        NativeCheckoutEngine history=historical(intent);JSONObject request=history.paymentResolutionRequest(intent,n);assertEquals(2,request.length());JSONObject query=payload(request.getJSONObject("queryEnvelope").toString());
        assertEquals("offline-payment-resolution-query",query.getString("kind"));assertEquals(n,query.getString("challenge"));assertEquals(binding.keyEpoch,query.getString("keyEpoch"));assertEquals(binding.deviceId,query.getString("deviceId"));assertEquals(text("SELECT proof_envelope FROM offline_intent_freezes"),request.getJSONObject("freezeEnvelope").toString());
        assertEquals("resolved_funds_returned",history.acceptPaymentResolution(intent,response(intent,result(intent,"funds_returned"),n),n).getString("status"));assertEquals(original,preserved());fails(()->checkout.getPaymentIntent(intent));
    }
    @Test public void wrongSignatureAndUnknownKeyRejectWithoutChangingOriginalFrozenCustody()throws Exception{
        String intent=frozen(),n=challenge(),original=preserved();JSONObject r=result(intent,"funds_returned"),wire=response(intent,r,n);
        KeyPairGenerator g=KeyPairGenerator.getInstance("EC");g.initialize(new ECGenParameterSpec("secp256r1"));KeyPair stranger=g.generateKeyPair();
        final JSONObject bad=new JSONObject(wire.toString()).put("resolutionEnvelope",new JSONObject(SignedProtocol.sign(r,"synthetic-server",stranger.getPrivate(),stranger.getPublic())));
        fails(()->engine.acceptPaymentResolution(intent,bad,n));final JSONObject unknown=new JSONObject(wire.toString()).put("resolutionEnvelope",new JSONObject(SignedProtocol.sign(r,"unknown-server",server.getPrivate(),server.getPublic())));
        fails(()->engine.acceptPaymentResolution(intent,unknown,n));JSONObject h=new JSONObject(wire.toString()).put("handoff",new JSONObject(SignedProtocol.sign(handoff(intent,n,"resolved",SignedProtocol.hash(CanonicalJson.bytes(r)),JSONObject.NULL),"synthetic-server",stranger.getPrivate(),stranger.getPublic())));
        fails(()->engine.acceptPaymentResolution(intent,h,n));assertEquals(original,preserved());assertEquals("frozen_for_manager",engine.getIntent(intent).getString("state"));
    }
    @Test public void allOriginalScopeAndHashFieldsMustMatchStoredFrozenIntent()throws Exception{
        String intent=frozen(),original=preserved();JSONObject valid=result(intent,"funds_returned");
        for(String key:new String[]{"freezeId","freezeSha256","paymentIntentId","requestSha256","orderId","documentId","organizationId","branchId","deviceId","actorId","shiftId","keyEpoch","authorityId","authoritySha256","snapshotSha256"}){
            JSONObject altered=new JSONObject(valid.toString()).put(key,key.endsWith("Sha256")?challenge():id());String n=challenge();fails(()->engine.acceptPaymentResolution(intent,response(intent,altered,n),n));assertEquals(key,original,preserved());
        }assertEquals("frozen_for_manager",engine.getIntent(intent).getString("state"));
    }
    @Test public void statusNonceScopeAndHashCannotBeReplayedOrSubstituted()throws Exception{
        String intent=frozen(),n=challenge(),original=preserved();JSONObject r=result(intent,"funds_returned"),wire=response(intent,r,n);
        fails(()->engine.acceptPaymentResolution(intent,wire,challenge()));
        for(String key:new String[]{"authorityId","keyEpoch","deviceId","freezeId","freezeSha256","resolutionSha256"}){
            JSONObject h=handoff(intent,n,"resolved",SignedProtocol.hash(CanonicalJson.bytes(r)),JSONObject.NULL).put(key,key.endsWith("Sha256")?challenge():id());JSONObject bad=new JSONObject(wire.toString()).put("handoff",signed(h));fails(()->engine.acceptPaymentResolution(intent,bad,n));
        }assertEquals(original,preserved());assertEquals("frozen_for_manager",engine.getIntent(intent).getString("state"));
    }
    @Test public void strictSchemaRejectsReplacementUnsupportedDecisionAndConfusedPurpose()throws Exception{
        String intent=frozen(),original=preserved();JSONObject valid=result(intent,"funds_returned");
        for(JSONObject altered:new JSONObject[]{new JSONObject(valid.toString()).put("decision","current_time_invoice"),new JSONObject(valid.toString()).put("replacement",new JSONObject()),new JSONObject(valid.toString()).put("purpose","selling"),new JSONObject(valid.toString()).put("extra",true),new JSONObject(valid.toString()).put("evidenceSha256","bad"),new JSONObject(valid.toString()).put("schemaVersion",2)}){
            String n=challenge();fails(()->engine.acceptPaymentResolution(intent,response(intent,altered,n),n));
        }
        String n=challenge();JSONObject wire=response(intent,valid,n).put("receipt",new JSONObject());fails(()->engine.acceptPaymentResolution(intent,wire,n));assertEquals(original,preserved());
    }
    @Test public void signedPendingAndConflictRetainOriginalFreezeAndBlockNewSaleAcrossRestart()throws Exception{
        String intent=frozen(),original=preserved(),n=challenge();assertEquals("pending",engine.acceptPaymentResolution(intent,status(intent,n,"pending"),n).getString("status"));reopen();assertEquals("pending",engine.getIntent(intent).getJSONObject("managerReview").getString("status"));fails(()->engine.beginPaymentIntent(id(),input()));
        n=challenge();assertEquals("resolution_conflict",engine.acceptPaymentResolution(intent,status(intent,n,"conflict"),n).getString("status"));reopen();assertEquals("conflict",engine.getIntent(intent).getJSONObject("managerReview").getString("status"));fails(()->engine.sealAuthority(currentBundle.authorityId));assertEquals(original,preserved());
    }
    @Test public void nonFrozenIntentCannotRequestOrAcceptManagerResult()throws Exception{
        String target=begin(),n=challenge();fails(()->engine.paymentResolutionRequest(target,n));String envelope=engine.commitPaymentIntent(target);String frozen=frozen();JSONObject wire=response(frozen,result(frozen,"funds_returned"),n);String original=preserved();
        fails(()->engine.acceptPaymentResolution(target,wire,n));assertEquals(envelope,engine.commitPaymentIntent(target));assertEquals(original,preserved());
    }
    @Test public void duplicateResignedResultKeepsFirstExactResponseAndStalePendingNeverRegresses()throws Exception{
        String intent=frozen(),n=challenge();JSONObject r=result(intent,"funds_returned");engine.acceptPaymentResolution(intent,response(intent,r,n),n);String first=text("SELECT response_json FROM offline_payment_results");
        reopen();String next=challenge();engine.acceptPaymentResolution(intent,response(intent,r,next),next);assertEquals(first,text("SELECT response_json FROM offline_payment_results"));assertEquals(1,count("offline_payment_results"));
        String stale=challenge();engine.acceptPaymentResolution(intent,status(intent,stale,"pending"),stale);assertEquals("manager_resolved",engine.getIntent(intent).getString("state"));assertEquals(first,text("SELECT response_json FROM offline_payment_results"));
    }
    @Test public void contradictoryValidResultLatchesAndCannotOverwriteOriginalOrReleaseHold()throws Exception{
        String intent=frozen(),n=challenge();JSONObject r=result(intent,"funds_returned");engine.acceptPaymentResolution(intent,response(intent,r,n),n);String first=text("SELECT response_json FROM offline_payment_results"),original=preserved();
        JSONObject changed=new JSONObject(r.toString()).put("resolutionId",id());String next=challenge();assertEquals("resolution_conflict",engine.acceptPaymentResolution(intent,response(intent,changed,next),next).getString("status"));
        reopen();assertEquals(first,text("SELECT response_json FROM offline_payment_results"));assertEquals(1,count("offline_payment_conflicts"));fails(()->engine.beginPaymentIntent(id(),input()));fails(()->engine.sealAuthority(currentBundle.authorityId));assertEquals(original,preserved());
        String retry=challenge();assertEquals("resolution_conflict",engine.acceptPaymentResolution(intent,response(intent,r,retry),retry).getString("status"));assertEquals(1,count("offline_payment_results"));
    }
    @Test public void signedConflictAfterAcceptedResultRemainsDurableAndPreservesOutcome()throws Exception{
        String intent=frozen(),n=challenge();engine.acceptPaymentResolution(intent,response(intent,result(intent,"funds_returned"),n),n);String first=text("SELECT response_json FROM offline_payment_results"),next=challenge();
        assertEquals("resolution_conflict",engine.acceptPaymentResolution(intent,status(intent,next,"conflict"),next).getString("status"));reopen();assertEquals(first,text("SELECT response_json FROM offline_payment_results"));fails(()->engine.beginPaymentIntent(id(),input()));assertEquals("conflict",engine.getIntent(intent).getJSONObject("managerReview").getString("status"));
    }
    @Test public void storageFailureRollsBackAcceptanceAndExactRetryWorksAfterRestart()throws Exception{
        String intent=frozen(),n=challenge(),original=preserved();JSONObject r=response(intent,result(intent,"funds_returned"),n);
        journal.getWritableDatabase().execSQL("CREATE TRIGGER synthetic_result_full BEFORE INSERT ON offline_payment_results BEGIN SELECT RAISE(ABORT,'synthetic_disk_full'); END");
        fails(()->engine.acceptPaymentResolution(intent,r,n));assertEquals(0,count("offline_payment_results"));assertEquals(original,preserved());assertEquals("frozen_for_manager",engine.getIntent(intent).getString("state"));
        journal.getWritableDatabase().execSQL("DROP TRIGGER synthetic_result_full");reopen();assertEquals("resolved_funds_returned",engine.acceptPaymentResolution(intent,r,n).getString("status"));assertEquals(original,preserved());
    }
    @Test public void acceptedResultRowsAreImmutableAndCorruptionCannotSilentlyReleaseHold()throws Exception{
        String intent=frozen(),n=challenge();engine.acceptPaymentResolution(intent,response(intent,result(intent,"funds_returned"),n),n);SQLiteDatabase db=journal.getWritableDatabase();
        assertThrows(SQLiteException.class,()->db.execSQL("UPDATE offline_payment_results SET payload_sha256=? WHERE intent_id=?",new Object[]{challenge(),intent}));assertThrows(SQLiteException.class,()->db.delete("offline_payment_results","intent_id=?",new String[]{intent}));
        ContentValues row=new ContentValues();try(Cursor c=db.rawQuery("SELECT * FROM offline_payment_results",null)){assertTrue(c.moveToFirst());for(int i=0;i<c.getColumnCount();i++)row.put(c.getColumnName(i),c.getString(i));}
        assertThrows(SQLiteException.class,()->db.insertWithOnConflict("offline_payment_results",null,row,SQLiteDatabase.CONFLICT_REPLACE));
        List<String> triggers=new ArrayList<>();try(Cursor c=db.rawQuery("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='offline_payment_results'",null)){while(c.moveToNext())triggers.add(c.getString(0));}
        for(String trigger:triggers)db.execSQL("DROP TRIGGER "+trigger);db.execSQL("UPDATE offline_payment_results SET payload_sha256=? WHERE intent_id=?",new Object[]{challenge(),intent});
        fails(()->engine.getIntent(intent));fails(()->engine.beginPaymentIntent(id(),input()));fails(()->engine.sealAuthority(currentBundle.authorityId));assertEquals(0,count("receipts"));assertEquals(1,count("offline_intent_freezes"));
    }
    private void acknowledge(String receipt)throws Exception{
        JSONObject proof=payload(receipt),ack=new JSONObject().put("kind","offline-ack").put("schemaVersion",1).put("id",id()).put("issuanceId",proof.getString("id"))
            .put("payloadSha256",NativeJournal.payloadHash(receipt)).put("authorityId",proof.getString("authorityId")).put("keyEpoch",binding.keyEpoch).put("deviceSequence",proof.getLong("deviceSequence")).put("receivedAt",NativeCheckoutEngine.iso(start));
        engine.acknowledgeIssuance(SignedProtocol.sign(ack,"synthetic-server",server.getPrivate(),server.getPublic()));
    }
    @Test public void resultDoesNotChangePriorReceiptAcknowledgementOrPendingOutbox()throws Exception{
        String acknowledged=sell();acknowledge(acknowledged);String pending=sell();String intent=frozen(),original=preserved(),n=challenge();
        assertEquals(1,count("acknowledgements"));assertEquals(1,count("outbox"));assertEquals("resolved_funds_returned",engine.acceptPaymentResolution(intent,response(intent,result(intent,"funds_returned"),n),n).getString("status"));assertEquals(original,preserved());
        assertEquals(acknowledged,engine.commitPaymentIntent(payload(acknowledged).getString("paymentIntentId")));assertEquals(pending,engine.commitPaymentIntent(payload(pending).getString("paymentIntentId")));assertEquals(original,preserved());
    }
    @Test public void independentConnectionsAcceptSameResultExactlyOnce()throws Exception{
        String intent=frozen(),n=challenge();JSONObject r=response(intent,result(intent,"funds_returned"),n);NativeJournal secondJournal=new NativeJournal(context,dbName,()->{});NativeCheckoutEngine second=createEngine(secondJournal);CountDownLatch gate=new CountDownLatch(1);AtomicReference<Throwable> error=new AtomicReference<>();AtomicInteger accepted=new AtomicInteger();
        Thread a=new Thread(()->{try{gate.await();engine.acceptPaymentResolution(intent,r,n);accepted.incrementAndGet();}catch(Throwable t){error.set(t);}}),b=new Thread(()->{try{gate.await();second.acceptPaymentResolution(intent,new JSONObject(r.toString()),n);accepted.incrementAndGet();}catch(Throwable t){error.set(t);}});
        try{a.start();b.start();gate.countDown();a.join(10000);b.join(10000);assertFalse(a.isAlive());assertFalse(b.isAlive());if(error.get()!=null)throw new AssertionError(error.get());assertEquals(2,accepted.get());assertEquals(1,count("offline_payment_results"));assertEquals(0,count("offline_payment_conflicts"));assertEquals(0,count("receipts"));}finally{secondJournal.close();}
    }
    private JSONObject rows(SQLiteDatabase db,String table)throws Exception{
        JSONObject result=new JSONObject();JSONArray rows=new JSONArray();try(Cursor c=db.rawQuery("SELECT * FROM "+table+" ORDER BY rowid",null)){while(c.moveToNext()){JSONObject row=new JSONObject();for(int i=0;i<c.getColumnCount();i++)row.put(c.getColumnName(i),c.isNull(i)?JSONObject.NULL:c.getString(i));rows.put(row);}}return result.put("rows",rows);
    }
    @Test public void genuineVersionFourUpgradePreservesFreezeReceiptsKeysAndClockBeforeResultAcceptance()throws Exception{
        String first=sell();acknowledge(first);sell();String intent=frozen();String originalProof=text("SELECT proof_envelope FROM offline_intent_freezes"),installation=journal.installationId();
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream in=InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("native-ledger-historical-schema.json")){byte[] b=new byte[4096];int n;while((n=in.read(b))!=-1)bytes.write(b,0,n);}
        JSONObject ddl=new JSONObject(bytes.toString("UTF-8"));String historical="payment-resolution-v4-"+id()+".db";migrationDbs.add(historical);java.util.Map<String,String> expected=new java.util.HashMap<>();
        String[] tables={"installation","device_key","intents","receipts","outbox","acknowledgements","offline_bundles","offline_authority_state","offline_chain","offline_intent_context","offline_intent_cancellations","offline_seal_confirmations","offline_upload_exceptions","offline_intent_freezes"};
        try(SQLiteDatabase old=SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(historical),null)){
            old.setForeignKeyConstraintsEnabled(true);old.execSQL("PRAGMA recursive_triggers=ON");for(int version=1;version<=3;version++){JSONArray commands=ddl.getJSONArray("version"+version);for(int i=0;i<commands.length();i++)old.execSQL(commands.getString(i));}
            // This unchanged version-4 helper predates the additive resolution schema.
            NativeCheckoutEngine.createFreezeTables(old);
            for(String table:tables){JSONArray data=rows(journal.getReadableDatabase(),table).getJSONArray("rows");for(int i=0;i<data.length();i++)old.insertOrThrow(table,null,values(data.getJSONObject(i)));expected.put(table,canonical(rows(old,table)));}
            try(Cursor missing=old.rawQuery("SELECT name FROM sqlite_master WHERE name='offline_payment_results'",null)){assertEquals(0,missing.getCount());}old.setVersion(4);assertEquals(4,old.getVersion());
        }
        try(NativeJournal migrated=new NativeJournal(context,historical,()->{})){
            assertEquals(8,migrated.getReadableDatabase().getVersion());assertEquals(installation,migrated.installationId());assertEquals(binding.deviceKeySha256,identity.readOrCreate(migrated).getString("deviceKeySha256"));
            for(String table:tables)assertEquals(table,expected.get(table),canonical(rows(migrated.getReadableDatabase(),table)));
            NativeCheckoutEngine upgraded=createEngine(migrated);assertEquals(originalProof,upgraded.freezePaymentIntentForManager(intent));String n=challenge();assertEquals("resolved_funds_returned",upgraded.acceptPaymentResolution(intent,response(intent,result(intent,"funds_returned"),n),n).getString("status"));
            for(String table:tables)assertEquals(table,expected.get(table),canonical(rows(migrated.getReadableDatabase(),table)));
        }
    }
    private NativePaymentRecovery recovery(NativePaymentRecovery.Transport transport)throws Exception{return new NativePaymentRecovery(journal,identity,Collections.singletonMap("synthetic-server",server.getPublic()),transport);}
    @Test public void orchestrationRetriesOriginalProofWithNewChallengeAfterLostResponse()throws Exception{
        String intent=frozen(),proof=text("SELECT proof_envelope FROM offline_intent_freezes"),original=preserved();List<String> nonces=new ArrayList<>();AtomicInteger calls=new AtomicInteger();JSONObject terminal=result(intent,"funds_returned");
        NativePaymentRecovery recovery=recovery((path,body)->{assertEquals("/api/pos/offline/payment-freeze",path);assertEquals(proof,body.getJSONObject("freezeEnvelope").toString());JSONObject query=payload(body.getJSONObject("queryEnvelope").toString());nonces.add(query.getString("challenge"));if(calls.incrementAndGet()==1)throw new java.io.IOException("synthetic_lost_response");return response(intent,terminal,query.getString("challenge"));});
        assertEquals("offline_payment_recovery_uncertain",assertThrows(NativeAccessError.class,()->recovery.recover(intent)).getMessage());assertEquals("frozen_for_manager",engine.getIntent(intent).getString("state"));assertEquals(original,preserved());
        assertEquals("resolved_funds_returned",recovery.recover(intent).getString("status"));assertEquals(2,nonces.size());assertNotEquals(nonces.get(0),nonces.get(1));assertEquals(original,preserved());assertEquals(1,count("offline_payment_results"));
    }
    @Test public void orchestrationAcceptsWhileLockedAndRetriesAfterLocalCommitWithoutDuplicates()throws Exception{
        String intent=frozen(),original=preserved();JSONObject terminal=result(intent,"funds_returned");locked=true;signedOut=true;failObservation=true;
        NativePaymentRecovery recovery=recovery((path,body)->response(intent,terminal,payload(body.getJSONObject("queryEnvelope").toString()).getString("challenge")));
        assertEquals("resolved_funds_returned",recovery.recover(intent).getString("status"));String first=text("SELECT response_json FROM offline_payment_results");reopen();
        NativePaymentRecovery retry=recovery((path,body)->response(intent,terminal,payload(body.getJSONObject("queryEnvelope").toString()).getString("challenge")));
        assertEquals("resolved_funds_returned",retry.recover(intent).getString("status"));assertEquals(first,text("SELECT response_json FROM offline_payment_results"));assertEquals(original,preserved());fails(()->checkout.getPaymentIntent(intent));
    }
    @Test public void orchestrationRejectsStaleNonceWithoutPersistingResultAndDoesNotSendUnfrozenIntent()throws Exception{
        String intent=frozen(),original=preserved();AtomicInteger calls=new AtomicInteger();NativePaymentRecovery recovery=recovery((path,body)->{calls.incrementAndGet();return response(intent,result(intent,"funds_returned"),challenge());});
        fails(()->recovery.recover(intent));assertEquals(1,calls.get());assertEquals(0,count("offline_payment_results"));assertEquals(original,preserved());fails(()->recovery.recover(id()));assertEquals(1,calls.get());
    }
    @Test public void newlyLearnedConflictForPriorResolvedIntentBlocksExistingNextPaymentCommit()throws Exception{
        String originalIntent=frozen(),n=challenge();engine.acceptPaymentResolution(originalIntent,response(originalIntent,result(originalIntent,"funds_returned"),n),n);
        String nextIntent=begin();String before=preserved(),conflictNonce=challenge();engine.acceptPaymentResolution(originalIntent,status(originalIntent,conflictNonce,"conflict"),conflictNonce);
        fails(()->engine.commitPaymentIntent(nextIntent));assertEquals(before,preserved());assertEquals("payment_confirmation_required",engine.getIntent(nextIntent).getString("state"));assertEquals(0,count("receipts"));assertEquals(0,value("SELECT sequence FROM offline_chain"));
    }
    @Test public void signedAlreadyIssuedEvidenceCreatesOnlyDurableConflictNeverLocalReceiptOrAck()throws Exception{
        String intent=frozen(),original=preserved(),n=challenge(),issuanceHash=challenge();JSONObject f=payload(text("SELECT proof_envelope FROM offline_intent_freezes"));
        JSONObject receipt=new JSONObject().put("id",f.getString("documentId")).put("orderId",f.getString("orderId"));for(String key:new String[]{"branchId","deviceId","actorId","shiftId"})receipt.put(key,f.getString(key));
        JSONObject ack=new JSONObject().put("kind","offline-ack").put("schemaVersion",1).put("id",id()).put("issuanceId",f.getString("orderId"))
            .put("payloadSha256",issuanceHash).put("authorityId",f.getString("authorityId")).put("keyEpoch",f.getString("keyEpoch")).put("deviceSequence",1).put("receivedAt",NativeCheckoutEngine.iso(start));
        JSONObject wire=new JSONObject().put("handoff",signed(handoff(intent,n,"already_issued",JSONObject.NULL,issuanceHash))).put("resolutionEnvelope",JSONObject.NULL).put("receipt",receipt).put("acknowledgement",signed(ack));
        assertEquals("resolution_conflict",engine.acceptPaymentResolution(intent,wire,n).getString("status"));reopen();assertEquals("conflict",engine.getIntent(intent).getJSONObject("managerReview").getString("status"));assertEquals(original,preserved());
        assertEquals(0,count("receipts"));assertEquals(0,count("acknowledgements"));assertEquals(0,count("offline_payment_results"));assertEquals(1,count("offline_payment_conflicts"));fails(()->engine.commitPaymentIntent(intent));fails(()->engine.beginPaymentIntent(id(),input()));
    }
    @Test public void exportActualSyntheticManagerResultBridgeContract()throws Exception{
        String intent=frozen();JSONArray states=new JSONArray(),intents=new JSONArray(),metadata=new JSONArray();
        states.put(new JSONObject().put("name","frozen").put("value",checkout.getState()));intents.put(new JSONObject().put("name","frozen").put("value",checkout.getPaymentIntent(intent)));
        String pendingNonce=challenge();metadata.put(engine.acceptPaymentResolution(intent,status(intent,pendingNonce,"pending"),pendingNonce));states.put(new JSONObject().put("name","pending").put("value",checkout.getState()));intents.put(new JSONObject().put("name","pending").put("value",checkout.getPaymentIntent(intent)));
        String resolvedNonce=challenge();metadata.put(engine.acceptPaymentResolution(intent,response(intent,result(intent,"funds_returned"),resolvedNonce),resolvedNonce));
        states.put(new JSONObject().put("name","accepted").put("value",coordinator(false).getState()));intents.put(new JSONObject().put("name","accepted").put("value",checkout.getPaymentIntent(intent)));
        assertEquals(intent,states.getJSONObject(2).getJSONObject("value").getString("lastResolvedIntentId"));assertEquals("accepted_on_device",intents.getJSONObject(2).getJSONObject("value").getJSONObject("managerReview").getString("status"));
        locked=true;JSONObject hidden=checkout.getState();assertTrue(hidden.isNull("lastResolvedIntentId"));assertTrue(hidden.isNull("lastResolvedIntent"));states.put(new JSONObject().put("name","locked").put("value",hidden));
        locked=false;signedOut=true;JSONObject signedOutState=checkout.getState();assertTrue(signedOutState.isNull("lastResolvedIntentId"));assertTrue(signedOutState.isNull("lastResolvedIntent"));states.put(new JSONObject().put("name","signed_out").put("value",signedOutState));
        JSONObject export=new JSONObject().put("schemaVersion",1).put("synthetic",true).put("states",states).put("intents",intents).put("recoveryMetadata",metadata);
        File file=new File(context.getCacheDir(),"native-payment-resolution-contract.json");try(FileOutputStream out=new FileOutputStream(file)){out.write(export.toString().getBytes(StandardCharsets.UTF_8));out.getFD().sync();}assertTrue(file.isFile());
    }
}
