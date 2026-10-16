# Branch stock management

## Design plan

This screen supports a restaurant manager receiving ingredients, recording waste and checking a physical count. It belongs in the existing counter as **Stock**, available to a manager or owner for the selected branch. Stock records are separate from the sales menu and never imply a change in menu availability.

Use the counter palette: navy `#142d4e`, action blue `#165dcc`, white `#ffffff`, page grey `#f4f7fb`, muted text `#526176`, and amber `#6e520f` for low stock. Inherit Arial and use tabular numerals for recorded quantities. Item names and quantities carry the hierarchy; avoid dashboard charts without actual consumption or costing data.

The left-aligned layout uses a searchable item list beside an editor on desktop. On mobile the selected item and its actions appear before the list. Each row shows the recorded balance with its own unit and a plain low-stock or paused label. Do not sum quantities across kilograms, litres and pieces. The manager can add an item, edit its details, record a movement and inspect the resulting history.

The planned action order is **Receive**, **Waste**, **Physical count**, **Adjustment**. Receive and waste use positive quantities; physical count records the actual quantity observed; adjustment uses a positive or negative change. A reason accompanies every change. New items begin with an unknown balance, shown as Not counted. A first physical count is required before receiving, recording waste or making an adjustment. An explicit first count of 0 establishes a known zero balance.

The screen must say that only recorded movements are reflected, sales do not deduct stock automatically, and recipe deductions are not available yet. There are no stock-costing, profit, expiry, supplier, purchase-order or branch-transfer claims.

## Review against the brief

A generic inventory dashboard would imply consumption insights the implementation does not hold. The selected design instead puts a recorded quantity and movement action beside the actual item. It uses one detail surface, a compact item list and an ordered movement history. Small-screen controls need at least 48 px tap targets and a single-column fallback without horizontal scrolling.

## Implementation and verification

Implemented the Stock manager panel in the existing counter, with separate item editing and movement history. The list supports search, active/low/uncounted/paused filters and keyset pagination. History is independently refreshed; a missing read never becomes a zero quantity. Stale item or branch responses are ignored, and a revision change during history pagination requires a refresh.

Every write first saves the canonical immutable command in localStorage under the original actor, branch and device. Web Locks serialize competing tabs; an existing different command cannot be overwritten. Storage events discover another tab's work and reset cancellation consent when the request identity changes. A lost response retains the same request for lookup and exact retry. Cancellation requires an explicit checkbox and a server acknowledgement that also prevents a delayed request from applying. A bound historical result is acknowledged separately from fetching the current balance.

Both write and recovery POST requests carry X-POS-Actor for the server to atomically match the current account. Recovery outside the Stock panel remains available with a failed bootstrap, missing enrolled device or changed role while the counter pilot is enabled. It reads only the signed-in actor's journals. Historical lookup does not require a new storage write or Web Lock; if safe local clearing is unavailable, the saved command remains for later reconciliation. New writes require persistent storage and Web Locks. This does not make the hosted counter available when its pilot gate is disabled.

Verification on 16 October 2026:

- 30 focused component and counter integration tests passed. These cover all movement types, milli-unit quantities, unknown versus explicit zero, immutable units, read failures, financial holds, request persistence across unmount/reopen, competing tabs, exact recovery/cancellation, account mismatch, no-Web-Locks historical lookup, mismatched acknowledgements, pagination and stale branch responses.
- TypeScript passed. Scoped ESLint reported no errors and only the pre-existing counter image warning.
- Scoped Semgrep ran 210 rules across five source files with zero findings.
- Actual Chrome review at 320px, 375px and 1280px found no horizontal document overflow. Stock buttons measured at least 48px; selected item actions stack before the list on narrow screens. Client/scroll widths matched at 305, 360 and 1265px respectively (15px desktop scrollbar); all stock descendants stayed inside clientWidth. Normal viewport captures preserve the actual right margin; full-page capture was rejected because its scrollbar removal clipped the returned image. The initial count warning and unavailable movement actions remain readable.
- In the synthetic mobile fixture, receiving 1.25 kg changed flour from 6.5 kg to 7.75 kg with exactly one new movement and its reference. The parent reviewer independently checked an interrupted first count of 0, recovery outside the manager panel, and exactly one recorded history entry after reopening.

Screenshots, metrics and scan output are retained privately in the task evidence folder, outside the repository. The synthetic preview is local only and is removed after review. These UI checks do not constitute production deployment or live stock acceptance.
