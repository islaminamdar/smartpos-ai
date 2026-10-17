# Internext Counter for Android

Customer application ID: `info.internext.pos.counter`, version `1.1.0` (2), Android 8.0 or newer.

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

## App updates without the Play Store

Version 1.1.0 checks the fixed Internext release endpoint when the app is in the foreground,
at most once every six hours automatically. Staff can also tap **Check updates**. An available
release appears in the app's update control; it does not interrupt a sale with an automatic
installation. Tap the update control for **Update now** or **Later**. After the verified download,
an explicit **Install update** action hands the file to Android. Android may require permission
to install from Internext Counter and always retains control of installation approval.

Before an authenticated counter can update, the website must report a loaded, online, idle
Sell screen with no unsaved work, unresolved request, active operation or open shift. Close
the shift and return to Sell. A fresh login screen or a properly guarded sign-out can also
qualify. An expired session with unresolved local history does not qualify. The native app
reads a narrowly scoped readiness marker and fails closed if it is absent; this marker grants
no financial permissions and clears no storage. Finish any physical printing before installing.

If version 1.0.0 is already installed, download 1.1.0 from the official downloads page and
install it **over** that app once. Version 1.0.0 cannot discover its own update. Never uninstall
or clear storage to upgrade. Retain the same signing key and application ID so Android preserves
app-private data. Website changes appear when the connected counter reloads; installed native
changes require an APK update. Offline selling is still unavailable.

See [release preparation and publication](../../docs/operations/android-app-updates.md).

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

- Fixed exact HTTPS origin; ignores incoming intent URLs; denies other navigation and all WebView downloads.
- The separate native updater uses the fixed HTTPS release endpoint, refuses redirects, limits response
  sizes, validates exact APK URL/bytes/hash/package/version and the installed and downloaded pinned
  signing certificate. Only the verified app-private update file is handed to Android through a
  narrowly scoped, non-exported provider with a temporary read grant. Failed or cancelled checks
  leave the installed version usable; a remote manifest cannot authorize arbitrary code installation.
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

The wider launch still needs actual POS/printer acceptance, named cashier onboarding (new-account
and password-reset email delivery remains pending mail setup), and a supervised first shift.
Direct thermal-printer adapters and production offline selling are separate unfinished work.
