# Online launch completion — 17 October 2026

Web release `e16341304d7d1a97d8968f83db1c53ff18ecd218` is deployed at
`https://pos.internext.info/counter`, with POS migrations 001–033. Source is pushed
to GitHub. Existing online sales remain enabled; offline issuance, offline payment
decisions and PayPal subscription collection remain disabled.

## Delivered

- Seven temporary illustrations cover eight exact Bur Dubai menu records. Every
  illustration is labelled. The original 125 photographs take precedence, and
  prices and availability were not changed: 133 products, 103 active, 30 inactive.
- Invited new cashiers can request an email code, verify ownership, choose their
  own password and accept their branch invitation. Existing confirmed accounts
  use sign-in. The fixed loopback hosting mail transport is configured. Local
  capture tests prove message construction, and the hosting MTA accepted a
  recipient check that was reset before sending. Actual inbox delivery has not
  been tested; no external test message was sent.
- Nightly hosting backups now use authenticated AES-256-GCM encryption. The final
  archive `daily-20261017T150817Z` was decrypted and restored into an isolated
  database with all 33 exact migration hashes, followed by verified cleanup.
  These are same-server backups; off-server replication and external alerts are
  not configured.

## Verification

The baseline combined web suite passed 1,529 tests with one existing skip. After
the concurrency guard was added, 20 new staff tests and 37 existing staff tests
passed; menu coverage passed 36 focused tests. Production build and type checks
passed. ESLint reported no errors and 44 existing warnings. Scoped security scans
reported no findings. Production-mode invitation UI and menu presentation were
checked at 375px and 1280px. Browser tests used intercepted synthetic responses;
they did not create customer transactions or send messages.

An actual isolated GoTrue/PostgreSQL test caught concurrent OTP verification
acceptance. Migration033 now consumes the correct setup attempt atomically before
calling Auth. Repeated competing completion tests proved one winner, one branch
membership and only the winning password authenticating. Replay, stale code,
revoked invitation and inactive inviter checks also passed.

The production migration was rehearsed on an isolated restoration before applying
it. All 114 pre-existing public/auth table counts and full-row hashes were
unchanged during migration. The only new table is the initially empty private
staff setup-attempt table. APK downloads and Apache configuration were preserved.

## Android status and remaining work

Customer APK 1.1.0 remains the signed online counter with its verified update
prompt. This web release does not require a new APK download. The engineering
offline application has passed actual SQLite capacity failure, forced process
death inside a transaction, real deployed HTTPS authentication/session refresh,
encrypted session reopening and APK-pinned signed-time verification. See the
separate native acceptance runbooks for scope and retained failure evidence.

The existing signing key is now configured on the server for the signed-time
endpoint; production offline issuance is still disabled. Do not use historical
deployment scripts that assume all signing configuration is absent.

The offline engineering app is not yet a final customer APK. It still needs safe
integration with the customer package, signing/updater and online counter features,
plus complete offline feature parity and commissioning. Physical POS/printer,
full-filesystem/power-loss and two physical-device reconnect tests remain pending.
Kitchen routing needs branch commissioning. Forgotten-password self-service,
live invitation email delivery and the supervised first customer shift also
remain pending. Do not present the whole POS roadmap as complete.
