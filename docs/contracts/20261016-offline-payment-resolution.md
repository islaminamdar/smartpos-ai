# Expired offline payment intent: manager resolution candidate

Status: design candidate, 2026-10-16. No migration, route, native method, accounting entry, or release flag described here is implemented by this document. Existing customer sale issuance remains subject to its release gates. This is an engineering design, not a conclusion about tax treatment; the current-time invoice option needs the business/accountant decision identified below.

Implementation checkpoint: native permanent freeze is implemented in candidate SQLite v4. Candidate SQL018 now implements registration/claims/conflicts and import/online collision guards, with a service that signs nonterminal registration status. The remaining decision/result tables, manager writers, HTTP/native transport and terminal result acceptance below are still design work. See [implemented registration scope](20261016-offline-payment-registration.md). Neither SQL017 nor SQL018 is enabled live.

## Problem and existing boundaries

A native payment intent freezes a basket and its planned cash/card tender before the cashier confirms collection. `NativeCheckoutEngine.commitPaymentIntent` then checks the current clock and authority budget inside SQLite before creating the invoice. If permission expires after money was collected, this check correctly refuses issuance. Restart does not establish whether money was collected. The existing `cancelUncollectedIntent` is an explicit declaration that no payment was collected; using it to clear a returned or voided payment would misstate history.

The inspected implementation stores immutable `intents.request_json/request_hash`, stable `offline_intent_context.order_id/document_id/authority_id`, and a separate cancellation record. `hasUncertain` blocks another sale and `sealAuthority` until an unresolved intent is addressed. SQL017 imports actual already-issued invoices independently of current membership and upload-time expiry. Import takes the order request advisory lock (seed 0), then device, shift, key epoch, and authority row locks; existing committed receipts replay before new issuance checks. It creates actual orders, lines, payments, documents, provenance, and the first ACK atomically. Expiry is not a reason to reject an invoice genuinely issued within its authority window.

This design handles **an intent with no local committed receipt**. It must not replace, cancel, or rewrite an existing invoice. Neither local time rollback, a new allocation, a fabricated old issue time, nor a retried card charge is a resolution.

## Decisions and scope

First implementation: permanently freeze the intent, register its authenticated evidence, let a current branch manager resolve it as either **funds returned** or **card authorization voided**, and deliver a signed terminal outcome to the original device. Partial returns, uncertain settlements, mixed return/void combinations, different cash drawers, missing device keys, and contradictory receipts remain visibly unresolved in this first slice.

Second implementation, separately gated: record a current-time invoice for funds the merchant confirms it retains, using the original frozen basket and explicit historical linkage. Do not route this through the ordinary online order endpoint, which rechecks current products and can reprice the basket. Do not deploy that outcome before its accounting and operational decisions are settled.

A manager attestation is evidence of an assertion, not payment-processor verification. Neither route charges a card, refunds a processor payment, sends money, or claims the app performed those actions. The manager completes any external return/void and then records its evidence. An uncertain external outcome stays unresolved; there is no automatic retry of that external action.

## Native freeze: the prerequisite

Add SQLite schema version 4, preserving all version 1–3 custody. Add append-only tables:

- `offline_intent_freezes(intent_id PRIMARY KEY REFERENCES intents, freeze_id UNIQUE, proof_payload_sha256, proof_envelope, frozen_observation_json)`.
- `offline_intent_resolution_results(intent_id PRIMARY KEY REFERENCES offline_intent_freezes, resolution_id UNIQUE, result_payload_sha256, result_envelope, replacement_document_json NULL)`.
- `offline_intent_resolution_conflicts(intent_id, evidence_sha256, evidence_json, UNIQUE(intent_id,evidence_sha256))` for durable contradictions. A conflict is not a terminal result.

`freezePaymentIntentForManager(intentId)` runs under the existing journal monitor and one SQLite write transaction. Require the same signed-in local staff scope and native PIN for this first slice. Expired selling permission is allowed; no advancing/renewing of its clock is performed. Read and hash the exact stored request, verify the stored signed bundle and binding, and obtain the original context IDs. Reject a committed or cancelled intent. If already frozen, return the original proof without regenerating any payload fields. Read the persisted device chain head and original intent creation time. Sign, insert, and commit the freeze before returning anything to the bridge or making a network request. Signing/storage failure leaves no advertised freeze.

The freeze cannot be removed or undone. Add native checks **and SQLite triggers** so neither `receipts` insertion/`intents.receipt_id` assignment nor an `offline_intent_cancellations` insertion can occur for a frozen intent. Exact replay of an already committed receipt remains available; freeze and commit racing locally produce exactly one winner. `beginPaymentIntent` retries for a frozen ID return a frozen state, never restart collection. `hasUncertain` includes a frozen intent until a verified terminal result is persisted. Clock failure must not require a fabricated timestamp to freeze: an observation is diagnostic only and may be unavailable.

Use a dedicated native operation; the browser supplies only `intentId`, never basket, order/document IDs, manager approval, or proof bytes to sign. Local PIN cannot confer server manager authority. A signed-out or removed cashier who cannot unlock needs a later explicitly designed online manager-assisted native access path; do not weaken the initial scope check or clear custody to work around this.

## Canonical contracts

All objects are strict: unknown fields fail. Use the existing `pos-signed-v1` envelope, canonical UTF-8, P-256 DER signatures, pinned server trust, lowercase UUID/SHA-256, safe integers, and exact UTC millisecond timestamps. Limit any decoded signed payload to 1 MiB; bound outer transport separately. Arrays retain their order. Reject schema normalization rather than silently trim signed fields. ECDSA signature bytes are not the idempotency identity; canonical payload hashes are.

`IntentRequest` is the existing exact native request:

```text
{authorityId, serviceType, customer,
 lines:[{productId,quantityMilli}],
 cashTenderedFils, recordedCardFils, presentedTotalFils}
```

Use the existing customer, line, quantity, service, and money bounds, at most 200 unique product IDs. Recompute with `offline-line-v1` and the stored signed snapshot. `requestSha256` hashes the exact canonical `IntentRequest`. Planned tender is not proof of actual collection. Actual collected net cash excludes change handed back; do not equate the cash note tendered with cash revenue.

Device-signed freeze payload:

```text
{kind:'offline-payment-freeze',schemaVersion:1,
 freezeId,paymentIntentId,orderId,documentId,
 organizationId,branchId,deviceId,actorId,shiftId,keyEpoch,deviceKeySha256,
 authorityId,authoritySha256,snapshotSha256,
 requestSha256,request:IntentRequest,intentCreatedAt,
 chainHead:{sequence,eventSha256},
 observation:null|{bootId,elapsedRealtimeMs,wallTimeMs},
 declaration:'local-intent-unissued-and-permanently-frozen'}
```

`sequence` is 0..MAX_SAFE_INTEGER and `eventSha256` is null exactly when sequence is zero. Native `intentCreatedAt` is retained as evidence, not authoritative issue time. Observation uses native boot UUID, nonnegative safe elapsed time, wall time 0..253402300799999; it grants no permission. The freeze neither advances the invoice chain nor consumes an invoice number. The server must obtain the enrolled device key from stored authority custody, never the submitted proof.

For registration and retrieval, a **separate**, freshly generated device-signed query wraps the immutable freeze identity:

```text
{kind:'offline-payment-resolution-query',schemaVersion:1,
 authorityId,keyEpoch,deviceId,freezeId,freezeSha256,challenge}
```

`challenge` is 64 lowercase hex characters. No client wall-clock freshness requirement: recovery must survive expiry and clock failure. The query challenge is matched only to the current outstanding native request. Reusing a captured query can recover the same device's immutable result, never change state or authorize selling. Native generates a new challenge on each retry while retaining the original freeze proof.

Manager decision request, separate from the device proof:

```text
{requestId,freezeId,freezeSha256,decision:'funds_returned'|'payment_voided',
 reason,evidence:[{method:'cash'|'card',amountFils,
 paymentObservedAt,completedAt,reference,note}],
 cashDrawerShiftId:null|UUID}
```

`reason` 1..240 characters; `reference` 1..120; `note` 1..400. Timestamps are manager-attested observed times, may not be future, and `completedAt >= paymentObservedAt`; server also records its independent acceptance time. Amounts are positive fils. Require one evidence leg for each planned nonzero payment method, in fixed cash-then-card order, with exact recomputed net payment amounts. `funds_returned` confirms each leg was actually collected and fully returned. `payment_voided` is card-only and confirms an authorization was fully voided before settlement; for that decision, `paymentObservedAt` is the authorization observation. For a return it is the collection observation. Display the corresponding label explicitly; do not describe an authorization as settled funds. Do not misdescribe a settled-card refund as an authorization void. Cash returns must identify the original open shift/drawer; other-drawer transfers need a later explicit two-drawer accounting contract. No PAN, CVV, account password, or unnecessary customer identity in evidence.

A successful terminal **server-signed** payload is:

```text
{kind:'offline-payment-resolution',schemaVersion:1,
 purpose:'reconciliation-only',resolutionId,requestId,freezeId,freezeSha256,
 paymentIntentId,requestSha256,orderId,documentId,
 organizationId,branchId,deviceId,actorId,shiftId,keyEpoch,authorityId,
 authoritySha256,snapshotSha256,managerActorId,
 decision:'funds_returned'|'payment_voided'|'current_time_invoice',
 evidenceSha256,resolvedAt,
 replacement:null|{documentSha256,documentId,orderId,documentNumber,issuedAt}}
```

The first two decisions require `replacement:null`. The third is reserved for phase two and must be rejected by phase-one parsers. Original actor and approving manager are distinct fields. Persist the first valid signed result; retry with the same payload and a different signature returns that original result.

Every device response also includes a fresh signed handoff:

```text
{kind:'native-payment-resolution-status',schemaVersion:1,
 purpose:'reconciliation-only',challenge,serverTimeMs,
 authorityId,keyEpoch,deviceId,freezeId,freezeSha256,
 state:'pending'|'resolved'|'already_issued'|'conflict',
 resolutionSha256:null|HASH,issuanceSha256:null|HASH}
```

`serverTimeMs` is 0..253402300799999. Exactly the applicable terminal hash is populated; `pending`/`conflict` have both null. This handoff cannot pass `verifyPrepared`, reset a financial clock, install a selling grant, or enable checkout. Response is a strict discriminated union `{handoff,resolutionEnvelope:null|SignedEnvelope,receipt:null|FiscalDocument,acknowledgement:null|SignedEnvelope}`: resolved return/void has only its resolution envelope; resolved replacement also has its exact document; already-issued has the exact original document and offline ACK, no resolution envelope. Pending/conflict carry no receipt or ACK. Conflict detail requires the separately authenticated manager view.

## Server migration and trust boundary

Use **new** migration `20261016001800_pos_offline_payment_resolution.sql`. SQL017 is a frozen candidate and has **not** been applied live; preserve it unchanged. Apply additive018 only after017 in disposable test databases for this work. Do not mutate or reapply001–016. Do not install the new endpoint before the import/online collision guards in this migration are present. Add private RLS-enabled tables, revoke all direct access from PUBLIC/anon/authenticated/service_role, and expose only selected SECURITY DEFINER RPCs to service_role with empty search_path:

- `pos_offline_intent_claims`: globally unique payment intent ID, order ID and document ID; authority/key epoch/scope; type `historical_receipt` or `frozen_intent`; immutable claim payload/hash. Backfill existing SQL017 receipts atomically during migration. Abort the migration on any inconsistency.
- `pos_offline_payment_freezes`: freeze ID primary key, intent ID unique, exact proof/envelope/hash, frozen request, original IDs/scope, registered-at. Append-only; FK to the immutable frozen claim.
- `pos_offline_payment_decisions`: resolution ID primary key, freeze ID unique, manager request ID unique, actor, full immutable request/hash, outcome, evidence, server accepted-at, exact unsigned resolution payload and nullable replacement linkage. Append-only.
- `pos_offline_payment_result_signatures`: resolution ID primary key, canonical result hash and first server envelope. Append-only, one-to-one with decisions; signing may finish after the decision transaction.
- `pos_offline_payment_conflicts`: immutable contradictory authenticated evidence, deduplicated by scope/code/payload hash. No generic auto-dismiss or auto-unblock.

These tables are not overloads of `pos_request_cancellations` or `pos_offline_exception_resolutions`. The former means an online request cancellation; the latter currently requires a real offline issuance FK and automatically resolves only matching chain gaps. Payment return/void is neither of those events.

RPC interfaces:

| RPC | Purpose and accepted trusted inputs |
|---|---|
| `pos_offline_payment_freeze(p_envelope jsonb)` | After service device-signature/schema verification: atomically register exact freeze or return authoritative existing invoice/conflict. No manager or current cashier membership required to preserve historical evidence. |
| `pos_offline_payment_case(p_freeze uuid)` | Service-only read of frozen historical scope, evidence, conflict/decision and signature state. HTTP caller authorization is mandatory before returning it. |
| `pos_offline_payment_decide(p_actor uuid,p_request jsonb)` | Explicit current manager identity derived by server authentication, never from JSON. Recheck manager under authority15 lock. Apply full return/void exactly once; return durable unsigned result or original decision. |
| `pos_offline_payment_attach(p_resolution uuid,p_envelope jsonb)` | Attach only a server-signed payload that exactly matches the committed decision; cache the first envelope. No decision changes. |

Server crypto is verified before the corresponding trusted write RPC. SQL independently rebinds every authority/key/scope/request/hash, recomputes amounts from its snapshot, rejects mismatched canonical input, and enforces identity and accounting constraints. A current member cannot invoke trusted JSON writes directly. Invalid signatures never create a case or quarantine anything.

### Serialization, delayed imports and online collisions

Reserve a new advisory namespace, candidate seed **31**, after checking the migration registry for conflicts. Required order for freeze/import/decision writers: current-manager authority15 shared lock when applicable → payment-intent advisory31 → original order request advisory0 → receipt configuration lock if allocating a replacement → device row → shift row → key epoch row → authority row → case/decision rows → document counter if needed. Import and freeze do not acquire current actor membership. Do not acquire authority15 after a device/shift lock. Existing online issue uses order0 before device/shift; existing close uses device before shift. No path may acquire advisory31 after holding order0. A complete lock-order audit and actual two-session tests are required before freezing the migration.

Update SQL017's import implementation through `CREATE OR REPLACE` in migration018 to participate in the shared intent lock/claim. A committed exact receipt still returns its **original** ACK first. New imports check immutable claims: a different intent/order/document scope is a durable collision; a matching frozen claim is a durable `intent_frozen` conflict, never an invoice. Claim insertion and original financial import must be in the same transaction/subtransaction so partial failure leaves neither a ghost claim nor a receipt. Check both existing offline receipts and ordinary orders/documents/cancellation records, including all alternate matching IDs.

Registration under the same locks: if a matching invoice already committed, return original receipt/ACK and record the contradictory freeze evidence; do not approve return/void through this flow. If no invoice exists, insert the frozen claim and case atomically. A freeze accepted first prevents later receipt creation, even if an older client submits a correctly signed historical bill. Such a contradiction stays unresolved for operator investigation; do not drop its signed evidence, ACK it as a sale, or silently dismiss it when the manager later decides the intent. A device clone/rollback may contradict a legitimate freeze; signatures do not prove physical device exclusivity.

Add a private guard for the authoritative online order writer and an insert guard on `pos_orders` so frozen original order IDs cannot be reused through another endpoint. A replacement writer needs an explicit private, immutable provenance row matching its exact IDs/scope before insert; no GUC/client-supplied boolean bypass. Document identity uniqueness plus guard checks protect the original document ID as well. Root-level helpers must not be left callable by authenticated roles. The manager decision and import contend on the same intent/order/device locks, not merely on independently named request IDs.

Extend shift-close guard to block any registered freeze without a decision, incomplete signature attachment if delivery is required by policy, and any unresolved contradiction. Device sealing must continue to require the receipt chain, but is not an escape from frozen intents: update `pos_offline_seal` to reject pending cases/conflicts. An exact already-committed seal remains recoverable. Do not reject already-sealed matching receipt retries or erase an older seal if contradictory late evidence arrives; block close/renewal via explicit unresolved state. New-grant checks must include this state independently of the original epoch `blocked` bit, since SQL017 recomputes that bit from its own exceptions.

### Idempotency and signing interruption

For registration compare original freeze payload hash and all claimed IDs, not the DER signature. Same freeze ID/intent with changed request, head, or scope is a conflict; never replace the record. For manager decisions compare manager actor plus full request body under requestId; changed decision/evidence/ID conflicts even if amounts match. Different requestIds cannot create two terminal outcomes for the same freeze.

The decision transaction commits the immutable unsigned result and accounting evidence **before** signing. The service then signs and calls attach; attach verifies exact decoded payload/hash and stores the first signature. If signing/attachment/response delivery fails, the case is already decided; return an explicit retryable delivery failure, never invite a second refund. Device query or exact manager retry may finish attaching the existing result without reapplying the decision. Device read recovery requires only its historical possession proof, even if the manager/cashier is later revoked. Native remains frozen until it verifies and durably stores the signed result. Server decision completion and device receipt of that result are separate states.

No signature from a removed manager is accepted as authorization for a *new* decision. Current authenticated managers may read prior decisions; an old session cannot submit a new result after revocation. Exact original server outcomes remain recoverable via the device channel.

## HTTP and operational gates

Candidate endpoints:

- `POST /api/pos/offline/payment-freeze`: `{freezeEnvelope,queryEnvelope}`, body ≤1,420,000 bytes. Verify stored device key and both proof scopes; register immutable evidence, return signed status union.
- `POST /api/pos/offline/payment-resolution`: `{queryEnvelope}`, body ≤16,384 bytes. Device-authenticated retrieval/attachment recovery only.
- `GET /api/pos/manager/offline-payments?branchId=...&cursor=...`: current authenticated branch manager; bounded 50-row summaries. Full evidence detail requires the same authorization. No public case lookup by UUID.
- `POST /api/pos/manager/offline-payments/resolve`: the strict manager decision request above, body ≤16,384 bytes. Expected website Origin, current manager/owner branch membership, recent server-authenticated manager action confirmation, and dedicated `POS_OFFLINE_PAYMENT_RESOLUTION_ENABLED=true` plus branch resolution policy (default false). An existing cookie or local PIN alone is not fresh manager confirmation; implement a short-lived server-side recent-auth capability or explicitly keep this route disabled until that mechanism exists.

Historical two device endpoints use the existing offline source limiter before body parsing/DB lookup; no Cookie sent/adopted on native transport. Exact release-route allowlist entries only. They stay reachable with issuance/live/pilot flags disabled or original actor/device revoked. They cannot allocate grants or accept decisions. Result-signature recovery is allowed when the resolution feature is paused. Manager return/void may operate while selling is disabled, under its separate resolution gate; issuing a new replacement invoice requires the additional live-sales/branch fiscal configuration gates.

All responses are private/no-store; errors expose stable bounded codes, not raw SQL. Device query response bound 1,420,000 bytes accommodates one fiscal document plus short ACK/result/handoff envelopes; measure the worst valid fixture and reject before oversized serialization. Do not canonicalize a transport wrapper containing several individually bounded payloads as if it were one signed payload. Manager list/read limits and independent request rate limits must be enforced. Upload notes are plain text, escaped in UI, never instructions.

## Accounting for first outcomes

An unissued intent has no `pos_payments` revenue entry. A complete same-drawer cash collection followed by an equal net return has zero net drawer effect. Keep both attestations in the resolution ledger and display them in the shift audit; do not create a fake sale, negative invoice, `refund.full`, or a standalone cash-out that would subtract money never booked as cash-in. Card void is not card revenue and is not a refund of an existing POS invoice.

Require exact full planned net tender amounts for this first slice. For a cash tender of AED100 against an AED80 basket with AED20 change, the funds retained/returned are AED80; original AED100 tender and AED20 change remain visible in the frozen quote. If change was never given, actual retained funds differ from the planned amount: keep the case unresolved for expanded evidence handling. Partial collection, partial refund, tender switching, different drawers, or an uncertain processor state must not be coerced into these terminal choices.

For every outcome, the audit separates original intent time, manager-attested physical event times, server decision time and native acknowledgement time. Customer-facing acknowledgement says “Payment returned” or “Card authorization void recorded”, not “Tax credit note”, because this flow has no original invoice. If an original invoice is found, use its existing invoice/refund route after reconciliation, rather than the unissued-intent flow.

## Second phase: a current-time invoice for retained funds

Use a separate candidate migration `20261016001900_pos_offline_payment_replacement.sql` and explicit decision `current_time_invoice`; do not quietly enable it by expanding an enum. Add `pos_offline_payment_invoice(p_actor,p_request)` plus immutable replacement provenance and result attachment. The request binds freeze/hash, exact confirmed collected net tender evidence, current reviewed merchant profile ID, and original request hash. For the first version retain original basket, customer and tender exactly; any needed customer correction is an explicit separately audited amendment feature, not an unrecorded edit. Manager preview shows the exact proposed invoice before confirmation.

Recompute original product names, units, quantities, unit prices and tax rates from the stored signed snapshot using `offline-line-v1`. Do not consult current product availability/price to replace those values. Verify the confirmed retained net tender equals that recomputed total; no charge attempt occurs. The invoice uses current server issue time, the next **unreserved** branch tax-invoice number from the normal counter, current explicitly reviewed merchant profile, and manager as issuing actor. Store original cashier, snapshot/profile versions, intent time and historical basket hashes in private immutable provenance. Existing product foreign keys still apply: an inactive product may be used from its immutable snapshot, but a physically missing referenced row blocks posting for explicit support handling. Never silently recreate a product, substitute another ID, or weaken referential integrity to post the invoice. If legal entity/TRN/tax treatment has changed or the current merchant profile is inconsistent with the frozen tax calculation, block for accounting review; do not automatically modify either value.

Use the original stable `orderId` and `documentId` from the freeze for this first issuance, with private linkage stating it was issued by manager resolution. There was no original invoice number: do not invent an “old invoice”. Preserve the expired authority's unused reserved numbers as gaps; never issue from that old range, consume its quota, advance its offline sequence, or change its expiry. Current-time issue time must be assigned in the financial transaction, not supplied by browser/native evidence or cached preview. Reserve number, insert immutable provenance, actual order/lines/payments/document and unsigned terminal result atomically; rollback all of them together on failure.

Attribute payment to the original still-open source device/shift because that drawer retained the funds, while `actorId/created_by` identifies the approving manager. This requires an explicit dedicated manager writer: existing online own-shift rules are deliberately not reused/bypassed through spoofed `auth.uid`. Current manager access is mandatory; removal of the original cashier/device does not transfer the drawer. If the original shift has closed or money moved to another drawer, reject and require a separately designed accounting transfer. A current manager may supervise this historical drawer without being its original opener; record their approving session/device separately in the decision audit.

This adds exactly one normal `pos_payments` entry per tender so current shift cash expectation includes retained funds once. Dedicated return/void evidence must not previously have completed that intent. Add immutable-row protection for replacement orders/lines/payments/documents, and adjust reports to distinguish **current issue date** from historical collection evidence. Existing full-refund logic must be tested against a replacement invoice, with no double subtraction of historical evidence.

Insert private replacement provenance before `pos_documents`. Extend the kitchen projection trigger to suppress these already-handled baskets explicitly, just as historical imports are suppressed; do not enqueue a new preparation ticket. Return the exact schema1 invoice plus its hash in the signed resolution. Native stores it in a separate server-resolution document table, not as a device-signed offline sale or an offline ACK, and never places it in the offline import outbox. Existing strict fiscal document schema remains unchanged; provenance is separately signed/audited and displayed with the receipt.

This is a new invoice at current time for a previously unissued basket, not a backdated offline import. If the accountant requires a different document/tax-point treatment, implement that explicit contract before enabling the outcome.

## Counter and manager experience

Counter state distinguishes `payment_confirmation_required`, `frozen_for_manager`, `manager_review_pending`, `resolution_delivery_pending`, `resolved_funds_returned`, `resolved_payment_voided`, `resolved_current_time_invoice`, and `resolution_conflict`. Amount, tender, original basket, intent/reference ID, and expiry reason remain visible behind local staff unlock. Never show “Paid and billed” without a committed original invoice or verified signed replacement document.

When the cashier reports money collected or uncertain after expiry: show “Do not collect again. Keep this payment for manager review.” Explain irreversible freezing, obtain native PIN, commit freeze, then upload. A network failure shows “Saved on this device; waiting to send”. A QR/reference can identify the case but contains no credentials, raw customer data, or bearer approval token. Native historical background retrieval may store results while locked; revealing basket/customer details still requires authorized local access.

Manager view shows original cashier/counter/shift, expiry, frozen quote and tender, collected/returned/void evidence, import conflicts and whether a decision is already complete. Choices describe completed real-world actions, not promises to refund later. Unknown payment status has a “Keep pending” action that records a note without terminal resolution. Confirmation repeats the full outcome/amount/drawer and warns that it will be retained. Lost response shows “Checking saved decision”, not another refund button.

After verified result storage, preserve the intent and freeze. Allow explicit authority finishing only when all other receipts/ACKs/conflicts are reconciled; do not automatically grant a new allocation or close the shift. Show a distinguishable payment acknowledgement or exact current-time invoice for printing. The expiry recovery decision never turns an expired grant back on.

## Required verification and implementation order

1. Freeze contracts and business choices below. Add shared Java/TypeScript canonical fixtures for each proof/status/result and invalid combination. Keep all feature flags false.
2. Implement SQLite v4 migration, freeze proof/signature persistence and commit/cancel triggers. Test versions1/2/3→4 preserve keys, receipts, ACKs, bundles, seals and exceptions; force-stop/full-disk/signature failure before/after freeze; duplicate freeze; commit-vs-freeze and cancel-vs-freeze races; hostile direct SQLite writes; expired/rolled-back clock with null observation.
3. Implement SQL018 private schema, shared locks/claims and guarded import/online paths first. Backfill/upgrade disposable databases containing existing receipts, seals, cancelled online requests, refunds and exceptions. Test all RPC/table/helper ACLs and canonical scope/arithmetic checks.
4. Implement service crypto, device routes, manager authentication/confirmation and return/void decision→sign→attach pipeline. Use real keys and actual disposable SQL; prove native capability/signatures cannot authorize manager decisions. Run Semgrep and independently review findings.
5. Exercise real PostgreSQL two-session races: import-before-freeze and freeze-before-import; manager-return-vs-import; two different manager decisions; same decision/re-sign retry; cross-device same intent/order/document; online writer/cancellation-vs-freeze; seal/close/renewal-vs-pending/conflict; staff removal-vs-manager decision. Verify locks actually block, and no dual invoice/decision, ghost row, reused number, or ACK is produced.
6. Native integration: exact signed query/result retrieval with logout, revoked staff/device, disabled selling flags, stale challenge, wrong key/epoch/scope/intent/hash, corrupted response, oversized envelope, lost result/signing attachment, rotation of server keys, and restart after each boundary. Outcome accepted only for the exact stored freeze. Unknown outcomes remain frozen. Verify no result can enter normal grant-install or offline-sale ACK paths.
7. UI/printing and shift audit with synthetic funds first: full cash return, card void, settled card refund recorded as return, mixed full return, amount mismatch, change-not-given, wrong drawer, missing references, no-collection cancellation remains distinct. Verify no processor/payment action is automatically retried and no pending case silently disappears.
8. Phase two only after decisions below: SQL019, dedicated historical-basket preview/issue, actual accounting/report/refund/numbering/kitchen regressions; race it against import and other decisions. Test menu/profile changes, large/weighted baskets, rounding, buyer threshold, original drawer closure, deleted/disabled products, current-time transaction timestamp, lost reply and signature, and full atomic rollback. Native receipt display must verify the separate signed server outcome rather than fabricate a local sale.
9. Supervised two-device acceptance, manager training, device loss/restore rules and explicit live approval remain separate. Passing tests is not permission to enable release flags.

## Business decisions to obtain before enabling outcomes

These are questions for the project owner; this design does not send them to the user automatically.

- May any current branch manager approve a full return/void, or should larger amounts require an owner/second approver? Suggested first implementation: manager/owner only, documented amount ceiling, no delegated cashier approval.
- What evidence does the restaurant retain for cash returned, card authorization void and settled-card refund (terminal reference, customer acknowledgement, manager note), and how long? Do not require cardholder secrets.
- For funds retained after an unissued basket expires, does the accountant approve a current-time invoice retaining original prices/tax calculations and explicit historical collection reference? What treatment is required when tax/entity details changed? Until answered, keep this outcome disabled and the case pending rather than force a return or backdate.
- Can the first return workflow require the original drawer to remain open and all planned tender to be fully resolved, leaving partial/different-drawer cases with the manager? The engineering default is yes; support for broader cases needs explicit accounting entries and acceptance.
- Who can recover an unresolved payment when the original cashier cannot sign in/unlock or the device is lost? Default: no local reset, no deletion, no unsupported “resolved” switch. A later manager-assisted/device-loss protocol must prove custody and prevent a surviving issuer from committing the same intent.
