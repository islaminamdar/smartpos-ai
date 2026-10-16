import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requirePilot, requireOrigin, requireDevice } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { kitchenListSchema, kitchenQuerySchema } from '@/lib/pos/server/kitchen'
import { kitchenBody, kitchenResult, kitchenRpcError } from '@/lib/pos/server/kitchen-http'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    requirePilot()
    const { client, user } = await authenticatedPosClient()
    const params = new URL(request.url).searchParams
    const parsed = kitchenQuerySchema.safeParse(Object.fromEntries(params))
    if (!parsed.success || [...params.keys()].length !== new Set(params.keys()).size)
      throw new PosServerError('invalid_query', 422)
    const query = parsed.data
    const binding = await requireDevice(client, query.branchId, query.deviceId, user.id)
    const { data, error } = await client.rpc('pos_list_kitchen', {
      p_branch: query.branchId,
      p_binding: binding,
      p_cursor: query.afterIssuedAt
        ? { issuedAt: query.afterIssuedAt, orderId: query.afterOrderId }
        : null,
    })
    if (error) kitchenRpcError(error.message)
    const result = kitchenListSchema.parse(data)
    if (result.branchId !== query.branchId) throw new PosServerError('confirmation_mismatch', 503)
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
    const command = await kitchenBody(request)
    const binding = await requireDevice(client, command.branchId, command.deviceId, user.id)
    const { data, error } = await client.rpc('pos_transition_kitchen', {
      p_command: command,
      p_binding: binding,
    })
    if (error) kitchenRpcError(error.message)
    return NextResponse.json(kitchenResult(command, data), { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
