# Signed native offline preparation

Candidate server routes; production activation and the native host workflow are separate. Both routes are POST-only, require the configured same Origin, the online pilot, live-sales and offline-issuance flags, a current authenticated actor and that actor's current bound device in the requested branch. Responses use `Cache-Control: private, no-store`. The client must supply pinned server public keys independently of every envelope.

`POST /api/pos/native/preparation` accepts at most 1,024 body bytes and exactly `{challenge, branchId, deviceId}`. The challenge is 64 lowercase hex characters; identifiers are canonical lowercase UUIDs. The response is exactly `{handoff}`, using the existing `pos-signed-v1` P-256/DER envelope. Its strict signed payload is:

```text
kind: "native-offline-context"
schemaVersion: 1
challenge: lowercase SHA256-shaped challenge string
serverTimeMs: nonnegative integer UTC Unix epoch milliseconds, <= 253402300799999
actorId, organizationId, branchId, deviceId: lowercase UUIDs
shiftId: lowercase UUID or null
```

The open shift comes from authenticated `pos_open_shift_summaries`, filtered by the exact requested branch/device and current actor's `openedBy`. A missing own shift returns null. Another cashier's shift is never adopted. Malformed summaries or multiple matching shifts fail closed. The endpoint neither opens nor closes shifts.

`POST /api/pos/native/prepare` accepts at most 8,192 body bytes and exactly `{challenge, reservation}`. `reservation` uses the existing strict `reserveRequestSchema` unchanged, including its durable `requestId`. The request's shift must be the actor's current open shift. The existing `reserveOfflineAuthority` service performs the durable SQL reservation/sign/attach workflow; this wrapper independently verifies returned signatures, snapshot/authority consistency, actor/organization/branch/device/shift scope, request identity, range size, budgets, permissions and lifetime before signing a handoff.

The response is exactly `{snapshotEnvelope, authorityEnvelope, handoff}`. Its strict handoff payload is:

```text
kind: "native-offline-prepared"
schemaVersion: 1
challenge: lowercase SHA256-shaped challenge string
serverTimeMs: nonnegative integer UTC Unix epoch milliseconds, <= 253402300799999
actorId, organizationId, branchId, deviceId, shiftId, keyEpoch, authorityId: lowercase UUIDs
deviceKeySha256, snapshotSha256, authoritySha256: lowercase 64-hex SHA256 strings
```

Time is sampled after reservation and bundle verification. After a lost response, the native host retains the original reservation request ID and exact body but supplies a fresh challenge. Only the handoff challenge/time changes; original stored envelopes, reserved numbers and authority expiry remain unchanged. A fresh handoff never renews an expired authority. The native verifier must match its outstanding challenge, trusted key, enrolled device key/epoch, full expected scope and both bundle hashes, and apply its persisted elapsed-time, expiry and local unlock rules before use. The server does not store challenges or treat them as reservation idempotency keys.

Verification: `tests/unit/pos/offline/native-preparation.test.ts` exercises real P-256 signatures and the actual reservation service against mocked Supabase responses, including a resigned actual SQL fixture. These tests do not replace SQL concurrency or physical-device acceptance tests. No migration or production data changes are part of these endpoints.
