import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requirePilot } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { branchOperationsSchema, operationsQuerySchema } from '@/lib/pos/operations/contracts'

export const dynamic = 'force-dynamic'

/** Manager read only. No counter registration or device cookie is needed to view a branch. */
export async function GET(request: Request) {
  try {
    requirePilot()
    const { client } = await authenticatedPosClient()
    const params = new URL(request.url).searchParams
    const parsed = operationsQuerySchema.safeParse(Object.fromEntries(params))
    if (!parsed.success || [...params.keys()].length !== new Set(params.keys()).size)
      throw new PosServerError('invalid_operations_query', 422)
    const { data, error } = await client.rpc('pos_branch_operations', {
      p_branch: parsed.data.branchId,
    })
    if (error) {
      const codes: Record<string, [string, number]> = {
        POS_ACCESS_DENIED: ['operations_manager_required', 403],
        POS_OPERATIONS_ACCESS_DENIED: ['operations_manager_required', 403],
        POS_REPORT_ACCESS_DENIED: ['operations_manager_required', 403],
        POS_OPERATIONS_PROFILE_REQUIRED: ['operations_profile_required', 409],
        POS_REPORT_PROFILE_REQUIRED: ['operations_profile_required', 409],
        POS_OPERATIONS_TOO_LARGE: ['operations_too_large', 503],
        POS_REPORT_TOO_LARGE: ['operations_too_large', 503],
      }
      const mapped = Object.entries(codes).find(([code]) => error.message.includes(code))?.[1]
      throw new PosServerError(mapped?.[0] ?? 'operations_unavailable', mapped?.[1] ?? 503)
    }
    const result = branchOperationsSchema.safeParse(data)
    if (!result.success || result.data.branchId !== parsed.data.branchId)
      throw new PosServerError('operations_unavailable', 503)
    return NextResponse.json(result.data, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
