# Online counter pilot — 16 October 2026

This milestone adds authenticated online billing to the separate offline training workspace. Deployment authorization and merchant setup were provided by the owner. Deployment activation and customer-specific records are tracked privately; a successful build alone is not a live release.

## Verified before activation

- Actual private Auth and PostgREST service, two synthetic tenants, row isolation and device binding.
- Eight concurrent retries create one sale and one immutable invoice. Sale and command cancellation races return the existing acknowledgement or prevent delayed submission.
- Concurrent cash withdrawals and full cash refunds cannot overdraw the recorded shift balance.
- Database backup restored into a separate database, including authentication data, receipts, migrations and cash-balance trigger. Server service/socket restart preserves data and connectivity.
- Browser login, enrollment, AED100 opening float, AED6 cash sale with AED4 change, 250g weighted AED15 split payment and full credit note.
- Blocked sale request retained on the original tab and reopened in another tab; recovery followed by a second-tab retry returns the same invoice. Drawer reconciles AED109 with no difference after the synthetic sequence.
- A rejected withdrawal can be cancelled authoritatively without changing the drawer. Offline state disables live financial actions.
- Desktop 1280px and mobile 375px rendered checks; no horizontal overflow on tested counter/receipt views.

Unit tests, typecheck, lint, production build and scoped Semgrep checks accompany release. Tests use synthetic data and do not establish hardware-printer or Android offline reliability. One pre-existing legacy RLS test remains skipped; legacy routes are denied by middleware.

## Manager workflow

1. Open `/counter` on the intended counter browser and sign in with the assigned account.
2. Name and register that counter, then open a shift with the actual cash float.
3. Select items and order type. Confirm external card terminal payments separately where applicable, then save the sale. Wait for the numbered invoice before starting another transaction.
4. Use Receipts for reprints and full returns. Issue a credit note before returning money; return each amount only once and process card refunds on the terminal.
5. If confirmation is interrupted, recover the saved request. Never collect payment twice. If the server cancels an unsaved request, reconcile any money already taken before starting again.
6. Count cash and close the shift at the end of duty.

## Current boundaries

The live pilot is online only. Native APK, offline live synchronization, printer drivers, shared tables/KDS, partial returns and full operational reports are pending. Daily backups are private and remain on the same host; off-host disaster recovery is not configured. Subscription collection is manual and no payment has been assumed. The approved subscription remains AED100 per branch monthly, covering the planned feature set as it is delivered.
