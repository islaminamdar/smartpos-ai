# Internext POS

Web-first restaurant POS under development for `pos.internext.info`. Commercial terms: **AED 100 per branch per month**, all planned features and multiple staff/devices included, with subscriptions collected manually initially.

First pilot: **Abdul Gafoor Suleman Usman Mithaiwala Restaurant LLC — Bur Dubai**. Hardware selection is deferred. The next packaging target is an Android APK with bundled assets and local storage, followed by Windows. Neither native package is built yet.

## Run the local preview

```sh
pnpm install
pnpm build
pnpm start --port 3045 --hostname 127.0.0.1
```

Open `http://127.0.0.1:3045/` for the website and `/pos` for the counter. Development mode is `pnpm dev --port 3045`; offline installation is intentionally enabled only in production builds. Do not run development and production builds concurrently in the same checkout.

The public counter is a **training workspace**. It stores orders on this browser/device and cannot activate real selling. Its 5% inclusive tax is a training fixture, not confirmed business tax configuration. Card payments are manually recorded, never charged. Browser print produces a training receipt, not a production tax invoice.

## Working in the training workspace

- Photo catalogue, search, categories and favourites; price/unit/availability editing.
- Dine-in labels, takeaway and delivery orders; manual gram-based weighted sales.
- Basket recovery, held orders, preparation notes and device-local kitchen workflow.
- Cash, externally confirmed card and mixed tender recording; cash change.
- Discounts with reasons, receipt history/reprints and linked tender-capped refunds.
- Opening floats, cash movements, cash counting and shift differences.
- Device-local reports, CSV export and validated JSON backup/recovery.
- Downloadable offline application shell, with isolated update caches and visible readiness.

Do not clear browser storage without a verified backup. Recovery requires the original device identity and an empty destination; it does not merge histories. Retire the old installation before restoring its identity elsewhere.

Offline browser use requires a successful initial download on HTTPS or localhost. Check Settings for readiness before disconnecting. Storage remains subject to browser/OS eviction and user clearing. An Android package needs native persistence and physical-device interruption tests before a manager pilot.

## Menu provenance

The catalogue comes from the local Noon archive captured **2026-08-20**, not a fresh live fetch. It contains 133 source entries, including duplicate names with distinct source IDs. There are 125 matched authentic existing Noon photographs and eight explicit missing-photo placeholders. No generated food images were substituted.

`data/pos/mithaiwala-catalogue.json` records source capture time, source item IDs and original image SHA-256 hashes. Published WebP derivatives retain item-code filenames. Source archive: `Mithaiwala-Noon-Images-Backup-2026-08-20/06-REPORTS-AND-MENU-EXPORT/active-menu.json` and `05-EXISTING-NOON-IMAGE-LIBRARY` in the parent workspace. The archive stays outside this repository.

Thirty entries have zero source base prices; the UI requires a positive reviewed price rather than silently selling them free. All imported prices and units need counter review before live activation. A named fixed pack is not automatically treated as a per-kilogram product.

## Server foundation and remaining work

Two `pos_*` SQL migrations and authenticated APIs implement organization/branch isolation, device-scoped shifts, idempotent order ingestion, operational commands, method-capped refunds and platform-admin manual subscription records. See [server contracts and limitations](lib/pos/server/README.md).

They are **not deployed**, and the training client is **not connected to live synchronization**. Remaining release work includes staff login/enrollment, production menu approval, versioned offline pricing, queue reconciliation, branch-wide reporting, shared table ownership, authorized kitchen amendments, production receipts/credit notes, subscription enforcement and backup operations. Independent devices can store separate training records; shared offline coordination is not implemented.

Later product scope includes inventory/recipes/wastage, purchasing/transfers, customer loyalty, delivery integrations, bilingual operations and customer ordering. All features stay under the agreed per-branch plan, but the website must not describe these as already available.

Legacy AI/WhatsApp/Stripe code predates this POS. WhatsApp is disabled by default and must remain disabled until replay-safe processing is implemented. No external messaging or payment integration is activated by the local preview.

## Verification and release

```sh
pnpm typecheck
pnpm test
pnpm build
```

Real IndexedDB tests run in disposable Chromium through the core test harness. Disposable PostgreSQL migration tests are in `tests/integration/`; their headers describe isolated execution. Neither is proof of physical printer, Android, cloud or live multi-device operation.

Preview desktop and mobile before release. Production deployment requires explicit owner approval; APK distribution requires a signed, tested package. See [current delivery status](docs/plans/2026-10-16-web-pos-delivery.md).
