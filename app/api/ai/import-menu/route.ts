import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth/session'
import { importMenuFromImage } from '@/lib/ai/importMenu'
import { createServiceRole } from '@/lib/db/supabase'
import { checkBudget, BudgetExceededError } from '@/lib/ai/budget'

const Body = z.object({ imageDataUrl: z.string() })

export async function POST(req: Request) {
  const s = await requireSession()
  try {
    await checkBudget(s.tenantId)
  } catch (e) {
    if (e instanceof BudgetExceededError)
      return NextResponse.json({ error: 'AI_BUDGET_EXCEEDED' }, { status: 429 })
    throw e
  }
  const { imageDataUrl } = Body.parse(await req.json())
  const imported = await importMenuFromImage(imageDataUrl)

  const admin = createServiceRole()
  for (const [ci, cat] of imported.categories.entries()) {
    const { data: cat_row } = (await admin
      .from('menu_categories')
      .insert({ tenant_id: s.tenantId, name: cat.name, sort_order: ci })
      .select('id')
      .single()) as { data: { id: string } | null }
    if (!cat_row) continue
    if (cat.items.length === 0) continue
    await admin.from('menu_items').insert(
      cat.items.map((it) => ({
        tenant_id: s.tenantId,
        category_id: cat_row.id,
        name: it.name,
        price_aed: it.price_aed,
        aliases: it.aliases ?? [],
        description: it.description ?? null,
      }))
    )
  }
  await admin.from('ai_usage').insert({
    tenant_id: s.tenantId,
    kind: 'import_menu',
    model: 'claude-sonnet-4-6',
    input_tokens: imported.usage.input_tokens,
    output_tokens: imported.usage.output_tokens,
    cost_usd: imported.usage.input_tokens * 0.000003 + imported.usage.output_tokens * 0.000015,
  })
  return NextResponse.json({ categories: imported.categories.length })
}
