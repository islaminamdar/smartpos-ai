# Manager offline payment review — candidate UI acceptance

Date: 2026-10-16. Scope: local candidate, synthetic records only. This is a manager attestation interface, not a card-provider refund/void integration or native resolution acceptance.

## Implemented interaction

`components/pos/offline-payments/OfflinePaymentReviews.tsx` is embedded in the manager-only Payment review tab when the server feature prop is enabled. Lists use opaque server pagination (50 cases per page, no invented global total). Detail shows the original basket, weight/piece quantity, cash/card amounts, tender/change, device declaration and current server eligibility separately. Mobile selection scrolls to the detail and offers a Back to case list button.

Full funds returned is available only for every original positive payment leg. Authorization void is card-only, explicitly before settlement. Amounts cannot be edited. Cash uses the original drawer/shift; a closed original drawer prevents a decision. Raw unsupported-text cases, conflicts, unknown holds and disabled policy remain read-only. No replacement invoice, partial return, mixed return/void or different cash drawer is offered.

Evidence entry uses Dubai time (UTC+4), preserves explicit observed/completed timestamps and requires reference, note and reason. The saved request review displays every immutable evidence field, including both readable Dubai timestamps. Exact consent resets when evidence changes. The current account password is requested only for submission; its input field is cleared before persistence/network work. The password is sent only in the confirmation request and is absent from the strict journal record and stable decision request.

The IndexedDB journal atomically reserves one request per actor and branch. Another tab cannot overwrite it. Lost responses require a fresh authoritative case read; retry uses the exact saved request with fresh consent/password. Matching canonical request, freeze/hash and manager scope clears only the local journal. A different accepted decision requires explicit local-only retry dismissal. Storage failure prevents POST. Actor/branch changes and lifecycle invalidation suppress delayed responses and clear password/consent; no request ID replacement is generated.

A list refresh invalidates the open detail until reread. Failed detail reads retain visible evidence with decisions disabled. The list adopts freshly read canonical status. Account, enrollment and payment guards recheck durable pending work. Journal detection continues when the feature flag is disabled; only read recovery is exposed then.

## Delivery language

- **Decision saved · signature pending:** manager attestation accepted; do not perform the external return/void again.
- **Signed result ready:** server result available; not a processor confirmation or device acknowledgement.
- **Original Android device confirmation: not implemented:** payment hold remains. No UI path claims that funds were returned by this application or that the device was cleared.

## Automated evidence

- 16 component/input tests cover exact amounts/drawer, Dubai calendar validation, mixed tender restrictions, evidence-bound consent, password clearing, persistence failure, lost POST/same-ID retry, canonical acceptance, stale reads, superseded local dismissal, actor isolation, background clearing, feature-off read recovery, unknown holds, fresh detail after list refresh and complete immutable evidence display.
- 2 real Chromium/IndexedDB tests cover competing tabs, reload, actor isolation, password-bearing record rejection, exact acknowledgement and notification failure.
- 20 existing and updated integrated counter tests pass, including newly added retained-manager-request guards with feature disabled and gated manager navigation. Total focused run: **38 passed**.
- Parent TypeScript check passed after its concurrent route-test typing fix. Final scoped Semgrep: 210 rules across 9 runtime files, 0 findings and 0 errors. No test result establishes production readiness or physical counter acceptance.

## Rendered review

Synthetic production preview at `/pos-assets/qa-payment-review` exercised original mixed-tender evidence, exact saved-request recovery with consent/fresh synthetic password, signature-pending state, and explicit Android hold. Parent independently reviewed desktop and exercised the saved retry; parent also inspected the 320px evidence screenshot.

Initial and final responsive observations are recorded in the private local task evidence directory. Requested widths: 320, 375, 768 and 1280; effective content widths were 305, 360, 753 and 1265 because of the browser scrollbar. All measured scroll widths matched content widths. Enabled buttons measured at least 48px. Final complete-evidence rendering was verified at 375px and 1280px and independently inspected by the parent. Final 320px check again measured no overflow and minimum enabled-button height of 48px.

Browser automation could not populate native `datetime-local` fields reliably, so initial new-decision submission was verified by component tests; rendered submission used a known saved synthetic request through the real journal. This limitation is not a claim that new date entry failed for users. Physical Android devices, real staff authentication, provider transactions, native resolution acceptance and production manager writes were not exercised.

Cleanup verified: temporary `app/pos-assets/qa-payment-review/page.tsx` and its empty directories removed, own preview stopped, port 3049 had no listener, own review tab closed and viewport reset. The synthetic pending request was cleared through canonical accepted UI recovery before closing. A private fixture copy and screenshots remain under the local task evidence folder; they are not part of the production build. Synthetic evidence only; no real customer or payment records.

Private screenshots: `manager-payment-review/final-mobile-375-evidence.png`, `manager-payment-review/final-desktop-1280-evidence.png` and `manager-payment-review/mobile-320-pending-device.png`, relative to `/home/islaminamdar/.local/state/codex-tasks/restaurant-pos-2026-10-16/`.
