import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp/client', () => ({ sendText: vi.fn(async () => ({})) }))
vi.mock('@/lib/ai/parseOrder', () => ({ parseOrder: vi.fn(async () => ({ items: [{ menu_item_id: 'm1', qty: 1, modifiers: [] }], confidence: 0.93, clarification_needed: null, usage: { input_tokens: 5, output_tokens: 5 } })) }))
vi.mock('@/lib/db/queries', () => ({ getTenantMenu: async () => [{ id: 'm1', name: 'Karak', aliases: [], price_aed: 5 }] }))

const inserts: any[] = []
vi.mock('@/lib/db/supabase', () => ({
  createServiceRole: () => ({
    from: (table: string) => ({
      insert: (row: any) => {
        inserts.push({ table, row })
        return { select: () => ({ single: async () => ({ data: { id: 'x' } }) }) }
      },
      upsert: (row: any, _opts?: any) => {
        inserts.push({ table, row, op: 'upsert' })
        return { select: () => ({ single: async () => ({ data: { id: 'c1', ai_active: true } }) }) }
      },
      select: () => ({ eq: () => ({ single: async () => ({ data: { id: 't1', name: 'Café', whatsapp_phone_number_id: 'p1', whatsapp_access_token: 'tok' } }) }) }),
    }),
  }),
}))

import { handleInbound } from '@/lib/whatsapp/handler'

beforeEach(() => { inserts.length = 0 })

describe('handleInbound', () => {
  it('creates conversation, message, and order from a text message', async () => {
    await handleInbound({
      tenantId: 't1',
      from: '971501234567',
      text: 'one karak please',
      profileName: 'Ahmed',
    })
    expect(inserts.some(i => i.table === 'conversations')).toBe(true)
    expect(inserts.some(i => i.table === 'messages')).toBe(true)
    expect(inserts.some(i => i.table === 'orders')).toBe(true)
  })
})
