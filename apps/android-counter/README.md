# Internext Counter for Android

Customer application ID: `info.internext.pos.counter`, version `1.0.0` (1), Android 8.0 or newer.

This small, signed online counter opens the live service at `https://pos.internext.info/counter`.
It shares the website's accounts, branch permissions, saved invoices, and request recovery.
It needs an internet connection to sell. It contains no local invoice issuer or offline checkout.
The separate `apps/android-pos` offline engineering candidate is unchanged and unreleased.

## First use

1. Install the customer APK from the official Internext downloads page. Open **Internext Counter**.
2. Sign in with the manager account. Enrol this physical counter device in the correct branch.
3. Open a shift with the actual cash float, check the menu prices, and save a sale only when ready.
4. A sale is confirmed only when the server returns its invoice. If the connection is interrupted,
   use the counter's pending-request recovery and check Receipts before attempting another sale.
5. In **Receipts**, select a saved invoice, then tap **Print receipt in the app's top bar**.
   Android's print service or Save as PDF handles the output. The page's browser print button
   does not launch printing inside Android WebView. Physical printers need a compatible Android
   print service and an actual hardware test; this release does not claim USB/Bluetooth ESC/POS support.
6. Sign out from the counter when handing the device to someone who should not access the account.

Offline, the app covers the counter with an internet-required message. It keeps the current page
in memory while the app stays open. Reloading or closing can discard an unsaved basket; saved sales
remain on the server. A pending saved request must be reconciled before repeating a sale.

## Build and release

Use Java 21, Android SDK 36, and the included checksum-pinned Gradle wrapper. Set `ANDROID_HOME`
to the installed SDK. Set `INTERNEXT_COUNTER_SIGNING_FILE` to a private properties file **outside
the repository** containing `storeFile`, `storePassword`, `keyAlias`, and `keyPassword`.
Release builds require this file. Never commit signing files, passwords, or APK binaries.

```sh
./gradlew --no-daemon testDebugUnitTest lintRelease assembleRelease
./gradlew --no-daemon connectedReleaseAndroidTest
```

The release artifact is `app/build/outputs/apk/release/app-release.apk`. Verify its signature
with Android SDK `apksigner verify --verbose --print-certs`, then publish its SHA-256 separately.
Retain the same private signing key for all future updates. Increment versionCode for updates.

## Security boundaries

- Fixed exact HTTPS origin; ignores incoming intent URLs; denies other navigation and all downloads.
- No native JavaScript bridge, no bundled credentials, no privileged offline sales capability.
- File/content access, mixed HTTP content, third-party cookies, popups, camera/microphone and location disabled.
- System certificate trust only, no certificate-error bypass, no WebView debugging in any build.
- First-party session cookies and IndexedDB recovery persist in app-private WebView storage.
  Cloud backup and device transfer are excluded. Clearing app data removes local request custody;
  do not clear data to recover an uncertain sale.
- Native print performs a read-only receipt check and uses Android PrintManager. It cannot confirm
  printer delivery. Reprinting does not create a sale.

Release verification must distinguish emulator checks, hosted financial acceptance, and physical
printer/device acceptance. A successful build does not prove those later steps.
