import { z } from 'zod'
import { posClient, PosServerError, authenticatedPosClient } from '../server/client'
import { hashToken } from '../server/live-access'
import { loginSourceKey } from '../server/login-source'
import { canonicalBytes, canonicalJson, sha256Hex } from './canonical'
import { signEnvelope, verifySignedEnvelope } from './authority'
import { offlineServerKeys } from './server-keys'
import { signedEnvelopeSchema } from './contracts'
import { offlineUuid } from './server-contracts'
import { offlinePaymentIntentRequestSchema } from './payment-contracts'
import { verifyStoredOfflinePaymentFreeze } from './payment-freeze'
import {
  paymentDecisionRequestSchema, offlinePaymentResolutionSchema, paymentReviewSummarySchema,
  paymentReviewCursorSchema, paymentReviewQuoteSchema, paymentReviewCapabilitiesSchema,
  paymentReviewConflictsSchema, paymentReviewDetailSchema, paymentReviewListSchema,
  paymentDecisionResponseSchema, type PaymentDecisionRequest, type PaymentReviewDetail,
  type OfflinePaymentResolution,
} from './payment-review-contracts'

const caseKind = z.enum(['freeze', 'raw'])
const storageDetailSchema = z.object({
  summary: paymentReviewSummarySchema, freezeEnvelope: signedEnvelopeSchema.nullable(),
  request: offlinePaymentIntentRequestSchema.nullable(), quote: paymentReviewQuoteSchema.nullable(),
  conflicts: paymentReviewConflictsSchema, conflictsTruncated: z.boolean(),
  decisionRequest: paymentDecisionRequestSchema.nullable(), resolution: offlinePaymentResolutionSchema.nullable(),
  resolutionEnvelope: signedEnvelopeSchema.nullable(), capabilities: paymentReviewCapabilitiesSchema,
}).strict()
const storedResolutionSchema = z.object({ resolution: offlinePaymentResolutionSchema,
  resolutionEnvelope: signedEnvelopeSchema.nullable() }).strict()
const decisionResultSchema = storedResolutionSchema.extend({ replayed: z.boolean() }).strict()
const errorCodes: Record<string, [string, number]> = {
  POS_ACCESS_DENIED: ['offline_review_forbidden', 403], POS_MANAGER_REQUIRED: ['offline_review_forbidden', 403],
  POS_OFFLINE_CASE_UNKNOWN: ['offline_case_unavailable', 404],
  POS_OFFLINE_CURSOR_INVALID: ['invalid_query', 422],
  POS_OFFLINE_RESOLUTION_DISABLED: ['offline_resolution_not_enabled', 503],
  POS_OFFLINE_CONFIRMATION_REQUIRED: ['manager_confirmation_required', 401],
  POS_OFFLINE_PAYMENT_HOLD: ['offline_payment_conflict', 409],
  POS_OFFLINE_PAYMENT_CONFLICT: ['offline_payment_conflict', 409],
  POS_OFFLINE_DECISION_CONFLICT: ['offline_decision_conflict', 409],
  POS_IDEMPOTENCY_CONFLICT: ['offline_decision_conflict', 409],
  POS_OFFLINE_INVALID_DECISION: ['invalid_payment_decision', 422],
  POS_OFFLINE_DECISION_INVALID: ['invalid_payment_decision', 422],
  POS_OFFLINE_SHIFT_CLOSED: ['offline_original_drawer_closed', 409],
  POS_OFFLINE_DRAWER_INVALID: ['offline_original_drawer_closed', 409],
}
function unavailable(): never { throw new PosServerError('offline_storage_unavailable', 503) }
async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await posClient(undefined, true).rpc(name, args)
  if (result.error) {
    const match = errorCodes[result.error.message]
    if (match) throw new PosServerError(...match)
    return unavailable()
  }
  return result.data
}
function stored<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) return unavailable()
  return parsed.data
}
export function requirePaymentReview() {
  if (process.env.POS_OFFLINE_PAYMENT_REVIEW_ENABLED !== 'true')
    throw new PosServerError('offline_review_not_enabled', 503)
}
function resolutionEnabled() { return process.env.POS_OFFLINE_PAYMENT_RESOLUTION_ENABLED === 'true' }
/** Current identity comes only from verified cookies; a submitted manager ID is never accepted. */
export async function paymentReviewActor(request: Request) {
  requirePaymentReview()
  const { user } = await authenticatedPosClient()
  const allowed = await rpc('pos_offline_manager_limit', { p_actor: user.id, p_source: loginSourceKey(request) })
  if (allowed === false) throw new PosServerError('offline_review_rate_limited', 429)
  if (allowed !== true) return unavailable()
  return user
}
export async function listPaymentReviews(actorId: string, branchId: string, cursor: string | null) {
  offlineUuid.parse(actorId); offlineUuid.parse(branchId)
  let parsedCursor = null
  if (cursor !== null) {
    if (cursor.length > 400) throw new PosServerError('invalid_query', 422)
    try { parsedCursor = paymentReviewCursorSchema.parse(JSON.parse(cursor)) }
    catch { throw new PosServerError('invalid_query', 422) }
  }
  const row = stored(z.object({ cases: z.array(paymentReviewSummarySchema).max(50),
    nextCursor: paymentReviewCursorSchema.nullable() }).strict(),
    await rpc('pos_offline_payment_list', { p_actor: actorId, p_branch: branchId, p_cursor: parsedCursor }))
  if (row.cases.some(item => item.branchId !== branchId)) return unavailable()
  return paymentReviewListSchema.parse({ branchId, cases: row.cases,
    nextCursor: row.nextCursor === null ? null : JSON.stringify(row.nextCursor) })
}
async function checkResolution(resolution: OfflinePaymentResolution, request: PaymentDecisionRequest,
  detail: Pick<PaymentReviewDetail, 'freeze'>) {
  const f = detail.freeze
  if (!f) return unavailable()
  for (const field of ['paymentIntentId', 'requestSha256', 'orderId', 'documentId', 'organizationId', 'branchId',
    'deviceId', 'actorId', 'shiftId', 'keyEpoch', 'authorityId', 'authoritySha256', 'snapshotSha256'] as const)
    if (resolution[field] !== f[field]) return unavailable()
  if (resolution.requestId !== request.requestId || resolution.freezeId !== f.freezeId || resolution.freezeId !== request.freezeId ||
    resolution.freezeSha256 !== request.freezeSha256 || resolution.decision !== request.decision ||
    resolution.evidenceSha256 !== await sha256Hex(canonicalBytes(request.evidence)) ||
    request.evidence.some(leg => Date.parse(leg.completedAt) > Date.parse(resolution.resolvedAt))) return unavailable()
}
async function verifyResolutionEnvelope(resolution: OfflinePaymentResolution, envelope: z.infer<typeof signedEnvelopeSchema>) {
  const keys = await offlineServerKeys()
  try {
    const verified = await verifySignedEnvelope(envelope, offlinePaymentResolutionSchema, keys.publicKeys)
    if (canonicalJson(verified.payload) !== canonicalJson(resolution)) throw new Error()
  } catch { return unavailable() }
  return envelope
}
/** Only an already committed exact result is signed. A retry cannot perform another return. */
export async function finishPaymentResolutionSignature(resolution: OfflinePaymentResolution, existing: z.infer<typeof signedEnvelopeSchema> | null) {
  if (existing) return verifyResolutionEnvelope(resolution, existing)
  const keys = await offlineServerKeys()
  const envelope = await signEnvelope(resolution, keys.activeId, keys.privateKey)
  await verifyResolutionEnvelope(resolution, envelope)
  const row = stored(storedResolutionSchema, await rpc('pos_offline_payment_attach', {
    p_resolution: resolution.resolutionId, p_envelope: envelope,
  }))
  if (canonicalJson(row.resolution) !== canonicalJson(resolution) || !row.resolutionEnvelope) return unavailable()
  return verifyResolutionEnvelope(resolution, row.resolutionEnvelope)
}
function evidenceMatches(request: PaymentDecisionRequest, detail: PaymentReviewDetail, now: number) {
  const f = detail.freeze, q = detail.quote
  if (!f || !q || request.freezeId !== f.freezeId || request.freezeSha256 !== detail.summary.freezeSha256 ||
    request.evidence.length !== q.payments.length || request.evidence.some((leg, i) =>
      leg.method !== q.payments[i].method || leg.amountFils !== q.payments[i].amountFils || Date.parse(leg.completedAt) > now) ||
    (request.evidence.some(leg => leg.method === 'cash') && request.cashDrawerShiftId !== f.shiftId))
    throw new PosServerError('invalid_payment_decision', 422)
}
export async function readPaymentReview(actorId: string, branchId: string, caseId: string, kind: 'freeze' | 'raw', recoverSignature = true) {
  offlineUuid.parse(actorId); offlineUuid.parse(branchId); offlineUuid.parse(caseId); caseKind.parse(kind)
  const raw = await rpc('pos_offline_payment_detail', { p_actor: actorId, p_branch: branchId, p_case: caseId, p_kind: kind })
  if (raw === null) throw new PosServerError('offline_case_unavailable', 404)
  const row = stored(storageDetailSchema, raw), s = row.summary
  if (s.branchId !== branchId || s.caseId !== caseId || s.caseKind !== kind) return unavailable()
  let freeze = null, quote = null
  if (kind === 'freeze') {
    if (!row.freezeEnvelope || !row.request || !row.quote) return unavailable()
    const verified = await verifyStoredOfflinePaymentFreeze(row.freezeEnvelope), f = verified.freeze, q = verified.quote
    if (f.branchId !== branchId || f.freezeId !== s.freezeId || f.freezeId !== caseId || verified.freezeSha256 !== s.freezeSha256 ||
      f.authorityId !== s.authorityId || f.paymentIntentId !== s.paymentIntentId || f.orderId !== s.orderId ||
      f.documentId !== s.documentId || f.deviceId !== s.deviceId || f.actorId !== s.actorId || f.shiftId !== s.shiftId ||
      canonicalJson(row.request) !== canonicalJson(f.request) || canonicalJson(row.quote) !== canonicalJson(q) ||
      s.grossFils !== q.totals.grossFils || s.cashFils !== (q.payments.find(p => p.method === 'cash')?.amountFils ?? 0) ||
      s.cardFils !== (q.payments.find(p => p.method === 'card')?.amountFils ?? 0)) return unavailable()
    freeze = f; quote = q
  } else if (row.freezeEnvelope || row.request || row.quote || row.decisionRequest || row.resolution || row.resolutionEnvelope ||
    row.capabilities.canDecide || s.state !== 'unsupported_text') return unavailable()
  if ((row.resolution !== null) !== (row.decisionRequest !== null) || (row.resolutionEnvelope !== null && row.resolution === null)) return unavailable()
  const result = paymentReviewDetailSchema.parse({ summary: s, freeze, quote, conflicts: row.conflicts,
    conflictsTruncated: row.conflictsTruncated, decisionRequest: row.decisionRequest, resolution: row.resolution,
    resolutionEnvelope: row.resolutionEnvelope, capabilities: row.capabilities, nativeDelivery: 'not_confirmed' })
  if (result.resolution && result.decisionRequest) {
    await checkResolution(result.resolution, result.decisionRequest, result)
    evidenceMatches(result.decisionRequest, result, Date.parse(result.resolution.resolvedAt))
    if (s.resolutionId !== result.resolution.resolutionId || s.decision !== result.resolution.decision) return unavailable()
    if (result.resolutionEnvelope) await verifyResolutionEnvelope(result.resolution, result.resolutionEnvelope)
    else if (recoverSignature) {
      try { result.resolutionEnvelope = await finishPaymentResolutionSignature(result.resolution, null) }
      catch { /* The decision is already committed. Keep an explicit delivery-pending result. */ }
    }
    if (result.resolutionEnvelope && result.summary.state === 'delivery_pending') result.summary.state = 'resolved'
  } else if (s.resolutionId !== null || s.decision !== null || ['resolved', 'delivery_pending'].includes(s.state)) return unavailable()
  if (!resolutionEnabled()) {
    result.capabilities.canDecide = false
    if (!result.capabilities.holdCode) result.capabilities.holdCode = 'offline_resolution_not_enabled'
  }
  if (result.resolution || result.conflicts.length || result.conflictsTruncated || s.state !== 'pending') result.capabilities.canDecide = false
  return result
}

/** Browser password is checked for the exact authenticated account and never enters any RPC,
 * durable journal, cookie or result. Its temporary Auth session is revoked before a decision. */
async function confirmManager(request: Request, user: { id: string; email?: string }, password: string) {
  const email = user.email?.trim().toLowerCase()
  if (!email) throw new PosServerError('authentication_required', 401)
  const rate = await rpc('pos_login_attempt', { p_key: hashToken(email), p_source: loginSourceKey(request) })
  if (rate === false) throw new PosServerError('login_rate_limited', 429)
  if (rate !== true) return unavailable()
  const client = posClient(), admin = posClient(undefined, true)
  const verified = await client.auth.signInWithPassword({ email, password })
  const confirmedAt = new Date().toISOString()
  const token = verified.data.session?.access_token
  const correct = !verified.error && !!token && verified.data.user?.id === user.id
  if (token) {
    const revoked = await admin.auth.admin.signOut(token, 'local').catch(() => ({ error: true }))
    if (revoked.error) throw new PosServerError('manager_confirmation_unavailable', 503)
  }
  if (!correct) throw new PosServerError('current_password_incorrect', 401)
  return confirmedAt
}
export async function decidePaymentReview(http: Request, user: { id: string; email?: string }, branchId: string,
  input: PaymentDecisionRequest, currentPassword: string) {
  const request = paymentDecisionRequestSchema.parse(input)
  z.string().min(1).max(256).parse(currentPassword)
  const detail = await readPaymentReview(user.id, branchId, request.freezeId, 'freeze', false)
  if (detail.resolution && detail.decisionRequest) {
    if (detail.resolution.managerActorId !== user.id || canonicalJson(detail.decisionRequest) !== canonicalJson(request))
      throw new PosServerError('offline_decision_conflict', 409)
  } else {
    if (!resolutionEnabled()) throw new PosServerError('offline_resolution_not_enabled', 503)
    if (!detail.capabilities.canDecide) throw new PosServerError('offline_payment_conflict', 409)
    evidenceMatches(request, detail, Date.now())
    const confirmedAt = await confirmManager(http, user, currentPassword)
    const row = stored(decisionResultSchema, await rpc('pos_offline_payment_decide', {
      p_actor: user.id, p_request: request, p_confirmed_at: confirmedAt,
    }))
    if (row.resolution.managerActorId !== user.id) return unavailable()
    await checkResolution(row.resolution, request, detail)
    detail.resolution = row.resolution; detail.decisionRequest = request; detail.resolutionEnvelope = row.resolutionEnvelope
  }
  const resolution = detail.resolution!
  // A failed signer/attachment must not invite another external return or another decision.
  let envelope = detail.resolutionEnvelope
  if (envelope) await verifyResolutionEnvelope(resolution, envelope)
  else { try { envelope = await finishPaymentResolutionSignature(resolution, null) } catch { envelope = null } }
  return paymentDecisionResponseSchema.parse({ status: envelope ? 'recorded' : 'delivery_pending',
    decisionRequest: request, resolution, resolutionEnvelope: envelope, nativeDelivery: 'not_confirmed' })
}
