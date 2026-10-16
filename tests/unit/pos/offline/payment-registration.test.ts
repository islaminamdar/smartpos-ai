// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { z } from 'zod'
const m = vi.hoisted(() => ({ rpc: vi.fn(), auth: vi.fn() }))
vi.mock('@/lib/pos/server/client', async original => ({ ...await original<typeof import('@/lib/pos/server/client')>(),
  authenticatedPosClient: m.auth, posClient: () => ({ rpc: m.rpc }) }))
import fixture from '../../../fixtures/pos-offline-output.json'
import { registerOfflinePaymentFreeze, nativePaymentRegistrationStatusSchema, paymentRegistrationResponseSchema,
  MAX_PAYMENT_REGISTRATION_RESPONSE_BYTES } from '@/lib/pos/offline/payment-registration'
import { offlinePaymentFreezeSchema } from '@/lib/pos/offline/payment-freeze'
import { canonicalBytes, decodeBase64Url, encodeBase64Url, parseCanonicalPayload, sha256Hex } from '@/lib/pos/offline/canonical'
import { publicKeyFingerprint, signEnvelope, verifySignedEnvelope } from '@/lib/pos/offline/authority'
import type { OfflineAuthority, OfflineSnapshot, OfflineIssuance } from '@/lib/pos/offline/contracts'
import { nativeOfflinePreparedSchema } from '@/lib/pos/offline/native-preparation'

let server: CryptoKeyPair, device: CryptoKeyPair, snapshot: OfflineSnapshot, authority: OfflineAuthority,
  row: Record<string, unknown>, freeze: z.infer<typeof offlinePaymentFreezeSchema>, result: Record<string, unknown>
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const hash = async (value: unknown) => sha256Hex(canonicalBytes(value))
async function store() {
  authority.snapshotSha256 = await hash(snapshot)
  row = { snapshot, authority, snapshotSha256: authority.snapshotSha256, authoritySha256: await hash(authority),
    snapshotEnvelope: await signEnvelope(snapshot, 'server-v1', server.privateKey),
    authorityEnvelope: await signEnvelope(authority, 'server-v1', server.privateKey),
    publicKeySpki: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', device.publicKey))),
    keyEpoch: authority.keyEpoch, deviceId: authority.deviceId }
  if (freeze) { freeze.snapshotSha256 = authority.snapshotSha256; freeze.authoritySha256 = row.authoritySha256 as string }
}
async function proofs(challenge = 'a'.repeat(64)) {
  freeze.requestSha256 = await hash(freeze.request)
  const freezeSha256 = await hash(freeze)
  const envelope = await signEnvelope(freeze, authority.deviceKeySha256, device.privateKey)
  const query = await signEnvelope({ kind: 'offline-payment-resolution-query', schemaVersion: 1, authorityId: freeze.authorityId,
    keyEpoch: freeze.keyEpoch, deviceId: freeze.deviceId, freezeId: freeze.freezeId, freezeSha256, challenge }, authority.deviceKeySha256, device.privateKey)
  result = { status: 'registered', freezeId: freeze.freezeId, freezeSha256, paymentIntentId: freeze.paymentIntentId,
    authorityId: freeze.authorityId, replayed: false, hasConflicts: false }
  return { envelope, query }
}
async function issued(p: Awaited<ReturnType<typeof proofs>>) {
  const a = authority, product = snapshot.products[0]
  const issuance: OfflineIssuance = { kind: 'offline-sale', schemaVersion: 1, id: freeze.orderId, authorityId: a.id,
    authoritySha256: freeze.authoritySha256, snapshotSha256: freeze.snapshotSha256,
    paymentIntentId: freeze.paymentIntentId, deviceSequence: 1, previousEventSha256: null,
    clock: { estimatedServerAt: a.issuedAt, bootId: id(8), elapsedRealtimeMs: 1000 },
    document: { schemaVersion: 1, id: freeze.documentId, kind: 'tax_invoice',
      documentNumber: `${a.invoiceRange.prefix}-INV-${String(a.invoiceRange.first).padStart(10, '0')}`, issuedAt: a.issuedAt,
      merchant: snapshot.profile, orderId: freeze.orderId, branchId: a.branchId, deviceId: a.deviceId, shiftId: a.shiftId, actorId: a.actorId,
      serviceType: 'takeaway', customer: null, lines: [{ lineNumber: 1, productId: product.id, name: product.name,
        unit: product.unit, quantityMilli: 1000, unitPriceFils: 1000, taxRateBps: 500, grossFils: 1000, netFils: 952, taxFils: 48 }],
      totals: { grossFils: 1000, netFils: 952, taxFils: 48 }, payments: [{ method: 'cash', amountFils: 1000 }],
      paymentSettlement: 'recorded', cashTenderedFils: 1500, changeFils: 500 } }
  const acknowledgementPayload = { kind: 'offline-ack', schemaVersion: 1, id: id(9), issuanceId: issuance.id,
    payloadSha256: await hash(issuance), authorityId: a.id, keyEpoch: a.keyEpoch, deviceSequence: 1, receivedAt: new Date().toISOString() }
  result = { status: 'already_issued', freezeId: freeze.freezeId, freezeSha256: await hash(freeze), authorityId: a.id,
    conflictId: id(10), receipt: issuance.document, acknowledgement: await signEnvelope(acknowledgementPayload, 'server-v1', server.privateKey),
    issuanceEnvelope: await signEnvelope(issuance, a.deviceKeySha256, device.privateKey) }
  return { ...p, issuance, acknowledgementPayload }
}
async function status(response: Awaited<ReturnType<typeof registerOfflinePaymentFreeze>>) {
  return (await verifySignedEnvelope(response.handoff, nativePaymentRegistrationStatusSchema, { 'server-v1': server.publicKey })).payload
}
beforeEach(async () => {
  vi.resetAllMocks(); m.auth.mockRejectedValue(new Error('revoked'))
  for (const flag of ['POS_ONLINE_PILOT', 'POS_LIVE_SALES_ENABLED', 'POS_OFFLINE_ISSUANCE_ENABLED']) vi.stubEnv(flag, 'false')
  server = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  device = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  vi.stubEnv('POS_OFFLINE_SIGNING_KEY_ID', 'server-v1')
  vi.stubEnv('POS_OFFLINE_SERVER_KEYS', JSON.stringify([{ id: 'server-v1', publicKeySpki: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', server.publicKey))), privateKeyPkcs8: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', server.privateKey))) }]))
  snapshot = structuredClone(fixture.bundle.snapshot) as OfflineSnapshot
  authority = { ...structuredClone(fixture.bundle.authority), deviceKeySha256: await publicKeyFingerprint(device.publicKey) } as OfflineAuthority
  await store()
  freeze = { kind: 'offline-payment-freeze', schemaVersion: 1, freezeId: id(1), paymentIntentId: id(2), orderId: id(3), documentId: id(4),
    organizationId: authority.organizationId, branchId: authority.branchId, deviceId: authority.deviceId, actorId: authority.actorId, shiftId: authority.shiftId,
    keyEpoch: authority.keyEpoch, deviceKeySha256: authority.deviceKeySha256, authorityId: authority.id,
    authoritySha256: row.authoritySha256 as string, snapshotSha256: authority.snapshotSha256, requestSha256: '0'.repeat(64),
    request: { authorityId: authority.id, serviceType: 'takeaway', customer: null, lines: [{ productId: snapshot.products[0].id, quantityMilli: 1000 }],
      cashTenderedFils: 1500, recordedCardFils: 0, presentedTotalFils: 1000 }, intentCreatedAt: authority.issuedAt,
    chainHead: { sequence: 0, eventSha256: null }, observation: null, declaration: 'local-intent-unissued-and-permanently-frozen' }
  m.rpc.mockImplementation(async (name, args) => {
    if (name === 'pos_offline_authority') { expect(args).toEqual({ p_id: authority.id }); return { data: row, error: null } }
    expect(name).toBe('pos_offline_payment_freeze'); expect(Object.keys(args)).toEqual(['p_envelope'])
    return { data: result, error: null }
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('registers verified evidence without current access or selling flags and signs an exact pending challenge', async () => {
  const p = await proofs(), response = await registerOfflinePaymentFreeze(p.envelope, p.query), s = await status(response)
  expect(s).toMatchObject({ state: 'pending', purpose: 'reconciliation-only', challenge: 'a'.repeat(64), authorityId: authority.id,
    keyEpoch: authority.keyEpoch, deviceId: authority.deviceId, freezeId: freeze.freezeId, freezeSha256: await hash(freeze),
    resolutionSha256: null, issuanceSha256: null })
  expect(response).toMatchObject({ receipt: null, acknowledgement: null, resolutionEnvelope: null })
  expect(nativeOfflinePreparedSchema.safeParse(s).success).toBe(false)
  expect(m.auth).not.toHaveBeenCalled(); expect(m.rpc.mock.calls.map(([name]) => name)).toEqual(['pos_offline_authority', 'pos_offline_payment_freeze'])
})
it('retains original registration identity across fresh queries and exact lost-response retries', async () => {
  const first = await proofs(), a = await status(await registerOfflinePaymentFreeze(first.envelope, first.query))
  const next = await proofs('b'.repeat(64)); result.replayed = true
  const b = await status(await registerOfflinePaymentFreeze(first.envelope, next.query))
  expect(b.freezeSha256).toBe(a.freezeSha256); expect(b.challenge).toBe('b'.repeat(64))
  const writes = m.rpc.mock.calls.filter(([name]) => name === 'pos_offline_payment_freeze')
  expect(writes.map(([, args]) => args.p_envelope)).toEqual([first.envelope, first.envelope])
})
it('preserves a pending case when status signing fails and retries the same registration only', async () => {
  const p = await proofs(), sign = crypto.subtle.sign.bind(crypto.subtle)
  const spy = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
    if (new TextDecoder().decode(args[2] as ArrayBuffer).includes('native-payment-resolution-status')) throw new Error('synthetic signing interruption')
    return sign(...args)
  })
  await expect(registerOfflinePaymentFreeze(p.envelope, p.query)).rejects.toThrow('synthetic signing interruption')
  expect(m.rpc.mock.calls.filter(([name]) => name === 'pos_offline_payment_freeze')).toHaveLength(1)
  spy.mockRestore(); result.replayed = true
  expect((await status(await registerOfflinePaymentFreeze(p.envelope, p.query))).state).toBe('pending')
  expect(m.rpc.mock.calls.filter(([name]) => name === 'pos_offline_payment_freeze').every(([, args]) => args.p_envelope === p.envelope || JSON.stringify(args.p_envelope) === JSON.stringify(p.envelope))).toBe(true)
})
it('never registers an invalid device signature or a query for another freeze', async () => {
  const p = await proofs(), wrong = await signEnvelope(freeze, authority.deviceKeySha256, server.privateKey)
  await expect(registerOfflinePaymentFreeze(wrong, p.query)).rejects.toMatchObject({ status: 403 })
  const query = { ...parseCanonicalPayload(decodeBase64Url(p.query.payloadBase64Url)) as object, freezeSha256: 'b'.repeat(64) }
  await expect(registerOfflinePaymentFreeze(p.envelope, await signEnvelope(query, authority.deviceKeySha256, device.privateKey))).rejects.toThrow()
  expect(m.rpc.mock.calls.every(([name]) => name === 'pos_offline_authority')).toBe(true)
})
it('does not register anything when the active signing configuration is unavailable', async () => {
  const p = await proofs(); vi.stubEnv('POS_OFFLINE_SERVER_KEYS', '')
  await expect(registerOfflinePaymentFreeze(p.envelope, p.query)).rejects.toMatchObject({ code: 'offline_signing_unavailable' })
  expect(m.rpc).not.toHaveBeenCalled()
})
it('maps unknown storage failures to a bounded error without exposing SQL details', async () => {
  const p = await proofs()
  m.rpc.mockImplementation(async name => name === 'pos_offline_authority' ? { data: row, error: null } : { data: null, error: { message: 'private SQL internal details' } })
  await expect(registerOfflinePaymentFreeze(p.envelope, p.query)).rejects.toMatchObject({ code: 'offline_storage_unavailable', status: 503 })
})
it('rejects mismatched registration identity, unknown fields, and unsupported resolved outcomes', async () => {
  const p = await proofs(), original = { ...result }
  for (const change of [{ freezeId: id(99) }, { freezeSha256: 'c'.repeat(64) }, { authorityId: id(99) },
    { paymentIntentId: id(99) }, { status: 'resolved' }, { extra: true }, { hasConflicts: undefined }]) {
    result = { ...original, ...change }
    await expect(registerOfflinePaymentFreeze(p.envelope, p.query)).rejects.toMatchObject({ code: 'offline_storage_unavailable' })
  }
})
it('returns only bounded signed conflict status without disclosing private conflict records', async () => {
  const p = await proofs()
  result = { status: 'conflict', freezeId: freeze.freezeId, freezeSha256: await hash(freeze), authorityId: authority.id,
    conflictId: id(10), code: 'identity_collision' }
  const response = await registerOfflinePaymentFreeze(p.envelope, p.query)
  expect((await status(response)).state).toBe('conflict')
  expect(JSON.stringify(response)).not.toContain(id(10)); expect(response.receipt).toBeNull()
})
it('does not hide a later conflicting import behind an exact successful registration replay', async () => {
  const p = await proofs(); result.replayed = true; result.hasConflicts = true
  expect((await status(await registerOfflinePaymentFreeze(p.envelope, p.query))).state).toBe('conflict')
})
it('independently verifies the exact original invoice, device proof and server ACK before already-issued status', async () => {
  const p = await issued(await proofs()), response = await registerOfflinePaymentFreeze(p.envelope, p.query)
  expect(await status(response)).toMatchObject({ state: 'already_issued', issuanceSha256: await hash(p.issuance), resolutionSha256: null })
  expect(response.receipt).toEqual(p.issuance.document); expect(response.acknowledgement).toEqual(result.acknowledgement)
})
it('rejects a validly signed ACK for any other invoice identity, hash, authority, epoch or sequence', async () => {
  const p = await issued(await proofs())
  for (const change of [{ issuanceId: id(99) }, { payloadSha256: 'c'.repeat(64) }, { authorityId: id(99) }, { keyEpoch: id(99) }, { deviceSequence: 2 }]) {
    result.acknowledgement = await signEnvelope({ ...p.acknowledgementPayload, ...change }, 'server-v1', server.privateKey)
    await expect(registerOfflinePaymentFreeze(p.envelope, p.query)).rejects.toMatchObject({ code: 'offline_storage_unavailable' })
  }
})
it('rejects a substituted receipt or signed issuance inconsistent with the frozen request', async () => {
  const p = await issued(await proofs()), saved = structuredClone(result)
  result.receipt = { ...p.issuance.document, cashTenderedFils: 1600, changeFils: 600 }
  await expect(registerOfflinePaymentFreeze(p.envelope, p.query)).rejects.toMatchObject({ code: 'offline_storage_unavailable' })
  result = saved
  for (const change of [{ paymentIntentId: id(99) }, { id: id(99), document: { ...p.issuance.document, orderId: id(99) } },
    { document: { ...p.issuance.document, serviceType: 'delivery' } },
    { document: { ...p.issuance.document, cashTenderedFils: 1600, changeFils: 600 } }]) {
    const issuance = { ...p.issuance, ...change }
    result.receipt = issuance.document; result.issuanceEnvelope = await signEnvelope(issuance, authority.deviceKeySha256, device.privateKey)
    result.acknowledgement = await signEnvelope({ ...p.acknowledgementPayload, issuanceId: issuance.id, payloadSha256: await hash(issuance) }, 'server-v1', server.privateKey)
    await expect(registerOfflinePaymentFreeze(p.envelope, p.query)).rejects.toMatchObject({ code: 'offline_storage_unavailable' })
  }
})
it('rejects foreign issuance/ACK signers and receipt schema normalization', async () => {
  const p = await issued(await proofs()), saved = structuredClone(result)
  result.issuanceEnvelope = await signEnvelope(p.issuance, authority.deviceKeySha256, server.privateKey)
  await expect(registerOfflinePaymentFreeze(p.envelope, p.query)).rejects.toThrow()
  result = structuredClone(saved); result.acknowledgement = await signEnvelope(p.acknowledgementPayload, 'server-v1', device.privateKey)
  await expect(registerOfflinePaymentFreeze(p.envelope, p.query)).rejects.toThrow()
  result = structuredClone(saved); result.receipt = { ...p.issuance.document, merchant: { ...p.issuance.document.merchant, legalName: ' Synthetic legal ' } }
  await expect(registerOfflinePaymentFreeze(p.envelope, p.query)).rejects.toThrow()
})
it('rejects status hash combinations, extra fields, manager decisions and receipt-only transport', async () => {
  const p = await proofs(), response = await registerOfflinePaymentFreeze(p.envelope, p.query), s = await status(response)
  for (const change of [{ state: 'resolved' }, { resolutionSha256: 'a'.repeat(64) }, { state: 'already_issued' }, { issuanceSha256: 'a'.repeat(64) }, { extra: true }])
    expect(nativePaymentRegistrationStatusSchema.safeParse({ ...s, ...change }).success).toBe(false)
  const invoice = await issued(p)
  expect(paymentRegistrationResponseSchema.safeParse({ ...response, receipt: invoice.issuance.document }).success).toBe(false)
})
it('accepts a large historical catalogue without canonicalizing the duplicated SQL reader as one signed payload', async () => {
  snapshot.products = Array.from({ length: 1800 }, (_, i) => ({ ...snapshot.products[0], id: id(100 + i), name: 'Synthetic '.repeat(20) + i }))
  freeze.request.lines = [{ productId: snapshot.products[0].id, quantityMilli: 1000 }]
  await store(); const p = await proofs()
  expect(JSON.stringify(row).length).toBeGreaterThan(1_048_576)
  const response = await registerOfflinePaymentFreeze(p.envelope, p.query)
  expect((await status(response)).state).toBe('pending')
  expect(new TextEncoder().encode(JSON.stringify(response)).length).toBeLessThan(MAX_PAYMENT_REGISTRATION_RESPONSE_BYTES)
})
it('verifies a maximum-line-count original receipt and measures its bounded response', async () => {
  snapshot.products = Array.from({ length: 200 }, (_, i) => ({ ...snapshot.products[0], id: id(100 + i), name: '菓'.repeat(240) }))
  authority.maxInvoiceTotalFils = 200_000; authority.maxGrossFils = 600_000
  freeze.request.lines = snapshot.products.map(product => ({ productId: product.id, quantityMilli: 1000 }))
  freeze.request.cashTenderedFils = 200_000; freeze.request.presentedTotalFils = 200_000
  await store(); const p = await issued(await proofs())
  const d = p.issuance.document
  if (d.kind !== 'tax_invoice' || d.schemaVersion !== 1) throw new Error('Expected original invoice')
  d.lines = snapshot.products.map((product, i) => ({ lineNumber: i + 1, productId: product.id, name: product.name, unit: product.unit,
    quantityMilli: 1000, unitPriceFils: 1000, taxRateBps: 500, grossFils: 1000, netFils: 952, taxFils: 48 }))
  d.totals = { grossFils: 200_000, netFils: 190_400, taxFils: 9600 }; d.payments = [{ method: 'cash', amountFils: 200_000 }]
  d.cashTenderedFils = 200_000; d.changeFils = 0
  result.receipt = d; result.issuanceEnvelope = await signEnvelope(p.issuance, authority.deviceKeySha256, device.privateKey)
  result.acknowledgement = await signEnvelope({ ...p.acknowledgementPayload, payloadSha256: await hash(p.issuance) }, 'server-v1', server.privateKey)
  const response = await registerOfflinePaymentFreeze(p.envelope, p.query)
  expect((await status(response)).state).toBe('already_issued'); expect(response.receipt?.lines).toHaveLength(200)
  const bytes = new TextEncoder().encode(JSON.stringify(response)).length
  expect(bytes).toBeGreaterThan(180_000); expect(bytes).toBeLessThan(MAX_PAYMENT_REGISTRATION_RESPONSE_BYTES)
})


it('retains verified historical NUL text as exact raw evidence and signs only a conflict', async () => {
  freeze.request.customer = { name: 'Buyer\u0000Name', address: 'Street', trn: null }
  const p = await proofs()
  m.rpc.mockImplementation(async (name, args) => {
    if (name === 'pos_offline_authority') return { data: row, error: null }
    expect(name).toBe('pos_offline_retain_unsupported')
    expect(args).toEqual({ p_authority: authority.id, p_envelope: p.envelope })
    return { data: { status: 'reconciliation_required', exceptionId: id(88), code: 'unsupported_text' }, error: null }
  })
  const response = await registerOfflinePaymentFreeze(p.envelope, p.query)
  expect(await status(response)).toMatchObject({ state: 'conflict', freezeSha256: await hash(freeze), resolutionSha256: null, issuanceSha256: null })
  expect(response).toMatchObject({ receipt: null, acknowledgement: null, resolutionEnvelope: null })
  expect(m.rpc.mock.calls.map(([name]) => name)).toEqual(['pos_offline_authority', 'pos_offline_retain_unsupported'])
  const wrong = await signEnvelope(freeze, authority.deviceKeySha256, server.privateKey)
  m.rpc.mockClear()
  await expect(registerOfflinePaymentFreeze(wrong, p.query)).rejects.toThrow()
  expect(m.rpc.mock.calls.every(([name]) => name === 'pos_offline_authority')).toBe(true)
})
it('does not report raw custody when storage failed or returned another result', async () => {
  freeze.request.customer = { name: 'Buyer', address: 'Street\u0000Address', trn: null }
  const p = await proofs()
  for (const response of [{ data: null, error: { message: 'private details' } },
    { data: { status: 'reconciliation_required', exceptionId: id(88), code: 'different' }, error: null },
    { data: { status: 'reconciliation_required', exceptionId: id(88), code: 'unsupported_text', extra: true }, error: null }]) {
    m.rpc.mockImplementation(async name => name === 'pos_offline_authority' ? { data: row, error: null } : response)
    await expect(registerOfflinePaymentFreeze(p.envelope, p.query)).rejects.toMatchObject({ code: 'offline_storage_unavailable' })
  }
})
it('keeps literal backslash-u0000 and Arabic or emoji on the ordinary historical path', async () => {
  freeze.request.customer = { name: 'Buyer\\u0000Name', address: 'دبي 🍬', trn: null }
  const p = await proofs()
  expect((await status(await registerOfflinePaymentFreeze(p.envelope, p.query))).state).toBe('pending')
  expect(m.rpc.mock.calls.map(([name]) => name)).toEqual(['pos_offline_authority', 'pos_offline_payment_freeze'])
})
