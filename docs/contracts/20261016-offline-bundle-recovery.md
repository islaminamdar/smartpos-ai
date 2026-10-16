# Historical pending-bundle recovery

This candidate closes the interval between durable reservation and receipt of the signed bundle. It does not authorize issuance, restore a staff session, open a shift, reserve invoice numbers, renew an allocation or change its original limits. Native integration and production activation are separate work.

`POST /api/pos/offline/bundle-recovery` accepts a `pos-signed-v1` envelope, at most 16,384 streamed body bytes. Its exact device-signed payload is:

```text
kind: "offline-bundle-recovery"
schemaVersion: 1
authorityId: lowercase UUID, equal to the device's persisted reservation.requestId
keyEpoch: lowercase UUID
deviceId: lowercase UUID
challenge: 64 lowercase hex characters
```

The envelope must be signed by the historical device key stored for that authority; its `keyId` is that enrolled key's SHA256 fingerprint. Incoming fields never supply a trusted key. The service reads the pre-existing authority through the service-role-only SQL017 reader, validates its immutable snapshot, scope and key fingerprint, verifies possession, and matches authority ID, device ID and key epoch. Unknown authority or foreign/forged proof cannot allocate, attach or return a bundle.

The route remains reachable when the online pilot, live-sales and new offline-issuance flags are disabled. It requires neither current staff membership nor a browser login/Origin. It uses the existing trusted-source recovery rate limiter before reading the body. The native transport must send no login cookies and ignore `Set-Cookie`, as for import/seal. Errors and responses use `Cache-Control: private, no-store`.

The response has exactly `{snapshotEnvelope, authorityEnvelope, handoff}`. If signing previously completed, the first stored envelopes are returned unchanged. If reservation committed but attachment was interrupted, only after device-proof verification may the service sign the frozen snapshot and authority and complete the existing idempotent `pos_offline_attach`. The sole authority change in the unsigned draft is filling its reserved null `snapshotSha256` with the hash of its exact frozen snapshot. SQL rechecks the frozen payloads and returns the first stored signature bytes if another attachment already won. No new reservation is made; original IDs, invoice range, prices, budgets, scope, issue time and expiry remain unchanged. No SQL migration is required.

The handoff is signed by a separately configured trusted server key. Its exact payload is:

```text
kind: "native-offline-recovered"
schemaVersion: 1
purpose: "reconciliation-only"
challenge: the exact verified device challenge
serverTimeMs: integer UTC Unix epoch milliseconds, 0 through 253402300799999
actorId, organizationId, branchId, deviceId, shiftId, keyEpoch, authorityId: lowercase UUIDs
deviceKeySha256, snapshotSha256, authoritySha256: 64 lowercase hex SHA256 strings
```

The distinct kind and purpose must be rejected by the ordinary preparation/issuance verifier. Even an unexpired recovered allocation is for retention and terminal reconciliation only. The native recovery path must never route this handoff through normal install/enable-issuance behavior. Retaining, signing a terminal declaration and confirming server custody require their own reviewed native workflow.

No caller clock or age-limited `issuedAt` is required in the recovery request: recovery must survive lost time anchors and revoked sessions. Freshness belongs to the response: the native host generates and tracks a new unpredictable challenge, verifies its exact match and complete expected scope/hashes against independently pinned server keys, and bounds the elapsed request round trip. It must never accept an unsolicited or previously consumed response. Replaying an old valid request can only retrieve the same historical evidence or idempotently finish the same attachment; it cannot extend validity or create another allocation.

Implementation: `lib/pos/offline/bundle-recovery.ts`. Unit coverage uses real P-256 signatures and strict route/limiter cases. `tests/integration/offline-service.test.ts` additionally exercises actual disposable SQL after staff/device revocation and issuance shutdown, including an interrupted attachment, rejection of foreign proofs, unchanged counters/expiry and exact stored-envelope replay. These checks do not imply production deployment or native recovery activation.
