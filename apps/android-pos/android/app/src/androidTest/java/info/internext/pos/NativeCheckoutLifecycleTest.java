package info.internext.pos;

import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.lang.reflect.Method;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Actual activity lifecycle and plugin worker, with synthetic read-only data.
 * No staff credentials, session mutations, payment intent, or financial record is created. */
@RunWith(AndroidJUnit4.class)
public class NativeCheckoutLifecycleTest {
    private static final String SYNTHETIC_CUSTOMER = "Synthetic Customer - lifecycle test only";
    private static final class Call extends PluginCall {
        final CountDownLatch completed = new CountDownLatch(1);
        final AtomicInteger callbacks = new AtomicInteger();
        volatile String code, message;
        volatile JSObject resolved, rejectedData;
        Call() { super(null, "NativeLedger", "synthetic-checkout-lifecycle", "test", new JSObject()); }
        @Override public void reject(String message, String code, Exception error, JSObject data) {
            this.message=message; this.code=code; rejectedData=data; callbacks.incrementAndGet(); completed.countDown();
        }
        @Override public void resolve(JSObject data) {
            resolved=data; callbacks.incrementAndGet(); completed.countDown();
        }
    }
    private static NativeLedgerPlugin plugin(MainActivity activity) {
        return (NativeLedgerPlugin)activity.getBridge().getPlugin("NativeLedger").getInstance();
    }
    private static void checkout(NativeLedgerPlugin plugin, Call call, NativeLedgerPlugin.ReadOperation operation) {
        try {
            Method method=NativeLedgerPlugin.class.getDeclaredMethod("checkoutCall",PluginCall.class,NativeLedgerPlugin.ReadOperation.class,String[].class);
            method.setAccessible(true); method.invoke(plugin,call,operation,new String[0]);
        } catch (Exception error) { throw new AssertionError(error); }
    }
    private static JSONObject syntheticReceipt() throws Exception {
        return new JSONObject().put("customer",SYNTHETIC_CUSTOMER).put("address","Synthetic address").put("totalFils",12345);
    }
    private static void await(CountDownLatch latch, String message) throws InterruptedException {
        assertTrue(message,latch.await(10,TimeUnit.SECONDS));
    }
    private static void assertLocked(Call call) throws InterruptedException {
        await(call.completed,"Checkout did not complete");
        assertEquals("pin_unlock_required",call.code); assertNull(call.resolved); assertNull(call.rejectedData);
        assertNotNull(call.message); assertFalse(call.message.contains(SYNTHETIC_CUSTOMER)); assertEquals(1,call.callbacks.get());
    }
    @Test public void pauseAndResumeSuppressesAnAlreadyRunningCheckoutResult() throws Exception {
        CountDownLatch started=new CountDownLatch(1),release=new CountDownLatch(1),returned=new CountDownLatch(1);
        Call call=new Call();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            try {
                scenario.onActivity(activity->checkout(plugin(activity),call,()->{
                    started.countDown();
                    if(!release.await(10,TimeUnit.SECONDS))throw new IllegalStateException("Synthetic read was not released");
                    JSONObject result=syntheticReceipt(); returned.countDown(); return result;
                }));
                await(started,"Synthetic checkout never started");
                // Keep the worker blocked until BOTH transitions complete: foreground=true
                // alone must not authorize returning the previous activity epoch's result.
                scenario.moveToState(Lifecycle.State.CREATED);
                scenario.moveToState(Lifecycle.State.RESUMED);
                InstrumentationRegistry.getInstrumentation().waitForIdleSync();
                release.countDown(); await(returned,"Synthetic read did not return its result"); assertLocked(call);
            } finally { release.countDown(); }
        }
    }
    @Test public void backgroundRejectsCheckoutBeforeInvokingTheReadOperation() throws Exception {
        Call call=new Call(); AtomicBoolean invoked=new AtomicBoolean(); AtomicReference<NativeLedgerPlugin> saved=new AtomicReference<>();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity->saved.set(plugin(activity)));
            scenario.moveToState(Lifecycle.State.CREATED);
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            InstrumentationRegistry.getInstrumentation().runOnMainSync(()->checkout(saved.get(),call,()->{
                invoked.set(true); return syntheticReceipt();
            }));
            assertLocked(call); assertFalse("A background checkout must not invoke the operation",invoked.get());
        }
    }
    @Test public void uninterruptedForegroundReadReturnsItsSyntheticResult() throws Exception {
        Call call=new Call();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity->checkout(plugin(activity),call,NativeCheckoutLifecycleTest::syntheticReceipt));
            await(call.completed,"Foreground checkout did not complete");
            assertNull(call.code); assertNotNull(call.resolved); assertEquals(SYNTHETIC_CUSTOMER,call.resolved.getString("customer"));
            assertEquals(12345,call.resolved.getInt("totalFils")); assertEquals(1,call.callbacks.get());
        }
    }
}
