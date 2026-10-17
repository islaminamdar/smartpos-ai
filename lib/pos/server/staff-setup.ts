import 'server-only'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { accessCookie, refreshCookie, posClient, PosServerError } from './client'
import { hashToken } from './live-access'
import { loginSourceKey } from './login-source'
import { staffRpcError } from './staff-access'
import { staffAccountSetupAvailable } from './staff-mail'

const identity = {
  token: z.string().regex(/^[a-f0-9]{64}$/),
  email: z.string().trim().toLowerCase().email().max(254),
}
export const staffSetupRequestSchema = z.object(identity).strict()
export const staffSetupCompleteSchema = z
  .object({
    ...identity,
    attemptId: z.string().uuid(),
    code: z.string().regex(/^\d{6,10}$/),
    password: z
      .string()
      .min(12)
      .max(72)
      .refine((value) => new TextEncoder().encode(value).length <= 72),
  })
  .strict()
export const staffSetupContextSchema = z
  .object({
    invitationId: z.string().uuid(),
    email: z.string().email(),
    existingConfirmed: z.boolean(),
    attemptId: z.string().uuid().nullable(),
    setupUserId: z.string().uuid().nullable(),
    codeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    setupExpiresAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
export async function prepareStaffSetup(request: Request, email: string) {
  if (!staffAccountSetupAvailable()) throw new PosServerError('account_setup_unavailable', 503)
  // Setup is a new identity flow. It must never replace a shared counter's signed-in person.
  const jar = await cookies()
  if (jar.get(accessCookie)?.value || jar.get(refreshCookie)?.value)
    throw new PosServerError('sign_out_first', 409)
  const admin = posClient(undefined, true)
  const rate = await admin.rpc('pos_login_attempt', {
    p_key: hashToken(email),
    p_source: loginSourceKey(request),
  })
  if (rate.error) throw new PosServerError('authentication_unavailable', 503)
  if (rate.data !== true) throw new PosServerError('login_rate_limited', 429)
  return admin
}
export function setupRpcError(message: string): never {
  if (message.includes('POS_SETUP_CODE_INVALID'))
    throw new PosServerError('verification_code_invalid', 401)
  if (message.includes('POS_SETUP_RATE_LIMITED'))
    throw new PosServerError('setup_rate_limited', 429)
  return staffRpcError(message)
}
