# Native manager-result recovery — interaction plan

2026-10-16. Candidate work. Production issuance remains gated; no real customer or provider actions are authorized in this UI work.

## Current inspected behavior

`apps/android-pos/src/NativeCounter.tsx` preserves an original uncertain payment ID, requires the original actor and native PIN for full detail, and wipes visible details and consent on native lock/background. A frozen payment currently displays its original bill calculation, local freeze reference and a collapsed proof fingerprint. It blocks new sales, collection, receipt issuance and no-money cancellation. That protection must continue until exact native durable acceptance.

## Agreed bridge and implemented presentation

The root agent owns the bridge and authenticated historical transport. The native storage specialist owns signature validation, scope checks and atomic acceptance. React supplies only the original payment ID to an explicit sync operation; it never supplies a manager decision or proof bytes to trust.

- Saved locally: explain that the saved review has not been sent; offer **Send for manager review**.
- Pending: **Sent for review · a completed result is not available yet**. The device protocol cannot currently distinguish awaiting a manager from an accepted decision awaiting signature; do not invent that distinction.
- Conflict: **Records disagree. Keep this payment and contact your manager or support.** No collection, cancellation or replacement bill.
- Unsupported historical record: **The original record needs support review.** Retain records, show support reference, no automatic repair/reset.
- Native accepted full return: **Manager’s full-return decision saved on this device.** Explain that this is the manager’s attestation, not a refund performed by the app.
- Native accepted authorization void: **Manager’s card-authorization-void decision saved on this device.** Explicitly distinguish it from an issued invoice/credit note.

Accepted results retain the original amount/tender and basket for inspection. The displayed time is the signed server `resolvedAt` labelled “Manager recorded”; no local device acceptance timestamp is invented because the local clock may not be trustworthy. Support identifiers remain collapsed. No tax invoice is presented for an unissued payment. Do not claim a provider processed funds or that a server has received a device acknowledgement unless the protocol provides that separate evidence.

## Recovery and privacy

All network actions share the existing native operation lock and lifecycle epoch. After a lost response, read the same saved payment first; do not repeat an external return/void or invent a new payment ID. Late results after lock, scope change or unmount cannot repopulate private detail. Unknown status remains blocked.

The checkout read now supplies `lastResolvedIntentId` and PIN-gated `lastResolvedIntent`, so an accepted result can be displayed after restart when its pending payment ID has cleared. A locked result shows only a neutral saved-record notice and access/unlock actions. Entering a new basket requires an explicit counter-state refresh; the UI must respect the returned native readiness and production gate.

## UI verification

Exact full-return and card-void result display; pending/conflict/unsupported states; same-ID recovery after response loss; restart with retained accepted metadata; locked-detail privacy; late-result suppression; original identity/request mismatch; shared operation lock; no collection/receipt/no-money-cancel actions on terminal result; no new sale merely because manager resolution succeeded. Rendered review will use synthetic records at 375 and 1280 pixels, with a 320-pixel overflow check. Physical device and real authenticated financial acceptance are separate native QA evidence.

## Exact wire fields

The plugin `syncFrozenPayment({intentId})` is exposed through `syncNativeFrozenPayment(intentId)`. It returns the existing intent wrapper. Frozen `managerReview` contains `{freezeId, proofSha256, status: saved_locally | pending | conflict}`; frozen reason remains `payment_frozen`. The device cannot separately identify unsupported historical text or an unsigned committed manager decision, so pending/conflict copy stays deliberately broad.

Terminal intent state is `manager_resolved`, with `canConfirm=false`, `canCancel=false`, `reasonCode=null`, `receipt=null` and `managerReview: {freezeId, proofSha256, status: accepted_on_device, resolutionId, decision: funds_returned | payment_voided, resolvedAt}`. The UI checks the original intent/request and freeze identity before accepting an action response; native verification and durable storage remain the actual trust boundary. The signed result is not rendered as a receipt or tax document.

## Local evidence and limits

Counter UI suite: 36 tests passed, including 9 new result-recovery cases for pending/conflict, return/void acceptance, restart, exact-ID lost-response recovery, locked metadata, native-lock wipe, delayed-response suppression, mismatched freeze rejection and paused selling after acceptance. Native app TypeScript check passed. Combined counter plus App regression run: 71 passed (36 counter, 35 App). Scoped ESLint was clean. Semgrep Community Edition ran 210 rules across the 2 UI runtime files with 0 findings and 0 errors.

A synthetic full-App Capacitor fixture was rendered using the actual `App` / `NativeCounter` / native TypeScript parser. At 375px, Send for manager review → pending → Check manager decision → accepted worked, preserving the original planned payment and showing new sales paused. At 1280px, the result and readable Dubai manager time were inspected. At 320px, the accepted card-void layout had no horizontal overflow. Effective content widths 360/1265/305 matched scroll widths; enabled app buttons measured at least 48px. Existing CSS patterns were reused.

Private screenshots are stored under `/home/islaminamdar/.local/state/codex-tasks/restaurant-pos-2026-10-16/native-manager-result/`: `mobile-375-pending.png`, `mobile-375-accepted.png`, and `desktop-1280-result.png`. This browser evidence does not establish real native signature acceptance, authenticated manager actions, physical payment events or deployment. The parent owns actual native/device verification and final release decisions.

Parent independently reviewed the desktop flow and mobile accepted-result screenshot. The synthetic repository fixture was removed, its private evidence copy retained, the owned port-3050 preview stopped (no listener), and the owned Chrome tab closed with its viewport reset. No production changes were made.

The web manager-review copy now separates a signed server result from unreported device acceptance: it instructs the manager to check the original Android device and does not claim its hold necessarily remains. The undeployed candidate API now returns `nativeDelivery: not_confirmed` because server acknowledgement of device acceptance is still absent. Only the delivery discriminator and presentation changed; no gate or financial behavior changed. Native generic frozen-payment errors also avoid asserting that a pending/conflict review was never sent.

Final delivery-copy/contract follow-up: 59 affected UI, integration-component, service and route unit tests passed across five files, including two neutral native error-guidance regressions. Native app TypeScript and scoped ESLint passed. A further Semgrep scan of the four changed bridge/web/service runtime files completed with no findings or errors. The integration database assertion was updated to `not_confirmed`; actual database execution remains the parent’s verification responsibility.
