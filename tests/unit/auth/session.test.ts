import { describe, it, expect, vi } from 'vitest'
import { resolveSession } from '@/lib/auth/session'

vi.mock('@/lib/db/supabase', () => ({
  createServer: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { tenant_id: 't1', role: 'owner' }, error: null }) }) }),
    }),
  })),
}))

describe('resolveSession', () => {
  it('returns the user + tenant when authenticated', async () => {
    const s = await resolveSession()
    expect(s).toEqual({ userId: 'u1', tenantId: 't1', role: 'owner' })
  })
})
