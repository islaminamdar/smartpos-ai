# Same-staff native PIN recovery

Candidate contract, 2026-10-16. SQL025 is additive; earlier migrations are unchanged. This is local access recovery, not an allocation, payment decision, clock repair or selling permission. No production enablement is implied.

## Preconditions and ownership

Native recovery requires the original Android device signing key, authenticated installation/PIN credential store and a healthy authenticated device clock. Missing or corrupt keys/stores are not recreated. The original account password and new PIN/confirmation are entered in Android only; neither appears in the web bridge, signed payload, database RPC, audit, report or logs. New authorization requires the same currently active staff account, branch, active device and active original device-cookie binding. A cashier may recover their own credential even when a manager originally enrolled the device key.

An epoch's `blocked` flag is a financial hold. It is preserved and does not prevent recovery of the PIN needed to inspect historical records. Device deactivation, binding revocation and current staff membership control new recovery authorization. Recovery never changes the encrypted preparation pointer, invoice range, old authority clock, clock latch, receipt, outbox, payment hold, seal, shift or existing transaction.

## Device proof and approval

The signed device payload is exactly:

```text
{
 kind: 'native-pin-recovery', schemaVersion: 1,
 requestId, organizationId, branchId, deviceId, actorId, keyEpoch,
 deviceKeySha256, oldCredentialSha256, newCredentialSha256,
 signedAt
}
```

IDs are lowercase UUID strings; hashes are lowercase SHA256 hexadecimal. `signedAt` is an exact UTC millisecond timestamp. The old/new credential commitments differ and each commits to the native credential generation: installationId, credential scope, salt, peppered verifier and KDF iterations. They do not contain a plain PIN. Scope includes organization, branch, device, actor, enrolled key epoch and device key fingerprint; a shift is only an unlock-session binding.

Stable operation identity is the entire proof payload excluding only `signedAt`. Refreshing a demonstrably unaccepted expired proof keeps the original request ID, old/new commitments and native candidate. Native retains its proof versions. An accepted request keeps the first proof envelope/hash even when a retry has a refreshed `signedAt` or another valid DER signature.

The server approval is exactly the same identity fields and `schemaVersion`, with `kind: 'native-pin-recovery-approval'`, `proofSha256` and `approvedAt`; it omits `signedAt`. The proof hash is the exact original accepted canonical byte hash. `approvedAt` is server UTC milliseconds. The approval must be signed by a pinned server key and verified before native application.

## Service and SQL trust boundaries

The server verifies canonical envelope bytes and the registered P256 device signature before lookup or authorization. For new authorization it verifies the password for the exact authenticated account, confirms the returned user ID, captures a server confirmation timestamp immediately after successful password verification, and revokes the temporary Auth session. Server signing configuration is checked before acceptance. Rate limiting, same-origin enforcement, request-size limits and native fixed HTTPS endpoint restrictions belong to the service/route boundary.

SQL independently validates strict proof fields, canonical bytes, exact byte hash and historical enrolled scope. It does not verify ECDSA, confirm the account password or inspect a local credential MAC. `p_actor` and `p_confirmed_at` are trusted-service inputs, not caller assertions. All public RPCs below are service-role only; authenticated/anonymous callers have no table or RPC privileges. The parser is private even to service_role.

| RPC | Result |
| --- | --- |
| `pos_native_pin_recovery_context(p_epoch uuid)` | null, or `{organizationId,branchId,deviceId,keyEpoch,deviceKeySha256,publicKeySpki}` for historical verification, without current-active filtering |
| `pos_native_pin_recovery_lookup(p_proof jsonb)` | null for an unaccepted request, otherwise `{approval,approvalEnvelope}` with envelope nullable while signature attachment is pending |
| `pos_native_pin_recovery_approve(p_actor uuid,p_binding text,p_proof jsonb,p_confirmed_at timestamptz)` | The same `{approval,approvalEnvelope}` response; exact committed replay returns the original record |
| `pos_native_pin_recovery_attach(p_request uuid,p_envelope jsonb)` | The same response with the first exact signed approval envelope |

`p_proof` is the complete signed device envelope; `p_binding` is the original device-cookie token hash. New authorization requires server confirmation within the previous120seconds (never future), and proof time within the previous300seconds or at most30seconds future. Both are evaluated after locking. `POS_PIN_RECOVERY_PROOF_EXPIRED` is emitted only for an absent request after generation-conflict and current-access checks under locks. It is not permission to create a different request ID.

Changed stable identity under the same request ID raises `POS_PIN_RECOVERY_CONFLICT`. A unique `(key_epoch,actor_id,old_credential_sha256)` constraint prevents another ID from resetting the same generation. Exact lookup/replay remains available after staff/device/binding revocation and proof expiry; it cannot create or refresh authorization. A mismatching supplied `p_actor` is rejected even on approve replay.

## Persistence and locks

`pos_native_pin_recoveries` stores immutable operation identity, first device proof, confirmation/approval timestamps and canonical unsigned approval. `pos_native_pin_recovery_signatures` stores the first signed envelope. Both have RLS, no direct public/anonymous/authenticated/service-role table access, and immutable update/delete guards.

New authorization locks shared staff authority15, request advisory34, device row, binding row and epoch row in that order. Staff revocation takes exclusive authority15; direct device/binding updates serialize through row locks. Different request IDs for one generation serialize through device/epoch locks before the unique constraint. Lookup and signature attachment use only request advisory34, so they can recover accepted evidence without current financial authority. Attach requires the exact committed canonical approval and hash; a legitimate server signing-key rotation cannot replace the first saved envelope.

Native uses its authenticated PIN database as the reset journal. It freezes the full old row and candidate before HTTP and blocks local credential mutations while pending. It persists the verified grant before atomically applying the replacement credential plus immutable consumed-grant audit. The native private compare-and-swap covers the full original credential row, including attempt/revision state. Recovery leaves the device locked; explicit PIN unlock remains separate. Replaying an older grant after a later reset must not restore an old verifier or reset attempts.

## Verification boundary

`tests/integration/pos-pin-recovery.mjs` uses isolated synthetic PostgreSQL data and deliberately synthetic signature bytes: it tests SQL trust-boundary enforcement, not cryptography. It covers current actor/device/binding checks, original cashier scope, first-envelope preservation, replay after revocation, exact canonical bytes, proof/confirmation freshness, immutable generation consumption, unchanged financial custody and actual lock-wait races. Root service tests separately verify real P256 signatures. Android acceptance must separately prove authenticated local storage, crash recovery, native-only secrets and stale-dialog invalidation.
