import { PosServerError } from './client'
import { readBoundedBody } from './body'
import {
  tabKitchenCommandSchema,
  tabKitchenUpdateResultSchema,
  tabKitchenAckMatches,
  type TabKitchenCommand,
} from './tab-kitchen'
export async function tabKitchenBody(request: Request) {
  const result = tabKitchenCommandSchema.safeParse(JSON.parse(await readBoundedBody(request, 4096)))
  if (!result.success) throw new PosServerError('invalid_tab_kitchen_request', 422)
  return result.data
}
export function tabKitchenResult(command: TabKitchenCommand, data: unknown) {
  const result = tabKitchenUpdateResultSchema.parse(data)
  if (!tabKitchenAckMatches(command, result)) throw new PosServerError('confirmation_mismatch', 503)
  return result
}
export function tabKitchenRpcError(message: string): never {
  const codes: Record<string, [string, number]> = {
    POS_KITCHEN_RETURN_PENDING: ['kitchen_return_acknowledgement_required', 409],
    POS_ACCESS_DENIED: ['kitchen_forbidden', 403],
    POS_DEVICE_INVALID: ['kitchen_forbidden', 403],
    POS_MANAGER_REQUIRED: ['kitchen_forbidden', 403],
    POS_STAFF_INACTIVE: ['staff_inactive', 403],
    POS_TAB_KITCHEN_NOT_FOUND: ['kitchen_unavailable', 404],
    POS_TAB_KITCHEN_CHANGED: ['kitchen_conflict', 409],
    POS_TAB_KITCHEN_PENDING_ACK: ['kitchen_acknowledgement_required', 409],
    POS_KITCHEN_NO_CHANGES: ['kitchen_no_changes', 409],
    POS_KITCHEN_REASON_REQUIRED: ['kitchen_reason_required', 422],
    POS_KITCHEN_TRANSITION_INVALID: ['kitchen_transition_invalid', 409],
    POS_KITCHEN_DISPATCH_REQUIRED: ['kitchen_dispatch_required', 409],
    POS_KITCHEN_CANCELLED: ['kitchen_cancelled', 409],
    POS_KITCHEN_LIMIT: ['kitchen_limit', 409],
    POS_INVALID_ORDER: ['invalid_tab_kitchen_request', 422],
    POS_INVALID_TAB_KITCHEN_COMMAND: ['invalid_tab_kitchen_request', 422],
    POS_INVALID_TAB_KITCHEN_CURSOR: ['invalid_query', 422],
    POS_IDEMPOTENCY_CONFLICT: ['request_conflict', 409],
    POS_REQUEST_CANCELLED: ['kitchen_request_cancelled', 409],
    POS_TAB_CHANGED: ['open_order_changed', 409],
    POS_TAB_NOT_FOUND: ['open_order_not_found', 404],
    POS_TAB_ALREADY_SETTLED: ['open_order_settled', 409],
    POS_TAB_STATE_INVALID: ['open_order_state_invalid', 409],
    POS_PRICE_CHANGED: ['menu_changed', 409],
    POS_PRODUCT_UNAVAILABLE: ['product_unavailable', 409],
    POS_PROFILE_REQUIRED: ['profile_required', 409],
  }
  const match = Object.entries(codes).find(([code]) => message.includes(code))?.[1]
  throw new PosServerError(match?.[0] ?? 'kitchen_unavailable', match?.[1] ?? 503)
}
