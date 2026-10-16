# Offer calculation and financial integration contract

Status: deterministic preview engine implemented and unit tested; live sale integration remains pending. No offer is enabled for customer invoices by this module alone.

## Rules supported by the preview engine

- Percentage, including an optional maximum saving, and fixed AED discounts.
- Eligibility across the basket, selected product IDs or exact category names.
- Buy X get Y from one eligible pool. Reward units must already be in the basket; the cheapest eligible whole units are free. A buy-two-get-one offer requires three units. Kilogram items are rejected for this rule rather than treated as pieces.
- Fixed-price bundles with distinct product IDs and required whole-unit quantities. Complete bundles are applied; extras retain their normal price. The bundle never increases a price. Overlapping component selectors are deliberately not part of this definition.
- Inclusive start and exclusive expiry, Dubai weekly windows and overnight windows. Monday is day 1; Sunday is day 7. An overnight window belongs to the day it starts. Empty windows means all hours within the date range. Start and end may not be equal; use 00:00–24:00 for a full day.
- Service-type restrictions, minimum basket spend before discounts, manager-only offers, case-insensitive coupon entry, and preview evaluation of total/per-customer limits.

Exactly one selected offer applies to an order. The eventual interface must state this clearly. Automatically recommending the best eligible offer is separate from silently stacking discounts. More complex combination policies remain a future feature; the overall commercial roadmap is unchanged.

## Calculation invariants

1. Consolidate duplicate product IDs before evaluation. A product has one line, one unit and one quantity; product UUID is the stable allocation tie-breaker. Current un-discounted invoices need not be rewritten.
2. Round each list-price line to integer fils using half-up rounding. Percentage savings are rounded once on the eligible subtotal. Fixed discounts are capped at that subtotal.
3. Allocate a monetary discount proportionally across eligible line amounts, using integer division and largest remainders. Equal remainders use product UUID order. BigInt intermediates prevent loss of precision at the supported limits. Reordering the basket cannot move a rounding fil between products.
4. Retain the original unit price. Record `beforeDiscountFils`, `discountFils` and final `grossFils` for each line. Compute inclusive VAT on each discounted line, then sum. The totals must reconcile exactly.
5. For buy X get Y, allocate the saving directly to the free units. For bundles, allocate the saving proportionally across the consumed component amounts, leaving extra quantities outside the bundle price.
6. Reject a completely free order with a clear complimentary-flow requirement. Do not manufacture a 1-fils charge. A paid basket may contain zero-price reward lines.

The published FTA [tax obligations guide](https://tax.gov.ae/DataFolder/Files/Pdf/2022/Get%20to%20know%20your%20Tax%20Obligations.pdf) identifies discount information among invoice particulars. The [VAT executive regulation](https://uaelegislation.gov.ae/en/legislations/1226/download) describes the discount as the reduction in consideration. This design applies supplier-funded checkout discounts; third-party subsidies, vouchers and a separate complimentary-supply policy are outside this calculation contract.

## Required authority before live use

The browser quote is an estimate, never authorization or a reserved redemption. The database must:

- Receive selected offer ID, expected revision and coupon alongside the immutable sale request. Expected discount and total are mismatch guards, not trusted amounts.
- Authenticate branch staff and the bound device, validate manager-only permission, and use current catalogue and offer definitions. Never accept browser-supplied role, category, usage count or time as authority.
- Acquire locks in consistent order: request/replay guard; device; shift; products ordered by UUID; campaign/quota; invoice sequence. Check one server timestamp after waiting for mutable locks. Offer management must not invert the product/campaign lock order.
- Return an already committed exact request before checking changed rules, expiry or exhausted usage. Cancelled requests remain cancelled. A changed payload with the same ID fails.
- Commit usage and unique redemption with order, payments, immutable fiscal snapshot and audit event in one transaction. A failed payment, stale price or abandoned request consumes nothing. Usage increments once per redeemed order, regardless of the number of bundle or buy-X-get-Y applications in that order. Usage persists across offer edits. Refunds initially retain usage to prevent repeated redemption abuse; any future release policy needs an explicit ledger reversal.
- Require a server-owned verified customer identity for per-customer limits; receipt names and free-text phone numbers do not prove identity. Do not expose private coupon definitions in a cashier bootstrap.
- Emit document schema v2 while continuing to read/replay v1. Preserve the unchanged VAT algorithm/profile version. Include exact applied definition/version and line allocation in the immutable snapshot; full credits copy original discounted amounts and tender allocation without reevaluating current offers.

## Release evidence still required

SQL parity with the TypeScript vectors; malformed/forged selection rejection; no cross-branch access; last-use races across devices; edit-versus-sale and expiry-while-waiting; exact replay after expiry; cancellation; full-refund preservation; response-loss recovery; manager/cashier UI; mobile/desktop receipt display and printing; independent security review. The preview tests alone do not meet these gates.
