import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requireOrigin, requirePilot, requireDevice } from '@/lib/pos/server/live-access'
import { readBoundedBody } from '@/lib/pos/server/body'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { offerListSchema, offerResultSchema, offerUpdateSchema } from '@/lib/pos/server/offers'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    requirePilot()
    const { client } = await authenticatedPosClient()
    const query = z
      .object({
        branchId: z
          .string()
          .uuid()
          .transform((value) => value.toLowerCase()),
      })
      .strict()
      .safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!query.success) throw new PosServerError('invalid_query', 422)
    const { data, error } = await client.rpc('pos_list_offers', { p_branch: query.data.branchId })
    if (error)
      throw new PosServerError(
        ['POS_ACCESS_DENIED', 'POS_MANAGER_REQUIRED'].some((code) => error.message.includes(code))
          ? 'manager_access_required'
          : 'storage_unavailable',
        ['POS_ACCESS_DENIED', 'POS_MANAGER_REQUIRED'].some((code) => error.message.includes(code))
          ? 403
          : 503
      )
    const result = offerListSchema.parse(data)
    if (result.offers.some((row) => row.offer.branchId !== query.data.branchId))
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
    const body = await readBoundedBody(request, 24000)
    let raw: unknown
    try {
      raw = JSON.parse(body)
    } catch {
      throw new PosServerError('invalid_json', 400)
    }
    const parsed = offerUpdateSchema.safeParse(raw)
    if (!parsed.success) throw new PosServerError('invalid_offer_update', 422)
    const binding = await requireDevice(client, parsed.data.branchId, parsed.data.deviceId, user.id)
    const { data, error } = await client.rpc('pos_manage_offer', {
      p_command: parsed.data,
      p_binding: binding,
    })
    if (error) {
      const map: Record<string, [string, number]> = {
        POS_OFFER_CONFLICT: ['offer_conflict', 409],
        POS_IDEMPOTENCY_CONFLICT: ['request_conflict', 409],
        POS_ACCESS_DENIED: ['manager_access_required', 403],
        POS_MANAGER_REQUIRED: ['manager_access_required', 403],
        POS_INVALID_OFFER: ['invalid_offer_update', 422],
        POS_OFFER_CUSTOMER_UNSUPPORTED: ['invalid_offer_update', 422],
        POS_DEVICE_INVALID: ['manager_access_required', 403],
        POS_INVALID_COMMAND: ['invalid_offer_update', 422],
        POS_OFFER_LIMIT_REACHED: ['offer_limit', 422],
      }
      const match = Object.entries(map).find(([code]) => error.message.includes(code))?.[1]
      throw new PosServerError(match?.[0] ?? 'storage_unavailable', match?.[1] ?? 503)
    }
    const result = offerResultSchema.parse(data)
    if (
      result.requestId !== parsed.data.id ||
      result.offer.id !== parsed.data.offer.id ||
      result.offer.branchId !== parsed.data.branchId ||
      JSON.stringify(result.offer) !==
        JSON.stringify(
          offerResultSchema.shape.offer.parse({
            ...parsed.data.offer,
            branchId: parsed.data.branchId,
            revision: parsed.data.expectedRevision + 1,
          })
        )
    )
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
