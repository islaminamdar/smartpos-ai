import { PosServerError } from './client'
import { readBoundedBody } from './body'
import {
  openOrderCommandSchema,
  openOrderUpdateResultSchema,
  openOrderAckMatches,
  type OpenOrderCommand,
} from './open-order-contracts'

export async function openOrderBody(request: Request) {
  const result = openOrderCommandSchema.safeParse(
    JSON.parse(await readBoundedBody(request, 100_000))
  )
  if (!result.success) throw new PosServerError('invalid_open_order_request', 422)
  return result.data
}
export function openOrderResult(command: OpenOrderCommand, data: unknown) {
  const result = openOrderUpdateResultSchema.parse(data)
  if (!openOrderAckMatches(command, result)) throw new PosServerError('confirmation_mismatch', 503)
  return result
}
export function openOrderRpcError(message: string): never {
  const codes: Record<string, [string, number]> = {
    POS_ACCESS_DENIED: ['open_order_forbidden', 403],
    POS_DEVICE_INVALID: ['open_order_forbidden', 403],
    POS_MANAGER_REQUIRED: ['open_order_forbidden', 403],
    POS_STAFF_INACTIVE: ['staff_inactive', 403],
    POS_TAB_CHANGED: ['open_order_changed', 409],
    POS_TABLE_CHANGED: ['table_changed', 409],
    POS_TAB_NOT_FOUND: ['open_order_not_found', 404],
    POS_TABLE_NOT_FOUND: ['table_not_found', 404],
    POS_TABLE_OCCUPIED: ['table_occupied', 409],
    POS_TABLE_INACTIVE: ['table_inactive', 409],
    POS_TABLE_NAME_EXISTS: ['table_name_exists', 409],
    POS_TABLE_LIMIT: ['table_limit', 409],
    POS_TAB_LIMIT: ['open_order_limit', 409],
    POS_TAB_STATE_INVALID: ['open_order_state_invalid', 409],
    POS_TAB_ALREADY_SETTLED: ['open_order_settled', 409],
    POS_TAB_CONTENT_CHANGED: ['open_order_content_changed', 409],
    POS_TAB_SOURCE_REQUIRED: ['open_order_source_required', 409],
    POS_IDEMPOTENCY_CONFLICT: ['request_conflict', 409],
    POS_REQUEST_CANCELLED: ['open_order_request_cancelled', 409],
    POS_INVALID_TAB_COMMAND: ['invalid_open_order_request', 422],
    POS_INVALID_TAB_CURSOR: ['invalid_query', 422],
    POS_INVALID_ORDER: ['invalid_open_order_request', 422],
    POS_PRICE_CHANGED: ['menu_changed', 409],
    POS_PRODUCT_UNAVAILABLE: ['product_unavailable', 409],
    POS_PROFILE_REQUIRED: ['profile_required', 409],
  }
  const match = Object.entries(codes).find(([code]) => message.includes(code))?.[1]
  throw new PosServerError(match?.[0] ?? 'open_orders_unavailable', match?.[1] ?? 503)
}
