# Branch reports

The online counter's manager Reports tab reads immutable issued invoices and credit notes. It does not change sales, refund records, subscriptions or drawer balances.

## API and authorization

`GET /api/pos/reports?branchId=<uuid>&start=YYYY-MM-DD&end=YYYY-MM-DD`

Add `format=csv` for an authenticated attachment. Both formats use private, no-store responses. The pilot gate and authenticated user client apply; PostgreSQL checks active manager/owner membership for the requested organization and branch. Cashiers, another tenant and managers of another branch are denied. Organization-wide managers/owners can read their branches. A disabled selling flag does not hide historical reports.

The inclusive date range is limited to 93 days, with Dubai midnight boundaries calculated in PostgreSQL. A receipt profile with the supported `Asia/Dubai` timezone is required. Missing configuration or query failures are unavailable results, never zero sales. Limits are 50,000 documents and 5,000 historical product groups per report; an over-limit query asks for a shorter range rather than silently truncating.

## Definitions

- Sales and VAT use final stored document and line amounts, including any discounts already reflected in those amounts. Prices and tax are not recalculated.
- Credit notes subtract on their issue date, even if the original invoice predates the selected range. Refund-only days can have negative net sales and VAT.
- Net including VAT equals invoice gross less credit-note gross. Net excluding VAT and net VAT use the corresponding saved amounts.
- Cash/card totals use recorded fiscal payments. Cash tender/change and drawer cash movements are excluded. Recorded card payments do not establish bank settlement.
- Products are grouped by saved product ID, name and unit. Historical renames remain separate rows. Quantities preserve thousandths of the sold unit. The top-products table ranks those groups by net sales including VAT.
- Category totals use only category values saved on each newly issued fiscal line. A credit note inherits that saved category from its original line. Older fiscal documents and signed offline imports without a saved category are explicitly excluded from category analytics; they are never joined to the current menu and are shown in the coverage count. Existing fiscal documents are never rewritten.
- Days without documents appear as zero after a successful query. Older orders without issued fiscal invoices are excluded and counted in a visible coverage warning.
- Customer details, customer TRNs and staff identities are not returned by the report.

CSV text cells are protected against spreadsheet formula interpretation. CSV export makes a fresh authorized query; records issued after the screen loaded can therefore change the exported totals. This is an operational report, not a tax-filing workflow.

## Validation

```sh
pnpm exec vitest run tests/unit/pos/reports.test.ts tests/unit/pos/reports-ui.test.tsx
node tests/integration/pos-reports.mjs /path/to/@electric-sql/pglite/dist/index.js
pnpm typecheck
```

The integration fixture applies migrations 001, 002, 003 and 011 independently of offers migration 010. It checks actual PostgreSQL authorization, Dubai date/microsecond boundaries, weighted quantities, split tenders, earlier-period refunds, negative days, immutable final amounts, legacy exclusions and empty ranges. The optional third argument writes a synthetic browser fixture to a private output path.

API/UI tests cover schema reconciliation, failed and mismatched results, CSV escaping, Dubai-based quick-date ranges, product ranking, date changes and an old branch's late response. Rendered review is recorded in `docs/design/2026-10-16-reports-review.md`. Maximum-volume rendering has not been load-tested.
