import { staffAccountSetupAvailable } from '@/lib/pos/server/staff-mail'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requirePilot, requireOrigin, requireDevice } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { staffListSchema, staffUpdateSchema, staffUpdateResultSchema } from '@/lib/pos/server/staff'
import { invitationLinksAvailable, staffBody, staffRpcError } from '@/lib/pos/server/staff-access'
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
          .transform((v) => v.toLowerCase()),
      })
      .strict()
      .safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!query.success) throw new PosServerError('invalid_query', 422)
    const { data, error } = await client.rpc('pos_list_staff', { p_branch: query.data.branchId })
    if (error) staffRpcError(error.message)
    const result = staffListSchema.parse({
      ...data,
      capabilities: {
        inviteLinks: invitationLinksAvailable(),
        emailDelivery: staffAccountSetupAvailable(),
        accountSetup: staffAccountSetupAvailable(),
      },
    })
    if (
      result.branchId !== query.data.branchId ||
      result.staff.some((member) => member.branchId !== null && member.branchId !== result.branchId)
    )
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
    const parsed = staffUpdateSchema.safeParse(await staffBody(request))
    if (!parsed.success) throw new PosServerError('invalid_staff_request', 422)
    const command = parsed.data
    const binding = await requireDevice(client, command.branchId, command.deviceId, user.id)
    const { data, error } = await client.rpc('pos_manage_staff', {
      p_command: command,
      p_binding: binding,
    })
    if (error) staffRpcError(error.message)
    const result = staffUpdateResultSchema.parse(data)
    if (
      result.requestId !== command.id ||
      result.staff.userId !== command.targetUserId ||
      result.staff.revision !== command.expectedRevision + 1 ||
      result.staff.active !== command.active ||
      result.staff.role !== command.role ||
      result.staff.branchId !== command.assignedBranchId ||
      result.staff.displayName !== command.displayName
    )
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
