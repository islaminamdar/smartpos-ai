import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { authenticatedPosClient, posClient, PosServerError } from '../server/client'
import { requirePilot } from '../server/live-access'
import { loginSourceKey } from '../server/login-source'
import { canonicalBytes, canonicalJson, decodeBase64Url, parseCanonicalPayload, sha256Hex } from './canonical'
import { publicKeyFingerprint, signEnvelope, verifyOfflineBundle, verifySignedEnvelope } from './authority'
import { offlineAuthoritySchema, offlineSnapshotSchema, signedEnvelopeSchema } from './contracts'
import { validateHistoricalIssuance } from './validation'
import { offlineServerKeys, importOfflinePublicKey, type OfflineServerKeys } from './server-keys'
import { enrollmentProofSchema, enrollmentRequestSchema, enrollmentResultSchema, reserveRequestSchema, offlineAckSchema,
  offlineExceptionSchema, offlineSealSchema, offlineUuid } from './server-contracts'

function newAuthorityEnabled() {
  requirePilot(true)
  if (process.env.POS_OFFLINE_ISSUANCE_ENABLED !== 'true') throw new PosServerError('offline_issuance_not_enabled', 503)
}
/** Only the exact SQL017 pre-insert rejection can authorize refreshing an enrollment proof. */
export class OfflineEnrollmentProofExpired extends PosServerError {
  constructor(readonly requestId: string, readonly requestSha256: string) { super('offline_enrollment_proof_expired', 409) }
}
async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await posClient(undefined, true).rpc(name, args)
  if (error) {
    if (name === 'pos_offline_enroll' && error.code === 'P0001' && error.message === 'POS_OFFLINE_PROOF_EXPIRED') {
      const request = enrollmentRequestSchema.parse(args.p_request)
      throw new OfflineEnrollmentProofExpired(request.requestId, await sha256Hex(canonicalBytes(request)))
    }
    const match = /\bPOS_OFFLINE_[A-Z_]+\b/.exec(error.message)?.[0] ??
      ['POS_ACCESS_DENIED', 'POS_IDEMPOTENCY_CONFLICT', 'POS_DEVICE_INVALID', 'POS_SHIFT_INVALID', 'POS_PROFILE_REQUIRED', 'POS_NUMBER_RANGE_EXHAUSTED']
        .find(code => error.message.includes(code))
    const status = match?.includes('ACCESS') ? 403 : !match || match === 'POS_OFFLINE_DISABLED' ? 503 : 409
    throw new PosServerError(match?.toLowerCase() ?? 'offline_storage_unavailable', status)
  }
  return data
}
function storage<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw)
  if (!result.success || canonicalJson(result.data) !== canonicalJson(raw)) throw new PosServerError('offline_storage_unavailable', 503)
  return result.data
}
export async function limitOfflineRecovery(request: Request) {
  const allowed = await rpc('pos_offline_limit', { p_source: loginSourceKey(request) })
  if (allowed === false) throw new PosServerError('offline_upload_rate_limited', 429)
  if (allowed !== true) throw new PosServerError('offline_storage_unavailable', 503)
}

export async function enrollOfflineDevice(raw: unknown) {
  newAuthorityEnabled()
  const request = enrollmentRequestSchema.parse(raw)
  const { user } = await authenticatedPosClient()
  await offlineServerKeys()
  try {
    const key = await importOfflinePublicKey(request.publicKeySpki)
    if (await publicKeyFingerprint(key) !== request.deviceKeySha256) throw new Error()
    const { payload } = await verifySignedEnvelope(request.proof, enrollmentProofSchema, { [request.deviceKeySha256]: key })
    if (payload.actorId !== user.id || payload.requestId !== request.requestId || payload.branchId !== request.branchId ||
      payload.deviceId !== request.deviceId || payload.deviceKeySha256 !== request.deviceKeySha256) throw new Error()
  } catch { throw new PosServerError('offline_device_proof_invalid', 403) }
  // DB checks freshness only for a new request, preserving exact recovery after a lost response.
  const result = storage(enrollmentResultSchema, await rpc('pos_offline_enroll', { p_actor: user.id, p_request: request }))
  if (result.deviceId !== request.deviceId || result.deviceKeySha256 !== request.deviceKeySha256 || result.publicKeySpki !== request.publicKeySpki)
    throw new PosServerError('offline_storage_unavailable', 503)
  return result
}

const readerSchema = z.object({
  snapshot: offlineSnapshotSchema, authority: offlineAuthoritySchema,
  snapshotEnvelope: signedEnvelopeSchema, authorityEnvelope: signedEnvelopeSchema,
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/), authoritySha256: z.string().regex(/^[a-f0-9]{64}$/),
  publicKeySpki: z.string().max(342), keyEpoch: offlineUuid, deviceId: offlineUuid,
}).strict()
async function verifiedReader(raw: unknown, keys: OfflineServerKeys) {
  try {
    const row = storage(readerSchema, raw)
    const bundle = await verifyOfflineBundle(row.snapshotEnvelope, row.authorityEnvelope, keys.publicKeys)
    const deviceKey = await importOfflinePublicKey(row.publicKeySpki)
    if (canonicalJson(bundle.snapshot) !== canonicalJson(row.snapshot) || canonicalJson(bundle.authority) !== canonicalJson(row.authority) ||
      row.snapshotSha256 !== bundle.snapshotSha256 || row.authoritySha256 !== bundle.authoritySha256 ||
      row.keyEpoch !== bundle.authority.keyEpoch || row.deviceId !== bundle.authority.deviceId ||
      await publicKeyFingerprint(deviceKey) !== bundle.authority.deviceKeySha256) throw new Error()
    return { row, bundle, deviceKey }
  } catch { throw new PosServerError('offline_storage_unavailable', 503) }
}

export async function reserveOfflineAuthority(raw: unknown) {
  newAuthorityEnabled()
  const request = reserveRequestSchema.parse(raw)
  const { user } = await authenticatedPosClient(), keys = await offlineServerKeys()
  const draft = storage(z.object({ snapshot: offlineSnapshotSchema, authority: z.record(z.unknown()) }).strict(),
    await rpc('pos_offline_reserve', { p_actor: user.id, p_request: request }))
  const snapshotSha256 = await sha256Hex(canonicalBytes(draft.snapshot))
  const authority = storage(offlineAuthoritySchema, { ...draft.authority, snapshotSha256 })
  if (authority.id !== request.requestId || authority.actorId !== user.id || authority.branchId !== request.branchId || authority.deviceId !== request.deviceId ||
    authority.shiftId !== request.shiftId || authority.invoiceRange.last - authority.invoiceRange.first + 1 !== request.count ||
    authority.maxInvoiceTotalFils !== request.maxInvoiceTotalFils || authority.maxGrossFils !== request.maxGrossFils ||
    canonicalJson(authority.permissions) !== canonicalJson(request.permissions) ||
    Date.parse(authority.expiresAt) - Date.parse(authority.issuedAt) !== request.lifetimeSeconds * 1000)
    throw new PosServerError('offline_storage_unavailable', 503)
  const snapshotEnvelope = await signEnvelope(draft.snapshot, keys.activeId, keys.privateKey)
  const authorityEnvelope = await signEnvelope(authority, keys.activeId, keys.privateKey)
  await verifyOfflineBundle(snapshotEnvelope, authorityEnvelope, keys.publicKeys)
  const result = await verifiedReader(await rpc('pos_offline_attach', {
    p_authority: authority.id, p_snapshot_envelope: snapshotEnvelope, p_authority_envelope: authorityEnvelope,
  }), keys)
  if (canonicalJson(result.bundle.authority) !== canonicalJson(authority) || canonicalJson(result.bundle.snapshot) !== canonicalJson(draft.snapshot))
    throw new PosServerError('offline_storage_unavailable', 503)
  return { snapshotEnvelope: result.row.snapshotEnvelope, authorityEnvelope: result.row.authorityEnvelope }
}

async function authenticateHistorical(raw: unknown, keys: OfflineServerKeys) {
  const envelope = signedEnvelopeSchema.parse(raw)
  let authorityId: string
  try { authorityId = z.object({ authorityId: offlineUuid }).passthrough().parse(parseCanonicalPayload(decodeBase64Url(envelope.payloadBase64Url))).authorityId }
  catch { throw new PosServerError('offline_payload_invalid', 422) }
  const rawRow = await rpc('pos_offline_authority', { p_id: authorityId })
  if (!rawRow) throw new PosServerError('offline_authority_unavailable', 404)
  const historical = await verifiedReader(rawRow, keys)
  if (historical.bundle.authority.id !== authorityId) throw new PosServerError('offline_storage_unavailable', 503)
  try {
    const verified = await verifySignedEnvelope(envelope, z.unknown(), { [historical.bundle.authority.deviceKeySha256]: historical.deviceKey })
    return { ...historical, ...verified, envelope }
  } catch { throw new PosServerError('offline_device_proof_invalid', 403) }
}

export async function importOfflineReceipt(raw: unknown) {
  // Deliberately no current actor/device membership or new-issuance flag: issued evidence survives revocation.
  const keys = await offlineServerKeys(), historical = await authenticateHistorical(raw, keys)
  let validated
  try { validated = validateHistoricalIssuance(historical.payload, historical.bundle) }
  catch {
    return storage(offlineExceptionSchema, await rpc('pos_offline_reject', {
      p_authority: historical.bundle.authority.id, p_envelope: historical.envelope, p_code: 'invalid_historical_receipt',
    }))
  }
  const issuance = validated.issuance
  const ack = offlineAckSchema.parse({ kind: 'offline-ack', schemaVersion: 1, id: randomUUID(), issuanceId: issuance.id,
    payloadSha256: historical.payloadSha256, authorityId: issuance.authorityId, keyEpoch: historical.bundle.authority.keyEpoch,
    deviceSequence: issuance.deviceSequence, receivedAt: new Date().toISOString() })
  const acknowledgement = await signEnvelope(ack, keys.activeId, keys.privateKey)
  const response = await rpc('pos_offline_import', { p_authority: issuance.authorityId, p_envelope: historical.envelope, p_ack_envelope: acknowledgement })
  const exception = offlineExceptionSchema.safeParse(response)
  if (exception.success) return exception.data
  const accepted = storage(z.object({ status: z.literal('accepted'), acknowledgement: signedEnvelopeSchema, receipt: z.unknown(), replayed: z.boolean() }).strict(), response)
  try {
    const { payload } = await verifySignedEnvelope(accepted.acknowledgement, offlineAckSchema, keys.publicKeys)
    if (payload.issuanceId !== issuance.id || payload.payloadSha256 !== historical.payloadSha256 || payload.authorityId !== issuance.authorityId ||
      payload.keyEpoch !== historical.bundle.authority.keyEpoch || payload.deviceSequence !== issuance.deviceSequence ||
      canonicalJson(accepted.receipt) !== canonicalJson(issuance.document)) throw new Error()
  } catch { throw new PosServerError('offline_acknowledgement_invalid', 503) }
  return accepted
}

export async function sealOfflineAuthority(raw: unknown) {
  const keys = await offlineServerKeys(), historical = await authenticateHistorical(raw, keys)
  const seal = offlineSealSchema.parse(historical.payload), authority = historical.bundle.authority
  if (seal.authorityId !== authority.id || seal.deviceId !== authority.deviceId || seal.keyEpoch !== authority.keyEpoch)
    throw new PosServerError('offline_device_proof_invalid', 403)
  const response = await rpc('pos_offline_seal', { p_authority: authority.id, p_final_sequence: seal.finalSequence,
    p_final_hash: seal.finalEventSha256, p_signed_evidence: historical.envelope })
  const result = storage(z.object({ status: z.literal('sealed'), authorityId: offlineUuid,
    finalSequence: z.number().int().nonnegative(), finalEventSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict(), response)
  if (result.authorityId !== seal.authorityId || result.finalSequence !== seal.finalSequence || result.finalEventSha256 !== seal.finalEventSha256)
    throw new PosServerError('offline_storage_unavailable', 503)
  return result
}
