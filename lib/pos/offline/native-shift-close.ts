import { z } from 'zod'
import { authenticatedPosClient, PosServerError } from '../server/client'
import { requirePilot, requireDevice, recoveryBinding } from '../server/live-access'
import { offlineUuid } from './server-contracts'
import { offlineServerKeys } from './server-keys'
import { signEnvelope, verifySignedEnvelope } from './authority'
import { canonicalBytes, sha256Hex } from './canonical'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const counted = z.number().int().min(0).max(100_000_000)
const signedFils = z.number().int().safe()
export const nativeShiftCloseCommandSchema = z.object({ id: offlineUuid, type: z.literal('shift.close'),
  branchId: offlineUuid, deviceId: offlineUuid, shiftId: offlineUuid, countedCashFils: counted }).strict()
export const nativeShiftCloseRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('context'), challenge: hash, branchId: offlineUuid, deviceId: offlineUuid, shiftId: offlineUuid }).strict(),
  z.object({ mode: z.literal('lookup'), challenge: hash, command: nativeShiftCloseCommandSchema }).strict(),
  z.object({ mode: z.literal('execute'), challenge: hash, command: nativeShiftCloseCommandSchema }).strict(),
])
const scope = { actorId: offlineUuid, organizationId: offlineUuid, branchId: offlineUuid, deviceId: offlineUuid, shiftId: offlineUuid }
const fresh = { schemaVersion: z.literal(1), purpose: z.literal('close-shift'), challenge: hash,
  serverTimeMs: z.number().int().min(0).max(253_402_300_799_999) }
export const nativeShiftCloseResultSchema = z.object({ commandId: offlineUuid, shiftId: offlineUuid,
  countedCashFils: counted, expectedCashFils: signedFils, cashDifferenceFils: signedFils,
  closedAt: z.string().datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
}).strict().refine(v => Number.isSafeInteger(v.countedCashFils - v.expectedCashFils) && v.cashDifferenceFils === v.countedCashFils - v.expectedCashFils)
const reason = z.enum(['offline_allocation_active','payment_reconciliation_required','offline_upload_required','shift_close_unavailable','shift_already_closed']).nullable()
const contextRow = z.object({ ...scope, status: z.enum(['open','closed']), canClose: z.boolean(), reasonCode: reason }).strict()
const contextConsistent = (v: z.infer<typeof contextRow>) => v.status === 'closed'
  ? !v.canClose && v.reasonCode === 'shift_already_closed'
  : v.canClose ? v.reasonCode === null : v.reasonCode !== null && v.reasonCode !== 'shift_already_closed'
export const nativeShiftCloseContextSchema = contextRow.extend({ ...fresh, kind: z.literal('native-shift-close-context') }).refine(contextConsistent)
const outcomeRow = z.object({ ...scope, commandId: offlineUuid, countedCashFils: counted,
  status: z.enum(['applied','not_found','cancelled']), result: nativeShiftCloseResultSchema.nullable() }).strict()
const resultConsistent = (v: z.infer<typeof outcomeRow>) => v.status !== 'applied' ? v.result === null
  : v.result !== null && v.result.commandId === v.commandId && v.result.shiftId === v.shiftId && v.result.countedCashFils === v.countedCashFils
export const nativeShiftCloseOutcomeSchema = outcomeRow.extend({ ...fresh, kind: z.literal('native-shift-close-result'), requestSha256: hash }).refine(resultConsistent)
function failure(message = 'native_shift_close_unavailable', status = 503): never { throw new PosServerError(message, status) }
function databaseFailure(message: string): never {
  if (['POS_ACCESS_DENIED','POS_DEVICE_INVALID','POS_SHIFT_INVALID'].some(code => message.includes(code))) return failure('device_binding_required',403)
  if (['POS_IDEMPOTENCY_CONFLICT','POS_REQUEST_CANCELLED','POS_SHIFT_CLOSED','POS_OFFLINE_PAYMENT_HOLD','POS_OFFLINE_CHAIN_INCOMPLETE'].some(code => message.includes(code))) return failure('native_shift_close_pending',409)
  return failure()
}

/** Exact committed lookup never executes or cancels a missing command. Execute
 * retains the existing bound transaction and obtains its immutable result anew. */
export async function nativeShiftClose(raw: unknown) {
  const request = nativeShiftCloseRequestSchema.parse(raw)
  if (request.mode !== 'lookup') requirePilot(request.mode === 'execute')
  const { client, user } = await authenticatedPosClient()
  const keys = await offlineServerKeys() // Validate signer before any financial write.
  const timing = () => ({ schemaVersion: 1 as const, purpose: 'close-shift' as const, challenge: request.challenge, serverTimeMs: Date.now() })
  if (request.mode === 'context') {
    const binding = await requireDevice(client, request.branchId, request.deviceId, user.id)
    const { data, error } = await client.rpc('pos_native_shift_close_context', { p_branch: request.branchId, p_device: request.deviceId, p_shift: request.shiftId, p_binding: binding })
    if (error) return databaseFailure(error.message)
    const parsed = contextRow.safeParse(data)
    if (!parsed.success || !contextConsistent(parsed.data)) return failure()
    const row = parsed.data
    if (row.actorId !== user.id || row.branchId !== request.branchId || row.deviceId !== request.deviceId || row.shiftId !== request.shiftId) return failure()
    if (row.status === 'open' && process.env.POS_LIVE_SALES_ENABLED !== 'true') { row.canClose = false; row.reasonCode = 'shift_close_unavailable' }
    const payload = nativeShiftCloseContextSchema.parse({ ...row, ...timing(), kind: 'native-shift-close-context' })
    const handoff = await signEnvelope(payload, keys.activeId, keys.privateKey)
    await verifySignedEnvelope(handoff, nativeShiftCloseContextSchema, keys.publicKeys)
    return { handoff }
  }
  const command = request.command
  const binding = request.mode === 'execute'
    ? await requireDevice(client, command.branchId, command.deviceId, user.id)
    : await recoveryBinding(user.id)
  if (request.mode === 'execute') {
    const { error } = await client.rpc('pos_execute_live_command', { p_command: command, p_binding: binding })
    if (error) return databaseFailure(error.message)
  }
  const { data, error } = await client.rpc('pos_native_shift_close_lookup', { p_command: command, p_binding: binding })
  if (error) return databaseFailure(error.message)
  const parsed = outcomeRow.safeParse(data)
  if (!parsed.success || !resultConsistent(parsed.data)) return failure()
  const row = parsed.data
  if (row.actorId !== user.id || row.branchId !== command.branchId || row.deviceId !== command.deviceId || row.shiftId !== command.shiftId ||
    row.commandId !== command.id || row.countedCashFils !== command.countedCashFils || (request.mode === 'execute' && row.status !== 'applied')) return failure()
  const payload = nativeShiftCloseOutcomeSchema.parse({ ...row, ...timing(), kind: 'native-shift-close-result', requestSha256: await sha256Hex(canonicalBytes(command)) })
  const handoff = await signEnvelope(payload, keys.activeId, keys.privateKey)
  await verifySignedEnvelope(handoff, nativeShiftCloseOutcomeSchema, keys.publicKeys)
  return { handoff }
}
