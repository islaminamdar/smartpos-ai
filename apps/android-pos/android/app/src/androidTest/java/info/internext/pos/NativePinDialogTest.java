package info.internext.pos;

import android.app.AlertDialog;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.TextView;
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
        volatile String code;
        int rejected;
        Call(){this(new JSObject());}
        Call(JSObject data){super(null,"NativeLedger","synthetic-pin-review","test",data);}
        @Override public void reject(String message,String code,Exception error,JSObject data){this.code=code;rejected++;}
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
    private static AlertDialog currentDialog(NativeLedgerPlugin plugin){
        try{Field field=NativeLedgerPlugin.class.getDeclaredField("credentials");field.setAccessible(true);return (AlertDialog)field.get(plugin);}
        catch(Exception error){throw new AssertionError(error);}
    }
    private static boolean containsText(View root,String text){
        if(root instanceof TextView&&text.contentEquals(((TextView)root).getText()))return true;
        if(root instanceof ViewGroup)for(int n=0;n<((ViewGroup)root).getChildCount();n++)if(containsText(((ViewGroup)root).getChildAt(n),text))return true;
        return false;
    }
    private static void invokeNew(NativeLedgerPlugin plugin,Call call,boolean historical){
        if(historical)plugin.unlockHistoricalPayment(call);else plugin.continueAfterAllocation(call);
    }
    private static void assertSingleSecurePin(AlertDialog dialog,boolean historical){
        assertNotNull(dialog);assertTrue(dialog.isShowing());assertTrue((dialog.getWindow().getAttributes().flags&WindowManager.LayoutParams.FLAG_SECURE)!=0);
        View root=dialog.getWindow().getDecorView();
        assertTrue(containsText(root,historical?"Unlock original payment":"Continue counter setup"));
        assertTrue(containsText(root,historical?"Your PIN unlocks this payment under its original staff and shift scope.":"The previous allocation and all its records are kept. This does not close a cash shift or issue a new allocation."));
        assertEquals(historical?"Unlock":"Continue setup",dialog.getButton(AlertDialog.BUTTON_POSITIVE).getText().toString());
        List<EditText> inputs=fields(root);assertEquals(1,inputs.size());EditText input=inputs.get(0);
        assertEquals(InputType.TYPE_CLASS_NUMBER|InputType.TYPE_NUMBER_VARIATION_PASSWORD,input.getInputType());assertFalse(input.isSaveEnabled());
        assertEquals(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS,input.getImportantForAutofill());assertEquals("Enter your PIN",input.getHint().toString());
    }
    private static void newDialogCancelledWithoutSubmission(boolean historical,boolean background){
        AtomicReference<Call> call=new AtomicReference<>();AtomicReference<AlertDialog> dialog=new AtomicReference<>();AtomicReference<EditText> input=new AtomicReference<>();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            scenario.onActivity(a->{Call c=new Call(new JSObject().put(historical?"intentId":"previousAuthorityId","00000000-0000-4000-8000-000000000001"));call.set(c);invokeNew(plugin(a),c,historical);AlertDialog d=currentDialog(plugin(a));dialog.set(d);assertSingleSecurePin(d,historical);input.set(fields(d.getWindow().getDecorView()).get(0));input.get().setText("12345678");assertNull(c.code);});
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            if(background)scenario.moveToState(Lifecycle.State.CREATED);
            else scenario.onActivity(a->dialog.get().getButton(AlertDialog.BUTTON_NEGATIVE).performClick());
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            assertEquals("native_pin_cancelled",call.get().code);assertEquals(1,call.get().rejected);assertEquals(0,input.get().length());assertFalse(dialog.get().isShowing());
            if(background)scenario.moveToState(Lifecycle.State.RESUMED);
            scenario.onActivity(a->assertNull(currentDialog(plugin(a))));
        }
    }
    @Test public void continueSetupDialogUsesOneSecurePinAndCancelNeverSubmits(){newDialogCancelledWithoutSubmission(false,false);}
    @Test public void originalPaymentDialogUsesOneSecurePinAndCancelNeverSubmits(){newDialogCancelledWithoutSubmission(true,false);}
    @Test public void backgroundWipesContinuationPinWithoutSubmitting(){newDialogCancelledWithoutSubmission(false,true);}
    @Test public void backgroundWipesOriginalPaymentPinWithoutSubmitting(){newDialogCancelledWithoutSubmission(true,true);}
    @Test public void newBridgesRejectExtraOrMalformedIdentitiesBeforeShowingDialog(){
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            scenario.onActivity(a->{NativeLedgerPlugin p=plugin(a);
                for(boolean historical:new boolean[]{false,true}){
                    String name=historical?"intentId":"previousAuthorityId";
                    List<JSObject> invalid=new ArrayList<>();invalid.add(new JSObject());invalid.add(new JSObject().put(name,"not-a-uuid"));invalid.add(new JSObject().put(name,123));invalid.add(new JSObject().put(name,org.json.JSONObject.NULL));invalid.add(new JSObject().put(name,"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"));invalid.add(new JSObject().put(name,"00000000-0000-4000-8000-000000000001").put("pin","12345678"));invalid.add(new JSObject().put(name,"00000000-0000-4000-8000-000000000001").put("extra",true));
                    for(JSObject data:invalid){Call call=new Call(data);invokeNew(p,call,historical);assertEquals("offline_context_changed",call.code);assertEquals(1,call.rejected);assertNull(currentDialog(p));}
                }
            });
        }
    }

}
