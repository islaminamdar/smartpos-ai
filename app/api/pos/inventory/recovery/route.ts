import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { recoveryBinding, requireOrigin } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { readBoundedBody } from '@/lib/pos/server/body'
import {
  inventoryCommandSchema,
  inventoryRecoverySchema,
  inventoryResultMatches,
} from '@/lib/pos/inventory'
import { inventoryFailure, requireInventoryActor } from '@/lib/pos/server/inventory'

export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    requireInventoryActor(request, user.id)
    const parsed = z
      .object({ mode: z.enum(['lookup', 'cancel']), command: inventoryCommandSchema })
      .strict()
      .safeParse(JSON.parse(await readBoundedBody(request, 9216)))
    if (!parsed.success) throw new PosServerError('invalid_inventory_request', 422)
    const binding = await recoveryBinding(user.id)
    const { command, mode } = parsed.data
    const { data, error } = await client.rpc('pos_inventory_request', {
      p_mode: mode,
      p_command: command,
      p_binding: binding,
    })
    if (error) inventoryFailure(error.message)
    const result = inventoryRecoverySchema.safeParse(data)
    if (
      !result.success ||
      !inventoryResultMatches(result.data, command) ||
      (mode === 'cancel' && result.data.status === 'not_found') ||
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
