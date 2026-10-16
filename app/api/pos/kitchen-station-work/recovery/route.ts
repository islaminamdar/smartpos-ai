import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { recoveryBinding, requireOrigin } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { readBoundedBody } from '@/lib/pos/server/body'
import {
  stationWorkCommandSchema,
  stationWorkRecoverySchema,
  stationWorkResultMatches,
} from '@/lib/pos/server/kitchen-station-work'
import { requireStationActor } from '@/lib/pos/server/kitchen-stations-http'
import { stationWorkFailure } from '@/lib/pos/server/kitchen-station-work-http'

export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    requireStationActor(request, user.id)
    const parsed = stationWorkCommandSchema.safeParse(
      JSON.parse(await readBoundedBody(request, 4096))
    )
    if (!parsed.success) throw new PosServerError('invalid_station_work_request', 422)
    const command = parsed.data
    const binding = await recoveryBinding(user.id)
    const { data, error } = await client.rpc('pos_resolve_kitchen_station_work_request', {
      p_command: command,
      p_binding: binding,
    })
    if (error) stationWorkFailure(error.message)
    const result = stationWorkRecoverySchema.safeParse(data)
    if (!result.success || !stationWorkResultMatches(command, result.data))
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result.data, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
