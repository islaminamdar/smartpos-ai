import { createHmac } from 'node:crypto'
import { PosServerError } from './client'
import { readBoundedBody } from './body'

export function invitationLinksAvailable() {
  if (!/^[a-f0-9]{64}$/.test(process.env.POS_INVITATION_SECRET ?? '')) return false
  try {
    const origin = new URL(process.env.POS_PUBLIC_ORIGIN ?? '')
    return (
      ['https:', 'http:'].includes(origin.protocol) &&
      (process.env.NODE_ENV !== 'production' || origin.protocol === 'https:') &&
      !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash &&
      origin.pathname === '/'
    )
  } catch {
    return false
  }
}
/** An application invitation is not an Auth login/reset token. Recipient identity is still required. */
export function invitationToken(actorId: string, branchId: string, requestId: string) {
  if (!invitationLinksAvailable()) throw new PosServerError('invitation_setup_required', 503)
  return createHmac('sha256', Buffer.from(process.env.POS_INVITATION_SECRET!, 'hex'))
    .update(
      JSON.stringify([
        'pos-staff-invite-v1',
        actorId.toLowerCase(),
        branchId.toLowerCase(),
        requestId.toLowerCase(),
      ])
    )
    .digest('hex')
}
export function invitationUrl(token: string) {
  if (!invitationLinksAvailable()) throw new PosServerError('invitation_setup_required', 503)
  const origin = process.env.POS_PUBLIC_ORIGIN
  if (!origin) throw new PosServerError('invitation_setup_required', 503)
  const url = new URL('/staff/accept', origin)
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')
    throw new PosServerError('invitation_setup_required', 503)
  // Fragment is never included in HTTP access logs or the Referer header.
  url.hash = new URLSearchParams({ token }).toString()
  return url.toString()
}
export async function staffBody(request: Request) {
  return JSON.parse(await readBoundedBody(request, 8000)) as unknown
}
export function staffRpcError(message: string): never {
  const codes: Record<string, [string, number]> = {
    POS_STAFF_CHANGED: ['staff_conflict', 409],
    POS_REQUEST_CANCELLED: ['staff_request_cancelled', 409],
    POS_STAFF_REVISION_AHEAD: ['staff_revision_ahead', 409],
    POS_STAFF_TARGET_FORBIDDEN: ['staff_forbidden', 403],
    POS_STAFF_SCOPE_FORBIDDEN: ['staff_forbidden', 403],
    POS_STAFF_OPEN_SHIFT: ['staff_open_shifts', 409],
    POS_INVALID_STAFF_COMMAND: ['invalid_staff_request', 422],
    POS_STAFF_MEMBERSHIP_EXISTS: ['staff_already_exists', 409],
    POS_INVITATION_EXPIRY_INVALID: ['invitation_expiry_invalid', 422],
    POS_INVITATION_PENDING: ['invitation_pending', 409],
    POS_INVITATION_FORBIDDEN: ['staff_forbidden', 403],
    POS_INVITATION_ACCEPTED: ['invitation_unavailable', 409],
    POS_INVITATION_INVALID: ['invitation_unavailable', 409],
    POS_INVITATION_IDENTITY_MISMATCH: ['invitation_identity_required', 403],
    POS_STAFF_CONFLICT: ['staff_conflict', 409],
    POS_IDEMPOTENCY_CONFLICT: ['request_conflict', 409],
    POS_STAFF_OPEN_SHIFTS: ['staff_open_shifts', 409],
    POS_STAFF_LIMIT: ['staff_limit', 422],
    POS_INVITATION_LIMIT: ['staff_limit', 422],
    POS_MANAGER_REQUIRED: ['staff_forbidden', 403],
    POS_ACCESS_DENIED: ['staff_forbidden', 403],
    POS_DEVICE_INVALID: ['staff_forbidden', 403],
    POS_STAFF_INACTIVE: ['staff_inactive', 403],
    POS_OWNER_REQUIRED: ['staff_forbidden', 403],
    POS_INVALID_COMMAND: ['invalid_staff_request', 422],
    POS_INVALID_INVITATION: ['invalid_staff_request', 422],
    POS_INVITATION_UNAVAILABLE: ['invitation_unavailable', 409],
    POS_INVITATION_EXPIRED: ['invitation_unavailable', 409],
    POS_INVITATION_REVOKED: ['invitation_unavailable', 409],
    POS_INVITATION_EMAIL_MISMATCH: ['invitation_identity_required', 403],
    POS_EMAIL_UNCONFIRMED: ['invitation_identity_required', 403],
    POS_STAFF_ALREADY_EXISTS: ['staff_already_exists', 409],
  }
  const found = Object.entries(codes).find(([code]) => message.includes(code))?.[1]
  throw new PosServerError(found?.[0] ?? 'staff_unavailable', found?.[1] ?? 503)
}
