package info.internext.pos.counter;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class CounterReleaseTest {
    private WebView web(CounterActivity activity) {
        try {
            Field field = CounterActivity.class.getDeclaredField("web");
            field.setAccessible(true);
            return (WebView) field.get(activity);
        } catch (ReflectiveOperationException error) { throw new AssertionError(error); }
    }

    @Test public void releaseHasNoDebugOrLocalFileAccess() {
        try (ActivityScenario<CounterActivity> scenario = ActivityScenario.launch(CounterActivity.class)) {
            scenario.onActivity(activity -> {
                assertEquals(0, activity.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE);
                WebView view = web(activity);
                WebSettings settings = view.getSettings();
                assertFalse(settings.getAllowFileAccess());
                assertFalse(settings.getAllowContentAccess());
                assertFalse(settings.getAllowFileAccessFromFileURLs());
                assertFalse(settings.getAllowUniversalAccessFromFileURLs());
                assertFalse(settings.getJavaScriptCanOpenWindowsAutomatically());
                assertFalse(settings.supportMultipleWindows());
                assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, settings.getMixedContentMode());
                assertEquals(WebSettings.LOAD_NO_CACHE, settings.getCacheMode());
                assertFalse(CookieManager.getInstance().acceptThirdPartyCookies(view));
                assertTrue(settings.getSafeBrowsingEnabled());
            });
        }
    }

    @Test public void launcherIgnoresUntrustedIntentUrls() {
        Intent intent = new Intent(InstrumentationRegistry.getInstrumentation().getTargetContext(), CounterActivity.class);
        intent.setData(Uri.parse("https://attacker.example/"));
        intent.putExtra("url", "javascript:alert(1)");
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try (ActivityScenario<CounterActivity> scenario = ActivityScenario.launch(intent)) {
            scenario.onActivity(activity -> assertEquals(CounterOrigin.HOME, web(activity).getUrl()));
        }
    }

    @Test public void noPrivilegedJavascriptBridgeIsExposed() throws Exception {
        CountDownLatch finished = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        try (ActivityScenario<CounterActivity> scenario = ActivityScenario.launch(CounterActivity.class)) {
            scenario.onActivity(activity -> web(activity).evaluateJavascript(
                    "JSON.stringify([typeof Android,typeof Capacitor,typeof PosNative,typeof nativeInterface])",
                    value -> { result.set(value); finished.countDown(); }));
            assertTrue("WebView evaluation completes", finished.await(15, TimeUnit.SECONDS));
            assertEquals("\"[\\\"undefined\\\",\\\"undefined\\\",\\\"undefined\\\",\\\"undefined\\\"]\"", result.get());
        }
    }

    @Test public void firstPartyCookieSurvivesActivityRecreation() throws Exception {
        CountDownLatch saved = new CountDownLatch(1);
        try (ActivityScenario<CounterActivity> scenario = ActivityScenario.launch(CounterActivity.class)) {
            scenario.onActivity(activity -> CookieManager.getInstance().setCookie(CounterOrigin.HOME,
                    "counter_release_probe=1; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=60", success -> {
                        CookieManager.getInstance().flush(); saved.countDown();
                    }));
            assertTrue(saved.await(10, TimeUnit.SECONDS));
            scenario.recreate();
            scenario.onActivity(activity -> {
                assertTrue(CookieManager.getInstance().getCookie(CounterOrigin.HOME).contains("counter_release_probe=1"));
                CookieManager.getInstance().setCookie(CounterOrigin.HOME,
                        "counter_release_probe=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0", null);
                CookieManager.getInstance().flush();
            });
        }
    }
}
