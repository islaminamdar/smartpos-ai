package info.internext.pos.counter;

import android.content.Context;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

/** Two explicit phases on the owned emulator, separated by a real signed APK upgrade.
 * No account, invoice, or production API writes. Skipped in the normal test suite. */
@RunWith(AndroidJUnit4.class)
public class CounterUpgradeStorageTest {
    private static final String KEY = "internext_upgrade_acceptance_probe";
    private static final String VALUE = "retained-from-signed-version-1";

    private WebView web(CounterActivity activity) {
        try {
            Field field = CounterActivity.class.getDeclaredField("web");
            field.setAccessible(true);
            return (WebView) field.get(activity);
        } catch (ReflectiveOperationException error) { throw new AssertionError(error); }
    }

    private String evaluate(ActivityScenario<CounterActivity> scenario, String script) throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch latch = new CountDownLatch(1);
        scenario.onActivity(activity -> web(activity).evaluateJavascript(script, value -> {
            result.set(value); latch.countDown();
        }));
        assertTrue("JavaScript callback", latch.await(10, TimeUnit.SECONDS));
        return result.get();
    }

    private void waitFor(ActivityScenario<CounterActivity> scenario, String script, String expected) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        do {
            if (expected.equals(evaluate(scenario, script))) return;
            Thread.sleep(200);
        } while (System.nanoTime() < deadline);
        assertEquals(expected, evaluate(scenario, script));
    }

    @Test public void preserveCookieLocalStorageAndIndexedDbAcrossSignedUpgrade() throws Exception {
        Bundle arguments = InstrumentationRegistry.getArguments();
        String phase = arguments.getString("upgradeProbePhase", "");
        Assume.assumeTrue("Explicit two-phase emulator acceptance only", phase.equals("seed") || phase.equals("verify"));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        int installed = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionCode;
        assertEquals(phase.equals("seed") ? 1 : 2, installed);
        try (ActivityScenario<CounterActivity> scenario = ActivityScenario.launch(CounterActivity.class)) {
            waitFor(scenario, "location.origin === 'https://pos.internext.info' && document.readyState === 'complete'", "true");
            if (phase.equals("seed")) {
                context.getSharedPreferences(KEY, 0).edit().putString("value", VALUE).commit();
                CountDownLatch cookie = new CountDownLatch(1);
                scenario.onActivity(activity -> CookieManager.getInstance().setCookie(CounterOrigin.HOME,
                        KEY + "=" + VALUE + "; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400", success -> {
                            CookieManager.getInstance().flush(); cookie.countDown();
                        }));
                assertTrue(cookie.await(10, TimeUnit.SECONDS));
                evaluate(scenario, "localStorage.setItem('" + KEY + "','" + VALUE + "');"
                        + "window.__upgradeProbe='waiting';var r=indexedDB.open('" + KEY + "',1);"
                        + "r.onupgradeneeded=()=>r.result.createObjectStore('proof');"
                        + "r.onerror=()=>window.__upgradeProbe='error';"
                        + "r.onsuccess=()=>{var d=r.result,t=d.transaction('proof','readwrite');"
                        + "t.objectStore('proof').put('" + VALUE + "','value');"
                        + "t.oncomplete=()=>{d.close();window.__upgradeProbe='saved'};"
                        + "t.onerror=()=>window.__upgradeProbe='error'};");
                waitFor(scenario, "window.__upgradeProbe", "\"saved\"");
            } else {
                assertEquals(VALUE, context.getSharedPreferences(KEY, 0).getString("value", null));
                assertEquals("\"" + VALUE + "\"", evaluate(scenario, "localStorage.getItem('" + KEY + "')"));
                scenario.onActivity(activity -> assertTrue(CookieManager.getInstance().getCookie(CounterOrigin.HOME).contains(KEY + "=" + VALUE)));
                evaluate(scenario, "window.__upgradeProbe='waiting';var r=indexedDB.open('" + KEY + "',1);"
                        + "r.onerror=()=>window.__upgradeProbe='error';r.onsuccess=()=>{var d=r.result;"
                        + "var q=d.transaction('proof').objectStore('proof').get('value');"
                        + "q.onsuccess=()=>{window.__upgradeProbe=q.result;d.close()};"
                        + "q.onerror=()=>window.__upgradeProbe='error'};");
                waitFor(scenario, "window.__upgradeProbe", "\"" + VALUE + "\"");
                // Remove only our synthetic probe after verification, never operational storage.
                evaluate(scenario, "localStorage.removeItem('" + KEY + "');indexedDB.deleteDatabase('" + KEY + "');");
                context.getSharedPreferences(KEY, 0).edit().clear().commit();
                scenario.onActivity(activity -> {
                    CookieManager.getInstance().setCookie(CounterOrigin.HOME, KEY + "=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0", null);
                    CookieManager.getInstance().flush();
                });
            }
        }
    }
}
