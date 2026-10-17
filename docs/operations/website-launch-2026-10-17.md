# Website-first restaurant launch — 17 October 2026

The staff entry point is https://pos.internext.info/counter. The public login belongs to Internext POS. Once the verified Bur Dubai manager signs in, the counter and kitchen display Suleman Usman Mithaiwala's authentic logo and colours. Invoice and credit-note legal details continue to come from each document's immutable merchant snapshot; the logo is decorative and requires an exact tenant, branch and profile match.

The verified live release `076fa03ad175d5a9938a9dc94c1a735d557020d9` includes SQL031–032 for kitchen station setup and station work. The interface is enabled, but new station routing remains disabled for the customer until the restaurant's actual kitchen configuration is commissioned. Existing kitchen tickets remain available through their current boards. No product routing is invented and no older tickets are reassigned.

The existing manager can use online sales, receipts, returns and shift reconciliation. The approved archived menu prices remain the opening prices; unpriced products remain unavailable. Review these with the branch before first service. Do not treat packaged sweets imported as pieces as per-kilogram prices.

Cashier invitations grant branch access to existing verified accounts; they do not create authentication accounts or send email. New-account self-service and forgotten-password emails remain pending mail configuration and verified delivery. See [staff onboarding](staff-onboarding.md).

The existing daily backup job now uses the versioned helper at `deployment/backup/backend-backup.py`. It includes database, backend/web configuration, current release identity and download manifests, validates archive hashes and records a restore inventory. It does not implement automatic offsite transfer or alerts. Those require a configured destination and notification channel. Application/runtime/APK artifacts must be retained separately by their exact hashes. Deployment, exact migration hashes, preservation of existing records and isolated restoration of both the prior and final database schema were verified. An encrypted copy of the final backup was also copied to the owner’s laptop, decrypted and checked against every archived file hash; this is a one-time off-server copy, not an automatic offsite schedule.

## First branch acceptance still needed

- Physical receipt and kitchen printer tests with the purchased equipment.
- Named cashier accounts and staff handover; never share the manager password.
- Manager review of current prices and approval of the remaining unpriced items.
- A supervised first shift with opening float, real sales, returns where needed and closing cash reconciliation.
- Ongoing offsite backups and failure notifications.

Android packaging is deferred while the website is completed. The existing online APK uses the same website, but offline sales and physical hardware compatibility remain unverified/disabled and must not be advertised as complete.

## Verified release acceptance

The release passed 1,468 unit tests (one existing skip), production build/type checks, scoped security review and mobile/desktop checks at 375/1280 px. Hosted acceptance in a separate synthetic tenant verified cash/card sales, decimal weight and VAT allocation, partial/full returns, replay/recovery, report reconciliation and zero-difference cash closure. Hosted kitchen configuration checks covered assignment, recovery, revision conflicts and tenant isolation. Invoice/credit PDFs were rendered and inspected; this does not verify physical printers. The live manager branding and 103 available priced products were checked without enrolling a new customer device or writing a customer bill. Synthetic access was disabled afterward. Existing APK download bytes and Apache access protections were also reverified. Detailed deployment evidence is retained privately.
