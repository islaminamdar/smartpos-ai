// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { z } from 'zod'
const m = vi.hoisted(() => ({ rpc: vi.fn(), auth: vi.fn() }))
vi.mock('@/lib/pos/server/client', async original => ({ ...await original<typeof import('@/lib/pos/server/client')>(),
  authenticatedPosClient: m.auth, posClient: () => ({ rpc: m.rpc }) }))
import fixture from '../../../fixtures/pos-offline-output.json'
import { verifyOfflinePaymentFreeze, offlinePaymentFreezeSchema, offlinePaymentIntentRequestSchema, offlinePaymentResolutionQuerySchema } from '@/lib/pos/offline/payment-freeze'
import { canonicalBytes, decodeBase64Url, encodeBase64Url, parseCanonicalPayload, sha256Hex } from '@/lib/pos/offline/canonical'
import { publicKeyFingerprint, signEnvelope } from '@/lib/pos/offline/authority'
import { offlineIssuanceSchema, type OfflineAuthority, type OfflineSnapshot, type SignedEnvelope } from '@/lib/pos/offline/contracts'
import { nativeOfflinePreparedSchema } from '@/lib/pos/offline/native-preparation'

let server: CryptoKeyPair, device: CryptoKeyPair, snapshot: OfflineSnapshot, authority: OfflineAuthority,
  row: Record<string, unknown>, freeze: z.infer<typeof offlinePaymentFreezeSchema>
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
async function stored() {
  authority.snapshotSha256 = await sha256Hex(canonicalBytes(snapshot))
  row = { snapshot, authority, snapshotSha256: authority.snapshotSha256, authoritySha256: await sha256Hex(canonicalBytes(authority)),
    snapshotEnvelope: await signEnvelope(snapshot, 'server-v1', server.privateKey), authorityEnvelope: await signEnvelope(authority, 'server-v1', server.privateKey),
    publicKeySpki: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', device.publicKey))), keyEpoch: authority.keyEpoch, deviceId: authority.deviceId }
  if (freeze) { freeze.snapshotSha256 = authority.snapshotSha256; freeze.authoritySha256 = row.authoritySha256 as string }
}
async function proofs(change: Record<string, unknown> = {}, queryChange: Record<string, unknown> = {}) {
  const payload = { ...freeze, ...change }
  if (change.request && !Object.hasOwn(change, 'requestSha256')) payload.requestSha256 = await sha256Hex(canonicalBytes(change.request))
  const envelope = await signEnvelope(payload, authority.deviceKeySha256, device.privateKey)
  const query = { kind: 'offline-payment-resolution-query', schemaVersion: 1, authorityId: payload.authorityId,
    keyEpoch: payload.keyEpoch, deviceId: payload.deviceId, freezeId: payload.freezeId,
    freezeSha256: await sha256Hex(canonicalBytes(payload)), challenge: 'a'.repeat(64), ...queryChange }
  return { envelope, query: await signEnvelope(query, authority.deviceKeySha256, device.privateKey), queryPayload: query }
}
async function verify(change: Record<string, unknown> = {}, queryChange: Record<string, unknown> = {}) {
  const p = await proofs(change, queryChange); return verifyOfflinePaymentFreeze(p.envelope, p.query)
}
beforeEach(async () => {
  vi.resetAllMocks(); m.auth.mockRejectedValue(new Error('Current staff access revoked'))
  for (const flag of ['POS_ONLINE_PILOT', 'POS_LIVE_SALES_ENABLED', 'POS_OFFLINE_ISSUANCE_ENABLED']) vi.stubEnv(flag, 'false')
  server = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  device = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  vi.stubEnv('POS_OFFLINE_SIGNING_KEY_ID', 'server-v1')
  vi.stubEnv('POS_OFFLINE_SERVER_KEYS', JSON.stringify([{ id: 'server-v1', publicKeySpki: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', server.publicKey))), privateKeyPkcs8: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', server.privateKey))) }]))
  snapshot = structuredClone(fixture.bundle.snapshot) as OfflineSnapshot
  authority = { ...structuredClone(fixture.bundle.authority), deviceKeySha256: await publicKeyFingerprint(device.publicKey) } as OfflineAuthority
  await stored()
  const request = { authorityId: authority.id, serviceType: 'takeaway' as const, customer: null,
    lines: [{ productId: snapshot.products[0].id, quantityMilli: 1000 }, { productId: snapshot.products[1].id, quantityMilli: 500 }],
    cashTenderedFils: 2000, recordedCardFils: 500, presentedTotalFils: 1501 }
  freeze = { kind: 'offline-payment-freeze', schemaVersion: 1, freezeId: id(1), paymentIntentId: id(2), orderId: id(3), documentId: id(4),
    organizationId: authority.organizationId, branchId: authority.branchId, deviceId: authority.deviceId, actorId: authority.actorId, shiftId: authority.shiftId,
    keyEpoch: authority.keyEpoch, deviceKeySha256: authority.deviceKeySha256, authorityId: authority.id,
    authoritySha256: row.authoritySha256 as string, snapshotSha256: authority.snapshotSha256, requestSha256: await sha256Hex(canonicalBytes(request)),
    request, intentCreatedAt: authority.issuedAt, chainHead: { sequence: 0, eventSha256: null }, observation: null,
    declaration: 'local-intent-unissued-and-permanently-frozen' }
  m.rpc.mockImplementation(async (name, args) => { expect(name).toBe('pos_offline_authority'); expect(args).toEqual({ p_id: authority.id }); return { data: row, error: null } })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('verifies real device/server signatures and recomputes weighted mixed tender as evidence only', async () => {
  const result = await verify()
  expect(result.kind).toBe('verified-offline-payment-freeze'); expect(result.purpose).toBe('reconciliation-only')
  expect(result.freeze).toEqual(freeze)
  expect(result.quote).toMatchObject({ calculationVersion: 'offline-line-v1', totals: { grossFils: 1501, taxFils: 72, netFils: 1429 },
    payments: [{ method: 'cash', amountFils: 1001 }, { method: 'card', amountFils: 500 }], cashTenderedFils: 2000, changeFils: 999, requiresBuyerDetails: false })
  expect(result.quote.lines.map(line => [line.grossFils, line.taxFils])).toEqual([[1000, 48], [501, 24]])
  expect(offlineIssuanceSchema.safeParse(result).success).toBe(false); expect(offlineIssuanceSchema.safeParse(result.freeze).success).toBe(false)
  expect(nativeOfflinePreparedSchema.safeParse(result).success).toBe(false)
  expect(m.auth).not.toHaveBeenCalled(); expect(m.rpc).toHaveBeenCalledTimes(1)
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.freeze.request.lines[0])).toBe(true); expect(Object.isFrozen(result.quote.payments)).toBe(true)
  expect(() => Object.assign(result.freeze.request, { presentedTotalFils: 1 })).toThrow()
})
it('preserves immutable freeze identity across signatures and fresh query challenges', async () => {
  const a = await verify(), b = await verify({}, { challenge: 'b'.repeat(64) })
  expect(b.freezeSha256).toBe(a.freezeSha256); expect(b.freeze).toEqual(a.freeze); expect(b.querySha256).not.toBe(a.querySha256)
  expect(b.query.challenge).toBe('b'.repeat(64)); expect(m.rpc.mock.calls.every(([name]) => name === 'pos_offline_authority')).toBe(true)
})
it('does not turn upload expiry, diagnostic timestamps, or an ahead-of-server chain head into an authorization gate', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(authority.expiresAt) + 10 * 86400000)
  const result = await verify({ intentCreatedAt: '2000-01-01T00:00:00.000Z', chainHead: { sequence: 999, eventSha256: 'c'.repeat(64) },
    observation: { bootId: id(5), elapsedRealtimeMs: Number.MAX_SAFE_INTEGER, wallTimeMs: 0 } })
  expect(result.freeze.chainHead.sequence).toBe(999); expect(result.freeze.intentCreatedAt).toBe('2000-01-01T00:00:00.000Z')
  expect(result.freeze.observation?.wallTimeMs).toBe(0); expect(m.auth).not.toHaveBeenCalled()
})
it('binds every authority scope and immutable bundle hash', async () => {
  for (const field of ['organizationId', 'branchId', 'deviceId', 'actorId', 'shiftId', 'keyEpoch'])
    await expect(verify({ [field]: id(99) })).rejects.toMatchObject({ code: 'offline_payment_freeze_invalid' })
  for (const field of ['deviceKeySha256', 'authoritySha256', 'snapshotSha256', 'requestSha256'])
    await expect(verify({ [field]: '0'.repeat(64) })).rejects.toMatchObject({ code: 'offline_payment_freeze_invalid' })
  await expect(verify({ request: { ...freeze.request, authorityId: id(99) } })).rejects.toThrow()
  m.rpc.mockResolvedValue({ data: row, error: null })
  await expect(verify({ authorityId: id(99), request: { ...freeze.request, authorityId: id(99) } })).rejects.toMatchObject({ code: 'offline_payment_freeze_invalid' })
})
it('binds signed query to exact freeze, enrolled epoch/device and canonical payload hash', async () => {
  for (const field of ['authorityId', 'keyEpoch', 'deviceId', 'freezeId']) await expect(verify({}, { [field]: id(99) })).rejects.toThrow()
  await expect(verify({}, { freezeSha256: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'offline_payment_freeze_invalid' })
  for (const change of [{ challenge: 'A'.repeat(64) }, { challenge: 'a'.repeat(63) }, { unexpected: true }, { kind: 'offline-bundle-recovery' }]) await expect(verify({}, change)).rejects.toThrow()
})
it('rejects foreign keys, wrong key IDs, altered order/document IDs and payload substitutions', async () => {
  const p = await proofs()
  for (const signed of [await signEnvelope(freeze, authority.deviceKeySha256, server.privateKey), { ...p.envelope, keyId: 'unknown' },
    { ...p.envelope, payloadBase64Url: encodeBase64Url(canonicalBytes({ ...freeze, orderId: id(99) })) },
    { ...p.envelope, payloadBase64Url: encodeBase64Url(canonicalBytes({ ...freeze, documentId: id(99) })) }])
    await expect(verifyOfflinePaymentFreeze(signed, p.query)).rejects.toMatchObject({ code: 'offline_device_proof_invalid' })
  await expect(verifyOfflinePaymentFreeze(p.envelope, await signEnvelope(p.queryPayload, authority.deviceKeySha256, server.privateKey))).rejects.toMatchObject({ code: 'offline_device_proof_invalid' })
})
it('validates all evidence identities without pretending that their database uniqueness is known', async () => {
  for (const field of ['freezeId', 'paymentIntentId', 'orderId', 'documentId']) {
    await expect(verify({ [field]: 'invalid' })).rejects.toThrow()
    await expect(verify({ [field]: '00000000-0000-4000-8000-0000000000AA' })).rejects.toThrow()
  }
  const a = await verify(), b = await verify({ orderId: id(99) })
  expect(b.freezeSha256).not.toBe(a.freezeSha256) // Future SQL claim must reject this same-freeze identity conflict.
  expect(m.rpc.mock.calls.every(([name]) => name === 'pos_offline_authority')).toBe(true)
})
it('rejects signed unknown fields, customer normalization, malformed timestamps and invalid chain shape', async () => {
  for (const change of [{ extra: true }, { declaration: 'never-collected' }, { intentCreatedAt: '2026-02-30T00:00:00.000Z' },
    { intentCreatedAt: '2026-10-16T00:00:00Z' }, { chainHead: { sequence: 0, eventSha256: 'a'.repeat(64) } },
    { chainHead: { sequence: 1, eventSha256: null } }, { chainHead: { sequence: Number.MAX_SAFE_INTEGER + 1, eventSha256: 'a'.repeat(64) } },
    { observation: { bootId: id(5), elapsedRealtimeMs: -1, wallTimeMs: 0 } },
    { observation: { bootId: id(5), elapsedRealtimeMs: 0, wallTimeMs: 253402300800000 } },
    { observation: { bootId: id(5), elapsedRealtimeMs: 0, wallTimeMs: 0, trusted: true } }]) {
    if ((change.chainHead?.sequence ?? 0) > Number.MAX_SAFE_INTEGER) {
      expect(offlinePaymentFreezeSchema.safeParse({ ...freeze, ...change }).success).toBe(false)
    } else await expect(verify(change)).rejects.toThrow()
  }
  await expect(verify({ request: { ...freeze.request, extra: true } })).rejects.toThrow()
  await expect(verify({ request: { ...freeze.request, customer: { name: ' Name ', address: 'Street', trn: null } } })).rejects.toThrow()
})
it('rejects repricing, unknown/duplicate products, fractional pieces and quantity bounds', async () => {
  for (const lines of [[{ productId: id(99), quantityMilli: 1000 }], [freeze.request.lines[0], freeze.request.lines[0]],
    [{ productId: snapshot.products[0].id, quantityMilli: 500 }], [{ productId: snapshot.products[0].id, quantityMilli: 0 }],
    [{ productId: snapshot.products[0].id, quantityMilli: 1000001 }], [{ ...freeze.request.lines[0], unitPriceFils: 1 }], []])
    await expect(verify({ request: { ...freeze.request, lines } })).rejects.toThrow()
  await expect(verify({ request: { ...freeze.request, presentedTotalFils: 1500 } })).rejects.toMatchObject({ code: 'offline_payment_freeze_invalid' })
})
it('rejects inadequate cash, excessive card, card-only cash and altered request digests', async () => {
  for (const changed of [{ cashTenderedFils: 1000 }, { recordedCardFils: 1502 }, { recordedCardFils: 1501, cashTenderedFils: 1 }])
    await expect(verify({ request: { ...freeze.request, ...changed } })).rejects.toMatchObject({ code: 'offline_payment_freeze_invalid' })
  await expect(verify({ request: { ...freeze.request, cashTenderedFils: 3000 }, requestSha256: freeze.requestSha256 })).rejects.toMatchObject({ code: 'offline_payment_freeze_invalid' })
  const card = await verify({ request: { ...freeze.request, recordedCardFils: 1501, cashTenderedFils: 0 } })
  expect(card.quote.payments).toEqual([{ method: 'card', amountFils: 1501 }]); expect(card.quote.changeFils).toBe(0)
})
it('checks signed tender permissions and absolute historical grant caps', async () => {
  for (const permissions of [{ cash: true, recordedCard: true, mixedTender: false }, { cash: true, recordedCard: false, mixedTender: false }, { cash: false, recordedCard: true, mixedTender: false }]) {
    authority.permissions = permissions; await stored(); await expect(verify()).rejects.toMatchObject({ code: 'offline_payment_freeze_invalid' })
  }
  authority.permissions = { cash: true, recordedCard: true, mixedTender: true }; authority.maxInvoiceTotalFils = 1500; authority.maxGrossFils = 3000
  await stored(); await expect(verify()).rejects.toMatchObject({ code: 'offline_payment_freeze_invalid' })
})
it('requires buyer details above the existing inclusive-tax threshold without consulting current catalogue', async () => {
  snapshot.products[0].unitPriceFils = 1_000_001; authority.maxInvoiceTotalFils = 2_000_000; authority.maxGrossFils = 6_000_000; await stored()
  const request = { ...freeze.request, lines: [{ productId: snapshot.products[0].id, quantityMilli: 1000 }], presentedTotalFils: 1_000_001, cashTenderedFils: 1_000_001, recordedCardFils: 0 }
  await expect(verify({ request })).rejects.toMatchObject({ code: 'offline_payment_freeze_invalid' })
  const good = await verify({ request: { ...request, customer: { name: 'Synthetic buyer', address: 'Synthetic street', trn: '100000000000001' } } })
  expect(good.quote.requiresBuyerDetails).toBe(true); expect(good.quote.totals.grossFils).toBe(1_000_001)
  expect(m.rpc.mock.calls.every(([name]) => name === 'pos_offline_authority')).toBe(true)
})
it('fails closed on missing, unsigned, normalized or inconsistent authority custody', async () => {
  const good = row
  for (const bad of [{ ...good, unexpected: true }, { ...good, authorityEnvelope: null }, { ...good, keyEpoch: id(99) },
    { ...good, snapshotSha256: 'b'.repeat(64) }, { ...good, authoritySha256: 'b'.repeat(64) },
    { ...good, snapshot: { ...snapshot, profile: { ...snapshot.profile, legalName: ` ${snapshot.profile.legalName} ` } } },
    { ...good, publicKeySpki: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', server.publicKey))) },
    { ...good, snapshotEnvelope: { ...good.snapshotEnvelope as SignedEnvelope, payloadBase64Url: (good.authorityEnvelope as SignedEnvelope).payloadBase64Url } }]) {
    row = bad; await expect(verify()).rejects.toMatchObject({ code: 'offline_storage_unavailable' })
  }
  m.rpc.mockResolvedValue({ data: null, error: null }); await expect(verify()).rejects.toMatchObject({ code: 'offline_authority_unavailable' })
  m.rpc.mockResolvedValue({ data: null, error: { message: 'private SQL detail' } }); await expect(verify()).rejects.toMatchObject({ code: 'offline_storage_unavailable' })
})
it('accepts a large valid historical menu without imposing the signed-payload limit on its reader wrapper', async () => {
  snapshot.products = [...snapshot.products, ...Array.from({ length: 1798 }, (_, i) => ({ id: id(i + 1000), name: 'n'.repeat(220), category: 'c'.repeat(100), unit: 'piece' as const, unitPriceFils: 1, taxRateBps: 500, revision: 1 }))]
  await stored(); expect(JSON.stringify(row.snapshotEnvelope).length).toBeGreaterThan(1_048_576)
  expect((await verify()).quote.totals.grossFils).toBe(1501)
})
it('rejects oversize decoded payloads and noncanonical wire bytes before reading historical custody', async () => {
  const p = await proofs(); m.rpc.mockClear()
  for (const envelope of [{ ...p.envelope, payloadBase64Url: encodeBase64Url(new TextEncoder().encode('x'.repeat(1_048_577))) },
    { ...p.envelope, payloadBase64Url: encodeBase64Url(new TextEncoder().encode(' ' + new TextDecoder().decode(canonicalBytes(freeze)))) },
    { ...p.envelope, publicKeySpki: row.publicKeySpki }]) await expect(verifyOfflinePaymentFreeze(envelope, p.query)).rejects.toThrow()
  expect(m.rpc).not.toHaveBeenCalled()
  expect(offlinePaymentIntentRequestSchema.safeParse({ ...freeze.request, cashTenderedFils: 0.1 }).success).toBe(false)
  expect(offlinePaymentResolutionQuerySchema.safeParse({ ...p.queryPayload, managerApproved: true }).success).toBe(false)
})

it('matches native zero-price, per-line and aggregate monetary ceilings', async () => {
  authority.maxInvoiceTotalFils = 100_000_000; authority.maxGrossFils = 300_000_000
  snapshot.products[0].unitPriceFils = 0; snapshot.products[1].unitPriceFils = 0; await stored()
  await expect(verify({ request: { ...freeze.request, presentedTotalFils: 1 } })).rejects.toMatchObject({ code: 'offline_payment_freeze_invalid' })
  snapshot.products[0].unitPriceFils = 100_000_000; snapshot.products[1].unitPriceFils = 1; await stored()
  const customer = { name: 'Synthetic buyer', address: 'Synthetic street', trn: null }
  const request = { ...freeze.request, customer, lines: [{ productId: snapshot.products[0].id, quantityMilli: 1000 }],
    presentedTotalFils: 100_000_000, cashTenderedFils: 100_000_000, recordedCardFils: 0 }
  expect((await verify({ request })).quote.totals.grossFils).toBe(100_000_000)
  await expect(verify({ request: { ...request, lines: [{ productId: snapshot.products[0].id, quantityMilli: 2000 }] } })).rejects.toMatchObject({ code: 'offline_payment_freeze_invalid' })
  await expect(verify({ request: { ...request, lines: [...request.lines, { productId: snapshot.products[1].id, quantityMilli: 1000 }] } })).rejects.toMatchObject({ code: 'offline_payment_freeze_invalid' })
})
it('permits the exact buyer threshold and diagnostic ceiling without treating observation as selling permission', async () => {
  snapshot.products[0].unitPriceFils = 1_000_000; authority.maxInvoiceTotalFils = 1_000_000; authority.maxGrossFils = 3_000_000; await stored()
  const result = await verify({ request: { ...freeze.request, lines: [{ productId: snapshot.products[0].id, quantityMilli: 1000 }],
    presentedTotalFils: 1_000_000, cashTenderedFils: 1_000_000, recordedCardFils: 0 },
    observation: { bootId: id(5), elapsedRealtimeMs: 0, wallTimeMs: 253402300799999 } })
  expect(result.quote.requiresBuyerDetails).toBe(false); expect(result.quote.payments).toEqual([{ method: 'cash', amountFils: 1_000_000 }])
})
it('fails closed before reading custody when trusted server key configuration is unavailable', async () => {
  const p = await proofs(); vi.stubEnv('POS_OFFLINE_SERVER_KEYS', '')
  await expect(verifyOfflinePaymentFreeze(p.envelope, p.query)).rejects.toMatchObject({ code: 'offline_signing_unavailable' })
  expect(m.rpc).not.toHaveBeenCalled()
})


const nativeExport = process.env.POS_NATIVE_FREEZE_FIXTURE_PATH ?? resolve(process.cwd(), 'tests/unit/pos/fixtures/native-payment-freeze-android-output.json')
it('verifies the actual Android Keystore freeze/query export without native private keys', async () => {
  const captured = JSON.parse(readFileSync(nativeExport, 'utf8'))
  expect(captured.schemaVersion).toBe(1)
  expect(captured.snapshotEnvelope.keyId).toBe('synthetic-server'); expect(captured.authorityEnvelope.keyId).toBe('synthetic-server')
  const configured = JSON.parse(process.env.POS_OFFLINE_SERVER_KEYS!)
  configured.push({ id: 'synthetic-server', publicKeySpki: captured.serverPublicKeySpki })
  vi.stubEnv('POS_OFFLINE_SERVER_KEYS', JSON.stringify(configured))
  const historicalSnapshot = parseCanonicalPayload(decodeBase64Url(captured.snapshotEnvelope.payloadBase64Url)) as OfflineSnapshot
  const historicalAuthority = parseCanonicalPayload(decodeBase64Url(captured.authorityEnvelope.payloadBase64Url)) as OfflineAuthority
  const historicalRow = { snapshot: historicalSnapshot, authority: historicalAuthority,
    snapshotEnvelope: captured.snapshotEnvelope, authorityEnvelope: captured.authorityEnvelope,
    snapshotSha256: await sha256Hex(decodeBase64Url(captured.snapshotEnvelope.payloadBase64Url)),
    authoritySha256: await sha256Hex(decodeBase64Url(captured.authorityEnvelope.payloadBase64Url)),
    publicKeySpki: captured.publicKeySpki, keyEpoch: historicalAuthority.keyEpoch, deviceId: historicalAuthority.deviceId }
  m.rpc.mockImplementation(async (name, args) => {
    expect(name).toBe('pos_offline_authority'); expect(args).toEqual({ p_id: historicalAuthority.id }); return { data: historicalRow, error: null }
  })
  const result = await verifyOfflinePaymentFreeze(captured.freezeEnvelope, captured.queryEnvelope)
  expect(result.freeze.deviceKeySha256).toBe(captured.deviceKeySha256)
  expect(result.freeze.request).toEqual(captured.intentDisplay.request)
  expect(result.quote).toEqual({ calculationVersion: 'offline-line-v1', lines: captured.intentDisplay.quote.lines,
    totals: captured.intentDisplay.quote.totals, payments: captured.intentDisplay.quote.payments,
    cashTenderedFils: captured.intentDisplay.quote.cashTenderedFils, changeFils: captured.intentDisplay.quote.changeFils,
    requiresBuyerDetails: captured.intentDisplay.quote.requiresBuyerDetails })
  expect(captured.intentDisplay.state).toBe('frozen_for_manager'); expect(captured.counterState.canIssue).toBe(false)
  expect(result.freezeSha256).toBe(await sha256Hex(decodeBase64Url(captured.freezeEnvelope.payloadBase64Url)))
  expect(m.auth).not.toHaveBeenCalled(); expect(m.rpc).toHaveBeenCalledTimes(1)
})
