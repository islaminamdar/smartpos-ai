import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requirePilot, requireOrigin, requireDevice } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import {
  openOrderListSchema,
  openOrderDetailSchema,
  openOrderQuerySchema,
} from '@/lib/pos/server/open-order-contracts'
import { openOrderBody, openOrderResult, openOrderRpcError } from '@/lib/pos/server/open-order-http'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    requirePilot()
    const { client, user } = await authenticatedPosClient()
    const params = new URL(request.url).searchParams
    const parsed = openOrderQuerySchema.safeParse(Object.fromEntries(params))
    if (!parsed.success || [...params.keys()].length !== new Set(params.keys()).size)
      throw new PosServerError('invalid_query', 422)
    const q = parsed.data
    const binding = await requireDevice(client, q.branchId, q.deviceId, user.id)
    const { data, error } = q.tabId
      ? await client.rpc('pos_get_tab', {
          p_branch: q.branchId,
          p_tab: q.tabId,
          p_binding: binding,
        })
      : await client.rpc('pos_list_tabs', {
          p_branch: q.branchId,
          p_binding: binding,
          p_cursor: q.afterCreatedAt ? { createdAt: q.afterCreatedAt, id: q.afterId } : null,
        })
    if (error) openOrderRpcError(error.message)
    const result = q.tabId ? openOrderDetailSchema.parse(data) : openOrderListSchema.parse(data)
    if (result.branchId !== q.branchId || ('tab' in result && result.tab.id !== q.tabId))
      throw new PosServerError('confirmation_mismatch', 503)
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
    const command = await openOrderBody(request)
    const binding = await requireDevice(client, command.branchId, command.deviceId, user.id)
    const { data, error } = await client.rpc('pos_execute_tab_command', {
      p_command: command,
      p_binding: binding,
    })
    if (error) openOrderRpcError(error.message)
    return NextResponse.json(openOrderResult(command, data), { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
