package info.internext.pos.counter;

import android.app.AlertDialog;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;
import androidx.core.content.FileProvider;
import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Foreground, user-directed updates. Merely discovering a release never opens a dialog. */
final class CounterUpdater {
    interface SafetyCheck { void check(Runnable whenReady); }
    private final CounterActivity activity;
    private final TextView status;
    private final Button action;
    private final SafetyCheck safety;
    private final java.util.function.Supplier<UpdateTransport> transportFactory;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final SharedPreferences preferences;
    private UpdateTransport transport;
    private UpdateRelease available;
    private File ready;
    private AlertDialog downloading;
    private AlertDialog updatePrompt;
    private boolean busy;
    private boolean destroyed;
    private boolean foreground;
    private long operation;
    private String installedLabel = "Internext Counter";
    private final android.os.Handler timer = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable periodicCheck = new Runnable() {
        @Override public void run() {
            if (foreground && !destroyed) {
                check(false);
                timer.postDelayed(this, 6 * 60 * 60 * 1000L);
            }
        }
    };

    CounterUpdater(CounterActivity activity, TextView status, Button action, SafetyCheck safety) {
        this(activity, status, action, safety, () -> new UpdateTransport(activity));
    }

    // Package-private dependency seam for instrumentation. No endpoint can be supplied by intents or web content.
    CounterUpdater(CounterActivity activity, TextView status, Button action, SafetyCheck safety,
                   java.util.function.Supplier<UpdateTransport> transportFactory) {
        this.activity = activity;
        this.transportFactory = transportFactory;
        this.status = status;
        this.action = action;
        this.safety = safety;
        preferences = activity.getSharedPreferences("counter-updates", 0);
        try { installedLabel = "App " + activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName; }
        catch (android.content.pm.PackageManager.NameNotFoundException ignored) { /* Own package is always present. */ }
        action.setOnClickListener(view -> {
            if (available == null) check(true);
            else confirmUpdate();
        });
        idle();
    }

    void resume() {
        foreground = true;
        if (!busy && available == null) check(false);
        timer.removeCallbacks(periodicCheck);
        long sinceCheck = Math.max(0, System.currentTimeMillis() - preferences.getLong("lastCheck", 0));
        timer.postDelayed(periodicCheck, Math.max(1000, 6 * 60 * 60 * 1000L - sinceCheck));
    }

    void pause() { foreground = false; timer.removeCallbacks(periodicCheck); }

    void destroy() {
        destroyed = true;
        timer.removeCallbacks(periodicCheck);
        operation++;
        if (transport != null) transport.cancel();
        if (downloading != null) downloading.dismiss();
        if (updatePrompt != null) updatePrompt.dismiss();
        worker.shutdownNow();
    }

    private void check(boolean manual) {
        if (busy || destroyed) return;
        long now = System.currentTimeMillis();
        long previous = preferences.getLong("lastCheck", 0);
        if (!manual && now >= previous && now - previous < 6 * 60 * 60 * 1000L) return;
        preferences.edit().putLong("lastCheck", now).apply();
        busy = true;
        long token = ++operation;
        action.setEnabled(false);
        status.setText("Checking for updates…");
        UpdateTransport task = transportFactory.get();
        transport = task;
        worker.execute(() -> {
            try {
                UpdateRelease release = task.fetchRelease();
                boolean newer = release.isNewerThan(task.installedVersion());
                post(token, () -> {
                    busy = false;
                    if (newer && release.minSdk <= Build.VERSION.SDK_INT) {
                        if (available == null || available.versionCode != release.versionCode) ready = null;
                        available = release;
                        idle();
                        if (manual && foreground) confirmUpdate();
                    } else {
                        available = null;
                        ready = null;
                        idle();
                        status.setText(newer ? "This update needs a newer Android version" : installedLabel + " · up to date");
                    }
                });
            } catch (Exception error) {
                post(token, () -> {
                    busy = false;
                    idle();
                    status.setText(manual ? "Could not check. Tap Check updates to retry." : "Update check unavailable · retry anytime");
                });
            }
        });
    }

    private void confirmUpdate() {
        if (busy || available == null || !foreground || (updatePrompt != null && updatePrompt.isShowing())) return;
        safety.check(() -> {
            if (!foreground || destroyed || busy) return;
            String message = "Finish and save the current bill. Resolve any interrupted sale in Receipts, finish printing, close the shift, and return to Sell before updating. The app will close during installation. Saved bills and login data are kept.\n\nAndroid will ask you to confirm installation.";
            if (!available.releaseNotes.isEmpty()) message += "\n\n" + available.releaseNotes;
            updatePrompt = new AlertDialog.Builder(activity).setTitle("Update to " + available.version + "?")
                    .setMessage(message).setNegativeButton("Later", null)
                    .setPositiveButton(ready == null ? "Update now" : "Install update", (dialog, which) ->
                            safety.check(() -> { if (ready == null) download(); else install(); }))
                    .create();
            updatePrompt.setOnDismissListener(dialog -> updatePrompt = null);
            updatePrompt.show();
        });
    }

    private void download() {
        if (busy || available == null || !foreground) return;
        busy = true;
        long token = ++operation;
        action.setEnabled(false);
        status.setText("Downloading update…");
        UpdateTransport task = transportFactory.get();
        transport = task;
        downloading = new AlertDialog.Builder(activity).setTitle("Downloading update")
                .setMessage("Keep this screen open. You can cancel and continue using the counter.")
                .setNegativeButton("Cancel", (dialog, which) -> cancelDownload())
                .setCancelable(false).create();
        downloading.show();
        UpdateRelease release = available;
        worker.execute(() -> {
            try {
                File apk = task.download(release);
                post(token, () -> {
                    busy = false;
                    dismissDownload();
                    ready = apk;
                    idle();
                    // A new explicit tap is required if the user left the app during download.
                    if (foreground) confirmUpdate();
                });
            } catch (Exception error) {
                post(token, () -> {
                    busy = false;
                    dismissDownload();
                    ready = null;
                    idle();
                    if (foreground) new AlertDialog.Builder(activity).setTitle("Update was not installed")
                            .setMessage("The download or security check did not finish. Check the connection and try Update now again. You can continue using this version.")
                            .setPositiveButton("OK", null).show();
                });
            }
        });
    }

    private void cancelDownload() {
        operation++;
        if (transport != null) transport.cancel();
        busy = false;
        ready = null;
        dismissDownload();
        idle();
    }

    private void install() {
        if (!foreground || busy || ready == null || available == null) return;
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(activity).setTitle("Allow Internext updates")
                    .setMessage("In Android settings, allow this app to install updates. Return here and tap Install update. You will still confirm each installation.")
                    .setNegativeButton("Later", null)
                    .setPositiveButton("Open settings", (dialog, which) -> {
                        try {
                            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:" + activity.getPackageName())));
                        } catch (RuntimeException error) { showInstallError(); }
                    }).show();
            return;
        }
        busy = true;
        action.setEnabled(false);
        status.setText("Verifying update…");
        long token = ++operation;
        UpdateTransport task = transportFactory.get();
        transport = task;
        File apk = ready;
        UpdateRelease release = available;
        worker.execute(() -> {
            try {
                task.verifyFile(apk, release);
                post(token, () -> {
                    busy = false;
                    idle();
                    if (!foreground) return;
                    safety.check(() -> {
                        if (!foreground || destroyed) return;
                        try {
                            Uri uri = FileProvider.getUriForFile(activity,
                                    activity.getPackageName() + ".updates", apk);
                            Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE);
                            intent.setDataAndType(uri, "application/vnd.android.package-archive");
                            intent.setClipData(ClipData.newRawUri("Internext update", uri));
                            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            intent.putExtra(Intent.EXTRA_RETURN_RESULT, true);
                            // Android always owns the installation confirmation. No background install.
                            activity.startActivity(intent);
                        } catch (RuntimeException error) { showInstallError(); }
                    });
                });
            } catch (Exception error) {
                post(token, () -> {
                    busy = false;
                    ready = null;
                    idle();
                    if (foreground) showInstallError();
                });
            }
        });
    }

    private void showInstallError() {
        new AlertDialog.Builder(activity).setTitle("Update was not installed")
                .setMessage("Android could not open this update. Your current app is unchanged. Try again or ask your manager to check the device installation settings.")
                .setPositiveButton("OK", null).show();
    }
    private void idle() {
        action.setEnabled(true);
        action.setVisibility(View.VISIBLE);
        action.setText(available == null ? "Check updates" : ready == null ? "Update now" : "Install update");
        status.setText(available == null ? installedLabel : "Version " + available.version + (ready == null ? " available" : " ready to install"));
    }
    private void dismissDownload() {
        if (downloading != null) { downloading.dismiss(); downloading = null; }
    }
    private void post(long token, Runnable action) {
        activity.runOnUiThread(() -> {
            if (!destroyed && token == operation && !activity.isFinishing() && !activity.isDestroyed()) action.run();
        });
    }
}
