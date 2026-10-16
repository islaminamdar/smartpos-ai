package info.internext.pos;

import android.os.Looper;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.WebViewListener;
import java.lang.reflect.Method;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Actual foreground bridge notification, with synthetic read-only private data. */
@RunWith(AndroidJUnit4.class)
public class NativeClockRecoveryLifecycleTest {
    private static final class Call extends PluginCall {
        final CountDownLatch done=new CountDownLatch(1);volatile boolean armed=true,onMain;volatile JSObject result;volatile String code;
        Call(JSObject input){super(null,"NativeLedger","synthetic-clock-lock","test",input);}
        @Override public void resolve(JSObject data){if(!armed)return;result=data;onMain=Looper.myLooper()==Looper.getMainLooper();done.countDown();}
        @Override public void reject(String message,String code,Exception error,JSObject data){this.code=code;done.countDown();}
    }
    @Test public void clockRecoveryLockPublishesAndSuppressesInflightPrivateDetail()throws Exception{
        CountDownLatch loaded=new CountDownLatch(1),started=new CountDownLatch(1),release=new CountDownLatch(1);AtomicReference<NativeLedgerPlugin> saved=new AtomicReference<>();Call event=new Call(new JSObject().put("eventName","nativeCheckoutLocked")),details=new Call(new JSObject());event.armed=false;
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            scenario.onActivity(a->{a.getBridge().addWebViewListener(new WebViewListener(){@Override public void onPageLoaded(android.webkit.WebView view){if(view.getUrl()!=null&&view.getUrl().startsWith("https://localhost/"))loaded.countDown();}});android.webkit.WebView v=a.getBridge().getWebView();if(v.getUrl()!=null&&v.getUrl().startsWith("https://localhost/")&&v.getProgress()==100)v.evaluateJavascript("document.readyState",state->{if("\"complete\"".equals(state))loaded.countDown();});});
            assertTrue(loaded.await(30,TimeUnit.SECONDS));scenario.onActivity(a->{try{
                NativeLedgerPlugin plugin=(NativeLedgerPlugin)a.getBridge().getPlugin("NativeLedger").getInstance();saved.set(plugin);plugin.addListener(event);
                Method method=NativeLedgerPlugin.class.getDeclaredMethod("checkoutCall",PluginCall.class,NativeLedgerPlugin.ReadOperation.class,String[].class);method.setAccessible(true);
                NativeLedgerPlugin.ReadOperation operation=()->{started.countDown();if(!release.await(10,TimeUnit.SECONDS))throw new AssertionError("Synthetic read stalled");return new JSONObject().put("buyer","Synthetic private buyer").put("expectedCashFils",12345);};method.invoke(plugin,details,operation,new String[0]);
            }catch(Exception e){throw new AssertionError(e);}});
            assertTrue(started.await(10,TimeUnit.SECONDS));event.armed=true;
            // Invoke from the instrumentation worker, proving listener delivery switches to main.
            Method lock=NativeLedgerPlugin.class.getDeclaredMethod("lockClockRecoveryDetails");lock.setAccessible(true);lock.invoke(saved.get());
            assertTrue(event.done.await(10,TimeUnit.SECONDS));assertTrue(event.onMain);assertEquals(1,event.result.length());release.countDown();assertTrue(details.done.await(10,TimeUnit.SECONDS));assertNull(details.result);assertEquals("pin_unlock_required",details.code);
        }finally{release.countDown();}
    }
}
