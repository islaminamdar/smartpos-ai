# Android counter foundation

This is a bundled Capacitor 8 Android client for Internext POS. It opens without internet and reads a native SQLite journal. **This build cannot enroll a live counter or issue sales.** The app explicitly reports that selling is paused. The production website remains the online counter.

## What exists

- Device setup/status and saved-receipt summary screens, with explicit unavailable/stale/error states.
- Android Keystore P-256 identity, persisted fingerprint binding, and nonexportable signing key. Hardware-backed storage is not guaranteed on every device.
- Private SQLite storage with full synchronization and WAL, immutable receipts/acknowledgements, exact intent retry checks and transactional receipt/outbox/intent writes.
- Read-only native bridge: identity, status and receipt summaries. No arbitrary SQL, financial writes, private keys or credential operations are exposed to JavaScript.
- Cloud backup and device transfer disabled to prevent copying an active issuer's identity and ledger. There is no export/restore product workflow yet.
- Bundled local web assets, no remote privileged WebView, no cleartext network traffic, native bridge logging disabled.

`NativeJournal.commitVerifiedIssuance` and `acknowledgeVerified` are internal storage primitives. Their caller must validate the signed authority, prices/tax, local staff unlock, invoice reservation, sequence, aggregate budget and server acknowledgement. That issuance/reconciliation engine is not implemented; these methods are not exported by the plugin. Storage tests use explicitly synthetic records and are not proof of live financial correctness.

The [offline protocol contract](../../docs/contracts/20261016-offline-issuance-contract.md) defines the next integration. Multiple devices require disjoint invoice reservations and their own authorities. Browser training history must never enter this ledger.

## Build

Use Node 22+, Java 21 and Android SDK 36. Keep machine paths in ignored `android/local.properties`. Run from this directory:

```sh
npm ci
npm run build
npm run sync
cd android
./gradlew --no-daemon :app:assembleDebug :app:assembleDebugAndroidTest
```

Scope Gradle to `:app`: the generated unused Cordova library's own test APK has conflicting old Kotlin dependencies; it is not the application's test target. The app/test APKs build successfully. The Gradle distribution is checksum-pinned. A debug APK is an engineering artifact, not a signed customer release. Production signing and manager distribution remain pending.

## Verification

Shared TypeScript/UI tests run from the repository root. Native instrumentation includes `NativeJournalAuditTest` (each test uses and deletes a separate synthetic database). `NativeRestartTest` has explicitly ordered phases: `seed`, `verify` after force-stop, `verify` after reboot, optional `verify` after an in-place APK update, then `cleanup`. Do not run all phases using unordered test discovery or repeat `seed` over an existing fixture.

Observed on an isolated Android 15/API35 emulator on 2026-10-16: nine journal tests passed; a signed synthetic receipt and its pending record survived a force-stop and full emulator reboot with Wi-Fi/mobile data disabled. The actual bundled app opened offline and read its separate empty native journal. Responsive UI fixtures were reviewed at 1280,375,320px; synthetic fixtures are not bundled.

The native `offline-line-v1` calculator now has shared server/Android golden fixtures for piece, pack and weighted sales, inclusive VAT rounding, cash/card/mixed payments and change. It only calculates: its caller must obtain prices and metadata from a verified historical snapshot and enforce authority, staff identity and limits. `requiresBuyerDetails` is a gate for the future issuer, not automatic permission to omit buyer details.

`CanonicalJson` and `SignedProtocol` implement the same canonical UTF-8 payloads, P-256 DER signatures and SPKI fingerprints as the server. The strict native parser rejects duplicate keys, lenient JSON, excessive nesting and oversized input before recursive parsing. Trusted keys are supplied separately; no keys in incoming messages are trusted. Signature verification alone does not authorize a sale. Shared synthetic Node-generated signatures exercise both runtimes. Test fixtures are packaged only in the instrumentation APK, never the customer app.

Run `:app:testDebugUnitTest` for native arithmetic and protocol checks. Run the explicit `info.internext.pos.offline.OfflineProtocolAndroidTest` instrumentation class for the real Android parser/crypto providers and an ephemeral Android Keystore signing key (removed after the test). Do not run all instrumentation classes indiscriminately: the existing restart fixture still requires its ordered phases.

Still required: signed server grant allocation and atomic historical import, native grant/schema validation and complete invoice engine, staff unlock and clock policy, complete local counter/shift workflows, multi-device reconnect tests, full-storage/power-loss tests, controlled recovery, printer adapters, production signing and physical POS acceptance. Emulator recovery does not certify physical hardware durability.
