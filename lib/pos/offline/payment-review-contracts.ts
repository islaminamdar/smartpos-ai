import { z } from 'zod'
import { signedEnvelopeSchema } from './contracts'
import { offlineUuid } from './server-contracts'
import { offlinePaymentFreezeSchema } from './payment-contracts'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const fils = z.number().int().min(0).max(100_000_000)
const text = (max: number) => z.string().min(1).max(max)
  .refine(value => value === value.trim() && !value.includes('\u0000'))
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
// Preserve SQL keyset precision; truncating microseconds can skip or repeat cases.
const recordedAt = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)))
const decision = z.enum(['funds_returned', 'payment_voided'])
export const paymentDecisionRequestSchema = z.object({
  requestId: offlineUuid, freezeId: offlineUuid, freezeSha256: hash, decision,
  reason: text(240), evidence: z.array(z.object({
    method: z.enum(['cash', 'card']), amountFils: fils.refine(value => value > 0),
    paymentObservedAt: instant, completedAt: instant, reference: text(120), note: text(400),
  }).strict()).min(1).max(2), cashDrawerShiftId: offlineUuid.nullable(),
}).strict().superRefine((request, ctx) => {
  const methods = request.evidence.map(leg => leg.method)
  if (new Set(methods).size !== methods.length || (methods.length === 2 && methods[0] !== 'cash'))
    ctx.addIssue({ code: 'custom', message: 'Use one cash leg, then one card leg when applicable.' })
  if (request.evidence.some(leg => Date.parse(leg.completedAt) < Date.parse(leg.paymentObservedAt)))
    ctx.addIssue({ code: 'custom', message: 'Completion cannot precede payment observation.' })
  if ((methods.includes('cash')) !== (request.cashDrawerShiftId !== null))
    ctx.addIssue({ code: 'custom', message: 'Cash returns require their original drawer.' })
  if (request.decision === 'payment_voided' && (methods.length !== 1 || methods[0] !== 'card'))
    ctx.addIssue({ code: 'custom', message: 'Authorization voids are card-only.' })
})
export type PaymentDecisionRequest = z.infer<typeof paymentDecisionRequestSchema>
export const offlinePaymentResolutionSchema = z.object({
  kind: z.literal('offline-payment-resolution'), schemaVersion: z.literal(1), purpose: z.literal('reconciliation-only'),
  resolutionId: offlineUuid, requestId: offlineUuid, freezeId: offlineUuid, freezeSha256: hash,
  paymentIntentId: offlineUuid, requestSha256: hash, orderId: offlineUuid, documentId: offlineUuid,
  organizationId: offlineUuid, branchId: offlineUuid, deviceId: offlineUuid, actorId: offlineUuid,
  shiftId: offlineUuid, keyEpoch: offlineUuid, authorityId: offlineUuid, authoritySha256: hash, snapshotSha256: hash,
  managerActorId: offlineUuid, decision, evidenceSha256: hash, resolvedAt: instant, replacement: z.null(),
}).strict()
export type OfflinePaymentResolution = z.infer<typeof offlinePaymentResolutionSchema>

export const paymentReviewCursorSchema = z.object({ recordedAt, caseId: offlineUuid, caseKind: z.enum(['freeze', 'raw']) }).strict()
export const paymentReviewSummarySchema = z.object({
  caseId: offlineUuid, caseKind: z.enum(['freeze', 'raw']), freezeId: offlineUuid.nullable(), freezeSha256: hash.nullable(),
  authorityId: offlineUuid, paymentIntentId: offlineUuid, orderId: offlineUuid, documentId: offlineUuid,
  branchId: offlineUuid, deviceId: offlineUuid, deviceName: z.string().min(1).max(120), actorId: offlineUuid, shiftId: offlineUuid,
  recordedAt, state: z.enum(['pending', 'conflict', 'delivery_pending', 'resolved', 'unsupported_text']),
  grossFils: fils.nullable(), cashFils: fils.nullable(), cardFils: fils.nullable(),
  decision: decision.nullable(), resolutionId: offlineUuid.nullable(),
}).strict()
export type PaymentReviewSummary = z.infer<typeof paymentReviewSummarySchema>
export const paymentReviewListSchema = z.object({
  branchId: offlineUuid, cases: z.array(paymentReviewSummarySchema).max(50), nextCursor: z.string().max(400).nullable(),
}).strict()
export type PaymentReviewList = z.infer<typeof paymentReviewListSchema>
export const paymentReviewQuoteSchema = z.object({
  calculationVersion: z.literal('offline-line-v1'),
  lines: z.array(z.object({ lineNumber: z.number().int().min(1).max(200), productId: offlineUuid,
    name: z.string().min(1).max(240), unit: z.enum(['piece', 'pack', 'kg']), quantityMilli: z.number().int().min(1).max(1_000_000),
    unitPriceFils: fils, taxRateBps: z.number().int().min(0).max(10_000), grossFils: fils, netFils: fils, taxFils: fils,
  }).strict()).min(1).max(200),
  totals: z.object({ grossFils: fils, netFils: fils, taxFils: fils }).strict(),
  payments: z.array(z.object({ method: z.enum(['cash', 'card']), amountFils: fils.refine(value => value > 0) }).strict()).min(1).max(2),
  cashTenderedFils: fils, changeFils: fils, requiresBuyerDetails: z.boolean(),
}).strict()
export const paymentReviewConflictsSchema = z.array(z.object({
  conflictId: offlineUuid, code: z.string().regex(/^[a-z_]{1,100}$/), payloadSha256: hash, createdAt: recordedAt,
}).strict()).max(50)
export const paymentReviewCapabilitiesSchema = z.object({
  policyEnabled: z.boolean(), originalShiftOpen: z.boolean(), canDecide: z.boolean(),
  holdCode: z.string().regex(/^[a-z_]{1,100}$/).nullable(),
}).strict()
export const paymentReviewDetailSchema = z.object({
  summary: paymentReviewSummarySchema, freeze: offlinePaymentFreezeSchema.nullable(), quote: paymentReviewQuoteSchema.nullable(),
  conflicts: paymentReviewConflictsSchema, conflictsTruncated: z.boolean(),
  decisionRequest: paymentDecisionRequestSchema.nullable(), resolution: offlinePaymentResolutionSchema.nullable(),
  resolutionEnvelope: signedEnvelopeSchema.nullable(), capabilities: paymentReviewCapabilitiesSchema,
  nativeDelivery: z.literal('not_implemented'),
}).strict()
export type PaymentReviewDetail = z.infer<typeof paymentReviewDetailSchema>
export const paymentDecisionResponseSchema = z.object({
  status: z.enum(['recorded', 'delivery_pending']), decisionRequest: paymentDecisionRequestSchema,
  resolution: offlinePaymentResolutionSchema, resolutionEnvelope: signedEnvelopeSchema.nullable(),
  nativeDelivery: z.literal('not_implemented'),
}).strict().superRefine((value, ctx) => {
  if ((value.status === 'recorded') !== (value.resolutionEnvelope !== null))
    ctx.addIssue({ code: 'custom', message: 'Stored signature and delivery state differ.' })
})
export type PaymentDecisionResponse = z.infer<typeof paymentDecisionResponseSchema>
