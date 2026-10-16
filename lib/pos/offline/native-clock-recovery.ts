import { z } from 'zod'
import { authenticatedPosClient, posClient, PosServerError } from '../server/client'
import { hashToken, requireDevice, requirePilot } from '../server/live-access'
import { loginSourceKey } from '../server/login-source'
import { offlineUuid } from './server-contracts'
import { signedEnvelopeSchema, type SignedEnvelope } from './contracts'
import {
  canonicalBytes,
  canonicalJson,
  decodeBase64Url,
  parseCanonicalPayload,
  sha256Hex,
} from './canonical'
import { publicKeyFingerprint, signEnvelope, verifySignedEnvelope } from './authority'
import { importOfflinePublicKey, offlineServerKeys, type OfflineServerKeys } from './server-keys'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const timestamp = z
  .string()
  .datetime()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
const identity = {
  schemaVersion: z.literal(1),
  requestId: offlineUuid,
  organizationId: offlineUuid,
  branchId: offlineUuid,
  deviceId: offlineUuid,
  actorId: offlineUuid,
  keyEpoch: offlineUuid,
  deviceKeySha256: hash,
  installationId: offlineUuid,
  oldClockGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  oldClockSha256: hash,
  retirementSha256: hash,
}
export const nativeClockRecoveryProofSchema = z
  .object({ ...identity, kind: z.literal('native-clock-recovery') })
  .strict()
export const nativeClockRecoveryApprovalSchema = z
  .object({
    ...identity,
    kind: z.literal('native-clock-recovery-approval'),
    proofSha256: hash,
    approvedAt: timestamp,
  })
  .strict()
export const nativeClockRecoveryRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('lookup'), proof: signedEnvelopeSchema, challenge: hash }).strict(),
  z
    .object({
      mode: z.literal('approve'),
      proof: signedEnvelopeSchema,
      challenge: hash,
      password: z.string().min(1).max(256),
    })
    .strict(),
])
const contextSchema = z
  .object({
    organizationId: offlineUuid,
    branchId: offlineUuid,
    deviceId: offlineUuid,
    keyEpoch: offlineUuid,
    deviceKeySha256: hash,
    publicKeySpki: z.string().min(1).max(342),
  })
  .strict()
const storedSchema = z
  .object({
    approval: nativeClockRecoveryApprovalSchema,
    approvalEnvelope: signedEnvelopeSchema.nullable(),
  })
  .strict()
type Proof = z.infer<typeof nativeClockRecoveryProofSchema>
type Stored = z.infer<typeof storedSchema>
function unavailable(): never {
  throw new PosServerError('clock_recovery_unavailable', 503)
}
function databaseFailure(message: string): never {
  if (['POS_ACCESS_DENIED', 'POS_DEVICE_INVALID'].includes(message))
    throw new PosServerError('device_binding_required', 403)
  if (message === 'POS_CLOCK_RECOVERY_CONFLICT')
    throw new PosServerError('clock_recovery_conflict', 409)
  if (message === 'POS_CLOCK_RECOVERY_CONFIRMATION_REQUIRED')
    throw new PosServerError('clock_recovery_confirmation_required', 401)
  return unavailable()
}
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await posClient(undefined, true).rpc(name, args)
  if (error) return databaseFailure(error.message)
  return data
}
function stored(raw: unknown, proof: Proof, proofSha256: string): Stored {
  const parsed = storedSchema.safeParse(raw)
  if (!parsed.success) return unavailable()
  const row = parsed.data
  for (const key of Object.keys(identity) as (keyof typeof identity)[])
    if (row.approval[key] !== proof[key]) return unavailable()
  if (row.approval.proofSha256 !== proofSha256) return unavailable()
  if (Date.parse(row.approval.approvedAt) > Date.now()) return unavailable()
  return row
}
async function verifyStoredEnvelope(row: Stored, keys: OfflineServerKeys): Promise<SignedEnvelope> {
  if (!row.approvalEnvelope) return unavailable()
  try {
    const verified = await verifySignedEnvelope(
      row.approvalEnvelope,
      nativeClockRecoveryApprovalSchema,
      keys.publicKeys
    )
    if (canonicalJson(verified.payload) !== canonicalJson(row.approval)) return unavailable()
    return row.approvalEnvelope
  } catch {
    return unavailable()
  }
}
export const nativeClockRecoveryTimeSchema = z
  .object({
    kind: z.literal('native-clock-recovery-time'),
    schemaVersion: z.literal(1),
    requestId: offlineUuid,
    approvalSha256: hash,
    retirementSha256: hash,
    oldClockGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    challenge: hash,
    serverTimeMs: z.number().int().min(0).max(253_402_300_799_999),
  })
  .strict()

async function finishApproval(
  raw: unknown,
  proof: Proof,
  proofSha256: string,
  challenge: string,
  keys?: OfflineServerKeys
) {
  let row = stored(raw, proof, proofSha256)
  keys ??= await offlineServerKeys()
  if (!row.approvalEnvelope) {
    const envelope = await signEnvelope(row.approval, keys.activeId, keys.privateKey)
    await verifySignedEnvelope(envelope, nativeClockRecoveryApprovalSchema, keys.publicKeys)
    const attached = stored(
      await rpc('pos_native_clock_recovery_attach', {
        p_request: proof.requestId,
        p_envelope: envelope,
      }),
      proof,
      proofSha256
    )
    if (canonicalJson(attached.approval) !== canonicalJson(row.approval)) return unavailable()
    row = attached
  }
  const approval = await verifyStoredEnvelope(row, keys)
  // Immutable authorization is deliberately separate from this fresh nonce-bound
  // time. A retry cannot reuse approvedAt to re-anchor the local clock.
  const timing = nativeClockRecoveryTimeSchema.parse({
    kind: 'native-clock-recovery-time',
    schemaVersion: 1,
    requestId: proof.requestId,
    approvalSha256: await sha256Hex(canonicalBytes(row.approval)),
    retirementSha256: proof.retirementSha256,
    oldClockGeneration: proof.oldClockGeneration,
    challenge,
    serverTimeMs: Date.now(),
  })
  const time = await signEnvelope(timing, keys.activeId, keys.privateKey)
  await verifySignedEnvelope(time, nativeClockRecoveryTimeSchema, keys.publicKeys)
  return { status: 'approved' as const, approval, time }
}

/** The password is transient Auth input only. Revoke only the temporary session,
 * and never send a password, access token or caller timestamp to the recovery RPC. */
async function confirmOriginalStaff(
  http: Request,
  user: { id: string; email?: string },
  password: string
) {
  const email = user.email?.trim().toLowerCase()
  if (!email) throw new PosServerError('authentication_required', 401)
  const allowed = await rpc('pos_login_attempt', {
    p_key: hashToken(email),
    p_source: loginSourceKey(http),
  })
  if (allowed === false) throw new PosServerError('login_rate_limited', 429)
  if (allowed !== true) return unavailable()
  const result = await posClient().auth.signInWithPassword({ email, password })
  const confirmedAt = new Date().toISOString()
  const token = result.data.session?.access_token
  const correct = !result.error && !!token && result.data.user?.id === user.id
  if (token) {
    const revoked = await posClient(undefined, true)
      .auth.admin.signOut(token, 'local')
      .catch(() => ({ error: true }))
    if (revoked.error) return unavailable()
  }
  if (!correct) throw new PosServerError('current_password_incorrect', 401)
  return confirmedAt
}

/** Historical device signatures authorize exact retrieval only. A new grant also
 * needs the original current account, its password and current device binding. */
export async function nativeClockRecovery(http: Request, raw: unknown) {
  const request = nativeClockRecoveryRequestSchema.parse(raw)
  let hint: Proof
  try {
    hint = nativeClockRecoveryProofSchema.parse(
      parseCanonicalPayload(decodeBase64Url(request.proof.payloadBase64Url, 4096))
    )
  } catch {
    throw new PosServerError('invalid_clock_recovery_proof', 422)
  }
  const context = contextSchema.safeParse(
    await rpc('pos_native_clock_recovery_context', { p_epoch: hint.keyEpoch })
  )
  if (!context.success) throw new PosServerError('invalid_clock_recovery_proof', 422)
  const row = context.data
  let verified: { payload: Proof; payloadSha256: string }
  try {
    const key = await importOfflinePublicKey(row.publicKeySpki)
    if ((await publicKeyFingerprint(key)) !== row.deviceKeySha256) throw new Error()
    verified = await verifySignedEnvelope(request.proof, nativeClockRecoveryProofSchema, {
      [row.deviceKeySha256]: key,
    })
    for (const key of [
      'organizationId',
      'branchId',
      'deviceId',
      'keyEpoch',
      'deviceKeySha256',
    ] as const)
      if (verified.payload[key] !== row[key]) throw new Error()
  } catch {
    throw new PosServerError('invalid_clock_recovery_proof', 422)
  }
  const proof = verified.payload
  const existing = await rpc('pos_native_clock_recovery_lookup', { p_proof: request.proof })
  if (existing !== null)
    return finishApproval(existing, proof, verified.payloadSha256, request.challenge)
  if (request.mode === 'lookup') return { status: 'not_found' as const }
  requirePilot()
  const { client, user } = await authenticatedPosClient()
  if (user.id !== proof.actorId)
    throw new PosServerError('clock_recovery_original_staff_required', 403)
  const binding = await requireDevice(client, proof.branchId, proof.deviceId, user.id)
  const keys = await offlineServerKeys() // Check signer before authorizing retirement and a clock generation change.
  const confirmedAt = await confirmOriginalStaff(http, user, request.password)
  const { data, error } = await posClient(undefined, true).rpc(
    'pos_native_clock_recovery_approve',
    {
      p_actor: user.id,
      p_binding: binding,
      p_proof: request.proof,
      p_confirmed_at: confirmedAt,
    }
  )
  if (error) return databaseFailure(error.message)
  return finishApproval(data, proof, verified.payloadSha256, request.challenge, keys)
}
