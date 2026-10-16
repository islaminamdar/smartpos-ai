import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticatedPosClient, clearSession, posClient, saveSession, accessCookie, refreshCookie } from '@/lib/pos/server/client'
import { requireOrigin, requirePilot, hashToken } from '@/lib/pos/server/live-access'
import { readBoundedBody } from '@/lib/pos/server/body'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requirePilot(); requireOrigin(request)
    const parsed = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) }).strict().safeParse(JSON.parse(await readBoundedBody(request, 2048)))
    if (!parsed.success) return NextResponse.json({ code: 'invalid_credentials' }, { status: 400, headers: privateHeaders })
    const email = parsed.data.email.toLowerCase().trim()
    const rate = await posClient(undefined, true).rpc('pos_login_attempt', { p_key: hashToken(email) })
    if (rate.error) return NextResponse.json({ code: 'authentication_unavailable' }, { status: 503, headers: privateHeaders })
    if (rate.data !== true) return NextResponse.json({ code: 'login_rate_limited' }, { status: 429, headers: { ...privateHeaders, 'Retry-After': '900' } })
    const client = posClient()
    const { data, error } = await client.auth.signInWithPassword({ email, password: parsed.data.password })
    if (error || !data.session || !data.user) return NextResponse.json({ code: 'invalid_credentials' }, { status: 401, headers: privateHeaders })
    const membership = await posClient(data.session.access_token).from('pos_staff').select('user_id').eq('user_id', data.user.id).eq('active', true).limit(1)
    if (membership.error || !membership.data?.length) return NextResponse.json({ code: 'pilot_access_required' }, { status: 403, headers: privateHeaders })
    await saveSession(data.session)
    return NextResponse.json({ status: 'authenticated', userId: data.user.id }, { headers: privateHeaders })
  } catch (error) { return posFailure(error) }
}
export async function GET() {
  try { requirePilot(); const { user } = await authenticatedPosClient(); return NextResponse.json({ status: 'authenticated', userId: user.id }, { headers: privateHeaders }) }
  catch (error) { return posFailure(error) }
}
export async function DELETE(request: Request) {
  try {
    requirePilot(); requireOrigin(request)
    const jar = await cookies()
    let token = jar.get(accessCookie)?.value
    if (jar.get(refreshCookie)?.value) {
      const refreshed = await posClient().auth.refreshSession({ refresh_token: jar.get(refreshCookie)!.value })
      if (refreshed.error && ![400, 401, 403, 404].includes(refreshed.error.status ?? 0)) return NextResponse.json({ code: 'logout_unavailable' }, { status: 503, headers: privateHeaders })
      token = refreshed.data.session?.access_token ?? token
    }
    if (token) {
      const revoked = await posClient(undefined, true).auth.admin.signOut(token, 'local')
      if (revoked.error && revoked.error.status !== 401 && revoked.error.status !== 403 && revoked.error.status !== 404) return NextResponse.json({ code: 'logout_unavailable' }, { status: 503, headers: privateHeaders })
    }
    await clearSession()
    return NextResponse.json({ status: 'signed_out' }, { headers: privateHeaders })
  }
  catch (error) { return posFailure(error) }
}
