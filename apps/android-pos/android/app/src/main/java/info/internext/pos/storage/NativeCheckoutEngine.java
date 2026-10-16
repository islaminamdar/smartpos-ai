package info.internext.pos.storage;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import info.internext.pos.offline.CanonicalJson;
import info.internext.pos.offline.OfflineBundle;
import info.internext.pos.offline.OfflineCalculator;
import info.internext.pos.offline.OfflineClock;
import info.internext.pos.offline.SignedProtocol;
import info.internext.pos.offline.PaymentResolution;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/** Internal native checkout. The coordinator independently gates the WebView write bridge
 * until recovery and two-device acceptance are complete. All money is recalculated
 * from signed snapshots; the caller can supply quantities and recorded tender only. */
public final class NativeCheckoutEngine {
    interface UnlockGuard { void requireUnlocked(OfflineBundle.Binding binding) throws Exception; }
    interface ClockSource { OfflineClock.Reading read() throws Exception; }
    public interface Signer { byte[] sign(byte[] canonicalPayload) throws Exception; }
    private final NativeJournal journal;
    private final Map<String, PublicKey> serverKeys;
    private final OfflineBundle.Binding binding;
    private final PublicKey deviceKey;
    private final UnlockGuard unlock;
    private final ClockSource clock;
    private final Signer signer;

    // Package-private deliberately: there is no externally callable authorization bypass.
    NativeCheckoutEngine(NativeJournal journal, Map<String, PublicKey> serverKeys,
                         OfflineBundle.Binding binding, PublicKey deviceKey,
                         UnlockGuard unlock, ClockSource clock, Signer signer) throws Exception {
        if (journal == null || serverKeys == null || binding == null || unlock == null || clock == null || signer == null)
            throw invalid("native_configuration_missing");
        this.journal = journal; this.serverKeys = Collections.unmodifiableMap(new HashMap<>(serverKeys));
        this.binding = binding; this.deviceKey = deviceKey; this.unlock = unlock; this.clock = clock; this.signer = signer;
        journal.bindDeviceKey(SignedProtocol.fingerprint(deviceKey));
    }

    static void createTables(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE offline_bundles (id TEXT PRIMARY KEY NOT NULL, snapshot_envelope TEXT NOT NULL, authority_envelope TEXT NOT NULL)");
        db.execSQL("CREATE TABLE offline_authority_state (authority_id TEXT PRIMARY KEY NOT NULL REFERENCES offline_bundles(id), next_number INTEGER NOT NULL CHECK(next_number>0), gross_fils INTEGER NOT NULL CHECK(gross_fils>=0), clock_json TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)), seal_envelope TEXT)");
        db.execSQL("CREATE TABLE offline_chain (slot INTEGER PRIMARY KEY CHECK(slot=1), key_epoch TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>=0), event_hash TEXT, CHECK((sequence=0 AND event_hash IS NULL) OR (sequence>0 AND length(event_hash)=64)))");
        db.execSQL("CREATE TABLE offline_intent_context (intent_id TEXT PRIMARY KEY NOT NULL REFERENCES intents(id), authority_id TEXT NOT NULL REFERENCES offline_bundles(id), order_id TEXT NOT NULL UNIQUE, document_id TEXT NOT NULL UNIQUE)");
        db.execSQL("CREATE TABLE offline_intent_cancellations (intent_id TEXT PRIMARY KEY NOT NULL REFERENCES offline_intent_context(intent_id), reason TEXT NOT NULL, cancelled_at TEXT NOT NULL)");
        for (String table : new String[]{"offline_bundles", "offline_intent_context", "offline_intent_cancellations"}) {
            db.execSQL("CREATE TRIGGER " + table + "_immutable_update BEFORE UPDATE ON " + table + " BEGIN SELECT RAISE(ABORT,'immutable_record'); END");
            db.execSQL("CREATE TRIGGER " + table + "_immutable_delete BEFORE DELETE ON " + table + " BEGIN SELECT RAISE(ABORT,'immutable_record'); END");
        }
        db.execSQL("CREATE TRIGGER offline_bundles_insert_guard BEFORE INSERT ON offline_bundles WHEN EXISTS(SELECT 1 FROM offline_bundles WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'bundle_exists'); END");
        db.execSQL("CREATE TRIGGER offline_context_insert_guard BEFORE INSERT ON offline_intent_context WHEN EXISTS(SELECT 1 FROM offline_intent_context WHERE intent_id=NEW.intent_id OR order_id=NEW.order_id OR document_id=NEW.document_id) BEGIN SELECT RAISE(ABORT,'intent_exists'); END");
        db.execSQL("CREATE TRIGGER offline_cancellation_insert_guard BEFORE INSERT ON offline_intent_cancellations WHEN EXISTS(SELECT 1 FROM offline_intent_cancellations WHERE intent_id=NEW.intent_id) BEGIN SELECT RAISE(ABORT,'cancellation_exists'); END");
        db.execSQL("CREATE TRIGGER offline_state_monotonic BEFORE UPDATE ON offline_authority_state WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.next_number<OLD.next_number OR NEW.gross_fils<OLD.gross_fils OR NEW.blocked<OLD.blocked OR (OLD.seal_envelope IS NOT NULL AND NEW.seal_envelope IS NOT OLD.seal_envelope) BEGIN SELECT RAISE(ABORT,'custody_rollback'); END");
        db.execSQL("CREATE TRIGGER offline_state_delete BEFORE DELETE ON offline_authority_state BEGIN SELECT RAISE(ABORT,'custody_delete'); END");
        db.execSQL("CREATE TRIGGER offline_state_replace BEFORE INSERT ON offline_authority_state WHEN EXISTS(SELECT 1 FROM offline_authority_state WHERE authority_id=NEW.authority_id) BEGIN SELECT RAISE(ABORT,'custody_replace'); END");
        db.execSQL("CREATE TRIGGER offline_chain_monotonic BEFORE UPDATE ON offline_chain WHEN NEW.slot IS NOT OLD.slot OR NEW.key_epoch IS NOT OLD.key_epoch OR NEW.sequence!=OLD.sequence+1 BEGIN SELECT RAISE(ABORT,'chain_rollback'); END");
        db.execSQL("CREATE TRIGGER offline_chain_delete BEFORE DELETE ON offline_chain BEGIN SELECT RAISE(ABORT,'custody_delete'); END");
        db.execSQL("CREATE TRIGGER offline_chain_replace BEFORE INSERT ON offline_chain WHEN EXISTS(SELECT 1 FROM offline_chain) BEGIN SELECT RAISE(ABORT,'custody_replace'); END");
    }

    /** Version 4 is additive. A freeze can only be followed by a separately verified
     * manager attestation; it cannot be erased or called never-collected. */
    static void createFreezeTables(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE offline_intent_freezes (intent_id TEXT PRIMARY KEY NOT NULL REFERENCES offline_intent_context(intent_id), freeze_id TEXT UNIQUE NOT NULL CHECK(length(freeze_id)=36), proof_payload_sha256 TEXT NOT NULL CHECK(length(proof_payload_sha256)=64), proof_envelope TEXT NOT NULL, envelope_sha256 TEXT NOT NULL CHECK(length(envelope_sha256)=64), frozen_observation_json TEXT NOT NULL)");
        db.execSQL("CREATE TRIGGER offline_freeze_immutable_update BEFORE UPDATE ON offline_intent_freezes BEGIN SELECT RAISE(ABORT,'immutable_freeze'); END");
        db.execSQL("CREATE TRIGGER offline_freeze_immutable_delete BEFORE DELETE ON offline_intent_freezes BEGIN SELECT RAISE(ABORT,'immutable_freeze'); END");
        db.execSQL("CREATE TRIGGER offline_freeze_insert_guard BEFORE INSERT ON offline_intent_freezes WHEN EXISTS(SELECT 1 FROM offline_intent_freezes WHERE intent_id=NEW.intent_id OR freeze_id=NEW.freeze_id) OR EXISTS(SELECT 1 FROM intents WHERE id=NEW.intent_id AND receipt_id IS NOT NULL) OR EXISTS(SELECT 1 FROM receipts WHERE intent_id=NEW.intent_id) OR EXISTS(SELECT 1 FROM offline_intent_cancellations WHERE intent_id=NEW.intent_id) BEGIN SELECT RAISE(ABORT,'freeze_conflict'); END");
        db.execSQL("CREATE TRIGGER offline_frozen_receipt_guard BEFORE INSERT ON receipts WHEN EXISTS(SELECT 1 FROM offline_intent_freezes WHERE intent_id=NEW.intent_id) BEGIN SELECT RAISE(ABORT,'payment_frozen'); END");
        db.execSQL("CREATE TRIGGER offline_frozen_intent_guard BEFORE UPDATE OF receipt_id ON intents WHEN NEW.receipt_id IS NOT NULL AND EXISTS(SELECT 1 FROM offline_intent_freezes WHERE intent_id=NEW.id) BEGIN SELECT RAISE(ABORT,'payment_frozen'); END");
        db.execSQL("CREATE TRIGGER offline_frozen_cancel_guard BEFORE INSERT ON offline_intent_cancellations WHEN EXISTS(SELECT 1 FROM offline_intent_freezes WHERE intent_id=NEW.intent_id) BEGIN SELECT RAISE(ABORT,'payment_frozen'); END");
    }

    /** Version 5 adds attestation custody only; original freeze and all fiscal guards remain. */
    static void createResolutionTables(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE offline_payment_results (intent_id TEXT PRIMARY KEY NOT NULL REFERENCES offline_intent_freezes(intent_id), resolution_id TEXT UNIQUE NOT NULL CHECK(length(resolution_id)=36), payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64), response_json TEXT NOT NULL, response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64), challenge TEXT NOT NULL CHECK(length(challenge)=64))");
        for(String table:new String[]{"offline_payment_statuses","offline_payment_conflicts"})
            db.execSQL("CREATE TABLE "+table+" (intent_id TEXT PRIMARY KEY NOT NULL REFERENCES offline_intent_freezes(intent_id), response_json TEXT NOT NULL, response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64), challenge TEXT NOT NULL CHECK(length(challenge)=64))");
        for(String table:new String[]{"offline_payment_results","offline_payment_statuses","offline_payment_conflicts"}){
            db.execSQL("CREATE TRIGGER "+table+"_immutable_update BEFORE UPDATE ON "+table+" BEGIN SELECT RAISE(ABORT,'immutable_resolution'); END");
            db.execSQL("CREATE TRIGGER "+table+"_immutable_delete BEFORE DELETE ON "+table+" BEGIN SELECT RAISE(ABORT,'immutable_resolution'); END");
            db.execSQL("CREATE TRIGGER "+table+"_insert_guard BEFORE INSERT ON "+table+" WHEN EXISTS(SELECT 1 FROM "+table+" WHERE intent_id=NEW.intent_id) OR EXISTS(SELECT 1 FROM intents WHERE id=NEW.intent_id AND receipt_id IS NOT NULL) OR EXISTS(SELECT 1 FROM receipts WHERE intent_id=NEW.intent_id) OR EXISTS(SELECT 1 FROM offline_intent_cancellations WHERE intent_id=NEW.intent_id) BEGIN SELECT RAISE(ABORT,'resolution_conflict'); END");
        }
        db.execSQL("CREATE TRIGGER offline_resolution_identity_guard BEFORE INSERT ON offline_payment_results WHEN EXISTS(SELECT 1 FROM offline_payment_results WHERE resolution_id=NEW.resolution_id) BEGIN SELECT RAISE(ABORT,'resolution_conflict'); END");
    }

    /** Reconstruct original signed scope for custody after logout/revocation/expiry. Never grants unlock. */
    public static NativeCheckoutEngine forHistorical(NativeJournal journal,Map<String,PublicKey> keys,
                                                      PublicKey deviceKey,Signer signer,String intentId)throws Exception {
        uuid(intentId);
        synchronized(journal){
            try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT b.authority_envelope,b.snapshot_envelope,b.id FROM offline_intent_context x JOIN offline_bundles b ON b.id=x.authority_id WHERE x.intent_id=?",new String[]{intentId})){
                if(!c.moveToFirst())throw invalid("intent_missing");
                JSONObject a=object(SignedProtocol.verify(c.getString(0),keys).payload());
                OfflineBundle.Binding original=new OfflineBundle.Binding(a.getString("organizationId"),a.getString("branchId"),a.getString("deviceId"),a.getString("actorId"),a.getString("shiftId"),a.getString("keyEpoch"),SignedProtocol.fingerprint(deviceKey));
                OfflineBundle b=OfflineBundle.verify(c.getString(1),c.getString(0),keys,original);
                if(!b.authorityId.equals(c.getString(2)))throw invalid("intent_integrity_failed");
                return new NativeCheckoutEngine(journal,keys,original,deviceKey,ignored->{throw invalid("pin_unlock_required");},()->{throw invalid("historical_clock_unavailable");},signer);
            }
        }
    }

    /** Original proof plus a device-signed fresh challenge. Neither requires an active sales grant. */
    public JSONObject paymentResolutionRequest(String intentId,String challenge)throws Exception {
        uuid(intentId);if(challenge==null||!challenge.matches("[a-f0-9]{64}"))throw invalid("payment_resolution_invalid");
        synchronized(journal){
            SQLiteDatabase db=journal.getReadableDatabase();JSONObject saved=verifiedFreeze(db,intentId,freezeBase(db,intentId));
            JSONObject review=saved.getJSONObject("managerReview");JSONObject proof=object(SignedProtocol.verify(saved.getString("envelope"),Collections.singletonMap(SignedProtocol.fingerprint(deviceKey),deviceKey)).payload());
            JSONObject query=new JSONObject().put("kind","offline-payment-resolution-query").put("schemaVersion",1)
                .put("authorityId",proof.getString("authorityId")).put("keyEpoch",proof.getString("keyEpoch")).put("deviceId",proof.getString("deviceId"))
                .put("freezeId",review.getString("freezeId")).put("freezeSha256",review.getString("proofSha256")).put("challenge",challenge);
            return new JSONObject().put("freezeEnvelope",new JSONObject(saved.getString("envelope"))).put("queryEnvelope",new JSONObject(sign(query)));
        }
    }

    /** Atomic acceptance of a server attestation. Invalid network data never changes local custody. */
    public JSONObject acceptPaymentResolution(String intentId,JSONObject response,String expectedChallenge)throws Exception {
        uuid(intentId);
        // Freeze the caller's mutable object once. Transport may contain envelopes larger than a payload.
        String exact=response.toString();JSONObject copy=object(CanonicalJson.transport(exact,2_000_000));
        synchronized(journal){
            SQLiteDatabase db=journal.getWritableDatabase();db.beginTransaction();
            try{
                JSONObject saved=verifiedFreeze(db,intentId,freezeBase(db,intentId));
                JSONObject proof=object(SignedProtocol.verify(saved.getString("envelope"),Collections.singletonMap(SignedProtocol.fingerprint(deviceKey),deviceKey)).payload());
                String freezeHash=saved.getJSONObject("managerReview").getString("proofSha256");
                PaymentResolution.Verified incoming=PaymentResolution.verify(copy,expectedChallenge,proof,freezeHash,serverKeys);
                PaymentResolution.Verified original=storedResolution(db,"offline_payment_results",intentId,proof,freezeHash);
                if("resolved".equals(incoming.state)){
                    if(original==null){
                        ContentValues row=responseRow(intentId,exact,expectedChallenge);row.put("resolution_id",incoming.resolution().getString("resolutionId"));row.put("payload_sha256",incoming.resolutionSha256);
                        db.insertOrThrow("offline_payment_results",null,row);
                    }else if(!original.resolutionSha256.equals(incoming.resolutionSha256)){
                        saveFirstResponse(db,"offline_payment_conflicts",intentId,exact,expectedChallenge);
                    }
                }else if("conflict".equals(incoming.state)||"already_issued".equals(incoming.state)){
                    saveFirstResponse(db,"offline_payment_conflicts",intentId,exact,expectedChallenge);
                }else saveFirstResponse(db,"offline_payment_statuses",intentId,exact,expectedChallenge);
                JSONObject review=resolutionReview(db,intentId,saved,proof);
                boolean resolved="accepted_on_device".equals(review.getString("status"));
                String status=resolved?"resolved_"+review.getString("decision"):"conflict".equals(review.getString("status"))?"resolution_conflict":"pending";
                JSONObject result=new JSONObject().put("intentId",intentId).put("status",status).put("resolutionId",resolved?review.getString("resolutionId"):JSONObject.NULL);
                db.setTransactionSuccessful();return result;
            }finally{db.endTransaction();}
        }
    }
    private static ContentValues responseRow(String id,String exact,String challenge){
        ContentValues row=new ContentValues();row.put("intent_id",id);row.put("response_json",exact);row.put("response_sha256",NativeJournal.hash(exact));row.put("challenge",challenge);return row;
    }
    private static void saveFirstResponse(SQLiteDatabase db,String table,String id,String exact,String challenge){
        try(Cursor c=db.rawQuery("SELECT 1 FROM "+table+" WHERE intent_id=?",new String[]{id})){if(c.moveToFirst())return;}
        db.insertOrThrow(table,null,responseRow(id,exact,challenge));
    }
    private PaymentResolution.Verified storedResolution(SQLiteDatabase db,String table,String id,JSONObject proof,String hash)throws Exception {
        try(Cursor c=db.rawQuery("SELECT response_json,response_sha256,challenge"+("offline_payment_results".equals(table)?",resolution_id,payload_sha256":"")+" FROM "+table+" WHERE intent_id=?",new String[]{id})){
            if(!c.moveToFirst())return null;String exact=c.getString(0);
            if(!NativeJournal.hash(exact).equals(c.getString(1)))throw invalid("payment_resolution_integrity_failed");
            PaymentResolution.Verified value=PaymentResolution.verify(object(CanonicalJson.transport(exact,2_000_000)),c.getString(2),proof,hash,serverKeys);
            if("offline_payment_results".equals(table)&&(!"resolved".equals(value.state)||!value.resolutionSha256.equals(c.getString(4))||!value.resolution().getString("resolutionId").equals(c.getString(3))))throw invalid("payment_resolution_integrity_failed");
            if("offline_payment_statuses".equals(table)&&!"pending".equals(value.state))throw invalid("payment_resolution_integrity_failed");
            return value;
        }
    }
    private JSONObject resolutionReview(SQLiteDatabase db,String id,JSONObject saved,JSONObject proof)throws Exception {
        JSONObject review=saved.getJSONObject("managerReview");String hash=review.getString("proofSha256");
        PaymentResolution.Verified result=storedResolution(db,"offline_payment_results",id,proof,hash);
        PaymentResolution.Verified conflict=storedResolution(db,"offline_payment_conflicts",id,proof,hash);
        PaymentResolution.Verified pending=storedResolution(db,"offline_payment_statuses",id,proof,hash);
        if(conflict!=null){
            boolean contradictory="conflict".equals(conflict.state)||"already_issued".equals(conflict.state)||("resolved".equals(conflict.state)&&result!=null&&!result.resolutionSha256.equals(conflict.resolutionSha256));
            if(!contradictory)throw invalid("payment_resolution_integrity_failed");
            return review.put("status","conflict");
        }
        if(result!=null){JSONObject r=result.resolution();return review.put("status","accepted_on_device").put("resolutionId",r.getString("resolutionId")).put("decision",r.getString("decision")).put("resolvedAt",r.getString("resolvedAt"));}
        return review.put("status",pending==null?"saved_locally":"pending");
    }

    boolean isPaymentResolved(String intentId)throws Exception {
        return "manager_resolved".equals(forHistorical(journal,serverKeys,deviceKey,bytes->{throw invalid("historical_signing_unavailable");},intentId).getIntent(intentId).getString("state"));
    }

    /** Every unresolved candidate is verified, including historical scopes, before it can be excluded. */
    public static boolean hasUncertainPayments(NativeJournal journal,Map<String,PublicKey> keys,PublicKey deviceKey)throws Exception {
        return hasUncertainPayments(journal,keys,deviceKey,null);
    }
    private static boolean hasUncertainPayments(NativeJournal journal,Map<String,PublicKey> keys,PublicKey deviceKey,String excluding)throws Exception {
        synchronized(journal){
            try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT i.id FROM intents i LEFT JOIN offline_intent_cancellations c ON c.intent_id=i.id WHERE i.receipt_id IS NULL AND c.intent_id IS NULL ORDER BY i.rowid",null)){
                while(c.moveToNext()){
                    if(c.getString(0).equals(excluding))continue;
                    NativeCheckoutEngine historical=forHistorical(journal,keys,deviceKey,bytes->{throw invalid("historical_signing_unavailable");},c.getString(0));
                    if(!"manager_resolved".equals(historical.getIntent(c.getString(0)).getString("state")))return true;
                }
                return false;
            }
        }
    }

    /** freshServerMs must originate from a fresh authenticated native HTTPS exchange, never JS
     * wall time or an old authority timestamp. Exact installation retries never reset the anchor. */
    void installVerifiedBundle(String snapshotEnvelope, String authorityEnvelope, long freshServerMs) throws Exception {
        installBundle(snapshotEnvelope,authorityEnvelope,freshServerMs,null,false,false);
    }
    public void installVerifiedBundle(String snapshotEnvelope, String authorityEnvelope, long freshServerMs, OfflineClock.Reading referenceReading) throws Exception {
        if(referenceReading==null)throw invalid("handoff_clock_changed");
        installBundle(snapshotEnvelope,authorityEnvelope,freshServerMs,referenceReading,false,false);
    }
    /** Retain a never-installed expired allocation and atomically seal it. This cannot enable
     * issuance, replace an installed bundle, reset its clock, or recycle its reserved numbers. */
    public void retainExpiredUnusedBundle(String snapshotEnvelope,String authorityEnvelope,long freshServerMs,OfflineClock.Reading referenceReading)throws Exception{
        if(referenceReading==null)throw invalid("handoff_clock_changed");
        installBundle(snapshotEnvelope,authorityEnvelope,freshServerMs,referenceReading,true,false);
    }
    /** Device-proof recovery only: missing bundles are inserted and sealed in one transaction.
     * No staff/PIN/selling clock reset, and an existing active allocation is never finished here. */
    void retainRecoveredUnusedBundle(String snapshotEnvelope,String authorityEnvelope,long freshServerMs,OfflineClock.Reading referenceReading)throws Exception{
        if(referenceReading==null)throw invalid("handoff_clock_changed");
        installBundle(snapshotEnvelope,authorityEnvelope,freshServerMs,referenceReading,false,true);
    }
    private void installBundle(String snapshotEnvelope, String authorityEnvelope, long freshServerMs, OfflineClock.Reading referenceReading,boolean retainExpired,boolean recoveryOnly) throws Exception {
        OfflineBundle bundle = OfflineBundle.verify(snapshotEnvelope, authorityEnvelope, serverKeys, binding);
        if (!bundle.deviceKeySha256.equals(SignedProtocol.fingerprint(deviceKey))) throw invalid("device_key_mismatch");
        synchronized (journal) {
            SQLiteDatabase db = journal.getWritableDatabase(); db.beginTransaction();
            try {
                try (Cursor c = db.rawQuery("SELECT snapshot_envelope,authority_envelope FROM offline_bundles WHERE id=?", new String[]{bundle.authorityId})) {
                    if (c.moveToFirst()) {
                        OfflineBundle stored = OfflineBundle.verify(c.getString(0), c.getString(1), serverKeys, binding);
                        if (!stored.snapshotSha256.equals(bundle.snapshotSha256) || !stored.authoritySha256.equals(bundle.authoritySha256)) throw invalid("bundle_conflict");
                        if(recoveryOnly&&state(db,bundle.authorityId).seal==null)throw invalid("offline_allocation_active");
                        db.setTransactionSuccessful(); return;
                    }
                }
                if(!recoveryOnly)unlock.requireUnlocked(binding);
                if(!retainExpired&&!recoveryOnly){NativeShiftCloseJournal.requireNoPending(journal,serverKeys);NativeShiftCloseJournal.requireNoCloseForShift(db,bundle.shiftId);}
                if (exists(db, "SELECT 1 FROM offline_authority_state WHERE seal_envelope IS NULL OR blocked=1") || hasUncertain(db)) throw invalid("previous_authority_unresolved");
                NativeAllocationLifecycle lifecycle=new NativeAllocationLifecycle(journal,serverKeys,deviceKey);
                // Terminal-only custody retention grants no selling capability. Keep outstanding
                // receipt uploads intact; active installation still requires their signed ACKs.
                if(!retainExpired&&!recoveryOnly)lifecycle.requireClear();
                else try(Cursor c=db.rawQuery("SELECT id FROM offline_bundles",null)){while(c.moveToNext())lifecycle.sealHash(c.getString(0),false);}
                lifecycle.requireNewRange(bundle);
                try (Cursor c = db.rawQuery("SELECT key_epoch FROM offline_chain WHERE slot=1", null)) {
                    if (c.moveToFirst()) {
                        if (!bundle.keyEpoch.equals(c.getString(0))) throw invalid("key_epoch_rotation_required");
                    } else {
                        if (exists(db, "SELECT 1 FROM receipts")) throw invalid("legacy_custody_requires_reconciliation");
                        ContentValues row = new ContentValues(); row.put("slot", 1); row.put("key_epoch", bundle.keyEpoch); row.put("sequence", 0); row.putNull("event_hash");
                        db.insertOrThrow("offline_chain", null, row);
                    }
                }
                OfflineClock.Reading reading = recoveryOnly?referenceReading:clock.read();
                long anchoredServerMs=freshServerMs;
                if(referenceReading!=null&&!recoveryOnly){
                    long delay=reading.elapsedRealtimeMs-referenceReading.elapsedRealtimeMs;
                    if(!reading.bootId.equals(referenceReading.bootId)||delay<0||delay>30000||reading.wallTimeMs<referenceReading.wallTimeMs)throw invalid("handoff_clock_changed");
                    anchoredServerMs=Math.addExact(freshServerMs,delay);
                }
                OfflineClock.State anchor=OfflineClock.anchor(anchoredServerMs, reading);
                if(retainExpired&&anchoredServerMs<bundle.expiresAtMs)throw invalid("authority_not_expired");
                OfflineClock.State savedClock=(retainExpired||recoveryOnly)?anchor:OfflineClock.advance(anchor, reading, bundle.notBeforeMs, bundle.expiresAtMs).nextState;
                ContentValues row = new ContentValues(); row.put("id", bundle.authorityId); row.put("snapshot_envelope", snapshotEnvelope); row.put("authority_envelope", authorityEnvelope); db.insertOrThrow("offline_bundles", null, row);
                row = new ContentValues(); row.put("authority_id", bundle.authorityId); row.put("next_number", bundle.firstInvoice); row.put("gross_fils", 0); row.put("clock_json", savedClock.toJson()); db.insertOrThrow("offline_authority_state", null, row);
                if(retainExpired||recoveryOnly)sealAuthority(bundle.authorityId,!recoveryOnly);
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
        }
    }

    /** Freeze intent BEFORE the cashier collects cash or records external card success. */
    public JSONObject beginPaymentIntent(String intentId, JSONObject input) throws Exception {
        uuid(intentId); JSONObject request = checkedRequest(input); String exact = canonical(request);
        String authorityId = request.getString("authorityId");
        synchronized (journal) {
            SQLiteDatabase db = journal.getWritableDatabase(); db.beginTransaction();
            try {
                try (Cursor c = db.rawQuery("SELECT request_json FROM intents WHERE id=?", new String[]{intentId})) {
                    if (c.moveToFirst()) {
                        if (!exact.equals(c.getString(0))) throw invalid("intent_conflict");
                        JSONObject result = intentState(db, intentId); db.setTransactionSuccessful(); return result;
                    }
                }
                if (hasUncertain(db)) throw invalid("payment_reconciliation_required");
                NativeShiftCloseJournal.requireNoPending(journal,serverKeys);
                OfflineBundle bundle = bundle(db, authorityId);NativeShiftCloseJournal.requireNoCloseForShift(db,bundle.shiftId); unlock.requireUnlocked(binding);
                requireStorableCustomer(request);
                OfflineCalculator.Calculation calculation = calculate(bundle, request);
                State state = state(db, authorityId); checkBudget(bundle, state, calculation.grossFils);
                OfflineClock.Tick tick = advance(db, bundle, state);
                journal.beginIntent(intentId, exact, iso(tick.estimatedServerMs));
                ContentValues row = new ContentValues(); row.put("intent_id", intentId); row.put("authority_id", authorityId); row.put("order_id", UUID.randomUUID().toString()); row.put("document_id", UUID.randomUUID().toString()); db.insertOrThrow("offline_intent_context", null, row);
                saveClock(db, authorityId, tick);
                JSONObject result = intentState(db, intentId); db.setTransactionSuccessful(); return result;
            } finally { db.endTransaction(); }
        }
    }

    /** Explicit cashier confirmation only; never invoked automatically from a recovery loop. */
    public String commitPaymentIntent(String intentId) throws Exception {
        uuid(intentId);
        synchronized (journal) {
            SQLiteDatabase db = journal.getWritableDatabase(); db.beginTransaction();
            try {
                JSONObject intent = intentState(db, intentId);
                if ("committed".equals(intent.getString("state"))) {
                    String original = receiptEnvelope(db, intent.getString("orderId")); db.setTransactionSuccessful(); return original;
                }
                if ("cancelled".equals(intent.getString("state"))) throw invalid("intent_cancelled");
                if ("frozen_for_manager".equals(intent.getString("state")) || "manager_resolved".equals(intent.getString("state"))) throw invalid("payment_frozen");
                if(hasUncertainPayments(journal,serverKeys,deviceKey,intentId))throw invalid("payment_reconciliation_required");
                JSONObject request = intent.getJSONObject("request"); OfflineBundle bundle = bundle(db, request.getString("authorityId"));
                NativeShiftCloseJournal.requireNoPending(journal,serverKeys);NativeShiftCloseJournal.requireNoCloseForShift(db,bundle.shiftId);
                unlock.requireUnlocked(binding); requireStorableCustomer(request);
                OfflineCalculator.Calculation calculation = calculate(bundle, request);
                State state = state(db, bundle.authorityId); checkBudget(bundle, state, calculation.grossFils);
                OfflineClock.Reading reading = safeReading(db, bundle); OfflineClock.Tick tick = advance(db, bundle, state, reading);
                long sequence; String previous;
                try (Cursor c = db.rawQuery("SELECT key_epoch,sequence,event_hash FROM offline_chain WHERE slot=1", null)) {
                    if (!c.moveToFirst() || !bundle.keyEpoch.equals(c.getString(0))) throw invalid("chain_missing");
                    sequence = Math.addExact(c.getLong(1), 1); previous = c.isNull(2) ? null : c.getString(2);
                }
                if (sequence > 9_007_199_254_740_991L) throw invalid("sequence_exhausted");
                String issuedAt = iso(tick.estimatedServerMs);
                String number = bundle.invoicePrefix + "-INV-" + String.format(Locale.ROOT, "%010d", state.nextNumber);
                JSONObject document = document(bundle, request, calculation, intent.getString("orderId"), intent.getString("documentId"), number, issuedAt);
                JSONObject payload = new JSONObject().put("kind", "offline-sale").put("schemaVersion", 1).put("id", intent.getString("orderId"))
                    .put("authorityId", bundle.authorityId).put("authoritySha256", bundle.authoritySha256).put("snapshotSha256", bundle.snapshotSha256)
                    .put("deviceSequence", sequence).put("previousEventSha256", previous == null ? JSONObject.NULL : previous).put("document", document)
                    .put("clock", new JSONObject().put("estimatedServerAt", issuedAt).put("bootId", reading.bootId).put("elapsedRealtimeMs", reading.elapsedRealtimeMs)).put("paymentIntentId", intentId);
                String signed = sign(payload); String result = journal.commitVerifiedIssuance(intentId, canonical(request), intent.getString("orderId"), number, issuedAt, calculation.grossFils, signed);
                ContentValues row = new ContentValues(); row.put("sequence", sequence); row.put("event_hash", SignedProtocol.hash(CanonicalJson.bytes(payload)));
                if (db.update("offline_chain", row, "slot=1", null) != 1) throw invalid("chain_missing");
                row = new ContentValues(); row.put("next_number", Math.addExact(state.nextNumber, 1)); row.put("gross_fils", Math.addExact(state.grossFils, calculation.grossFils)); row.put("clock_json", tick.nextState.toJson());
                if (db.update("offline_authority_state", row, "authority_id=?", new String[]{bundle.authorityId}) != 1) throw invalid("authority_missing");
                db.setTransactionSuccessful(); return result;
            } finally { db.endTransaction(); }
        }
    }

    /** Human reconciliation that explicitly confirms no money was collected. Retains the intent. */
    public void cancelUncollectedIntent(String intentId, String reason) throws Exception {
        uuid(intentId); text(reason, 240);
        synchronized (journal) {
            SQLiteDatabase db = journal.getWritableDatabase(); db.beginTransaction();
            try {
                JSONObject intent = intentState(db, intentId);
                unlock.requireUnlocked(binding);
                if ("committed".equals(intent.getString("state"))) throw invalid("already_issued");
                if ("frozen_for_manager".equals(intent.getString("state")) || "manager_resolved".equals(intent.getString("state"))) throw invalid("payment_frozen");
                if ("cancelled".equals(intent.getString("state"))) {
                    try (Cursor c = db.rawQuery("SELECT reason FROM offline_intent_cancellations WHERE intent_id=?", new String[]{intentId})) {
                        if (!c.moveToFirst() || !reason.equals(c.getString(0))) throw invalid("cancellation_conflict");
                    }
                } else {
                    bundle(db, intent.getJSONObject("request").getString("authorityId"));
                    ContentValues row = new ContentValues(); row.put("intent_id", intentId); row.put("reason", reason); row.put("cancelled_at", iso(clock.read().wallTimeMs)); db.insertOrThrow("offline_intent_cancellations", null, row);
                }
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
        }
    }

    /** Irreversibly freeze an unissued payment before any online manager request.
     * Returns custody evidence internally; the bridge returns only the display summary. */
    public String freezePaymentIntentForManager(String intentId)throws Exception {
        uuid(intentId);
        synchronized(journal){
            SQLiteDatabase db=journal.getWritableDatabase();db.beginTransaction();
            try {
                JSONObject base=freezeBase(db,intentId);unlock.requireUnlocked(binding);
                JSONObject saved=intentState(db,intentId);
                if("committed".equals(saved.getString("state")))throw invalid("already_issued");
                if("cancelled".equals(saved.getString("state")))throw invalid("intent_cancelled");
                if("frozen_for_manager".equals(saved.getString("state"))||"manager_resolved".equals(saved.getString("state"))){String original=verifiedFreeze(db,intentId,base).getString("envelope");db.setTransactionSuccessful();return original;}
                JSONObject head;
                try(Cursor c=db.rawQuery("SELECT key_epoch,sequence,event_hash FROM offline_chain WHERE slot=1",null)){
                    if(!c.moveToFirst()||!binding.keyEpoch.equals(c.getString(0)))throw invalid("chain_missing");
                    head=new JSONObject().put("sequence",c.getLong(1)).put("eventSha256",c.isNull(2)?JSONObject.NULL:c.getString(2));checkFreezeHead(head);
                }
                Object observation=JSONObject.NULL;
                // Diagnostic only. This does not advance an authority clock or authorize a sale.
                // The PIN guard is still mandatory; a failed PIN clock cannot be bypassed here.
                try {OfflineClock.Reading reading=clock.read();observation=new JSONObject().put("bootId",reading.bootId).put("elapsedRealtimeMs",reading.elapsedRealtimeMs).put("wallTimeMs",reading.wallTimeMs);}
                catch(Exception unavailable){/* Preserve unknown observation honestly. */}
                String freezeId=UUID.randomUUID().toString();JSONObject payload=base.put("freezeId",freezeId).put("chainHead",head).put("observation",observation);
                String envelope=sign(payload);SignedProtocol.Verified verified=SignedProtocol.verify(envelope,Collections.singletonMap(SignedProtocol.fingerprint(deviceKey),deviceKey));
                ContentValues row=new ContentValues();row.put("intent_id",intentId);row.put("freeze_id",freezeId);row.put("proof_payload_sha256",verified.payloadSha256);row.put("proof_envelope",envelope);row.put("envelope_sha256",NativeJournal.hash(envelope));row.put("frozen_observation_json",canonicalValue(observation));
                db.insertOrThrow("offline_intent_freezes",null,row);db.setTransactionSuccessful();return envelope;
            }finally{db.endTransaction();}
        }
    }
    private JSONObject freezeBase(SQLiteDatabase db,String intentId)throws Exception {
        try(Cursor c=db.rawQuery("SELECT i.request_json,i.request_hash,i.created_at,x.authority_id,x.order_id,x.document_id FROM intents i JOIN offline_intent_context x ON x.intent_id=i.id WHERE i.id=?",new String[]{intentId})){
            if(!c.moveToFirst())throw invalid("intent_missing");
            String exact=c.getString(0);JSONObject request=checkedRequest(object(CanonicalJson.parse(exact.getBytes(StandardCharsets.UTF_8))));
            if(!canonical(request).equals(exact)||!NativeJournal.hash(exact).equals(c.getString(1))||!request.getString("authorityId").equals(c.getString(3)))throw invalid("intent_integrity_failed");
            OfflineBundle b=bundle(db,c.getString(3));calculate(b,request);String created=c.getString(2);strictIso(created);uuid(c.getString(4));uuid(c.getString(5));
            return new JSONObject().put("kind","offline-payment-freeze").put("schemaVersion",1).put("paymentIntentId",intentId).put("orderId",c.getString(4)).put("documentId",c.getString(5))
                .put("organizationId",b.organizationId).put("branchId",b.branchId).put("deviceId",b.deviceId).put("actorId",b.actorId).put("shiftId",b.shiftId).put("keyEpoch",b.keyEpoch).put("deviceKeySha256",b.deviceKeySha256)
                .put("authorityId",b.authorityId).put("authoritySha256",b.authoritySha256).put("snapshotSha256",b.snapshotSha256).put("requestSha256",c.getString(1)).put("request",request).put("intentCreatedAt",created)
                .put("declaration","local-intent-unissued-and-permanently-frozen");
        }
    }
    private JSONObject verifiedFreeze(SQLiteDatabase db,String id,JSONObject base)throws Exception {
        try(Cursor c=db.rawQuery("SELECT freeze_id,proof_payload_sha256,proof_envelope,envelope_sha256,frozen_observation_json FROM offline_intent_freezes WHERE intent_id=?",new String[]{id})){
            if(!c.moveToFirst())throw invalid("freeze_missing");String envelope=c.getString(2);
            if(!NativeJournal.hash(envelope).equals(c.getString(3)))throw invalid("freeze_integrity_failed");
            SignedProtocol.Verified verified=SignedProtocol.verify(envelope,Collections.singletonMap(SignedProtocol.fingerprint(deviceKey),deviceKey));JSONObject proof=object(verified.payload());
            if(!verified.payloadSha256.equals(c.getString(1))||!c.getString(0).equals(string(proof,"freezeId")))throw invalid("freeze_integrity_failed");uuid(c.getString(0));
            checkFreezeHead(proof.getJSONObject("chainHead"));Object observation=proof.get("observation");
            if(observation!=JSONObject.NULL){JSONObject value=object(observation);fields(value,"bootId","elapsedRealtimeMs","wallTimeMs");new OfflineClock.Reading(string(value,"bootId"),integer(value,"elapsedRealtimeMs",0,9_007_199_254_740_991L),integer(value,"wallTimeMs",0,OfflineClock.MAX_TIME_MS));}
            if(!canonicalValue(observation).equals(c.getString(4)))throw invalid("freeze_integrity_failed");
            proof.remove("freezeId");proof.remove("chainHead");proof.remove("observation");
            if(!canonical(proof).equals(canonical(base)))throw invalid("freeze_integrity_failed");
            return new JSONObject().put("envelope",envelope).put("managerReview",new JSONObject().put("freezeId",c.getString(0)).put("proofSha256",c.getString(1)).put("status","saved_locally"));
        }
    }
    private static void checkFreezeHead(JSONObject head)throws Exception {
        fields(head,"sequence","eventSha256");long sequence=integer(head,"sequence",0,9_007_199_254_740_991L);
        if(sequence==0){if(!head.isNull("eventSha256"))throw invalid("chain_missing");}
        else if(!(head.get("eventSha256") instanceof String)||!head.getString("eventSha256").matches("[0-9a-f]{64}"))throw invalid("chain_missing");
    }
    private static String canonicalValue(Object value)throws Exception{return new String(CanonicalJson.bytes(value),StandardCharsets.UTF_8);}

    /** Stop new issuance durably BEFORE returning the exact signed terminal declaration. */
    public String sealAuthority(String authorityId) throws Exception { return sealAuthority(authorityId,true); }
    private String sealAuthority(String authorityId,boolean requireUnlock) throws Exception {
        uuid(authorityId);
        synchronized (journal) {
            SQLiteDatabase db = journal.getWritableDatabase(); db.beginTransaction();
            try {
                OfflineBundle bundle = bundle(db, authorityId); State state = state(db, authorityId);
                if (state.seal != null) { db.setTransactionSuccessful(); return state.seal; }
                if(requireUnlock)unlock.requireUnlocked(binding);
                if (hasUncertain(db)) throw invalid("payment_reconciliation_required");
                long sequence; String hash;
                try (Cursor c = db.rawQuery("SELECT sequence,event_hash FROM offline_chain WHERE slot=1", null)) {
                    if (!c.moveToFirst()) throw invalid("chain_missing"); sequence = c.getLong(0); hash = c.isNull(1) ? null : c.getString(1);
                }
                JSONObject payload = new JSONObject().put("kind", "offline-seal").put("schemaVersion", 1).put("id", UUID.randomUUID().toString())
                    .put("authorityId", authorityId).put("keyEpoch", bundle.keyEpoch).put("deviceId", bundle.deviceId).put("finalSequence", sequence).put("finalEventSha256", hash == null ? JSONObject.NULL : hash);
                String envelope = sign(payload); ContentValues row = new ContentValues(); row.put("seal_envelope", envelope); db.update("offline_authority_state", row, "authority_id=?", new String[]{authorityId}); db.setTransactionSuccessful(); return envelope;
            } finally { db.endTransaction(); }
        }
    }

    /** Verify exact server custody before dropping an outbox entry. Works while locally locked. */
    public void acknowledgeIssuance(String acknowledgement) throws Exception {
        SignedProtocol.Verified verified = SignedProtocol.verify(acknowledgement, serverKeys);
        JSONObject ack = object(verified.payload()); fields(ack, "kind", "schemaVersion", "id", "issuanceId", "payloadSha256", "authorityId", "keyEpoch", "deviceSequence", "receivedAt");
        if (!"offline-ack".equals(string(ack,"kind")) || integer(ack,"schemaVersion",1,1)!=1) throw invalid("invalid_ack");
        uuid(string(ack,"id")); String receiptId = string(ack,"issuanceId"); uuid(receiptId); uuid(string(ack,"authorityId")); uuid(string(ack,"keyEpoch"));
        integer(ack,"deviceSequence",1,9_007_199_254_740_991L); String received = string(ack,"receivedAt"); strictIso(received);
        synchronized (journal) {
            SQLiteDatabase db = journal.getWritableDatabase(); db.beginTransaction();
            try {
                String receiptEnvelope = receiptEnvelope(db, receiptId);
                SignedProtocol.Verified original = SignedProtocol.verify(receiptEnvelope, Collections.singletonMap(SignedProtocol.fingerprint(deviceKey), deviceKey));
                JSONObject issuance = object(original.payload());
                if (!original.payloadSha256.equals(string(ack,"payloadSha256")) || !issuance.getString("authorityId").equals(ack.getString("authorityId")) || issuance.getLong("deviceSequence") != ack.getLong("deviceSequence")) throw invalid("ack_mismatch");
                String epoch;
                try (Cursor c = db.rawQuery("SELECT key_epoch FROM offline_chain WHERE slot=1", null)) { if (!c.moveToFirst()) throw invalid("chain_missing"); epoch=c.getString(0); }
                if (!epoch.equals(ack.getString("keyEpoch"))) throw invalid("ack_mismatch");
                try (Cursor c = db.rawQuery("SELECT ack_json FROM acknowledgements WHERE receipt_id=?", new String[]{receiptId})) {
                    if (c.moveToFirst()) {
                        if (!SignedProtocol.verify(c.getString(0), serverKeys).payloadSha256.equals(verified.payloadSha256)) throw invalid("ack_conflict");
                        db.setTransactionSuccessful(); return;
                    }
                }
                journal.acknowledgeVerified(receiptId, original.payloadSha256, acknowledgement, received); db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
        }
    }

    public JSONObject getIntent(String intentId) throws Exception {
        uuid(intentId); synchronized (journal) { return intentState(journal.getReadableDatabase(), intentId); }
    }
    /** Quote only: no invoice numbers, intent, payment, or clock state is changed. */
    JSONObject quoteBasket(JSONObject input) throws Exception {
        JSONObject draft=object(CanonicalJson.parse(CanonicalJson.bytes(input)));
        fields(draft,"authorityId","serviceType","customer","lines","tenderMode","cashTenderedFils","recordedCardFils");
        String mode=string(draft,"tenderMode");
        if(!java.util.Arrays.asList("cash","card","mixed").contains(mode))throw invalid("invalid_tender");
        Long cash=draft.isNull("cashTenderedFils")?null:integer(draft,"cashTenderedFils",0,OfflineCalculator.MAX_FILS);
        Long card=draft.isNull("recordedCardFils")?null:integer(draft,"recordedCardFils",0,OfflineCalculator.MAX_FILS);
        JSONObject request=new JSONObject().put("authorityId",draft.get("authorityId")).put("serviceType",draft.get("serviceType"))
            .put("customer",draft.get("customer")).put("lines",draft.get("lines")).put("cashTenderedFils",0).put("recordedCardFils",0).put("presentedTotalFils",1);
        checkedRequest(request);
        requireStorableCustomer(request);
        synchronized(journal){
            OfflineBundle bundle=bundle(journal.getReadableDatabase(),request.getString("authorityId"));
            // Preliminary arithmetic uses sufficient hypothetical tender only to obtain gross.
            // It is never persisted or exposed; the final quote uses the actual planned tender.
            long gross=OfflineCalculator.calculate(OfflineCalculator.VERSION,true,inputs(bundle,request),OfflineCalculator.MAX_FILS,0).grossFils;
            long finalCard,finalCash;
            if(mode.equals("cash")){if(card!=null&&card!=0)throw invalid("invalid_tender");finalCard=0;finalCash=cash==null?gross:cash;}
            else if(mode.equals("card")){if((cash!=null&&cash!=0)||(card!=null&&card!=gross))throw invalid("invalid_tender");finalCard=gross;finalCash=0;}
            else{if(card==null||card<=0||card>=gross)throw invalid("invalid_tender");finalCard=card;finalCash=cash==null?gross-card:cash;}
            request.put("cashTenderedFils",finalCash).put("recordedCardFils",finalCard).put("presentedTotalFils",gross);
            return quote(bundle,request,calculate(bundle,request,false));
        }
    }
    JSONObject quoteRequest(JSONObject request)throws Exception{
        synchronized(journal){OfflineBundle b=bundle(journal.getReadableDatabase(),string(request,"authorityId"));return quote(b,request,calculate(b,request,false));}
    }
    /** Recheck native unlock, current clock and budget without reserving or issuing anything. */
    void requireReady(String authorityId,JSONObject request)throws Exception{
        synchronized(journal){SQLiteDatabase db=journal.getWritableDatabase();db.beginTransaction();try{
            OfflineBundle b=bundle(db,authorityId);unlock.requireUnlocked(binding);
            NativeShiftCloseJournal.requireNoPending(journal,serverKeys);NativeShiftCloseJournal.requireNoCloseForShift(db,b.shiftId);
            if(request!=null)requireStorableCustomer(request);
            long gross=request==null?1:calculate(b,request).grossFils;State state=state(db,authorityId);
            checkBudget(b,state,gross);OfflineClock.Tick tick=advance(db,b,state);saveClock(db,authorityId,tick);db.setTransactionSuccessful();
        }finally{db.endTransaction();}}
    }
    JSONObject receiptForDisplay(String id)throws Exception{
        uuid(id);synchronized(journal){SQLiteDatabase db=journal.getReadableDatabase();
            String envelope=receiptEnvelope(db,id);
            JSONObject payload=object(SignedProtocol.verify(envelope,Collections.singletonMap(SignedProtocol.fingerprint(deviceKey),deviceKey)).payload());
            OfflineBundle b=bundle(db,payload.getString("authorityId"));unlock.requireUnlocked(binding);
            JSONObject intent=intentState(db,payload.getString("paymentIntentId"));JSONObject request=intent.getJSONObject("request");
            JSONObject doc=payload.getJSONObject("document");
            if(!id.equals(payload.getString("id"))||!id.equals(intent.getString("orderId"))||!"committed".equals(intent.getString("state"))
                ||!b.authorityId.equals(request.getString("authorityId"))||!b.snapshotSha256.equals(payload.getString("snapshotSha256"))||!b.authoritySha256.equals(payload.getString("authoritySha256")))throw invalid("receipt_integrity_failed");
            JSONObject expected=document(b,request,calculate(b,request),id,intent.getString("documentId"),doc.getString("documentNumber"),doc.getString("issuedAt"));
            if(!canonical(expected).equals(canonical(doc)))throw invalid("receipt_integrity_failed");
            return doc;
        }
    }
    private static JSONObject quote(OfflineBundle b,JSONObject request,OfflineCalculator.Calculation c)throws Exception{
        JSONObject doc=document(b,request,c,"","","","");
        return new JSONObject().put("schemaVersion",1).put("authorityId",b.authorityId).put("request",object(CanonicalJson.parse(CanonicalJson.bytes(request))))
            .put("lines",doc.get("lines")).put("totals",doc.get("totals")).put("payments",doc.get("payments"))
            .put("cashTenderedFils",c.cashTenderedFils).put("changeFils",c.changeFils).put("requiresBuyerDetails",c.requiresBuyerDetails);
    }
    public JSONArray listPendingIssuances() throws Exception {
        synchronized (journal) {
            JSONArray result = new JSONArray();
            try (Cursor c = journal.getReadableDatabase().rawQuery("SELECT r.envelope_json FROM receipts r JOIN outbox o ON o.receipt_id=r.id JOIN offline_intent_context i ON i.intent_id=r.intent_id ORDER BY r.rowid LIMIT 100", null)) {
                while (c.moveToNext()) { SignedProtocol.verify(c.getString(0), Collections.singletonMap(SignedProtocol.fingerprint(deviceKey),deviceKey)); result.put(new JSONObject(c.getString(0))); }
            }
            return result;
        }
    }

    private OfflineBundle bundle(SQLiteDatabase db, String id) throws Exception {
        try (Cursor c = db.rawQuery("SELECT snapshot_envelope,authority_envelope FROM offline_bundles WHERE id=?", new String[]{id})) {
            if (!c.moveToFirst()) throw invalid("authority_missing"); return OfflineBundle.verify(c.getString(0),c.getString(1),serverKeys,binding);
        }
    }
    private static final class State {
        long nextNumber, grossFils; String clockJson, seal; boolean blocked;
    }
    private static State state(SQLiteDatabase db, String id) {
        try (Cursor c = db.rawQuery("SELECT next_number,gross_fils,clock_json,blocked,seal_envelope FROM offline_authority_state WHERE authority_id=?",new String[]{id})) {
            if (!c.moveToFirst()) throw invalid("authority_missing"); State s=new State(); s.nextNumber=c.getLong(0); s.grossFils=c.getLong(1); s.clockJson=c.getString(2); s.blocked=c.getInt(3)!=0; s.seal=c.isNull(4)?null:c.getString(4); return s;
        }
    }
    private static void checkBudget(OfflineBundle bundle, State state, long gross) {
        if (state.blocked || state.seal!=null) throw invalid("authority_closed");
        if (state.nextNumber<bundle.firstInvoice || state.nextNumber>bundle.lastInvoice || gross>bundle.maxInvoiceTotalFils || state.grossFils>bundle.maxGrossFils-gross) throw invalid("authority_exhausted");
    }
    private OfflineClock.Tick advance(SQLiteDatabase db, OfflineBundle bundle, State state) throws Exception { return advance(db,bundle,state,safeReading(db,bundle)); }
    private OfflineClock.Tick advance(SQLiteDatabase db, OfflineBundle bundle, State state, OfflineClock.Reading reading) throws Exception {
        try { return OfflineClock.advance(OfflineClock.State.fromJson(state.clockJson),reading,bundle.notBeforeMs,bundle.expiresAtMs); }
        catch (OfflineClock.ClockException error) {
            if (!"clock_not_started".equals(error.code) && !"clock_expired".equals(error.code)) {
                // Called before any financial writes in this transaction. Persist detected anomaly
                // even though the requested sale fails; restarting must not erase the warning.
                ContentValues row=new ContentValues(); row.put("blocked",1); db.update("offline_authority_state",row,"authority_id=?",new String[]{bundle.authorityId}); db.setTransactionSuccessful();
            }
            throw error;
        }
    }
    private OfflineClock.Reading safeReading(SQLiteDatabase db, OfflineBundle bundle) throws Exception {
        try { return clock.read(); }
        catch (OfflineClock.ClockException error) {
            if (error.isAnomaly()) {
                ContentValues row=new ContentValues(); row.put("blocked",1); db.update("offline_authority_state",row,"authority_id=?",new String[]{bundle.authorityId}); db.setTransactionSuccessful();
            }
            throw error;
        }
    }
    private static void saveClock(SQLiteDatabase db,String id,OfflineClock.Tick tick) throws Exception {
        ContentValues row=new ContentValues(); row.put("clock_json",tick.nextState.toJson()); db.update("offline_authority_state",row,"authority_id=?",new String[]{id});
    }
    private boolean hasUncertain(SQLiteDatabase db)throws Exception { return hasUncertainPayments(journal,serverKeys,deviceKey); }
    private static boolean exists(SQLiteDatabase db,String sql) { try(Cursor c=db.rawQuery(sql,null)){return c.moveToFirst();} }
    private JSONObject intentState(SQLiteDatabase db,String id) throws Exception {
        try(Cursor c=db.rawQuery("SELECT i.request_json,i.receipt_id,x.order_id,x.document_id,c.intent_id,f.intent_id FROM intents i JOIN offline_intent_context x ON x.intent_id=i.id LEFT JOIN offline_intent_cancellations c ON c.intent_id=i.id LEFT JOIN offline_intent_freezes f ON f.intent_id=i.id WHERE i.id=?",new String[]{id})) {
            if(!c.moveToFirst())throw invalid("intent_missing");
            if(!c.isNull(5)&&(!c.isNull(1)||!c.isNull(4)))throw invalid("freeze_integrity_failed");
            JSONObject result=new JSONObject().put("intentId",id).put("state",!c.isNull(1)?"committed":!c.isNull(4)?"cancelled":!c.isNull(5)?"frozen_for_manager":"payment_confirmation_required")
                .put("orderId",c.getString(2)).put("documentId",c.getString(3)).put("request",CanonicalJson.parse(c.getString(0).getBytes(StandardCharsets.UTF_8)));
            if(!c.isNull(5)){
                JSONObject saved=verifiedFreeze(db,id,freezeBase(db,id));
                JSONObject proof=object(SignedProtocol.verify(saved.getString("envelope"),Collections.singletonMap(SignedProtocol.fingerprint(deviceKey),deviceKey)).payload());
                JSONObject review=resolutionReview(db,id,saved,proof);result.put("managerReview",review);
                if("accepted_on_device".equals(review.getString("status")))result.put("state","manager_resolved");
            }
            return result;
        }
    }
    private static String receiptEnvelope(SQLiteDatabase db,String id) {
        try(Cursor c=db.rawQuery("SELECT envelope_json,envelope_hash FROM receipts WHERE id=?",new String[]{id})) {
            if(!c.moveToFirst() || !NativeJournal.hash(c.getString(0)).equals(c.getString(1)))throw invalid("receipt_integrity_failed"); return c.getString(0);
        }
    }
    private String sign(JSONObject payload) throws Exception {
        byte[] bytes=CanonicalJson.bytes(payload), signature=signer.sign(bytes); SignedProtocol.requireDer(signature);
        String envelope=new JSONObject().put("format","pos-signed-v1").put("alg","ECDSA-P256-SHA256-DER").put("keyId",SignedProtocol.fingerprint(deviceKey))
            .put("payloadBase64Url",SignedProtocol.encode(bytes)).put("signatureBase64Url",SignedProtocol.encode(signature)).toString();
        SignedProtocol.verify(envelope,Collections.singletonMap(SignedProtocol.fingerprint(deviceKey),deviceKey)); return envelope;
    }
    /** New financial actions must be representable in PostgreSQL. Historical signed requests
     * remain readable and freezable byte-for-byte; never normalize their customer fields. */
    private static void requireStorableCustomer(JSONObject request) throws Exception {
        if (!request.isNull("customer")) {
            JSONObject customer = request.getJSONObject("customer");
            if (customer.getString("name").indexOf('\0') >= 0 || customer.getString("address").indexOf('\0') >= 0)
                throw invalid("unsupported_text");
        }
    }
    private static JSONObject checkedRequest(JSONObject raw) throws Exception {
        JSONObject r=object(CanonicalJson.parse(CanonicalJson.bytes(raw)));
        fields(r,"authorityId","serviceType","customer","lines","cashTenderedFils","recordedCardFils","presentedTotalFils"); uuid(string(r,"authorityId"));
        if(!java.util.Arrays.asList("dine_in","takeaway","delivery").contains(string(r,"serviceType")))throw invalid("invalid_service_type");
        if(r.get("customer")!=JSONObject.NULL){JSONObject customer=object(r.get("customer")); fields(customer,"name","address","trn"); text(string(customer,"name"),200);text(string(customer,"address"),400);if(customer.get("trn")!=JSONObject.NULL&&!string(customer,"trn").matches("[0-9]{15}"))throw invalid("invalid_customer");}
        if(!(r.get("lines") instanceof JSONArray))throw invalid("invalid_lines");JSONArray lines=r.getJSONArray("lines");if(lines.length()<1||lines.length()>200)throw invalid("invalid_lines");
        for(int i=0;i<lines.length();i++){JSONObject line=object(lines.get(i));fields(line,"productId","quantityMilli");uuid(string(line,"productId"));integer(line,"quantityMilli",1,1_000_000);}
        integer(r,"cashTenderedFils",0,100_000_000);integer(r,"recordedCardFils",0,100_000_000);integer(r,"presentedTotalFils",1,100_000_000);return r;
    }
    private static OfflineCalculator.Calculation calculate(OfflineBundle bundle,JSONObject request) throws Exception {
        return calculate(bundle,request,true);
    }
    private static List<OfflineCalculator.InputLine> inputs(OfflineBundle bundle,JSONObject request)throws Exception{
        checkedRequest(request);List<OfflineCalculator.InputLine> inputs=new ArrayList<>();JSONArray lines=request.getJSONArray("lines");
        for(int i=0;i<lines.length();i++){JSONObject line=lines.getJSONObject(i);OfflineBundle.Product product=bundle.product(line.getString("productId"));inputs.add(product.calculatorInput(line.getLong("quantityMilli")));}return inputs;
    }
    private static OfflineCalculator.Calculation calculate(OfflineBundle bundle,JSONObject request,boolean requireBuyer) throws Exception {
        OfflineCalculator.Calculation c=OfflineCalculator.calculate(OfflineCalculator.VERSION,true,inputs(bundle,request),request.getLong("cashTenderedFils"),request.getLong("recordedCardFils"));
        if(c.grossFils!=request.getLong("presentedTotalFils"))throw invalid("presented_total_changed");
        boolean cash=false,card=false;for(OfflineCalculator.Payment p:c.payments){cash|="cash".equals(p.method);card|="card".equals(p.method);}
        if((cash&&!bundle.cashAllowed)||(card&&!bundle.recordedCardAllowed)||(cash&&card&&!bundle.mixedTenderAllowed))throw invalid("tender_not_authorized");
        if(requireBuyer&&c.requiresBuyerDetails&&request.isNull("customer"))throw invalid("buyer_details_required");return c;
    }
    private static JSONObject document(OfflineBundle bundle,JSONObject request,OfflineCalculator.Calculation c,String orderId,String documentId,String number,String issuedAt)throws Exception{
        JSONArray lines=new JSONArray(),payments=new JSONArray();
        for(OfflineCalculator.Line l:c.lines)lines.put(new JSONObject().put("lineNumber",l.lineNumber).put("productId",l.productId).put("name",l.name).put("unit",l.unit.name()).put("quantityMilli",l.quantityMilli).put("unitPriceFils",l.unitPriceFils).put("taxRateBps",l.taxRateBps).put("grossFils",l.grossFils).put("netFils",l.netFils).put("taxFils",l.taxFils));
        for(OfflineCalculator.Payment p:c.payments)payments.put(new JSONObject().put("method",p.method).put("amountFils",p.amountFils));
        return new JSONObject().put("schemaVersion",1).put("kind","tax_invoice").put("id",documentId).put("orderId",orderId).put("documentNumber",number).put("issuedAt",issuedAt)
            .put("merchant",bundle.profile()).put("branchId",bundle.branchId).put("deviceId",bundle.deviceId).put("shiftId",bundle.shiftId).put("actorId",bundle.actorId)
            .put("serviceType",request.get("serviceType")).put("customer",request.get("customer")).put("lines",lines).put("totals",new JSONObject().put("grossFils",c.grossFils).put("netFils",c.netFils).put("taxFils",c.taxFils))
            .put("payments",payments).put("paymentSettlement","recorded").put("cashTenderedFils",c.cashTenderedFils).put("changeFils",c.changeFils);
    }
    private static JSONObject object(Object v){if(!(v instanceof JSONObject))throw invalid("invalid_object");return (JSONObject)v;}
    private static String string(JSONObject o,String key)throws Exception{Object v=o.get(key);if(!(v instanceof String))throw invalid("invalid_string");return (String)v;}
    private static void fields(JSONObject o,String...keys){if(o.length()!=keys.length)throw invalid("unexpected_field");for(String key:keys)if(!o.has(key))throw invalid("missing_field");}
    private static long integer(JSONObject o,String key,long min,long max)throws Exception{Object v=o.get(key);if(!(v instanceof Integer)&&!(v instanceof Long))throw invalid("invalid_integer");long n=((Number)v).longValue();if(n<min||n>max)throw invalid("invalid_integer");return n;}
    private static void uuid(String id){if(id==null||!id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))throw invalid("invalid_id");}
    private static void text(String value,int max){if(value.isEmpty()||value.length()>max||trimChar(value.charAt(0))||trimChar(value.charAt(value.length()-1)))throw invalid("invalid_text");}
    private static boolean trimChar(char c){return c==0x0009||c==0x000a||c==0x000b||c==0x000c||c==0x000d||c==0x0020||c==0x00a0||c==0x1680||(c>=0x2000&&c<=0x200a)||c==0x2028||c==0x2029||c==0x202f||c==0x205f||c==0x3000||c==0xfeff;}
    private static String canonical(Object value)throws Exception{return new String(CanonicalJson.bytes(value),StandardCharsets.UTF_8);}
    static String iso(long millis){java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",Locale.ROOT);f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));return f.format(new java.util.Date(millis));}
    static void strictIso(String value)throws Exception{if(!value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z"))throw invalid("invalid_timestamp");java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",Locale.ROOT);f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));f.setLenient(false);if(!iso(f.parse(value).getTime()).equals(value))throw invalid("invalid_timestamp");}
    private static IllegalStateException invalid(String code){return new IllegalStateException(code);}
}
