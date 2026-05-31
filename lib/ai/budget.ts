import { createServiceRole } from '@/lib/db/supabase'

const MONTHLY_USD_CAP = 8 // ≈ 30 AED — keeps ~50% gross margin on 100 AED tier

export class BudgetExceededError extends Error {
  status = 429
  constructor() {
    super('AI_BUDGET_EXCEEDED')
  }
}

export async function checkBudget(tenantId: string) {
  const admin = createServiceRole()
  const since = new Date()
  since.setUTCDate(1)
  since.setUTCHours(0, 0, 0, 0)
  const { data } = await admin
    .from('ai_usage')
    .select('cost_usd')
    .eq('tenant_id', tenantId)
    .gte('created_at', since.toISOString())
  const spent = (data ?? []).reduce((s, r: any) => s + Number(r.cost_usd), 0)
  if (spent >= MONTHLY_USD_CAP) throw new BudgetExceededError()
}
