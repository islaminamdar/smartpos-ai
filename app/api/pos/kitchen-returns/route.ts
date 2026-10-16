import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requireDevice, requireOrigin, requirePilot } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { readBoundedBody } from '@/lib/pos/server/body'
import {
  kitchenReturnQuerySchema,
  kitchenReturnListSchema,
  kitchenReturnAckSchema,
  kitchenReturnAckResultSchema,
} from '@/lib/pos/server/kitchen-returns'
export const dynamic = 'force-dynamic'
function rpcError(message: string): never {
  const code = [
    'POS_ACCESS_DENIED',
    'POS_DEVICE_INVALID',
    'POS_ORDER_UNAVAILABLE',
    'POS_INVALID_KITCHEN_CURSOR',
    'POS_KITCHEN_LIMIT',
  ].find((c) => message.includes(c))
  throw new PosServerError(
    code ?? 'storage_unavailable',
    code === 'POS_ACCESS_DENIED' || code === 'POS_DEVICE_INVALID'
      ? 403
      : code === 'POS_ORDER_UNAVAILABLE'
        ? 404
        : code === 'POS_INVALID_KITCHEN_CURSOR'
          ? 422
          : 503
  )
}
export async function GET(request: Request) {
  try {
    requirePilot()
    const { client, user } = await authenticatedPosClient()
    const params = new URL(request.url).searchParams
    const parsed = kitchenReturnQuerySchema.safeParse(Object.fromEntries(params))
    if (!parsed.success || [...params.keys()].length !== new Set(params.keys()).size)
      throw new PosServerError('invalid_query', 422)
    const q = parsed.data
    const binding = await requireDevice(client, q.branchId, q.deviceId, user.id)
    const { data, error } = await client.rpc('pos_list_kitchen_returns', {
      p_branch: q.branchId,
      p_binding: binding,
      p_cursor: q.afterId ? { issuedAt: q.afterIssuedAt, id: q.afterId } : null,
    })
    if (error) rpcError(error.message)
    const result = kitchenReturnListSchema.parse(data)
    if (result.branchId !== q.branchId) throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
export async function POST(request: Request) {
  try {
    requirePilot()
    requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    if (request.headers.get('x-pos-actor') !== user.id)
      throw new PosServerError('account_changed', 409)
    const parsed = kitchenReturnAckSchema.safeParse(
      JSON.parse(await readBoundedBody(request, 1024))
    )
    if (!parsed.success) throw new PosServerError('invalid_request', 422)
    const q = parsed.data
    const binding = await requireDevice(client, q.branchId, q.deviceId, user.id)
    const { data, error } = await client.rpc('pos_acknowledge_kitchen_return', {
      p_branch: q.branchId,
      p_device: q.deviceId,
      p_notice: q.noticeId,
      p_binding: binding,
    })
    if (error) rpcError(error.message)
    const result = kitchenReturnAckResultSchema.parse(data)
    if (result.branchId !== q.branchId || result.noticeId !== q.noticeId)
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
