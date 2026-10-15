# POS server foundation — 16 October 2026

This is an **unprovisioned development foundation**, not an enabled live service. Existing legacy product tables and routes are unchanged. Training data must never be silently promoted into customer accounts.

## Private operator provisioning

Only perform these steps against a reviewed staging database first. Production setup/deployment requires the user's approval. Never commit credentials, real staff accounts, receipts or private subscription records.

1. Supply the existing application's `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` environment values. The new routes use the existing cookie-based SSR helper and validate the session with `auth.getUser()`. They do not use service-role credentials.
2. Review/apply `supabase/migrations/20261016000100_pos_platform.sql` and then `20261016000200_pos_operations.sql` through the project's database migration process. The isolated `pos_*` domain does not automatically migrate legacy tenants.
3. In an administrator-only database session, provision an organization, branch, and authorized `pos_staff` memberships using existing `auth.users` UUIDs. The first intended customer is **Abdul Gafoor Suleman Usman Mithaiwala Restaurant LLC**, **Bur Dubai**. No real customer or staff rows are seeded by the migration.
4. Create each cashier device with its own UUID. Open each shift through the authenticated `shift.open` command; it belongs to the signed-in cashier and registered device. A unique index allows only one open shift per device. Device and staff provisioning still require an administrator session; no production onboarding UI has been connected.
5. Import only approved menu entries into branch-scoped `pos_products`, assigning server UUIDs and integer fils. Price is **VAT inclusive** when a nonzero `tax_rate_bps` is configured; 500 means 5%. Default tax is zero until the merchant's tax setup is confirmed. `kg` quantities use thousandths of a kilogram; `piece` and `pack` quantities must be whole numbers. Browser training IDs/prices are not authoritative.
6. Create one `pos_subscriptions` row per branch: AED 100 (10,000 fils) monthly, all features, unlimited staff/devices, manual collection. `paid_through` and collection status are maintained through the authenticated `subscription.update` command. Separately provision platform operators in `pos_platform_admins` using an administrator database session; merchant owner/manager membership does not confer subscription-editing rights. **Subscription enforcement is not implemented**. Recording already-collected offline payments is intentionally independent of current subscription status so financial history is never discarded.
7. Verify authenticated bootstrap and paid-sale sync on staging with two different organizations, two branch-scoped cashiers and two devices. Test real Supabase auth/RLS and concurrent requests before enabling any live client. Offline shifts must be fully reconciled before an operator closes their corresponding server shift; late new sales against a closed shift are rejected and must stay pending.

## Integration contract

`GET /api/pos/bootstrap` returns `{status:'ready',userId,branches,catalogue,devices,shifts}`. Rows use database snake_case; UUID identifiers bind the server's authoritative catalogue and device/shift records. Responses are private/no-store. Missing environment, schema or accessible branch returns HTTP 503 with `setup_required`; unauthenticated calls return HTTP 401. A ready bootstrap does not establish that a device or open shift has been provisioned; consumers must check those lists.

`POST /api/pos/sync` accepts only the strict shape in `contracts.ts`. It calls `pos_record_paid_order` using the authenticated user's database role. It never accepts a caller-supplied organization or actor ID. `expectedTotalFils` is compared with server calculations; it is not trusted. Payments record the amount applied to a sale, not tendered cash before change. Card entries are manual records, not a card processor acknowledgement.

The UUID order key is idempotent: retrying the same canonical JSON payload as the same user returns the existing receipt result. A changed payload for that UUID conflicts. Pricing is checked against the current catalogue, and stale offline prices are rejected for reconciliation; **historical price-version reconciliation is not implemented**. It is unsafe to edit the original paid local receipt to make a stale price match.

Transactions validate membership, branch, active device, cashier-owned open shift, catalogue, quantities, inclusive tax rounding, exact payment total and order total before inserting the order, snapshot lines, payments and audit event together. Errors preserve pending status. Database diagnostics are not sent to clients.

## Current limits

- This API is not automatically connected to the browser training outbox. Cloud synchronization and live onboarding remain disabled until configured and verified.
- The paid-sale sync contract supports completed positive paid orders only. Discounts, modifiers, credit, voids and table transfers are not implemented. Separate operational commands now support server shifts, cash movements and financial refund records, but the training outbox is not connected to them.
- No automatic subscription charging, payment processor, printer driver, shared table locking, production receipt numbering or remote device enrollment has been implemented here.
- Server RLS currently isolates organizations and branch scopes. It does not implement fine-grained owner/manager/cashier report permissions within an authorized branch.
- The bootstrap list queries rely on the database's configured row-return limit. Catalogue pagination is required before large catalogues exceed that limit.

## Verification

`npx vitest run tests/unit/pos/server.test.ts tests/unit/pos/commands.test.ts` exercises input validation, authentication, missing configuration, same-origin mutation checks, conflict handling and required acknowledgements. An isolated PostgreSQL test is included at `tests/integration/pos-schema.mjs`; its header gives the optional disposable dependency installation/run commands. That test executes the real SQL migration and checks RLS, tenant/branch/device boundaries, line rounding, atomic failure, idempotent retries, privilege denial and closed-shift handling. Embedded PostgreSQL verification is not proof of deployment or a substitute for staging Supabase concurrency/session tests.


## Operational command API

`POST /api/pos/commands` accepts `{command:{id,branchId,type,...}}`, with fresh UUID `id` per intended action and the same UUID/payload for retries. All money values are integer fils. The exact strict schema is in `commands.ts`.

| Type | Extra fields | Authorization |
| --- | --- | --- |
| `shift.open` | `deviceId, shiftId, openingCashFils` | Active branch staff; one open shift per registered device |
| `shift.close` | `deviceId, shiftId, countedCashFils` | The shift's signed-in owner |
| `cash.move` | `deviceId, shiftId, amountFils, reason` | Manager/owner; their own open shift; signed amount |
| `refund.create` | `deviceId, shiftId, orderId, method, amountFils, reason` | Manager/owner; their own open shift; original sale in same branch |
| `subscription.update` | `status, paidThrough, reason` | Separately provisioned active platform administrator |

Successful commands return `status:'applied'`, `commandId` and `replayed`. Shift close also returns expected cash, counted cash and the difference. Every accepted command is recorded with its actor, original payload, result and audit event in the same database transaction. Current permissions are intentionally strict: a manager cannot close another cashier's shift or authorize a refund while operating that cashier's server shift.

Refunds lock the original order and cap the sum of refunds **per original tender** across all devices. Thus cash refunded cannot exceed that order's cash payment and card refunded cannot exceed its card payment. Drawer reconciliation includes cash refunds in the shift actually paying them out. A refund is a financial record only: card/other refunds do not call a payment processor; no cash is physically dispensed. Item-level return allocation, VAT credit-note generation, inventory restocking and external refund settlement remain pending. Do not use this foundation as a compliant production returns workflow before those requirements are resolved.

Close a server shift only after its local offline queue is fully synchronized. The server cannot know that a disconnected device still holds unsent sales. Newly arriving sales after server closure will remain pending for operator reconciliation; accepted receipts are never silently discarded.

`tests/integration/pos-operations.mjs` executes both migrations in disposable PostgreSQL and verifies shift ownership, independent devices, idempotency, per-tender cross-device refund limits, manager/cashier/platform-admin separation, manual subscription changes and drawer reconciliation. Tests validate sequential database behavior and locking logic, not simultaneous multi-backend production concurrency; staging concurrency tests remain required.

## Legacy integration release gate

The unrelated legacy WhatsApp webhook is disabled by default for GET and POST. It returns 404 before database lookup, AI work or outbound messaging unless `ENABLE_LEGACY_WHATSAPP_WEBHOOK=true` is explicitly configured. Even when enabled, POST requires `META_APP_SECRET` and a valid `x-hub-signature-256` HMAC over the request body; GET requires a configured verification token. No integration has been enabled by this work.

Do not enable this legacy integration for production until inbound message-ID deduplication/replay protection and transactional processing have been implemented and tested. Signature verification authenticates a delivery but does not make webhook retries idempotent. The new POS frontend does not call this integration. Existing AI API routes call `requireSession()` before their AI/database work; no anonymous AI API bypass was found in this narrow review.

The separate legacy Stripe client is initialized only when a request has configured credentials. Importing billing routes during a production build requires no Stripe key. Missing checkout key/price/app URL or missing webhook key/secret returns HTTP 503 `BILLING_NOT_CONFIGURED` before authentication/database/provider work. This does not enable automatic collection for the new manual POS subscriptions; no placeholder key is supplied.
