package info.internext.pos;

import android.app.AlertDialog;
import android.text.InputType;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import info.internext.pos.storage.DeviceIdentity;
import info.internext.pos.storage.NativeAccessError;
import info.internext.pos.storage.NativeJournal;
import info.internext.pos.storage.NativeSession;
import info.internext.pos.storage.NativeOfflineCoordinator;
import info.internext.pos.storage.NativeReconciliation;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Display and secure online access bridge. Offline sale issuance remains unavailable; opening a shift is explicit. */
@CapacitorPlugin(name = "NativeLedger")
public final class NativeLedgerPlugin extends Plugin {
    private NativeJournal journal;
    private NativeSession session;
    private NativeOfflineCoordinator offline;
    private NativeReconciliation reconciliation;
    private volatile boolean foreground=true;
    private AlertDialog credentials;
    private EditText passwordField;
    private volatile boolean destroyed;
    private final ExecutorService storage = Executors.newSingleThreadExecutor();
    @Override public void load() { journal = new NativeJournal(getContext()); }
    interface ReadOperation { org.json.JSONObject read() throws Exception; }
    private NativeSession session() throws Exception {
        if(session==null)session=new NativeSession(getContext(),journal);
        return session;
    }
    private NativeOfflineCoordinator offline()throws Exception{if(offline==null)offline=new NativeOfflineCoordinator(getContext(),journal,session());return offline;}
    private NativeReconciliation reconciliation()throws Exception{if(reconciliation==null)reconciliation=new NativeReconciliation(getContext(),journal,session());return reconciliation;}
    @PluginMethod public void getReconciliationState(PluginCall call){execute(call,()->reconciliation().getState(),true);}
    @PluginMethod public void reconcileOffline(PluginCall call){execute(call,()->reconciliation().reconcile(),true);}
    @PluginMethod public void finishOfflineAuthority(PluginCall call){
        String authorityId=call.getString("authorityId");
        if(authorityId==null||!authorityId.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")){call.reject("Select the prepared allocation to finish.","native_access_unavailable");return;}
        showPinDialog(call,false,false,authorityId);
    }
    private static String accessCode(Exception error){
        if(error instanceof NativeAccessError)return ((NativeAccessError)error).code;
        String code=error.getMessage();return java.util.Arrays.asList("pin_incorrect","pin_locked","pin_online_reset_required","pin_unlock_required","pin_format_invalid","pin_confirmation_mismatch","clock_source_blocked","clock_rollback","pin_kdf_unsupported").contains(code)?code:"native_access_unavailable";
    }
    private void read(PluginCall call, ReadOperation operation) {
        execute(call,operation,false);
    }
    private boolean execute(PluginCall call,ReadOperation operation,boolean access){
        if(destroyed){call.reject("The app is closing. Open it again.","native_access_unavailable");return false;}
        try{storage.execute(() -> {
            try { org.json.JSONObject value=operation.read();if(value!=null)call.resolve(new JSObject(value.toString())); }
            catch (Exception error) {
                String code=access?accessCode(error):"native_storage_unavailable";
                call.reject(access?"Secure access could not be completed. Check the app's recovery message.":"This device's saved records could not be read. Keep the app installed and contact support.",code);
            }
        });return true;}catch(java.util.concurrent.RejectedExecutionException error){call.reject("The app is closing. Open it again.","native_access_unavailable");return false;}
    }
    @PluginMethod public void getIdentity(PluginCall call) { read(call, () -> new DeviceIdentity().readOrCreate(journal)); }
    @PluginMethod public void getStatus(PluginCall call) { read(call, () -> journal.status()); }
    @PluginMethod public void listReceipts(PluginCall call) { read(call, () -> journal.listReceipts()); }
    @PluginMethod public void getAccessState(PluginCall call){execute(call,()->session().getAccessState(),true);}
    @PluginMethod public void signOut(PluginCall call){execute(call,()->{if(offline!=null)offline.lock();return session().signOut();},true);}
    @PluginMethod public void enrollCounter(PluginCall call){
        String branch=call.getString("branchId"),name=call.getString("name");
        execute(call,()->session().enrollCounter(branch,name),true);
    }
    @PluginMethod public void getOfflineState(PluginCall call){execute(call,()->offline().getState(),true);}
    @PluginMethod public void openOfflineShift(PluginCall call){
        Object value=call.getData().opt("openingCashFils");
        if(!(value instanceof Integer)&&!(value instanceof Long)){call.reject("Enter an exact opening cash amount.","native_access_unavailable");return;}
        execute(call,()->offline().openShift(((Number)value).longValue()),true);
    }
    @PluginMethod public void prepareOffline(PluginCall call){
        execute(call,()->{org.json.JSONObject state=offline().beginPreparation();String stage=state.getString("stage");
            if(!(stage.equals("prepare")||stage.equals("unlock")||(stage.equals("recover")&&"prepare".equals(state.optString("pendingAction")))))return state;
            showPinDialog(call,!state.getBoolean("pinProvisioned"),false);return null;},true);
    }
    @PluginMethod public void unlockOffline(PluginCall call){showPinDialog(call,false,true);}
    @PluginMethod public void lockOffline(PluginCall call){execute(call,()->{offline().lock();return offline().getState();},true);}
    private void showPinDialog(PluginCall call,boolean create,boolean unlockOnly){showPinDialog(call,create,unlockOnly,null);}
    private void showPinDialog(PluginCall call,boolean create,boolean unlockOnly,String finishAuthorityId){
        getActivity().runOnUiThread(()->{
            if(destroyed||!foreground||getActivity().isFinishing()||credentials!=null){call.reject("PIN entry is unavailable right now.","native_pin_cancelled");return;}
            LinearLayout layout=new LinearLayout(getActivity());layout.setOrientation(LinearLayout.VERTICAL);int padding=(int)(24*getContext().getResources().getDisplayMetrics().density);layout.setPadding(padding,8,padding,8);
            EditText pin=pinField(create?"Choose an 8–12 digit PIN":"Enter your PIN"),confirm=create?pinField("Confirm your PIN"):null;layout.addView(pin);if(confirm!=null)layout.addView(confirm);passwordField=pin;
            AlertDialog dialog=new AlertDialog.Builder(getActivity()).setTitle(finishAuthorityId!=null?"Finish offline allocation":create?"Set this counter PIN":"Unlock this counter").setMessage(finishAuthorityId!=null?"This permanently stops use of this saved allocation. Your records are kept. This does not close the cash shift.":create?"Use a PIN for this staff account on this device. It is separate from your account password.":"Your PIN is checked on this device.").setView(layout).setNegativeButton("Cancel",(d,w)->call.reject("PIN entry cancelled.","native_pin_cancelled")).setPositiveButton(finishAuthorityId!=null?"Finish allocation":create?"Set PIN":"Unlock",null).create();
            credentials=dialog;dialog.setOnCancelListener(d->call.reject("PIN entry cancelled.","native_pin_cancelled"));dialog.setOnDismissListener(d->{pin.getText().clear();if(confirm!=null)confirm.getText().clear();if(credentials==dialog){credentials=null;passwordField=null;}});
            dialog.setOnShowListener(d->dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{
                if(pin.length()<8||pin.length()>12){pin.setError("Use 8–12 digits");return;}
                char[] secret=new char[pin.length()],repeat=confirm==null?null:new char[confirm.length()];android.text.TextUtils.getChars(pin.getText(),0,pin.length(),secret,0);if(confirm!=null)android.text.TextUtils.getChars(confirm.getText(),0,confirm.length(),repeat,0);
                if(create&&!Arrays.equals(secret,repeat)){Arrays.fill(secret,'\0');Arrays.fill(repeat,'\0');confirm.setError("PINs must match");return;}
                dialog.dismiss();if(!execute(call,()->{try{if(!foreground)throw new NativeAccessError("native_pin_cancelled");org.json.JSONObject result;
                    if(finishAuthorityId!=null){offline().finishAuthorityWithPin(finishAuthorityId,secret);result=foreground?reconciliation().reconcile():reconciliation().getState();}
                    else result=unlockOnly?offline().unlockWithPin(secret):offline().prepareWithPin(secret,repeat);if(!foreground){offline().lock();return finishAuthorityId!=null?reconciliation().getState():offline().getState();}return result;}finally{Arrays.fill(secret,'\0');if(repeat!=null)Arrays.fill(repeat,'\0');}},true)){Arrays.fill(secret,'\0');if(repeat!=null)Arrays.fill(repeat,'\0');}
            }));if(dialog.getWindow()!=null)dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);dialog.show();
        });
    }
    private EditText pinField(String label){EditText field=new EditText(getActivity());field.setHint(label);field.setContentDescription(label);field.setInputType(InputType.TYPE_CLASS_NUMBER|InputType.TYPE_NUMBER_VARIATION_PASSWORD);field.setSingleLine(true);field.setSaveEnabled(false);field.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(12)});if(android.os.Build.VERSION.SDK_INT>=26)field.setImportantForAutofill(android.view.View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);return field;}
    @PluginMethod public void signIn(PluginCall call){
        // Credentials never enter the WebView or PluginCall JSON. Android owns these fields.
        getActivity().runOnUiThread(()->{
            if(destroyed||getActivity().isFinishing()||credentials!=null){call.reject("Sign-in is unavailable right now.","native_access_unavailable");return;}
            LinearLayout layout=new LinearLayout(getActivity());layout.setOrientation(LinearLayout.VERTICAL);
            int padding=(int)(24*getContext().getResources().getDisplayMetrics().density);layout.setPadding(padding,8,padding,8);
            EditText email=new EditText(getActivity());email.setHint("Staff email");email.setContentDescription("Staff email");email.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);email.setSingleLine(true);email.setSaveEnabled(false);email.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(254)});
            EditText password=new EditText(getActivity());passwordField=password;password.setHint("Password");password.setContentDescription("Password");password.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);password.setSingleLine(true);password.setSaveEnabled(false);password.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(256)});
            if(android.os.Build.VERSION.SDK_INT>=26){email.setImportantForAutofill(android.view.View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);password.setImportantForAutofill(android.view.View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);}
            layout.addView(email);layout.addView(password);
            AlertDialog dialog=new AlertDialog.Builder(getActivity()).setTitle("Secure staff sign-in").setMessage("Sign in to pos.internext.info. Your password stays outside the counter web screen.").setView(layout).setNegativeButton("Cancel",(d,w)->call.reject("Sign-in cancelled.","native_sign_in_cancelled")).setPositiveButton("Sign in",null).create();
            credentials=dialog;dialog.setOnCancelListener(d->call.reject("Sign-in cancelled.","native_sign_in_cancelled"));
            dialog.setOnDismissListener(d->{password.getText().clear();email.getText().clear();if(credentials==dialog){credentials=null;passwordField=null;}});
            dialog.setOnShowListener(d->dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{
                if(email.getText().toString().trim().isEmpty()||password.length()==0){if(email.length()==0)email.setError("Enter your staff email");if(password.length()==0)password.setError("Enter your password");return;}
                String address=email.getText().toString().trim();char[] secret=new char[password.length()];android.text.TextUtils.getChars(password.getText(),0,password.length(),secret,0);password.getText().clear();dialog.dismiss();
                if(!execute(call,()->{try{return session().signIn(address,secret);}finally{Arrays.fill(secret,'\0');}},true))Arrays.fill(secret,'\0');
            }));
            if(dialog.getWindow()!=null)dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            dialog.show();
        });
    }
    @Override protected void handleOnPause(){foreground=false;if(credentials!=null)credentials.cancel();try{storage.execute(()->{if(offline!=null)offline.lock();});}catch(java.util.concurrent.RejectedExecutionException ignored){}super.handleOnPause();}
    @Override protected void handleOnResume(){foreground=true;super.handleOnResume();}
    @Override protected void handleOnDestroy() {
        destroyed=true;
        if(passwordField!=null)passwordField.getText().clear();
        if(credentials!=null)credentials.dismiss();
        storage.execute(() -> {if(offline!=null)offline.close();journal.close();}); storage.shutdown(); super.handleOnDestroy();
    }
}
