package info.internext.pos.storage;

import static org.junit.Assert.*;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.OfflineBundle;
import info.internext.pos.offline.OfflineClock;
import info.internext.pos.offline.SignedProtocol;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Synthetic server data, isolated real Android SQLite/vault/Keystore, and no network. */
@RunWith(AndroidJUnit4.class)
public class NativeBundleRecoveryTest {
    private Context context;
    private String dbName,vaultName,deviceAlias,vaultAlias,clockDb,clockAlias,boot=UUID.randomUUID().toString();
    private NativeClockSource sellingClock;
    private NativeJournal journal;
    private SecureSessionStore store;
    private NativeSession session;
    private DeviceIdentity identity;
    private NativeBundleRecovery recovery;
    private KeyPair server;
    private PublicKey deviceKey;
    private OfflineBundle.Binding binding;
    private JSONObject snapshot,authority,identityInfo;
    private String snapshotEnvelope,authorityEnvelope;
    private final long start=1_792_132_200_000L;
    private long wall=start,elapsed=1000,serverTime=start,roundTrip=25;
    private String mutation="";
    private boolean lostResponse,locked=true;
    private int unlockCalls;
    private final List<JSONObject> proofs=new ArrayList<>();
    private JSONObject replayResponse;

    @Before public void setup()throws Exception {
        context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        String suffix=UUID.randomUUID().toString();
        dbName="bundle-recovery-"+suffix+".db";vaultName="bundle-recovery-"+suffix+".vault";
        deviceAlias="internext.pos.test.recovery.device."+suffix;vaultAlias="internext.pos.test.recovery.vault."+suffix;
        clockDb="bundle-recovery-clock-"+suffix+".db";clockAlias="internext.pos.test.recovery.clock."+suffix;
        journal=new NativeJournal(context,dbName,()->{});identity=new DeviceIdentity(deviceAlias);
        identityInfo=identity.readOrCreate(journal);
        deviceKey=SignedProtocol.publicKey(SignedProtocol.decode(identityInfo.getString("publicKeySpkiBase64Url"),256));
        KeyPairGenerator generator=KeyPairGenerator.getInstance("EC");generator.initialize(new ECGenParameterSpec("secp256r1"));server=generator.generateKeyPair();
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        try(InputStream in=InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("pos-offline-output.json")){
            byte[] buffer=new byte[4096];int n;while((n=in.read(buffer))!=-1)bytes.write(buffer,0,n);
        }
        JSONObject fixture=new JSONObject(bytes.toString("UTF-8")).getJSONObject("reservation");
        snapshot=fixture.getJSONObject("snapshot");authority=fixture.getJSONObject("authority");
        snapshot.put("createdAt",NativeCheckoutEngine.iso(start));
        authority.put("deviceKeySha256",identityInfo.getString("deviceKeySha256")).put("issuedAt",NativeCheckoutEngine.iso(start))
            .put("notBefore",NativeCheckoutEngine.iso(start)).put("expiresAt",NativeCheckoutEngine.iso(start+3_600_000));
        binding=new OfflineBundle.Binding(authority.getString("organizationId"),authority.getString("branchId"),authority.getString("deviceId"),authority.getString("actorId"),authority.getString("shiftId"),authority.getString("keyEpoch"),authority.getString("deviceKeySha256"));
        rebuild();store=new SecureSessionStore(context,vaultName,vaultAlias);seed();reopen();
    }

    private void rebuild()throws Exception {
        authority.put("snapshotSha256",SignedProtocol.hash(CanonicalJson.bytes(snapshot)));
        snapshotEnvelope=SignedProtocol.sign(snapshot,"synthetic-server",server.getPrivate(),server.getPublic());
        authorityEnvelope=SignedProtocol.sign(authority,"synthetic-server",server.getPrivate(),server.getPublic());
    }
    private void seed()throws Exception {
        JSONObject state=store.read();state.put("actorId",JSONObject.NULL).put("logoutPending",true);
        state.put("counter",new JSONObject().put("actorId",binding.actorId).put("id",binding.deviceId).put("branchId",binding.branchId).put("name","Synthetic counter"));
        state.getJSONObject("cookies").put("pos-device-"+binding.actorId,hex("a"));
        state.put("offline",new JSONObject().put("scope",new JSONObject().put("actorId",binding.actorId).put("organizationId",binding.organizationId).put("branchId",binding.branchId).put("deviceId",binding.deviceId))
            .put("shiftId",binding.shiftId).put("shiftRequest",JSONObject.NULL).put("shiftAcknowledged",false).put("enrollmentRequest",JSONObject.NULL).put("keyEpoch",binding.keyEpoch)
            .put("reservation",new JSONObject().put("requestId",authority.getString("id")).put("branchId",binding.branchId).put("deviceId",binding.deviceId).put("shiftId",binding.shiftId)
                .put("count",authority.getJSONObject("invoiceRange").getLong("last")-authority.getJSONObject("invoiceRange").getLong("first")+1)
                .put("lifetimeSeconds",3600).put("maxInvoiceTotalFils",authority.getLong("maxInvoiceTotalFils")).put("maxGrossFils",authority.getLong("maxGrossFils")).put("permissions",authority.getJSONObject("permissions"))));
        store.write(state);
    }
    private void reopen()throws Exception {
        store=new SecureSessionStore(context,vaultName,vaultAlias);
        session=new NativeSession(store,new NativePosHttp(store,url->{throw new AssertionError("Authenticated HTTP must not run during historical recovery");}),journal);
        recovery=new NativeBundleRecovery(journal,session,identity,Collections.singletonMap("synthetic-server",server.getPublic()),this::respond,this::reading);
    }
    private OfflineClock.Reading reading(){return new OfflineClock.Reading(boot,elapsed,wall);}
    private NativeCheckoutEngine engine()throws Exception {
        return new NativeCheckoutEngine(journal,Collections.singletonMap("synthetic-server",server.getPublic()),binding,deviceKey,b->{unlockCalls++;if(locked)throw new IllegalStateException("locked");},this::reading,identity::sign);
    }
    private JSONObject respond(String path,JSONObject envelope)throws Exception {
        assertEquals("/api/pos/offline/bundle-recovery",path);
        JSONObject proof=(JSONObject)SignedProtocol.verify(envelope.toString(),Collections.singletonMap(binding.deviceKeySha256,deviceKey)).payload();
        assertEquals(6,proof.length());assertEquals("offline-bundle-recovery",proof.getString("kind"));assertEquals(1,proof.getInt("schemaVersion"));
        assertEquals(authority.getString("id"),proof.getString("authorityId"));assertEquals(binding.keyEpoch,proof.getString("keyEpoch"));assertEquals(binding.deviceId,proof.getString("deviceId"));
        assertTrue(proof.getString("challenge").matches("[a-f0-9]{64}"));proofs.add(proof);
        if(mutation.equals("local-reservation")){
            JSONObject changed=store.read();changed.getJSONObject("offline").getJSONObject("reservation").put("requestId",UUID.randomUUID().toString());store.write(changed);
        }
        if(mutation.equals("concurrent-install")){locked=false;engine().installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start);locked=true;}
        elapsed+=roundTrip;wall+=roundTrip;
        if(mutation.equals("elapsed"))elapsed-=roundTrip+1;
        if(mutation.equals("wall"))wall-=roundTrip+1;
        if(mutation.equals("boot"))boot=UUID.randomUUID().toString();
        JSONObject handoff=new JSONObject().put("kind","native-offline-recovered").put("schemaVersion",1).put("purpose","reconciliation-only")
            .put("challenge",proof.getString("challenge")).put("serverTimeMs",serverTime).put("actorId",binding.actorId).put("organizationId",binding.organizationId)
            .put("branchId",binding.branchId).put("deviceId",binding.deviceId).put("shiftId",binding.shiftId).put("keyEpoch",binding.keyEpoch).put("deviceKeySha256",binding.deviceKeySha256)
            .put("authorityId",authority.getString("id")).put("snapshotSha256",SignedProtocol.hash(CanonicalJson.bytes(snapshot))).put("authoritySha256",SignedProtocol.hash(CanonicalJson.bytes(authority)));
        if(mutation.equals("challenge"))handoff.put("challenge",hex("f"));
        if(mutation.equals("kind"))handoff.put("kind","native-offline-prepared");
        if(mutation.equals("purpose"))handoff.put("purpose","checkout");
        for(String field:new String[]{"actorId","organizationId","branchId","deviceId","shiftId","keyEpoch","authorityId"})if(mutation.equals(field))handoff.put(field,UUID.randomUUID().toString());
        for(String field:new String[]{"deviceKeySha256","snapshotSha256","authoritySha256"})if(mutation.equals(field))handoff.put(field,hex("f"));
        if(mutation.equals("unknown"))handoff.put("extra",true);
        String handoffKey=mutation.equals("key")?"untrusted-server":"synthetic-server";
        JSONObject response=new JSONObject().put("snapshotEnvelope",new JSONObject(snapshotEnvelope)).put("authorityEnvelope",new JSONObject(authorityEnvelope))
            .put("handoff",new JSONObject(SignedProtocol.sign(handoff,handoffKey,server.getPrivate(),server.getPublic())));
        if(mutation.equals("snapshot"))response.getJSONObject("snapshotEnvelope").put("payloadBase64Url",SignedProtocol.encode(CanonicalJson.bytes(new JSONObject(snapshot.toString()).put("createdAt",NativeCheckoutEngine.iso(start+1)))));
        if(mutation.equals("wrapper"))response.put("extra",true);
        if(replayResponse!=null)return new JSONObject(replayResponse.toString());
        if(lostResponse){lostResponse=false;replayResponse=response;throw new NativeAccessError("native_network_unavailable");}
        return response;
    }
    private String id()throws Exception{return authority.getString("id");}
    private String hex(String c){return String.join("",Collections.nCopies(64,c));}
    private String canonical(JSONObject value)throws Exception{return new String(CanonicalJson.bytes(value),StandardCharsets.UTF_8);}
    private long count(String table){return number("SELECT count(*) FROM "+table);}
    private long number(String sql){try(Cursor c=journal.getReadableDatabase().rawQuery(sql,null)){assertTrue(c.moveToFirst());return c.getLong(0);}}
    private String saved(String column,String authorityId){try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT "+column+" FROM offline_authority_state WHERE authority_id=?",new String[]{authorityId})){assertTrue(c.moveToFirst());return c.isNull(0)?null:c.getString(0);}}
    private JSONObject ownPayload(String envelope)throws Exception{return (JSONObject)SignedProtocol.verify(envelope,Collections.singletonMap(binding.deviceKeySha256,deviceKey)).payload();}
    private JSONObject input()throws Exception{return new JSONObject().put("authorityId",id()).put("serviceType","takeaway").put("customer",JSONObject.NULL).put("lines",new JSONArray().put(new JSONObject().put("productId",snapshot.getJSONArray("products").getJSONObject(0).getString("id")).put("quantityMilli",1000))).put("cashTenderedFils",1000).put("recordedCardFils",0).put("presentedTotalFils",1000);}
    private void emptyCustody(){assertEquals(0,count("offline_bundles"));assertEquals(0,count("offline_authority_state"));assertEquals(0,count("offline_chain"));assertEquals(0,count("intents"));assertEquals(0,count("receipts"));assertEquals(0,count("outbox"));}
    private void terminal()throws Exception {
        assertEquals(1,count("offline_bundles"));assertEquals(1,count("offline_authority_state"));assertEquals(0,count("intents"));assertEquals(0,count("receipts"));assertEquals(0,count("outbox"));
        assertNotNull(saved("seal_envelope",id()));assertEquals("0",saved("gross_fils",id()));assertEquals("0",saved("blocked",id()));assertEquals("1",saved("next_number",id()));
        JSONObject seal=ownPayload(saved("seal_envelope",id()));assertEquals("offline-seal",seal.getString("kind"));assertEquals(id(),seal.getString("authorityId"));assertEquals(0,seal.getLong("finalSequence"));assertTrue(seal.isNull("finalEventSha256"));
        locked=false;assertThrows(IllegalStateException.class,()->engine().beginPaymentIntent(UUID.randomUUID().toString(),input()));assertEquals(0,count("intents"));
    }

    @After public void cleanup()throws Exception {
        if(sellingClock!=null)sellingClock.close();
        if(journal!=null)journal.close();if(context!=null&&dbName!=null){context.deleteDatabase(dbName);assertFalse(context.getDatabasePath(dbName).exists());}
        if(context!=null&&clockDb!=null){context.deleteDatabase(clockDb);assertFalse(context.getDatabasePath(clockDb).exists());}
        if(context!=null&&vaultName!=null)for(String suffix:new String[]{"",".bak",".new"}){File f=new File(context.getNoBackupFilesDir(),vaultName+suffix);if(f.exists())assertTrue(f.delete());}
        KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);for(String alias:new String[]{deviceAlias,vaultAlias,clockAlias})if(alias!=null){if(keys.containsAlias(alias))keys.deleteEntry(alias);assertFalse(keys.containsAlias(alias));}
    }

    @Test public void signedOutPendingLogoutAndLockedStaffCanOnlyRetainUnexpiredGrantTerminally()throws Exception {
        String before=canonical(store.read());JSONObject state=recovery.getState();assertEquals("available",state.getString("status"));assertTrue(state.getBoolean("canRecover"));assertEquals(id(),state.getString("authorityId"));assertEquals(5,state.length());
        assertEquals("retained",recovery.recover(id()).getString("status"));assertEquals(0,unlockCalls);assertEquals(before,canonical(store.read()));terminal();
        OfflineClock.State anchored=OfflineClock.State.fromJson(saved("clock_json",id()));assertEquals(start+roundTrip,anchored.anchorServerMs);
    }
    @Test public void expiredGrantIsRetainedWithoutAnySaleOrConsumedNumber()throws Exception {
        serverTime=start+7_200_000;wall=serverTime;elapsed+=7_200_000;
        assertEquals("retained",recovery.recover(id()).getString("status"));terminal();assertEquals(0,number("SELECT sequence FROM offline_chain"));
    }
    @Test public void lostResponseKeepsOriginalReservationAndRequiresFreshChallengeAfterRestart()throws Exception {
        String original=canonical(store.read());lostResponse=true;assertThrows(Exception.class,()->recovery.recover(id()));emptyCustody();assertEquals(original,canonical(store.read()));
        reopen();assertThrows(Exception.class,()->recovery.recover(id()));emptyCustody();assertNotEquals(proofs.get(0).getString("challenge"),proofs.get(1).getString("challenge"));
        replayResponse=null;assertEquals("retained",recovery.recover(id()).getString("status"));terminal();assertEquals(original,canonical(store.read()));assertEquals(3,proofs.size());
    }
    @Test public void noncePurposeEveryScopeFieldAndBothBundleHashesAreIndependentlyBound()throws Exception {
        String original=canonical(store.read());
        for(String bad:new String[]{"challenge","kind","purpose","actorId","organizationId","branchId","deviceId","shiftId","keyEpoch","authorityId","deviceKeySha256","snapshotSha256","authoritySha256","unknown"}){
            mutation=bad;assertThrows("Rejected mutated "+bad,Exception.class,()->recovery.recover(id()));emptyCustody();assertEquals(original,canonical(store.read()));
        }
        mutation="";recovery.recover(id());terminal();
    }
    @Test public void untrustedSigningKeyTamperedSnapshotAndUnknownWrapperNeverRetain()throws Exception {
        for(String bad:new String[]{"key","snapshot","wrapper"}){mutation=bad;assertThrows(Exception.class,()->recovery.recover(id()));emptyCustody();}
        mutation="";recovery.recover(id());terminal();
    }
    @Test public void roundTripTimeoutRollbackBootChangeAndOverflowRejectFreshness()throws Exception {
        for(String bad:new String[]{"elapsed","wall","boot","timeout","overflow"}){
            mutation=bad;elapsed=1000;wall=start;roundTrip=bad.equals("timeout")?30001:25;serverTime=bad.equals("overflow")?OfflineClock.MAX_TIME_MS:start;
            assertThrows("Rejected timing "+bad,Exception.class,()->recovery.recover(id()));emptyCustody();
        }
        mutation="";roundTrip=30000;serverTime=start;wall=start;elapsed=1000;recovery.recover(id());terminal();
    }
    @Test public void foreignRequestedAuthorityAndDamagedPersistedScopeNeverReachNetwork()throws Exception {
        assertThrows(Exception.class,()->recovery.recover(UUID.randomUUID().toString()));assertEquals(0,proofs.size());emptyCustody();
        JSONObject original=store.read(),changed=new JSONObject(original.toString());changed.getJSONObject("offline").getJSONObject("scope").put("deviceId",UUID.randomUUID().toString());store.write(changed);
        assertEquals("blocked",recovery.getState().getString("status"));assertThrows(Exception.class,()->recovery.recover(id()));assertEquals(0,proofs.size());emptyCustody();
        store.write(original);recovery.recover(id());terminal();
    }
    @Test public void existingActiveAuthorityAndClockLatchAreNeverSealedOrReanchored()throws Exception {
        locked=false;engine().installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start);locked=true;
        String oldClock=saved("clock_json",id());int calls=unlockCalls;
        assertFalse(recovery.getState().getBoolean("canRecover"));assertThrows(Exception.class,()->recovery.recover(id()));assertEquals(0,proofs.size());assertNull(saved("seal_envelope",id()));assertEquals(oldClock,saved("clock_json",id()));
        journal.getWritableDatabase().execSQL("UPDATE offline_authority_state SET blocked=1");
        assertThrows(Exception.class,()->recovery.recover(id()));assertEquals("1",saved("blocked",id()));assertEquals(oldClock,saved("clock_json",id()));assertNull(saved("seal_envelope",id()));assertEquals(calls,unlockCalls);assertEquals(0,count("receipts"));
    }
    @Test public void uncertainLegacyCollectionIsPreservedAndBlocksMissingBundleRetention()throws Exception {
        String pending=UUID.randomUUID().toString();journal.beginIntent(pending,canonical(input()),NativeCheckoutEngine.iso(start));
        assertFalse(recovery.getState().getBoolean("canRecover"));assertThrows(Exception.class,()->recovery.recover(id()));assertEquals(1,count("intents"));assertEquals(0,count("offline_bundles"));assertEquals(0,count("receipts"));assertEquals(0,count("offline_intent_cancellations"));
    }
    @Test public void previousReceiptChainAndOutboxArePreservedWhileNewAllocationIsSealedUnused()throws Exception {
        locked=false;NativeCheckoutEngine engine=engine();engine.installVerifiedBundle(snapshotEnvelope,authorityEnvelope,start);
        String oldId=id(),intent=UUID.randomUUID().toString();engine.beginPaymentIntent(intent,input());String receipt=engine.commitPaymentIntent(intent);engine.sealAuthority(oldId);
        String oldClock=saved("clock_json",oldId),oldSeal=saved("seal_envelope",oldId);
        authority.put("id",UUID.randomUUID().toString());authority.getJSONObject("invoiceRange").put("first",4).put("last",6);rebuild();seed();reopen();locked=true;
        recovery.recover(id());assertEquals(2,count("offline_bundles"));assertEquals(1,count("receipts"));assertEquals(1,count("outbox"));assertEquals(1,count("intents"));assertEquals(1,number("SELECT sequence FROM offline_chain"));
        JSONObject seal=ownPayload(saved("seal_envelope",id()));assertEquals(1,seal.getLong("finalSequence"));assertEquals(SignedProtocol.verify(receipt,Collections.singletonMap(binding.deviceKeySha256,deviceKey)).payloadSha256,seal.getString("finalEventSha256"));
        assertEquals(oldClock,saved("clock_json",oldId));assertEquals(oldSeal,saved("seal_envelope",oldId));assertEquals("4",saved("next_number",id()));assertEquals("0",saved("gross_fils",id()));
        locked=false;assertThrows(IllegalStateException.class,()->engine().beginPaymentIntent(UUID.randomUUID().toString(),input()));assertEquals(1,count("intents"));
    }
    @Test public void interruptedSealRollsBackWholeRetentionAndExactReservationRetriesSafely()throws Exception {
        String original=canonical(store.read());journal.getWritableDatabase().execSQL("CREATE TRIGGER synthetic_recovery_interrupt BEFORE UPDATE OF seal_envelope ON offline_authority_state WHEN NEW.seal_envelope IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic_interruption'); END");
        assertThrows(Exception.class,()->recovery.recover(id()));emptyCustody();assertEquals(original,canonical(store.read()));
        journal.getWritableDatabase().execSQL("DROP TRIGGER synthetic_recovery_interrupt");journal.close();journal=new NativeJournal(context,dbName,()->{});reopen();
        recovery.recover(id());terminal();assertEquals(original,canonical(store.read()));assertEquals(2,proofs.size());assertNotEquals(proofs.get(0).getString("challenge"),proofs.get(1).getString("challenge"));
    }
    @Test public void retainedRetryAfterRestartDoesNotFetchSignReanchorOrConsumeNumbers()throws Exception {
        recovery.recover(id());String clock=saved("clock_json",id()),seal=saved("seal_envelope",id());int network=proofs.size();
        journal.close();journal=new NativeJournal(context,dbName,()->{});reopen();wall-=500;elapsed-=500;
        assertEquals("retained",recovery.getState().getString("status"));assertFalse(recovery.getState().getBoolean("canRecover"));assertEquals("retained",recovery.recover(id()).getString("status"));
        assertEquals(network,proofs.size());assertEquals(clock,saved("clock_json",id()));assertEquals(seal,saved("seal_envelope",id()));terminal();
    }
    @Test public void changedLocalReservationAndConcurrentActiveInstallRejectStaleResponse()throws Exception {
        JSONObject original=store.read();mutation="local-reservation";assertThrows(Exception.class,()->recovery.recover(id()));emptyCustody();
        assertNotEquals(id(),store.read().getJSONObject("offline").getJSONObject("reservation").getString("requestId"));
        store.write(original);mutation="concurrent-install";assertThrows(Exception.class,()->recovery.recover(id()));
        assertEquals(1,count("offline_bundles"));assertNull(saved("seal_envelope",id()));assertEquals("0",saved("blocked",id()));assertEquals("1",saved("next_number",id()));assertEquals(0,count("receipts"));
        String clock=saved("clock_json",id());mutation="";assertThrows(Exception.class,()->recovery.recover(id()));assertEquals(clock,saved("clock_json",id()));assertNull(saved("seal_envelope",id()));
    }
    @Test public void noPendingReservationAndMissingTrustPinsCannotStartRecovery()throws Exception {
        NativeBundleRecovery unconfigured=new NativeBundleRecovery(journal,session,identity,Collections.emptyMap(),this::respond,this::reading);
        assertEquals("blocked",unconfigured.getState().getString("status"));assertEquals("offline_not_configured",unconfigured.getState().getString("reasonCode"));
        assertThrows(Exception.class,()->unconfigured.recover(id()));assertEquals(0,proofs.size());
        JSONObject state=store.read();state.getJSONObject("offline").put("reservation",JSONObject.NULL);store.write(state);
        JSONObject absent=recovery.getState();assertEquals("not_needed",absent.getString("status"));assertTrue(absent.isNull("authorityId"));assertFalse(absent.getBoolean("canRecover"));
        assertThrows(Exception.class,()->recovery.recover(id()));assertEquals(0,proofs.size());emptyCustody();
    }
    private String authenticatedClockRow()throws Exception {
        try(SQLiteDatabase db=SQLiteDatabase.openDatabase(context.getDatabasePath(clockDb).getAbsolutePath(),null,SQLiteDatabase.OPEN_READONLY);
            Cursor c=db.rawQuery("SELECT payload,mac FROM clock_state WHERE slot=1",null)){
            assertTrue(c.moveToFirst());assertTrue(new JSONObject(c.getString(0)).getBoolean("blocked"));return c.getString(0)+"\n"+c.getString(1);
        }
    }
    @Test public void rawRecoveryPreservesAuthenticatedSellingClockRollbackLatchAcrossRestart()throws Exception {
        sellingClock=new NativeClockSource(context,journal,clockDb,clockAlias,()->new NativeClockSource.Observation(7,elapsed,wall));
        sellingClock.read();elapsed--;wall--;
        assertEquals("clock_rollback",assertThrows(IllegalStateException.class,()->sellingClock.read()).getMessage());String before=authenticatedClockRow();
        elapsed+=1000;wall+=1000;recovery.recover(id());assertEquals(before,authenticatedClockRow());terminal();
        assertEquals("clock_source_blocked",assertThrows(IllegalStateException.class,()->sellingClock.read()).getMessage());
        sellingClock.close();sellingClock=new NativeClockSource(context,journal,clockDb,clockAlias,()->new NativeClockSource.Observation(7,elapsed,wall));
        assertEquals("clock_source_blocked",assertThrows(IllegalStateException.class,()->sellingClock.read()).getMessage());assertEquals(before,authenticatedClockRow());
    }
}
