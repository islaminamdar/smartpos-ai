# Permanent payment freeze

Candidate implementation, not a customer release. Offline selling remains disabled. SQL017 is not applied live. Manager submission/decisions, server claims and signed result delivery are pending; the server helper added with this candidate only verifies evidence and performs a historical read.

## Why this state exists

A saved payment may have been collected when offline permission expires. The cashier must not create a second payment, backdate an invoice, renew the old permission, or label returned funds as never collected. **Permanently freeze payment** records the original unresolved intent for a later manager decision. It does not itself establish whether payment was collected or returned.

The cashier sees the original planned basket/tender and confirms this irreversible action for that exact intent and request. Native code requires the original actor, counter, allocation and staff PIN. Permission expiry and the sale release gate do not prevent preserving evidence, but a failed staff/PIN authorization still does. In particular a persistent clock anomaly can prevent the PIN check; no clock/PIN bypass has been added. Staff/device-loss recovery remains separate.

## Durable native operation

SQLite version 4 adds `offline_intent_freezes` and immutable-row/insert guards. Versions 1, 2 and 3 upgrade additively. Existing ledger tables, installation, device fingerprint, receipts, acknowledgements, outbox, allocations, clocks, chain, cancellations, seals and upload exceptions are retained.

The native engine verifies the exact stored request/hash, signed historical bundle, original order/document IDs and calculation. Under the journal monitor and one SQLite write transaction it reads the chain head, creates and signs `offline-payment-freeze`, and commits the immutable proof before exposing success. The proof binds the original scope, basket/hash, bundle hashes, IDs, original intent creation time, and observed chain head. An optional clock observation is diagnostic: unavailable means null. Neither it nor a successful freeze advances/reset the authority clock, creates a financial document, consumes a reserved number, changes gross budget, or adds an offline chain event.

The freeze table cannot be updated, deleted or replaced. SQLite triggers independently prevent receipt insertion, receipt assignment and no-money cancellation for a frozen intent. Inserting a freeze for a committed/cancelled intent is rejected. A race between commit and freeze can have only one winner. Signing/storage failure rolls back the freeze without deleting the original intent. Exact replay returns the first stored proof/signature and still requires scope/PIN at the bridge. Readback verifies the proof signature/hash and matches it to the original request/scope before displaying its summary.

`freezePaymentIntentForManager({intentId})` accepts no price, reason, timestamp, approval or raw proof from JavaScript. It returns the normal native intent display with state `frozen_for_manager`, both actions disabled, reason `payment_frozen`, and `managerReview:{freezeId,proofSha256,status:'saved_locally'}`. The signed proof stays native. Other intent shapes are unchanged. Frozen intents remain globally unresolved: further sale, allocation finishing and account/setup changes remain blocked. There is no local unfreeze action.

## Truthful display and failure recovery

The UI distinguishes the original planned tender from evidence of collection. It says **Saved locally · not sent**, with no tax invoice or manager decision. The original freeze reference remains visible only with authorized payment details; its technical proof fingerprint is under Support details. Native lock/background behavior clears details and consent, including expanded support content.

A lost result is recovered by reading the same intent. It cannot become a second intent or silently repeat a charge. A frozen response cannot be accepted for a different request, even if its intent ID matches. A frozen payment never exposes confirmation or no-money cancellation controls. Older receipts are not shown beside the unresolved payment as if they billed it.

## Server boundary and next implementation

`verifyOfflinePaymentFreeze` validates the signed freeze and separate device-signed resolution query against enrolled historical keys, original bundle/scope and exact historical basket arithmetic. Its immutable typed result is reconciliation-only. It does not prove the device physically froze, that money was collected, that IDs are unused, or that a manager approved a decision. Chain-head evidence may be ahead of server custody when earlier receipts are queued.

No HTTP endpoint or SQL018 write accepts these proofs yet. Before submission is enabled, implement shared intent/order claims and import/decision serialization, current manager authorization, reviewed return/void evidence, signing-attachment interruption recovery, and pinned native outcome readback. A separate current-time invoice outcome requires the accounting decisions in `docs/contracts/20261016-offline-payment-resolution.md`. Never treat a local freeze, read-only validator result, or accepted upload as a completed manager resolution.

Testing and independent review evidence are retained privately with the candidate commit. Full two-device native/server acceptance, physical printers, manager training and release approval remain separate.
