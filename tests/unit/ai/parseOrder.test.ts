import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted runs before vi.mock hoisting, so mockCreate is available in the
// factory closure without hitting the temporal dead zone.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: mockCreate }
  },
}))

import { parseOrder } from '@/lib/ai/parseOrder'
import menu from '@/tests/fixtures/menus/sample-uae-cafe.json'

const setMockResponse = (response: any) => mockCreate.mockResolvedValue(response)

beforeEach(() => vi.clearAllMocks())

describe('parseOrder', () => {
  it('parses a multilingual order against the tenant menu', async () => {
    setMockResponse({
      content: [{
        type: 'tool_use',
        name: 'submit_order',
        input: {
          items: [
            { menu_item_id: 'm1', qty: 2, modifiers: [{ name: 'sugar', value: 'less' }] },
            { menu_item_id: 'm2', qty: 1, modifiers: [{ name: 'spice', value: 'medium' }] },
          ],
          confidence: 0.94,
          clarification_needed: null,
        },
      }],
      usage: { input_tokens: 800, output_tokens: 120 },
    })
    const result = await parseOrder({
      text: 'two karak less sugar and one chicken biryani medium spicy',
      menu: menu.items,
      locale: 'en',
    })
    expect(result.items).toHaveLength(2)
    expect(result.items[0].menu_item_id).toBe('m1')
    expect(result.items[0].qty).toBe(2)
    expect(result.confidence).toBeGreaterThan(0.9)
    expect(result.clarification_needed).toBeNull()
  })

  it('asks for clarification when an item is not on the menu', async () => {
    setMockResponse({
      content: [{
        type: 'tool_use',
        name: 'submit_order',
        input: {
          items: [],
          confidence: 0.3,
          clarification_needed: 'Did you mean Cheese Manakish? We do not have "zaatar pizza" on the menu.',
        },
      }],
      usage: { input_tokens: 600, output_tokens: 60 },
    })
    const result = await parseOrder({ text: 'one zaatar pizza', menu: menu.items, locale: 'en' })
    expect(result.items).toHaveLength(0)
    expect(result.clarification_needed).toMatch(/manakish/i)
  })
})
