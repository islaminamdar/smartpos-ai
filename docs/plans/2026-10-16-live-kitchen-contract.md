# Live kitchen coordination

This increment connects the shared kitchen board to confirmed paid counter sales. It does not replace the remaining shared open orders, floor/table management, courses, station routing or physical kitchen printer work in the commercial roadmap.

## Authoritative tickets

A new tax invoice creates one kitchen ticket in the same database transaction. Retrying the sale cannot create a second ticket. Historical invoices are not backfilled, so releasing this feature cannot send old meals to the kitchen. Both existing invoice schema versions use the same kitchen projection. The ticket contains item names, quantities, units, order type, invoice reference and timestamps; customer, payment, price and coupon details are excluded.

Branch staff on an enrolled device can read the board and advance adjacent stages: queued, preparing, ready, served. A kitchen display does not require an open cash shift. A manager can reverse one adjacent stage with a reason. A full credit note cancels the ticket in its refund transaction, including an already served ticket, while preserving the original state in the audit. Cancellation does not mean food was physically recalled or a printer received an instruction.

Every status change includes a fresh request ID, original device, expected ticket revision and target status. The server checks branch and actor authority, locks the relevant order/ticket, and returns an immutable canonical acknowledgement. Competing devices cannot both change the same revision. A manager correction must not silently overwrite a later kitchen action.

## Connection and recovery

The browser saves a request before sending it. An uncertain response retains the exact request. A subsequent list result never substitutes for a request acknowledgement. Recovery takes the same request lock: it returns the committed original result or creates a permanent cancellation record that prevents a delayed original from changing the ticket.

Recovery is tied to the original actor and device ownership. The original historical binding or the same actor's current replacement device in the same branch can be used. An inactive actor may recover their own committed result only; cancellation of an unsaved request still requires active branch authority. The browser retains unresolved records when authority, storage or network checks fail.

The board polls an authenticated same-origin endpoint while visible. Failed refreshes retain the last confirmed view with a stale warning and disable stage changes. This is online coordination; no offline processing or physical print guarantee is implied.

## Queue completeness

Active orders have no automatic age cutoff. Global counts include every queued, preparing and ready ticket. Active tickets use oldest-first keyset pages of at most 100; explicit paging makes older work accessible without falsely claiming a limited page is the whole queue. The latest 50 served/cancelled tickets are shown separately, with a visible truncation indicator when there are more. Financial receipt history remains the source for older documents.

## Release evidence required

- Unit/API checks for authentication, device scope, origin, bounded inputs, response identity and private fields.
- Executed SQL lifecycle, negative boundaries, refund propagation, immutable replay and cancellation tests.
- Actual concurrent database tests for competing stage changes, refund versus stage change, save versus cancellation, and staff revocation.
- Desktop and narrow phone browser review, including stale state, saved-request recovery, weighed quantities and paging.
- Reviewed production build, scoped Semgrep results, verified backup and migration ledger before activation.
- Public synthetic-branch acceptance and cleanup, plus read-only real-merchant verification after activation.

This source contract does not establish release, printer or customer acceptance. Exact deployment and verification records are private.
