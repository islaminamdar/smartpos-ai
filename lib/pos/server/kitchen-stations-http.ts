import { PosServerError } from './client'

export function requireStationActor(request: Request, actorId: string) {
  if (request.headers.get('x-pos-actor') !== actorId)
    throw new PosServerError('kitchen_station_actor_changed', 403)
}
export function uniqueStationQuery(request: Request) {
  const params = new URL(request.url).searchParams
  if (new Set(params.keys()).size !== [...params.keys()].length)
    throw new PosServerError('invalid_query', 422)
  return Object.fromEntries(params)
}
export function stationFailure(message: string): never {
  const code = message.match(/\bPOS_[A-Z_]+\b/)?.[0]
  const errors: Record<string, readonly [string, number]> = {
    POS_STATION_INVALID: ['invalid_kitchen_station_request', 422],
    POS_STATION_PRODUCT_INVALID: ['invalid_kitchen_station_request', 422],
    POS_STATION_CONFLICT: ['kitchen_station_conflict', 409],
    POS_STATION_NAME_CONFLICT: ['kitchen_station_name_conflict', 409],
    POS_STATION_CAPACITY: ['kitchen_station_capacity', 409],
    POS_STATION_ASSIGNED: ['kitchen_station_assigned', 409],
    POS_STATION_NOT_FOUND: ['kitchen_station_not_found', 404],
    POS_STATION_NO_CHANGES: ['kitchen_station_no_changes', 409],
    POS_ACCESS_DENIED: ['kitchen_station_access_required', 403],
    POS_DEVICE_INVALID: ['device_binding_required', 403],
    POS_MANAGER_REQUIRED: ['kitchen_station_access_required', 403],
    POS_STAFF_INACTIVE: ['staff_inactive', 403],
    POS_IDEMPOTENCY_CONFLICT: ['request_conflict', 409],
    POS_REQUEST_CANCELLED: ['kitchen_station_request_cancelled', 409],
  }
  const mapped = code ? errors[code] : undefined
  throw new PosServerError(mapped?.[0] ?? 'kitchen_stations_unavailable', mapped?.[1] ?? 503)
}
