# Live counter pilot: source audit and implementation contract

Date: 2026-10-16. Scope: current repository, read-only audit before live enablement. Deployment authorization does not establish that financial workflows are ready. No hosted database, production account, merchant configuration or actual bill was verified by this audit.

## Finding and release boundary

The existing web workspace is a functioning local **training** system. `PosWorkspace.tsx` creates a hard-coded training organisation/branch, imports archived menu data and uses `TRAINING_TAX`. `local-store.ts:requireTraining` rejects live mutations. `sync.ts` reports zero uploaded events; it has no transport or acknowledgement implementation. Publishing this build alone will not provide real counter sales or cloud-backed bills.

The authenticated server is a foundation: bootstrap, paid-order and operational-command routes, RLS and transactional idempotent SQL functions exist. They do not configure or connect the current workspace. Legacy signup creates `tenants/users`, whereas POS authorisation uses `pos_organizations/pos_staff`; login redirects to `/dashboard`. Existing signup is not POS provisioning.

Recommended first release: a supervised **online live pilot** for the approved Bur Dubai branch, with authenticated staff, enrolled devices, approved prices, opening shifts, cash/manual recorded card/mixed payments and immutable real receipts/reprints. Enable only the flows supported end to end. Each approved device owns its orders and shift. Browser printing/download can serve the web pilot; printer hardware is deferred. This is an initial boundary, not a substitute for the requested multiple-device offline product.

Enable offline live sales separately after versioned price acceptance, receipt allocation, actor/device authorisation, durable acknowledgement and reconciliation tests pass. Do not convert training records into live transactions.

## Required changes, in priority order

| Priority | Observed source gap | Required implementation / acceptance |
| --- | --- | --- |
| P0 | `app/(auth)/actions.ts`, `api/pos/bootstrap`: legacy onboarding and incomplete POS identity/config response | Provision real auth users, organisation, branch, staff roles and devices; route login to selected authorised POS scope. Return capabilities and server-owned merchant configuration. Verify deployed RLS with two tenants. |
| P0 | `PosWorkspace.tsx`, archived catalogue, `pos_products`: archive IDs/prices are not authoritative UUID catalogue | Import with explicit source-to-product mapping; merchant approves current counter prices, piece/pack/kg units, tax settings and availability. Disable unapproved prices. Preserve immutable catalogue revisions. |
| P0 | `money.ts:calculateTotals` rounds tax once per order; SQL `pos_record_paid_order` rounds per line | Use one documented deterministic algorithm. Two separate AED3 lines at 5% produce 29 fils under original local algorithm, 28 on server. Allocate discounts per line deterministically before tax; current server contract rejects discounts. Version new calculations and preserve old paid receipts/backups. |
| P0 | `local-store.ts`, `sync.ts`: no live adapter or acknowledged outbox | Add durable immutable requests, original actor/config versions, dependencies, retries and matching acknowledgements. Never report cloud success from a local write or HTTP dispatch. Never upload old cashier events under a new cashier identity. |
| P0 | SQL orders have no receipt number or legal profile; local number is device suffix plus array length | Persist branch-approved numbering and immutable merchant/tax/line snapshots. Online pilot can allocate on server atomically. Offline needs server-issued unique device namespace/range/epoch and atomic durable counter. Never renumber after sync. Enforce uniqueness server-side. |
| P0 | `pos_record_paid_order` validates against current active price and product | Offline sale at a previously authorised price is rejected after catalogue changes. Accept referenced immutable authorised revisions within explicit offline policy; never silently reprice an already paid sale. Deactivation/revocation conflicts require visible reconciliation. |
| P0 | Commands close shifts using only server records; local closes do not drain uploads | Online close waits for all preceding operations and reconciles a sequence/watermark. Offline close is a frozen pending-close intent until server ledger agreement, not a final cloud close. No lost or late sale behind a closed shift. |
| P0 | Devices are active database rows, with no installation binding/offline grant | Implement enrollment and device revocation, actor-bound offline lease, clock/grace policy and explicit lock on expiry. Restore must retire the previous installation/receipt epoch before re-enrollment; cloning a backup must not create two writable devices with the same identity. |
| P1 | Training UI has unrestricted manager actions; bootstrap omits capabilities | Enforce roles in both UI and server. SQL cash/refund requires manager/owner, but also requires shift `opened_by` to equal actor: manager approval on a cashier shift needs a real approval contract. A typed manager name/PIN is not authority. |
| P1 | Local refund ledger is own-device; SQL allows same-branch refunds across devices | First live refunds should be online-only, server-capped and idempotent. Offline cross-device refunds need an authority/reservation model. Add item/tax allocation and receipt/credit-document linkage; manually recorded card refunds do not process a terminal refund. |
| P1 | Sync request lacks notes, labels, cash received/change, line identity, discount, expected tax and configuration revision | Extend the versioned request/receipt contract before promising these fields survive sync. Current payments are applied amounts; tendered cash must not be submitted as retained cash. Unsupported operations stay disabled or visibly pending. |
| P1 | `subscriptions` and subscription command exist; no operational entitlement policy | Confirm manual AED100-per-branch activation/renewal process and offline grace. Return entitlement. Do not discard historic financial events because subscription expires. Default database trial is not proof a trial was granted. |
| P1 | Backup restore is training-only; branch RLS read access is broad | Design authenticated live recovery, logout/lock and device-local data retention separately. Decide cashier report visibility and protect it server-side. Public service-worker shell caching must not cache authenticated API responses. |

The local single-record IndexedDB snapshot is adequate for a small supervised prototype but needs measured growth/retention testing before sustained counter use. Shared-table editing/settlement and cross-device kitchen dispatch have no conflict authority yet; do not enable those as shared live workflows.

## Authoritative setup required

Collect and approve the exact legal entity name, branch business address/contact, currency/timezone, tax registration state and TRN where applicable, confirmed inclusive/exclusive tax treatment/rates, receipt wording and numbering policy. The current provisional 5% constant is not confirmation of registration or the correct treatment of every product. Obtain the merchant's approved configuration; this audit does not establish legal compliance.

Also require the current counter menu and UUID mapping, approved weighted-item rates, staff auth identities/roles, device labels, opening cash, discount/refund authority, cash-drawer rules and subscription/offline grace policy. Do not invent absent values or infer pack sizes from pictures.

Proposed server-owned profile contract:

```ts
type MerchantReceiptProfile = {
  version: string; organisationId: string; branchId: string;
  legalName: string; branchName: string; address: string; contact?: string;
  currency: 'AED'; timezone: string;
  taxRegistration: { status: 'registered'; trn: string } | { status: 'not_registered' };
  taxPolicy: { version: string; inclusive: boolean; rounding: 'line-v2' };
  confirmedBy: string; confirmedAt: string;
};
```

This is a proposal, not an implemented database schema. Authorisation must control who can confirm it; a caller-supplied `confirmed:true` is insufficient. Product tax classifications belong to the approved catalogue revision. Snapshot profile/version on each paid receipt; later profile edits cannot alter historical bills.

## Proposed application contracts

`GET /api/pos/bootstrap` v2 should return authenticated actor and capabilities, authorised branch choices, merchant profile, immutable catalogue/tax revision, server time, enrolled device identity/epoch, active shift, receipt allocation and offline entitlement expiry. Select organisation from authenticated membership, never arbitrary client input. A public training route may remain separate.

Local live mutation should commit financial record + stable outbox envelope + receipt counter in one IndexedDB transaction. Suggested envelope: `{id, version, actorId, branchId, deviceId, epoch, sequence, dependsOn, createdAt, payload, payloadHash, status, attempts, nextRetryAt, lastError, acknowledgement}`. Statuses: pending, sending, synced, blocked. An interrupted sending attempt retries the same immutable operation; changing its payload requires an explicit new operation, never editing a paid original.

Dependency order: shift.open acknowledgement → sale/cash operations → refund after its original sale exists → shift.close with acknowledged ledger watermark. Preserve original actor authorisation across reconnect; revoked access is a reconciliation case, not permission to forge a new actor. Failed/quota-limited local writes must never produce a success receipt.

Current paid-order adapter rules, once supported:

- Use `Sale.id` as order UUID, not a newly generated outbox UUID. Use stable outbox IDs for command retries.
- Map approved product UUIDs; counted quantity → `quantityMilli = quantity * 1000`; kg grams → `quantityMilli = grams`. Preserve approved unit metadata.
- Send cash retained after change and recorded card amounts, excluding zero amounts. Add separate customer tender/change receipt fields.
- Require acknowledgement of exact order ID, request hash, canonical receipt number, total and tax. Preserve immutable originals and display conflicts separately.
- Current strict server contract supports no discounts. Implement the same discount allocation and tax calculation server-side before enabling live discounts; never strip discounts during sync.

For offline-capable live sales, extend paid-order request with catalogue revision, tax/profile revision, receipt allocation/number, device sequence, original actor grant, immutable line IDs and expected line tax/discount amounts. Server verifies issued revision/grant and recomputes totals using the same versioned algorithm. Conflicts are visible and retain the original money record.

## Verification gates

1. Staged real auth/RLS: two organisations, manager/cashier restrictions, revoked device/staff, incorrect branch and legacy signup do not gain access.
2. Money: separate AED3-line rounding, weighted grams, tax-zero, discount remainder allocation, mixed tenders/change, shared bounds; identical client/SQL results.
3. Idempotency: concurrent duplicate submits and lost acknowledgements produce one sale/receipt; restart/reconnect reuses IDs; changed replay is rejected. Test actual concurrent database sessions, not only sequential RPC tests.
4. Offline: two enrolled cashiers independently sell, close/reopen browsers, reconcile unchanged historic prices after catalogue update, and receive distinct receipts. Expired grants, clock drift, storage failure and duplicate-device restore cannot silently lose or duplicate money.
5. Shifts/refunds: close with pending events fails or stays pending; server/client cash totals agree; concurrent refund caps hold; card refund is clearly recorded versus externally processed.
6. Bills: inspect the actual merchant-approved rendered bill and reprint/download; reprinting creates no new sale, later menu/profile edits do not change it. Printer integration is a separate deferred test.

Evidence sources: `lib/pos/{types,money,local-store,sync}.ts`; `components/pos/PosWorkspace.tsx`; `lib/pos/server/{contracts,commands,client}.ts`; `app/api/pos/{bootstrap,sync,commands}/route.ts`; `app/(auth)/actions.ts`; `supabase/migrations/20261016000{1,2}00_pos_*.sql`; `lib/pos/server/README.md`; `tests/unit/pos/*`.

## Bounded preparation completed after this audit

The observed tax drift above has now been fixed for **new local sales**: `line-v2` rounds each line's tax and sums it, matching the existing undiscounted SQL algorithm. Order discounts use proportional integer-fils allocation, largest remainder first, with ties broken by immutable line ID; tax is calculated on each discounted line. Reordering a basket does not change allocation. Current live server requests still reject discounts; their server-side implementation remains required before live discounts can be enabled.

New paid records persist `calculationVersion: 'line-v2'`. Historical unversioned records retain `order-v1` validation and their original totals. No database migration rewrites past receipts. A real Chromium IndexedDB regression restores an unversioned 29-fils-VAT receipt, retries it unchanged, creates a new 28-fils receipt, and successfully re-exports/revalidates both. Targeted money/storage/server tests: 25 passed. Scoped Semgrep on the three changed core files: zero findings, with one partial-parser warning on the existing `asserts value is CartLine[]` signature in `local-store.ts:59` (not a full security certification).

Status: source audit and bounded rounding preparation complete. Hosted provisioning, live connection, real receipt configuration, offline live reconciliation and merchant counter acceptance remain unverified/pending. Live mutations remain disabled. Merchant profile schema remains a proposal pending the authoritative setup above.
