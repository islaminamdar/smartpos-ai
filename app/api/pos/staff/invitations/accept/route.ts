import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import {
  authenticatedPosClient,
  posClient,
  saveSession,
  PosServerError,
  accessCookie,
  refreshCookie,
} from '@/lib/pos/server/client'
import { requirePilot, requireOrigin, hashToken } from '@/lib/pos/server/live-access'
import { loginSourceKey } from '@/lib/pos/server/login-source'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { staffAcceptSchema, staffAcceptResultSchema } from '@/lib/pos/server/staff'
import { staffBody, staffRpcError } from '@/lib/pos/server/staff-access'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requirePilot()
    requireOrigin(request)
    const parsed = staffAcceptSchema.safeParse(await staffBody(request))
    if (!parsed.success) throw new PosServerError('invalid_invitation_credentials', 422)
    const input = parsed.data
    // Never silently replace the manager's active identity on a shared counter.
    const jar = await cookies()
    if (jar.get(accessCookie)?.value || jar.get(refreshCookie)?.value) {
      try {
        const current = await authenticatedPosClient()
        if (current.user.email?.toLowerCase() !== input.email)
          throw new PosServerError('sign_out_first', 409)
      } catch (error) {
        if (!(error instanceof PosServerError && error.status === 401)) throw error
      }
    }
    const admin = posClient(undefined, true)
    const rate = await admin.rpc('pos_login_attempt', {
      p_key: hashToken(input.email),
      p_source: loginSourceKey(request),
    })
    if (rate.error) throw new PosServerError('authentication_unavailable', 503)
    if (rate.data !== true) throw new PosServerError('login_rate_limited', 429)
    const { data, error } = await posClient().auth.signInWithPassword({
      email: input.email,
      password: input.password,
    })
    if (error || !data.user || !data.session) throw new PosServerError('invalid_credentials', 401)
    let retained = false
    try {
      if (data.user.email?.toLowerCase() !== input.email || !data.user.email_confirmed_at)
        throw new PosServerError('invitation_identity_required', 403)
      const client = posClient(data.session.access_token)
      const accepted = await client.rpc('pos_accept_staff_invitation', {
        p_token_hash: hashToken(input.token),
      })
      if (accepted.error) staffRpcError(accepted.error.message)
      const result = staffAcceptResultSchema.parse(accepted.data)
      await saveSession(data.session)
      retained = true
      return NextResponse.json(result, { headers: privateHeaders })
    } finally {
      if (!retained)
        await admin.auth.admin.signOut(data.session.access_token, 'local').catch(() => undefined)
    }
  } catch (error) {
    return posFailure(error)
  }
}
