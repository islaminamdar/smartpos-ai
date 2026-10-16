package info.internext.pos.storage;

import android.os.Looper;
import android.os.SystemClock;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import info.internext.pos.MainActivity;
import info.internext.pos.NativeLedgerPlugin;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.WebViewListener;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Real foreground Activity, main Handler and bridge listeners. Short leases are a
 * native-only test seam; production unlock always arms the fixed five-minute lease.
 * These tests do not provision real credentials or write financial/session records. */
@RunWith(AndroidJUnit4.class)
public class NativeSessionExpiryAndroidTest {
    private static final class Call extends PluginCall {
        final CountDownLatch done=new CountDownLatch(1);volatile JSObject result;volatile String code;volatile boolean onMain;
        volatile boolean armed=true;volatile int beforeArm,delivered;volatile long deliveredAt;
        Call(JSObject args){super(null,"NativeLedger","synthetic-expiry","test",args);}
        @Override public void resolve(JSObject value){if(!armed){beforeArm++;return;}delivered++;deliveredAt=SystemClock.elapsedRealtime();result=value;onMain=Looper.myLooper()==Looper.getMainLooper();done.countDown();}
        @Override public void reject(String message,String code,Exception error,JSObject data){this.code=code;done.countDown();}
    }
    private static void invoke(NativeLedgerPlugin plugin,String method){
        try{Method m=NativeLedgerPlugin.class.getDeclaredMethod(method);m.setAccessible(true);m.invoke(plugin);}catch(Exception e){throw new AssertionError(e);}
    }
    private static NativeSessionExpiry lease(NativeLedgerPlugin plugin){
        NativeSessionExpiry expiry=new NativeSessionExpiry(NativeStaffUnlock.mainScheduler(),SystemClock::elapsedRealtime);
        expiry.callbacks(()->invoke(plugin,"invalidateCheckoutAccess"),()->invoke(plugin,"publishCheckoutLocked"));return expiry;
    }
    private static void awaitAppDocument(ActivityScenario<MainActivity> scenario)throws Exception{
        CountDownLatch loaded=new CountDownLatch(1);
        scenario.onActivity(activity->{
            // Capacitor resets its listener map on initial page navigation. Register
            // test listeners after that navigation, never against the initial blank page.
            activity.getBridge().addWebViewListener(new WebViewListener(){
                @Override public void onPageLoaded(android.webkit.WebView view){if(appDocument(view))loaded.countDown();}
            });
            android.webkit.WebView view=activity.getBridge().getWebView();
            if(appDocument(view)&&view.getProgress()==100)view.evaluateJavascript("document.readyState",value->{if("\"complete\"".equals(value))loaded.countDown();});
        });
        assertTrue("Local app document did not finish its initial navigation",loaded.await(30,TimeUnit.SECONDS));
    }
    private static boolean appDocument(android.webkit.WebView view){String url=view.getUrl();return url!=null&&url.startsWith("https://localhost/");}
    @Test public void foregroundDeadlineEmitsExistingLockEventWithoutAnotherCheckoutRead()throws Exception{
        Call event=new Call(new JSObject().put("eventName","nativeCheckoutLocked"));event.armed=false;AtomicReference<NativeSessionExpiry> saved=new AtomicReference<>();long[] deadline={0};
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            awaitAppDocument(scenario);
            scenario.onActivity(activity->{NativeLedgerPlugin plugin=(NativeLedgerPlugin)activity.getBridge().getPlugin("NativeLedger").getInstance();
                plugin.addListener(event);NativeSessionExpiry expiry=lease(plugin);saved.set(expiry);long now=SystemClock.elapsedRealtime();deadline[0]=now+75;event.armed=true;expiry.arm(now,75);
            });
            boolean arrived=event.done.await(10,TimeUnit.SECONDS);
            assertTrue("No post-arm lock event; expired="+saved.get().expired()+", priorEvents="+event.beforeArm,arrived);
            assertTrue("Expiry event must run on the main looper",event.onMain);
            assertTrue("Pre-deadline event is not expiry evidence",event.deliveredAt>=deadline[0]);
            assertEquals(1,event.delivered);assertEquals(1,event.result.length());assertEquals(1,event.result.getInt("schemaVersion"));
            assertFalse("Notification must revoke the lease",saved.get().active());
        }finally{if(saved.get()!=null)saved.get().close();}
    }
    @Test public void expiryInvalidationSuppressesAnInFlightForegroundDetailResult()throws Exception{
        CountDownLatch started=new CountDownLatch(1),release=new CountDownLatch(1);
        Call details=new Call(new JSObject()),event=new Call(new JSObject().put("eventName","nativeCheckoutLocked"));
        AtomicReference<NativeSessionExpiry> saved=new AtomicReference<>();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            awaitAppDocument(scenario);event.armed=false;
            scenario.onActivity(activity->{try{
                NativeLedgerPlugin plugin=(NativeLedgerPlugin)activity.getBridge().getPlugin("NativeLedger").getInstance();plugin.addListener(event);
                Class<?> operation=Class.forName("info.internext.pos.NativeLedgerPlugin$ReadOperation");
                Object read=Proxy.newProxyInstance(operation.getClassLoader(),new Class<?>[]{operation},(proxy,method,args)->{
                    started.countDown();if(!release.await(10,TimeUnit.SECONDS))throw new AssertionError("Synthetic read not released");
                    return new JSONObject().put("buyer","Synthetic private buyer").put("countedCashFils",12345);
                });
                Method checkout=NativeLedgerPlugin.class.getDeclaredMethod("checkoutCall",PluginCall.class,operation,String[].class);checkout.setAccessible(true);checkout.invoke(plugin,details,read,new String[0]);
                saved.set(lease(plugin));
            }catch(Exception e){throw new AssertionError(e);}});
            assertTrue(started.await(10,TimeUnit.SECONDS));event.armed=true;saved.get().arm(SystemClock.elapsedRealtime(),75);
            assertTrue(event.done.await(10,TimeUnit.SECONDS));release.countDown();assertTrue(details.done.await(10,TimeUnit.SECONDS));
            assertEquals("pin_unlock_required",details.code);assertNull(details.result);assertTrue(event.onMain);
        }finally{release.countDown();if(saved.get()!=null)saved.get().close();}
    }
}
