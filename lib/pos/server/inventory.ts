import { PosServerError } from './client'

// Bind a browser's saved command to its original signed-in actor even if another
// tab changes the cookie between rendering the form and sending the request.
export function requireInventoryActor(request: Request, actorId: string) {
  if (request.headers.get('x-pos-actor') !== actorId)
    throw new PosServerError('inventory_actor_changed', 403)
}

export function inventoryFailure(message: string): never {
  if (/POS_(ACCESS_DENIED|MANAGER_REQUIRED|DEVICE_INVALID|INVENTORY_ACCESS_DENIED)/.test(message))
    throw new PosServerError('inventory_access_required', 403)
  if (/POS_(IDEMPOTENCY_CONFLICT|INVENTORY_REQUEST_CONFLICT)/.test(message))
    throw new PosServerError('request_conflict', 409)
  if (/POS_INVENTORY_(REVISION_CONFLICT|CONFLICT)/.test(message))
    throw new PosServerError('inventory_conflict', 409)
  if (/POS_INVENTORY_(UNCOUNTED|COUNT_REQUIRED)/.test(message))
    throw new PosServerError('inventory_count_required', 409)
  if (/POS_INVENTORY_(INSUFFICIENT|NEGATIVE)/.test(message))
    throw new PosServerError('inventory_insufficient_stock', 409)
  if (/POS_INVENTORY_(SKU_CONFLICT|SKU_EXISTS)/.test(message))
    throw new PosServerError('inventory_sku_conflict', 409)
  if (/POS_INVENTORY_(CAPACITY|LIMIT)/.test(message))
    throw new PosServerError('inventory_capacity', 409)
  if (/POS_INVENTORY_INACTIVE/.test(message)) throw new PosServerError('inventory_inactive', 409)
  if (/POS_INVENTORY_NOT_FOUND/.test(message)) throw new PosServerError('inventory_not_found', 404)
  if (
    /POS_(INVALID_COMMAND|INVALID_QUERY|INVENTORY_INVALID|INVENTORY_UNIT_IMMUTABLE)/.test(message)
  )
    throw new PosServerError('invalid_inventory_request', 422)
  throw new PosServerError('storage_unavailable', 503)
}

export function uniqueInventoryQuery(request: Request) {
  const params = new URL(request.url).searchParams
  if (new Set(params.keys()).size !== [...params.keys()].length)
    throw new PosServerError('invalid_query', 422)
  return Object.fromEntries(params)
}
