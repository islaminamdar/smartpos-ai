# Continue after a finished allocation

Candidate only. Production Android sale issuance remains disabled. SQL017–022 and the matching server configuration are not deployed to the online pilot. This increment does not release a customer APK.

## Explicit handoff

The device screen first reads local state without network or mutation. Continuing requires the displayed original allocation, the original signed-in staff/device scope, a native PIN dialog and internet. It preserves every receipt, intent, freeze, accepted manager outcome, acknowledgement, seal, bundle, device key, PIN and clock record.

The previous allocation must be finished, its exact seal confirmed, every receipt acknowledged with a valid signed server ACK, and payment/conflict holds cleared. Empty upload queues alone are insufficient. Older allocations cannot be reused after a later allocation, including one finished without sales.

`POST /api/pos/native/continuation` uses the current authenticated native device binding. SQL022 locks and rechecks current access, original shift, epoch, latest allocation and unresolved custody. It returns either the same original open shift or confirmation that this exact shift is already closed with no other device shift open. It performs no financial mutation and reserves no numbers.

The server signs a fresh challenge-bound `native-offline-continuation` result with `purpose: prepare-next`, original scope, original seal hash and the retained or cleared shift ID. Android verifies the pinned signature, native monotonic round-trip freshness and all scope fields. It does not accept browser clock readings or a caller-selected replacement shift.

## Durable device update

SQLite v6 appends an immutable archive of the exact old preparation, the signed result and the exact next preparation before changing the encrypted session. The session update compares the expected old preparation and retains current cookies/access records. A process interrupted between these stores resumes the saved original transition; it cannot replace a new allocation, shift or account.

For a same-open shift the old reservation is cleared while the shift is retained. For an already-closed original shift, its shift/opening request is cleared as well. The separate existing preparation flow remains necessary to obtain a new allocation. No automatic sale permission or shift opening follows the handoff.

An explicit later check can confirm that the retained original shift has since closed. It appends separate immutable closure evidence before another exact session update. The first transition is never rewritten. A newer reservation cannot be cleared by this retry.

## Operator limits

**Closing the Android-bound cash drawer is not implemented in this version.** A separate browser device cannot substitute for the Android binding. This increment supports continuation on the same open shift and recognizes an original shift already closed on the server; it is not a complete cashier next-shift workflow. Counted cash, durable close request and recovery after a lost response remain required.

Historical pending/resolved payment detail can be unlocked through its exact original intent ID and original shift PIN scope. Unlocking a newer shift does not authorize older payment details. This does not yet provide a separate historical-receipt unlock across shifts.

After interruption, read saved status before another explicit consented action. A completed result means the setup handoff was saved; it does not mean a new allocation was prepared, a drawer was closed or sales were enabled. The interface retains this result across its parent refresh and clears sensitive state on lock/account changes.

## Verification boundary

Isolated tests cover real PostgreSQL locking, real P256 protocol signatures, Android SQLite/Keystore persistence, interruption/retry, historical holds and strict UI bridge contracts. Private verification records contain exact runs and failures. These tests do not establish physical printer delivery, actual cash handling, complete two-device native/server acceptance or a whole-platform security audit.
