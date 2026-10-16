# Live offers validation — 2026-10-16

Migration `20261016001200_pos_offers.sql` is implemented and independently tested. This record establishes database and contract validation; it does not claim production deployment or completed browser acceptance.

Validated SQL SHA256:

```text
5b169a7e584d18598d61e0d4051f00f54c75c1ace79471aa70348da650fd1509
```

## Implemented financial boundary

The server validates versioned, branch-scoped percentage, fixed, buy-X-get-Y and bundle offers. It uses current catalogue prices, its own clock and locked usage counts; expected browser amounts only detect stale requests. Device, shift, sorted product and offer locks precede final authorization. Discounted orders, payments, line amounts, redemption, usage increment, audit event and schema-v2 invoice are inserted in one transaction. The writer never creates a full-price paid order and patches its totals.

One redeemed order consumes one use, irrespective of bundle/BXGY application count. Offer edits and full credits retain usage. Full credits copy original discounted amounts, allocations and tender splits. Existing no-offer sales and v1 replay retain the prior writer. Existing cancellation tombstones remain authoritative.

Coupon-bearing definitions, versions, management commands and exact original sale requests have no client table grants. Public order/document requests contain a null coupon placeholder; applied snapshots and automatically generated audit details contain no coupon code. Exact replay/recovery compare the private original request. Privileged calculator and writer helpers cannot be executed by authenticated or anonymous clients.

Review identified and fixed a permission-wait race: staff can be deactivated or assigned to another branch while a transaction waits. Sale and management writers now recheck and hold the current scoped membership with a share lock before writing. The calculator also rejects a null or unknown role.

## Reproducible local checks

Run from the repository root. PGlite is a disposable test dependency installed outside the repository; the path below is the validation environment used for this run.

```bash
sha256sum supabase/migrations/20261016001200_pos_offers.sql
node --experimental-strip-types tests/integration/pos-offers.mjs /tmp/smartpos-sql-validation/node_modules/@electric-sql/pglite/dist/index.js /tmp/pos-offer-fiscal-fixtures.json
pnpm exec vitest run tests/unit/pos/offers.test.ts tests/unit/pos/offer-documents.test.tsx tests/unit/pos/offers-api.test.ts
semgrep scan --config p/default --metrics off --disable-version-check supabase/migrations/20261016001200_pos_offers.sql tests/integration/pos-offers.mjs --json --output /tmp/pos012-final-semgrep.json
```

The integration suite passes 400 deterministic varied SQL/TypeScript calculation comparisons plus all four benefit types, schedule boundaries, weighted rounding, exact-fils allocation, zero-paid reward lines, direct v2 settlement, full credits, private coupon replay/recovery, quota retention, failed-payment rollback, cancellation, malformed inputs, manager/cashier/tenant/device separation, private helper ACLs and the 200-definition cap. It also reconciles real discounted ledger amounts with reports and drawer summaries, and verifies replay/full credits after later menu name, unit and price changes.

The targeted TypeScript run passed 27 tests across three files. Seven generated SQL invoices, their original sale requests, a full credit and the quote response passed the current strict TypeScript schemas and invoice acknowledgement matching. Existing catalogue, recovery and cash-out integration suites were additionally run from isolated temporary copies with migration012 appended; all passed. Semgrep found zero findings across two targets and 200 applicable rules. Static scanning does not establish financial or concurrency correctness.

## Independent real PostgreSQL verification

Server QA ran 14 checks on PostgreSQL 17.6, using synthetic records and independent sessions with observed lock contention:

- Final redemption across different devices and shifts: one sale, one quota rejection, no partial loser records.
- Same sale retry: one invoice and one usage increment, canonical replay.
- Both manager-edit/sale lock orders; changed rules reject a stale request while an already saved original remains unchanged.
- Expiry while waiting for an offer lock: rejected without financial writes.
- Both cancellation/sale outcomes: immutable cancellation or canonical committed result.
- Discounted full credit, retained usage, coupon privacy, and exact pre-migration v1 replay/recovery.
- Both offered-sale/refund lock orders without deadlock.
- Sale staff deactivation, sale branch reassignment, and manager deactivation during a blocked edit: denied with zero mutation.

Final reconciliation: 10 invoices, 3 credit notes, payments of 9,100 fils, refunds of 2,700 fils, and exactly 9 redemptions matching usage increments. All self-created databases were dropped and their absence verified. Sanitized evidence and the reproducible server harness are retained privately under run `8efddee365204f699ac105812bd390c1`; infrastructure access details are intentionally excluded from this repository.

## Release and rollback limits

No unresolved material defect was found within this database/contract review. This is not a full-platform security audit. Browser/mobile acceptance, printing, deployment readback, production authentication and production load behavior are separate checks. The real concurrency tests used a minimal synthetic authentication shim, not live merchant records.

Per-customer limits are rejected until verified customer identity exists. One offer applies per order; fully free orders require a separate complimentary flow. Unit-based BXGY and bundles reject kilogram items. There are at most 200 definitions per branch, including inactive definitions; management reports a limit error rather than silently discarding history.

**Once any v2 document is issued, an application rollback must retain v2 document readers and exact private-request recovery.** Restoring a pre-offers application would make those documents unreadable to that application. Do not remove migration012 tables or rewrite issued receipts to make an older application appear compatible. Before any v2 sale, the retained v1 writer permits no-offer traffic while the application rollout is verified.
