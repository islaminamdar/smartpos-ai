// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { invoice } from '../../../fixtures/pos-invoice'
import { canonicalBytes, sha256Hex } from '@/lib/pos/offline/canonical'
import { validateHistoricalIssuance, assessOfflineImport, OfflineReconciliationError, type OfflineImportState, type ImportedOfflineReceipt, type VerifiedOfflineBundle } from '@/lib/pos/offline/validation'

const id = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const at = '2026-10-16T10:00:00.000Z'
const payloadHash = 'd'.repeat(64)
async function fixture() {
  const document = { ...structuredClone(invoice), issuedAt: at,
    lines: invoice.lines.map((line, index) => ({ ...line, productId: index ? other : id })) }
  const snapshot: VerifiedOfflineBundle['snapshot'] = { kind: 'offline-snapshot', schemaVersion: 1, id, organizationId: id, branchId: id,
    createdAt: at, profile: document.merchant, calculationVersion: 'offline-line-v1', offers: [],
    products: document.lines.map(line => ({ id: line.productId, name: line.name, category: 'Synthetic', unit: line.unit, unitPriceFils: line.unitPriceFils, taxRateBps: line.taxRateBps, revision: 1 })) }
  const snapshotSha256 = await sha256Hex(canonicalBytes(snapshot))
  const authority: VerifiedOfflineBundle['authority'] = { kind: 'offline-authority', schemaVersion: 1, id, organizationId: id, branchId: id, deviceId: id, actorId: id,
    deviceKeySha256: 'a'.repeat(64), keyEpoch: id, shiftId: id, snapshotId: id, snapshotSha256, issuedAt: at, notBefore: at, expiresAt: '2026-10-16T22:00:00.000Z',
    invoiceRange: { prefix: 'TEST', first: 1, last: 100 }, maxInvoiceTotalFils: 100_000, maxGrossFils: 10_000_000,
    permissions: { cash: true, recordedCard: true, mixedTender: true }, policy: { refunds: 'online-only', sharedTabs: 'online-only', offers: 'online-only' } }
  const authoritySha256 = await sha256Hex(canonicalBytes(authority))
  const bundle = { snapshot, authority, snapshotSha256, authoritySha256 }
  const issuance = { kind: 'offline-sale' as const, schemaVersion: 1 as const, id, authorityId: id, authoritySha256, snapshotSha256,
    deviceSequence: 1, previousEventSha256: null as string | null, document, clock: { estimatedServerAt: at, bootId: id, elapsedRealtimeMs: 20 }, paymentIntentId: id }
  const state: OfflineImportState = { device: { organizationId: id, branchId: id, deviceId: id, keyEpoch: id, lastSequence: 0, lastEventSha256: null },
    grant: { authorityId: id, grossFils: 0, invoiceCount: 0 }, matches: [] }
  return { issuance, bundle, state }
}

function acceptedRow(issuance: Awaited<ReturnType<typeof fixture>>['issuance']): ImportedOfflineReceipt {
  return { issuanceId: issuance.id, paymentIntentId: issuance.paymentIntentId, documentId: issuance.document.id, documentNumber: issuance.document.documentNumber,
    authorityId: issuance.authorityId, deviceSequence: issuance.deviceSequence, payloadSha256: payloadHash, acknowledgementId: 'original-ack' }
}

describe('independently recomputed historical offline invoices', () => {
  it('preserves the historical per-line 28 fils VAT, not aggregate 29, without a current clock or menu', async () => {
    const { issuance, bundle } = await fixture()
    const result = validateHistoricalIssuance(issuance, bundle)
    expect(result).toMatchObject({ invoiceSequence: 1, grossFils: 600, netFils: 572, taxFils: 28 })
    expect(result.issuance).toEqual(issuance)
  })
  it('uses gram rounding then inclusive per-line tax and keeps exact half-fils rounding', async () => {
    const { issuance, bundle } = await fixture()
    const product = bundle.snapshot.products[0]
    Object.assign(product, { unit: 'kg', unitPriceFils: 1001 })
    issuance.document.lines = [{ ...issuance.document.lines[0], unit: 'kg', unitPriceFils: 1001, quantityMilli: 500, grossFils: 501, taxFils: 24, netFils: 477 }]
    issuance.document.totals = { grossFils: 501, taxFils: 24, netFils: 477 }
    issuance.document.payments = [{ method: 'cash', amountFils: 501 }]
    issuance.document.cashTenderedFils = 1000; issuance.document.changeFils = 499
    expect(validateHistoricalIssuance(issuance, bundle)).toMatchObject({ grossFils: 501, taxFils: 24, netFils: 477 })
  })
  it('rejects arithmetically consistent reprice and tax changes against historical product values', async () => {
    const { issuance, bundle } = await fixture()
    issuance.document.lines[0] = { ...issuance.document.lines[0], unitPriceFils: 301, grossFils: 301, netFils: 287 }
    issuance.document.totals = { grossFils: 601, netFils: 573, taxFils: 28 }
    issuance.document.payments[1].amountFils++
    expect(() => validateHistoricalIssuance(issuance, bundle)).toThrow('historical catalogue')
  })
  it.each(['grossFils', 'netFils', 'taxFils'] as const)('rejects forged %s totals', async field => {
    const { issuance, bundle } = await fixture()
    issuance.document.totals[field]++
    expect(() => validateHistoricalIssuance(issuance, bundle)).toThrow()
  })
  it('rejects schema normalization and case aliases rather than rewriting signed bytes', async () => {
    const { issuance, bundle } = await fixture()
    issuance.document.customer = { name: ' Padded ', address: 'Address', trn: null }
    expect(() => validateHistoricalIssuance(issuance, bundle)).toThrow('normalization')
    issuance.document.customer = null
    issuance.document.id = 'a0000000-0000-4000-8000-000000000001'.toUpperCase()
    expect(() => validateHistoricalIssuance(issuance, bundle)).toThrow('lowercase')
  })
  it('rejects snapshot hash substitution and malformed grant supplied by a typed caller', async () => {
    const { issuance, bundle } = await fixture()
    expect(() => validateHistoricalIssuance(issuance, { ...bundle, snapshotSha256: 'f'.repeat(64) })).toThrow('snapshot hash')
    expect(() => validateHistoricalIssuance(issuance, { ...bundle, authority: { ...bundle.authority, maxGrossFils: -1 } })).toThrow()
  })
  it('accepts inclusive start, rejects expiry, and excludes current upload time', async () => {
    const { issuance, bundle } = await fixture()
    expect(validateHistoricalIssuance(issuance, bundle).issuance.document.issuedAt).toBe(bundle.authority.notBefore)
    issuance.document.issuedAt = issuance.clock.estimatedServerAt = bundle.authority.expiresAt
    expect(() => validateHistoricalIssuance(issuance, bundle)).toThrow('outside its authority')
  })
})

describe('offline import transaction decisions, not financial persistence', () => {
  it('returns atomic next counters without mutating provided state', async () => {
    const { issuance, bundle, state } = await fixture()
    const before = structuredClone(state)
    expect(assessOfflineImport(validateHistoricalIssuance(issuance, bundle), payloadHash, state)).toEqual({
      kind: 'accept', nextDeviceSequence: 1, nextEventSha256: payloadHash, nextGrantGrossFils: 600, nextGrantInvoiceCount: 1 })
    expect(state).toEqual(before)
  })
  it('returns original ACK after lost response even when later bills advanced chain and budget', async () => {
    const { issuance, bundle, state } = await fixture()
    state.device.lastSequence = 10; state.device.lastEventSha256 = 'e'.repeat(64)
    state.grant.invoiceCount = 10; state.grant.grossFils = 6000
    state.matches = [acceptedRow(issuance)]
    expect(assessOfflineImport(validateHistoricalIssuance(issuance, bundle), payloadHash, state)).toEqual({ kind: 'duplicate', acknowledgementId: 'original-ack' })
  })
  it.each(['issuanceId', 'paymentIntentId', 'documentId', 'documentNumber', 'authorityId', 'payloadSha256', 'acknowledgementId'] as const)('quarantines a conflicting %s match', async field => {
    const { issuance, bundle, state } = await fixture()
    const row = acceptedRow(issuance)
    state.matches = [row, { ...row, [field]: 'different' }]
    expect(() => assessOfflineImport(validateHistoricalIssuance(issuance, bundle), payloadHash, state)).toThrow(OfflineReconciliationError)
    try { assessOfflineImport(validateHistoricalIssuance(issuance, bundle), payloadHash, state) } catch (error) { expect(error).toMatchObject({ code: 'collision' }) }
  })
  it('rejects a missing predecessor, skipped number in device chain, and replay without original ACK custody', async () => {
    const { issuance, bundle, state } = await fixture()
    issuance.deviceSequence = 3; issuance.previousEventSha256 = 'e'.repeat(64)
    expect(() => assessOfflineImport(validateHistoricalIssuance(issuance, bundle), payloadHash, state)).toThrow('chain')
    state.device.lastSequence = 2; state.device.lastEventSha256 = 'f'.repeat(64)
    expect(() => assessOfflineImport(validateHistoricalIssuance(issuance, bundle), payloadHash, state)).toThrow('chain')
    state.matches = [acceptedRow(issuance)]
    expect(() => assessOfflineImport(validateHistoricalIssuance(issuance, bundle), payloadHash, state)).toThrow('custody state')
  })
  it('allows disjoint reserved invoice numbers with contiguous device chain across grants', async () => {
    const { issuance, bundle, state } = await fixture()
    bundle.authority.invoiceRange = { prefix: 'TEST', first: 201, last: 300 }
    issuance.document.documentNumber = 'TEST-INV-0000000201'
    issuance.deviceSequence = 3; issuance.previousEventSha256 = 'e'.repeat(64)
    state.device.lastSequence = 2; state.device.lastEventSha256 = issuance.previousEventSha256
    expect(assessOfflineImport(validateHistoricalIssuance(issuance, bundle), payloadHash, state)).toMatchObject({ kind: 'accept', nextDeviceSequence: 3, nextGrantInvoiceCount: 1 })
  })
  it('rejects a retired epoch substituted for the historically enrolled epoch', async () => {
    const { issuance, bundle, state } = await fixture()
    state.device.keyEpoch = other
    expect(() => assessOfflineImport(validateHistoricalIssuance(issuance, bundle), payloadHash, state)).toThrow('state is inconsistent')
  })
  it('enforces accumulated budget even when this individual invoice is within its limit', async () => {
    const { issuance, bundle, state } = await fixture()
    bundle.authority.maxGrossFils = 1000
    state.grant.grossFils = 600; state.grant.invoiceCount = 1
    state.device.lastSequence = 1; state.device.lastEventSha256 = 'e'.repeat(64)
    issuance.deviceSequence = 2; issuance.previousEventSha256 = state.device.lastEventSha256
    expect(() => assessOfflineImport(validateHistoricalIssuance(issuance, bundle), payloadHash, state)).toThrow('cumulative budget')
  })
  it('enforces count and rejects corrupt aggregate/counter state instead of recovering it silently', async () => {
    const { issuance, bundle, state } = await fixture()
    state.grant.invoiceCount = 100; state.grant.grossFils = 60000
    state.device.lastSequence = 100; state.device.lastEventSha256 = 'e'.repeat(64)
    issuance.deviceSequence = 101; issuance.previousEventSha256 = state.device.lastEventSha256
    expect(() => assessOfflineImport(validateHistoricalIssuance(issuance, bundle), payloadHash, state)).toThrow('cumulative budget')
    state.grant.invoiceCount = 0
    expect(() => assessOfflineImport(validateHistoricalIssuance(issuance, bundle), payloadHash, state)).toThrow('state is inconsistent')
    state.grant.grossFils = 0; state.device.lastSequence = NaN
    expect(() => assessOfflineImport(validateHistoricalIssuance(issuance, bundle), payloadHash, state)).toThrow('state is inconsistent')
  })
})
