// @vitest-environment node
import { expect, it } from 'vitest'
import fixture from '../../../fixtures/native-checkout-output.json'
import { decodeBase64Url } from '@/lib/pos/offline/canonical'
import { publicKeyFingerprint, verifyOfflineBundle, verifyOfflineIssuance, verifySignedEnvelope } from '@/lib/pos/offline/authority'
import { assessOfflineImport, validateHistoricalIssuance, type OfflineImportState } from '@/lib/pos/offline/validation'
import { offlineSealSchema } from '@/lib/pos/offline/server-contracts'

async function keys() {
  const importKey = (value: string) => crypto.subtle.importKey('spki', decodeBase64Url(value, 256), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
  return { server: await importKey(fixture.serverPublicKeySpki), device: await importKey(fixture.devicePublicKeySpki) }
}

it('accepts actual Android Keystore invoices through independent server signature and money validation', async () => {
  const key = await keys()
  const bundle = await verifyOfflineBundle(fixture.snapshotEnvelope, fixture.authorityEnvelope, { 'synthetic-server': key.server })
  const expected = [
    { grossFils: 1000, netFils: 952, taxFils: 48, invoiceSequence: 1 },
    { grossFils: 501, netFils: 477, taxFils: 24, invoiceSequence: 2 },
    { grossFils: 1000, netFils: 952, taxFils: 48, invoiceSequence: 3 },
  ]
  for (const [index, envelope] of fixture.issuances.entries()) {
    const verified = await verifyOfflineIssuance(envelope, bundle, key.device)
    const result = validateHistoricalIssuance(verified.issuance, bundle)
    expect(result).toMatchObject(expected[index])
    expect(result.issuance.document.merchant).toEqual(bundle.snapshot.profile)
  }
})

it('accepts the native chain once in order and independently rejects gaps and a replay without custody', async () => {
  const key = await keys()
  const bundle = await verifyOfflineBundle(fixture.snapshotEnvelope, fixture.authorityEnvelope, { 'synthetic-server': key.server })
  const a = bundle.authority
  const state: OfflineImportState = { device: { organizationId: a.organizationId, branchId: a.branchId, deviceId: a.deviceId, keyEpoch: a.keyEpoch, lastSequence: 0, lastEventSha256: null }, grant: { authorityId: a.id, grossFils: 0, invoiceCount: 0 }, matches: [] }
  const second = await verifyOfflineIssuance(fixture.issuances[1], bundle, key.device)
  expect(() => assessOfflineImport(validateHistoricalIssuance(second.issuance, bundle), second.payloadSha256, state)).toThrow('chain')
  for (const envelope of fixture.issuances) {
    const verified = await verifyOfflineIssuance(envelope, bundle, key.device)
    const decision = assessOfflineImport(validateHistoricalIssuance(verified.issuance, bundle), verified.payloadSha256, state)
    expect(decision.kind).toBe('accept')
    if (decision.kind !== 'accept') throw new Error('Native fixture was not accepted')
    state.device.lastSequence = decision.nextDeviceSequence
    state.device.lastEventSha256 = decision.nextEventSha256
    state.grant.grossFils = decision.nextGrantGrossFils
    state.grant.invoiceCount = decision.nextGrantInvoiceCount
  }
  expect(state.grant).toMatchObject({ grossFils: 2501, invoiceCount: 3 })
  const replay = await verifyOfflineIssuance(fixture.issuances[0], bundle, key.device)
  expect(() => assessOfflineImport(validateHistoricalIssuance(replay.issuance, bundle), replay.payloadSha256, state)).toThrow('chain')
  const seal = await verifySignedEnvelope(fixture.sealEnvelope, offlineSealSchema, { [await publicKeyFingerprint(key.device)]: key.device })
  expect(seal.payload).toMatchObject({ authorityId: a.id, deviceId: a.deviceId, keyEpoch: a.keyEpoch, finalSequence: 3, finalEventSha256: state.device.lastEventSha256 })
})
