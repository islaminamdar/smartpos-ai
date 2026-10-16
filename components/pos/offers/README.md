# Offer interfaces

`OfferManager({ branchId, deviceId, disabled, onChanged? })` reads the manager-only offers and catalogue APIs. It supports structured percentage, fixed-AED, buy-X-get-Y and exact-product bundle editing; product/category/all eligibility; coupon, usage cap, minimum spend, service channel, manager-only access, activation, Dubai start/end dates and up to 14 weekly windows. Per-customer limits are deliberately absent and always sent as `null` until verified customer identity exists. New offers start paused.

`OfferPicker({ branchId, serviceType, lines, disabled, onSelection })` requests eligible quotes only when the cashier chooses **Check offers**. `lines` is the live sale line shape including current expected catalogue revision. `onSelection(selection, quote)` receives the shared `OfferSelection` and an eligible `OfferQuote`, or two nulls. The parent owns checkout totals, the immutable sale request and final payment acknowledgement.

Only one offer applies per order. Basket, branch, service or coupon changes immediately invalidate the selection and ignore old asynchronous responses. Disabling the picker during payment freezes it without clearing the selected offer needed by an immutable request. Quotes do not reserve use or establish payment success; the authoritative writer checks them again. Private coupon definitions are read only by the manager API; the picker receives eligible sanitized quote definitions.

## Interrupted writes

Before POST, the manager stores the exact command in session storage under `pos-offer-request:<branchId>:<deviceId>`. While pending, editing pauses. Same-tab reload and retry preserve the request ID and payload. A validated matching ACK clears it before refreshing; a later refresh failure is explicitly reported as an already-saved change. Invalid ACK, network/5xx, authentication/authorization failures and unknown conflicts retain the journal.

The only definitive rejection exceptions are HTTP409 `offer_conflict`, HTTP422 `invalid_offer_update`, and HTTP422 `offer_limit`. Their backend contract guarantees no late commit for that command. They clear the journal only after storage removal succeeds, then reload the current definitions before permitting editing. Storage/read/removal or reload failure leaves editing paused. `request_conflict` is never silently discarded. This journal is per tab, not an offline editing queue; the operator must keep the tab available until an uncertain change is resolved.

## Validation

`pnpm exec vitest run tests/unit/pos/offers-ui.test.tsx` covers the four structured benefit payloads, Dubai conversion/weekly windows, null customer limit, immutable retry/restoration, unavailable storage, mismatched ACK, stale edit recovery, unknown conflict retention, removal failure, ACK-versus-refresh failure, unavailable initial data, quote invalidation and stale/cross-branch results.

Component source typecheck passes. Scoped ESLint has no errors; its request-generation cleanup-ref warning is reviewed because this is a monotonically increasing request token rather than a DOM ref. The integrated desktop/mobile browser review is recorded in `docs/design/2026-10-16-offers-review.md`; final server integration and deployment remain separate release gates. Shared authorization, quote schemas, SQL redemption locking and financial transactions belong to the server layer and are not replaced by these UI checks.

`tests/unit/pos/live-offers-ui.test.tsx` adds seven real-component integration cases: basket/service/coupon invalidation changes the checkout amount, the offered sale/payment payload is persisted before dispatch, an exact v2 fiscal ACK completes the sale, valid same-total wrong-product/wrong-offer ACKs stay pending, and response-loss/remount retry sends the identical request. These tests mock the journal's persistence boundary; the existing `online-journal.test.ts` separately exercises actual browser IndexedDB. Both offer UI suites total 22 passing cases.
