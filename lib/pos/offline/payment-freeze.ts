import { z } from 'zod'
import { posClient, PosServerError } from '../server/client'
import { canonicalBytes, canonicalJson, decodeBase64Url, parseCanonicalPayload, sha256Hex } from './canonical'
import { publicKeyFingerprint, verifyOfflineBundle, verifySignedEnvelope } from './authority'
import { offlineAuthoritySchema, offlineSnapshotSchema, signedEnvelopeSchema } from './contracts'
import { importOfflinePublicKey, offlineServerKeys } from './server-keys'
import { offlineUuid } from './server-contracts'

const MAX_FILS = 100_000_000
const hash = z.string().regex(/^[a-f0-9]{64}$/)
import { offlinePaymentFreezeSchema, offlinePaymentIntentRequestSchema, offlinePaymentResolutionQuerySchema } from './payment-contracts'
export { offlinePaymentFreezeSchema, offlinePaymentIntentRequestSchema, offlinePaymentResolutionQuerySchema } from './payment-contracts'
const readerSchema = z.object({
  snapshot: offlineSnapshotSchema, authority: offlineAuthoritySchema,
  snapshotEnvelope: signedEnvelopeSchema, authorityEnvelope: signedEnvelopeSchema,
  snapshotSha256: hash, authoritySha256: hash, publicKeySpki: z.string().max(342), keyEpoch: offlineUuid, deviceId: offlineUuid,
}).strict()
const verifiedFreezeBrand: unique symbol = Symbol('verified-offline-payment-freeze')
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
function immutable<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child)
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}
function invalid(): never { throw new PosServerError('offline_payment_freeze_invalid', 422) }

function calculate(request: z.infer<typeof offlinePaymentIntentRequestSchema>, bundle: Awaited<ReturnType<typeof verifyOfflineBundle>>) {
  const products = new Map(bundle.snapshot.products.map(product => [product.id, product]))
  const halfUp = (numerator: bigint, denominator: bigint) => Number((numerator * BigInt(2) + denominator) / (denominator * BigInt(2)))
  let grossFils = 0, taxFils = 0
  const lines = request.lines.map((line, index) => {
    const product = products.get(line.productId)
    if (!product || (product.unit !== 'kg' && line.quantityMilli % 1000 !== 0)) return invalid()
    const gross = halfUp(BigInt(product.unitPriceFils) * BigInt(line.quantityMilli), BigInt(1000))
    const tax = halfUp(BigInt(gross) * BigInt(product.taxRateBps), BigInt(10_000 + product.taxRateBps))
    grossFils += gross; taxFils += tax
    if (gross > MAX_FILS || grossFils > MAX_FILS) return invalid()
    return { lineNumber: index + 1, productId: product.id, name: product.name, unit: product.unit,
      quantityMilli: line.quantityMilli, unitPriceFils: product.unitPriceFils, taxRateBps: product.taxRateBps,
      grossFils: gross, netFils: gross - tax, taxFils: tax }
  })
  const authority = bundle.authority
  if (grossFils < 1 || grossFils !== request.presentedTotalFils || grossFils > authority.maxInvoiceTotalFils ||
    grossFils > authority.maxGrossFils || request.recordedCardFils > grossFils) return invalid()
  const cashApplied = grossFils - request.recordedCardFils
  if (request.cashTenderedFils < cashApplied || (cashApplied === 0 && request.cashTenderedFils !== 0) ||
    (cashApplied > 0 && !authority.permissions.cash) || (request.recordedCardFils > 0 && !authority.permissions.recordedCard) ||
    (cashApplied > 0 && request.recordedCardFils > 0 && !authority.permissions.mixedTender)) return invalid()
  const requiresBuyerDetails = grossFils > 1_000_000
  if (requiresBuyerDetails && request.customer === null) return invalid()
  const payments: { method: 'cash' | 'card'; amountFils: number }[] = []
  if (cashApplied > 0) payments.push({ method: 'cash', amountFils: cashApplied })
  if (request.recordedCardFils > 0) payments.push({ method: 'card', amountFils: request.recordedCardFils })
  return { calculationVersion: 'offline-line-v1' as const, lines, totals: { grossFils, netFils: grossFils - taxFils, taxFils },
    payments, cashTenderedFils: request.cashTenderedFils, changeFils: request.cashTenderedFils - cashApplied, requiresBuyerDetails }
}

/** Historical enrolled proof and exact arithmetic verification. This alone does not prove
 * an unused identity, physical collection, current manager authority or a decision. */
export async function verifyStoredOfflinePaymentFreeze(rawFreeze: unknown) {
  let freezeEnvelope, routed
  try {
    freezeEnvelope = signedEnvelopeSchema.parse(rawFreeze)
    routed = offlinePaymentFreezeSchema.parse(parseCanonicalPayload(decodeBase64Url(freezeEnvelope.payloadBase64Url)))
  } catch { return invalid() }
  const keys = await offlineServerKeys()
  const { data, error } = await posClient(undefined, true).rpc('pos_offline_authority', { p_id: routed.authorityId })
  if (error) throw new PosServerError('offline_storage_unavailable', 503)
  if (!data) throw new PosServerError('offline_authority_unavailable', 404)
  let bundle, deviceKey, custody
  try {
    const row = readerSchema.parse(data), original = data as Record<string, unknown>
    if (canonicalJson(row.snapshot) !== canonicalJson(original.snapshot) || canonicalJson(row.authority) !== canonicalJson(original.authority)) throw new Error()
    bundle = await verifyOfflineBundle(row.snapshotEnvelope, row.authorityEnvelope, keys.publicKeys)
    deviceKey = await importOfflinePublicKey(row.publicKeySpki)
    if (canonicalJson(row.snapshot) !== canonicalJson(bundle.snapshot) || canonicalJson(row.authority) !== canonicalJson(bundle.authority) ||
      row.snapshotSha256 !== bundle.snapshotSha256 || row.authoritySha256 !== bundle.authoritySha256 ||
      row.keyEpoch !== bundle.authority.keyEpoch || row.deviceId !== bundle.authority.deviceId ||
      await publicKeyFingerprint(deviceKey) !== bundle.authority.deviceKeySha256) throw new Error()
    custody = { snapshotEnvelope: row.snapshotEnvelope, authorityEnvelope: row.authorityEnvelope, publicKeySpki: row.publicKeySpki }
  } catch { throw new PosServerError('offline_storage_unavailable', 503) }
  let verified
  try { verified = await verifySignedEnvelope(freezeEnvelope, offlinePaymentFreezeSchema, { [bundle.authority.deviceKeySha256]: deviceKey }) }
  catch { throw new PosServerError('offline_device_proof_invalid', 403) }
  const freeze = verified.payload, a = bundle.authority
  if (freeze.authorityId !== a.id || freeze.organizationId !== a.organizationId || freeze.branchId !== a.branchId ||
    freeze.deviceId !== a.deviceId || freeze.actorId !== a.actorId || freeze.shiftId !== a.shiftId || freeze.keyEpoch !== a.keyEpoch ||
    freeze.deviceKeySha256 !== a.deviceKeySha256 || freeze.authoritySha256 !== bundle.authoritySha256 || freeze.snapshotSha256 !== bundle.snapshotSha256) return invalid()
  const requestBytes = canonicalBytes(freeze.request)
  if (requestBytes.length > 131_072 || await sha256Hex(requestBytes) !== freeze.requestSha256) return invalid()
  const quote = calculate(freeze.request, bundle)
  return immutable({ [verifiedFreezeBrand]: true as const, kind: 'verified-offline-payment-freeze' as const,
    purpose: 'reconciliation-only' as const, freeze, freezeSha256: verified.payloadSha256, quote, freezeEnvelope, custody })
}
export type VerifiedStoredOfflinePaymentFreeze = Awaited<ReturnType<typeof verifyStoredOfflinePaymentFreeze>>

/** Device registration/retrieval additionally requires a separate signed fresh query. */
export async function verifyOfflinePaymentFreeze(rawFreeze: unknown, rawQuery: unknown) {
  let queryEnvelope
  try {
    queryEnvelope = signedEnvelopeSchema.parse(rawQuery)
    offlinePaymentResolutionQuerySchema.parse(parseCanonicalPayload(decodeBase64Url(queryEnvelope.payloadBase64Url)))
  } catch { return invalid() }
  const evidence = await verifyStoredOfflinePaymentFreeze(rawFreeze)
  const deviceKey = await importOfflinePublicKey(evidence.custody.publicKeySpki)
  let queried
  try { queried = await verifySignedEnvelope(queryEnvelope, offlinePaymentResolutionQuerySchema, { [evidence.freeze.deviceKeySha256]: deviceKey }) }
  catch { throw new PosServerError('offline_device_proof_invalid', 403) }
  const query = queried.payload, freeze = evidence.freeze
  if (query.authorityId !== freeze.authorityId || query.keyEpoch !== freeze.keyEpoch || query.deviceId !== freeze.deviceId ||
    query.freezeId !== freeze.freezeId || query.freezeSha256 !== evidence.freezeSha256) return invalid()
  return immutable({ ...evidence, query, querySha256: queried.payloadSha256, queryEnvelope })
}
export type VerifiedOfflinePaymentFreeze = Awaited<ReturnType<typeof verifyOfflinePaymentFreeze>>
