# Website-first restaurant launch — 17 October 2026

The staff entry point is https://pos.internext.info/counter. The public login belongs to Internext POS. Once the verified Bur Dubai manager signs in, the counter and kitchen display Suleman Usman Mithaiwala's authentic logo and colours. Invoice and credit-note legal details continue to come from each document's immutable merchant snapshot; the logo is decorative and requires an exact tenant, branch and profile match.

The intended release includes SQL031–032 for kitchen station setup and station work. The interface is enabled, but new station routing remains disabled for the customer until the restaurant's actual kitchen configuration is commissioned. Existing kitchen tickets remain available through their current boards. No product routing is invented and no older tickets are reassigned.

The existing manager can use online sales, receipts, returns and shift reconciliation. The approved archived menu prices remain the opening prices; unpriced products remain unavailable. Review these with the branch before first service. Do not treat packaged sweets imported as pieces as per-kilogram prices.

Cashier invitations grant branch access to existing verified accounts; they do not create authentication accounts or send email. New-account self-service and forgotten-password emails remain pending mail configuration and verified delivery. See [staff onboarding](staff-onboarding.md).

The existing daily backup job is being updated with the versioned helper at `deployment/backup/backend-backup.py`. It includes database, backend/web configuration, current release identity and download manifests, validates archive hashes and records a restore inventory. It does not implement automatic offsite transfer or alerts. Those require a configured destination and notification channel. Application/runtime/APK artifacts must be retained separately by their exact hashes. Deployment and isolated database restoration must be verified and recorded privately before reporting this release as live.

## First branch acceptance still needed

- Physical receipt and kitchen printer tests with the purchased equipment.
- Named cashier accounts and staff handover; never share the manager password.
- Manager review of current prices and approval of the remaining unpriced items.
- A supervised first shift with opening float, real sales, returns where needed and closing cash reconciliation.
- Ongoing offsite backups and failure notifications.

Android packaging is deferred while the website is completed. The existing online APK uses the same website, but offline sales and physical hardware compatibility remain unverified/disabled and must not be advertised as complete.
