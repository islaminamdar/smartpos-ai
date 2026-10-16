import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { recoveryBinding, requireOrigin } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { readBoundedBody } from '@/lib/pos/server/body'
import {
  stationCommandSchema,
  stationRecoverySchema,
  stationResultMatches,
} from '@/lib/pos/server/kitchen-stations'
import { requireStationActor, stationFailure } from '@/lib/pos/server/kitchen-stations-http'

export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    requireStationActor(request, user.id)
    const parsed = stationCommandSchema.safeParse(JSON.parse(await readBoundedBody(request, 4096)))
    if (!parsed.success) throw new PosServerError('invalid_kitchen_station_request', 422)
    const command = parsed.data
    const binding = await recoveryBinding(user.id)
    const { data, error } = await client.rpc('pos_resolve_kitchen_station_request', {
      p_command: command,
      p_binding: binding,
    })
    if (error) stationFailure(error.message)
    const result = stationRecoverySchema.safeParse(data)
    if (!result.success || !stationResultMatches(command, result.data))
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result.data, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
