# Android Counter 1.1.0 acceptance — 2026-10-17

The signed customer package remains `info.internext.pos.counter`, now version 1.1.0/code 2.
This is an online counter release with direct-hosted update discovery. It is not the final
offline POS release. Publication/readback evidence is retained in the operator's private task record.

## Verified before publication

- Production web build/typecheck succeeded; 1,496 web tests passed, one existing test skipped.
  An unchanged offline-candidate test initially timed out under concurrent builds; its isolated
  rerun and the subsequent complete run both passed.
- Six Android unit tests, release lint/build, and six release instrumentation checks passed.
- A real signed 1.0.0 → 1.1.0 emulator upgrade preserved a first-party HttpOnly cookie,
  localStorage, IndexedDB and app preferences without uninstalling. Synthetic probe data was removed.
- A private signed 1.1.1/code 3 fixture exercised the update UI and actual Android installer.
  Automatic discovery was nonmodal; Later did not download; a one-byte APK change failed the
  real checksum verifier; the restored artifact passed package/version/current-signer verification.
- Android installation permission/settings and installer confirmation were exercised. Cancelling
  left code 2 installed and the update available. Confirming replaced it with code 3, independently
  read back from Android. Package replacement ended instrumentation as expected. The test fixture
  was never published; the emulator snapshot restores the customer code 2 installation.
- Readiness checks cover idle Sell, open shifts, baskets, busy/pending recovery, other editing
  screens, fresh login, guarded sign-out and expired loaded sessions. The native caller checks
  the exact first-party page, one readiness marker and print state again before installer handoff.
- Mobile 375px and desktop 1280px previews passed overflow/readiness checks. Bootstrap data in
  those presentation tests was intercepted synthetic data; no real customer sales were written.
- Fourteen publisher test methods passed. Scoped Semgrep had no unresolved finding: the
  exported launcher is required, ignores incoming URLs, and exposes no updater control plane.

## Test boundaries and remaining work

The private installer fixture substitutes the network transport; it verifies actual APK bytes,
signature and Android installation, not a future public release download. Public release files
must additionally be fetched and compared with staging after publication. The production
manifest endpoint and manual Check updates must be checked on the restored customer APK.

Offline issuance/reconnect across counters, direct USB/Bluetooth thermal printing, physical POS
commissioning, kitchen routing setup, new-cashier email onboarding, ongoing offsite backup/alerts,
eight authentic menu photos and the supervised first customer shift remain separate work.
Same-package upgrades preserve durable request journals; a fresh login cannot inspect another
account's journals. Staff must still reconcile uncertain payments before updating. APK updates
do not uninstall, clear browser storage or claim delivery to a physical printer.
