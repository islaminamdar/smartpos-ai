# Native device-clock recovery candidate

This is an unreleased, original-device recovery path. It does not enable offline selling, increase invoice limits, reset a staff PIN, or create a financial document. Production offline issuance remains disabled. Hardware, printer, multi-device and commissioning acceptance remain separate release requirements.

An enrolled counter whose authenticated OS-clock high-water record detects a rollback, or whose unsealed allocation detects a genuine clock-drift anomaly, can request recovery using its original staff account password in a native Android dialog. Correct Android date and time before completing recovery. A healthy counter does not need recovery. The JavaScript bridge accepts only the explicit saved request ID on retry; passwords, PINs and proposed clock readings never come from JavaScript.

The native clock database upgrades from versions 1 or 2 to 3 without changing generation-zero boot identities. Its Keystore MAC protects the clock state, pending recovery and audit. The financial ledger upgrades from version 7 to 8 by adding immutable holds, retirements and completion records. Existing receipts, payment intents, customer data, acknowledgements, sequence counters, authority clock observations and staff PIN records remain in place.

Recovery ordering is deliberately conservative:

1. Persist the exact device-signed request and retirement manifest before sending it. The manifest covers all installed allocation hashes and the encrypted vault's pending reservation. Pending recovery blocks preparation and financial writes, including installation paths that receive a reference clock reading.
2. Retain an independently verified, pinned-server approval. Only then permanently fence all covered allocations. No unapproved password attempt retires allocations.
3. Obtain a fresh challenge-bound signed time response for every apply attempt. Require the same OS boot, nondecreasing elapsed time, a round trip of at most 30 seconds, and corrected wall time within 120 seconds of server time plus the full round trip.
4. Commit financial retirement before replacing the global clock baseline. Atomically increment its generation and retain the previous state plus signed evidence in the clock audit. Record financial-side completion afterward. A crash at either boundary leaves an explicit saved recovery for retry.

The new generation changes the native boot identity. Existing PIN verifiers and failed-attempt counters are unchanged; an existing temporary PIN cooldown is conservatively restarted under the new boot identity, and a permanent failed-attempt hold is not cleared. Pending PIN recovery remains discoverable. The counter finishes locked and requires a separate PIN unlock.

Old allocations stay blocked permanently. Outstanding receipts still require their original signed acknowledgements; uncertain payments still require cancellation of genuinely uncollected money or the existing manager reconciliation flow. Every allocation must still be sealed and confirmed. Only after these existing holds are clear can normal continuation and a distinct, newly authorized allocation proceed. A late bundle belonging to a retired pending reservation may be retained and sealed through historical recovery, but cannot become a selling allocation.

Historical lookup uses the saved device proof without session cookies and ignores response cookies. It can retain an existing approval after staff access is revoked or the app is signed out. Applying the clock replacement still requires the original signed-in local actor, fresh native confirmation, the original device key and a fresh signed time exchange. Backgrounding invalidates the current attempt; an authentic late approval is kept for later explicit retry.

## Deliberate limits

- Pre-enrollment bootstrap is limited to the strictly empty local setup described below. Any uncertain enrollment, financial or lifecycle history, PIN credential/recovery history, or enrolled clock recovery must use its existing recovery process. An acknowledged empty online setup shift is preserved exactly; an unacknowledged shift request is ineligible.
- Missing/corrupt clock, financial, credential or encrypted session storage, lost Keystore keys, OS boot-counter rollback and same-boot elapsed-time rollback fail closed. Recovery does not repair these signals or reset an installation.
- Android OS time is a software signal, not tamper-proof hardware time. The signed-time and retirement rules bound recovery; they do not claim hardware attestation or prevent restoration of an entire external device image.
- New recovery approvals require the server feature configuration and deployed SQL contract. Local candidate tests are not evidence that those production gates are enabled.

The dedicated JVM, Android storage/transport, migration and native-dialog tests use synthetic merchant data, disposable databases, isolated Keystore aliases and fake HTTPS responses signed with real ephemeral P-256 keys. Test outcomes are recorded separately; this document is not a claim that unrun tests passed.

## Prior enrolled-recovery verification checkpoint — 2026-10-16

The final candidate passed 108 JVM tests and 40 focused Android device tests, including clock recovery, native dialogs, screen-lock event propagation and the version-six ledger upgrade. The surrounding 144-case Android run passed 143 initially; its remaining legacy-schema fixture incorrectly included new tables. After correcting only that fixture, the failed case passed in the final focused run. Original failure evidence is retained.

The web suite passed 1,180 tests with one existing skip. Isolated PostgreSQL checks covered 162 assertions and nine observed lock races with populated custody preserved; seven additional service checks used actual PostgreSQL and P-256 signatures with mocked authentication transport. Actual Android-generated signatures and status metadata were checked by the TypeScript parser. Desktop and 375/320px recovery views were inspected without horizontal overflow. Builds, type checking and scoped security scans passed; full lint retained 43 existing warnings and no errors. These results establish the tested candidate scope, not live SQL028 activation, real-provider acceptance or a customer-ready APK.

## Pre-enrollment bootstrap candidate

An explicit Android confirmation can verify corrected device time before a server key epoch exists. It works while signed out, without requesting a password or PIN. The native bridge accepts no arguments. A separate anonymous endpoint returns a pinned-server signed time envelope bound to the original installation, current retained device-key fingerprint, authenticated old clock generation/hash and a fresh native nonce. It does not authorize an account, enroll the device, open a shift, reserve invoice numbers or enable selling.

Admission checks every financial and lifecycle table for emptiness and checks the complete expected table inventory. It also verifies the existing device key, encrypted vault, authentication identity, absence of credentials and PIN recovery history, and absence of enrolled clock recovery. Missing or malformed records fail closed. An uncertain enrollment/reservation/shift operation cannot be treated as empty. The one setup-shift exception requires an exact acknowledged shift-open request matching the original scope; the vault and shift remain unchanged.

The native clock remains blocked throughout the request. Immediately before application the same gates are checked again under the session, journal, authentication and clock locks. A fresh same-boot exchange must finish within 30 seconds, with nondecreasing elapsed time and corrected OS wall time within 120 seconds of signed server time plus the full round trip. Backgrounding invalidates the attempt. The clock replacement and immutable MAC-protected signed-evidence audit commit together, using the exact old generation/hash. A failed write rolls both back. Restart after a committed replacement discovers completion; retry before completion uses a new nonce. Every retained bootstrap generation must have its contiguous authenticated audit.

No storage or key is recreated as a repair action. If both a protected store and its matching Keystore identity are removed or a whole device image is restored, local emptiness is not cryptographic proof that history never existed. Those external state-loss cases remain unsupported. A commissioning interruption between creating the initial device key and recording its fingerprint also fails closed. Bootstrap does not change PIN limits, financial records, invoice counters or old allocation clocks.

Bootstrap verification results are recorded separately from the prior enrolled-recovery checkpoint above. No production bootstrap activation or customer APK readiness is implied.

### Bootstrap verification checkpoint — 2026-10-16

The local candidate passed 113 JVM tests and 145 distinct Android instrumentation cases across focused and affected suites. The first 67-case run had one premature dialog-callback assertion; waiting for Android's queued cancellation callback corrected that test without changing runtime behavior. Its exact rejection and dismissal assertions then passed. The additional 76-case session, preparation, transport, staff-security and lock-event regression run passed completely. Five final-package checks passed after the last dialog-copy update and final UI asset synchronization.

The APK's bundled HTML, JavaScript and CSS matched the built assets byte for byte. Real TypeScript-produced P-256 signed time passed the JVM verifier; actual Android canonical request bytes and signed responses passed the production TypeScript parser and route. Bounded independent source review and Java/security Semgrep scans reported no findings. Synthetic cache exports were archived and removed, the owned emulator was stopped, and app databases, keys, encrypted vault and WebView storage were preserved. These are local candidate results, not production bootstrap acceptance or customer APK release.
