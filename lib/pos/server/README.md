# POS online pilot server — 16 October 2026

The current server supports an authenticated **online pilot** at `/counter`: branch profiles/catalogue, browser device enrollment, shifts, cash movements, paid invoices, full credit notes, immutable receipts staff management, offers, branch reports, shared preparation tracking for paid orders, and recovery of uncertain requests. `/pos` remains a separate local training workspace. Training data is never promoted into a customer account.

This document describes implemented contracts, not deployment verification. Enable live financial writes only after the real backend, account, device, receipt and browser checks pass. Offline live selling remains disabled.

## Configuration and provisioning

Keep `SUPABASE_INTERNAL_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `POS_PUBLIC_ORIGIN` in private server configuration. The counter uses same-origin APIs and receives no Supabase key or session token in response bodies. The internal backend gateway must remain inaccessible from public networks; disable public GoTrue signup.

`POS_ONLINE_PILOT=true` permits the counter and exact POS API allowlist. `POS_LIVE_SALES_ENABLED=true` separately permits financial submissions. A branch also requires a confirmed merchant profile and `pos_branch_receipt_config.live_enabled=true`. Every legacy application page, provider API and Server Action remains denied regardless of release flags. No provider integration is enabled by this pilot.

Apply migrations in order:

1. `20261016000100_pos_platform.sql`: organization, branch, staff, products, sales and baseline RLS.
2. `20261016000200_pos_operations.sql`: shifts, cash/refund records, audit and restricted manual subscription administration.
3. `20261016000300_pos_live_documents.sql`: versioned merchant profiles, server invoice/credit numbering and immutable fiscal snapshots.
4. `20261016000400_pos_online_access.sql`: login throttling, per-actor device binding and bound financial RPCs.
5. `20261016000500_pos_request_recovery.sql`: atomic committed-result lookup and cancellation tombstones.
6. `20261016000600_pos_cash_out_balance.sql`: prevents cash-outs from making the drawer balance negative.
7. `20261016000700_pos_paypal_subscriptions.sql`: provider subscription state and idempotent events; provider configuration remains separately gated.
8. `20261016000800_pos_catalogue_management.sql`: audited catalogue editing and revision checks.
9. `20261016000900_pos_login_source_limits.sql`: source-specific login throttling.
10. `20261016001000_pos_sale_lock_order.sql`: consistent sale/refund lock ordering.
11. `20261016001100_pos_branch_reports.sql`: scoped reports and exports.
12. `20261016001200_pos_offers.sql`: authoritative offer rules and versioned discounted receipts.
13. `20261016001300_pos_staff_access.sql`: staff permissions, application invitations, authority locks and historical recovery.
14. `20261016001400_pos_kitchen.sql`: transactional paid-order kitchen tickets, shared revision-controlled stages and request recovery. Private release records establish whether this candidate is deployed.

Privately provision the organization, branch, `auth.users` account, active `pos_staff` membership, confirmed merchant profile and approved `pos_products`. Migrations contain no real staff credentials or customer seed records. The first intended customer is Abdul Gafoor Suleman Usman Mithaiwala Restaurant LLC, Bur Dubai. Confirm business details and tax setup through the operator workflow rather than public source files.

Products use integer fils and VAT-inclusive unit prices; 500 basis points means 5%. Kilogram quantities use thousandths of a kilogram, while pieces and packs require whole quantities. Unpriced items must remain unavailable. The profile is immutable: update merchant details by creating a new version and selecting it for subsequent documents.

The existing pilot keeps its approved AED100 monthly manual subscription. New commercial pricing is USD100 per branch/month, with multiple staff/devices. PayPal subscription code is separately gated and must remain unavailable until merchant setup and real sandbox verification are complete. Platform administration remains separate from merchant roles; counter payments never charge subscriptions.

## Authentication and device authority

Login requires an active POS membership and an atomic database-backed limit before password authentication. Tokens use HttpOnly, SameSite Strict cookies with Secure enabled in production. Verification and refresh occur on the server; logout revokes the refresh session. The service-role key is used for login throttling and session revocation, not for bypassing financial transaction authorization.

Device cookies contain random opaque tokens and are scoped by authenticated actor. The database stores only their hashes. Switching accounts cannot overwrite the original actor's device credential. Enrollment creates a distinct device; an existing actor binding cannot silently change device or branch. The financial RPCs enforce user, membership, active device and binding themselves, in addition to HTTP checks. Each cashier owns an independent shift, with one open shift per device.

All browser mutations require a same-origin `Origin` header. Responses containing account or financial data are private/no-store. Missing setup returns503, unauthenticated access401 and invalid authority403; database diagnostics are not exposed.

## Current HTTP contracts

The source of truth is `live-contracts.ts`; immutable profile/document validation is in `documents.ts`.

| Endpoint                         | Contract                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/pos/session`          | `{email,password}` → `{status:'authenticated',userId}`                                                                            |
| `GET /api/pos/session`           | Verify/refresh the current session                                                                                                |
| `DELETE /api/pos/session`        | Revoke refresh session and clear auth cookies                                                                                     |
| `GET /api/pos/bootstrap`         | Validated camelCase `LiveBootstrap`: profiles, catalogue, branch roles/`canSell`, bound device, open shifts and expected cash     |
| `POST /api/pos/devices`          | `{branchId,name}` → `{status:'enrolled',device}` and HttpOnly binding cookie                                                      |
| `POST /api/pos/sync`             | `{order:LiveOrder}` → `{status:'synced',orderId,totalFils,taxFils,replayed,receipt}`                                              |
| `POST /api/pos/commands`         | `{command:LiveCommand}` → matching `{status:'applied',commandId,replayed,...}`                                                    |
| `GET /api/pos/kitchen`           | `branchId`, `deviceId`, optional paired `afterIssuedAt`/`afterOrderId` → private paged kitchen tickets and complete active counts |
| `POST /api/pos/kitchen`          | Strict `KitchenCommand` → canonical original ticket revision acknowledgement                                                      |
| `POST /api/pos/kitchen/recovery` | Exact original `KitchenCommand` → committed acknowledgement or immutable cancellation                                             |
| `GET /api/pos/receipts`          | Required `branchId`; optional `orderId` or stable `cursor`; up to100 immutable snapshots with `nextCursor`                        |
| `POST /api/pos/recovery`         | `{kind:'sale'                                                                                                                     | 'command',request:exactOriginalInnerObject}`→ original committed acknowledgement or`{status:'cancelled',requestId,kind,replayed}` |

Financial commands are `shift.open`, `shift.close`, `cash.move` and `refund.full`. Cash movements and full returns require manager/owner authority and that actor's own open shift. A manager cannot close another cashier's shift. Close results contain expected cash, counted cash and their difference.

Live orders require the active profile ID, buyer metadata or null, cash tendered, authoritative catalogue references and expected prices/taxes/totals. The server recomputes amounts. Payments record amounts applied to the sale; cash change is separate. Card entries are manual records, not payment-processor acknowledgements.

Invoice and credit numbers are assigned transactionally on the server. The receipt stores merchant, item, tax, total and payment snapshots, so later profile/menu changes cannot rewrite an issued document. The pilot supports full invoice reversal only. A full credit note reverses original line/tax/tender amounts; cash refunds require sufficient drawer cash. It does not initiate external card refunds or physically dispense cash.

## Uncertain results and cancellation

Persist a fresh UUID and frozen request **before** dispatch. Retry the same ID and exact payload until a matching validated acknowledgement arrives; changed payloads conflict. Never manufacture a success receipt from local basket data.

The recovery RPC takes the same transaction lock as the financial operation. If already committed, it returns that operation's canonical acknowledgement. Otherwise it writes an immutable cancellation tombstone, which prevents a delayed original from committing. It never deletes financial history. Recovery remains available while the global financial-write flag is paused. Cancellation does not return physical money: the operator must reconcile any amount already collected.

The browser journal permits one pending financial request per actor across tabs. An uncertain response, failed local acknowledgement, expired session or network outage must preserve that request. Offline browser training remains independent and cannot submit to these live APIs.

## Verification and limits

Targeted unit tests cover cookie/session behavior, login limits, origin checks, branch/device authority, input validation, response acknowledgement, per-actor binding and release gates. Disposable database tests execute the actual migrations: `pos-schema.mjs`, `pos-operations.mjs`, `pos-documents.mjs`, `pos-online-access.mjs` `pos-recovery.mjs` and `pos-cash-out.mjs` under `tests/integration`. Their headers describe the disposable runtime invocation.

Local checks do not establish production configuration, real Supabase session behavior or concurrent multi-backend transaction safety. Verify those on the actual isolated backend before activation, including two tenants, staff roles, devices, concurrent retries and cancellation races.

Remaining limits include offline live reconciliation, partial/item returns, modifiers, stock restocking, unpaid shared orders/table coordination, external card settlement, printer hardware delivery, automatic subscription enforcement and fine-grained report permissions within a branch. Receipt reprinting uses immutable records but does not confirm physical printer delivery.

## Foundation compatibility

The original schemas in `contracts.ts` and `commands.ts`, and baseline RPCs from migrations001/002, are retained for historical tests and internal compatibility. They are **not the current counter HTTP contracts**. Profile-enabled branches reject the older financial paths; private foundation/unbound functions are not executable by authenticated clients. Legacy Stripe, WhatsApp, AI and printer routes remain outside the hosted allowlist and must not be enabled through this pilot.

## Login source throttling (migration009)

Public deployment must explicitly set `POS_LOGIN_SOURCE_MODE=apache-rightmost`. This trusts only the final `X-Forwarded-For` IP appended by the sole inbound Apache proxy; never the leftmost caller-provided value. The application listener must remain loopback-only, Apache `ProxyAddHeaders` must remain enabled, and any `mod_remoteip` trust lists must remain constrained. Read-only host verification on 2026-10-16 confirmed the scoped SSL proxy points to127.0.0.1:3046, listener is loopback-only, no ProxyAddHeaders override, and remoteip configuration trusts loopback/internal and explicit Cloudflare CIDRs. Apache's documented default is `ProxyAddHeaders On`. No Apache configuration was changed. Revalidate the trust contract whenever proxy/CDN topology changes, and verify spoofed leading XFF values still share the same source budget after deployment.

Migration009 adds `(p_key,p_source)` and temporarily preserves a service-only one-argument compatibility overload for release rollback. The old overload keeps account throttling and removes the shared global counter; only the new route adds source throttling. Deploy the updated route with its private environment flag, then retire the compatibility overload in a later migration after the rollback window. New logins fail503 when source mode/header is missing or invalid. Already authenticated reads/sales are unaffected. Each validated source has60 attempts/minute and each normalized account10 attempts/15minutes, with no globally exhaustible counter. IPv4 mapped addresses normalize together and IPv6 uses a /64 budget. Requests behind the same legitimate NAT share that source budget. There is no claim of eliminating distributed brute force or targeted account lockout.

For a local preview only, explicitly use `POS_LOGIN_SOURCE_MODE=loopback-development` with a literal loopback `POS_PUBLIC_ORIGIN` matching the request origin. This accepts no public origin. Test source parsing with `tests/unit/pos/login-source.test.ts` and isolated PostgreSQL budgets with `tests/integration/pos-login-source.mjs`.

## Kitchen projection and authority

Kitchen tickets project only new immutable invoices, in the same transaction, and contain no prices, customer details, tender or coupon data. Full credit notes cancel matching tickets transactionally. The board is a paged online polling view, not a physical print queue. Stage changes require active branch staff and their bound device, without requiring a cash shift. Forward movement is adjacent; backward corrections require a manager and a reason.

Kitchen writes take shared staff authority lock15, request lock18, then device, order and ticket locks. Recovery uses the same request lock and immutable cancellation records. An inactive original actor may retrieve their own exact committed result only. Replacement bindings must belong to the same actor and branch and original device ownership is checked independently. See `docs/plans/2026-10-16-live-kitchen-contract.md` and the isolated/concurrent verification records for scope and limitations.
