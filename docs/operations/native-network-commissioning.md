# Native/server network commissioning

This is an opt-in, isolated integration test. It does not enable Android sales or authorize an APK release. The production `NativeCheckoutCoordinator` constructor still disables new issuance; the test uses its package-private enabled constructor and explicitly checks the production gate remains closed.

## What is exercised

One Android emulator runs two independent storage namespaces, each with its own SQLite ledger, clock/PIN databases, encrypted session store and Android Keystore keys. These are **not two physical devices or two separately installed apps**.

The test uses real native preparation, checkout, reconciliation, continuation and drawer-close code. `NativePosHttp` sends real HTTPS to a loopback-only listener, which invokes the production TypeScript route handlers and SQL functions against a disposable PostgreSQL database containing migrations 001–030. A connection factory redirects only the test's fixed-origin requests to `127.0.0.1:9443`. A temporary CA is trusted per connection; hostname verification remains enabled. Platform-default rejection of that CA is also tested.

Auth tokens and the Supabase client transport are synthetic adapters. PostgreSQL transactions still run with the relevant `authenticated` or `service_role` identity. No production account, database, payment provider or site receives test traffic.

## Scenarios and acceptance

Each run seeds one synthetic organization/branch, two staff/device bindings, and two open drawers with 10,000 fils each. Both namespaces prepare independently, issue two bills while their connection factory refuses network access, reopen their local stores, and recover the same committed receipts. Reconciliation deliberately loses one response per namespace **after the server has committed**. Retrying must preserve the signed acknowledgement and create no duplicate financial records.

Both namespaces finish their first allocation, continue the same shift into a new allocation, issue one further bill each, upload and seal it, then close their original drawer. The assertions require:

- Six invoices, orders and cash payments, totalling 6,000 fils; each bill is 1,000 gross, 952 net and 48 VAT.
- Two distinct device keys, sequences 1–3 for each key, matching signed receipt chains and verified server acknowledgements.
- Four non-overlapping, sealed allocations; continuation preserves existing receipt and acknowledgement rows.
- Three acknowledgements and two seal confirmations per namespace, with empty upload queues and no reconciliation exceptions.
- Two drawers closed at 13,000 fils, each with zero difference.
- Replayed imports retain the same accepted financial payload and signed acknowledgement. The `replayed` indicator may change.

Network preflight also checks rejected untrusted TLS, missing/invalid sessions, wrong origin/cross-site requests, missing or foreign device bindings, malformed/extra JSON fields and oversized bodies. Protected financial-table fingerprints must remain unchanged during those checks.

The optional **historical revocation** variant runs in a fresh database and new namespaces. After four bills have been issued and locally sealed, test-only controls disable the synthetic staff, devices and offline policy, and change the current price to 2,500 fils. Fresh access/preparation must be denied, while the four original 1,000-fils bills and both seals must still reconcile without cookies. The test then restores access and the 1,000-fils price at revision 3 before continuing. Changing this current metadata must not change existing financial/custody rows.

## Reproduce locally

Use a dedicated test emulator and private task directory. Never clear an existing app's data or point this harness at a shared/customer database. Build/install the debug and instrumentation APKs before starting the timed server test.

1. Create a new PostgreSQL cluster with a private Unix socket directory named `/tmp/pos-qa-pg-<unique>`, with TCP listening disabled. The test refuses nonlocal database connections, creates a randomly named database, and drops only that database afterwards. The runner remains responsible for stopping its cluster.
2. Create an ephemeral CA/server certificate for IP `127.0.0.1` and its private key. Keep the private directory owner-only and secret files mode `0600`. Do not install this CA into the device's global trust store.
3. Set the environment below and run `node_modules/.bin/vitest run --config tests/integration/native-network.config.ts`. This suite is excluded from ordinary unit tests. Keep a process handle and terminate the owned process group on interruption or timeout.

| Variable                                            | Required value                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `OFFLINE_TEST_PG_SOCKET`                            | The private `/tmp/pos-qa-pg-<unique>` socket directory                           |
| `OFFLINE_TEST_PG_PORT`                              | The cluster's port; defaults to `55432`                                          |
| `OFFLINE_TEST_PG_ENTRY`                             | Absolute module entry for the local `pg` package                                 |
| `NATIVE_NETWORK_TLS_KEY`, `NATIVE_NETWORK_TLS_CERT` | Private temporary TLS key and matching certificate paths                         |
| `NATIVE_NETWORK_PORT`                               | `9443`; listener binds only `127.0.0.1`                                          |
| `NATIVE_NETWORK_BOOT_PATH`                          | A new private `boot.json` beneath `/home/islaminamdar/.local/state/codex-tasks/` |
| `NATIVE_NETWORK_COMPLETION_TOKEN`                   | Fresh random 32 bytes encoded as 64 lowercase hexadecimal characters             |
| `NATIVE_NETWORK_TIMEOUT_MS`                         | At most `600000` milliseconds                                                    |
| `NATIVE_NETWORK_HISTORICAL_REVOCATION`              | `true` for the optional second variant; otherwise omitted                        |

4. Wait for the server report to say `ready` and for the new boot file. Boot publication occurs only after network preflight succeeds. The boot file contains temporary synthetic session tokens; do not print or commit it.
5. On the explicitly selected emulator, create only the owned `adb reverse tcp:9443 tcp:9443` mapping. Stream the boot file through `run-as info.internext.pos` into that app's no-backup directory as `commissioning-<runId>.json`, using the run ID from the boot file. Do not replace other app files.
6. Run the instrumentation class `info.internext.pos.storage.NativeServerCommissioningTest` with argument `commissioningConfig=commissioning-<runId>.json`. The test runner is `info.internext.pos.test/androidx.test.runner.AndroidJUnitRunner`.
7. Require instrumentation success and read `cache/commissioning-<runId>-result.json`. Both `status` and `cleanup` must be `completed`. Collect the six `devices[].receipts[].issuanceId` values. Using the temporary CA with hostname verification, POST `{ "runId": "<runId>", "receiptIds": ["<six IDs>"] }` to `https://127.0.0.1:9443/__test/complete`, with the private completion token in `X-Test-Token`. Read that token from private configuration rather than exposing it in logs or command-line arguments.
8. The completion response is only an acknowledgement. Wait for the server test to pass, its process to exit successfully, and the report to confirm its owned database was dropped and listener closed. Compare native/server receipt IDs, document IDs/numbers, payload hashes and sequences; PostgreSQL bigint sequence values are JSON strings and need numeric normalization.

For a second run, use a fresh run ID, database, temporary keys/tokens and Android namespaces. Never replay an uncertain run using its old configuration.

## Cleanup and failure evidence

On native success, the test deletes only its namespaced databases, encrypted store files, Keystore aliases, configuration and run marker, then marks cleanup complete. Its sanitized result remains in the app cache. On native failure, it closes handles but retains the exact namespaced custody/configuration and a marker that prevents blind reruns.

The operator must still remove the owned ADB reverse mapping, stop the owned PostgreSQL cluster, remove its socket directory, and destroy temporary TLS private keys, boot files and completion-token configuration. Preserve sanitized reports, source hashes and test logs. If a test fails or cleanup is incomplete, retain that state as failed/pending and investigate the exact run before deleting its evidence or starting a replacement.

## Observed results — 2026-10-16

The baseline run passed Android instrumentation (one test, 42.915 seconds) and the server/SQL acceptance. Independent readback matched all six native/server receipt identities, document numbers, payload hashes and sequences. Both native namespaces reported cleanup complete; the server reported its database dropped and listener closed.

The historical-revocation variant also passed Android instrumentation (one test, 43.688 seconds) and server/SQL acceptance. Independent readback again matched all six native/server receipts. Four original-price bills and two seals were accepted while current access was revoked; access was restored before continuation. The server recorded TLS 1.2/1.3 connections and 14 historical requests without Cookie/Set-Cookie. Both native namespace cleanup and server database/listener cleanup completed. Separate operator readback verified the owned emulator and PostgreSQL processes stopped, the reverse mapping/socket removed, and temporary TLS keys, boot files and completion tokens removed. Unrelated application data was preserved.

These checks do not verify physical hardware durability, two physical-device contention, real airplane-mode behavior, full Android process death/relaunch, GoTrue login/refresh/password transport, the deployed Next.js reverse proxy, printer/card-terminal behavior, or production signing-key commissioning. Network loss is injected at the native connection factory; reopening uses real persistent stores within the same instrumentation process. Those release gates remain separate.
