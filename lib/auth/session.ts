import { createServer } from '@/lib/db/supabase'

export type Session = { userId: string; tenantId: string; role: 'owner' | 'manager' | 'staff' }

export async function resolveSession(): Promise<Session | null> {
  const sb = await createServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return null
  const { data } = await sb.from('users').select('tenant_id, role').eq('id', user.id).single()
  if (!data) return null
  return { userId: user.id, tenantId: data.tenant_id, role: data.role as Session['role'] }
}

export async function requireSession(): Promise<Session> {
  const s = await resolveSession()
  if (!s) throw new Error('UNAUTHENTICATED')
  return s
}
