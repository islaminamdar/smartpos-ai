import { describe, it, expect, vi } from 'vitest'

const mockCreate = vi.hoisted(() => vi.fn())
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate }
  },
}))

import { importMenuFromImage } from '@/lib/ai/importMenu'

describe('importMenuFromImage', () => {
  it('returns categories with items and prices', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'submit_menu',
          input: {
            categories: [
              {
                name: 'Drinks',
                items: [{ name: 'Karak Tea', price_aed: 5, aliases: ['karak', 'chai'] }],
              },
              {
                name: 'Mains',
                items: [{ name: 'Chicken Biryani', price_aed: 25, aliases: ['biryani'] }],
              },
            ],
          },
        },
      ],
      usage: { input_tokens: 1500, output_tokens: 300 },
    })
    const out = await importMenuFromImage('data:image/png;base64,AAAA')
    expect(out.categories[0].items[0].name).toBe('Karak Tea')
    expect(out.categories[0].items[0].price_aed).toBe(5)
  })
})
