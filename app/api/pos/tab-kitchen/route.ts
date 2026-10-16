import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requirePilot, requireOrigin, requireDevice } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import {
  tabKitchenListSchema,
  tabKitchenQuerySchema,
  tabKitchenDetailSchema,
  tabKitchenTabSchema,
} from '@/lib/pos/server/tab-kitchen'
import {
  tabKitchenBody,
  tabKitchenResult,
  tabKitchenRpcError,
} from '@/lib/pos/server/tab-kitchen-http'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    requirePilot()
    const { client, user } = await authenticatedPosClient()
    const params = new URL(request.url).searchParams
    const parsed = tabKitchenQuerySchema.safeParse(Object.fromEntries(params))
    if (!parsed.success || [...params.keys()].length !== new Set(params.keys()).size)
      throw new PosServerError('invalid_query', 422)
    const q = parsed.data
    const binding = await requireDevice(client, q.branchId, q.deviceId, user.id)
    const rpc = q.tabId
      ? 'pos_get_tab_kitchen_for_tab'
      : q.ticketId
        ? 'pos_get_tab_kitchen'
        : 'pos_list_tab_kitchen'
    const args = {
      p_branch: q.branchId,
      p_binding: binding,
      ...(q.tabId
        ? { p_tab: q.tabId }
        : q.ticketId
          ? { p_ticket: q.ticketId, p_after_sequence: q.afterSequence ?? null }
          : { p_cursor: q.afterIssuedAt ? { issuedAt: q.afterIssuedAt, id: q.afterId } : null }),
    }
    const { data, error } = await client.rpc(rpc, args)
    if (error) tabKitchenRpcError(error.message)
    const result = q.tabId
      ? tabKitchenTabSchema.parse(data)
      : q.ticketId
        ? tabKitchenDetailSchema.parse(data)
        : tabKitchenListSchema.parse(data)
    if (
      result.branchId !== q.branchId ||
      (q.tabId && (!('tabId' in result) || result.tabId !== q.tabId)) ||
      (q.ticketId && (!('ticket' in result) || result.ticket?.id !== q.ticketId))
    )
      throw new PosServerError('confirmation_mismatch', 503)
    if (q.ticketId && 'events' in result) {
      const after = q.afterSequence ?? result.ticket.acknowledgedSequence
      const remaining = Math.max(0, result.ticket.eventSequence - after)
      if (
        result.events.length !== Math.min(20, remaining) ||
        (remaining > 0 && result.events[0]?.sequence !== after + 1) ||
        (result.eventsNextAfter !== null) !== remaining > 20
      )
        throw new PosServerError('confirmation_mismatch', 503)
    }
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
    const command = await tabKitchenBody(request)
    const binding = await requireDevice(client, command.branchId, command.deviceId, user.id)
    const { data, error } = await client.rpc('pos_execute_tab_kitchen_command', {
      p_command: command,
      p_binding: binding,
    })
    if (error) tabKitchenRpcError(error.message)
    return NextResponse.json(tabKitchenResult(command, data), { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
