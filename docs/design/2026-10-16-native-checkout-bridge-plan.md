# Native checkout bridge and recovery plan — 16 October 2026

Status: design proposal against the current native engine. No checkout UI or financial bridge is authorized by this document. The current increment implements reconciliation while new sales remain paused.

## Current engine and required bridge

`NativeCheckoutEngine` already persists an immutable request before collection with `beginPaymentIntent(intentId, input)`, commits through `commitPaymentIntent(intentId)`, reads an identified intent, and records explicit no-money-collected cancellation with a reason. A committed retry returns the original receipt. Unknown intents are not discoverable from the current public UI bridge; menu/quote APIs are also missing.

A future bridge should expose typed summaries, with native code retaining signature verification, money calculation, authority/clock/budget checks and receipt issuance:

| Method | Required result / purpose |
| --- | --- |
| `getCheckoutState()` | Native readiness and reason; exact actor/branch/device/shift/authority scope; verified catalogue snapshot identity/date, tender permissions, supported service types; unresolved intent if any, plus recent committed receipt reference. No network-ready claim from Wi-Fi. |
| `quoteBasket({authorityId, lines, tenderPlan, customer})` | Native line details, inclusive tax/net/gross, cash applied, card amount, cash tendered/change, buyer-details requirement, and exact request identity/hash for the quote. Unknown products or quantities fail closed. The input never supplies product prices/tax. |
| `beginPaymentIntent({intentId, request})` | Persisted native intent with exact request and authoritative quote. The client-generated ID is fixed for this attempt; uncertain calls reconcile against that ID/native unresolved discovery before any replacement. |
| `getPaymentIntent({intentId})` | Canonical state `payment_confirmation_required`, `committed`, or `cancelled`, original request, quote, creation time, and receipt reference when committed. |
| `confirmPaymentIntent({intentId})` | Explicit staff confirmation commits exactly once and returns the native immutable receipt summary/document. Repeated confirmation returns that same receipt. |
| `cancelUncollectedIntent({intentId, reason})` | Explicit confirmation that no money was collected; preserves the original intent and cancellation reason. A completed sale cannot be cancelled through this method. |
| `getReceipt({id})` | Strict typed native document and separate upload status, suitable for readable receipt view; printing requires its own verified transport. |

The exact wire names/fields remain subject to the implementation owner's contract. Read-only native menu/quote must be implemented before a genuine counter screen; a disconnected demo is not an acceptable substitute. Snapshot products currently contain ID, name, category, unit, price, tax and revision, but no images. The initial screen must use honest named product rows unless an actual signed/local image cache is separately supplied.

## Integrated counter flow

Add a Counter view beside This device and Saved receipts. At 1280px use catalogue and basket columns; 375/320px use catalogue then a full-width basket/payment review. Product search and category filtering operate over the verified snapshot. Support dine-in, takeaway and delivery as service types, while explaining that offline dine-in does not update shared tables. Piece/pack quantities are whole units; kg accepts exactly three decimal places. Missing/unavailable catalogue items cannot be created as arbitrary cash sales.

The native quote is the only authoritative money display. Edit quantity/service/customer/tender in a draft; invalidate the previous quote immediately and reject late responses from an older draft or authority. Do not enable collection from a JavaScript subtotal. Native buyer-detail requirements determine whether full name/address and optional valid TRN are required. Refunds, shared tabs and offers remain online-only, without silently converting an existing shared bill or removing an offer.

Choose Cash, Card recorded or Cash + card only if the authority permits it. The current engine freezes `cashTenderedFils` and `recordedCardFils` in the intent before collection. Therefore the UI must label these as the agreed/planned tender amounts and confirm them before saving the intent. It must not imply cash has already been received at that step. If actual tender later differs, do not silently mutate the immutable request: use no-payment cancellation only when nothing was collected; otherwise stop and reconcile. A future engine change separating planned tender from actual confirmation would need its own contract and tests.

The first explicit action is “Save payment step” with “Do not collect payment until this step is saved.” Only native persistence success enables collection instructions. Then show the frozen total, agreed cash, recorded card amount and change. Card wording: complete payment on the separate terminal and verify success; the app does not charge a card. Never request PAN/CVV. The second explicit action is “Confirm payment received · AED …”, requiring an unchecked confirmation bound to that intent. Native commit success shows the official receipt number, amount/tender/change and “Saved on this device · awaiting server confirmation”. It never creates a new payment from a missing acknowledgement.

## Interrupted payment and receipt recovery

On launch and before every new sale, obtain native unresolved intent state. An unresolved intent replaces the new-sale flow with “Payment needs checking” and the original amount/time/items. Do not display an automatic collect-again instruction. Staff verify cash/terminal evidence, then either confirm money already received or attest no money was collected and give a cancellation reason. Uncertainty stays visible and blocks another sale. A committed intent opens its existing receipt; it cannot be cancelled or edited as an unpaid basket.

Failures after collection retain identity and evidence. Expiry, clock anomalies or unavailable storage must not be presented as ordinary no-payment failures. The current engine rechecks authority/time at commit, so an intent that crosses expiry after physical collection requires a defined native manager reconciliation path before selling can be enabled. UI text alone does not solve this gap. Signed-out access or local unlock recovery must preserve original custody and not reassign its actor.

Receipt and kitchen status are separate. Until a verified native dispatch integration exists, say “Not sent to the shared kitchen while offline. Hand this order to the kitchen using your branch procedure.” Do not claim a bill printed, uploaded or dispatched merely because it was saved. Receipt history shows pending/acknowledged status from exact native confirmation. Reconciliation uploads historical records without creating sales, even if preparation expired or the app is signed out.

## Acceptance before enabling collection

Verify native catalogue/quote agreement including kg rounding, all three service types, permitted tenders/split tender, buyer detail thresholds, stale quote rejection, double taps and navigation. Force-stop/restart before intent persistence, after persistence, after external collection, during commit and after committed receipt before UI acknowledgement. Verify money-not-collected cancellation separately from confirmed money received, changed tender handling, expiry during collection, two devices with distinct official numbers, upload failures and exact receipt acknowledgement. Review 320/375/1280px with readable frozen receipts and at least 44px touch controls. Browser fixtures establish UI behaviour only; genuine collection remains gated on native/device acceptance and operational readiness.
