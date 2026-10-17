package info.internext.pos.counter;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;

/** No cookies, credentials, redirects, external storage, or web-supplied URLs. */
class UpdateTransport {
    private final Context context;
    private volatile HttpsURLConnection connection;
    final AtomicBoolean cancelled = new AtomicBoolean();
    UpdateTransport(Context context) { this.context = context.getApplicationContext(); }

    UpdateRelease fetchRelease() throws Exception {
        HttpsURLConnection request = open(UpdateRelease.MANIFEST_URL);
        try (InputStream input = request.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            readBounded(input, bytes, UpdateRelease.MAX_MANIFEST_BYTES, 30000);
            return parseRelease(bytes.toByteArray());
        } finally { request.disconnect(); connection = null; }
    }

    static UpdateRelease parseRelease(byte[] bytes) throws Exception {
        if (bytes.length > UpdateRelease.MAX_MANIFEST_BYTES) throw new IOException("Update metadata too large");
        JSONObject json = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        return new UpdateRelease((int) integer(json, "schemaVersion"), string(json, "applicationId"),
                integer(json, "versionCode"), string(json, "version"), (int) integer(json, "minSdk"),
                string(json, "download"), string(json, "sha256"), integer(json, "apkBytes"),
                json.has("releaseNotes") ? string(json, "releaseNotes") : "");
    }

    File download(UpdateRelease release) throws Exception {
        File directory = new File(context.getCacheDir(), "updates");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Update storage unavailable");
        File partial = new File(directory, "update.part");
        File ready = new File(directory, "update.apk");
        if (ready.exists() && !ready.delete()) throw new IOException("Update storage unavailable");
        HttpsURLConnection request = open(release.download);
        try {
            long length = request.getContentLengthLong();
            if (length != -1 && length != release.apkBytes) throw new IOException("Update size did not match");
            try (InputStream input = request.getInputStream(); FileOutputStream output = new FileOutputStream(partial)) {
                long written = readBounded(input, output, release.apkBytes, 180000);
                if (written != release.apkBytes) throw new IOException("Update download was incomplete");
                output.getFD().sync();
            }
            verifyFile(partial, release);
            checkCancelled();
            if (!partial.renameTo(ready)) throw new IOException("Update storage unavailable");
            return ready;
        } finally {
            request.disconnect(); connection = null;
            if (partial.exists() && !partial.delete()) partial.deleteOnExit();
        }
    }

    void verifyFile(File file, UpdateRelease release) throws Exception {
        checkCancelled();
        if (!file.isFile() || file.length() != release.apkBytes) throw new IOException("Update size did not match");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[32768];
            int count;
            while ((count = input.read(buffer)) != -1) { checkCancelled(); digest.update(buffer, 0, count); }
        }
        if (!release.sha256.equals(hex(digest.digest()))) throw new IOException("Update checksum did not match");
        PackageManager manager = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = manager.getPackageArchiveInfo(file.getAbsolutePath(), flags);
        PackageInfo installed = manager.getPackageInfo(context.getPackageName(), flags);
        if (archive == null || archive.applicationInfo == null) throw new IOException("Invalid APK");
        release.verifyIdentity(archive.packageName, versionCode(archive), archive.versionName,
                archive.applicationInfo.minSdkVersion, Build.VERSION.SDK_INT, versionCode(installed),
                signers(installed), signers(archive));
    }

    long installedVersion() throws PackageManager.NameNotFoundException {
        return versionCode(context.getPackageManager().getPackageInfo(context.getPackageName(), 0));
    }

    void cancel() {
        cancelled.set(true);
        HttpsURLConnection active = connection;
        if (active != null) active.disconnect();
    }

    private HttpsURLConnection open(String url) throws IOException {
        checkCancelled();
        HttpsURLConnection request = (HttpsURLConnection) new URL(url).openConnection();
        connection = request;
        request.setInstanceFollowRedirects(false);
        request.setConnectTimeout(15000);
        request.setReadTimeout(15000);
        request.setUseCaches(false);
        request.setRequestProperty("Accept-Encoding", "identity");
        request.setRequestProperty("Cache-Control", "no-cache");
        try {
            if (request.getResponseCode() != 200) throw new IOException("Update server unavailable");
            checkCancelled();
            return request;
        } catch (IOException error) { request.disconnect(); connection = null; throw error; }
    }

    private long readBounded(InputStream input, java.io.OutputStream output, long maximum, long timeout) throws IOException {
        long deadline = android.os.SystemClock.elapsedRealtime() + timeout;
        long total = 0;
        byte[] buffer = new byte[32768];
        int count;
        while ((count = input.read(buffer)) != -1) {
            checkCancelled();
            total += count;
            if (total > maximum || android.os.SystemClock.elapsedRealtime() > deadline) throw new IOException("Update download limit exceeded");
            output.write(buffer, 0, count);
        }
        checkCancelled();
        return total;
    }

    private void checkCancelled() throws IOException {
        if (cancelled.get() || Thread.currentThread().isInterrupted()) throw new IOException("Update cancelled");
    }

    private static long integer(JSONObject json, String key) throws Exception {
        Object value = json.get(key);
        if (!(value instanceof Integer) && !(value instanceof Long)) throw new IOException("Invalid update metadata");
        long number = ((Number) value).longValue();
        if (number < 0 || number > Integer.MAX_VALUE) throw new IOException("Invalid update metadata");
        return number;
    }
    private static String string(JSONObject json, String key) throws Exception {
        Object value = json.get(key);
        if (!(value instanceof String)) throw new IOException("Invalid update metadata");
        return (String) value;
    }
    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }
    private static Set<String> signers(PackageInfo info) throws Exception {
        Signature[] signatures = Build.VERSION.SDK_INT >= 28
                ? (info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners()) : info.signatures;
        Set<String> result = new HashSet<>();
        if (signatures != null) for (Signature signature : signatures) {
            result.add(hex(MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())));
        }
        return result;
    }
    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte value : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }
}
