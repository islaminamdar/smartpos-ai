import { z } from 'zod'
import { authenticatedPosClient, PosServerError } from '../server/client'
import { requireDevice, requirePilot } from '../server/live-access'
import { nativeAccess } from '../server/native-access'
import { signEnvelope, verifyOfflineBundle } from './authority'
import { canonicalJson } from './canonical'
import { offlineServerKeys } from './server-keys'
import { offlineUuid, reserveRequestSchema } from './server-contracts'
import { reserveOfflineAuthority } from './server'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const serverTimeMs = z.number().int().nonnegative().max(253_402_300_799_999)
export const nativePreparationRequestSchema = z.object({ challenge: hash, branchId: offlineUuid, deviceId: offlineUuid }).strict()
export const nativePrepareRequestSchema = z.object({ challenge: hash, reservation: reserveRequestSchema }).strict()
const handoffScope = { schemaVersion: z.literal(1), challenge: hash, serverTimeMs, actorId: offlineUuid,
  organizationId: offlineUuid, branchId: offlineUuid, deviceId: offlineUuid }
export const nativeOfflineContextSchema = z.object({ ...handoffScope, kind: z.literal('native-offline-context'), shiftId: offlineUuid.nullable() }).strict()
export const nativeOfflinePreparedSchema = z.object({ ...handoffScope, kind: z.literal('native-offline-prepared'), shiftId: offlineUuid,
  keyEpoch: offlineUuid, deviceKeySha256: hash, authorityId: offlineUuid, snapshotSha256: hash, authoritySha256: hash }).strict()

// Exact SQL004 output; accepting malformed or ambiguous summaries must not choose a shift.
const shiftsSchema = z.array(z.object({ id: offlineUuid, branchId: offlineUuid, deviceId: offlineUuid, openedBy: offlineUuid,
  openedAt: z.string().datetime({ offset: true }), openingCashFils: z.number().int().nonnegative().safe(),
  expectedCashFils: z.number().int().safe() }).strict()).max(10_000)

export function requireNativePreparationEnabled() {
  requirePilot(true)
  if (process.env.POS_OFFLINE_ISSUANCE_ENABLED !== 'true') throw new PosServerError('offline_issuance_not_enabled', 503)
}

async function currentScope(branchId: string, deviceId: string) {
  const access = await nativeAccess()
  const branch = access.branches.find(row => row.id === branchId)
  if (!branch || !access.device || access.device.id !== deviceId || access.device.branchId !== branchId)
    throw new PosServerError('device_binding_required', 403)
  const { client, user } = await authenticatedPosClient()
  if (user.id !== access.actorId) throw new PosServerError('access_denied', 403)
  await requireDevice(client, branchId, deviceId, user.id)
  const result = await client.rpc('pos_open_shift_summaries')
  const parsed = shiftsSchema.safeParse(result.data)
  if (result.error || !parsed.success) throw new PosServerError('native_preparation_unavailable', 503)
  const own = parsed.data.filter(row => row.branchId === branchId && row.deviceId === deviceId && row.openedBy === user.id)
  if (own.length > 1) throw new PosServerError('native_preparation_unavailable', 503)
  return { actorId: user.id, organizationId: branch.organizationId, branchId, deviceId, shiftId: own[0]?.id ?? null }
}

/** Signed challenge response only; never opens/closes a financial shift. */
export async function nativeOfflineContext(raw: unknown) {
  requireNativePreparationEnabled()
  const request = nativePreparationRequestSchema.parse(raw)
  const scope = await currentScope(request.branchId, request.deviceId), keys = await offlineServerKeys()
  const payload = nativeOfflineContextSchema.parse({ kind: 'native-offline-context', schemaVersion: 1,
    challenge: request.challenge, serverTimeMs: Date.now(), ...scope })
  return { handoff: await signEnvelope(payload, keys.activeId, keys.privateKey) }
}

/** Fresh handoff challenge is independent of the durable reservation request identity. */
export async function prepareNativeOffline(raw: unknown) {
  requireNativePreparationEnabled()
  const request = nativePrepareRequestSchema.parse(raw), reservation = request.reservation
  const scope = await currentScope(reservation.branchId, reservation.deviceId)
  if (!scope.shiftId || scope.shiftId !== reservation.shiftId) throw new PosServerError('native_shift_required', 409)
  const keys = await offlineServerKeys()
  const envelopes = await reserveOfflineAuthority(reservation)
  let bundle
  try {
    bundle = await verifyOfflineBundle(envelopes.snapshotEnvelope, envelopes.authorityEnvelope, keys.publicKeys)
    const a = bundle.authority
    if (a.organizationId !== scope.organizationId || a.branchId !== scope.branchId || a.deviceId !== scope.deviceId ||
      a.actorId !== scope.actorId || a.shiftId !== scope.shiftId || a.id !== reservation.requestId ||
      a.invoiceRange.last - a.invoiceRange.first + 1 !== reservation.count || a.maxInvoiceTotalFils !== reservation.maxInvoiceTotalFils ||
      a.maxGrossFils !== reservation.maxGrossFils || canonicalJson(a.permissions) !== canonicalJson(reservation.permissions) ||
      Date.parse(a.expiresAt) - Date.parse(a.issuedAt) !== reservation.lifetimeSeconds * 1000) throw new Error()
  } catch { throw new PosServerError('offline_storage_unavailable', 503) }
  // Read AFTER reservation and signature verification; a replay gets fresh server time
  // without extending the original signed authority's expiry or reserving another range.
  const payload = nativeOfflinePreparedSchema.parse({ kind: 'native-offline-prepared', schemaVersion: 1,
    challenge: request.challenge, serverTimeMs: Date.now(), ...scope, keyEpoch: bundle.authority.keyEpoch,
    deviceKeySha256: bundle.authority.deviceKeySha256, authorityId: bundle.authority.id,
    snapshotSha256: bundle.snapshotSha256, authoritySha256: bundle.authoritySha256 })
  return { ...envelopes, handoff: await signEnvelope(payload, keys.activeId, keys.privateKey) }
}
