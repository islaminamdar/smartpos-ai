import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export type ImportedMenu = {
  categories: {
    name: string
    items: { name: string; price_aed: number; aliases: string[]; description?: string }[]
  }[]
  usage: { input_tokens: number; output_tokens: number }
}

export async function importMenuFromImage(dataUrl: string): Promise<ImportedMenu> {
  const [meta, b64] = dataUrl.split(',')
  const mediaType = (meta.match(/data:([^;]+)/)?.[1] ?? 'image/png') as
    | 'image/png'
    | 'image/jpeg'
    | 'image/webp'
    | 'image/gif'
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system:
      'You extract menus from photos or PDFs of UAE restaurant menus. Prices are in AED. Generate at least one alias per item (a common short name). Skip section headers, addresses, opening hours. Never invent items.',
    tools: [
      {
        name: 'submit_menu',
        description: 'Submit the extracted menu',
        input_schema: {
          type: 'object' as const,
          required: ['categories'],
          properties: {
            categories: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'items'],
                properties: {
                  name: { type: 'string' },
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['name', 'price_aed'],
                      properties: {
                        name: { type: 'string' },
                        price_aed: { type: 'number' },
                        aliases: { type: 'array', items: { type: 'string' }, default: [] },
                        description: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'submit_menu' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: b64,
            } as {
              type: 'base64'
              media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
              data: string
            },
          },
          { type: 'text', text: 'Extract the menu.' },
        ],
      },
    ],
  })
  const block = resp.content.find((b) => b.type === 'tool_use')
  if (!block || block.type !== 'tool_use') throw new Error('Model did not return menu')
  const input = block.input as { categories: ImportedMenu['categories'] }
  return {
    categories: input.categories,
    usage: { input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens },
  }
}
