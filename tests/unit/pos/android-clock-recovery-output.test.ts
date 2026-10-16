// @vitest-environment node
// Public output from actual Android Keystore/SQLite instrumentation. Synthetic accounts only.
import { expect, it } from 'vitest'
import actual from './fixtures/native-clock-recovery-android-output.json'
import { importOfflinePublicKey } from '@/lib/pos/offline/server-keys'
import { publicKeyFingerprint, verifySignedEnvelope } from '@/lib/pos/offline/authority'
import {
  nativeClockRecoveryProofSchema,
  nativeClockRecoveryApprovalSchema,
  nativeClockRecoveryTimeSchema,
} from '@/lib/pos/offline/native-clock-recovery'

it('verifies actual Android proof, approval and separate fresh-time identity across runtimes', async () => {
  const device = await importOfflinePublicKey(actual.devicePublicKeySpki)
  const server = await importOfflinePublicKey(actual.serverPublicKeySpki)
  const proof = await verifySignedEnvelope(actual.proof, nativeClockRecoveryProofSchema, {
    [await publicKeyFingerprint(device)]: device,
  })
  const approval = await verifySignedEnvelope(actual.approval, nativeClockRecoveryApprovalSchema, {
    [actual.approval.keyId]: server,
  })
  const time = await verifySignedEnvelope(actual.time, nativeClockRecoveryTimeSchema, {
    [actual.time.keyId]: server,
  })
  const { kind: _kind, ...identity } = proof.payload
  expect(approval.payload).toMatchObject({
    ...identity,
    kind: 'native-clock-recovery-approval',
    proofSha256: proof.payloadSha256,
  })
  expect(time.payload).toMatchObject({
    requestId: proof.payload.requestId,
    approvalSha256: approval.payloadSha256,
    retirementSha256: proof.payload.retirementSha256,
    oldClockGeneration: proof.payload.oldClockGeneration,
  })
  expect(proof.payload).not.toHaveProperty('signedAt')
  expect(actual.states.completed.requestId).toBe(proof.payload.requestId)
  expect(Object.keys(actual).sort()).toEqual([
    'approval',
    'devicePublicKeySpki',
    'proof',
    'serverPublicKeySpki',
    'states',
    'time',
  ])
})
it('does not accept the enrolled device as the server approval or time signer', async () => {
  const device = await importOfflinePublicKey(actual.devicePublicKeySpki)
  await expect(
    verifySignedEnvelope(actual.approval, nativeClockRecoveryApprovalSchema, {
      [actual.approval.keyId]: device,
    })
  ).rejects.toThrow()
  await expect(
    verifySignedEnvelope(actual.time, nativeClockRecoveryTimeSchema, {
      [actual.time.keyId]: device,
    })
  ).rejects.toThrow()
})
