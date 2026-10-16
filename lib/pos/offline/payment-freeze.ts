import { z } from 'zod'
import { posClient, PosServerError } from '../server/client'
import { canonicalBytes, canonicalJson, decodeBase64Url, parseCanonicalPayload, sha256Hex } from './canonical'
import { publicKeyFingerprint, verifyOfflineBundle, verifySignedEnvelope } from './authority'
import { offlineAuthoritySchema, offlineSnapshotSchema, signedEnvelopeSchema } from './contracts'
import { importOfflinePublicKey, offlineServerKeys } from './server-keys'
import { offlineUuid } from './server-contracts'

const MAX_FILS = 100_000_000
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const integer = (max: number) => z.number().int().min(0).max(max)
const text = (max: number) => z.string().min(1).max(max).refine(value => value === value.trim())
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)

export const offlinePaymentIntentRequestSchema = z.object({
  authorityId: offlineUuid, serviceType: z.enum(['dine_in', 'takeaway', 'delivery']),
  customer: z.object({ name: text(200), address: text(400), trn: z.string().regex(/^[0-9]{15}$/).nullable() }).strict().nullable(),
  lines: z.array(z.object({ productId: offlineUuid, quantityMilli: z.number().int().min(1).max(1_000_000) }).strict()).min(1).max(200),
  cashTenderedFils: integer(MAX_FILS), recordedCardFils: integer(MAX_FILS), presentedTotalFils: z.number().int().min(1).max(MAX_FILS),
}).strict().superRefine((request, ctx) => {
  if (new Set(request.lines.map(line => line.productId)).size !== request.lines.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate frozen product.' })
})
export const offlinePaymentFreezeSchema = z.object({
  kind: z.literal('offline-payment-freeze'), schemaVersion: z.literal(1),
  freezeId: offlineUuid, paymentIntentId: offlineUuid, orderId: offlineUuid, documentId: offlineUuid,
  organizationId: offlineUuid, branchId: offlineUuid, deviceId: offlineUuid, actorId: offlineUuid, shiftId: offlineUuid,
  keyEpoch: offlineUuid, deviceKeySha256: hash, authorityId: offlineUuid, authoritySha256: hash, snapshotSha256: hash,
  requestSha256: hash, request: offlinePaymentIntentRequestSchema, intentCreatedAt: instant,
  chainHead: z.object({ sequence: integer(Number.MAX_SAFE_INTEGER), eventSha256: hash.nullable() }).strict(),
  observation: z.object({ bootId: offlineUuid, elapsedRealtimeMs: integer(Number.MAX_SAFE_INTEGER), wallTimeMs: integer(253_402_300_799_999) }).strict().nullable(),
  declaration: z.literal('local-intent-unissued-and-permanently-frozen'),
}).strict().superRefine((freeze, ctx) => {
  if ((freeze.chainHead.sequence === 0) !== (freeze.chainHead.eventSha256 === null))
    ctx.addIssue({ code: 'custom', message: 'Invalid observed chain head.' })
  if (freeze.request.authorityId !== freeze.authorityId)
    ctx.addIssue({ code: 'custom', message: 'Frozen request authority differs.' })
})
export const offlinePaymentResolutionQuerySchema = z.object({
  kind: z.literal('offline-payment-resolution-query'), schemaVersion: z.literal(1),
  authorityId: offlineUuid, keyEpoch: offlineUuid, deviceId: offlineUuid, freezeId: offlineUuid, freezeSha256: hash, challenge: hash,
}).strict()
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

/** Evidence verification ONLY. Does not establish an unused identity, physical collection,
 * a durable native freeze, server chain position, manager approval, or a financial result.
 * Future SQL018 must claim/check IDs and serialize against imports before accepting custody.
 * No routes or financial writes may consume this until those guards exist. */
export async function verifyOfflinePaymentFreeze(rawFreeze: unknown, rawQuery: unknown) {
  let freezeEnvelope, queryEnvelope, routed
  try {
    freezeEnvelope = signedEnvelopeSchema.parse(rawFreeze)
    queryEnvelope = signedEnvelopeSchema.parse(rawQuery)
    routed = offlinePaymentFreezeSchema.parse(parseCanonicalPayload(decodeBase64Url(freezeEnvelope.payloadBase64Url)))
    offlinePaymentResolutionQuerySchema.parse(parseCanonicalPayload(decodeBase64Url(queryEnvelope.payloadBase64Url)))
  } catch { return invalid() }
  const keys = await offlineServerKeys()
  const { data, error } = await posClient(undefined, true).rpc('pos_offline_authority', { p_id: routed.authorityId })
  if (error) throw new PosServerError('offline_storage_unavailable', 503)
  if (!data) throw new PosServerError('offline_authority_unavailable', 404)
  let bundle, deviceKey
  try {
    const row = readerSchema.parse(data), original = data as Record<string, unknown>
    // The SQL reader duplicates payloads inside envelopes; bound each payload, not the wrapper.
    if (canonicalJson(row.snapshot) !== canonicalJson(original.snapshot) || canonicalJson(row.authority) !== canonicalJson(original.authority)) throw new Error()
    bundle = await verifyOfflineBundle(row.snapshotEnvelope, row.authorityEnvelope, keys.publicKeys)
    deviceKey = await importOfflinePublicKey(row.publicKeySpki)
    if (canonicalJson(row.snapshot) !== canonicalJson(bundle.snapshot) || canonicalJson(row.authority) !== canonicalJson(bundle.authority) ||
      row.snapshotSha256 !== bundle.snapshotSha256 || row.authoritySha256 !== bundle.authoritySha256 ||
      row.keyEpoch !== bundle.authority.keyEpoch || row.deviceId !== bundle.authority.deviceId ||
      await publicKeyFingerprint(deviceKey) !== bundle.authority.deviceKeySha256) throw new Error()
  } catch { throw new PosServerError('offline_storage_unavailable', 503) }
  let verified, queried
  try {
    const trusted = { [bundle.authority.deviceKeySha256]: deviceKey }
    verified = await verifySignedEnvelope(freezeEnvelope, offlinePaymentFreezeSchema, trusted)
    queried = await verifySignedEnvelope(queryEnvelope, offlinePaymentResolutionQuerySchema, trusted)
  } catch { throw new PosServerError('offline_device_proof_invalid', 403) }
  const freeze = verified.payload, query = queried.payload, a = bundle.authority
  if (freeze.authorityId !== a.id || freeze.organizationId !== a.organizationId || freeze.branchId !== a.branchId ||
    freeze.deviceId !== a.deviceId || freeze.actorId !== a.actorId || freeze.shiftId !== a.shiftId || freeze.keyEpoch !== a.keyEpoch ||
    freeze.deviceKeySha256 !== a.deviceKeySha256 || freeze.authoritySha256 !== bundle.authoritySha256 || freeze.snapshotSha256 !== bundle.snapshotSha256 ||
    query.authorityId !== freeze.authorityId || query.keyEpoch !== freeze.keyEpoch || query.deviceId !== freeze.deviceId ||
    query.freezeId !== freeze.freezeId || query.freezeSha256 !== verified.payloadSha256) return invalid()
  const requestBytes = canonicalBytes(freeze.request)
  if (requestBytes.length > 131_072 || await sha256Hex(requestBytes) !== freeze.requestSha256) return invalid()
  const quote = calculate(freeze.request, bundle)
  // Observation, intent time, and chain head are retained evidence, not present-day authority.
  // In particular an expired grant or a server behind queued receipts does not reject recovery.
  return immutable({ [verifiedFreezeBrand]: true as const, kind: 'verified-offline-payment-freeze' as const,
    purpose: 'reconciliation-only' as const, freeze, freezeSha256: verified.payloadSha256,
    query, querySha256: queried.payloadSha256, quote, freezeEnvelope, queryEnvelope })
}
export type VerifiedOfflinePaymentFreeze = Awaited<ReturnType<typeof verifyOfflinePaymentFreeze>>
