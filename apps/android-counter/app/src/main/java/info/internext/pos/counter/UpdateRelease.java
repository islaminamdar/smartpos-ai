package info.internext.pos.counter;

import java.util.Set;

/** Pure validation rules shared by the network and APK-verification boundaries. */
final class UpdateRelease {
    static final String APPLICATION_ID = "info.internext.pos.counter";
    static final String RELEASE_SIGNER = "b8ea075db91eaa417947bca77d9e53e93ded76c594282fb2feafc7f7895a08f3";
    static final String MANIFEST_URL = "https://pos.internext.info/downloads/release.json";
    static final long MAX_APK_BYTES = 100L * 1024 * 1024;
    static final int MAX_MANIFEST_BYTES = 16384;
    final long versionCode;
    final String version;
    final int minSdk;
    final String download;
    final String sha256;
    final long apkBytes;
    final String releaseNotes;

    UpdateRelease(int schemaVersion, String applicationId, long versionCode, String version,
                  int minSdk, String download, String sha256, long apkBytes, String releaseNotes) {
        if (schemaVersion != 1 || !APPLICATION_ID.equals(applicationId)
                || versionCode <= 0 || versionCode > 2100000000L
                || version == null || !version.matches("[0-9]{1,5}\\.[0-9]{1,5}\\.[0-9]{1,5}")
                || minSdk < 26 || minSdk > 100
                || !("https://pos.internext.info/downloads/internext-pos-counter-" + version + ".apk").equals(download)
                || sha256 == null || !sha256.matches("[a-f0-9]{64}")
                || apkBytes <= 0 || apkBytes > MAX_APK_BYTES
                || releaseNotes == null || releaseNotes.length() > 2000) {
            throw new IllegalArgumentException("Invalid update metadata");
        }
        this.versionCode = versionCode;
        this.version = version;
        this.minSdk = minSdk;
        this.download = download;
        this.sha256 = sha256;
        this.apkBytes = apkBytes;
        this.releaseNotes = releaseNotes;
    }

    boolean isNewerThan(long installedVersion) { return versionCode > installedVersion; }

    void verifyIdentity(String packageName, long archiveVersion, String archiveVersionName,
                        int archiveMinSdk, int deviceSdk, long installedVersion,
                        Set<String> installedSigners, Set<String> archiveSigners) {
        if (!APPLICATION_ID.equals(packageName) || archiveVersion != versionCode
                || !version.equals(archiveVersionName) || archiveMinSdk != minSdk
                || archiveMinSdk > deviceSdk || !isNewerThan(installedVersion)
                || installedSigners == null || installedSigners.size() != 1 || !installedSigners.contains(RELEASE_SIGNER)
                || archiveSigners == null || !installedSigners.equals(archiveSigners)) {
            throw new IllegalArgumentException("Update identity or signature did not match");
        }
    }
}
