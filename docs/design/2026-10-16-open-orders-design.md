# Shared unpaid orders and tables

16 October 2026 · UI/UX Specialist · model runtime-selected/not exposed

## Scope and visual decisions

The counter can save a basket as a shared unpaid order, continue it from another registered counter, assign one open order to a table, and settle its current revision through the existing payment flow. Managers can configure tables and void or reopen an order with a reason. Saving, voiding and reopening never take payment. Unpaid orders reach the kitchen only after payment in this increment; that limitation appears on both the board and save form.

The existing navy/blue counter identity, Arial typography, white cards, pale background and visible focus rings remain consistent. The board separates Orders, Tables and Recent history. Written status labels accompany colour. Cards show the label, order reference, service type, table/guests, AED estimate, saved time in Dubai, quantities and notes. Estimates explicitly exclude payment offers. Table occupancy comes from the complete branch table list, including orders outside the visible page. Pagination replaces the page rather than mixing snapshots. Controls use 48px minimum height and flexible wrapping for small screens.

The optional new-order form starts collapsed and pristine, allowing ordinary walk-in payment. Editing metadata requires saving before payment. Saved-order metadata remains mounted when navigating between counter screens, while the revision-bound form resets only after canonical adoption of a new revision. Loading an order retrieves its latest detail; paid orders cannot be loaded for editing. Voided orders require manager review and a full, reasoned reopen save.

## Reliability and recovery

An exact request is stored atomically in an actor-and-branch IndexedDB journal before sending. Concurrent tabs cannot overwrite it. Cross-tab notifications and focus refresh expose pending work promptly, while atomic storage remains the final guard. Original device IDs remain attached during replacement-device recovery. Notification errors cannot turn a successful storage commit into an apparent failure.

Uncertain requests remain locked until an exact canonical acknowledgement or cancellation result arrives. Canonical adoption runs before the journal is cleared, so the counter cannot briefly pay an unlinked basket. If adoption fails, the request remains recoverable. Cancellation requires consent keyed to that request ID and never voids an already saved order or refunds a payment. Recovery discovers the authenticated actor and original branches even without a bootstrap/device result.

Visible-only polling runs every 10 seconds without overlapping reads. Writes invalidate earlier reads. Failed refreshes retain the last confirmed board, show an explicit stale warning and disable actions. Opening a row separately validates current detail, branch and state. Server permissions, revision conflicts, catalogue validation and exactly-once settlement remain authoritative.

## Verification

The owned test suite passed 27 checks: 24 UI interaction tests and 3 real Chromium IndexedDB tests. It covers storage-before-network, persistence failure, atomic cross-tab requests, actor isolation, replacement-device recovery, exact and mismatched acknowledgements, canonical adoption before clearing storage, adoption callback failures, request-keyed cancellation consent, metadata preservation, current-detail validation, manager-only actions, complete occupancy, pagination, stale reads and visible-only polling. TypeScript and scoped ESLint passed during implementation. The final scoped Semgrep scan ran 210 rules over 8 owned source files with zero findings. These checks do not replace the parent engineer's server, SQL, payment and full-suite checks.

## Rendered review

The integrated production build was exercised through CUA in a dedicated Chrome tab at `http://127.0.0.1:3049/counter`, using synthetic same-origin API responses and real browser IndexedDB. Final build identifier supplied by the parent engineer: `QCEFzjuM0urLTJ4KprdYC`. Desktop 1280px, phone 375px and narrow phone 320px were reviewed. Page scroll width never exceeded viewport width. No visible non-checkbox button/input/select/summary measured below 44px. Checkbox labels provide at least a 48px hit area. Native screenshots confirmed readable single-column phone cards, wrapped metadata, full-width actions, stacked table editor fields and a contained pending-request panel. No browser error logs were returned in the final review.

The following integrated interactions were exercised:

- An untouched new form allows ordinary payment; editing its label blocks payment. Metadata survives switching to Orders & tables and back.
- A lost save acknowledgement keeps the original request, disables basket/payment/sign-out, and exact replay adopts the canonical shared order before payment is enabled.
- Adding a table while another basket is open preserves that basket. Occupied tables cannot be deactivated. Table creation requires a reason.
- Failed board refresh retains the last confirmed orders with a stale warning and disabled open/void controls.
- Manager void requires confirmation and a reason, removes the order from the open list, and retains it in recent history. Review/reopen asks explicitly before replacing a current basket. A voided order cannot be paid; reopening requires a reason. Lost reopen acknowledgement is recoverable with the same request.
- A saved order's weight quantity change blocks payment until its new revision is saved. Successful save restores the matching-basket indicator and payment availability.
- Account navigation while pending shows the recovery reminder and keeps password/sign-out controls disabled.

Rendered review found two small copy issues and both were fixed and rechecked in the final build: the order estimate now explicitly says AED, and a configured name such as “Table 4” no longer appears as “Table Table 4” in the order metadata. The final marketing card “Shared orders, tables & kitchen” and its paid-kitchen limitation were also reviewed at 1280px and 375px without overflow.

Private measurement evidence is stored at `/home/islaminamdar/.local/state/codex-tasks/restaurant-pos-2026-10-16/open-orders-ui-review/results.json`. Screenshots were captured and inspected in native CUA output; the full-page capture timed out once, so subsequent captures used the visible viewport. All synthetic requests resolved through the normal UI; IndexedDB readback confirmed zero pending records. The current basket was cleared, the temporary local tab closed and viewport emulation reset. No production tab, real account, payment or device hardware was touched. Authentication, live backend acceptance, printing, offline use and deployment are outside this synthetic UI review.
