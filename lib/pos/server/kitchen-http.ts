import { PosServerError } from './client'
import { readBoundedBody } from './body'
import {
  kitchenCommandSchema,
  kitchenUpdateResultSchema,
  kitchenAckMatches,
  type KitchenCommand,
} from './kitchen'

export async function kitchenBody(request: Request) {
  const result = kitchenCommandSchema.safeParse(JSON.parse(await readBoundedBody(request, 4096)))
  if (!result.success) throw new PosServerError('invalid_kitchen_request', 422)
  return result.data
}
export function kitchenResult(command: KitchenCommand, data: unknown) {
  const result = kitchenUpdateResultSchema.parse(data)
  if (!kitchenAckMatches(command, result)) throw new PosServerError('confirmation_mismatch', 503)
  return result
}
export function kitchenRpcError(message: string): never {
  const codes: Record<string, [string, number]> = {
    POS_KITCHEN_RETURN_PENDING: ['kitchen_return_acknowledgement_required', 409],
    POS_ACCESS_DENIED: ['kitchen_forbidden', 403],
    POS_DEVICE_INVALID: ['kitchen_forbidden', 403],
    POS_MANAGER_REQUIRED: ['kitchen_forbidden', 403],
    POS_STAFF_INACTIVE: ['staff_inactive', 403],
    POS_KITCHEN_CHANGED: ['kitchen_conflict', 409],
    POS_KITCHEN_TRANSITION_INVALID: ['kitchen_transition_invalid', 409],
    POS_KITCHEN_REFUNDED: ['kitchen_refunded', 409],
    POS_KITCHEN_NOT_FOUND: ['kitchen_unavailable', 404],
    POS_REQUEST_CANCELLED: ['kitchen_request_cancelled', 409],
    POS_IDEMPOTENCY_CONFLICT: ['request_conflict', 409],
    POS_INVALID_KITCHEN_COMMAND: ['invalid_kitchen_request', 422],
    POS_INVALID_KITCHEN_CURSOR: ['invalid_query', 422],
    POS_KITCHEN_REASON_REQUIRED: ['kitchen_reason_required', 422],
  }
  const match = Object.entries(codes).find(([code]) => message.includes(code))?.[1]
  throw new PosServerError(match?.[0] ?? 'kitchen_unavailable', match?.[1] ?? 503)
}
