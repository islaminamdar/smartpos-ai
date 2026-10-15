# Hosted release and live-counter gate

The owner approved deployment on 2026-10-16 and subsequently approved archived Noon prices as the opening price list, with unpriced items unavailable. This is authorization to deploy, not evidence that live billing has been implemented.

## First hosted release

`POS_PUBLIC_RELEASE_ONLY=true` is mandatory on the initial service. Only homepage, training counter, static assets and a read-only health endpoint are available. Legacy application routes and Server Actions are denied. Financial APIs return an explicit setup-required response. The health response must show `liveSalesEnabled:false` and `selling:training_only`. No training records are uploaded or converted to live transactions.

Next.js was upgraded from 14.2.35 to the maintenance release 15.5.28, identified as patched in the [official 14 October 2026 security update](https://nextjs.org/blog/nextjs-security-update-october-14-2026). The unused shadcn CLI was removed. Build-only CSS dependencies were moved to development dependencies, and compatible dependency fixes pinned in `pnpm-workspace.yaml`. Production dependency audit was rerun; its result is recorded in the private release log. Development/build advisories are not silently classified as fixed merely because those tools are absent from the runtime.

The deployed runtime uses a standalone build, a dedicated service user, a loopback listener and a scoped Apache reverse proxy. Provider credentials and private runtime settings stay outside the release. The existing Internext apex website and mail records must be preserved. Backups, infrastructure details and deployment evidence live in the private task record, not this public repository.

## Package and verify

Build with `POS_PUBLIC_RELEASE_ONLY=true pnpm build`, run tests, review/commit changes, then run `node scripts/package-pos-release.mjs /absolute/new/release-directory`. Transfer that directory over SSH using the verified hosting plan. Do not publish the source repository or environment files as the document root.

Before switching the current-release symlink, verify the artifact's source commit and file hashes. Keep the prior release for rollback. Confirm the loopback health response, HTTPS domain, static assets, homepage, training checkout and browser offline reload. Verify POST to public pages, legacy endpoints, financial APIs and image optimizer cannot bypass the initial release restriction. Confirm the existing apex site remains available.

## Real customer bills remain blocked

Do not remove the hosted release restriction solely because the web page is reachable. Staff authentication, POS organization/branch/device provisioning, authoritative catalogue/profile, server receipt issuance, persistent synchronization, ledger reconciliation and tested backups are still required. Follow `2026-10-16-live-pilot-gap-audit.md`.

The manager login email and VAT configuration still require confirmation. A registered merchant's tax invoice needs its verified name, address and TRN alongside the invoice details; see the [FTA tax-invoice guidance](https://tax.gov.ae/Datafolder/Files/Pdf/2023/Knowledge%20Center%20Page/VAT11%20-%20Tax%20invoices%20En.pdf). A training receipt cannot be relabeled as a production tax invoice. This source is a requirements reference, not a claim of compliance or a completed legal review.

Printer hardware is deferred as requested. Native Android packaging is a subsequent deliverable and has not been distributed.
