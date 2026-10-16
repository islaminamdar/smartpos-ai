import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requireDevice, requireOrigin, requirePilot } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { readBoundedBody } from '@/lib/pos/server/body'
import {
  inventoryCommandSchema,
  inventoryListSchema,
  inventoryQuerySchema,
  inventoryResultMatches,
  inventoryResultSchema,
} from '@/lib/pos/inventory'
import {
  inventoryFailure,
  uniqueInventoryQuery,
  requireInventoryActor,
} from '@/lib/pos/server/inventory'

export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    requirePilot()
    const { client } = await authenticatedPosClient()
    const parsed = inventoryQuerySchema
      .extend({
        branchId: z.string().uuid(),
        search: inventoryQuerySchema.shape.search.default(''),
        filter: inventoryQuerySchema.shape.filter.default('all'),
        afterId: z.string().uuid().optional(),
      })
      .strict()
      .safeParse(uniqueInventoryQuery(request))
    if (!parsed.success) throw new PosServerError('invalid_query', 422)
    const { branchId, ...query } = parsed.data
    const { data, error } = await client.rpc('pos_inventory', {
      p_branch: branchId,
      p_query: { ...query, afterId: query.afterId ?? null },
    })
    if (error) inventoryFailure(error.message)
    const result = inventoryListSchema.safeParse(data)
    if (
      !result.success ||
      result.data.branchId !== branchId ||
      (query.afterId && result.data.items.some((item) => item.id <= query.afterId!))
    )
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result.data, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
export async function POST(request: Request) {
  try {
    requirePilot()
    requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    requireInventoryActor(request, user.id)
    const parsed = inventoryCommandSchema.safeParse(
      JSON.parse(await readBoundedBody(request, 8192))
    )
    if (!parsed.success) throw new PosServerError('invalid_inventory_request', 422)
    const command = parsed.data
    const binding = await requireDevice(client, command.branchId, command.deviceId, user.id)
    const { data, error } = await client.rpc('pos_manage_inventory', {
      p_command: command,
      p_binding: binding,
    })
    if (error) inventoryFailure(error.message)
    const result = inventoryResultSchema.safeParse(data)
    if (
      !result.success ||
      !inventoryResultMatches(result.data, command) ||
      (result.data.status === 'applied' &&
        result.data.movement &&
        result.data.movement.actorId !== user.id)
    )
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result.data, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
