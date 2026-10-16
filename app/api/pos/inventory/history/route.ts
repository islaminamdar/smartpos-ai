import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requirePilot } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { inventoryHistorySchema } from '@/lib/pos/inventory'
import { inventoryFailure, uniqueInventoryQuery } from '@/lib/pos/server/inventory'

export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    requirePilot()
    const { client } = await authenticatedPosClient()
    const parsed = z
      .object({
        branchId: z.string().uuid(),
        itemId: z.string().uuid(),
        beforeRevision: z
          .string()
          .regex(/^[1-9]\d{0,9}$/)
          .transform(Number)
          .refine((n) => n >= 2 && n <= 2_147_483_646)
          .optional(),
      })
      .strict()
      .safeParse(uniqueInventoryQuery(request))
    if (!parsed.success) throw new PosServerError('invalid_query', 422)
    const { branchId, itemId, beforeRevision } = parsed.data
    const { data, error } = await client.rpc('pos_inventory_history', {
      p_branch: branchId,
      p_item: itemId,
      p_before_revision: beforeRevision ?? null,
    })
    if (error) inventoryFailure(error.message)
    const result = inventoryHistorySchema.safeParse(data)
    if (
      !result.success ||
      result.data.branchId !== branchId ||
      result.data.item.id !== itemId ||
      (beforeRevision && result.data.entries.some((entry) => entry.revision >= beforeRevision))
    )
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result.data, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
