# Frozen payment review and signed outcome recovery

Candidate implementation, not a customer release. Offline selling remains disabled, and SQL017–021 have not been applied live. Native freeze, server registration and manager return/void attestations, device-authenticated retrieval, and native signed-result acceptance are implemented as candidates. The manager decision write route remains outside the hosted release allowlist; branch resolution policy defaults to false. These changes do not enable customer collection or issuance.

## Why this state exists

A saved payment may have been collected when offline permission expires. The cashier must not create a second payment, backdate an invoice, renew the old permission, or label returned funds as never collected. **Permanently freeze payment** records the original unresolved intent for manager review. It does not itself establish whether payment was collected or returned.

The cashier sees the original planned basket/tender and confirms this irreversible action for that exact intent and request. Creating the freeze requires the original actor, counter, allocation and staff PIN. Permission expiry and the sale release gate do not prevent preserving evidence, but failed staff/PIN authorization still does. A persistent clock anomaly can prevent the PIN check; no clock/PIN bypass has been added. Staff/device-loss recovery remains separate.

## Durable native custody

SQLite version 4 added `offline_intent_freezes` and immutable-row/insert guards. Version 5 adds `offline_payment_results`, `offline_payment_statuses` and `offline_payment_conflicts` without rewriting earlier data. Versions 1–4 upgrade additively to version 5. Installation identity, device fingerprint, original requests/freezes, receipts, acknowledgements, outbox, allocations, clocks, chain, cancellations, seals and upload exceptions are retained. Historical-schema fixture migration is distinct from installing an archived APK and upgrading it in place.

The freeze operation verifies the exact stored request/hash, signed historical bundle, original order/document IDs and calculation. Under the journal monitor and one SQLite write transaction it reads the chain head, creates and signs `offline-payment-freeze`, and commits the immutable proof before reporting success. It binds the original scope, basket/hash, bundle hashes, IDs, original intent creation time and observed chain head. The optional clock observation is diagnostic; unavailable means null. Freezing does not advance the authority clock, create a financial document, consume a number or budget, or add a chain event.

The original freeze cannot be updated, deleted or replaced. SQLite triggers permanently prevent receipt insertion, receipt assignment and no-money cancellation for that frozen intent, including after a manager outcome is accepted. A race between commit and freeze can have only one winner. Signing/storage failure rolls back without deleting the original intent. Exact replay retains the first proof/signature. Readback verifies proof signature/hash, original request and historical scope.

## Submission and outcome acceptance

`freezePaymentIntentForManager({intentId})` accepts no price, manager approval, timestamp or raw proof from JavaScript. It returns a display summary with state `frozen_for_manager`, confirmation/cancellation disabled, reason `payment_frozen` and `managerReview:{freezeId,proofSha256,status:'saved_locally'}`. The signed proof stays native.

`syncFrozenPayment({intentId})` submits the original immutable freeze with a newly signed random challenge. It accepts no URL, response envelope or outcome from the browser. Historical transport sends no cookie and adopts no response cookie. Device-key proof can recover custody after logout, actor revocation, selling-permission expiry or disabled issuance flags; it grants no manager authority. Original staff scope and PIN are still required to display payment/customer details. If transport finishes after the app locks or backgrounds, durable custody can succeed while the display call refuses to reveal details; reading the original intent later recovers the result.

The engine reconstructs the original binding from the retained signed authority and enrolled local key, verifies the stored freeze and recalculates its exact historical request. It independently verifies the pinned-server status signature, fresh challenge, freeze hash and scope, and then the separate terminal signature. Only `funds_returned` and `payment_voided` with `replacement:null` are supported. The terminal result must match all original IDs, request/bundle hashes and scope. Card void is limited to an original valid card-only plan. Unsupported historical buyer text cannot be cleared by this path. No expiry or current-session check substitutes for these historical checks.

One transaction stores the first complete signed result and its challenge-bound response. A retry with the same canonical result and a new ECDSA signature keeps the first stored response. The terminal intent state is `manager_resolved`, with:

```text
managerReview:{freezeId,proofSha256,status:'accepted_on_device',
 resolutionId,decision:'funds_returned'|'payment_voided',resolvedAt}
```

`resolvedAt` is the server's recorded attestation time. It is not a device receipt timestamp or proof that a payment provider completed an operation. Confirmation and cancellation remain disabled, `receipt` remains null, and `reasonCode` is null. No receipt, invoice, ACK, payment/refund ledger entry, clock reset, authority renewal or processor action is created by native acceptance.

Every exclusion from the unresolved-intent hold re-verifies the stored result, original device proof and historical calculation. A row's mere presence never clears a hold. Only that exact resolved intent is excluded. A signed `conflict`, `already_issued`, or different valid terminal result preserves immutable conflict evidence and keeps the intent held, including after an earlier result was accepted. Original results are retained. Unresolved siblings remain held; a newly learned conflict also prevents an already-started later intent from committing. A stale pending response never regresses an accepted outcome.

## Truthful display and uncertain responses

A frozen display distinguishes `saved_locally`, `pending` and `conflict`. Pending does not distinguish an undecided manager case from an interrupted server signature attachment. It does not mean an external return has completed. Invalid signatures, wrong challenge/scope/hash, unknown outcomes and malformed responses are rejected without treating unauthenticated data as a permanent conflict. Lost transport/storage responses leave the original proof for exact recovery; they do not cause a second charge or a replacement intent.

The counter shows a manager result only after durable local acceptance and verification. `getCheckoutState` provides `lastResolvedIntentId` and `lastResolvedIntent` for the current original allocation after staff unlock, so restart does not hide the completed review when the pending intent clears. Conservative pending/receipt references remain available while locked or signed out; customer/basket/result details remain behind original scope and PIN. Background/lock lifecycle checks clear sensitive displays and consent.

The UI distinguishes planned tender, manager-attested external return/void, and a tax invoice. It must never label an attestation as “paid and billed.” There is no local unfreeze action. A conflict cannot be dismissed by retrying or overwriting the original proof.

## Server and operational boundaries

The server verifies enrolled device signatures, original bundle/scope and historical arithmetic before registration. SQL018 serializes shared intent/order/document claims and retains conflicts; SQL019 quarantines unchanged unsupported historical evidence; SQL020 retains current-manager-authorized return/void decisions and the first server signature; SQL021 supplies scoped historical retrieval. A device proof cannot authorize a manager decision. A signing interruption can finish attachment of the already committed immutable decision without allocating a new invoice or granting new authority.

A manager first completes any physical return or external terminal void and records its evidence through the separately gated review flow. The app does not send funds, refund a processor transaction, void a terminal authorization or confirm external settlement. An uncertain external outcome remains unresolved. The current-time replacement invoice remains a separate design requiring accounting decisions; this candidate cannot use an ordinary online sale to reprice or replace the frozen basket.

A verified result permits only the resolved intent's hold to clear. Authority finishing, remaining receipts/ACKs, other conflicts, shift closure and subsequent allocation still require their existing checks and explicit actions. Returning funds never re-enables an expired grant. Controlled PIN/clock/staff/device-loss recovery, physical-device durability/full-storage/power-loss tests, printer support, supervised two-device native/server acceptance, manager evidence/training rules, server deployment/configuration and explicit release approval remain required.

Test and independent-review evidence are recorded privately against the candidate source. Tests and synthetic fixtures do not enable release flags or certify physical POS hardware. No customer APK is distributed by this work.
