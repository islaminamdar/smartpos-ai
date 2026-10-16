import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requireDevice, requirePilot } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import {
  stationWorkDetailSchema,
  stationWorkDetailQuerySchema,
  stationWorkDetailMatchesQuery,
} from '@/lib/pos/server/kitchen-station-work'
import { uniqueStationQuery } from '@/lib/pos/server/kitchen-stations-http'
import { stationWorkFailure } from '@/lib/pos/server/kitchen-station-work-http'

export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    requirePilot()
    const { client, user } = await authenticatedPosClient()
    const parsed = stationWorkDetailQuerySchema.safeParse(uniqueStationQuery(request))
    if (!parsed.success) throw new PosServerError('invalid_query', 422)
    const query = parsed.data
    const binding = await requireDevice(client, query.branchId, query.deviceId, user.id)
    const { data, error } = await client.rpc('pos_get_kitchen_station_work', {
      p_branch: query.branchId,
      p_device: query.deviceId,
      p_binding: binding,
      p_work: query.workId,
      p_query: { noticeView: query.noticeView, afterSequence: query.afterSequence },
    })
    if (error) stationWorkFailure(error.message)
    const result = stationWorkDetailSchema.safeParse(data)
    if (!result.success || !stationWorkDetailMatchesQuery(query, result.data))
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result.data, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
