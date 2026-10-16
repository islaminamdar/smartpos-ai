import { z } from 'zod'
import { posClient, PosServerError } from '../server/client'
import { fiscalDocumentSchema } from '../server/documents'
import { canonicalJson } from './canonical'
import { signEnvelope, verifyOfflineBundle, verifySignedEnvelope } from './authority'
import { offlineIssuanceSchema, signedEnvelopeSchema } from './contracts'
import { offlineAckSchema, offlineUuid } from './server-contracts'
import { importOfflinePublicKey, offlineServerKeys, type OfflineServerKeys } from './server-keys'
import { verifyOfflinePaymentFreeze, type VerifiedOfflinePaymentFreeze } from './payment-freeze'
import { validateHistoricalIssuance } from './validation'
import { hasUnsupportedCustomerText, retainVerifiedUnsupportedEvidence } from './unsupported-text'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const resultScope = { freezeId: offlineUuid, freezeSha256: hash, authorityId: offlineUuid }
const registrationResultSchema = z.discriminatedUnion('status', [
  z.object({ ...resultScope, status: z.literal('registered'), paymentIntentId: offlineUuid,
    replayed: z.boolean(), hasConflicts: z.boolean() }).strict(),
  z.object({ ...resultScope, status: z.literal('conflict'), conflictId: offlineUuid,
    code: z.string().regex(/^[a-z_]{1,100}$/) }).strict(),
  z.object({ ...resultScope, status: z.literal('already_issued'), conflictId: offlineUuid,
    receipt: fiscalDocumentSchema, acknowledgement: signedEnvelopeSchema, issuanceEnvelope: signedEnvelopeSchema }).strict(),
])

/** Registration status only. A manager decision is deliberately not a supported outcome yet. */
export const nativePaymentRegistrationStatusSchema = z.object({
  kind: z.literal('native-payment-resolution-status'), schemaVersion: z.literal(1),
  purpose: z.literal('reconciliation-only'), challenge: hash,
  serverTimeMs: z.number().int().nonnegative().max(253_402_300_799_999),
  authorityId: offlineUuid, keyEpoch: offlineUuid, deviceId: offlineUuid, freezeId: offlineUuid, freezeSha256: hash,
  state: z.enum(['pending', 'already_issued', 'conflict']), resolutionSha256: z.null(), issuanceSha256: hash.nullable(),
}).strict().superRefine((status, ctx) => {
  if ((status.state === 'already_issued') !== (status.issuanceSha256 !== null))
    ctx.addIssue({ code: 'custom', message: 'Status does not match its original issuance proof.' })
})
export const paymentRegistrationResponseSchema = z.object({ handoff: signedEnvelopeSchema,
  resolutionEnvelope: z.null(), receipt: fiscalDocumentSchema.nullable(), acknowledgement: signedEnvelopeSchema.nullable(),
}).strict().superRefine((response, ctx) => {
  if ((response.receipt === null) !== (response.acknowledgement === null))
    ctx.addIssue({ code: 'custom', message: 'Original receipt and acknowledgement must be supplied together.' })
})
export const MAX_PAYMENT_REGISTRATION_RESPONSE_BYTES = 1_420_000
function unavailable(): never { throw new PosServerError('offline_storage_unavailable', 503) }

async function originalIssuance(verified: VerifiedOfflinePaymentFreeze,
  row: Extract<z.infer<typeof registrationResultSchema>, { status: 'already_issued' }>, keys: OfflineServerKeys) {
  try {
    const custody = verified.custody
    const bundle = await verifyOfflineBundle(custody.snapshotEnvelope, custody.authorityEnvelope, keys.publicKeys)
    const deviceKey = await importOfflinePublicKey(custody.publicKeySpki)
    const original = await verifySignedEnvelope(row.issuanceEnvelope, offlineIssuanceSchema, { [verified.freeze.deviceKeySha256]: deviceKey })
    const { issuance } = validateHistoricalIssuance(original.payload, bundle)
    const { payload: ack } = await verifySignedEnvelope(row.acknowledgement, offlineAckSchema, keys.publicKeys)
    const f = verified.freeze, d = issuance.document, q = verified.quote
    if (d.kind !== 'tax_invoice' || d.schemaVersion !== 1) throw new Error()
    if (issuance.id !== f.orderId || issuance.paymentIntentId !== f.paymentIntentId || d.id !== f.documentId ||
      issuance.authorityId !== f.authorityId || issuance.authoritySha256 !== f.authoritySha256 || issuance.snapshotSha256 !== f.snapshotSha256 ||
      d.orderId !== f.orderId || d.actorId !== f.actorId || d.branchId !== f.branchId || d.deviceId !== f.deviceId || d.shiftId !== f.shiftId ||
      d.serviceType !== f.request.serviceType || canonicalJson(d.customer) !== canonicalJson(f.request.customer) ||
      canonicalJson(d.lines) !== canonicalJson(q.lines) || canonicalJson(d.totals) !== canonicalJson(q.totals) ||
      canonicalJson(d.payments) !== canonicalJson(q.payments) || d.cashTenderedFils !== q.cashTenderedFils || d.changeFils !== q.changeFils ||
      canonicalJson(row.receipt) !== canonicalJson(d) || ack.issuanceId !== issuance.id || ack.payloadSha256 !== original.payloadSha256 ||
      ack.authorityId !== f.authorityId || ack.keyEpoch !== f.keyEpoch || ack.deviceSequence !== issuance.deviceSequence) throw new Error()
    return original.payloadSha256
  } catch { return unavailable() }
}

/** Candidate service for SQL018; not exposed by an HTTP route or a native transport path.
 * Only signature-verified historical evidence reaches the trusted registration RPC.
 * Registration does not resolve the payment, authorize a manager, or permit selling.
 * A failed response/signing step is retried with the same immutable freeze, never a charge.
 */
export async function registerOfflinePaymentFreeze(rawFreeze: unknown, rawQuery: unknown) {
  const verified = await verifyOfflinePaymentFreeze(rawFreeze, rawQuery)
  // Load/validate the active signing configuration before the registration write.
  const keys = await offlineServerKeys()
  const f = verified.freeze
  let row: z.infer<typeof registrationResultSchema>
  if (hasUnsupportedCustomerText(f.request.customer)) {
    const retained = await retainVerifiedUnsupportedEvidence(f.authorityId, verified.freezeEnvelope)
    row = { status: 'conflict', freezeId: f.freezeId, freezeSha256: verified.freezeSha256,
      authorityId: f.authorityId, conflictId: retained.exceptionId, code: retained.code }
  } else {
    const { data, error } = await posClient(undefined, true).rpc('pos_offline_payment_freeze', { p_envelope: verified.freezeEnvelope })
    if (error) return unavailable()
    try {
      row = registrationResultSchema.parse(data)
      // The wrapper may exceed a signed-payload budget; compare each member independently.
      for (const [key, value] of Object.entries(row))
        if (canonicalJson(value) !== canonicalJson((data as Record<string, unknown>)[key])) throw new Error()
    } catch { return unavailable() }
  }
  if (row.freezeId !== f.freezeId || row.freezeSha256 !== verified.freezeSha256 || row.authorityId !== f.authorityId ||
    (row.status === 'registered' && row.paymentIntentId !== f.paymentIntentId)) return unavailable()
  const issuanceSha256 = row.status === 'already_issued' ? await originalIssuance(verified, row, keys) : null
  const state = row.status === 'registered' ? (row.hasConflicts ? 'conflict' : 'pending') : row.status
  const payload = nativePaymentRegistrationStatusSchema.parse({ kind: 'native-payment-resolution-status', schemaVersion: 1,
    purpose: 'reconciliation-only', challenge: verified.query.challenge, serverTimeMs: Date.now(), authorityId: f.authorityId,
    keyEpoch: f.keyEpoch, deviceId: f.deviceId, freezeId: f.freezeId, freezeSha256: verified.freezeSha256,
    state, resolutionSha256: null, issuanceSha256 })
  const handoff = await signEnvelope(payload, keys.activeId, keys.privateKey)
  await verifySignedEnvelope(handoff, nativePaymentRegistrationStatusSchema, keys.publicKeys)
  const response = paymentRegistrationResponseSchema.parse({ handoff, resolutionEnvelope: null,
    receipt: row.status === 'already_issued' ? row.receipt : null,
    acknowledgement: row.status === 'already_issued' ? row.acknowledgement : null })
  if (new TextEncoder().encode(JSON.stringify(response)).length > MAX_PAYMENT_REGISTRATION_RESPONSE_BYTES)
    throw new PosServerError('offline_response_too_large', 503)
  return response
}
