# Source security review — 16 October 2026

The standard source review completed against `a4e52298e973e47a58a9fbda170c51a66e619761`. It covered all 814 tracked artifacts, including application and native source, SQL migrations, tests, documentation, configuration and static asset/container inspection. Independent reviews and parent validation produced one low-severity finding. The immutable report and original evidence are retained in the private audit record.

## Validated finding

Full Android receipt/customer details and protected drawer totals could remain on a continuously foreground screen after the five-minute native PIN session expired. Later native reads and writes still required a valid session. The missing control was notification to clear information already displayed.

This requires previously authorized details, physical access to the same unattended device, and no earlier operating-system screen lock. Explicit lock, sign-out and backgrounding already invalidated these views. It is not a remote access or financial-write bypass. The candidate APK has not been released and production Android sale issuance remains disabled.

The separately investigated signed-out receipt summary is not a finding: the documented recovery contract deliberately permits limited invoice number/time/amount/sync metadata. Full protected receipt details have a different access boundary.

## Candidate correction

The native session now owns a generation-tagged notification deadline using elapsed time. Expiry first invalidates in-flight native operation epochs, then publishes the existing lock event on the main looper. Receipt and drawer views already clear private cached data on that event. Failed PIN retries and repeated locked reads cannot cancel a pending expiry notification; a later successful unlock replaces the old generation. Database commit time does not extend the original deadline. The timer does not acquire authentication or database locks.

The correction preserves native read/write authorization and explicit lock, pause and sign-out handling. It does not alter credentials, stored receipts, financial authority or the limited recovery-summary policy. See [native session behavior and scheduling limits](../../apps/android-pos/LOCAL-UNLOCK.md). The immutable audit remains evidence for the earlier revision; correction evidence is recorded separately.

The full web unit suite passed 1,083 tests with one pre-existing skipped test. All 100 native JVM tests passed, including ten deterministic expiry cases. The six native UI suites passed 164 tests; their lock events are simulated and are not evidence of Android timer delivery. Type checking, scoped UI lint, and scoped Semgrep checks on the four changed native production files and three changed UI test files passed. The Android debug and instrumentation packages built successfully. Physical POS and printer acceptance remain separate from these checks.

All 122 targeted Android instrumentation cases have passing evidence. The first broad run passed 121/122: one new listener test attached before initial page navigation, which resets Capacitor listeners. After correcting that test setup without changing production code, both real Handler/bridge cases passed. They verify main-looper lock notification after the native deadline and rejection of an already-running private-detail response. Six new real Keystore/SQLite regressions cover native session expiry and cancellation races. These isolated emulator checks do not establish full two-device offline operation or physical receipt delivery.

## Evidence limits

This audit used source traces and static inspection; it did not execute application tests or make production changes. Eight local Semgrep rules scanned 328 source files with zero parse errors. All 48 SQL-concatenation leads were checked and resolved to fixed internal identifiers/predicates or isolated test helpers. That scan is not a claim that all vulnerability classes were mechanically checked.

PNG/WebP container inspection and Gradle wrapper bytecode review do not establish image-decoder security, dependency internals or upstream binary provenance. Deployed ingress, configuration, migrations, provider behavior and physical-device operation require their own evidence. A subsequent production dependency advisory query reported zero known advisories for the current lockfile; advisory absence is not proof of security.

## Release boundary

The live service was checked after the review: release `5573dcc1bb0028c5891c457663ecd182be4d8e2d` reports an online pilot, with offline sales disabled. The manager browser is connected to Bur Dubai and awaits registration of the intended physical counter. No synthetic opening cash, sale or customer bill was entered.

SQL017–027 remain candidate migrations. The manager Operations view, menu photo upload and inventory baseline are implemented candidates, not live features. Inventory currently supports explicit counts, receipts, waste and adjustments; it does not claim recipe consumption, purchasing, transfers or expiry tracking. The existing manual AED100 pilot agreement remains unchanged. USD100 commercial PayPal billing is uncommissioned.

This review closes the whole-repository source-review task. It does not close the operational release requirements in [launch readiness](2026-10-16-launch-readiness.md), including offline two-device acceptance, physical printing, customer APK signing/update preservation, off-host restoration and provider commissioning.
