# Isolated native storage failure acceptance

`NativeStorageFailureTest` adds two explicitly orchestrated checks against the genuine Android
SQLite/Keystore checkout engine. It has no network client and uses synthetic merchant data,
ephemeral test keys and a separate database for each run. It does not enable production sales.
Ordinary instrumentation discovery skips it before touching storage. This document describes
the harness; execution results must be recorded separately.

The capacity check saves the exact payment intent, caps the test database with SQLite's
`max_page_count`, and allocates a bounded 1 MiB padding value through a **test-only** trigger
inside the real receipt insertion. The cap leaves fewer than 1 MiB of pages available. The
checkout must throw an actual `SQLiteFullException`. No injected Java failure or SQL `RAISE`
counts as success. This exercises SQLite capacity exhaustion, **not a full device filesystem**.
The capacity setter is pinned to the primary write connection inside a separate completed
setup transaction; Android's WAL connection pool can otherwise apply the connection-local
limit to a reader while leaving checkout writes unrestricted. WAL remains enabled, and the
actual checkout runs its own normal transaction after capacity setup finishes.

The process-death check pauses at the existing package-private `CommitProbe`, after inserting
the receipt inside the open checkout transaction and before adding its outbox row. A synced,
atomically published checkpoint lets the host independently inspect and force-stop the live
process. A 180-second timeout is a failure, not crash evidence. This exercises process death
during a transaction, **not sudden hardware power loss**.

Both checks fingerprint all production ledger tables after freezing the intent. They require
the identical fingerprint after failure and in a newly started instrumentation process, with
no issued receipt, outbox entry, consumed invoice number, changed sequence or spent budget.
The original Keystore identity and installation must remain. Explicit recovery of that same
intent must then produce one correctly signed invoice and one outbox entry; retry returns the
same envelope and cannot consume another number. The normal production issuance gate stays
closed throughout.

## Ownership and preconditions

- Select a dedicated, owned emulator. Never use a customer's device or clear application data.
- Build/install debug app and instrumentation APKs **before** seeding either run. Do not
  reinstall, reset, restore a snapshot or clear data between seed and verification.
- Run only `info.internext.pos.storage.NativeStorageFailureTest#orchestratedStorageFailure`.
- Use a new random 32-character lowercase hexadecimal `storageFailureRun` for each mode.
  The exact ID owns a database, Keystore alias and evidence files. Existing fixtures cause
  seeding to fail; never automatically delete them or retry over an uncertain run.
- Use the `info.internext.pos.test/androidx.test.runner.AndroidJUnitRunner` runner.
- The package `info.internext.pos` is the engineering candidate, separate from the released
  online app `info.internext.pos.counter`.

Build from `apps/android-pos/android` with the configured Java 21 / Android SDK environment:

```sh
./gradlew --no-daemon :app:assembleDebug :app:assembleDebugAndroidTest
```

## Capacity phases

In the commands below, substitute the explicitly selected emulator serial and fresh run ID.
Keep the run ID in a private host task record.

```sh
adb -s SERIAL shell am instrument -w -r \
  -e class info.internext.pos.storage.NativeStorageFailureTest#orchestratedStorageFailure \
  -e storageFailureRun RUN_ID -e storageFailurePhase capacity_seed \
  info.internext.pos.test/androidx.test.runner.AndroidJUnitRunner
```

Require a passing test and read, using `run-as info.internext.pos`, both original files under
`no_backup/`: `native-storage-failure-capacity-RUN_ID.json` and
`native-storage-failure-capacity-RUN_ID-signal.json`. Require `status=capacity_failed`, an exact
`android.database.sqlite.SQLiteFullException`, and matching before/after hashes. Record the
seed PID and export both files. Force-stop the owned engineering package and verify that PID
and package process are absent before continuing. No customer package is stopped.

```sh
adb -s SERIAL shell am instrument -w -r \
  -e class info.internext.pos.storage.NativeStorageFailureTest#orchestratedStorageFailure \
  -e storageFailureRun RUN_ID -e storageFailurePhase capacity_verify \
  info.internext.pos.test/androidx.test.runner.AndroidJUnitRunner
```

Require passing instrumentation and `status=verified` in
`cache/native-storage-failure-capacity-RUN_ID-result.json`. The verifier lifts only the test
capacity cap and removes only its pressure trigger before replaying the saved intent.

## Mid-transaction process-death phases

Start the following command asynchronously, preserving its process handle and output. The
test is expected to remain running until the host kills the Android package.

```sh
adb -s SERIAL shell am instrument -w -r \
  -e class info.internext.pos.storage.NativeStorageFailureTest#orchestratedStorageFailure \
  -e storageFailureRun RUN_ID -e storageFailurePhase crash_seed \
  info.internext.pos.test/androidx.test.runner.AndroidJUnitRunner
```

Within 180 seconds, wait for
`no_backup/native-storage-failure-crash-RUN_ID-signal.json`. Export the entire original
checkpoint and hash it. Require the exact run ID, `phase=receipt_inserted_transaction_open`,
`inTransaction=true`, one receipt visible inside the transaction and zero outbox rows.
Independently observe its `pid` as a live `info.internext.pos` process. Then:

```sh
adb -s SERIAL shell am force-stop info.internext.pos
```

Record the command result and verify the original PID and package process are absent. The
seed instrumentation intentionally terminates; it is **not** reported as a passing test.
If the process was already absent or the checkpoint changed to `crash_timeout`, do not
claim process-death coverage and do not run the verification with invented evidence.

```sh
adb -s SERIAL shell am instrument -w -r \
  -e class info.internext.pos.storage.NativeStorageFailureTest#orchestratedStorageFailure \
  -e storageFailureRun RUN_ID -e storageFailurePhase crash_verify \
  -e storageFailureKilledPid OBSERVED_KILLED_PID \
  info.internext.pos.test/androidx.test.runner.AndroidJUnitRunner
```

`storageFailureKilledPid` is an orchestrator attestation, not independent proof inside the
app. Retain the host observation/kill/absence evidence separately. Require passing
instrumentation and `status=verified` in
`cache/native-storage-failure-crash-RUN_ID-result.json`.

## Cleanup

First export the original seed checkpoint and final result. Only verified fixtures support
automatic cleanup:

```sh
adb -s SERIAL shell am instrument -w -r \
  -e class info.internext.pos.storage.NativeStorageFailureTest#orchestratedStorageFailure \
  -e storageFailureRun RUN_ID -e storageFailurePhase cleanup \
  -e storageFailureMode capacity \
  info.internext.pos.test/androidx.test.runner.AndroidJUnitRunner
```

Use `storageFailureMode crash` for the other mode. Cleanup deletes only the exact owned
database, Keystore alias, marker and signal. It retains the sanitized cache result with
`cleanup=completed`; export and inspect it. Failed fixtures remain intact for investigation.
Cleanup cannot be used to disguise or erase an incomplete run.

Passing these checks does not establish physical flash durability, full filesystem recovery,
production authentication/signing readiness, two physical-device reconnect, printer output,
or permission to ship the offline candidate.

## Observed results — 2026-10-17

The corrected harness passed on the owned Android 15/API35 emulator. Capacity setup preserved
WAL and limited the primary writer to 86 pages of 4,096 bytes. Receipt insertion raised a real
`android.database.sqlite.SQLiteFullException`; every production-table fingerprint remained
unchanged. Seed and new-process recovery passed in 0.192 and 0.205 seconds. Recovery retained
the original installation/device key and exact intent, issued one 1,000-fils synthetic bill
with sequence 1 and the first reserved number, and replay returned its original envelope.
The successful capacity namespace and key were removed by the verified cleanup phase.

For the process-death scenario, the host read the synced checkpoint while PID 3826 had one
receipt inserted inside an open transaction and no outbox row. The host independently found
that PID belonging to `info.internext.pos`, force-stopped it, and verified both PID and package
process absent. The seed instrumentation was intentionally killed, not counted as a passing
test. New PID 3889 verified the unchanged pre-commit ledger and recovered the original intent
once in 0.195 seconds. Its owned namespace/key cleanup passed. Both recovered bills were
synthetic and never uploaded to any server.

An earlier capacity attempt failed because the connection-local limit was applied to a WAL
reader; its synthetic receipt therefore committed. That run is not acceptance evidence. Its
database/marker archive, failure log and original isolated Keystore alias were preserved for
investigation. The fix pins capacity setup to the primary writer and used a fresh run ID.
A host polling attempt also ended before creating a crash fixture because ADB's missing-file
output was parsed as JSON; absence was reconciled before a fresh successful run. Neither
failure was silently retried over existing custody. The final successful runs cleaned up only
their own verified data; the archived failed capacity namespace remains intentionally separate.
