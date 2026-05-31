import { describe, it, expect, vi } from 'vitest'

const mockCreate = vi.hoisted(() => vi.fn())
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate }
  },
}))

vi.mock('@/lib/db/supabase', () => ({
  createServer: async () => ({
    rpc: async (_fn: string, _args: any) => ({ data: [{ r: 1240 }], error: null }),
  }),
}))

import { dashboardQuery } from '@/lib/ai/dashboardQuery'

describe('dashboardQuery', () => {
  it('answers using the SQL tool', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'run_query',
            input: {
              sql: "select sum(revenue) as r from v_orders_summary where day = current_date - interval '1 day'",
            },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 30 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Yesterday you made AED 1,240 across 47 orders.' }],
        usage: { input_tokens: 50, output_tokens: 20 },
      })
    const out = await dashboardQuery('how did yesterday go?')
    expect(out.answer).toMatch(/1,240/)
  })
})
