# Internext POS — operational design specification

Date: 2026-10-16. Target: web first at `pos.internext.info`, followed by an offline-capable Android APK. First tenant: Abdul Gafoor Suleman Usman Mithaiwala Restaurant LLC, Bur Dubai. The user confirmed AED 100 per branch/month for all features and multiple staff/devices; subscription VAT treatment remains unconfirmed. This document specifies intended behavior, not a claim that features are implemented.

## 1. Art direction and fetched benchmarks

**Concept:** A clear blue Internext control surface wrapped around the restaurant's actual food, with a readable running ticket that always tells the cashier what happens next.

The signature is the juxtaposition of authentic, light-background food photographs and the compact receipt panel. Brand differentiation comes from the restaurant badge and its real menu, not decorative dashboards. Internext owns application navigation, action colors and typography; a tenant owns its logo, name, menu and receipt identity. Keep the legal business name on receipts/settings; use “Suleman Usman Mithaiwala” and “Bur Dubai” in compact headers, with the full name available without truncation in restaurant details.

Primary reference pages fetched on 2026-10-16:

- [Square restaurant POS](https://squareup.com/us/en/point-of-sale/restaurants): product guidance connects menu photos with fast order entry, availability, table handling and split bills. Borrow the task focus and clear distinction between ordering, payment and kitchen work; do not copy its device marketing or claim its offline payment capabilities.
- [OrderPin POS](https://www.orderpin.co/products-pos/): separates order taking, menu, tables, staff, stock, reports and chain operations. Borrow the operational grouping and branch-aware administration. Its broad feature list is a scope reference, not proof of our implementation.

These are directly fetched primary product references, not asserted design-award winners. A Lightspeed page was initially discoverable but subsequent retrieval returned 403; do not rely on its visual details.

Cut gradient washes, animated dashboard numbers, AI-first language, generic “all-in-one” hero cards, decorative charts, unsupported customer counts, fake testimonials, and ornamental card shadows. Current landing copy includes “AI handles 80%” and “Start 14-day free trial”; neither is authorized or evidenced for this offering. Replace rather than carry forward.

## 2. Tokens and typography

| Token | Value | Role |
|---|---|---|
| Canvas | `#F4F7FB` | Quiet workspace background |
| Surface | `#FFFFFF` | Menu, ticket and dialogs |
| Navy | `#142D4E` | Navigation and strongest text |
| Action blue | `#165DCC` | Primary actions, active navigation |
| Secondary ink | `#526176` | Supporting copy on light surfaces |
| Interactive boundary | `#78879A` | Input/control outline when needed |

Use lighter `#DCE3EC` for nonessential separators only; it is not a sufficient focus indicator. Semantic colors may be dark green, amber and red, always paired with words/icons. Recompute contrast for every actual foreground/surface pair during QA. Focus is a 3px action-blue outline with 3px offset on white; on navy use white.

Use a local/system sans stack (`"Segoe UI", Arial, sans-serif`) for the first working build, so offline startup cannot depend on a font CDN. If later using a branded family, ship local WOFF2, use `font-display: swap`, limit to two weights, and verify Arabic fallback explicitly. Tabular numerals for currency, quantities and reports; normal numerals in prose.

Core scale: 14 / 16 / 20 / 25 / 31.25 / 39.06px. Starting at 16px, successive large sizes use 1.25 ratio. 14px is the smallest secondary interface text, not the price or action label. Menu names: 16px/22px at weight 600; price: 16px/22px weight 700; ticket total: 25px/31px. Marketing hero: clamp 32px to 48px, 1.12 line height. Body: 16px/24px. No all-caps labels or widely tracked microtext. Long dish names wrap naturally, with an optional detail view; prices never truncate.

Spacing is a 4px system; main gaps 12/16/24px. Controls use 8px radius, food tiles 10px, modal 12px. Avoid applying the same card treatment to every region. Align names left, quantities centrally, financial values right. Put the unit beside the price: “AED 18.00 / 250 g” only when the source confirms that unit.

## 3. Layout and primary journey

At 1280px: 88px labeled navigation rail + flexible menu area + 340px persistent ticket. Header contains tenant/branch and connectivity status. Search precedes wrapping category chips. Three or four product columns as real remaining width permits; do not force four. Ticket holds order type, items, subtotal/tax/total and one strong next action.

```
[Internext] [Suleman Usman Mithaiwala / Bur Dubai] [Saved on this device]
[Sell    ] [Search menu........................] [Current order       ]
[Orders  ] [All  Breakfast  Sweets  Meals ...   ] [Takeaway / Dine-in  ]
[Kitchen ] [photo/name/price] [photo/name/price] [items + qty controls]
[Reports ] [photo/name/price] [photo/name/price] [total               ]
[More    ] [product grid continues............] [Review payment      ]
```

At 768px: compact header and labeled navigation, 2–3 menu columns. Ticket becomes an accessible sheet/full working panel rather than compressing every column. At 375px: 2 product columns if names and controls remain readable, search and category controls above, navigation via a labeled menu, persistent bottom “Review order · AED 0.00” action. At 320px: 2 columns only when each card is at least 138px wide; otherwise use a single-column compact row with thumbnail, name and price. Ticket/payment takes a full screen with explicit Back. Bottom action reserves its height plus safe-area padding. Do not allow fixed navigation and ticket controls to cover the last product.

Cashier journey: open shift (when configured) → select order type → search/tap item → choose required unit/modifier → review ticket → record cash/card/split payment → receive an order ID → print or reprint → new order. Adding a simple item should require one tap. Payment must never be triggered by the add button. Required variants must be visibly selected before add. Cash entry shows paid amount and change; recorded card payment clearly states it does not charge a card unless a verified terminal integration exists.

For weighted sweets: support a configured unit and decimal quantity; do not infer that all archived prices are per kg. Item quantity and pricing unit must be visible in the ticket and receipt. Mixed boxes need explicit composition/weight rules before implementation.

Order journey: searchable history, paid/unpaid state, fulfillment state and sync state as separate fields. Pending kitchen tickets are not paid sales. Voids/refunds are traceable manager actions, not deletion. Kitchen board uses Waiting → Preparing → Ready, with elapsed time plus text state. Cashier can retry printing without duplicating the sale.

Owner journey: choose restaurant and branch scope → view date-scoped sales with freshness → inspect shift differences → edit menu/availability → manage staff permissions → review subscription. Reports must distinguish this device's records from centrally reconciled data. Do not label local-only totals “all branches”.

## 4. State language, offline and failure handling

Use precise states: “Offline”, “Saved on this device”, “Waiting to sync · 3 orders”, “Synced at 14:05”, “Sync needs attention”. A browser online signal is not proof of successful synchronization. Never show “Synced” from connectivity alone. Offline availability depends on prior installation/cache/setup and actual persistence tests, and must be presented accordingly.

A completed offline sale gets a stable local order ID before a success screen. Retries use that same ID. Never present unsent kitchen tickets as received by another device. Clearly separate saved sale, payment recorded, receipt printed, kitchen delivered and cloud synced. If storage is unavailable, block finalization with a recovery action rather than claiming success. Closing a tab must not silently discard a saved ticket.

Stock while offline is “last known” unless the device has authoritative local stock. Multiple devices cannot promise globally current stock offline. Card terminal status is independent from internet status. Subscription expiry should not erase records; offline grace behavior requires an explicit business decision.

Initial local preview banner: “Pilot preview — menu and counter prices need confirmation.” Do not expose a fake checkout or claim secure multi-tenant hosting until it is implemented and tested. Unavailable features are hidden or explicitly labeled “Planned”, never decorative controls that do nothing.

## 5. Landing page and conversion

One primary conversion in the current build: **Open POS preview**. The public product page should explain the actual proposed subscription and clearly separate preview capabilities from roadmap. Recommended headline: “Your restaurant, ready for the next order.” Supporting copy: “A restaurant POS from Internext, with a web workspace and an Android app planned for counter service.” Update the wording only after APK/offline delivery is verified.

Show the actual working product interface beside concise copy; no fake laptop frame. Then a compact workflow (take order, manage service, close shift), truthful feature availability, AED 100/month subscription intent and contact/onboarding action when a working destination exists. Do not invent a free trial, cancellation policy, hardware inclusion, “unlimited branches”, tax terms, payment integrations or delivery-platform integrations. Avoid using the first customer's legal name or logo as a public endorsement without approval; the tenant badge belongs inside its preview.

## 6. Motion lens

One sustained idea: show the causal movement from menu selection to ticket. A 120–160ms background acknowledgment on the selected tile and updated quantity is sufficient; no flying food, bounce, sound or forced scrolling. Sheet/dialog opening may use 160–200ms opacity/translation; state changes are also expressed in text. No idle animation. Under `prefers-reduced-motion: reduce`, remove transforms and transitions, preserve all confirmations and state information. Do not use animation as the only proof an order was added.

## 7. Authentic asset handling

Reviewed the archive README and authentic-source contact sheet. The commissioned photographs show dishes on light neutral tabletops, which suit the proposed white tile grid. Use exact product-photo mappings from `07-AUTHENTIC-WEBSITE-SOURCE-PHOTOS` or `05-EXISTING-NOON-IMAGE-LIBRARY`; inspect chosen full images before applying a specific label. The `01-RECOMMENDED-CANDIDATES` folder contains generated candidates that still need business approval and is not the default source. Never use rejected drafts.

The archive/export is dated 2026-08-20, not current pricing evidence. Preserve source IDs and mappings during import. Prefer 4:3 thumbnails with contain/gentle crop that does not remove part of the serving; no artificial dish replacement. Missing images use a quiet named placeholder. Derivatives should be local WebP/JPEG with widths 240/480px, explicit dimensions and descriptive alt only where it adds information beyond the adjacent name. Cache only the required image set under an explicit offline storage budget.

## 8. Accessibility, performance and verification floor

- Contrast: body text at least 4.5:1, large text at least 3:1, meaningful control boundaries/icons/focus at least 3:1 against their actual adjacent surface. Status never depends on color alone.
- Primary and counter controls at least 44×44 CSS px; no interactive target below 24×24. Quantity controls need accessible names including the dish. Visible keyboard focus everywhere.
- Entire order entry and checkout path keyboard-operable. Proper dialog focus trap, Escape/Back behavior and restoration. Hidden mobile navigation is removed from focus order with `hidden`, `inert` or `display:none`.
- Semantic landmarks and sequential headings; one clear h1 per page. Search has a persistent accessible label. Errors are linked to fields. Announce add/remove/save results with a polite live region; avoid repeated announcements while typing.
- At every page and major modal at 320, 375, 768 and 1280px, assert `document.documentElement.scrollWidth <= document.documentElement.clientWidth`; test the legal tenant name, longest menu name, large total and long customer name. Verify 200% zoom and reduced motion.
- Target LCP ≤2.5s, INP ≤200ms, CLS ≤0.1 under a documented mobile lab setup. These are acceptance targets, not measured results. Menu filtering and add feedback should respond within 100ms locally. No blocking third-party font dependency.
- Thumbnail target ≤60KB each, explicit dimensions, first visible items prioritized and below-fold images lazy-loaded. Avoid preloading the full archive on every visit. Initial page transfer target ≤1MB excluding a user-triggered offline download.
- Verify HTTP success and decoded image dimensions for every used image, no broken routes/console errors, and served title/description/favicon. Public landing has canonical/OG; private POS should be noindex and must not leak customer data into public metadata.
- Separate critic passes after implementation: one for keyboard, responsive flow and operational failure states; one for repetitive template styling and fit to this specific counter workflow. Findings remain hypotheses until reproduced.

## 9. Questions that affect production, not the first visual preview

Confirm price per branch versus per customer, VAT treatment, POS/printer model, actual counter menu prices/units, table workflow, cashier languages, tax registration/receipt requirements, discount/refund permissions, opening cash rules and offline subscription grace. Web-first implementation should preserve a native printer adapter boundary for the later APK; a website wrapper alone does not establish offline durability or printer support.
