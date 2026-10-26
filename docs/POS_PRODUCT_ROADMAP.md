# Internext POS product roadmap

## Product target

A reliable, UAE-ready, multi-branch restaurant operating system: fast at the counter, clear in the kitchen, accountable for managers, and simple for customers. Every financial document remains immutable; sales features must preserve VAT, tender, receipts, audit history, recovery, and branch isolation.

## Present pilot foundation

- Counter sales, dine-in, takeaway, delivery, weighted sales, shifts, receipts and controlled returns.
- Kitchen tickets, kitchen stations, saved orders/tables, item notes, item modifiers and menu favourites.
- Branch catalogue, photos, offers, inventory count/receive/waste/adjustment and basic reporting.
- Staff roles, branded branch portal, manager close-out view, QR-viewable public menu.

## Delivery sequence

### Phase 1 — Counter speed and control

- Barcode/SKU scan and product lookup.
- Manager-authorised discounts, voids, price overrides and reason reporting.
- Split tender, partial payments and deposits where the fiscal engine supports them.
- Combos, bundles, modifiers, add-ons and course handling.
- Customer display and printer profiles.

**Acceptance:** every action is permission-checked, recoverable, visible on the receipt/kitchen ticket where relevant, and exported in reports.

### Phase 2 — Kitchen and fulfilment

- Station routing by product/category, timers, delayed firing and production status.
- Delivery dispatch board and rider handover.
- Cancellation/refund signals to every affected kitchen station.
- Preparation instructions and allergen warnings.

**Acceptance:** a kitchen order can be traced from sale to completion or cancellation with no duplicate ticket.

### Phase 3 — Inventory, purchasing and cost

- Ingredient master, units and supplier records.
- Recipes/BOMs, yield and item-level consumption.
- Purchase orders, goods receipt, supplier invoice reference and stock transfer.
- Expiry/batch tracking where required, stock count variance and wastage reasons.
- Food cost, menu margin and reorder reports.

**Acceptance:** recipes never rewrite historic invoices; sale deductions are idempotent and can be reconciled to stock movements.

### Phase 4 — Customer and growth

- Consent-based customer profiles and invoice-linked history.
- Loyalty ledger, points rules, redemption controls and return reversal.
- Wallet/store credit only after a dedicated financial ledger is in place.
- Digital receipts, feedback and campaigns only with recorded consent.
- QR menu first; self-ordering and online payment after table/session controls are designed.

**Acceptance:** balances are derived from an immutable ledger and customers can be removed/exported according to the privacy policy.

### Phase 5 — Owner, franchise and subscription platform

- Multi-branch dashboard, central catalogue, branch price/availability overrides.
- Sales, tax, profitability, staff and inventory reports with date/branch filters.
- Tenant onboarding, branding, AED 100/branch/month subscription record and role administration.
- Health monitoring, release controls, support tools and audit log.

**Acceptance:** one client cannot access another client's staff, menu, data, reports or media.

### Phase 6 — Hardware, Android and resilience

- Supported Android POS device matrix, printer/scanner/customer-display commissioning.
- Signed APK delivery, in-app update check and rollback guidance.
- Offline sales only after device keys, authority grants, conflict handling and end-to-end recovery are tested on target hardware.
- Windows deployment only after browser/PWA and printer compatibility tests.

**Acceptance:** a device test record confirms sales, receipt, kitchen ticket, cash drawer, printer and recovery behaviour before go-live.

## Release rule

Each module requires focused automated tests, full typecheck/build, security scan where data or permissions are touched, isolated migration rehearsal, a verified backup, live health check and a desktop plus mobile smoke check.
