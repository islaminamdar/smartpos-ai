# Web POS delivery and acceptance

## Accepted decisions — 2026-10-16

The user superseded the original native-first proposal: build the web app and commercial website first, then package Android with offline storage, then Windows. Use `pos.internext.info`. AED 100 per branch/month includes all features and multiple staff/devices; collect subscriptions manually initially. First pilot is Abdul Gafoor Suleman Usman Mithaiwala Restaurant LLC, Bur Dubai. Include dine-in, takeaway, delivery and weighted sweets. Hardware compatibility will be tested later; hardware selection does not block web implementation.

## Current scope

The delivered local build is a functional training counter and website, plus an isolated server foundation. It is not a production-ready restaurant SaaS or APK. The training UI blocks live activation and labels device-local financial and kitchen records. Archived menu data is unverified for counter pricing.

Implemented features and source provenance are documented in the root README. Backend contract gaps are tracked in `lib/pos/server/README.md`. These boundaries are intentional release gates, not completed functionality.

## Pilot sequence

1. Review the local desktop/mobile experience and confirm counter prices, units, availability and tax details.
2. Provision a staging database and authenticated staff/device enrollment. Connect transactional queues, server-issued branch identities, production shift operations and reconciled reporting. Test duplicate delivery, price changes, separate-device refunds and interrupted synchronization.
3. Add branch-local coordination or explicit device ownership for tables/kitchen work during internet loss. Disconnected cashiers must never imply their local view is current across devices.
4. Implement production invoice numbering, business details, credit notes, authorizations and audit events; verify the applicable requirements before release.
5. Build a bundled Android package with native durable storage and printer adapters. Test actual device cold-start without internet, power loss, full storage, reconnect, cash drawer and receipt/kitchen printing. Sign and retain recoverable signing assets privately.
6. Obtain approval for production deployment, then back up and deploy via direct SSH. Pilot one branch; reconcile a full shift against independent records before expanding.

Inventory, purchasing, recipes, wastage, loyalty, customer ordering, delivery connectors and Windows packaging follow the verified counter foundation. They remain planned within the agreed subscription rather than hidden paid add-ons.

## Verification record

Observed on 2026-10-16:

- Production build passed after optional legacy Stripe/OpenAI clients were made lazy and fail-closed when unconfigured. All 22 routes generated. Sentry configuration warnings remain nonblocking.
- Full unit suite: 45 passed, one pre-existing legacy RLS test skipped. The new POS database policies were separately exercised in the disposable PostgreSQL tests; the skipped legacy test is not reported as passed.
- Both real SQL migrations executed in isolated PostgreSQL. Tests covered organization/branch/device boundaries, permissions, idempotency, atomic rejection, tax rounding, stale prices, shift ownership, per-method refunds and manual subscription administration.
- Core tests used disposable Chromium IndexedDB for duplicate requests, quota failure rollback, cross-scope isolation, backup validation, atomic kitchen holds and prevention of checkout/kitchen mismatches.
- Semgrep root scan: 210 rules across 14 POS UI/core/API files, zero findings. Separate optional-integration review: 210 rules across five files, zero findings. This is a scoped check, not a whole-repository security certification.
- Original SHA-256 hashes verified for all 125 used source photos. All 130 checked public assets returned HTTP 200. The build gate validates catalogue identity/assets and rejects both previous unsupported marketing claims; deliberate invalid fixtures exited 1.
- Actual production browser: opened a shift with AED 100; recorded AED 35 cash sale with AED 50 received and AED 15 change; disabled network and reloaded; recorded AED 5 and weighted 250 g at AED 80/kg (AED 20); reloaded again and found all three receipts. Reconnected, recorded a linked AED 5 partial refund and closed with AED 155 counted, zero difference.
- Two independent rendered reviewers inspected real screenshots. Landing/POS overflow checks passed 320, 375, 768 and 1280 px. Phone navigation/basket keyboard wrap, Escape and focus restoration were exercised. A narrow mobile pilot-name column was corrected by placing the status below the text. A renderer compatibility defect in the background inert attribute was found and fixed with native DOM properties; final rebuilt verification is recorded in the private task log.
- The production counter cached successfully; a downloaded update waited for the old tab to close and activated on reopening. Automated worker tests additionally verified failed-download rollback preserves the old cache. Browser restart/physical Android power-loss behavior is not claimed.

No production deployment, live database provisioning, payment charge, APK build, printer delivery or manager distribution has occurred.
