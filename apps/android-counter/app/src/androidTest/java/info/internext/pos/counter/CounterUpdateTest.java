package info.internext.pos.counter;

import android.widget.Button;
import android.widget.TextView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class CounterUpdateTest {
    private JSONObject metadata() throws Exception {
        return new JSONObject().put("schemaVersion", 1).put("applicationId", UpdateRelease.APPLICATION_ID)
                .put("versionCode", 3).put("version", "1.2.0").put("minSdk", 26)
                .put("download", "https://pos.internext.info/downloads/internext-pos-counter-1.2.0.apk")
                .put("sha256", new String(new char[64]).replace('\0', 'a')).put("apkBytes", 1000);
    }
    private UpdateRelease parse(JSONObject json) throws Exception {
        return UpdateTransport.parseRelease(json.toString().getBytes(StandardCharsets.UTF_8));
    }
    @Test public void metadataRejectsCoercionsAndOversize() throws Exception {
        assertEquals(3, parse(metadata()).versionCode);
        for (String key : new String[] {"schemaVersion", "versionCode", "minSdk", "apkBytes"}) {
            for (Object value : new Object[] {"3", 3.5, true, JSONObject.NULL, -1, 2147483648L}) {
                JSONObject invalid = metadata().put(key, value);
                assertThrows(key + ":" + value, Exception.class, () -> parse(invalid));
            }
        }
        for (String key : new String[] {"applicationId", "version", "download", "sha256", "releaseNotes"}) {
            assertThrows(Exception.class, () -> parse(metadata().put(key, 123)));
            assertThrows(Exception.class, () -> parse(metadata().put(key, JSONObject.NULL)));
        }
        assertThrows(Exception.class, () -> UpdateTransport.parseRelease(new byte[UpdateRelease.MAX_MANIFEST_BYTES + 1]));
        assertThrows(Exception.class, () -> UpdateTransport.parseRelease("not json".getBytes(StandardCharsets.UTF_8)));
    }

    @Test public void automaticCheckOnlyShowsBannerAndUnsafeStateBlocksUpdate() throws Exception {
        AtomicReference<CounterUpdater> updater = new AtomicReference<>();
        AtomicReference<TextView> status = new AtomicReference<>();
        AtomicReference<Button> action = new AtomicReference<>();
        AtomicInteger safetyChecks = new AtomicInteger();
        AtomicInteger downloads = new AtomicInteger();
        UpdateRelease release = parse(metadata());
        try (ActivityScenario<CounterActivity> scenario = ActivityScenario.launch(CounterActivity.class)) {
            scenario.onActivity(activity -> {
                activity.getSharedPreferences("counter-updates", 0).edit().clear().commit();
                TextView label = new TextView(activity);
                Button button = new Button(activity);
                status.set(label); action.set(button);
                CounterUpdater testUpdater = new CounterUpdater(activity, label, button,
                        whenReady -> safetyChecks.incrementAndGet(),
                        () -> new UpdateTransport(activity) {
                            @Override UpdateRelease fetchRelease() { return release; }
                            @Override long installedVersion() { return 2; }
                            @Override java.io.File download(UpdateRelease ignored) {
                                downloads.incrementAndGet();
                                throw new AssertionError("Unsafe updates must never download");
                            }
                        });
                updater.set(testUpdater);
                testUpdater.resume();
            });
            waitUntil(() -> status.get().getText().toString().contains("available"));
            assertEquals("Automatic discovery must not ask to interrupt a sale", 0, safetyChecks.get());
            scenario.onActivity(activity -> action.get().performClick());
            assertEquals(1, safetyChecks.get());
            assertEquals(0, downloads.get());
            scenario.onActivity(activity -> updater.get().destroy());
        }
    }

    private interface Check { boolean ready(); }
    private void waitUntil(Check check) throws Exception {
        for (int attempt = 0; attempt < 100; attempt++) {
            AtomicReference<Boolean> ready = new AtomicReference<>(false);
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> ready.set(check.ready()));
            if (ready.get()) return;
            Thread.sleep(50);
        }
        fail("Timed out waiting for updater UI");
    }
}
