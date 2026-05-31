import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth/session'
import { dashboardQuery } from '@/lib/ai/dashboardQuery'
import { createServiceRole } from '@/lib/db/supabase'
import { checkBudget, BudgetExceededError } from '@/lib/ai/budget'

const Body = z.object({ question: z.string().min(1) })

export async function POST(req: Request) {
  const s = await requireSession()
  try {
    await checkBudget(s.tenantId)
  } catch (e) {
    if (e instanceof BudgetExceededError)
      return NextResponse.json({ error: 'AI_BUDGET_EXCEEDED' }, { status: 429 })
    throw e
  }
  const { question } = Body.parse(await req.json())
  const result = await dashboardQuery(question)
  const admin = createServiceRole()
  await admin.from('ai_usage').insert({
    tenant_id: s.tenantId,
    kind: 'dashboard_query',
    model: 'claude-sonnet-4-6',
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    cost_usd: result.usage.input_tokens * 0.000003 + result.usage.output_tokens * 0.000015,
  })
  return NextResponse.json({ answer: result.answer })
}
