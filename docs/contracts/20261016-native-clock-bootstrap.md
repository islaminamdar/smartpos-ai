# Clock verification before first offline enrollment

Candidate implementation; Android release and production signing commissioning remain pending.

This separate flow repairs a latched wall-clock fault on an intact installation before its first offline key epoch. It cannot recover deleted/corrupt stores, unknown enrollment outcomes, PIN lockouts, or financial custody. Anonymous server time is not evidence of device ownership, emptiness, or permission to sell. Native code independently proves the eligibility described below.

## Frozen transport

`POST /api/pos/native/clock-bootstrap`, fixed HTTPS origin, no cookies in either direction. Request is canonical UTF-8 JSON, at most 2,048 bytes with a 10-second body-read deadline:

```ts
{
  schemaVersion: 1,
  installationId: string, // canonical lowercase UUID
  deviceKeySha256: string, // 64 lowercase hex
  oldClockGeneration: number, // integer 0 .. Number.MAX_SAFE_INTEGER - 1
  oldClockSha256: string, // 64 lowercase hex, authenticated clock-state hash
  challenge: string, // 32 fresh native random bytes encoded as 64 lowercase hex
}
```

Strict response: `{ status: 'ready', time: SignedEnvelope }`. The signed canonical payload contains every request field unchanged, plus `kind: 'native-clock-bootstrap-time'` and server-owned integer `serverTimeMs` (0–253402300799999). No extra fields, caller timestamp, password, arbitrary key or URL. The existing pinned P-256 signature envelope applies. The domain differs from enrolled clock recovery, which requires approval and financial retirement.

The server verifies its signing configuration, signs only this fixed schema and verifies the result. It reads no staff identity and writes no approvals, epochs, shifts or authority. Two domain-separated existing `pos_offline_limit` buckets enforce 600 attempts/minute globally and per trusted source, with the global bucket consumed first to bound source-row creation. Exhausting the shared quota temporarily denies bootstrap verification; it does not consume the ordinary recovery budget. Invalid source configuration, missing signer or limiter failure denies verification. Responses are private/no-store with no cookies. Exact POST is reachable while new selling is paused.

## Native admission and apply

Require authentic intact clock, vault, journal, auth and existing device-key continuity. Never create/reset a store or key to establish eligibility. There must be no key epoch, attempted enrollment (including uncertain/expired outcomes), reservation, PIN or PIN recovery, enrolled-clock recovery, preparation/closure transition, or financial/lifecycle journal rows. Pending/unknown counter or shift setup blocks verification. An exact acknowledged online setup shift is allowed only when its retained request, shift ID, actor and counter scope agree; preserve it byte-for-byte. Signed-out untouched setup is supported. The installation-integrity boundary does not prove absence of historical custody after correlated deletion of stores and their Keystore entries.

After explicit native confirmation, capture a fresh challenge and raw OS observation. Verify the exact signed identity/hash/generation/challenge under pinned server keys. Require unchanged OS boot count, nondecreasing elapsed time, round trip at most 30,000 ms, and corrected device wall time within 120,000 ms of signed server time plus the full round trip. Boot/elapsed rollback, overflow and unavailable signals remain blocked. User corrects Android date/time first; TLS validation is never bypassed.

Recheck eligibility and lifecycle under existing store lock order before applying. One clock database transaction appends immutable authenticated bootstrap evidence and changes only the blocked clock baseline, using the old hash/generation as compare-and-swap and advancing the generation. Preserve keys, cookies, PIN attempts, shift state and every financial row. No allowance is created. Finish locked. Crash before commit leaves the old block; crash after commit leaves the new baseline and audit together. Retries use a fresh nonce; stale callbacks cannot reapply an old generation.

## Frozen JavaScript metadata

Zero-argument `getNativeClockBootstrapState()` and `verifyNativeClockBootstrap()` return exactly:

```ts
{
  schemaVersion: 1,
  status: 'not_available' | 'ready' | 'blocked' | 'completed',
  canVerify: boolean,
  reasonCode: string | null,
}
```

`ready` requires `canVerify: true` and null reason. `completed` is false/`clock_bootstrap_completed`; `not_available` is false/`clock_healthy` or `clock_bootstrap_not_eligible`; blocked is false with a reviewed storage/configuration/signal reason. JavaScript never supplies proof, time, challenge, credentials or local eligibility. Original-account recovery metadata remains unchanged. UI rereads ordinary native state after completion and never releases unrelated setup, payment, PIN or closing holds.

## Candidate verification

The web regression run passed 1,341 tests with one existing skipped legacy RLS test. Subsequent focused checks passed 49 server/transport/interoperability tests and 115 UI/contract/interoperability tests. These overlap and must not be added as unique coverage. Actual Android-exported request bytes pass the production TypeScript route and signer; Java verifies a fixture produced by the production TypeScript signer. The UI consumes actual Android bootstrap and ordinary-recovery metadata. Browser interactions use a synthetic native bridge, including success, lost response, incorrect time and original recovery, at 1280/375/320 px without horizontal overflow.

Native validation passed 113 JVM tests. Across 152 instrumented executions, all 145 distinct Android cases have a passing latest result, including 76 affected access/setup/network/PIN regressions and five final installed-package checks. One initial dialog test asserted before Android dispatched its cancellation callback; waiting for the actual UI callback corrected the test, and the original failure was retained in private evidence. The APK's three bundled web files match the final Vite output exactly. Builds, type checks, scoped lint and bounded independent security review passed; scoped Semgrep scans reported no findings. These results do not constitute a whole-platform security certification.

The APK is an internal debug candidate. The native tests use synthetic HTTPS responses and isolated SQLite/Keystore stores, not real remote signing or two physical counters. No production bootstrap deployment, signing activation, customer bill, PayPal payment or customer APK delivery occurred in this increment. The existing online release remains `2de794a`.
