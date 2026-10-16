# PayPal branch subscriptions — prepared, not enabled

This domain prepares **US$100 per branch each month**, all features, for an existing authenticated branch manager or owner. It does not modify `pos_subscriptions` (the previous AED100 manual arrangements), provision a merchant, start a PayPal product/plan, or gate/delete POS sale records. The existing customer's pricing decision remains with the owner. Provider credentials and a real sandbox approval/payment/cancellation cycle are still required before enabling live billing.

## Routes and deployment boundary

- `GET /billing`: branch selection, recurring terms, explicit consent, checkout link, canonical subscription status and recent payment ledger. Sign in using `/counter` first. Browser return/cancel query parameters never confirm a payment.
- `GET /api/billing/paypal/status?branchId=UUID`: manager-scoped stored status, environment and recent 100 transactions.
- `POST /api/billing/paypal/checkout`: `{branchId, requestId: UUID, acceptRecurring: true}`. Server generates its own durable checkout UUID; this UUID is the provider request key and custom ID. An uncertain create is retried only with that same UUID. Concurrent checkouts for one branch share the existing nonterminal record.
- `POST /api/billing/paypal/reconcile`: `{branchId}`. Refreshes canonical provider status/payment data.
- `POST /api/billing/paypal/cancel`: `{branchId, confirmCancellation: true}`. Canonical lookup verifies the existing mapping, requests cancellation and reads it back. Already-terminal subscriptions remain terminal. A changed/deactivated plan cannot prevent an already-mapped subscription from being cancelled. Cancellation does not refund prior payments.
- `POST /api/billing/paypal/webhook`: raw provider webhook; cryptographic signature verified with PayPal before storage. No browser-origin check on this endpoint. Every browser mutation requires the existing strict same-origin session check.

Root deployment must allowlist only these routes in addition to current pilot routes. Keep all legacy integrations blocked. Apply migration `20261016000700_pos_paypal_subscriptions.sql` after existing POS migrations and verify readback; never seed actual payments. No provider network request is made when configuration is absent. Responses are private/no-store, and tokens never reach the browser.

## Private configuration

Set `PAYPAL_BILLING_ENABLED=true`, explicit `PAYPAL_ENVIRONMENT=sandbox` or `live`, and the corresponding environment-specific settings:

```
PAYPAL_SANDBOX_CLIENT_ID
PAYPAL_SANDBOX_CLIENT_SECRET
PAYPAL_SANDBOX_PLAN_ID
PAYPAL_SANDBOX_WEBHOOK_ID
```

Live uses the same names with `PAYPAL_LIVE_`. Sandbox never falls back to live credentials. `POS_PUBLIC_ORIGIN` must match the application's exact origin; live requires HTTPS. Existing server-only Supabase URL/anon/service credentials remain required. Do not put these values in `NEXT_PUBLIC_*`, source, reports, screenshots, or browser storage.

An authorized operator must create/approve the PayPal product, recurring plan and webhook in the correct PayPal app. This implementation does not create them. The active plan must contain exactly one unlimited REGULAR monthly cycle, one-month frequency, USD100 fixed price, no quantity pricing, trial, nonzero setup fee, shipping amount or additional tax. Checkout verifies this plan and any subscription overrides against canonical PayPal responses. A mismatch fails closed for a new purchase. Existing mapped agreements continue to reconcile and remain cancellable when a plan is changed/deactivated; commercial uncertainty is stored as `price_review_required` and shown to the manager, never treated as a new entitlement. Tax treatment and PayPal merchant account readiness must be confirmed by the business before activation.

Register the webhook endpoint for subscription lifecycle/payment-failure events and `PAYMENT.SALE.COMPLETED`, `PAYMENT.SALE.REFUNDED`, `PAYMENT.SALE.REVERSED`. PayPal signature verification requires the real app webhook ID. Simulator mock events cannot establish a complete verification test; use actual sandbox events. Signed sale/refund events use a canonical sale lookup to find the agreement and original payment time, then reread that time window from subscription transactions. No caller-supplied URLs are fetched. Subscription ACTIVE is not presented as proof of a completed payment.

## Persistence and recovery

New tables have tenant-scoped read policies and service-only writes through narrow RPCs. Manager/owner membership is rechecked inside mutating RPCs. A unique active record per branch/environment, row locks, expiring lease with fencing token, provider request key, immutable provider mapping, exact event digest deduplication, and unique transaction IDs protect duplicates and races. Event handlers query canonical provider state rather than trusting webhook resource status. Late events cannot reopen a terminal subscription. A lost provider response leaves an unresolved durable record, never success. After 70 hours without a provider ID, creation stops for manual reconciliation before PayPal's documented 72-hour request-key retention expires; do not delete it and create another subscription blindly.

Payment reconciliation walks at most 31 days per request and overlaps the previous three days. Long gaps return `reconciliationPending`; repeat reconcile until caught up. Webhook retries similarly advance a checkpoint. Older refund/reversal webhooks trigger a targeted original-payment window. If webhook delivery is permanently lost, older payment changes outside the overlap require operator reconciliation; no scheduler has been installed. Provider errors and unrecognized response shapes remain unconfirmed. Billing never changes cash sales, receipts, shifts or the customer's legacy manual subscription.

## Validation performed locally

- `pnpm exec vitest run tests/unit/billing`: mocked provider and service regression tests (no external requests) cover absent config/environment separation, exact pricing/cycle restrictions, mapping, approval-link allowlist, minimal create response followed by canonical GET, preserved signed event bytes, signature rejection uncertain cancellation, and mapped lifecycle/cancellation processing after plan changes.
- `node tests/integration/pos-paypal.mjs /path/to/@electric-sql/pglite/dist/index.js`: disposable actual PostgreSQL engine covers branch/cashier isolation, service-only mutations, repeated branch checkout reuse, lease fencing, duplicate events/transactions, terminal protection, uncertain-create retention and unchanged legacy AED records.
- Scoped ESLint, TypeScript and Semgrep checks accompany these tests. Tests do not prove a real multi-session database race or PayPal integration works.

Before live enablement: real sandbox authorization/payment/failure/cancellation and signed webhooks; actual PostgreSQL concurrent request tests; desktop/mobile browser review; external HTTPS webhook reachability; correct merchant-owned PayPal app/plan/webhook; decide existing-customer pricing and billing terms. No live PayPal activity or deployment was performed by this implementation task.

## Official references reviewed

- [Create subscription](https://developer.paypal.com/api/subscriptions/v1/subscriptions-create) and [show subscription](https://developer.paypal.com/api/subscriptions/v1/subscriptions-get)
- [Plan details](https://developer.paypal.com/api/subscriptions/v1/plans-get) and [subscription transactions](https://developer.paypal.com/api/subscriptions/v1/subscriptions-transactions)
- [Idempotency](https://developer.paypal.com/api/rest/reference/idempotency/)
- [Webhook verification and retries](https://developer.paypal.com/api/rest/webhooks/rest/) and [subscription webhook events](https://developer.paypal.com/subscriptions/webhooks)
- [Sale lookup](https://developer.paypal.com/api/deprecated/payments/v1) (legacy sale read is still relevant to subscription sale notifications; verify actual sandbox response shape before enabling)
