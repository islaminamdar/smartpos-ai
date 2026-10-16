// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { z } from 'zod'
import { invoice } from '../../../fixtures/pos-invoice'
import { canonicalBytes, canonicalJson, decodeBase64Url, encodeBase64Url, parseCanonicalPayload, sha256Hex } from '@/lib/pos/offline/canonical'
import { offlineAuthoritySchema, offlineIssuanceSchema, offlineSnapshotSchema, type OfflineAuthority, type OfflineSnapshot } from '@/lib/pos/offline/contracts'
import { derToP1363, p1363ToDer, publicKeyFingerprint, signEnvelope, validateIssuanceAgainstAuthority, verifyOfflineBundle, verifyOfflineIssuance, verifySignedEnvelope } from '@/lib/pos/offline/authority'

const id = '00000000-0000-4000-8000-000000000001'
const second = '00000000-0000-4000-8000-000000000002'
const issuedAt = '2026-10-16T10:00:00.000Z'
function fixtures() {
  const document = { ...structuredClone(invoice), issuedAt,
    lines: invoice.lines.map((line, index) => ({ ...line, productId: index ? second : id })) }
  const snapshot: OfflineSnapshot = { kind: 'offline-snapshot', schemaVersion: 1, id, organizationId: id, branchId: id,
    createdAt: issuedAt, profile: document.merchant, calculationVersion: 'offline-line-v1', offers: [],
    products: document.lines.map((line) => ({ id: line.productId, name: line.name, category: 'Synthetic', unit: line.unit, unitPriceFils: line.unitPriceFils, taxRateBps: line.taxRateBps, revision: 1 })) }
  const authority: OfflineAuthority = { kind: 'offline-authority', schemaVersion: 1, id, organizationId: id, branchId: id,
    deviceId: id, actorId: id, deviceKeySha256: 'a'.repeat(64), keyEpoch: id, shiftId: id, snapshotId: id, snapshotSha256: 'b'.repeat(64),
    issuedAt, notBefore: issuedAt, expiresAt: '2026-10-16T22:00:00.000Z', invoiceRange: { prefix: 'TEST', first: 1, last: 100 },
    maxInvoiceTotalFils: 100_000, maxGrossFils: 10_000_000, permissions: { cash: true, recordedCard: true, mixedTender: true },
    policy: { refunds: 'online-only', sharedTabs: 'online-only', offers: 'online-only' } }
  const issuance = { kind: 'offline-sale' as const, schemaVersion: 1 as const, id, authorityId: id, authoritySha256: 'c'.repeat(64),
    snapshotSha256: authority.snapshotSha256, deviceSequence: 1, previousEventSha256: null, document,
    clock: { estimatedServerAt: issuedAt, bootId: id, elapsedRealtimeMs: 1234 }, paymentIntentId: id }
  return { snapshot, authority, issuance }
}

describe('offline canonical protocol bytes', () => {
  it('is stable across insertion order without normalizing Unicode or array order', () => {
    expect(canonicalJson({ z: [3, 1], a: { y: 'مثال 🍰', b: 1 } })).toBe('{"a":{"b":1,"y":"مثال 🍰"},"z":[3,1]}')
    expect(canonicalJson({ x: 'é' })).not.toBe(canonicalJson({ x: 'e\u0301' }))
  })
  it('rejects ambiguous or lossy JSON and invalid UTF8', () => {
    for (const value of [-0, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, new Date(), '\ud800', { x: undefined }, Array(1)])
      expect(() => canonicalJson(value)).toThrow()
    for (const raw of ['{"a":1,"a":1}', '{ "a":1}', '{"b":2,"a":1}', '1e2'])
      expect(() => parseCanonicalPayload(new TextEncoder().encode(raw))).toThrow()
    expect(() => parseCanonicalPayload(Uint8Array.of(0xff))).toThrow()
    expect(() => decodeBase64Url('Zh')).toThrow() // nonzero unused padding bits
    expect(() => decodeBase64Url('Zg==')).toThrow()
    expect(() => decodeBase64Url('AAAA', 1)).toThrow()
  })
})

describe('P256 DER interoperability and signed authority', () => {
  it('verifies Node DER signatures and emits DER accepted by Node', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const trusted = await crypto.subtle.importKey('spki', publicKey.export({ format: 'der', type: 'spki' }), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
    const payload = { amount: 300, name: 'مثال' }, bytes = canonicalBytes(payload)
    const envelope = { format: 'pos-signed-v1', alg: 'ECDSA-P256-SHA256-DER', keyId: 'test', payloadBase64Url: encodeBase64Url(bytes),
      signatureBase64Url: encodeBase64Url(sign('sha256', bytes, { key: privateKey, dsaEncoding: 'der' })) }
    expect((await verifySignedEnvelope(envelope, z.object({ amount: z.number(), name: z.string() }).strict(), { test: trusted })).payload).toEqual(payload)
    await expect(verifySignedEnvelope({ ...envelope, payloadBase64Url: encodeBase64Url(canonicalBytes({ ...payload, amount: 301 })) }, z.any(), { test: trusted })).rejects.toThrow('Signature')
    await expect(verifySignedEnvelope(envelope, z.any(), {})).rejects.toThrow('Unknown')
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const output = await signEnvelope(payload, 'native', keys.privateKey)
    const nodePublic = createPublicKey({ key: Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)), format: 'der', type: 'spki' })
    expect(verify('sha256', bytes, nodePublic, decodeBase64Url(output.signatureBase64Url))).toBe(true)
  })
  it('accepts valid short scalars and rejects malformed/nonminimal/zero/trailing DER', () => {
    const raw = new Uint8Array(64); raw[31] = 1; raw[63] = 2
    expect(p1363ToDer(raw).length).toBe(8)
    expect(derToP1363(p1363ToDer(raw))).toEqual(raw)
    for (const bytes of [Uint8Array.of(0x30, 6, 2, 1, 0, 2, 1, 1), Uint8Array.of(0x30, 7, 2, 2, 0, 1, 2, 1, 1), Uint8Array.of(0x30, 6, 2, 1, 0x80, 2, 1, 1), Uint8Array.of(...p1363ToDer(raw), 0)])
      expect(() => derToP1363(bytes)).toThrow()
  })
  it('binds independently signed snapshot and grant, rejecting signed schema normalization', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const { snapshot, authority } = fixtures()
    authority.snapshotSha256 = await sha256Hex(canonicalBytes(snapshot))
    const snapshotEnvelope = await signEnvelope(snapshot, 'server', keys.privateKey)
    const authorityEnvelope = await signEnvelope(authority, 'server', keys.privateKey)
    expect((await verifyOfflineBundle(snapshotEnvelope, authorityEnvelope, { server: keys.publicKey })).authority).toEqual(authority)
    const wrong = await signEnvelope({ ...authority, snapshotSha256: '0'.repeat(64) }, 'server', keys.privateKey)
    await expect(verifyOfflineBundle(snapshotEnvelope, wrong, { server: keys.publicKey })).rejects.toThrow('do not match')
    const padded = await signEnvelope({ ...snapshot, profile: { ...snapshot.profile, legalName: ' Synthetic ' } }, 'server', keys.privateKey)
    await expect(verifySignedEnvelope(padded, offlineSnapshotSchema, { server: keys.publicKey })).rejects.toThrow('normalization')
  })
  it('binds actual device signatures to the enrolled SPKI fingerprint, not a caller-selected key', async () => {
    const server = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const device = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const { snapshot, authority, issuance } = fixtures()
    authority.snapshotSha256 = await sha256Hex(canonicalBytes(snapshot))
    authority.deviceKeySha256 = await publicKeyFingerprint(device.publicKey)
    const bundle = await verifyOfflineBundle(await signEnvelope(snapshot, 'server', server.privateKey), await signEnvelope(authority, 'server', server.privateKey), { server: server.publicKey })
    issuance.authoritySha256 = bundle.authoritySha256
    issuance.snapshotSha256 = bundle.snapshotSha256
    const envelope = await signEnvelope(issuance, authority.deviceKeySha256, device.privateKey)
    expect((await verifyOfflineIssuance(envelope, bundle, device.publicKey)).issuance.document).toEqual(issuance.document)
    await expect(verifyOfflineIssuance(envelope, bundle, server.publicKey)).rejects.toThrow('Device key')
    await expect(verifyOfflineIssuance({ ...envelope, keyId: 'self-chosen' }, bundle, device.publicKey)).rejects.toThrow('Unknown')
  })
})

describe('bounded historical invoice validation', () => {
  it('accepts immutable historical lines and per-line28 fils VAT without current catalogue or current clock', () => {
    const { snapshot, authority, issuance } = fixtures()
    expect(validateIssuanceAgainstAuthority(issuance, authority, snapshot, issuance.authoritySha256).document.totals.taxFils).toBe(28)
    expect(offlineSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(offlineAuthoritySchema.parse(authority)).toEqual(authority)
  })
  it('rejects authority scope, prices, number reservation, tender and time changes', () => {
    const { snapshot, authority, issuance } = fixtures()
    for (const changed of [
      { ...issuance, authorityId: second },
      { ...issuance, document: { ...issuance.document, deviceId: second } },
      { ...issuance, document: { ...issuance.document, documentNumber: 'TEST-INV-0000000101' } },
      { ...issuance, document: { ...issuance.document, lines: issuance.document.lines.map((line) => ({ ...line, name: 'Forged' })) } },
      { ...issuance, document: { ...issuance.document, issuedAt: authority.expiresAt }, clock: { ...issuance.clock, estimatedServerAt: authority.expiresAt } },
    ]) expect(() => validateIssuanceAgainstAuthority(changed, authority, snapshot, issuance.authoritySha256)).toThrow()
    expect(() => validateIssuanceAgainstAuthority(issuance, { ...authority, permissions: { ...authority.permissions, mixedTender: false } }, snapshot, issuance.authoritySha256)).toThrow('Tender')
  })
  it('rejects unbounded grants, duplicate products, offers, contradictory chains and aliases', () => {
    const { snapshot, authority, issuance } = fixtures()
    for (const changes of [{ expiresAt: '2026-10-18T10:00:00.000Z' }, { invoiceRange: { ...authority.invoiceRange, last: 1001 } }, { maxGrossFils: 10_000_001 }, { policy: { ...authority.policy, refunds: 'offline' } }])
      expect(offlineAuthoritySchema.safeParse({ ...authority, ...changes }).success).toBe(false)
    expect(offlineSnapshotSchema.safeParse({ ...snapshot, products: [snapshot.products[0], snapshot.products[0]] }).success).toBe(false)
    expect(offlineSnapshotSchema.safeParse({ ...snapshot, offers: [{}] }).success).toBe(false)
    expect(offlineIssuanceSchema.safeParse({ ...issuance, deviceSequence: 2 }).success).toBe(false)
    expect(offlineIssuanceSchema.safeParse({ ...issuance, document: { ...issuance.document, lines: issuance.document.lines.map((line) => ({ ...line, productId: id })) } }).success).toBe(false)
  })
})
