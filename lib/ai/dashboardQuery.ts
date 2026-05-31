import Anthropic from '@anthropic-ai/sdk'
import { DASHBOARD_QUERY_SYSTEM } from './prompts'
import { createServer } from '@/lib/db/supabase'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function dashboardQuery(question: string) {
  const sb = await createServer()
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }]
  let totalIn = 0,
    totalOut = 0
  for (let i = 0; i < 4; i++) {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system:
        DASHBOARD_QUERY_SYSTEM +
        `\nAvailable read-only views: v_orders_summary(day, orders, revenue), v_top_items(item, qty, revenue, day), v_recent_complaints(body, created_at).`,
      tools: [
        {
          name: 'run_query',
          description: 'Execute a SELECT against the allowed views and return rows.',
          input_schema: {
            type: 'object',
            required: ['sql'],
            properties: { sql: { type: 'string' } },
          },
        },
      ],
      messages,
    })
    totalIn += resp.usage.input_tokens
    totalOut += resp.usage.output_tokens
    const toolBlock = resp.content.find((b) => b.type === 'tool_use')
    const textBlock = resp.content.find((b) => b.type === 'text') as
      | { type: 'text'; text: string }
      | undefined
    if (toolBlock && toolBlock.type === 'tool_use') {
      const { data, error } = await (sb as any).rpc('ai_query', {
        sql: (toolBlock.input as any).sql,
      })
      messages.push({ role: 'assistant', content: resp.content as any })
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: error ? `ERROR: ${error.message}` : JSON.stringify(data),
          },
        ],
      })
      continue
    }
    if (textBlock)
      return { answer: textBlock.text, usage: { input_tokens: totalIn, output_tokens: totalOut } }
  }
  return {
    answer: "I couldn't answer that from your data.",
    usage: { input_tokens: totalIn, output_tokens: totalOut },
  }
}
