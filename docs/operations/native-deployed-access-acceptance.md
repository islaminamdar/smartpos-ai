# Native access against the deployed service

`NativeDeployedAccessTest` is an opt-in Android instrumentation check of the fixed
`https://pos.internext.info` service. It uses the real native HTTPS transport, system TLS trust,
deployed authentication provider, encrypted session vault and packaged server public keys.
It does not inject a connection factory, bypass TLS or trust keys supplied in a response.

The test signs in to an isolated synthetic account, reopens its encrypted vault, removes only
that test vault's access cookie to require a real refresh, and requires a rotated refresh
token. It verifies a signed server-time response against the packaged key and rejects reuse
with a different challenge. It then signs out, checks its cookies are empty and requires an
unauthenticated native-access request to fail. It never enrolls a device, opens a shift,
reserves invoice numbers or calls a financial endpoint. Server authentication/session and
rate-limit writes still occur.

## Preparation

Use only the owned engineering emulator/application `info.internext.pos`. Never clear its
storage: unrelated test or operational custody may exist. Use a fresh run UUID and the
explicit test class, never an unordered suite containing restart/upgrade tests.

The synthetic account must have an email matching `integration-pos-<hex>@example.invalid`,
one authorized active branch and a fresh native vault with no device binding. The first
restaurant's organization/branch are explicitly forbidden. If temporary branch/staff
activation is necessary, record their exact original rows before changing only the intended
flags and restore those flags afterward. Keep receipt activation and all device/financial
state unchanged. Compare scoped financial/device fingerprints before and after the check.

The deployed server must have a commissioned private signing key whose public key matches
the APK's pinned resource. Configuring a time signer does not enable offline sale issuance;
keep all customer issuance gates closed during this test.

Create a private configuration in the app's `no_backup` directory named
`deployed-access-<run UUID>.json`. Its nine fields are `schemaVersion` (1), `syntheticOnly`
(true), `runId`, `createdAtMs`, `email`, `password`, `actorId`, `branchId` and `organizationId`.
Encode it as canonical JSON: sorted keys, compact separators, UTF-8, without a trailing newline.
The test rejects configurations older than 30 minutes. Stream the password privately; never
put it in command-line arguments, public logs, source control or the download directory.

Run:

```sh
adb -s SERIAL shell am instrument -w -r \
  -e class info.internext.pos.storage.NativeDeployedAccessTest \
  -e deployedAccessConfig deployed-access-RUN_UUID.json \
  info.internext.pos.test/androidx.test.runner.AndroidJUnitRunner
```

## Evidence and cleanup

Require passing instrumentation and the original
`cache/deployed-access-<run UUID>-result.json` with both `status=completed` and
`cleanup=completed`. A successful APK build, successful login alone, or a server health
response is insufficient. Export that sanitized report and the test log, restore the exact
temporary branch/staff flags, and verify financial/device fingerprints separately.

On success, the test removes only its namespaced database, encrypted vault, Keystore alias,
configuration and run marker. On failure it attempts logout and removes the plaintext
configuration, but preserves the remaining test state for investigation. The host must remove
the exact plaintext fixture if failure occurred before the test entered its cleanup block.
Never blindly reuse a failed run ID or delete its saved state to obtain a passing run.

This acceptance does not prove offline bill issuance, two-device synchronization, physical
printer delivery, full-disk/power-loss durability or readiness to distribute the offline
engineering candidate. Record actual execution results separately before claiming completion.

## Observed results — 2026-10-17

The test passed on the owned Android 15/API35 emulator against public release
`e16341304d7d1a97d8968f83db1c53ff18ecd218`. It confirmed genuine deployed sign-in, encrypted-vault
reopening, access-cookie recovery through a rotated refresh token, the packaged-key signed
time response, wrong-challenge rejection, logout and subsequent unauthenticated denial.
The sanitized native report recorded `status=completed`, `cleanup=completed` and no local
financial custody. No device enrollment, shift, allocation or financial endpoint was used.

The host restored the synthetic branch and staff rows to their exact previous values.
Independent before/after fingerprints of documents, orders, order lines, payments, refunds,
cash movements, shifts, devices and device bindings matched. The first restaurant was not
modified. Production offline issuance remained disabled; verifying a pinned time response
does not authorize offline bills.

An initial attempt failed before any network request because the host supplied ordinary
JSON rather than canonical bytes. The host removed that exact plaintext fixture, restored
the synthetic flags and verified unchanged financial/device fingerprints before preparing
a fresh run ID. The successful attempt used canonical JSON; no APK or production correction
was required for that fixture-format failure.
