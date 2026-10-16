import { z } from 'zod'
import { signedEnvelopeSchema } from './contracts'

export const offlineUuid = z.string().uuid().refine(value => value === value.toLowerCase())
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
export const enrollmentProofSchema = z.object({
  kind: z.literal('offline-enrollment'), schemaVersion: z.literal(1), requestId: offlineUuid,
  branchId: offlineUuid, deviceId: offlineUuid, actorId: offlineUuid, deviceKeySha256: hash, issuedAt: instant,
}).strict()
export const enrollmentRequestSchema = z.object({
  requestId: offlineUuid, branchId: offlineUuid, deviceId: offlineUuid,
  publicKeySpki: z.string().regex(/^[A-Za-z0-9_-]{1,342}$/), deviceKeySha256: hash, proof: signedEnvelopeSchema,
}).strict()
export const enrollmentResultSchema = z.object({
  keyEpoch: offlineUuid, deviceId: offlineUuid, deviceKeySha256: hash,
  publicKeySpki: z.string().regex(/^[A-Za-z0-9_-]{1,342}$/),
}).strict()
export const reserveRequestSchema = z.object({
  requestId: offlineUuid, branchId: offlineUuid, deviceId: offlineUuid, shiftId: offlineUuid,
  count: z.number().int().min(1).max(1000), lifetimeSeconds: z.number().int().min(60).max(86400),
  maxInvoiceTotalFils: z.number().int().min(1).max(100_000_000),
  maxGrossFils: z.number().int().min(1).max(100_000_000_000),
  permissions: z.object({ cash: z.boolean(), recordedCard: z.boolean(), mixedTender: z.boolean() }).strict(),
}).strict().superRefine((request, ctx) => {
  const p = request.permissions
  if ((!p.cash && !p.recordedCard) || (p.mixedTender && (!p.cash || !p.recordedCard)) || request.maxGrossFils > request.count * request.maxInvoiceTotalFils)
    ctx.addIssue({ code: 'custom', message: 'Invalid offline limits or tenders.' })
})
export const offlineAckSchema = z.object({
  kind: z.literal('offline-ack'), schemaVersion: z.literal(1), id: offlineUuid,
  issuanceId: offlineUuid, payloadSha256: hash, authorityId: offlineUuid, keyEpoch: offlineUuid,
  deviceSequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), receivedAt: instant,
}).strict()
export const offlineSealSchema = z.object({
  kind: z.literal('offline-seal'), schemaVersion: z.literal(1), id: offlineUuid,
  authorityId: offlineUuid, keyEpoch: offlineUuid, deviceId: offlineUuid,
  finalSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), finalEventSha256: hash.nullable(),
}).strict().superRefine((seal, ctx) => {
  if ((seal.finalSequence === 0) !== (seal.finalEventSha256 === null)) ctx.addIssue({ code: 'custom', message: 'Invalid final chain head.' })
})
export const offlineExceptionSchema = z.object({
  status: z.literal('reconciliation_required'), exceptionId: offlineUuid,
  code: z.string().regex(/^[A-Za-z0-9_]{1,100}$/),
}).strict()
