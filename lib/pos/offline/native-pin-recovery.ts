import { z } from 'zod'
import { authenticatedPosClient, posClient, PosServerError } from '../server/client'
import { hashToken, requireDevice, requirePilot } from '../server/live-access'
import { loginSourceKey } from '../server/login-source'
import { offlineUuid } from './server-contracts'
import { signedEnvelopeSchema, type SignedEnvelope } from './contracts'
import { canonicalJson, decodeBase64Url, parseCanonicalPayload } from './canonical'
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
  oldCredentialSha256: hash,
  newCredentialSha256: hash,
}
export const nativePinRecoveryProofSchema = z
  .object({ ...identity, kind: z.literal('native-pin-recovery'), signedAt: timestamp })
  .strict()
  .refine((v) => v.oldCredentialSha256 !== v.newCredentialSha256)
export const nativePinRecoveryApprovalSchema = z
  .object({
    ...identity,
    kind: z.literal('native-pin-recovery-approval'),
    proofSha256: hash,
    approvedAt: timestamp,
  })
  .strict()
  .refine((v) => v.oldCredentialSha256 !== v.newCredentialSha256)
export const nativePinRecoveryRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('lookup'), proof: signedEnvelopeSchema }).strict(),
  z
    .object({
      mode: z.literal('approve'),
      proof: signedEnvelopeSchema,
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
    approval: nativePinRecoveryApprovalSchema,
    approvalEnvelope: signedEnvelopeSchema.nullable(),
  })
  .strict()
type Proof = z.infer<typeof nativePinRecoveryProofSchema>
type Stored = z.infer<typeof storedSchema>
function unavailable(): never {
  throw new PosServerError('pin_recovery_unavailable', 503)
}
export class PinRecoveryProofExpired extends PosServerError {
  constructor(
    readonly requestId: string,
    readonly proofSha256: string
  ) {
    super('pin_recovery_proof_expired', 409)
  }
}
function databaseFailure(message: string): never {
  if (['POS_ACCESS_DENIED', 'POS_DEVICE_INVALID'].includes(message))
    throw new PosServerError('device_binding_required', 403)
  if (message === 'POS_PIN_RECOVERY_CONFLICT')
    throw new PosServerError('pin_recovery_conflict', 409)
  if (message === 'POS_PIN_RECOVERY_CONFIRMATION_REQUIRED')
    throw new PosServerError('pin_recovery_confirmation_required', 401)
  return unavailable()
}
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await posClient(undefined, true).rpc(name, args)
  if (error) return databaseFailure(error.message)
  return data
}
function stored(raw: unknown, proof: Proof): Stored {
  const parsed = storedSchema.safeParse(raw)
  if (!parsed.success) return unavailable()
  const row = parsed.data
  for (const key of Object.keys(identity) as (keyof typeof identity)[])
    if (row.approval[key] !== proof[key]) return unavailable()
  if (Date.parse(row.approval.approvedAt) > Date.now()) return unavailable()
  return row
}
async function verifyStoredEnvelope(row: Stored, keys: OfflineServerKeys): Promise<SignedEnvelope> {
  if (!row.approvalEnvelope) return unavailable()
  try {
    const verified = await verifySignedEnvelope(
      row.approvalEnvelope,
      nativePinRecoveryApprovalSchema,
      keys.publicKeys
    )
    if (canonicalJson(verified.payload) !== canonicalJson(row.approval)) return unavailable()
    return row.approvalEnvelope
  } catch {
    return unavailable()
  }
}
async function finishApproval(raw: unknown, proof: Proof, keys?: OfflineServerKeys) {
  const row = stored(raw, proof)
  keys ??= await offlineServerKeys()
  if (row.approvalEnvelope)
    return { status: 'approved' as const, approval: await verifyStoredEnvelope(row, keys) }
  const envelope = await signEnvelope(row.approval, keys.activeId, keys.privateKey)
  await verifySignedEnvelope(envelope, nativePinRecoveryApprovalSchema, keys.publicKeys)
  const attached = stored(
    await rpc('pos_native_pin_recovery_attach', {
      p_request: proof.requestId,
      p_envelope: envelope,
    }),
    proof
  )
  if (canonicalJson(attached.approval) !== canonicalJson(row.approval)) return unavailable()
  return { status: 'approved' as const, approval: await verifyStoredEnvelope(attached, keys) }
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
export async function nativePinRecovery(http: Request, raw: unknown) {
  const request = nativePinRecoveryRequestSchema.parse(raw)
  let hint: Proof
  try {
    hint = nativePinRecoveryProofSchema.parse(
      parseCanonicalPayload(decodeBase64Url(request.proof.payloadBase64Url, 4096))
    )
  } catch {
    throw new PosServerError('invalid_pin_recovery_proof', 422)
  }
  const context = contextSchema.safeParse(
    await rpc('pos_native_pin_recovery_context', { p_epoch: hint.keyEpoch })
  )
  if (!context.success) throw new PosServerError('invalid_pin_recovery_proof', 422)
  const row = context.data
  let verified: { payload: Proof; payloadSha256: string }
  try {
    const key = await importOfflinePublicKey(row.publicKeySpki)
    if ((await publicKeyFingerprint(key)) !== row.deviceKeySha256) throw new Error()
    verified = await verifySignedEnvelope(request.proof, nativePinRecoveryProofSchema, {
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
    throw new PosServerError('invalid_pin_recovery_proof', 422)
  }
  const proof = verified.payload
  const existing = await rpc('pos_native_pin_recovery_lookup', { p_proof: request.proof })
  if (existing !== null) return finishApproval(existing, proof)
  if (request.mode === 'lookup') return { status: 'not_found' as const }
  requirePilot()
  const { client, user } = await authenticatedPosClient()
  if (user.id !== proof.actorId)
    throw new PosServerError('pin_recovery_original_staff_required', 403)
  const binding = await requireDevice(client, proof.branchId, proof.deviceId, user.id)
  const keys = await offlineServerKeys() // Check signer before accepting a new credential generation.
  const confirmedAt = await confirmOriginalStaff(http, user, request.password)
  const { data, error } = await posClient(undefined, true).rpc('pos_native_pin_recovery_approve', {
    p_actor: user.id,
    p_binding: binding,
    p_proof: request.proof,
    p_confirmed_at: confirmedAt,
  })
  // Only this locked SQL outcome proves this exact proof was not accepted. A
  // timeout, generic conflict or failed lookup can never authorize native refresh.
  if (error?.message === 'POS_PIN_RECOVERY_PROOF_EXPIRED')
    throw new PinRecoveryProofExpired(proof.requestId, verified.payloadSha256)
  if (error) return databaseFailure(error.message)
  return finishApproval(data, proof, keys)
}
