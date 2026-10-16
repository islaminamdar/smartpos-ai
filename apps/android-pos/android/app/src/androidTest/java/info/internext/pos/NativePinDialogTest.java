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
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Actual Android dialogs, cancelled before any credential, enrollment, or financial request. */
@RunWith(AndroidJUnit4.class)
public class NativePinDialogTest {
    private static final class Call extends PluginCall{
        String code;
        Call(){super(null,"NativeLedger","synthetic-pin-review","test",new JSObject());}
        @Override public void reject(String message,String code,Exception error,JSObject data){this.code=code;}
        @Override public void resolve(JSObject data){fail("Dialog test must not submit");}
    }
    private static NativeLedgerPlugin plugin(MainActivity a){return (NativeLedgerPlugin)a.getBridge().getPlugin("NativeLedger").getInstance();}
    private static AlertDialog show(MainActivity a,Call call,boolean create,String authority){
        try{
            NativeLedgerPlugin plugin=plugin(a);Method m=NativeLedgerPlugin.class.getDeclaredMethod("showPinDialog",PluginCall.class,boolean.class,boolean.class,String.class);m.setAccessible(true);m.invoke(plugin,call,create,!create,authority);
            Field f=NativeLedgerPlugin.class.getDeclaredField("credentials");f.setAccessible(true);AlertDialog dialog=(AlertDialog)f.get(plugin);assertNotNull(dialog);assertTrue(dialog.isShowing());return dialog;
        }catch(Exception e){throw new AssertionError(e);}
    }
    private static List<EditText> fields(View root){List<EditText> result=new ArrayList<>();collect(root,result);return result;}
    private static void collect(View root,List<EditText> result){if(root instanceof EditText)result.add((EditText)root);if(root instanceof ViewGroup)for(int i=0;i<((ViewGroup)root).getChildCount();i++)collect(((ViewGroup)root).getChildAt(i),result);}
    @Test public void newPinIsSecureMaskedConfirmedAndClearedOnCancel(){
        AtomicReference<Call> savedCall=new AtomicReference<>();AtomicReference<List<EditText>> savedInputs=new AtomicReference<>();AtomicReference<AlertDialog> savedDialog=new AtomicReference<>();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            scenario.onActivity(a->{Call call=new Call();savedCall.set(call);AlertDialog dialog=show(a,call,true,null);savedDialog.set(dialog);
                assertTrue((dialog.getWindow().getAttributes().flags&WindowManager.LayoutParams.FLAG_SECURE)!=0);
                List<EditText> inputs=fields(dialog.getWindow().getDecorView());savedInputs.set(inputs);assertEquals(2,inputs.size());
                for(EditText field:inputs){assertEquals(InputType.TYPE_CLASS_NUMBER|InputType.TYPE_NUMBER_VARIATION_PASSWORD,field.getInputType());assertFalse(field.isSaveEnabled());assertEquals(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS,field.getImportantForAutofill());}
            });
            // Android dispatches OnShow on the main queue. Interact after it is delivered,
            // as an actual tap would, rather than clicking in the dialog creation callback.
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(a->{List<EditText> inputs=savedInputs.get();AlertDialog dialog=savedDialog.get();
                inputs.get(0).setText("12345678");inputs.get(1).setText("87654321");dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();assertNotNull(inputs.get(1).getError());assertTrue(dialog.isShowing());assertNull(savedCall.get().code);
                dialog.getButton(AlertDialog.BUTTON_NEGATIVE).performClick();
            });
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();scenario.onActivity(a->{assertEquals("native_pin_cancelled",savedCall.get().code);for(EditText field:savedInputs.get())assertEquals(0,field.length());});
        }
    }
    @Test public void finishHasExplicitTerminalConfirmationAndCancelDoesNotSubmit(){
        AtomicReference<Call> savedCall=new AtomicReference<>();AtomicReference<List<EditText>> savedInputs=new AtomicReference<>();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            scenario.onActivity(a->{Call call=new Call();savedCall.set(call);AlertDialog dialog=show(a,call,false,"00000000-0000-4000-8000-000000000001");assertEquals("Finish allocation",dialog.getButton(AlertDialog.BUTTON_POSITIVE).getText().toString());
                List<EditText> inputs=fields(dialog.getWindow().getDecorView());savedInputs.set(inputs);assertEquals(1,inputs.size());inputs.get(0).setText("12345678");dialog.cancel();
            });
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();scenario.onActivity(a->{assertEquals("native_pin_cancelled",savedCall.get().code);assertEquals(0,savedInputs.get().get(0).length());});
        }
    }
    @Test public void backgroundCancelsAndWipesBothNativePinFields(){
        AtomicReference<Call> call=new AtomicReference<>();AtomicReference<List<EditText>> inputs=new AtomicReference<>();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            scenario.onActivity(a->{Call c=new Call();call.set(c);AlertDialog dialog=show(a,c,true,null);inputs.set(fields(dialog.getWindow().getDecorView()));for(EditText f:inputs.get())f.setText("12345678");});
            scenario.moveToState(Lifecycle.State.CREATED);InstrumentationRegistry.getInstrumentation().waitForIdleSync();assertEquals("native_pin_cancelled",call.get().code);for(EditText f:inputs.get())assertEquals(0,f.length());
        }
    }
}
