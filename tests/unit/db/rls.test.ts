import { describe, it, expect, beforeAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/db/types'

// Skipped until a real Supabase project is linked.
// Set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
// and SUPABASE_SERVICE_ROLE_KEY in .env.local, then change `.skip` to `` to run.
describe.skip('RLS', () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  let tenantA: string

  beforeAll(async () => {
    const admin = createClient<Database>(url, service)
    const { data: a } = await admin.from('tenants').insert({ name: 'A' }).select('id').single()
    tenantA = a!.id
    await admin.from('menu_categories').insert({ tenant_id: tenantA, name: 'Drinks' })
  })

  it('anonymous client cannot read menu_categories', async () => {
    const anonClient = createClient<Database>(url, anon)
    const { data } = await anonClient.from('menu_categories').select('*')
    expect(data ?? []).toHaveLength(0)
  })
})
