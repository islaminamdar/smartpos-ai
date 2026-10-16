// @vitest-environment node
// Exported by actual Android SQLite/Keystore instrumentation with synthetic records.
import { expect, it } from 'vitest'
import actual from './fixtures/native-pin-recovery-android-output.json'
import { importOfflinePublicKey } from '@/lib/pos/offline/server-keys'
import { publicKeyFingerprint, verifySignedEnvelope } from '@/lib/pos/offline/authority'
import { nativePinRecoveryProofSchema, nativePinRecoveryApprovalSchema } from '@/lib/pos/offline/native-pin-recovery'
it('verifies the actual Android device proof and exact server approval scope/hash', async () => {
 const device = await importOfflinePublicKey(actual.publicKeySpki)
 const server = await importOfflinePublicKey(actual.serverPublicKeySpki)
 const proof = await verifySignedEnvelope(actual.proof, nativePinRecoveryProofSchema, { [await publicKeyFingerprint(device)]: device })
 const approval = await verifySignedEnvelope(actual.approval, nativePinRecoveryApprovalSchema, { [actual.approval.keyId]: server })
 const { kind: _kind, signedAt: _time, ...identity } = proof.payload
 expect(approval.payload).toMatchObject({ ...identity, kind: 'native-pin-recovery-approval', proofSha256: proof.payloadSha256 })
 expect(approval.payload.requestId).toBe(actual.states.completed.requestId)
 expect(Object.keys(actual).sort()).toEqual(['approval', 'proof', 'publicKeySpki', 'serverPublicKeySpki', 'states'])
})
it('does not trust the device signing key as the approval signer', async () => {
 const device = await importOfflinePublicKey(actual.publicKeySpki)
 await expect(verifySignedEnvelope(actual.approval, nativePinRecoveryApprovalSchema, { [actual.approval.keyId]: device })).rejects.toThrow()
})
