import { PosServerError } from './client'

export function stationWorkFailure(message: string): never {
  const code = message.match(/\bPOS_[A-Z_]+\b/)?.[0]
  const errors: Record<string, readonly [string, number]> = {
    POS_STATION_WORK_INVALID: ['invalid_station_work_request', 422],
    POS_STATION_WORK_CONFLICT: ['station_work_conflict', 409],
    POS_STATION_WORK_NOT_FOUND: ['station_work_not_found', 404],
    POS_STATION_WORK_NO_CHANGES: ['station_work_no_changes', 409],
    POS_STATION_WORK_NOTICE_PENDING: ['station_work_notice_pending', 409],
    POS_STATION_WORK_CLOSED: ['station_work_closed', 409],
    POS_KITCHEN_REASON_REQUIRED: ['station_work_reason_required', 422],
    POS_KITCHEN_TRANSITION_INVALID: ['invalid_station_work_request', 422],
    POS_KITCHEN_LIMIT: ['station_work_limit', 409],
    POS_ACCESS_DENIED: ['station_work_access_required', 403],
    POS_DEVICE_INVALID: ['device_binding_required', 403],
    POS_MANAGER_REQUIRED: ['station_work_manager_required', 403],
    POS_STAFF_INACTIVE: ['staff_inactive', 403],
    POS_IDEMPOTENCY_CONFLICT: ['request_conflict', 409],
    POS_REQUEST_CANCELLED: ['station_work_request_cancelled', 409],
  }
  const mapped = code ? errors[code] : undefined
  throw new PosServerError(mapped?.[0] ?? 'station_work_unavailable', mapped?.[1] ?? 503)
}
