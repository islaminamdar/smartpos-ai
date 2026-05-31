import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: 'u', tenantId: 't', role: 'owner' }),
}))

vi.mock('@/lib/ai/parseOrder', () => ({
  parseOrder: async () => ({
    items: [{ menu_item_id: 'm1', qty: 2, modifiers: [] }],
    confidence: 0.9,
    clarification_needed: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  }),
}))

vi.mock('@/lib/ai/transcribe', () => ({
  transcribe: async () => ({ text: 'two karak', language: 'en' }),
}))

vi.mock('@/lib/db/queries', () => ({
  getTenantMenu: async () => [{ id: 'm1', name: 'Karak', aliases: [], price_aed: 5 }],
}))

const inserts: any[] = []
vi.mock('@/lib/db/supabase', () => ({
  createServiceRole: () => ({
    from: (table: string) => ({
      insert: (row: any) => {
        inserts.push({ table, row })
        return {
          select: () => ({
            single: async () => ({ data: { id: 'o1' } }),
          }),
        }
      },
      select: (_cols?: string) => ({
        eq: (_col: string, _val: string) => ({
          gte: async (_col2: string, _val2: string) => ({ data: [] }),
          single: async () => ({ data: { id: 'o1' } }),
        }),
      }),
    }),
  }),
}))

import { POST } from '@/app/api/ai/parse-order/route'

describe('parse-order route', () => {
  it('creates an order from text input', async () => {
    const req = new Request('http://test/api/ai/parse-order', {
      method: 'POST',
      body: JSON.stringify({ kind: 'text', text: 'two karak', locale: 'en' }),
    })
    const res = await POST(req)
    const json = await res.json()
    expect(json.orderId).toBe('o1')
    expect(inserts.some((i) => i.table === 'orders')).toBe(true)
    expect(inserts.some((i) => i.table === 'order_items')).toBe(true)
  })
})
