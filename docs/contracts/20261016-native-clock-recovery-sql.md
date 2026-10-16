# Native clock recovery SQL boundary

SQL028 is an additive approval ledger for the [native clock recovery protocol](20261016-native-clock-recovery.md). Applying this migration does not repair a device clock, retire an allocation, reset a PIN, issue a payment decision or enable offline selling. Native persistence and the service signing boundary perform separate work.

## Service interface

All four public functions are `SECURITY DEFINER` with an empty search path and execute permission only for `service_role`. Anonymous and authenticated callers cannot invoke them. The private proof parser is not executable even by `service_role`. Both new tables have RLS, no direct table privileges for public/anonymous/authenticated/service roles, and immutable update/delete guards.

| Function | Result |
| --- | --- |
| `pos_native_clock_recovery_context(p_epoch uuid)` | Historical enrolled organization, branch, device, epoch, fingerprint and public key, or null. No current-access filtering. |
| `pos_native_clock_recovery_lookup(p_proof jsonb)` | Null for an unknown request; otherwise `{approval, approvalEnvelope}`. The envelope may be null while signature attachment is pending. |
| `pos_native_clock_recovery_approve(p_actor uuid, p_binding text, p_proof jsonb, p_confirmed_at timestamptz)` | The same result, creating at most one immutable approval for an installation/key epoch/old generation. |
| `pos_native_clock_recovery_attach(p_request uuid, p_envelope jsonb)` | The same result with the first exact signed approval envelope retained. |

The proof has exactly `kind: native-clock-recovery`, `schemaVersion: 1`, requestId, installationId, organizationId, branchId, deviceId, actorId, keyEpoch, deviceKeySha256, oldClockGeneration, oldClockSha256 and retirementSha256. IDs are lowercase UUID strings. Hashes are lowercase SHA256 hexadecimal. Generation is a JSON integer from zero through 9007199254740991. There is no device timestamp. Unknown fields, missing fields, coerced numbers, noncanonical bytes and a different enrolled key scope are rejected.

The approval preserves every identity field, changes kind to `native-clock-recovery-approval`, and adds the exact canonical device payload hash as proofSha256 plus server-approved UTC milliseconds as approvedAt. No transient challenge or fresh server-time value is stored in this approval. The service must verify the registered P256 device signature before either lookup or approval, and verify the server signature before attachment. SQL checks canonical bytes, exact hashes and identity; it does not verify ECDSA, Android Keystore/MAC state, the retirement manifest contents or the account password.

## Authorization, concurrency and replay

New approval requires the proof actor to equal the trusted service actor, a current active staff membership and branch, an active device, and the original actor's unrevoked device-cookie binding. A current cashier can recover their own native scope even if a manager enrolled the key. A financially blocked epoch stays blocked and can still authorize this bounded access repair.

The service supplies the timestamp captured immediately after successful original-account password confirmation. SQL evaluates it after all locks: it must be finite, no later than server time and no older than 120 seconds. The broken device clock is never used for authorization freshness. The service separately revokes the temporary password-confirmation session and signs each transient native challenge/time handoff.

Lock order is shared staff authority15, request advisory41, branch row SHARE, device row UPDATE, original binding row SHARE, then epoch row UPDATE. Staff writers use the exclusive authority gate. Row locks serialize branch/device/binding deactivation; the epoch lock serializes competing request IDs consuming one generation. A unique `(installation_id, key_epoch, old_clock_generation)` constraint also protects consumption across different actors or changed clock/retirement hashes.

The entire proof payload is immutable operation identity. An identical payload with a different valid DER signature returns the first approval and retains the first device proof envelope. Any changed identity under a known request ID conflicts. Another request for the consumed generation conflicts, including when its old clock or retirement hash differs. Exact accepted replay does not need fresh confirmation or current membership; a mismatching trusted actor is still rejected on the approve path. Historical lookup remains available after revocation and cannot create another approval. Lookup and attachment use only the request lock, preserving recovery after authorization changes.

Signature attachment must reproduce the exact committed approval payload, canonical bytes and SHA256. The first valid envelope wins; a later signing-key rotation or valid alternate DER signature cannot replace it. The native consumer must still enforce its immutable retirement evidence, old-generation compare-and-swap, consumed audit, fresh challenge lifetime and locked completion. A database approval is not proof that native application succeeded.

## Verification boundary

`tests/integration/pos-clock-recovery.mjs` creates a uniquely named disposable database on an explicitly supplied QA Unix socket, applies all SQL001–028, and drops only the database it created. Synthetic keys and signatures deliberately isolate the SQL trust boundary; they are not cryptographic verification evidence.

The suite tests strict parsing and canonical bytes, safe integer boundaries, exact immutable replay, generation conflicts, first signature attachment, staff/device/binding/branch denial, password-confirmation freshness, table/RPC permissions and empty search paths. Independent PostgreSQL sessions demonstrate lock waits for duplicate/competing approvals, lookup, signature attachment, staff/device/binding/branch revocation and confirmation expiry while waiting.

Preservation checks hash every preexisting public table around approval, lookup, replay and attachment. The fixture includes an actually imported synthetic bill, document, payment, offline receipt, authority, frozen payment and prior PIN approval/signature, so these assertions include populated custody. The test does not inspect Android PIN storage or prove hardware behavior. Real signature/service, native crash/reboot/clock and UI acceptance evidence are separate gates. No production migration or enablement is implied.
