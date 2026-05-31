import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth/session'
import { parseOrder } from '@/lib/ai/parseOrder'
import { transcribe } from '@/lib/ai/transcribe'
import { getTenantMenu } from '@/lib/db/queries'
import { createServiceRole } from '@/lib/db/supabase'
import { checkBudget, BudgetExceededError } from '@/lib/ai/budget'
import { log } from '@/lib/logger'

const Body = z.union([
  z.object({
    kind: z.literal('text'),
    text: z.string(),
    locale: z.string().default('en'),
    tableLabel: z.string().optional(),
  }),
  z.object({
    kind: z.literal('audio'),
    audioBase64: z.string(),
    mime: z.string(),
    locale: z.string().default('en'),
    tableLabel: z.string().optional(),
  }),
])

export async function POST(req: Request) {
  const session = await requireSession()
  try {
    await checkBudget(session.tenantId)
  } catch (e) {
    if (e instanceof BudgetExceededError)
      return NextResponse.json({ error: 'AI_BUDGET_EXCEEDED' }, { status: 429 })
    throw e
  }
  const body = Body.parse(await req.json())

  let text: string
  let detectedLocale = body.locale

  if (body.kind === 'audio') {
    const bin = Buffer.from(body.audioBase64, 'base64')
    const blob = new Blob([bin], { type: body.mime })
    const t = await transcribe(blob, body.locale)
    text = t.text
    detectedLocale = t.language
  } else {
    text = body.text
  }

  const menu = await getTenantMenu(session.tenantId)
  const parsed = await parseOrder({ text, menu, locale: detectedLocale })

  const admin = createServiceRole()

  const subtotal = parsed.items.reduce((sum, it) => {
    const m = menu.find((x) => x.id === it.menu_item_id)
    return sum + (m ? m.price_aed * it.qty : 0)
  }, 0)

  const { data: order } = await admin
    .from('orders')
    .insert({
      tenant_id: session.tenantId,
      channel: 'voice',
      status: parsed.clarification_needed ? 'new' : 'accepted',
      table_label: body.tableLabel ?? null,
      raw_input: text,
      parse_confidence: parsed.confidence,
      subtotal_aed: subtotal,
      total_aed: subtotal,
    })
    .select('id')
    .single()

  if (parsed.items.length && order) {
    await admin.from('order_items').insert(
      parsed.items.map((it) => {
        const m = menu.find((x) => x.id === it.menu_item_id)!
        return {
          order_id: order.id,
          menu_item_id: m.id,
          name_snapshot: m.name,
          qty: it.qty,
          unit_price_aed: m.price_aed,
          modifiers_snapshot: it.modifiers ?? [],
          notes: it.note ?? null,
        }
      })
    )

    try {
      const { data: tenant } = await admin
        .from('tenants')
        .select('name, printnode_printer_id')
        .eq('id', session.tenantId)
        .single()
      if (tenant?.printnode_printer_id) {
        const { formatTicket } = await import('@/lib/printing/escpos')
        const { sendPrint } = await import('@/lib/printing/printnode')
        const raw = formatTicket({
          tenantName: tenant.name,
          orderId: order.id,
          tableLabel: body.tableLabel ?? null,
          items: parsed.items.map((it) => {
            const m = menu.find((x) => x.id === it.menu_item_id)!
            return {
              name: m.name,
              qty: it.qty,
              price_aed: m.price_aed,
              modifiers: it.modifiers ?? [],
            }
          }),
          total_aed: subtotal,
          createdAt: new Date(),
        })
        await sendPrint(tenant.printnode_printer_id, raw)
      }
    } catch (e) {
      log.error(e, { context: 'print dispatch failed' })
    }
  }

  await admin.from('ai_usage').insert({
    tenant_id: session.tenantId,
    kind: 'parse_order',
    model: 'claude-sonnet-4-6',
    input_tokens: parsed.usage.input_tokens,
    output_tokens: parsed.usage.output_tokens,
    cost_usd: parsed.usage.input_tokens * 0.000003 + parsed.usage.output_tokens * 0.000015,
  })

  return NextResponse.json({ orderId: order?.id, parsed })
}
