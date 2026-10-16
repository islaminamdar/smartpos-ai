import { z } from 'zod'
import { posClient, PosServerError } from '../server/client'
import { canonicalBytes, decodeBase64Url, parseCanonicalPayload, sha256Hex } from './canonical'
import { signEnvelope, verifyOfflineBundle, verifySignedEnvelope, publicKeyFingerprint } from './authority'
import { signedEnvelopeSchema } from './contracts'
import { offlineUuid } from './server-contracts'
import { importOfflinePublicKey, offlineServerKeys } from './server-keys'
import { offlinePaymentResolutionQuerySchema } from './payment-contracts'
import { verifyStoredOfflinePaymentFreeze } from './payment-freeze'
import { finishPaymentResolutionSignature } from './payment-review'
import { paymentDecisionRequestSchema, offlinePaymentResolutionSchema } from './payment-review-contracts'
import { registerOfflinePaymentFreeze, MAX_PAYMENT_REGISTRATION_RESPONSE_BYTES } from './payment-registration'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const nativePaymentResolutionStatusSchema = z.object({
  kind: z.literal('native-payment-resolution-status'), schemaVersion: z.literal(1), purpose: z.literal('reconciliation-only'),
  challenge: hash, serverTimeMs: z.number().int().nonnegative().max(253_402_300_799_999),
  authorityId: offlineUuid, keyEpoch: offlineUuid, deviceId: offlineUuid, freezeId: offlineUuid, freezeSha256: hash,
  state: z.enum(['pending', 'resolved', 'conflict']), resolutionSha256: hash.nullable(), issuanceSha256: z.null(),
}).strict().superRefine((value, ctx) => {
  if ((value.state === 'resolved') !== (value.resolutionSha256 !== null))
    ctx.addIssue({ code: 'custom', message: 'Resolution status and hash differ.' })
})
const queryRequest = z.object({ queryEnvelope: signedEnvelopeSchema }).strict()
const freezeRequest = queryRequest.extend({ freezeEnvelope: signedEnvelopeSchema }).strict()
const storedSchema = z.object({ state: z.enum(['pending', 'resolved', 'conflict']), freezeEnvelope: signedEnvelopeSchema,
  decisionRequest: paymentDecisionRequestSchema.nullable(), resolution: offlinePaymentResolutionSchema.nullable(),
  resolutionEnvelope: signedEnvelopeSchema.nullable(), managerActorId: offlineUuid.nullable(),
}).strict()
type Query = z.infer<typeof offlinePaymentResolutionQuerySchema>
function unavailable(): never { throw new PosServerError('offline_storage_unavailable', 503) }

/** Query possession is checked before the case reader. This never checks current login,
 * membership, selling flags or expiry, and cannot create a manager decision. */
async function authenticatedQuery(raw: unknown) {
  const envelope = signedEnvelopeSchema.parse(raw)
  const query = offlinePaymentResolutionQuerySchema.parse(parseCanonicalPayload(decodeBase64Url(envelope.payloadBase64Url)))
  const keys = await offlineServerKeys()
  const { data, error } = await posClient(undefined, true).rpc('pos_offline_authority', { p_id: query.authorityId })
  if (error) return unavailable()
  if (!data) throw new PosServerError('offline_authority_unavailable', 404)
  let bundle, deviceKey
  try {
    const row = z.object({ snapshotEnvelope: signedEnvelopeSchema, authorityEnvelope: signedEnvelopeSchema,
      publicKeySpki: z.string().max(342), keyEpoch: offlineUuid, deviceId: offlineUuid }).passthrough().parse(data)
    bundle = await verifyOfflineBundle(row.snapshotEnvelope, row.authorityEnvelope, keys.publicKeys)
    deviceKey = await importOfflinePublicKey(row.publicKeySpki)
    if (bundle.authority.id !== query.authorityId || row.keyEpoch !== bundle.authority.keyEpoch ||
      row.deviceId !== bundle.authority.deviceId || await publicKeyFingerprint(deviceKey) !== bundle.authority.deviceKeySha256) return unavailable()
  } catch { return unavailable() }
  try {
    await verifySignedEnvelope(envelope, offlinePaymentResolutionQuerySchema, { [bundle.authority.deviceKeySha256]: deviceKey })
    if (query.keyEpoch !== bundle.authority.keyEpoch || query.deviceId !== bundle.authority.deviceId) throw new Error()
  } catch { throw new PosServerError('offline_device_proof_invalid', 403) }
  return { query, keys }
}
async function readCase(query: Query) {
  const { data, error } = await posClient(undefined, true).rpc('pos_offline_payment_native_read', {
    p_authority: query.authorityId, p_epoch: query.keyEpoch, p_device: query.deviceId,
    p_freeze: query.freezeId, p_hash: query.freezeSha256,
  })
  if (error) {
    if (error.message === 'POS_OFFLINE_CASE_UNKNOWN') throw new PosServerError('offline_case_unavailable', 404)
    return unavailable()
  }
  const parsed = storedSchema.safeParse(data)
  if (!parsed.success) return unavailable()
  const row = parsed.data, verified = await verifyStoredOfflinePaymentFreeze(row.freezeEnvelope), f = verified.freeze
  if (f.authorityId !== query.authorityId || f.keyEpoch !== query.keyEpoch || f.deviceId !== query.deviceId ||
    f.freezeId !== query.freezeId || verified.freezeSha256 !== query.freezeSha256) return unavailable()
  if ((row.resolution !== null) !== (row.decisionRequest !== null) || (row.resolution !== null) !== (row.managerActorId !== null) ||
    (row.resolutionEnvelope !== null && row.resolution === null) ||
    (row.state === 'resolved' && (!row.resolution || !row.resolutionEnvelope)) ||
    (row.state === 'conflict' && (row.resolution || row.decisionRequest || row.resolutionEnvelope || row.managerActorId))) return unavailable()
  if (row.resolution && row.decisionRequest) {
    const r = row.resolution, request = row.decisionRequest
    for (const field of ['paymentIntentId', 'requestSha256', 'orderId', 'documentId', 'organizationId', 'branchId',
      'deviceId', 'actorId', 'shiftId', 'keyEpoch', 'authorityId', 'authoritySha256', 'snapshotSha256'] as const)
      if (r[field] !== f[field]) return unavailable()
    if (r.managerActorId !== row.managerActorId || r.requestId !== request.requestId || r.freezeId !== f.freezeId ||
      request.freezeId !== f.freezeId || r.freezeSha256 !== query.freezeSha256 || request.freezeSha256 !== query.freezeSha256 ||
      r.decision !== request.decision || r.evidenceSha256 !== await sha256Hex(canonicalBytes(request.evidence)) ||
      request.evidence.length !== verified.quote.payments.length || request.evidence.some((leg, i) =>
        leg.method !== verified.quote.payments[i].method || leg.amountFils !== verified.quote.payments[i].amountFils ||
        Date.parse(leg.completedAt) > Date.parse(r.resolvedAt)) ||
      (request.evidence.some(leg => leg.method === 'cash') && request.cashDrawerShiftId !== f.shiftId)) return unavailable()
    if (row.resolutionEnvelope) await finishPaymentResolutionSignature(r, row.resolutionEnvelope)
  }
  return row
}
export async function recoverOfflinePaymentResolution(raw: unknown) {
  const request = queryRequest.parse(raw), { query, keys } = await authenticatedQuery(request.queryEnvelope)
  let row = await readCase(query)
  if (row.resolution && !row.resolutionEnvelope) {
    try { await finishPaymentResolutionSignature(row.resolution, null) }
    catch { /* Committed attestation remains pending. Never invent a signed success. */ }
    // A concurrent import/conflict may have arrived during attachment. Recheck under
    // the financial locks before exposing a terminal result to its original device.
    row = await readCase(query)
  }
  const resolved = row.state === 'resolved'
  if (!resolved && row.resolutionEnvelope) return unavailable()
  const resolutionSha256 = resolved ? await sha256Hex(canonicalBytes(row.resolution)) : null
  const status = nativePaymentResolutionStatusSchema.parse({ kind: 'native-payment-resolution-status', schemaVersion: 1,
    purpose: 'reconciliation-only', challenge: query.challenge, serverTimeMs: Date.now(), authorityId: query.authorityId,
    keyEpoch: query.keyEpoch, deviceId: query.deviceId, freezeId: query.freezeId, freezeSha256: query.freezeSha256,
    state: row.state, resolutionSha256, issuanceSha256: null })
  const handoff = await signEnvelope(status, keys.activeId, keys.privateKey)
  await verifySignedEnvelope(handoff, nativePaymentResolutionStatusSchema, keys.publicKeys)
  const response = { handoff, resolutionEnvelope: resolved ? row.resolutionEnvelope : null, receipt: null, acknowledgement: null }
  if (new TextEncoder().encode(JSON.stringify(response)).length > MAX_PAYMENT_REGISTRATION_RESPONSE_BYTES)
    throw new PosServerError('offline_response_too_large', 503)
  return response
}
/** Registration may return independently verified original invoice evidence. Native must
 * retain that contradiction, never manufacture a second local invoice or offline ACK. */
export async function registerAndRecoverOfflinePayment(raw: unknown) {
  const request = freezeRequest.parse(raw)
  const registered = await registerOfflinePaymentFreeze(request.freezeEnvelope, request.queryEnvelope)
  const status = parseCanonicalPayload(decodeBase64Url(registered.handoff.payloadBase64Url)) as { state: string }
  if (status.state !== 'pending') return registered
  return recoverOfflinePaymentResolution({ queryEnvelope: request.queryEnvelope })
}
