import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requireDevice, requireOrigin, requirePilot } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { readBoundedBody } from '@/lib/pos/server/body'
import {
  stationCommandSchema,
  stationListSchema,
  stationQuerySchema,
  stationResultSchema,
  stationResultMatches,
  stationListMatchesQuery,
} from '@/lib/pos/server/kitchen-stations'
import {
  requireStationActor,
  stationFailure,
  uniqueStationQuery,
} from '@/lib/pos/server/kitchen-stations-http'

export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    requirePilot()
    const { client, user } = await authenticatedPosClient()
    const parsed = stationQuerySchema.safeParse(uniqueStationQuery(request))
    if (!parsed.success) throw new PosServerError('invalid_query', 422)
    const query = parsed.data
    const binding = await requireDevice(client, query.branchId, query.deviceId, user.id)
    const { data, error } = await client.rpc('pos_list_kitchen_stations', {
      p_branch: query.branchId,
      p_device: query.deviceId,
      p_binding: binding,
      p_after_product: query.afterProductId ?? null,
    })
    if (error) stationFailure(error.message)
    const result = stationListSchema.safeParse(data)
    if (!result.success || !stationListMatchesQuery(query, result.data))
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
    const parsed = stationCommandSchema.safeParse(JSON.parse(await readBoundedBody(request, 4096)))
    if (!parsed.success) throw new PosServerError('invalid_kitchen_station_request', 422)
    const command = parsed.data
    const binding = await requireDevice(client, command.branchId, command.deviceId, user.id)
    const { data, error } = await client.rpc('pos_execute_kitchen_station_command', {
      p_command: command,
      p_binding: binding,
    })
    if (error) stationFailure(error.message)
    const result = stationResultSchema.safeParse(data)
    if (!result.success || !stationResultMatches(command, result.data))
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result.data, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
