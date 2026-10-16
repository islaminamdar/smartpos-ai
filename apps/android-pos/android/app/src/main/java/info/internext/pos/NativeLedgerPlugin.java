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
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Display and secure online access bridge. Financial write methods remain unavailable. */
@CapacitorPlugin(name = "NativeLedger")
public final class NativeLedgerPlugin extends Plugin {
    private NativeJournal journal;
    private NativeSession session;
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
    private void read(PluginCall call, ReadOperation operation) {
        execute(call,operation,false);
    }
    private boolean execute(PluginCall call,ReadOperation operation,boolean access){
        if(destroyed){call.reject("The app is closing. Open it again.","native_access_unavailable");return false;}
        try{storage.execute(() -> {
            try { call.resolve(new JSObject(operation.read().toString())); }
            catch (Exception error) {
                String code=access?(error instanceof NativeAccessError?((NativeAccessError)error).code:"native_access_unavailable"):"native_storage_unavailable";
                call.reject(access?"Secure access could not be completed. Check the app's recovery message.":"This device's saved records could not be read. Keep the app installed and contact support.",code);
            }
        });return true;}catch(java.util.concurrent.RejectedExecutionException error){call.reject("The app is closing. Open it again.","native_access_unavailable");return false;}
    }
    @PluginMethod public void getIdentity(PluginCall call) { read(call, () -> new DeviceIdentity().readOrCreate(journal)); }
    @PluginMethod public void getStatus(PluginCall call) { read(call, () -> journal.status()); }
    @PluginMethod public void listReceipts(PluginCall call) { read(call, () -> journal.listReceipts()); }
    @PluginMethod public void getAccessState(PluginCall call){execute(call,()->session().getAccessState(),true);}
    @PluginMethod public void signOut(PluginCall call){execute(call,()->session().signOut(),true);}
    @PluginMethod public void enrollCounter(PluginCall call){
        String branch=call.getString("branchId"),name=call.getString("name");
        execute(call,()->session().enrollCounter(branch,name),true);
    }
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
    @Override protected void handleOnDestroy() {
        destroyed=true;
        if(passwordField!=null)passwordField.getText().clear();
        if(credentials!=null)credentials.dismiss();
        storage.execute(() -> journal.close()); storage.shutdown(); super.handleOnDestroy();
    }
}
