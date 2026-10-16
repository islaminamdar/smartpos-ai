# Android counter candidate

This is a bundled Capacitor 8 Android client for Internext POS. It opens without internet and uses a native SQLite journal. At candidate `0a78059`, native access/enrollment, preparation, checkout and recovery flows are implemented, but **production sale issuance is hard-disabled and the required server candidate is not deployed**. This is an internal engineering APK, not a customer release. The recorded live website remains the online counter. See the [launch readiness audit](../../docs/plans/2026-10-16-launch-readiness.md) for the release boundary.

## What exists

- Device setup/status and saved-receipt summary screens, with explicit unavailable/stale/error states.
- Android Keystore P-256 identity, persisted fingerprint binding, and nonexportable signing key. Hardware-backed storage is not guaranteed on every device.
- Private SQLite storage with full synchronization and WAL, immutable receipts/acknowledgements, exact intent retry checks and transactional receipt/outbox/intent writes.
- Narrow native bridge for access/enrollment, preparation, authoritative quote/payment-intent/receipt operations, reconciliation and recovery. New collection/issuance stays behind the native release gate. No arbitrary SQL, private keys, passwords or PIN values are exposed to JavaScript; credentials and PINs use native dialogs.
- Cloud backup and device transfer disabled to prevent copying an active issuer's identity and ledger. There is no export/restore product workflow yet.
- Bundled local web assets, no remote privileged WebView, no cleartext network traffic, native bridge logging disabled.

`NativeJournal.commitVerifiedIssuance` and `acknowledgeVerified` are internal storage primitives. Their caller must validate the signed authority, prices/tax, local staff unlock, invoice reservation, sequence, aggregate budget and server acknowledgement. The internal `NativeCheckoutEngine` now connects these primitives to verified bundles, native calculation, intent custody, sequence/budget allocation, device signing, sealing and signed server acknowledgement. The engine constructor remains package-private. The plugin now exposes validated coordinator methods, with original actor/PIN/scope checks before financial detail read/replay and a hard-disabled production issuance gate. Native enrollment, local unlock and OS clock handoff exist in the candidate; live deployment and full operational acceptance remain pending. Injected enabled test guards do not authorize production sales.

The [offline protocol contract](../../docs/contracts/20261016-offline-issuance-contract.md) defines the candidate protocol and acceptance boundaries. Multiple devices require disjoint invoice reservations and their own authorities. Browser training history must never enter this ledger.

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

`OfflineBundle` verifies both server signatures, exact historical hashes, independently supplied enrollment bindings and strict immutable snapshot/authority schemas. `OfflineClock` estimates bounded server time, detects rollback/drift and conservatively handles reboot readings; see [clock policy](../../docs/contracts/20261016-native-clock-policy.md). The native engine latches clock anomalies in SQLite before rejecting a new sale. Expired grants never hide an already committed receipt.

Checkout input contains only authority ID, service type, customer details, product IDs/quantities, tender amounts and the amount presented to the cashier. `beginPaymentIntent` recalculates and freezes that input before collection. Only one unresolved intent is allowed; restart does not imply collection succeeded or failed. `commitPaymentIntent` requires explicit cashier confirmation, recalculates from the frozen snapshot, checks local unlock/time/budgets, signs the invoice and atomically commits receipt, intent linkage, upload queue, counters and chain. An exact committed engine retry returns the original envelope without issuing again; the public coordinator first requires the original actor/scope and native unlock before exposing financial details. Changed input conflicts. A reasoned `cancelUncollectedIntent` retains evidence and explicitly means no money was collected; it cannot cancel an issued bill. Card entries record an external payment, never initiate a charge.

`sealAuthority` durably stops issuance before returning its exact signed declaration. `acknowledgeIssuance` verifies the trusted server signature and exact receipt hash, authority, epoch and sequence before removing that one upload entry. SQLite schema version2 adds custody tables without rewriting version1 receipt/key/intent history. `NativeUpgradeTest` has explicit `seedLegacy` against the archived version1 APK, `verifyUpgrade` after an in-place install, then `cleanup`; never run its phases unordered. After schema version2 has been opened, do not downgrade to a version1-only APK; retain a compatible reader and all custody records.

Verified on the isolated Android emulator: real SQLite/Keystore checkout tests, previous journal tests, protocol/bundle/clock compatibility, and actual version1-to-version2 APK upgrade with retained receipt/outbox/key/installation identity. `tests/fixtures/native-checkout-output.json` was exported by the real Android checkout test with synthetic merchant data and ephemeral public keys. Server tests independently verify those native signatures, money calculations, sequence chain and terminal declaration. No private keys or real merchant data are included. New clock reboot tests use synthetic readings; prior physical emulator restart checks covered the earlier journal foundation, not this complete checkout engine.

Current candidate additions are documented in [secure access](SECURE-ACCESS.md), [local unlock](LOCAL-UNLOCK.md), [checkout](CHECKOUT.md), [reconciliation](RECONCILIATION.md), [missing-allocation recovery](RECOVERY.md) and [permanent payment freeze](PAYMENT-RECOVERY.md). SQLite is now version 4; additive historical-schema migration evidence is distinct from an ordered old-APK upgrade test. Local permanent freeze preserves custody but does not submit or resolve manager review.

Still required: complete server claims/manager decisions and signed outcome delivery, subsequent allocation/shift and controlled PIN/clock/staff/device-loss recovery, deploy/configure the server candidate only after full acceptance, two-device native/server reconnect, full-storage/power-loss checks, printer adapters, production signing and physical POS/manager acceptance. Native financial methods exist, but new production sale issuance remains disabled. Emulator recovery does not certify physical hardware durability.
