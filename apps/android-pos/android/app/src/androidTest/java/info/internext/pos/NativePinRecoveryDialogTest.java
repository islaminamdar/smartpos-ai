package info.internext.pos;

import android.app.AlertDialog;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.EditText;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Real Android dialogs; every fixture cancels or fails local validation before networking. */
@RunWith(AndroidJUnit4.class)
public class NativePinRecoveryDialogTest {
    private static final String ID="00000000-0000-4000-8000-000000000001";
    private static final class Call extends PluginCall {
        volatile String code;int rejected;
        Call(){this(new JSObject());}Call(JSObject data){super(null,"NativeLedger","synthetic-recovery-dialog","test",data);}
        @Override public void reject(String message,String code,Exception error,JSObject data){this.code=code;rejected++;}
        @Override public void resolve(JSObject data){fail("Cancelled dialog must never submit or resolve");}
    }
    private static NativeLedgerPlugin plugin(MainActivity a){return (NativeLedgerPlugin)a.getBridge().getPlugin("NativeLedger").getInstance();}
    private static AtomicLong epoch(NativeLedgerPlugin p)throws Exception{Field f=NativeLedgerPlugin.class.getDeclaredField("checkoutEpoch");f.setAccessible(true);return (AtomicLong)f.get(p);}
    private static AlertDialog current(NativeLedgerPlugin p){try{Field f=NativeLedgerPlugin.class.getDeclaredField("credentials");f.setAccessible(true);return (AlertDialog)f.get(p);}catch(Exception e){throw new AssertionError(e);}}
    private static AlertDialog show(MainActivity a,Call call,String id,boolean passwordOnly,boolean stale){
        try{NativeLedgerPlugin p=plugin(a);long value=epoch(p).get();if(stale)epoch(p).incrementAndGet();Method m=NativeLedgerPlugin.class.getDeclaredMethod("showPinRecoveryDialog",PluginCall.class,String.class,boolean.class,String.class,long.class);m.setAccessible(true);m.invoke(p,call,id,passwordOnly,null,value);return current(p);}catch(Exception e){throw new AssertionError(e);}
    }
    private static List<EditText> fields(View root){List<EditText> out=new ArrayList<>();collect(root,out);return out;}
    private static void collect(View view,List<EditText> out){if(view instanceof EditText)out.add((EditText)view);if(view instanceof ViewGroup)for(int i=0;i<((ViewGroup)view).getChildCount();i++)collect(((ViewGroup)view).getChildAt(i),out);}
    private static void secure(AlertDialog d){assertNotNull(d);assertTrue(d.isShowing());assertTrue((d.getWindow().getAttributes().flags&WindowManager.LayoutParams.FLAG_SECURE)!=0);for(EditText f:fields(d.getWindow().getDecorView())){assertFalse(f.isSaveEnabled());assertEquals(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS,f.getImportantForAutofill());}}
    private static void cancelled(String id,boolean passwordOnly,boolean background){
        AtomicReference<Call> call=new AtomicReference<>();AtomicReference<AlertDialog> dialog=new AtomicReference<>();AtomicReference<List<EditText>> inputs=new AtomicReference<>();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            scenario.onActivity(a->{Call c=new Call();call.set(c);AlertDialog d=show(a,c,id,passwordOnly,false);dialog.set(d);secure(d);List<EditText> fs=fields(d.getWindow().getDecorView());inputs.set(fs);assertEquals(id==null?3:passwordOnly?1:0,fs.size());
                if(!fs.isEmpty()){assertEquals(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD,fs.get(0).getInputType());assertEquals("Current account password",fs.get(0).getHint().toString());fs.get(0).setText("synthetic-password");}
                for(int i=1;i<fs.size();i++){assertEquals(InputType.TYPE_CLASS_NUMBER|InputType.TYPE_NUMBER_VARIATION_PASSWORD,fs.get(i).getInputType());fs.get(i).setText("12345678");}
                assertEquals(id==null?"Recover PIN":passwordOnly?"Authorize saved recovery":"Check and finish recovery",d.getButton(AlertDialog.BUTTON_POSITIVE).getText().toString());
            });InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            if(background)scenario.moveToState(Lifecycle.State.CREATED);else scenario.onActivity(a->dialog.get().getButton(AlertDialog.BUTTON_NEGATIVE).performClick());
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();assertEquals("native_pin_cancelled",call.get().code);assertEquals(1,call.get().rejected);assertFalse(dialog.get().isShowing());for(EditText f:inputs.get())assertEquals(0,f.length());
            if(background)scenario.moveToState(Lifecycle.State.RESUMED);scenario.onActivity(a->assertNull(current(plugin(a))));
        }
    }
    @Test public void startUsesNativePasswordAndTwoMaskedPinsAndCancelWipesAll(){cancelled(null,false,false);}
    @Test public void firstRetryIsExplicitConfirmationWithoutAnyPasswordOrPin(){cancelled(ID,false,false);}
    @Test public void unacceptedRetryPasswordDialogCannotChangeSavedPin(){cancelled(ID,true,false);}
    @Test public void backgroundWipesAllThreeRecoveryFields(){cancelled(null,false,true);}
    @Test public void backgroundWipesRetryPassword(){cancelled(ID,true,true);}
    @Test public void missingPasswordAndMismatchingPinNeverSubmit(){
        AtomicReference<Call> call=new AtomicReference<>();AtomicReference<AlertDialog> dialog=new AtomicReference<>();AtomicReference<List<EditText>> inputs=new AtomicReference<>();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            scenario.onActivity(a->{Call c=new Call();call.set(c);AlertDialog d=show(a,c,null,false,false);dialog.set(d);inputs.set(fields(d.getWindow().getDecorView()));});InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(a->{List<EditText> fs=inputs.get();fs.get(1).setText("12345678");fs.get(2).setText("12345678");dialog.get().getButton(AlertDialog.BUTTON_POSITIVE).performClick();assertNotNull(fs.get(0).getError());assertNull(call.get().code);assertTrue(dialog.get().isShowing());fs.get(0).setText("synthetic-password");fs.get(2).setText("87654321");dialog.get().getButton(AlertDialog.BUTTON_POSITIVE).performClick();assertNotNull(fs.get(2).getError());assertNull(call.get().code);assertTrue(dialog.get().isShowing());dialog.get().cancel();});InstrumentationRegistry.getInstrumentation().waitForIdleSync();assertEquals("native_pin_cancelled",call.get().code);for(EditText f:inputs.get())assertEquals(0,f.length());
        }
    }
    @Test public void staleLifecycleConsentCannotCreateRecoveryDialog(){
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){scenario.onActivity(a->{Call c=new Call();assertNull(show(a,c,null,false,true));assertEquals("native_pin_cancelled",c.code);assertEquals(1,c.rejected);});}
    }
    @Test public void bridgeRejectsJavascriptSecretsExtraKeysAndMalformedRequestIds(){
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){scenario.onActivity(a->{NativeLedgerPlugin p=plugin(a);
            for(JSObject data:new JSObject[]{new JSObject().put("password","synthetic"),new JSObject().put("pin","12345678"),new JSObject().put("extra",true)})for(boolean start:new boolean[]{true,false}){Call c=new Call(data);if(start)p.startPinRecovery(c);else p.getPinRecoveryState(c);assertEquals("pin_recovery_invalid",c.code);assertEquals(1,c.rejected);assertNull(current(p));}
            for(JSObject data:new JSObject[]{new JSObject(),new JSObject().put("requestId",123),new JSObject().put("requestId",org.json.JSONObject.NULL),new JSObject().put("requestId","not-a-uuid"),new JSObject().put("requestId",ID).put("password","synthetic"),new JSObject().put("requestId",ID).put("pin","12345678")}){Call c=new Call(data);p.retryPinRecovery(c);assertEquals("pin_recovery_invalid",c.code);assertEquals(1,c.rejected);assertNull(current(p));}
        });}
    }
}
