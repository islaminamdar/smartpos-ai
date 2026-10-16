# Rendered UI review — 2026-10-16

Role: UI/UX QA Specialist; model runtime-selected/not exposed. Review used an independent CUA-controlled Chrome tab against the production build at `http://127.0.0.1:3049`. Live/customer tabs were untouched. No credentials, customer transactions or payment actions were entered.

## Scope and observed evidence

Reviewed `/`, unsigned `/billing`, and `/counter` sign-in at1280,375,320px viewport widths. Screenshots captured in the review conversation cover desktop hero, desktop roadmap/pricing, mobile hero at375/320, narrow menu illustration, narrow pricing, unsigned billing, and sign-in at375/320/1280. DOM dimensions confirmed no horizontal overflow at those widths. All three homepage menu images completed loading with nonzero natural dimensions; no broken-image placeholders. Console collection returned no errors or warnings during reviewed flows.

Homepage navigation is available on narrow screens without a hidden menu; staff access remains prominent. Skip-to-content keyboard navigation moved subsequent tab focus to the staff-counter CTA. Focus outline was visible. The pricing anchor and subscription-details link navigated correctly. The card-payment FAQ expands and explicitly explains that the POS records external terminal payments, rather than charging a customer's card. USD100/branch/month is visible; PayPal checkout is explicitly in development/not enabled. Offline live billing and Android APK are explicitly unreleased; training-only functions are labelled separately.

Unsigned billing shows a disabled branch selector and checkout button, sign-in direction, recurring terms, cancellation meaning, and preservation of existing manual arrangements. It does not claim a payment succeeded. The page-to-counter link works. Sign-in inputs have visible labels and keyboard focus; inputs measure46px high and submit44.5px. No form was submitted.

## Small improvements found

- Billing header's counter link was19.5px high at mobile width. Updated only `app/billing/billing.css` so header and footer navigation links have44px minimum touch height.
- Counter training link was19.5px high. Root independently updated `.lc-login > a` to44px minimum height.

Both changes were verified against the freshly rebuilt/restarted3049 production preview: billing header/footer links and counter brand/training links each measure44px high at375and320px. Both pages retain scrollWidth equal to viewport width, with no horizontal overflow. Screenshots captured the final mobile state; console collection remained empty. Temporary per-tab viewport override was cleared after testing. The scoped rendered review is complete; this is not a full authenticated POS or PayPal flow audit.

## Limits

No real Android hardware, screen reader, operating-system text scaling, authenticated billing data, payment provider, offline APK, printer, or customer-sale flow tested in this review. Root owns authenticated catalogue and server release verification separately. No production deployment was performed by this reviewer.

## Authenticated catalogue check

Root tested the actual menu API through the production preview using a dedicated synthetic branch, with live financial writes disabled. A new AED24/kg test item was saved, made unavailable and read back after reload. The form was inspected at desktop and375px;320px exposed a navigation overflow after adding the fifth manager tab. The source now wraps navigation rows and hides the empty editor panel on small screens until an item is selected. Final rebuilt readback passed: document widths305/360/1265 at viewports320/375/1280, with no horizontal overflow. The temporary diagnostic style was removed by reloading the rebuilt page, and viewport overrides were reset. Console error/warning collection was empty. No real restaurant item, bill, shift or payment was changed.
