import { z } from 'zod'
import { authenticatedPosClient, posClient, PosServerError } from '../server/client'
import { nativeAccess } from '../server/native-access'
import { requireDevice } from '../server/live-access'
import { requireNativePreparationEnabled } from './native-preparation'
import { offlineServerKeys, importOfflinePublicKey } from './server-keys'
import { signEnvelope, verifySignedEnvelope, verifyOfflineBundle, publicKeyFingerprint } from './authority'
import { canonicalBytes, sha256Hex } from './canonical'
import { signedEnvelopeSchema } from './contracts'
import { offlineUuid, offlineSealSchema } from './server-contracts'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const nativeContinuationRequestSchema = z.object({ challenge: hash, authorityId: offlineUuid, sealSha256: hash }).strict()
const scope = { actorId: offlineUuid, organizationId: offlineUuid, branchId: offlineUuid, deviceId: offlineUuid,
  shiftId: offlineUuid, keyEpoch: offlineUuid, deviceKeySha256: hash, nextShiftId: offlineUuid.nullable() }
export const nativeContinuationSchema = z.object({ ...scope, kind: z.literal('native-offline-continuation'),
  schemaVersion: z.literal(1), purpose: z.literal('prepare-next'), challenge: hash,
  serverTimeMs: z.number().int().nonnegative().max(253_402_300_799_999), priorAuthorityId: offlineUuid, sealSha256: hash,
}).strict().refine(value => value.nextShiftId === null || value.nextShiftId === value.shiftId)
const storedSchema = z.object({ ...scope, snapshotEnvelope: signedEnvelopeSchema, authorityEnvelope: signedEnvelopeSchema,
  sealEnvelope: signedEnvelopeSchema, publicKeySpki: z.string().max(342),
}).strict()
function unavailable(): never { throw new PosServerError('offline_continuation_unavailable', 503) }

/** Permission to retire a local preparation pointer only. No new authority, shift,
 * invoice number, clock anchor, financial command or PIN credential is created. */
export async function nativeOfflineContinuation(raw: unknown) {
  requireNativePreparationEnabled()
  const request = nativeContinuationRequestSchema.parse(raw)
  const access = await nativeAccess(), { client, user } = await authenticatedPosClient()
  if (!access.device || user.id !== access.actorId) throw new PosServerError('device_binding_required', 403)
  await requireDevice(client, access.device.branchId, access.device.id, user.id)
  const { data, error } = await posClient(undefined, true).rpc('pos_offline_continuation_context', {
    p_actor: user.id, p_device: access.device.id, p_authority: request.authorityId, p_seal_hash: request.sealSha256,
  })
  if (error) {
    if (['POS_ACCESS_DENIED', 'POS_DEVICE_INVALID'].includes(error.message)) throw new PosServerError('access_denied', 403)
    if (['POS_SHIFT_INVALID', 'POS_OFFLINE_SEAL_REQUIRED', 'POS_OFFLINE_UNSEALED_AUTHORITY',
      'POS_OFFLINE_PAYMENT_HOLD', 'POS_OFFLINE_CHAIN_INCOMPLETE'].includes(error.message))
      throw new PosServerError('offline_continuation_blocked', 409)
    return unavailable()
  }
  const parsed = storedSchema.safeParse(data)
  if (!parsed.success) return unavailable()
  const row = parsed.data, keys = await offlineServerKeys()
  try {
    const bundle = await verifyOfflineBundle(row.snapshotEnvelope, row.authorityEnvelope, keys.publicKeys), a = bundle.authority
    const deviceKey = await importOfflinePublicKey(row.publicKeySpki)
    if (await publicKeyFingerprint(deviceKey) !== a.deviceKeySha256 || a.id !== request.authorityId ||
      a.actorId !== user.id || a.deviceId !== access.device.id || a.branchId !== access.device.branchId ||
      !access.branches.some(b => b.id === a.branchId && b.organizationId === a.organizationId) ||
      (row.nextShiftId !== null && row.nextShiftId !== a.shiftId)) return unavailable()
    for (const field of ['actorId', 'organizationId', 'branchId', 'deviceId', 'shiftId', 'keyEpoch', 'deviceKeySha256'] as const)
      if (row[field] !== a[field]) return unavailable()
    const { payload: seal } = await verifySignedEnvelope(row.sealEnvelope, offlineSealSchema, { [a.deviceKeySha256]: deviceKey })
    if (seal.authorityId !== a.id || seal.deviceId !== a.deviceId || seal.keyEpoch !== a.keyEpoch ||
      await sha256Hex(canonicalBytes(seal)) !== request.sealSha256) return unavailable()
  } catch { return unavailable() }
  const payload = nativeContinuationSchema.parse({ kind: 'native-offline-continuation', schemaVersion: 1,
    purpose: 'prepare-next', challenge: request.challenge, serverTimeMs: Date.now(), priorAuthorityId: request.authorityId,
    sealSha256: request.sealSha256, ...Object.fromEntries(Object.keys(scope).map(key => [key, row[key as keyof typeof scope]])) })
  const handoff = await signEnvelope(payload, keys.activeId, keys.privateKey)
  await verifySignedEnvelope(handoff, nativeContinuationSchema, keys.publicKeys)
  return { handoff }
}
