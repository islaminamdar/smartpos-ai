package info.internext.pos.counter;

import android.app.AlertDialog;
import android.app.Instrumentation;
import android.content.Context;
import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Button;
import android.widget.TextView;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.lang.reflect.Field;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

/** Opt-in emulator probe. Future APK assets are private androidTest assets, never production assets. */
@RunWith(AndroidJUnit4.class)
public final class CounterUpdateInstallTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();

    @Test public void fixtureUpdateReachesAndroidInstaller() throws Exception {
        Assume.assumeTrue("Private, supervised emulator probe only",
                "true".equals(InstrumentationRegistry.getArguments().getString("updateInstallProbe")));
        Context testContext = instrumentation.getContext();
        Context appContext = instrumentation.getTargetContext();
        UpdateRelease release;
        try (InputStream input = testContext.getAssets().open("update-fixture.json");
             ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) {
                bytes.write(buffer, 0, count);
                assertTrue(bytes.size() <= UpdateRelease.MAX_MANIFEST_BYTES);
            }
            release = UpdateTransport.parseRelease(bytes.toByteArray());
        }
        long initialVersion = new UpdateTransport(appContext).installedVersion();
        boolean cancelInstaller = "cancel".equals(
                InstrumentationRegistry.getArguments().getString("updateInstallAction"));
        assertTrue("Fixture must upgrade the installed release", release.isNewerThan(initialVersion));
        AtomicReference<CounterUpdater> updater = new AtomicReference<>();
        AtomicReference<Button> action = new AtomicReference<>();
        AtomicReference<TextView> status = new AtomicReference<>();
        try (ActivityScenario<CounterActivity> scenario = ActivityScenario.launch(CounterActivity.class)) {
            scenario.onActivity(activity -> {
                CounterUpdater original = field(activity, "updater");
                original.destroy();
                Button button = field(original, "action");
                TextView label = field(original, "status");
                action.set(button);
                status.set(label);
                activity.getSharedPreferences("counter-updates", 0).edit().clear().commit();
                // POS readiness is verified in the web/native safety tests. This isolated test
                // exercises native install UI and real APK verification without customer access.
                CounterUpdater fixtureUpdater = new CounterUpdater(activity, label, button, Runnable::run,
                        () -> new UpdateTransport(activity) {
                            @Override UpdateRelease fetchRelease() { return release; }
                            @Override File download(UpdateRelease requested) throws Exception {
                                assertSame(release, requested);
                                File directory = new File(activity.getCacheDir(), "updates");
                                assertTrue(directory.isDirectory() || directory.mkdirs());
                                File apk = new File(directory, "update.apk");
                                try (InputStream input = testContext.getAssets().open("update-fixture.apk");
                                     FileOutputStream output = new FileOutputStream(apk)) {
                                    byte[] buffer = new byte[32768];
                                    int count;
                                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                                    output.getFD().sync();
                                }
                                try (RandomAccessFile probe = new RandomAccessFile(apk, "rw")) {
                                    long position = probe.length() / 2;
                                    probe.seek(position);
                                    int original = probe.readUnsignedByte();
                                    probe.seek(position);
                                    probe.write(original ^ 1);
                                    probe.getFD().sync();
                                    try {
                                        IOException rejected = assertThrows("A one-byte APK modification must fail verification",
                                                IOException.class, () -> verifyFile(apk, requested));
                                        assertEquals("Update checksum did not match", rejected.getMessage());
                                        phase("checksum-rejected", "The real verifier rejected a one-byte modification of the signed APK.");
                                    } finally {
                                        probe.seek(position);
                                        probe.write(original);
                                        probe.getFD().sync();
                                    }
                                }
                                verifyFile(apk, requested); // Real checksum, size, package, version and signer checks.
                                return apk;
                            }
                        });
                setField(activity, "updater", fixtureUpdater);
                updater.set(fixtureUpdater);
                fixtureUpdater.resume();
            });
            waitMain(() -> status.get().getText().toString().contains("available"), 15000);
            assertNull("Discovery must not interrupt the counter", field(updater.get(), "updatePrompt"));
            scenario.onActivity(activity -> action.get().performClick());
            waitMain(() -> prompt(updater.get()) != null && prompt(updater.get()).isShowing(), 10000);
            scenario.onActivity(activity -> prompt(updater.get()).getButton(AlertDialog.BUTTON_NEGATIVE).performClick());
            waitMain(() -> prompt(updater.get()) == null || !prompt(updater.get()).isShowing(), 10000);
            assertNull("Later must not download", field(updater.get(), "ready"));
            scenario.onActivity(activity -> action.get().performClick());
            waitMain(() -> prompt(updater.get()) != null && prompt(updater.get()).isShowing(), 10000);
            scenario.onActivity(activity -> prompt(updater.get()).getButton(AlertDialog.BUTTON_POSITIVE).performClick());
            waitMain(() -> status.get().getText().toString().contains("ready to install")
                    && prompt(updater.get()) != null && prompt(updater.get()).isShowing(), 30000);
            phase("verified-fixture", "Later preserved the app; the real verifier accepted the private signed update.");
            scenario.onActivity(activity -> prompt(updater.get()).getButton(AlertDialog.BUTTON_POSITIVE).performClick());

            if (!appContext.getPackageManager().canRequestPackageInstalls()) {
                // A supervisor clicks the real platform UI. Button capitalisation and OEM
                // accessibility labels vary; they are not part of the updater contract.
                phase("permission-dialog", "Tap Open settings, enable Allow from this source in Android settings, then press Back within 90 seconds. Use a screenshot; this test owns UiAutomation.");
                waitUntil(() -> appContext.getPackageManager().canRequestPackageInstalls()
                        && scenario.getState() == Lifecycle.State.RESUMED, 90000);
                scenario.onActivity(activity -> action.get().performClick());
                waitMain(() -> prompt(updater.get()) != null && prompt(updater.get()).isShowing(), 10000);
                scenario.onActivity(activity -> prompt(updater.get()).getButton(AlertDialog.BUTTON_POSITIVE).performClick());
            }
            waitUntil(() -> {
                AccessibilityNodeInfo root = instrumentation.getUiAutomation().getRootInActiveWindow();
                if (root == null || root.getPackageName() == null) return false;
                String owner = root.getPackageName().toString();
                return owner.contains("packageinstaller") || owner.contains("permissioncontroller");
            }, 15000);
            phase("installer-open", cancelInstaller
                    ? "Tap Cancel in the Android installer within 90 seconds. The test will verify the old version remains installed and the update stays available."
                    : "Android owns the confirmation. Tap Update now; package replacement may end this instrumentation process. Verify installed version and preserved data externally.");
            if (cancelInstaller) {
                waitUntil(() -> scenario.getState() == Lifecycle.State.RESUMED, 90000);
                assertEquals("Cancelling Android installation must retain the installed version",
                        initialVersion, new UpdateTransport(appContext).installedVersion());
                waitMain(() -> "Install update".contentEquals(action.get().getText()), 10000);
                assertNotNull("Verified update remains available after cancellation", field(updater.get(), "ready"));
                phase("installer-cancelled", "Android installation cancelled; original version and ready-to-install update remain available.");
                return;
            }
            // Keep the provider/process alive while the supervisor inspects and confirms Android UI.
            // Successful self-replacement normally terminates the instrumented target process.
            waitUntil(() -> new UpdateTransport(appContext).installedVersion() >= release.versionCode, 180000);
        }
    }

    private void phase(String name, String instruction) {
        Bundle result = new Bundle();
        result.putString("updateProbePhase", name);
        result.putString("stream", "\nUPDATE_PROBE " + name + ": " + instruction + "\n");
        instrumentation.sendStatus(0, result);
    }
    private interface Check { boolean ready() throws Exception; }
    private void waitUntil(Check check, long milliseconds) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + milliseconds;
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            if (check.ready()) return;
            Thread.sleep(100);
        }
        fail("Timed out waiting for the supervised updater step");
    }
    private void waitMain(Check check, long milliseconds) throws Exception {
        waitUntil(() -> {
            AtomicReference<Boolean> result = new AtomicReference<>(false);
            AtomicReference<Exception> error = new AtomicReference<>();
            instrumentation.runOnMainSync(() -> {
                try { result.set(check.ready()); } catch (Exception exception) { error.set(exception); }
            });
            if (error.get() != null) throw error.get();
            return result.get();
        }, milliseconds);
    }
    private AlertDialog prompt(CounterUpdater updater) { return field(updater, "updatePrompt"); }
    @SuppressWarnings("unchecked") private <T> T field(Object instance, String name) {
        try {
            Field field = instance.getClass().getDeclaredField(name);
            field.setAccessible(true);
            return (T) field.get(instance);
        } catch (ReflectiveOperationException exception) { throw new AssertionError(exception); }
    }
    private void setField(Object instance, String name, Object value) {
        try {
            Field field = instance.getClass().getDeclaredField(name);
            field.setAccessible(true);
            field.set(instance, value);
        } catch (ReflectiveOperationException exception) { throw new AssertionError(exception); }
    }
}
