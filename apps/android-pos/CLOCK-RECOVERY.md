# Native device-clock recovery candidate

This is an unreleased, original-device recovery path. It does not enable offline selling, increase invoice limits, reset a staff PIN, or create a financial document. Production offline issuance remains disabled. Hardware, printer, multi-device and commissioning acceptance remain separate release requirements.

An enrolled counter whose authenticated OS-clock high-water record detects a rollback, or whose unsealed allocation detects a genuine clock-drift anomaly, can request recovery using its original staff account password in a native Android dialog. Correct Android date and time before completing recovery. A healthy counter does not need recovery. The JavaScript bridge accepts only the explicit saved request ID on retry; passwords, PINs and proposed clock readings never come from JavaScript.

The native clock database upgrades from version 1 to 2 without changing generation-zero boot identities. Its Keystore MAC protects the clock state, pending recovery and audit. The financial ledger upgrades from version 7 to 8 by adding immutable holds, retirements and completion records. Existing receipts, payment intents, customer data, acknowledgements, sequence counters, authority clock observations and staff PIN records remain in place.

Recovery ordering is deliberately conservative:

1. Persist the exact device-signed request and retirement manifest before sending it. The manifest covers all installed allocation hashes and the encrypted vault's pending reservation. Pending recovery blocks preparation and financial writes, including installation paths that receive a reference clock reading.
2. Retain an independently verified, pinned-server approval. Only then permanently fence all covered allocations. No unapproved password attempt retires allocations.
3. Obtain a fresh challenge-bound signed time response for every apply attempt. Require the same OS boot, nondecreasing elapsed time, a round trip of at most 30 seconds, and corrected wall time within 120 seconds of server time plus the full round trip.
4. Commit financial retirement before replacing the global clock baseline. Atomically increment its generation and retain the previous state plus signed evidence in the clock audit. Record financial-side completion afterward. A crash at either boundary leaves an explicit saved recovery for retry.

The new generation changes the native boot identity. Existing PIN verifiers and failed-attempt counters are unchanged; an existing temporary PIN cooldown is conservatively restarted under the new boot identity, and a permanent failed-attempt hold is not cleared. Pending PIN recovery remains discoverable. The counter finishes locked and requires a separate PIN unlock.

Old allocations stay blocked permanently. Outstanding receipts still require their original signed acknowledgements; uncertain payments still require cancellation of genuinely uncollected money or the existing manager reconciliation flow. Every allocation must still be sealed and confirmed. Only after these existing holds are clear can normal continuation and a distinct, newly authorized allocation proceed. A late bundle belonging to a retired pending reservation may be retained and sealed through historical recovery, but cannot become a selling allocation.

Historical lookup uses the saved device proof without session cookies and ignores response cookies. It can retain an existing approval after staff access is revoked or the app is signed out. Applying the clock replacement still requires the original signed-in local actor, fresh native confirmation, the original device key and a fresh signed time exchange. Backgrounding invalidates the current attempt; an authentic late approval is kept for later explicit retry.

## Deliberate limits

- A clock fault before the first key epoch is enrolled has no approved bootstrap-recovery protocol yet. The app remains blocked; it must not claim the clock is healthy or recreate storage to bypass this. Healthy fresh installation and healthy enrolled-but-unprepared setup remain available.
- Missing/corrupt clock, financial, credential or encrypted session storage, lost Keystore keys, OS boot-counter rollback and same-boot elapsed-time rollback fail closed. Recovery does not repair these signals or reset an installation.
- Android OS time is a software signal, not tamper-proof hardware time. The signed-time and retirement rules bound recovery; they do not claim hardware attestation or prevent restoration of an entire external device image.
- New recovery approvals require the server feature configuration and deployed SQL contract. Local candidate tests are not evidence that those production gates are enabled.

The dedicated JVM, Android storage/transport, migration and native-dialog tests use synthetic merchant data, disposable databases, isolated Keystore aliases and fake HTTPS responses signed with real ephemeral P-256 keys. Test outcomes are recorded separately; this document is not a claim that unrun tests passed.

## Verification checkpoint — 2026-10-16

The final candidate passed 108 JVM tests and 40 focused Android device tests, including clock recovery, native dialogs, screen-lock event propagation and the version-six ledger upgrade. The surrounding 144-case Android run passed 143 initially; its remaining legacy-schema fixture incorrectly included new tables. After correcting only that fixture, the failed case passed in the final focused run. Original failure evidence is retained.

The web suite passed 1,180 tests with one existing skip. Isolated PostgreSQL checks covered 162 assertions and nine observed lock races with populated custody preserved; seven additional service checks used actual PostgreSQL and P-256 signatures with mocked authentication transport. Actual Android-generated signatures and status metadata were checked by the TypeScript parser. Desktop and 375/320px recovery views were inspected without horizontal overflow. Builds, type checking and scoped security scans passed; full lint retained 43 existing warnings and no errors. These results establish the tested candidate scope, not live SQL028 activation, real-provider acceptance or a customer-ready APK.
