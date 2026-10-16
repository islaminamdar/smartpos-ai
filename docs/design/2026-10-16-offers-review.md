# Offers interface review — 16 October 2026

Role: UI/UX Engineer; model runtime-selected/not exposed.

## Scope and method

Reviewed the integrated production-built counter at `http://127.0.0.1:3049` with separate headless Chromium contexts at 1280, 375 and 320px. Only synthetic bootstrap, catalogue, offer and quote responses were intercepted. The preview's real backend was deliberately unavailable. No manager save, customer sale, refund or other financial write was sent. Real live browser tabs were untouched.

The receipt checks use actual synthetic PostgreSQL output in `tests/fixtures/pos-offer-documents.json`, rather than an invented receipt layout. The browser pass verifies rendering and controlled-response behavior, not production authorization or provider/payment operation.

## Initial rendered results

- Manager bundle editor, two exact-product selections, Dubai weekly happy hour and seven counter tabs all fit desktop and both mobile widths. Document scroll widths equal their respective viewports. Every measured visible button and non-checkbox form control is at least 44px high.
- Cashier selected-offer totals show the expected AED5.00 before discount, AED0.50 saving and AED4.50 final amount. Coupon changes clear the selected quote and restore the normal price. An injected HTTP503 displays an actionable unavailable-offer error with no stale quote.
- No unexpected JavaScript exceptions occurred. Each deliberate HTTP503 produced its expected browser network error; these are not concealed as clean-console results.
- Initial screenshots exposed inherited counter label styling that stacked checkboxes/radios above their text. Scoped selectors in `offers.module.css` now preserve inline control labels. The picker also now explicitly labels both saving and total as AED. Final rebuilt readback is recorded below when complete.
- The synthetic discounted invoice renders at all three widths without outer overflow. It shows the offer name, original amount, discount, final line VAT, total, cash tender and change. Print emulation hides application controls. A one-page 80mm-wide PDF was generated and its rasterized page visually inspected; content is legible and unclipped. Physical printer delivery was not tested.

Screenshots, JSON measurements and the PDF are stored privately under the task's `offer-ui-review` evidence directory. Initial filenames include `manager-1280.png`, `manager-320.png`, `picker-375.png`, `unavailable-320.png`, `receipt-375.png`, `receipt-print-320.png`, `receipt-80mm.pdf` and `receipt-80mm.png`.

## Integration safeguards tested

Twenty-two component/integration tests pass. Seven mount the actual `LiveCounter`, offer picker and receipt validation together. They verify basket/service/coupon invalidation, persisting the discounted offer/payment request before dispatch, exact fiscal ACK acceptance, rejection of valid same-total wrong-product and wrong-offer documents, and identical-request recovery after response loss and remount. The journal boundary is mocked in these tests; the existing journal suite independently exercises actual browser IndexedDB.

Fifteen manager/picker cases additionally cover all four benefit definitions, Dubai date conversion, weekly windows, unsupported per-customer limits remaining null, storage failure, immutable retry, bad acknowledgements, definitive stale-edit recovery, unknown conflict retention and ACK-versus-refresh failure. TypeScript passes. Scoped Semgrep: 210 rules, two components, complete parsing, zero findings. Scoped lint has no errors and one reviewed request-generation cleanup-ref advisory.

## Final readback

The rebuilt preview was rechecked at 1280, 375 and 320px. All checkbox and radio label containers now have computed `flex-direction: row`; keyboard Space toggles the enable checkbox and selects the offer radio with a visible focus outline. All seven tabs remain at least 44px high. Document widths still match the viewport, no measured standard form/button targets are below 44px, and explicit “Save AED 0.50 · total AED 4.50” appears at every width. Coupon invalidation and the deliberate unavailable-quote response were repeated successfully. No financial write occurred.

Homepage readback at 1280 and 375px has no overflow, missing images, console errors or JavaScript exceptions. It states that offers are in the online pilot, connected sales need internet, offline live billing/Android are not released, and recurring PayPal billing is in development; the price remains US$100 per branch per month. Final screenshots use the same evidence filenames listed above, plus `homepage-1280.png` and `homepage-375.png`.

The actual SQL bundle invoice (AED32.00 final, AED13.00 discount) and a paid invoice containing a zero-priced reward line were also selected and visually inspected at320px. Both retain readable per-line discount/VAT and final payment figures; screenshots are `receipt-0000000006-320.png` and `receipt-0000000007-320.png`. No JavaScript errors occurred.

The initial label-layout and currency-label issues are resolved. No further visual release blocker was found in this bounded pass. Receipt/PDF verification is a rendering check, not proof of physical printing, production financial correctness or subscription activation. No production deployment is claimed by this review.
