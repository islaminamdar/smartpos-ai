# Native clock recovery contract

Status: implementation candidate. No customer APK release or offline selling activation is implied.

Clock recovery is an online, original-account-authorized repair of a native clock latch. It permanently retires the old installed selling allowances and any pending reservation; it does not recreate or extend them. Existing bills, invoice ranges, chain entries, payment holds, PIN verifiers and failure counts remain intact. Correct Android system time is required before applying the repair. Completion ends the native session locked.

## Protocol

All objects are strict. UUIDs and SHA-256 values are lowercase; hashes are 64 hexadecimal characters. Canonical JSON and the existing P-256 signed-envelope format apply.

Device proof fields: `kind: native-clock-recovery`, `schemaVersion: 1`, `requestId`, `installationId`, `organizationId`, `branchId`, `deviceId`, `actorId`, `keyEpoch`, `deviceKeySha256`, `oldClockGeneration`, `oldClockSha256`, `retirementSha256`. Generation is an integer from zero through 9007199254740991. There is no device timestamp because the clock is untrusted.

Approval repeats the exact identity fields, changes kind to `native-clock-recovery-approval`, and adds `proofSha256` (canonical proof payload hash) and `approvedAt` (UTC ISO timestamp with milliseconds). It is immutable and retained before financial retirement. The database accepts at most one request for an installation/key epoch/old generation. Approval needs the original active account, current binding and fresh password confirmation. Exact historical retrieval remains possible after revocation; it cannot authorize a different generation or manifest.

A separate fresh signed time object has kind `native-clock-recovery-time`, schemaVersion 1, requestId, approvalSha256 (canonical approval payload hash), retirementSha256, oldClockGeneration, challenge (native random 64 hex), and serverTimeMs. Every attempt obtains a fresh native challenge and handoff, including historical lookup. Immutable approvedAt is never a clock anchor.

`POST /api/pos/native/clock-recovery` accepts `{mode: lookup, proof, challenge}` or `{mode: approve, proof, challenge, password}`. Password exists transiently in native HTTPS and Auth only; no JavaScript or SQL password input. Success is `{status: approved, approval, time}`; absent exact historical approval is `{status: not_found}`. No response clears a pending hold or proves it safe to create a different request.

## Native transaction and custody

Before network access, persist an authenticated request and manifest with a pending hold. Manifest covers all installed bundles and the exact saved pending reservation. Normal clock access cannot change the captured old clock hash while pending. After verifying approval, persist irreversible retirement in the financial journal, then compare-and-swap the original authenticated clock generation/hash and record completion. Recover crashes by resuming the same identity. Old authority clocks, expiry and counters are preserved. Fences apply at installation, begin and commit, including the explicit reference-reading installation path and late arrival of a previously missing grant.

The actual native observations must share a boot, have nondecreasing elapsed time and a round trip no greater than 30000 ms. Add the full elapsed round trip to signed server time. Android wall time at apply must be within 120000 ms of that conservative server time. A reboot invalidates the challenge; it does not erase the pending request. A later generation must reject replay. Generation zero preserves legacy boot IDs; a successful repair advances generation and derives a new boot identity, conservatively restarting any existing PIN cooldown without resetting attempts.

Retired authorities still require normal seal/ACK/payment reconciliation. Only reconciled retired rows can stop blocking a future allocation. Clock recovery never issues, cancels, forgives or silently resolves a payment. Pending PIN recovery remains discoverable and unchanged. Missing or corrupt signing keys, authentication or financial stores fail closed.

## Bridge and UI

Only `getNativeClockRecoveryState()`, `startNativeClockRecovery()` and `retryNativeClockRecovery({requestId})` are exposed. Native owns password dialogs, clock observations, proof, manifest, nonce and HTTPS. Metadata has exactly schemaVersion, status, requestId, canStart, canRetry, passwordRequired and reasonCode. UI must retain global pending holds and discard callbacks after actor/lifecycle changes. Completion is a locked state, not permission to sell.

## Commissioning limits

This recovery protocol requires a previously enrolled device key epoch. A clock fault latched before first key enrollment cannot use it: the normal enrollment flow itself requires healthy clock observations. The separate [bootstrap candidate](20261016-native-clock-bootstrap.md) addresses intact installations with no enrollment uncertainty or financial custody. A healthy fresh install or enrolled-but-unprepared counter remains usable for normal setup. No automatic shift, store reset, invented healthy-clock result or replacement installation is used to bypass these limits.

Missing or corrupt custody/key stores, staff/device loss, complete two-device reconnect acceptance, physical receipt printing and signed customer APK commissioning remain separate work. Server support including SQL028 was deployed with web release `2de794a`; production offline issuance remains disabled and the customer APK is unreleased. Pre-enrollment repair is specified separately in the [bootstrap contract](20261016-native-clock-bootstrap.md).

## Verification required

Real signature and SQL authorization/replay/race checks; native global-latch-before-authority regression; late grant retirement; fresh-time, reboot and elapsed boundaries; cross-store crashes; PIN cooldown and permanent lock preservation; pending PIN coexistence; custody snapshots; retired allowance issuance denial; new allocation only after reconciliation; responsive recovery views. Hardware/customer commissioning and deployment are separate gates.
