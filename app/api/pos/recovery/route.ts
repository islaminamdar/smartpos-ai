import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requirePilot, requireOrigin, requireDevice } from '@/lib/pos/server/live-access'
import { readBoundedBody } from '@/lib/pos/server/body'
import { liveRecoverySchema } from '@/lib/pos/server/live-contracts'
import { fiscalDocumentSchema } from '@/lib/pos/server/documents'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requirePilot(); requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    const parsed = liveRecoverySchema.safeParse(JSON.parse(await readBoundedBody(request, 100_000)))
    if (!parsed.success) throw new PosServerError('invalid_recovery_request', 422)
    const payload = parsed.data.request
    const binding = await requireDevice(client, payload.branchId, payload.deviceId, user.id)
    const { data, error } = await client.rpc('pos_resolve_live_request', { p_kind: parsed.data.kind, p_request: payload, p_binding: binding })
    if (error) {
      const conflict = error.message.includes('POS_IDEMPOTENCY_CONFLICT')
      const denied = ['POS_ACCESS_DENIED','POS_DEVICE_INVALID'].some(code => error.message.includes(code))
      throw new PosServerError(conflict ? 'POS_IDEMPOTENCY_CONFLICT' : denied ? 'device_binding_required' : 'recovery_unavailable', conflict ? 409 : denied ? 403 : 503)
    }
    const cancelled = data?.status === 'cancelled' && data.requestId === payload.id && data.kind === parsed.data.kind
    const sale = parsed.data.kind === 'sale' && data?.status === 'synced' && data.orderId === payload.id && fiscalDocumentSchema.safeParse(data.receipt).success
    const command = parsed.data.kind === 'command' && data?.status === 'applied' && data.commandId === payload.id && (parsed.data.request.type !== 'refund.full' || fiscalDocumentSchema.safeParse(data.creditNote).success)
    if (!cancelled && !sale && !command) throw new PosServerError('invalid_recovery_acknowledgement', 503)
    return NextResponse.json(data, { headers: privateHeaders })
  } catch (error) { return posFailure(error) }
}
