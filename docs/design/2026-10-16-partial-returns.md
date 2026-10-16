# Partial item returns — design and verification

Date: 2026-10-16

## Experience

Managers and owners open an original invoice from Receipts, check authoritative remaining quantities, and select original invoice lines. Repeated products remain separate lines. Piece/pack quantities accept whole units; weight accepts grams through three decimal places. Selecting all remaining items uses the same return flow.

The server preview shows the original discount allocation, net amount, VAT, credit total, cash to return, card refund to arrange separately, and remaining invoice balance. Editing quantities or the reason clears the preview and consent. A fresh confirmation applies only to the exact validated preview. Free-item returns explicitly record quantities with no refund payment. Returns do not automatically restock inventory or process payment-terminal refunds.

The saved credit note retains original-line identity, cumulative quantities, original offer information, and invoice net/VAT/gross immediately before and after the adjustment. Allocation follows the shared contract; the browser does not author money or reprice the sale.

## Recovery and scope

The existing durable request journal stores the exact command before submission. An uncertain response keeps the request pending, prevents another return, and offers recovery of that same request. Legacy full-return requests remain recoverable. Late acknowledgements can complete the original durable journal entry without applying an old actor's receipt or success state to a changed account, branch, device, or shift context. Preview and consent are discarded on scope changes and page suspension.

## Verification

- Reviewed the actual full LiveCounter, original invoice, return form, confirmation, and credit-note view at 1280, 375, and 320 CSS pixels. Document scroll width matched client width at all three widths; navigation wrapped and return controls remained usable. Screenshots were inspected and retained privately.
- Exercised a synthetic 125 g return and a lost-response → saved-request → exact-recovery flow in the browser. These were local simulated transport responses, not customer transactions.
- Used the actual local PostgreSQL-exported fixture in `tests/fixtures/pos-partial-return-documents.json` for interactive discounted and zero-value browser flows. The final discounted example returned AED 0.68, split into AED 0.08 cash and AED 0.60 card; the quantity-only example produced no payment rows. Both final receipts were inspected on mobile.
- All 13 exported PostgreSQL vectors also pass interactive component tests: select their exact original quantities, submit the original reason, validate the exported preview, require fresh consent, and pass the exact request and quote hash to commit.
- Final focused run: 55 tests passed across partial-return UI, full-counter return integration, offer receipts, live offers, and staff recovery. Cases include invalid weight precision, duplicate products, stale/mismatched previews, pending requests, actor/shift changes including an away-and-back transition, and exact interrupted recovery.
- A full-project run exposed a test sequencing race: the pending banner appeared before the asynchronous remaining-item read produced the review button. The test now awaits that button, verifies it stays disabled, and verifies no preview or commit occurs. Runtime behavior was unchanged; the original failure log was retained privately.
- Type checking and whitespace checks passed. Scoped ESLint had no errors and one pre-existing image warning. Scoped Semgrep ran 22 rules across the three changed production UI components with no findings.

## Limits

This is local implementation and acceptance evidence. It does not establish deployment, a complete accessibility certification, physical printer delivery, a completed terminal refund, inventory restocking, or customer acceptance. Broader integration/database checks and final project-wide release gates are tracked separately. The existing receipt-column layout was retained; this change is not a counter redesign.
