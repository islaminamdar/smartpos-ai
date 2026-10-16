import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requirePilot, requireOrigin, requireDevice } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { staffRevokeCommandSchema, staffRevokeResultSchema } from '@/lib/pos/server/staff'
import { staffBody, staffRpcError } from '@/lib/pos/server/staff-access'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requirePilot()
    requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    const parsed = staffRevokeCommandSchema.safeParse(await staffBody(request))
    if (!parsed.success) throw new PosServerError('invalid_staff_request', 422)
    const command = parsed.data
    const binding = await requireDevice(client, command.branchId, command.deviceId, user.id)
    const { data, error } = await client.rpc('pos_revoke_staff_invitation', {
      p_command: command,
      p_binding: binding,
    })
    if (error) staffRpcError(error.message)
    const result = staffRevokeResultSchema.parse(data)
    if (result.requestId !== command.id || result.invitationId !== command.invitationId)
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
