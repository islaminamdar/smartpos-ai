# Missing allocation recovery

Candidate only. Native sale issuance remains disabled. The matching historical server endpoint and SQL017 are not yet released to the live pilot.

A preparation request may reserve invoice numbers on the server before the signed response reaches Android. The encrypted native session retains that exact request ID and original actor, counter, shift and key epoch. `NativeBundleRecovery` uses those records and the nonexportable device key to request the original bundle. It does not create a replacement request, authenticate a cashier, reserve numbers, or reset permission.

## Boundary and transaction

`getBundleRecoveryState()` reads local custody. It reports `not_needed`, `available`, `blocked`, or `retained`, with only the allocation ID and a bounded reason code. `recoverMissingOfflineBundle({authorityId})` requires the displayed original ID and an explicit UI confirmation. The bridge rejects extra fields and stale foreground operations. A pause may hide an already-completed result; the UI reads state before offering a fresh consented retry.

The native request is a device-signed `offline-bundle-recovery` proof sent only to `/api/pos/offline/bundle-recovery`. Transport sends and adopts no cookies. It is usable after logout or staff revocation, but only for the retained historical scope. The response contains the original signed snapshot/authority and a distinct `native-offline-recovered` handoff with `purpose: reconciliation-only`. Pinned server keys, exact scope, both payload hashes, fresh random challenge and an OS monotonic round trip of at most 30 seconds are checked before storage. A prepared handoff cannot substitute for a recovered handoff or vice versa.

Both expired and unexpired missing allocations are inserted and sealed in one SQLite transaction. No invoice is issued, no invoice number is consumed, and no device chain event is added. Existing active allocations are never finished by this recovery path. An uncertain payment, other unfinished/blocked allocation, incompatible key epoch or missing legacy chain blocks recovery. Previously committed receipts, outbox, signatures, numbers and chain head remain unchanged. Signing or storage failure rolls back the whole retention; exact retry of an already retained allocation returns the existing seal without network or re-anchoring.

This terminal-only operation uses native OS readings for response freshness without reading or changing the authenticated selling-clock or PIN stores. The stored anchor belongs only to the new already-sealed allocation. It never repairs a clock anomaly or grants selling time. The internal engine entry point cannot be selected by JavaScript, and its PIN/clock callbacks deliberately throw if invoked.

The original encrypted reservation is checked again before the network request and under the session lock before the journal transaction. A stale response cannot be attached after its scope or reservation changes.

## Confirmation and operator limits

Recovery does not upload its seal automatically. The screen reports local retention and directs the operator to **Upload saved records**. Existing reconciliation uploads outstanding receipts first, then the exact stored seal, and requires the server's signed acknowledgement before reporting confirmation. A local retained result is not proof of server acceptance or shift closure.

Unknown responses and reasons fail closed. The UI binds consent to the exact allocation and requires another status check/confirmation after uncertainty. It does not reset the app, replace device identity, clear a pending payment, or begin a new allocation. Missing device keys, lost app data, staff/PIN recovery and collected-payment expiry remain separate unresolved workflows.

Verification is recorded privately with the candidate commit: JVM signed-handoff tests, real Android SQLite/Keystore/vault recovery and transport tests, preparation/checkout regression tests, UI boundary tests, mobile/desktop review and scoped Semgrep. This is not the complete two-device native/server acceptance or a customer APK release.
