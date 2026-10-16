import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requirePilot, requireOrigin, recoveryBinding } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { kitchenCancellationSchema } from '@/lib/pos/server/kitchen'
import { kitchenBody, kitchenResult, kitchenRpcError } from '@/lib/pos/server/kitchen-http'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    requirePilot()
    requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    const command = await kitchenBody(request)
    const binding = await recoveryBinding(user.id)
    const { data, error } = await client.rpc('pos_resolve_kitchen_request', {
      p_command: command,
      p_binding: binding,
    })
    if (error) kitchenRpcError(error.message)
    if (data?.status === 'cancelled') {
      const result = kitchenCancellationSchema.parse(data)
      if (result.requestId !== command.id) throw new PosServerError('confirmation_mismatch', 503)
      return NextResponse.json(result, { headers: privateHeaders })
    }
    return NextResponse.json(kitchenResult(command, data), { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
