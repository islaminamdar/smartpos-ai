package info.internext.pos.counter;

import org.junit.Test;
import java.util.Set;
import static org.junit.Assert.*;

public final class UpdateReleaseTest {
    private static final String HASH = "a".repeat(64);
    private static final String URL = "https://pos.internext.info/downloads/internext-pos-counter-1.1.0.apk";
    private UpdateRelease release(String url, String hash, long size) {
        return new UpdateRelease(1, UpdateRelease.APPLICATION_ID, 2, "1.1.0", 26, url, hash, size, "Fixes");
    }
    @Test public void trustedReleaseRequiresNewerVersion() {
        UpdateRelease release = release(URL, HASH, 1000);
        assertTrue(release.isNewerThan(1));
        assertFalse(release.isNewerThan(2));
        assertFalse(release.isNewerThan(3));
    }
    @Test public void rejectsEveryAlternativeDownloadLocation() {
        for (String url : new String[] {
                URL.replace("https:", "http:"), URL.replace("pos.internext.info", "evil.example"),
                URL.replace("pos.internext.info", "pos.internext.info.evil.example"),
                URL.replace("pos.internext.info", "user@pos.internext.info"),
                URL.replace("pos.internext.info", "pos.internext.info:443"), URL + "?x=1", URL + "#x",
                URL.replace("/downloads/", "/downloads/../downloads/"),
                URL.replace("/downloads/", "/%64ownloads/"), URL.replace("1.1.0", "2.0.0")
        }) assertThrows(url, IllegalArgumentException.class, () -> release(url, HASH, 1000));
    }
    @Test public void rejectsInvalidBoundsAndHash() {
        for (long size : new long[] {-1, 0, UpdateRelease.MAX_APK_BYTES + 1})
            assertThrows(IllegalArgumentException.class, () -> release(URL, HASH, size));
        for (String hash : new String[] {"", "a".repeat(63), "a".repeat(65), "Z".repeat(64), "A".repeat(64)})
            assertThrows(IllegalArgumentException.class, () -> release(URL, hash, 1000));
        assertThrows(IllegalArgumentException.class, () -> new UpdateRelease(2, UpdateRelease.APPLICATION_ID, 2, "1.1.0", 26, URL, HASH, 1000, ""));
        assertThrows(IllegalArgumentException.class, () -> new UpdateRelease(1, "other", 2, "1.1.0", 26, URL, HASH, 1000, ""));
        assertThrows(IllegalArgumentException.class, () -> new UpdateRelease(1, UpdateRelease.APPLICATION_ID, 0, "1.1.0", 26, URL, HASH, 1000, ""));
        assertThrows(IllegalArgumentException.class, () -> new UpdateRelease(1, UpdateRelease.APPLICATION_ID, 2, "1.1.0", 25, URL, HASH, 1000, ""));
        assertThrows(IllegalArgumentException.class, () -> new UpdateRelease(1, UpdateRelease.APPLICATION_ID, 2, "1.1.0", 26, URL, HASH, 1000, "x".repeat(2001)));
    }
    private void verify(String packageName, long versionCode, String version, int minSdk, int deviceSdk,
                        long installedVersion, Set<String> installed, Set<String> archive) {
        release(URL, HASH, 1000).verifyIdentity(packageName, versionCode, version, minSdk, deviceSdk, installedVersion, installed, archive);
    }
    @Test public void verifiesExactPackageVersionAndPinnedInstalledSigner() {
        Set<String> signer = Set.of(UpdateRelease.RELEASE_SIGNER);
        verify(UpdateRelease.APPLICATION_ID, 2, "1.1.0", 26, 36, 1, signer, signer);
        assertThrows(IllegalArgumentException.class, () -> verify("other", 2, "1.1.0", 26, 36, 1, signer, signer));
        assertThrows(IllegalArgumentException.class, () -> verify(UpdateRelease.APPLICATION_ID, 3, "1.1.0", 26, 36, 1, signer, signer));
        assertThrows(IllegalArgumentException.class, () -> verify(UpdateRelease.APPLICATION_ID, 2, "1.2.0", 26, 36, 1, signer, signer));
        assertThrows(IllegalArgumentException.class, () -> verify(UpdateRelease.APPLICATION_ID, 2, "1.1.0", 27, 36, 1, signer, signer));
        assertThrows(IllegalArgumentException.class, () -> verify(UpdateRelease.APPLICATION_ID, 2, "1.1.0", 26, 25, 1, signer, signer));
        assertThrows(IllegalArgumentException.class, () -> verify(UpdateRelease.APPLICATION_ID, 2, "1.1.0", 26, 36, 2, signer, signer));
        assertThrows(IllegalArgumentException.class, () -> verify(UpdateRelease.APPLICATION_ID, 2, "1.1.0", 26, 36, 1, signer, Set.of("wrong")));
        assertThrows(IllegalArgumentException.class, () -> verify(UpdateRelease.APPLICATION_ID, 2, "1.1.0", 26, 36, 1, Set.of("wrong"), Set.of("wrong")));
        assertThrows(IllegalArgumentException.class, () -> verify(UpdateRelease.APPLICATION_ID, 2, "1.1.0", 26, 36, 1, Set.of(), Set.of()));
    }
}
