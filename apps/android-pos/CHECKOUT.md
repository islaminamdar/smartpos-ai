# Android counter candidate

The counter now has a native catalogue, quote, payment-intent and receipt bridge. **Production issuance is still disabled in the native constructor.** JavaScript, an account role, a remote feature flag or an injected browser response cannot enable it. The package-private enabled constructor exists for isolated native tests only. This is an internal candidate, not an APK for restaurant deployment.

## Counter workflow

The signed menu supplies product names, units, prices and tax rates. Staff choose dine-in, takeaway or delivery, whole pieces/packs or exact weight quantities, buyer details, and planned cash or externally recorded card tender. Android calculates the displayed quote and change. No price, tax rate, invoice number or clock input is accepted from JavaScript. Card recording does not charge a card.

Before collecting any money, the counter saves a payment intent with a fixed ID and immutable request. Only a separate, explicit confirmation issues the receipt. The engine recalculates and checks the original scope, native PIN, clock, remaining invoice numbers and monetary budget inside the issuance transaction. The bill, outbox entry, number and device chain advance atomically. An identical committed retry returns the original bill.

A lost response is uncertain, not a failed sale. Reopening the counter discovers the saved pending ID. Read that same ID before proceeding. An identical begin retry can recover a saved pending, committed or cancelled result, including while the release gate is paused. It cannot replace the saved basket. New baskets are blocked while any uncollected/uncertain intent remains.

Cancellation requires the original staff scope and PIN, an explicit statement that **no money was collected**, and a reason. It preserves the intent and a separate cancellation record. It is not a refund, card void, cash return or permission to discard a doubtful payment.

## Access and display boundaries

Full buyer details, saved intent requests and receipt details require the enrolled staff account and native PIN. The coordinator checks the original authority before calling engine reads or early replay paths. Locked/signed-out checkout state exposes only pending/last identifiers, and shows the catalogue only to the retained signed-in account. Readiness does not come from browser time.

The older device recovery screen still exposes limited journal summaries (invoice number, time, amount and sync status), along with custody counts and device identity. Those are deliberate recovery metadata; this candidate does **not** claim that every financial summary is hidden while signed out. Full receipt/customer display is the new scoped boundary. Historical signed uploads remain available without staff sign-in so loss of access cannot strand server custody.

## Release gates

If authority expires after collection starts, the pending intent remains preserved and no backdated invoice is issued. The candidate now includes immutable payment freeze, server custody/manager review and native verification of signed full-return/void outcomes; see [PAYMENT-RECOVERY.md](PAYMENT-RECOVERY.md). A saved decision, signed delivery and native acceptance remain separate. Production manager writes remain gated.

Missing-bundle recovery and controlled allocation continuation are implemented as candidates; see [RECOVERY.md](RECOVERY.md) and [NEXT-ALLOCATION.md](NEXT-ALLOCATION.md). Native cash-drawer close, controlled PIN/clock/staff/device-loss recovery, full two-device native/server offline/restart/reconnect acceptance, physical printing and supervised manager acceptance remain pending. Offline bills do not automatically reach the cloud kitchen. SQL017–022 deployment and customer APK release are not implied by candidate tests.

## Verification scope

`NativeCheckoutCoordinatorTest` uses isolated synthetic fixtures with real Android SQLite and Keystore. It tests the gate, scope/PIN reads, immutable intent/replay, interrupted signing, expiry, exact quantities/tenders and native output serialization. Its exported contract samples contain synthetic data only. UI tests exercise bridge validation, stale quotes, explicit collection consent and lost-response recovery. These are separate from a complete production acceptance or platform-wide security audit.
