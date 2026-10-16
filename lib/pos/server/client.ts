import { createClient, type Session } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
export class PosServerError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code) }
}
export const accessCookie = 'pos-access'
export const refreshCookie = 'pos-refresh'
export const deviceCookie = (userId: string) => `pos-device-${userId}`
export const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/' }
export function posClient(token?: string, admin = false) {
  const url = process.env.SUPABASE_INTERNAL_URL
  const key = admin ? process.env.SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_ANON_KEY
  if (!url || !key) throw new PosServerError('setup_required', 503)
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined })
}
export async function saveSession(session: Session) {
  const jar = await cookies()
  jar.set(accessCookie, session.access_token, { ...cookieOptions, maxAge: session.expires_in })
  jar.set(refreshCookie, session.refresh_token, { ...cookieOptions, maxAge: 60 * 60 * 24 * 7 })
}
export async function clearSession() {
  const jar = await cookies()
  for (const name of [accessCookie, refreshCookie]) jar.set(name, '', { ...cookieOptions, maxAge: 0 })
}
export async function authenticatedPosClient() {
  const jar = await cookies()
  let token = jar.get(accessCookie)?.value
  const refresh = jar.get(refreshCookie)?.value
  const authClient = posClient()
  if (token) {
    const { data, error } = await authClient.auth.getUser(token)
    if (!error && data.user) return { client: posClient(token), user: data.user }
  }
  if (refresh) {
    const { data, error } = await authClient.auth.refreshSession({ refresh_token: refresh })
    if (!error && data.session) {
      await saveSession(data.session)
      token = data.session.access_token
      const verified = await authClient.auth.getUser(token)
      if (!verified.error && verified.data.user) return { client: posClient(token), user: verified.data.user }
    }
  }
  throw new PosServerError('authentication_required', 401)
}
