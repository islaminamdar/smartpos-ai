# Native/server network commissioning

This is an opt-in, isolated integration test. It does not enable Android sales or authorize an APK release. The production `NativeCheckoutCoordinator` constructor still disables new issuance; the test uses its package-private enabled constructor and explicitly checks the production gate remains closed.

## What is exercised

One Android emulator runs two independent storage namespaces, each with its own SQLite ledger, clock/PIN databases, encrypted session store and Android Keystore keys. These are **not two physical devices or two separately installed apps**.

The test uses real native preparation, checkout, reconciliation, continuation and drawer-close code. `NativePosHttp` sends real HTTPS to a loopback-only listener, which invokes the production TypeScript route handlers and SQL functions against a disposable PostgreSQL database containing migrations 001–030. A connection factory redirects only the test's fixed-origin requests to `127.0.0.1:9443`. A temporary CA is trusted per connection; hostname verification remains enabled. Platform-default rejection of that CA is also tested.

Auth tokens and the Supabase client transport are synthetic adapters. PostgreSQL transactions still run with the relevant `authenticated` or `service_role` identity. No production account, database, payment provider or site receives test traffic.

## Scenarios and acceptance

Each run seeds one synthetic organization/branch, two staff/device bindings, and two open drawers with 10,000 fils each. In the baseline and historical-revocation runs, both namespaces prepare independently, issue two bills while their connection factory refuses network access, reopen their local stores, and recover the same committed receipts. Reconciliation deliberately loses one response per namespace **after the server has committed**. Retrying must preserve the signed acknowledgement and create no duplicate financial records.

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
| `NATIVE_NETWORK_TIMEOUT_MS`                         | At most `600000` milliseconds; `1200000` for the restart variant                  |
| `NATIVE_NETWORK_HISTORICAL_REVOCATION`              | `true` for the optional revocation variant; otherwise omitted                     |
| `NATIVE_NETWORK_RESTART`                            | `true` for the ordered restart variant; cannot combine with revocation           |

4. Wait for the server report to say `ready` and for the new boot file. Boot publication occurs only after network preflight succeeds. The boot file contains temporary synthetic session tokens; do not print or commit it.
5. On the explicitly selected emulator, create only the owned `adb reverse tcp:9443 tcp:9443` mapping. Stream the boot file through `run-as info.internext.pos` into that app's no-backup directory as `commissioning-<runId>.json`, using the run ID from the boot file. Do not replace other app files.
6. Run the instrumentation class `info.internext.pos.storage.NativeServerCommissioningTest` with argument `commissioningConfig=commissioning-<runId>.json`. The test runner is `info.internext.pos.test/androidx.test.runner.AndroidJUnitRunner`.
7. Require instrumentation success and read `cache/commissioning-<runId>-result.json`. Both `status` and `cleanup` must be `completed`. Collect the six `devices[].receipts[].issuanceId` values. Using the temporary CA with hostname verification, POST `{ "runId": "<runId>", "receiptIds": ["<six IDs>"] }` to `https://127.0.0.1:9443/__test/complete`, with the private completion token in `X-Test-Token`. Read that token from private configuration rather than exposing it in logs or command-line arguments.
8. The completion response is only an acknowledgement. Wait for the server test to pass, its process to exit successfully, and the report to confirm its owned database was dropped and listener closed. Compare native/server receipt IDs, document IDs/numbers, payload hashes and sequences; PostgreSQL bigint sequence values are JSON strings and need numeric normalization.

For a second run, use a fresh run ID, database, temporary keys/tokens and Android namespaces. Never replay an uncertain run using its old configuration.

## Actual force-stop and reboot variant

Use `NATIVE_NETWORK_RESTART=true` with a fresh run and the same isolated server/TLS setup. This variant uses `NativeServerRestartTest` and five separately selected methods; **never run the whole class as a suite**. Each method requires `restartConfig=restart-<runId>.json` and its matching `restartPhase`. Copy the private boot configuration under that filename. Install the APKs before preparation; do not reinstall, clear app data, restore a snapshot, change the clock or reset PIN state between phases.

1. Run `prepareOnline` with `restartPhase=prepare_online` while the owned reverse mapping is present. Require a `ready` checkpoint and successful instrumentation. Each namespace now has its own signed allocation and durable keys.
2. Remove the owned reverse mapping and turn off Wi-Fi and mobile data on the dedicated emulator. Record their actual settings. Run `seedOffline` with `restartPhase=seed_offline`. It requires a real connection failure, then commits and locally seals two receipts per namespace without network requests. It writes a durable `ready` checkpoint and stays alive with database owners open for at most three minutes.
3. While that process is still alive, export the full checkpoint and independently record its PID, boot count and disconnected settings. From the host, submit the strict checkpoint projection to `/__test/checkpoint` over verified TLS, with body `{token, runId, evidence}`. Require HTTP 200. Preserve the full original checkpoint and its hash alongside the projection. Then issue `am force-stop info.internext.pos` on the selected emulator and verify both the old PID and package process are absent. The seed instrumentation is intentionally killed; its terminated runner is not a normal passing test.
4. Run `verifyOfflineAfterForceStop` with `restartPhase=after_force_stop`, still disconnected. Require a new PID at the same boot count. Before explicit PIN unlock, the test checks locked access and preserved credential state. It reconstructs signed receipts from SQLite, compares identities, authority/seal hashes and immutable journal rows, and replays the exact existing confirmations without new financial rows. Export and submit the second checkpoint from the host.
5. Reboot the actual emulator with `adb reboot`; wait for boot completion and independently require a higher OS boot count. Keep Wi-Fi, mobile data and reverse forwarding off. Run `verifyAfterReboot` with `restartPhase=after_reboot`; require the same custody and locked-access checks. Export and submit the third checkpoint. Each server checkpoint verifies zero imported financial records, the original authority/key bindings and unchanged protected-table fingerprints. Uploads remain blocked until all three checkpoints are accepted.
6. Recreate only the owned reverse mapping. Run `recoverReconcileContinueClose` with `restartPhase=complete`. Historical reconciliation starts while PIN-locked, deliberately loses one committed import response per namespace, then retries without duplicates. Original-account/PIN authorization and fresh signed time are required for continuation. Each namespace receives a new allocation, issues one additional bill while connected, reconciles/seals it and closes its drawer. Require native `status=completed` and `cleanup=completed`, then submit the six final receipt IDs to `/__test/complete` and perform the final server/readback checks above.

The checkpoint endpoint accepts a strict projection: `schemaVersion`, `runId`, `phase`, `bootCount`, `elapsedRealtimeMs`, `pid` and two device records containing identity/key/authority/seal/immutable hashes, the two original receipt identities and the receipt/outbox/acknowledgement/seal-confirmation counts. The native checkpoint also contains PIN-state evidence and other diagnostic fields. Validate its `ready` status before projection; do not discard the original or invent evidence from the phase name. A rejected or uncertain phase must be investigated, not rerun automatically.

A healthy reboot is allowed by the existing clock policy when wall time does not move backward and expiry/drift checks pass. A clock rollback must remain blocked; do not reset or bypass the clock to complete this test. Enrolled custody cannot use pristine-installation clock bootstrap. These phases test interruption after committed and sealed records, not killing a transaction midway or sudden hardware power loss.

## Cleanup and failure evidence

On native success, the test deletes only its namespaced databases, encrypted store files, Keystore aliases, configuration and run marker, then marks cleanup complete. Its sanitized result remains in the app cache. On native failure, it closes handles but retains the exact namespaced custody/configuration and a marker that prevents blind reruns.

The operator must still remove the owned ADB reverse mapping, stop the owned PostgreSQL cluster, remove its socket directory, and destroy temporary TLS private keys, boot files and completion-token configuration. Preserve sanitized reports, source hashes and test logs. If a test fails or cleanup is incomplete, retain that state as failed/pending and investigate the exact run before deleting its evidence or starting a replacement.

## Observed results — 2026-10-16

The baseline run passed Android instrumentation (one test, 42.915 seconds) and the server/SQL acceptance. Independent readback matched all six native/server receipt identities, document numbers, payload hashes and sequences. Both native namespaces reported cleanup complete; the server reported its database dropped and listener closed.

The historical-revocation variant also passed Android instrumentation (one test, 43.688 seconds) and server/SQL acceptance. Independent readback again matched all six native/server receipts. Four original-price bills and two seals were accepted while current access was revoked; access was restored before continuation. The server recorded TLS 1.2/1.3 connections and 14 historical requests without Cookie/Set-Cookie. Both native namespace cleanup and server database/listener cleanup completed. Separate operator readback verified the owned emulator and PostgreSQL processes stopped, the reverse mapping/socket removed, and temporary TLS keys, boot files and completion tokens removed. Unrelated application data was preserved.

The ordered restart run also passed. Preparation completed in 8.676 seconds. Four receipts were committed with Wi-Fi/mobile data off and ADB reverse absent. The live seed process (PID 5476, boot count 5) was force-stopped and verified absent. The new process (PID 5559, boot count 5) passed recovery in 4.369 seconds. An actual emulator reboot increased the boot count to 6; recovery in PID 1537 passed in 10.689 seconds while still disconnected. Reconciliation, continuation and drawer close passed in 24.666 seconds. All three full checkpoints preserved the original four receipt identities, authority/seal hashes and immutable journal digests. Independent native/server readback matched all six final receipt identities, numbers, payload hashes and sequences; both drawers closed at 13,000 fils with zero difference. Native namespace cleanup and server database/listener cleanup completed. Operator readback also verified the owned PostgreSQL/emulator processes and listener absent, both test databases gone, the socket/reverse mapping removed, and temporary TLS keys, boot files and token configurations deleted. The failed-run database archive and sanitized evidence were retained; unrelated app storage was preserved. The two continuation bills were issued while connected; the initial four were issued while actually disconnected.

An earlier preparation attempt failed in the test-only serializer when a nullable SQL field was represented as a Java null rather than JSON null. It created two allocations but no receipts and performed no restart checks. Its failed evidence was archived, and a narrowly scoped cleanup verified zero financial custody before deleting only those test namespaces. The corrected test used a fresh run ID. That failed attempt is not counted as successful commissioning.

These checks do not verify physical hardware durability, two physical-device contention, airplane-mode switching, a mid-transaction crash or power loss, GoTrue login/refresh/password transport, the deployed Next.js reverse proxy, printer/card-terminal behavior, or production signing-key commissioning. The baseline/revocation runs inject connection-factory failures and reopen stores within one process; the restart variant verifies actual process death, OS reboot and disabled emulator network paths. All runs still use two namespaces within one emulator. These results leave the production Android issuance gate closed and do not authorize release.
