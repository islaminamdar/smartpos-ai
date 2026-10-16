import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requirePilot, requireOrigin, requireDevice, hashToken } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { staffInviteCommandSchema, staffInviteResultSchema } from '@/lib/pos/server/staff'
import {
  invitationToken,
  invitationUrl,
  staffBody,
  staffRpcError,
} from '@/lib/pos/server/staff-access'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requirePilot()
    requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    const parsed = staffInviteCommandSchema.safeParse(await staffBody(request))
    if (!parsed.success) throw new PosServerError('invalid_staff_request', 422)
    const command = parsed.data
    const binding = await requireDevice(client, command.branchId, command.deviceId, user.id)
    const token = invitationToken(user.id, command.branchId, command.id)
    const setupUrl = invitationUrl(token)
    const { data, error } = await client.rpc('pos_create_staff_invitation', {
      p_command: command,
      p_binding: binding,
      p_token_hash: hashToken(token),
    })
    if (error) staffRpcError(error.message)
    const result = staffInviteResultSchema.parse({ ...data, setupUrl })
    if (
      result.requestId !== command.id ||
      result.invitation.id !== command.id ||
      result.invitation.email !== command.email ||
      result.invitation.displayName !== command.displayName ||
      result.invitation.role !== command.role ||
      result.invitation.branchId !== command.assignedBranchId ||
      new Date(result.invitation.expiresAt).getTime() !== new Date(command.expiresAt).getTime()
    )
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
