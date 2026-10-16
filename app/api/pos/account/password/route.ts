import { NextResponse } from 'next/server'
import {
  authenticatedPosClient,
  posClient,
  clearSession,
  PosServerError,
} from '@/lib/pos/server/client'
import { requirePilot, requireOrigin, hashToken } from '@/lib/pos/server/live-access'
import { loginSourceKey } from '@/lib/pos/server/login-source'
import { liveBootstrapSchema } from '@/lib/pos/server/live-contracts'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { passwordChangeSchema } from '@/lib/pos/server/staff'
import { staffBody } from '@/lib/pos/server/staff-access'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requirePilot()
    requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    const input = passwordChangeSchema.safeParse(await staffBody(request))
    if (!input.success) throw new PosServerError('invalid_password_change', 422)
    const email = user.email?.trim().toLowerCase()
    if (!email) throw new PosServerError('authentication_required', 401)
    const shifts = await client.rpc('pos_open_shift_summaries')
    if (shifts.error) throw new PosServerError('account_unavailable', 503)
    if (
      liveBootstrapSchema.shape.shifts
        .parse(shifts.data)
        .some((shift) => shift.openedBy === user.id)
    )
      throw new PosServerError('account_open_shifts', 409)
    const admin = posClient(undefined, true)
    const rate = await admin.rpc('pos_login_attempt', {
      p_key: hashToken(email),
      p_source: loginSourceKey(request),
    })
    if (rate.error) throw new PosServerError('authentication_unavailable', 503)
    if (rate.data !== true) throw new PosServerError('login_rate_limited', 429)
    const verified = await posClient().auth.signInWithPassword({
      email,
      password: input.data.currentPassword,
    })
    if (verified.error || !verified.data.session || verified.data.user?.id !== user.id)
      throw new PosServerError('current_password_incorrect', 401)
    const token = verified.data.session.access_token
    let changed = false
    try {
      const updated = await posClient(token).auth.updateUser({ password: input.data.newPassword })
      if (updated.error || updated.data.user?.id !== user.id)
        throw new PosServerError('password_change_unconfirmed', 503)
      changed = true
      const revoked = await admin.auth.admin.signOut(token, 'global').catch(() => ({ error: true }))
      try {
        await clearSession()
      } catch {
        throw new PosServerError('password_changed_sign_out_pending', 503)
      }
      if (revoked.error) throw new PosServerError('password_changed_sign_out_pending', 503)
      return NextResponse.json(
        { status: 'password_changed', requiresSignIn: true },
        { headers: privateHeaders }
      )
    } finally {
      if (!changed) await admin.auth.admin.signOut(token, 'local').catch(() => undefined)
    }
  } catch (error) {
    return posFailure(error)
  }
}
