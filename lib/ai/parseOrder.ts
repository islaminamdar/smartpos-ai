import Anthropic from '@anthropic-ai/sdk'
import { PARSE_ORDER_SYSTEM } from './prompts'

export type MenuItem = {
  id: string
  name: string
  aliases: string[]
  price_aed: number
  modifiers?: { name: string; options: string[] }[]
}

export type ParsedOrder = {
  items: { menu_item_id: string; qty: number; modifiers: { name: string; value: string }[]; note?: string }[]
  confidence: number
  clarification_needed: string | null
  usage: { input_tokens: number; output_tokens: number }
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function parseOrder(args: {
  text: string
  menu: MenuItem[]
  locale: string
}): Promise<ParsedOrder> {
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: PARSE_ORDER_SYSTEM,
    tools: [{
      name: 'submit_order',
      description: 'Submit the parsed order',
      input_schema: {
        type: 'object' as const,
        required: ['items', 'confidence', 'clarification_needed'],
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['menu_item_id', 'qty'],
              properties: {
                menu_item_id: { type: 'string' },
                qty: { type: 'integer', minimum: 1 },
                modifiers: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['name', 'value'],
                    properties: { name: { type: 'string' }, value: { type: 'string' } },
                  },
                  default: [],
                },
                note: { type: 'string' },
              },
            },
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          clarification_needed: { type: ['string', 'null'] },
        },
      },
    }],
    tool_choice: { type: 'tool', name: 'submit_order' },
    messages: [{
      role: 'user',
      content: `Locale: ${args.locale}\nMenu JSON:\n${JSON.stringify(args.menu)}\n\nTranscript:\n"""${args.text}"""`,
    }],
  })
  const block = resp.content.find(b => b.type === 'tool_use')
  if (!block || block.type !== 'tool_use') {
    throw new Error('Model did not call submit_order')
  }
  const input = block.input as { items: ParsedOrder['items']; confidence: number; clarification_needed: string | null }
  return {
    ...input,
    usage: { input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens },
  }
}
