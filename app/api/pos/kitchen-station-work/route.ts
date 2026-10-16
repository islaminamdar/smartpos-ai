import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requireDevice, requireOrigin, requirePilot } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { readBoundedBody } from '@/lib/pos/server/body'
import {
  stationWorkCommandSchema,
  stationWorkListSchema,
  stationWorkQuerySchema,
  stationWorkResultSchema,
  stationWorkResultMatches,
  stationWorkListMatchesQuery,
} from '@/lib/pos/server/kitchen-station-work'
import { requireStationActor, uniqueStationQuery } from '@/lib/pos/server/kitchen-stations-http'
import { stationWorkFailure } from '@/lib/pos/server/kitchen-station-work-http'

export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    requirePilot()
    const { client, user } = await authenticatedPosClient()
    const parsed = stationWorkQuerySchema.safeParse(uniqueStationQuery(request))
    if (!parsed.success) throw new PosServerError('invalid_query', 422)
    const query = parsed.data
    const binding = await requireDevice(client, query.branchId, query.deviceId, user.id)
    const { data, error } = await client.rpc('pos_list_kitchen_station_work', {
      p_branch: query.branchId,
      p_device: query.deviceId,
      p_binding: binding,
      p_query: {
        station: query.station,
        view: query.view,
        cursor: query.cursorAt ? { at: query.cursorAt, id: query.cursorId } : null,
      },
    })
    if (error) stationWorkFailure(error.message)
    const result = stationWorkListSchema.safeParse(data)
    if (!result.success || !stationWorkListMatchesQuery(query, result.data))
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result.data, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
export async function POST(request: Request) {
  try {
    requirePilot()
    requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    requireStationActor(request, user.id)
    const parsed = stationWorkCommandSchema.safeParse(
      JSON.parse(await readBoundedBody(request, 4096))
    )
    if (!parsed.success) throw new PosServerError('invalid_station_work_request', 422)
    const command = parsed.data
    const binding = await requireDevice(client, command.branchId, command.deviceId, user.id)
    const { data, error } = await client.rpc('pos_execute_kitchen_station_work_command', {
      p_command: command,
      p_binding: binding,
    })
    if (error) stationWorkFailure(error.message)
    const result = stationWorkResultSchema.safeParse(data)
    if (!result.success || !stationWorkResultMatches(command, result.data))
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result.data, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
