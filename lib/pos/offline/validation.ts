import { validateIssuanceAgainstAuthority, type verifyOfflineBundle } from './authority'
import { canonicalJson } from './canonical'
import { offlineAuthoritySchema, offlineSnapshotSchema, type OfflineAuthority } from './contracts'

export type VerifiedOfflineBundle = Awaited<ReturnType<typeof verifyOfflineBundle>>

/** Server recomputation after signature verification; no present-day catalogue or clock inputs. */
export function validateHistoricalIssuance(raw: unknown, bundle: VerifiedOfflineBundle) {
  const authority = offlineAuthoritySchema.parse(bundle.authority)
  const snapshot = offlineSnapshotSchema.parse(bundle.snapshot)
  if (canonicalJson(authority) !== canonicalJson(bundle.authority) || canonicalJson(snapshot) !== canonicalJson(bundle.snapshot))
    throw new Error('Historical bundle normalization would change authenticated data.')
  if (bundle.snapshotSha256 !== authority.snapshotSha256) throw new Error('Historical snapshot hash differs.')
  const issuance = validateIssuanceAgainstAuthority(raw, authority, snapshot, bundle.authoritySha256)
  if (canonicalJson(issuance) !== canonicalJson(raw)) throw new Error('Issuance normalization would change authenticated data.')
  const document = issuance.document
  if (document.kind !== 'tax_invoice' || document.schemaVersion !== 1) throw new Error('Only original offline invoices are supported.')
  // UUID aliases must not evade future database uniqueness and idempotency comparisons.
  const identities = [document.id, document.orderId, document.actorId, document.branchId, document.deviceId, document.shiftId,
    ...document.lines.map(line => line.productId), snapshot.profile.id, snapshot.profile.organizationId,
    snapshot.profile.branchId, snapshot.profile.confirmedBy]
  if (identities.some(value => value !== value.toLowerCase())) throw new Error('Offline identities must be lowercase.')
  const products = new Map(snapshot.products.map(product => [product.id, product]))
  let grossFils = 0, netFils = 0, taxFils = 0
  const round = (numerator: bigint, denominator: bigint) => Number((numerator * BigInt(2) + denominator) / (denominator * BigInt(2)))
  for (const line of document.lines) {
    const product = products.get(line.productId)!
    const gross = round(BigInt(product.unitPriceFils) * BigInt(line.quantityMilli), BigInt(1000))
    const tax = round(BigInt(gross) * BigInt(product.taxRateBps), BigInt(10_000 + product.taxRateBps))
    if (line.grossFils !== gross || line.taxFils !== tax || line.netFils !== gross - tax)
      throw new Error('Historical line calculation differs.')
    grossFils += gross; taxFils += tax; netFils += gross - tax
  }
  if (document.totals.grossFils !== grossFils || document.totals.netFils !== netFils || document.totals.taxFils !== taxFils)
    throw new Error('Historical totals differ.')
  return { issuance, authority, invoiceSequence: Number(document.documentNumber.slice(authority.invoiceRange.prefix.length + 5)), grossFils, netFils, taxFils }
}

export type ValidatedHistoricalIssuance = ReturnType<typeof validateHistoricalIssuance>
export interface ImportedOfflineReceipt {
  issuanceId: string
  paymentIntentId: string
  documentId: string
  documentNumber: string
  authorityId: string
  deviceSequence: number
  payloadSha256: string
  acknowledgementId: string
}

export interface OfflineImportState {
  device: { organizationId: string; branchId: string; deviceId: string; keyEpoch: string; lastSequence: number; lastEventSha256: string | null }
  grant: { authorityId: string; grossFils: number; invoiceCount: number }
  /** All rows matching ANY issuance/intent/document ID, branch number, or device-epoch sequence.
   * Query under the same locks as device/grant state. Empty means ALL those keys are unused. */
  matches: readonly ImportedOfflineReceipt[]
}

export class OfflineReconciliationError extends Error {
  constructor(public readonly code: 'state' | 'collision' | 'chain' | 'budget', message: string) { super(message); this.name = 'OfflineReconciliationError' }
}

const validCount = (value: number) => Number.isSafeInteger(value) && value >= 0
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function scopeMatches(authority: OfflineAuthority, state: OfflineImportState): boolean {
  return state.device.organizationId === authority.organizationId && state.device.branchId === authority.branchId &&
    state.device.deviceId === authority.deviceId && state.device.keyEpoch === authority.keyEpoch && state.grant.authorityId === authority.id
}

/** Pure decision only, NEVER an importer. Caller must lock historical epoch/grant and all uniqueness
 * keys, persist exceptions, and atomically write the exact immutable invoice + provenance + ACK
 * with these next counters. No current membership, current time, repricing or kitchen projection.
 * An acknowledgement means committed custody, not merely this decision returning accept. */
export function assessOfflineImport(validated: ValidatedHistoricalIssuance, payloadSha256: string, state: OfflineImportState) {
  const { issuance, authority, grossFils } = validated
  const { document } = issuance
  if (!scopeMatches(authority, state) || !hash(payloadSha256) || !validCount(state.device.lastSequence) ||
    ((state.device.lastSequence === 0) !== (state.device.lastEventSha256 === null)) ||
    (state.device.lastEventSha256 !== null && !hash(state.device.lastEventSha256)) ||
    !validCount(state.grant.grossFils) || !validCount(state.grant.invoiceCount) ||
    state.grant.invoiceCount > state.device.lastSequence || state.grant.grossFils < state.grant.invoiceCount ||
    state.grant.grossFils > state.grant.invoiceCount * authority.maxInvoiceTotalFils ||
    state.grant.grossFils > authority.maxGrossFils || state.grant.invoiceCount > authority.invoiceRange.last - authority.invoiceRange.first + 1 ||
    ((state.grant.invoiceCount === 0) !== (state.grant.grossFils === 0)))
    throw new OfflineReconciliationError('state', 'Historical device or grant state is inconsistent.')
  if (state.matches.length) {
    const first = state.matches[0]
    if (!first.acknowledgementId || state.matches.some(row => row.issuanceId !== issuance.id || row.paymentIntentId !== issuance.paymentIntentId ||
      row.documentId !== document.id || row.documentNumber !== document.documentNumber || row.authorityId !== authority.id ||
      row.deviceSequence !== issuance.deviceSequence || row.payloadSha256 !== payloadSha256 || row.acknowledgementId !== first.acknowledgementId))
      throw new OfflineReconciliationError('collision', 'Offline receipt identity is already bound to different evidence.')
    if (state.device.lastSequence < issuance.deviceSequence || state.grant.invoiceCount < 1 || state.grant.grossFils < grossFils ||
      (state.device.lastSequence === issuance.deviceSequence && state.device.lastEventSha256 !== payloadSha256))
      throw new OfflineReconciliationError('state', 'Imported receipt and aggregate custody state disagree.')
    return { kind: 'duplicate' as const, acknowledgementId: first.acknowledgementId }
  }
  if (issuance.deviceSequence !== state.device.lastSequence + 1 || issuance.previousEventSha256 !== state.device.lastEventSha256)
    throw new OfflineReconciliationError('chain', 'Offline device chain has a gap or different predecessor.')
  const nextGrantGrossFils = state.grant.grossFils + grossFils
  const nextGrantInvoiceCount = state.grant.invoiceCount + 1
  if (!Number.isSafeInteger(nextGrantGrossFils) || nextGrantGrossFils > authority.maxGrossFils ||
    nextGrantInvoiceCount > authority.invoiceRange.last - authority.invoiceRange.first + 1)
    throw new OfflineReconciliationError('budget', 'Offline authority cumulative budget is exhausted.')
  return { kind: 'accept' as const, nextDeviceSequence: issuance.deviceSequence, nextEventSha256: payloadSha256, nextGrantGrossFils, nextGrantInvoiceCount }
}
