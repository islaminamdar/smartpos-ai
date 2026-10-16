import { z } from 'zod'
import { fiscalDocumentSchema, merchantProfileSchema } from '../server/documents'

export const MAX_SIGNED_PAYLOAD_BYTES = 1_048_576
const uuid = z.string().uuid().refine((value) => value === value.toLowerCase(), 'Use lowercase UUIDs.')
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
const integer = (max: number) => z.number().int().nonnegative().max(max)
const text = (max: number) => z.string().min(1).max(max).refine((value) => value === value.trim())
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/)

export const signedEnvelopeSchema = z.object({
  format: z.literal('pos-signed-v1'),
  alg: z.literal('ECDSA-P256-SHA256-DER'),
  keyId: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/),
  payloadBase64Url: base64url.max(Math.ceil(MAX_SIGNED_PAYLOAD_BYTES * 4 / 3)),
  signatureBase64Url: base64url.max(96),
}).strict()

export const offlineProductSchema = z.object({
  id: uuid, name: text(240), category: text(120), unit: z.enum(['piece', 'pack', 'kg']),
  unitPriceFils: integer(100_000_000), taxRateBps: integer(10_000),
  revision: z.number().int().min(1).max(2_147_483_647),
}).strict()

export const offlineSnapshotSchema = z.object({
  kind: z.literal('offline-snapshot'), schemaVersion: z.literal(1), id: uuid,
  organizationId: uuid, branchId: uuid, createdAt: timestamp,
  profile: merchantProfileSchema, products: z.array(offlineProductSchema).min(1).max(2000),
  calculationVersion: z.literal('offline-line-v1'), offers: z.array(z.never()).max(0),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.profile.organizationId !== snapshot.organizationId || snapshot.profile.branchId !== snapshot.branchId)
    ctx.addIssue({ code: 'custom', message: 'Snapshot merchant scope differs.' })
  if (new Set(snapshot.products.map((product) => product.id)).size !== snapshot.products.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate snapshot product.' })
})

export const offlineAuthoritySchema = z.object({
  kind: z.literal('offline-authority'), schemaVersion: z.literal(1), id: uuid,
  organizationId: uuid, branchId: uuid, deviceId: uuid, actorId: uuid,
  deviceKeySha256: hash, keyEpoch: uuid, shiftId: uuid, snapshotId: uuid, snapshotSha256: hash,
  issuedAt: timestamp, notBefore: timestamp, expiresAt: timestamp,
  invoiceRange: z.object({
    prefix: z.string().regex(/^[A-Z0-9]{2,16}$/),
    first: z.number().int().min(1).max(9_999_999_999),
    last: z.number().int().min(1).max(9_999_999_999),
  }).strict(),
  maxInvoiceTotalFils: z.number().int().min(1).max(100_000_000),
  maxGrossFils: z.number().int().min(1).max(100_000_000_000),
  permissions: z.object({ cash: z.boolean(), recordedCard: z.boolean(), mixedTender: z.boolean() }).strict(),
  policy: z.object({ refunds: z.literal('online-only'), sharedTabs: z.literal('online-only'), offers: z.literal('online-only') }).strict(),
}).strict().superRefine((grant, ctx) => {
  const count = grant.invoiceRange.last - grant.invoiceRange.first + 1
  if (count < 1 || count > 1000 || grant.maxGrossFils > count * grant.maxInvoiceTotalFils)
    ctx.addIssue({ code: 'custom', message: 'Invalid reserved invoice range or budget.' })
  const issued = Date.parse(grant.issuedAt), start = Date.parse(grant.notBefore), end = Date.parse(grant.expiresAt)
  if (start < issued || end <= start || end - issued > 86_400_000)
    ctx.addIssue({ code: 'custom', message: 'Offline authority must be bounded to at most 24 hours.' })
  if ((!grant.permissions.cash && !grant.permissions.recordedCard) ||
    (grant.permissions.mixedTender && (!grant.permissions.cash || !grant.permissions.recordedCard)))
    ctx.addIssue({ code: 'custom', message: 'Invalid tender permissions.' })
})

export const offlineIssuanceSchema = z.object({
  kind: z.literal('offline-sale'), schemaVersion: z.literal(1), id: uuid,
  authorityId: uuid, authoritySha256: hash, snapshotSha256: hash,
  deviceSequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), previousEventSha256: hash.nullable(),
  document: fiscalDocumentSchema,
  clock: z.object({ estimatedServerAt: timestamp, bootId: uuid, elapsedRealtimeMs: integer(Number.MAX_SAFE_INTEGER) }).strict(),
  paymentIntentId: uuid,
}).strict().superRefine((issuance, ctx) => {
  const document = issuance.document
  if (document.kind !== 'tax_invoice' || document.schemaVersion !== 1 || document.orderId !== issuance.id ||
    document.issuedAt !== issuance.clock.estimatedServerAt)
    ctx.addIssue({ code: 'custom', message: 'Invalid offline invoice identity or version.' })
  if ((issuance.deviceSequence === 1) !== (issuance.previousEventSha256 === null))
    ctx.addIssue({ code: 'custom', message: 'Invalid device chain predecessor.' })
  if (new Set(document.lines.map((line) => line.productId.toLowerCase())).size !== document.lines.length)
    ctx.addIssue({ code: 'custom', message: 'Consolidate duplicate product lines.' })
})

export type SignedEnvelope = z.infer<typeof signedEnvelopeSchema>
export type OfflineSnapshot = z.infer<typeof offlineSnapshotSchema>
export type OfflineAuthority = z.infer<typeof offlineAuthoritySchema>
export type OfflineIssuance = z.infer<typeof offlineIssuanceSchema>
