# Shared unpaid orders and tables — 2026-10-16

## Scope and state

This increment adds shared unpaid orders and tables. Exact deployment, backup, rendered review and public acceptance evidence are recorded privately by the operator; source and local tests alone do not prove production activation.

Branch staff can create/edit shared unpaid orders, load them at another enrolled counter, assign one open order to a table, and settle the saved revision through the existing audited sale engine. Managers can maintain tables, void with a reason and reopen voided orders using explicitly reviewed lines and table selection. Drafts can be empty; payments cannot. There are200tables and1000simultaneously open orders per branch. Tables include complete occupancy independent of order pagination; active orders have no age cutoff. Open pages contain100orders, recent history50with truncation indication.

## Financial and access invariants

- Each payment has its own UUID, separate from the saved-order ID. A permanently cancelled payment attempt does not permanently invalidate its order.
- A private immutable canonical record links one order to one successful payment. Two payment UUIDs cannot settle one saved order. A preexisting ordinary invoice cannot be adopted; stripping or changing sourceTab on a linked retry conflicts.
- Settlement verifies revision, service type and the complete unique product/quantity/price/tax/catalogue revision set. Harmless line ordering may differ, but replay still requires the exact original outer request.
- Fiscal v1/v2 documents and offer arithmetic remain unchanged. Linked acknowledgements add exact settledTab identity/revision, validated by both server and browser, including inactive-account recovery.
- Ordinary sales and drafts require active branch authority/bound devices. Draft management does not need a cash shift; financial settlement needs the actor's own shift. Manager-only table/void/reopen checks also run in SQL. Private tables and helper/renamed financial functions have no direct authenticated grants.
- Management: shared authority15 → request19 → device share → branch coordination20 → tab/table → product locks. Settlement: shared authority15 → financial request0 → receipt configuration/device/shift → branch20 → tab → existing financial engine. No management path acquires shift/request0 after branch20.
- Management and financial requests persist before dispatch and recover by exact canonical acknowledgement or durable cancellation only. Management permits the original historical binding or same-actor/same-branch replacement; inactive users may retrieve their own committed results only. No history is deleted.

## Operator safeguards

The browser journal uses atomic IndexedDB insertion per actor/branch. Failed storage, response loss or an unrelated acknowledgement cannot clear the pending change. Save adoption runs before local acknowledgement removal, so a newly saved order cannot silently become an unrelated checkout basket. Metadata survives navigation; replacing a basket requires confirmation. Current menu repricing is an explicit review action. Stale list reads retain the last confirmed view and pause new actions.

## Verification scope

The candidate includes141isolated PostgreSQL assertions, strict actual-SQL/TypeScript response fixtures, HTTP trust-boundary tests, integrated counter/save/payment-link regressions, browser component recovery tests and real Chromium IndexedDB tests. Independent real PostgreSQL races and rendered desktop/mobile review are release gates; their final evidence and hashes are private. This is a scoped review, not a completed platform-wide security audit.

## Remaining scope

Unpaid kitchen dispatch, courses, per-item station routing, kitchen/table metadata on fiscal snapshots, floor-plan drawing, split/merged bills, partial returns, customer loyalty, inventory, native offline APK/printing, off-host backups and real recurring PayPal activation remain separate work. Current paid kitchen receives one ticket only when an invoice commits. Full refunds cancel that ticket but preserve the settled order as history.
