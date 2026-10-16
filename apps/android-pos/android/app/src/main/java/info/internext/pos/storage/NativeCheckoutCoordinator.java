package info.internext.pos.storage;

import android.database.Cursor;
import info.internext.pos.offline.OfflineBundle;
import info.internext.pos.offline.OfflineClock;
import org.json.JSONArray;
import org.json.JSONObject;

/** Scope/PIN boundary for the counter. Browser values never grant permission to issue.
 * Production remains disabled until payment-expiry recovery and device acceptance are complete. */
public final class NativeCheckoutCoordinator {
    interface ContextSource { CheckoutContext load(boolean requireUnlocked) throws Exception; }
    static final class CheckoutContext {
        final OfflineBundle bundle; final NativeCheckoutEngine engine;
        CheckoutContext(OfflineBundle bundle,NativeCheckoutEngine engine){this.bundle=bundle;this.engine=engine;}
    }
    private final NativeJournal journal;
    private final ContextSource source;
    private final boolean releaseEnabled;
    public NativeCheckoutCoordinator(NativeJournal journal,NativeOfflineCoordinator offline){this(journal,offline::checkoutContext,false);}
    // This constructor is only accessible to native package tests, never a PluginCall/config flag.
    NativeCheckoutCoordinator(NativeJournal journal,ContextSource source,boolean releaseEnabled){this.journal=journal;this.source=source;this.releaseEnabled=releaseEnabled;}

    public synchronized JSONObject getState()throws Exception{
        // References alone are conservative custody markers while signed out. A result row
        // is never sufficient to hide one; signed-result verification happens below.
        String pending=firstId("SELECT i.id FROM intents i LEFT JOIN offline_intent_cancellations c ON c.intent_id=i.id WHERE i.receipt_id IS NULL AND c.intent_id IS NULL ORDER BY i.rowid LIMIT 1");
        String last=firstId("SELECT r.id FROM receipts r JOIN offline_intent_context x ON x.intent_id=r.intent_id ORDER BY r.rowid DESC LIMIT 1");
        JSONObject state=new JSONObject().put("schemaVersion",1).put("canIssue",false).put("reasonCode",JSONObject.NULL)
            .put("context",JSONObject.NULL).put("pendingIntentId",nullable(pending)).put("lastReceiptId",nullable(last))
            .put("unresolvedIntent",JSONObject.NULL).put("lastReceipt",JSONObject.NULL)
            .put("lastResolvedIntentId",JSONObject.NULL).put("lastResolvedIntent",JSONObject.NULL);
        try{
            // Never acquire the session source while holding the journal monitor.
            CheckoutContext visible=source.load(false);state.put("context",context(visible.bundle));
            synchronized(journal){
                pending=null;
                try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT i.id FROM intents i LEFT JOIN offline_intent_cancellations c ON c.intent_id=i.id WHERE i.receipt_id IS NULL AND c.intent_id IS NULL ORDER BY i.rowid",null)){
                    while(c.moveToNext())if(!visible.engine.isPaymentResolved(c.getString(0))){pending=c.getString(0);break;}
                }
                try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT r.id FROM receipts r JOIN offline_intent_context x ON x.intent_id=r.intent_id WHERE x.authority_id=? ORDER BY r.rowid DESC LIMIT 1",new String[]{visible.bundle.authorityId})){
                    last=c.moveToFirst()?c.getString(0):null;
                }
                state.put("pendingIntentId",nullable(pending)).put("lastReceiptId",nullable(last));
            }
            CheckoutContext unlocked=source.load(true);state.put("context",context(unlocked.bundle));
            synchronized(journal){
                // Re-read after the PIN boundary: a concurrent recovery may have added a conflict.
                pending=null;last=null;String resolved=null;
                try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT i.id FROM intents i LEFT JOIN offline_intent_cancellations c ON c.intent_id=i.id WHERE i.receipt_id IS NULL AND c.intent_id IS NULL ORDER BY i.rowid",null)){
                    while(c.moveToNext())if(!unlocked.engine.isPaymentResolved(c.getString(0))){pending=c.getString(0);break;}
                }
                try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT r.id FROM receipts r JOIN offline_intent_context x ON x.intent_id=r.intent_id WHERE x.authority_id=? ORDER BY r.rowid DESC LIMIT 1",new String[]{unlocked.bundle.authorityId})){
                    if(c.moveToFirst())last=c.getString(0);
                }
                try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT r.intent_id FROM offline_payment_results r JOIN offline_intent_context x ON x.intent_id=r.intent_id WHERE x.authority_id=? ORDER BY r.rowid DESC",new String[]{unlocked.bundle.authorityId})){
                    while(c.moveToNext())if(unlocked.engine.isPaymentResolved(c.getString(0))){resolved=c.getString(0);break;}
                }
                state.put("pendingIntentId",nullable(pending)).put("lastReceiptId",nullable(last));
                if(pending!=null)state.put("unresolvedIntent",intent(unlocked,pending));
                if(last!=null)state.put("lastReceipt",receipt(unlocked,last));
                if(resolved!=null)state.put("lastResolvedIntentId",resolved).put("lastResolvedIntent",intent(unlocked,resolved));
                if(pending!=null)return state.put("reasonCode","frozen_for_manager".equals(state.getJSONObject("unresolvedIntent").getString("state"))?"payment_frozen":"payment_reconciliation_required");
                requireReleased();unlocked.engine.requireReady(unlocked.bundle.authorityId,null);state.put("canIssue",true);
            }
        }catch(Exception error){state.put("reasonCode",code(error));}
        return state;
    }
    public synchronized JSONObject quoteBasket(JSONObject input)throws Exception{
        CheckoutContext context=source.load(false);requireAuthority(context,input.getString("authorityId"));
        return context.engine.quoteBasket(input);
    }
    public synchronized JSONObject beginPaymentIntent(String id,JSONObject request)throws Exception{
        CheckoutContext context=source.load(true);requireAuthority(context,request.getString("authorityId"));
        synchronized(journal){
            // A lost result may be recovered while issuance is paused, but still requires the
            // original actor, PIN and exact saved request. It never starts a replacement intent.
            if(intentExists(id)){
                requireIntentScope(context,id);
                context.engine.beginPaymentIntent(id,request);return intent(context,id);
            }
            requireReleased();context.engine.beginPaymentIntent(id,request);return intent(context,id);
        }
    }
    public synchronized JSONObject getPaymentIntent(String id)throws Exception{
        CheckoutContext context=source.load(true);synchronized(journal){return intent(context,id);}
    }
    public synchronized JSONObject confirmPaymentIntent(String id)throws Exception{
        CheckoutContext context=source.load(true);
        synchronized(journal){
            requireIntentScope(context,id);
            JSONObject original=context.engine.getIntent(id);
            if("frozen_for_manager".equals(original.getString("state"))||"manager_resolved".equals(original.getString("state")))throw fail("payment_frozen");
            if(!"committed".equals(original.getString("state")))requireReleased();
            context.engine.commitPaymentIntent(id);return intent(context,id);
        }
    }
    public synchronized JSONObject cancelUncollectedIntent(String id,String reason)throws Exception{
        CheckoutContext context=source.load(true);synchronized(journal){requireIntentScope(context,id);
            context.engine.cancelUncollectedIntent(id,reason);return intent(context,id);}
    }
    public synchronized JSONObject freezePaymentIntentForManager(String id)throws Exception{
        CheckoutContext context=source.load(true);
        synchronized(journal){requireIntentScope(context,id);context.engine.freezePaymentIntentForManager(id);return intent(context,id);}
    }
    public synchronized JSONObject getReceipt(String id)throws Exception{
        CheckoutContext context=source.load(true);synchronized(journal){return receipt(context,id);}
    }
    private JSONObject intent(CheckoutContext context,String id)throws Exception{
        requireIntentScope(context,id);JSONObject saved=context.engine.getIntent(id),request=saved.getJSONObject("request");
        String created;
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT created_at FROM intents WHERE id=?",new String[]{id})){if(!c.moveToFirst())throw fail("intent_missing");created=c.getString(0);}
        String status=saved.getString("state"),reason=status.equals("frozen_for_manager")?"payment_frozen":null;boolean canConfirm=false,canCancel=status.equals("payment_confirmation_required");
        if(canCancel){try{requireReleased();context.engine.requireReady(context.bundle.authorityId,request);canConfirm=true;}catch(Exception error){reason=code(error);}}
        JSONObject result=new JSONObject().put("schemaVersion",1).put("intentId",id).put("state",status).put("createdAt",created)
            .put("request",request).put("quote",context.engine.quoteRequest(request)).put("canConfirm",canConfirm).put("canCancel",canCancel)
            .put("reasonCode",nullable(reason)).put("receipt",status.equals("committed")?receipt(context,saved.getString("orderId")):JSONObject.NULL);
        if(status.equals("frozen_for_manager")||status.equals("manager_resolved"))result.put("managerReview",saved.getJSONObject("managerReview"));
        return result;
    }
    private JSONObject receipt(CheckoutContext context,String id)throws Exception{
        String intentId;
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT intent_id FROM receipts WHERE id=?",new String[]{id})){if(!c.moveToFirst())throw fail("receipt_missing");intentId=c.getString(0);}
        requireIntentScope(context,intentId);
        JSONObject doc=context.engine.receiptForDisplay(id),profile=doc.getJSONObject("merchant"),merchant=new JSONObject();
        for(String name:new String[]{"legalName","branchName","address","phone","trn"})merchant.put(name,profile.get(name));
        boolean acknowledged;
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT 1 FROM acknowledgements WHERE receipt_id=?",new String[]{id})){acknowledged=c.moveToFirst();}
        JSONObject result=new JSONObject().put("schemaVersion",1).put("id",id).put("merchant",merchant).put("syncState",acknowledged?"acknowledged":"pending");
        for(String name:new String[]{"documentNumber","issuedAt","serviceType","customer","lines","totals","payments","cashTenderedFils","changeFils"})result.put(name,doc.get(name));
        return result;
    }
    private static JSONObject context(OfflineBundle b)throws Exception{
        JSONArray products=new JSONArray();for(OfflineBundle.Product p:b.products())products.put(new JSONObject().put("id",p.id).put("name",p.name).put("category",p.category).put("unit",p.unit.name()).put("unitPriceFils",p.unitPriceFils));
        return new JSONObject().put("authorityId",b.authorityId).put("actorId",b.actorId).put("branchId",b.branchId).put("deviceId",b.deviceId).put("shiftId",b.shiftId)
            .put("branchName",b.profile().get("branchName")).put("snapshotId",b.snapshotId).put("snapshotCreatedAt",b.snapshot().get("createdAt")).put("expiresAt",NativeCheckoutEngine.iso(b.expiresAtMs))
            .put("permissions",new JSONObject().put("cash",b.cashAllowed).put("recordedCard",b.recordedCardAllowed).put("mixedTender",b.mixedTenderAllowed)).put("products",products);
    }
    private void requireIntentScope(CheckoutContext context,String id)throws Exception{
        try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT x.authority_id,i.request_json FROM intents i JOIN offline_intent_context x ON x.intent_id=i.id WHERE i.id=?",new String[]{id})){
            if(!c.moveToFirst())throw fail("intent_missing");requireAuthority(context,c.getString(0));requireAuthority(context,new JSONObject(c.getString(1)).getString("authorityId"));
        }
    }
    private boolean intentExists(String id){try(Cursor c=journal.getReadableDatabase().rawQuery("SELECT 1 FROM intents WHERE id=?",new String[]{id})){return c.moveToFirst();}}
    private String firstId(String query){try(Cursor c=journal.getReadableDatabase().rawQuery(query,null)){return c.moveToFirst()?c.getString(0):null;}}
    private static void requireAuthority(CheckoutContext context,String id)throws NativeAccessError{if(!context.bundle.authorityId.equals(id))throw fail("offline_context_changed");}
    private void requireReleased()throws NativeAccessError{if(!releaseEnabled)throw fail("native_checkout_not_enabled");}
    private static Object nullable(String value){return value==null?JSONObject.NULL:value;}
    public static String code(Exception error){
        if(error instanceof NativeAccessError)return ((NativeAccessError)error).code;
        if(error instanceof OfflineClock.ClockException)return ((OfflineClock.ClockException)error).code;
        String message=error.getMessage();
        return java.util.Arrays.asList("offline_payment_recovery_uncertain","payment_resolution_invalid","payment_resolution_integrity_failed","unsupported_text","payment_frozen","freeze_integrity_failed","intent_integrity_failed","pin_unlock_required","authority_missing","authority_closed","authority_exhausted","payment_reconciliation_required","intent_missing","intent_conflict","intent_cancelled","already_issued","cancellation_conflict","buyer_details_required","presented_total_changed","tender_not_authorized","receipt_integrity_failed","invalid_tender").contains(message)?message:"native_checkout_unavailable";
    }
    private static NativeAccessError fail(String code){return new NativeAccessError(code);}
}
