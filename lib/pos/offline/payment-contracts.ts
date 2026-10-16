import { z } from 'zod'
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
