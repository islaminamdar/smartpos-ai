# Manager review of frozen offline payments

Candidate implementation, 2026-10-16. This adds manager review and records completed full returns or card authorization voids. It does not move funds, call a payment provider, issue a replacement invoice, or clear an Android payment hold. SQL017–020 are not applied live. Native signed-result retrieval and acceptance remain pending. The hosted release allowlist deliberately excludes the decision POST, even when the online pilot is enabled.

## Authorization and release controls

`POS_OFFLINE_PAYMENT_REVIEW_ENABLED` defaults off and controls current-authenticated manager reads. `POS_OFFLINE_PAYMENT_RESOLUTION_ENABLED` additionally controls new decisions; SQL020 has a separate per-branch policy defaulting to false. Reads use current manager/owner branch membership, not the historical cashier's credentials. Independent manager/source rate limits apply before evidence access. Device signatures cannot approve manager actions.

For a new decision, the website verifies the current password of the authenticated account, requires the exact same user ID, revokes only that temporary Auth session, and passes its trusted confirmation time to SQL. The timestamp is captured immediately after password verification, before token cleanup; SQL accepts it for at most 120 seconds. Failed cleanup blocks the decision. A current authorized manager may recover their exact accepted request without creating another decision or reconfirming an already completed external action. Revocation is checked under SQL locks before a new decision.

The manager POST requires the configured website Origin and rejects cross-site requests. It is not currently reachable through hosted middleware. All responses are private/no-store and expose bounded error codes. No browser-supplied actor ID or confirmation timestamp is accepted.

## Implemented interfaces

- `GET /api/pos/manager/offline-payments`: strict `branchId` and optional opaque `cursor`. At most 50 case summaries; keyset cursor preserves the database's six-digit timestamp, case UUID and kind. Never infer a branch-wide count from a page.
- `GET /api/pos/manager/offline-payments/case`: strict `branchId`, `caseId` and `caseKind` (`freeze` or `raw`). Current authorization precedes access to original evidence. Raw unsupported-text custody exposes metadata only and cannot be resolved by this slice.
- Candidate `POST /api/pos/manager/offline-payments/resolve`: at most 16,384 bytes; strict `{branchId, request, currentPassword}`. Its `request` contains stable `requestId`, `freezeId`, `freezeSha256`, `decision`, `reason`, ordered `evidence` and `cashDrawerShiftId`.

`decision` is `funds_returned` or `payment_voided`. Each evidence leg records `method`, exact net `amountFils`, `paymentObservedAt`, `completedAt`, `reference` and `note`. All original tender legs must be covered exactly, cash first. Cash requires the original still-open drawer; card void requires an entirely card-paid basket. Partial amounts, different drawers, replacement invoices and mixed return/void outcomes remain unavailable. Times are canonical UTC milliseconds; the UI labels and converts Dubai time. Actual NUL text and unrecognized fields are rejected without normalization.

The service verifies the original enrolled device signature, stored server-signed bundle, exact freeze scope and canonical hashes. It recomputes the quote from the historical snapshot. Current product prices are not substituted. Historical evidence validation remains independent of current selling enablement.

## Immutable decision and recovery

SQL020 stores private, RLS-protected decisions and first result signatures through service-only RPCs. It coordinates with existing financial identity, device, shift, authority and case locks. Original invoices, contradictory claims, unresolved exceptions, closed drawers and unauthorized actors block new decisions. Exact request replay preserves the first outcome. No order, invoice, payment, credit note or cash-out is created by an attestation.

An accepted result binds the manager, exact original scope, original native request hash, freeze hash and evidence hash. The service signs only the independently verified committed result, then verifies the stored first signature against pinned server keys. A signing interruption returns `delivery_pending`; subsequent authorized detail retrieval may attach the missing signature. Existing decisions remain readable when new decisions are disabled. Signature recovery does not override a late financial conflict or generate another external return.

The public result includes `nativeDelivery: 'not_implemented'`. `recorded` means the signed server outcome exists, not that the device accepted it or that the processor verified a void. Native acceptance must be implemented separately before exposing the manager writer.

## Browser behavior

The counter exposes the review tab only for manager/owner scope when enabled, or as read-only recovery when this browser retains a saved decision after the feature is disabled. IndexedDB stores the exact request before sending; passwords are never stored. A lost response retains that request and requires authoritative case retrieval before an exact retry. Scope changes suppress stale responses, and active writes guard navigation and sign-out.

Matching immutable server evidence acknowledges the local retry journal. If another manager's decision won, an explicit dismissal removes only this browser's request after authoritative verification; it cannot alter the server or Android record. Unknown holds and stale case eligibility block submission. Selected details remain accessible on small screens; lists, evidence and buttons are checked at mobile and desktop widths.

## Verification and limits

- Independent actual PostgreSQL 16.15 checks: 532 assertions and nine observed lock-wait races, including staff revocation, competing decisions, imports and precise mixed-kind pagination. SQL020 SHA256: `fc57c702100c3bed6c404fc69d455e4de7c84e8ea044f59c40083f57b48b098c`.
- Actual disposable PostgreSQL plus production service functions and real P256 proofs: four integration tests, including full return/card void, interrupted signing and read recovery, exact replay, late contradictory issuance, unsupported historical text and no extra financial writes. Cookie/password Auth and session revocation transport are mocked; these are not live-provider Auth tests.
- Targeted service, route and browser tests cover original proof tampering, wrong role/password, confirmation timing, immutable retries, body bounds, Origin, journal recovery and disabled states. Full-suite totals and scoped security results are recorded in the private task record.
- Local production-preview browser exercises use synthetic cases and synthetic Auth responses with real IndexedDB. They do not establish real merchant operation, physical return of cash, provider void/refund, printer compatibility or native delivery.

Required next work: exact native signed-outcome storage/verification and recovery transport, complete two-device acceptance, physical POS printing, manager training and the remaining documented business decisions before release enablement. Current-time replacement invoices remain a separately gated design requiring an additive migration after SQL020.
