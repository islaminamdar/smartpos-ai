import { createServiceRole } from '@/lib/db/supabase'
import { getTenantMenu } from '@/lib/db/queries'
import { parseOrder } from '@/lib/ai/parseOrder'
import { sendText } from './client'
import { checkBudget, BudgetExceededError } from '@/lib/ai/budget'
import { log } from '@/lib/logger'

export async function handleInbound(input: {
  tenantId: string
  from: string
  text: string
  profileName?: string
}) {
  const admin = createServiceRole()
  const { data: tenant } = await admin
    .from('tenants')
    .select('id, name, whatsapp_phone_number_id, whatsapp_access_token')
    .eq('id', input.tenantId)
    .single()

  if (!tenant?.whatsapp_phone_number_id || !tenant.whatsapp_access_token) return

  const { data: conv } = (await admin
    .from('conversations')
    .upsert(
      {
        tenant_id: input.tenantId,
        channel: 'whatsapp',
        external_id: input.from,
        customer_name: input.profileName ?? null,
      },
      { onConflict: 'tenant_id,channel,external_id' }
    )
    .select('id, ai_active')
    .single()) as { data: { id: string; ai_active: boolean } | null }

  if (!conv) return

  await admin.from('messages').insert({
    conversation_id: conv.id,
    direction: 'inbound',
    author: 'customer',
    body: input.text,
  })

  if (!conv.ai_active) return

  const menu = await getTenantMenu(input.tenantId)

  try {
    await checkBudget(input.tenantId)
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      log.warn('[whatsapp] AI budget exceeded — skipping AI reply', { tenantId: input.tenantId })
      return
    }
    throw e
  }

  const parsed = await parseOrder({ text: input.text, menu, locale: 'auto' })

  let replyBody: string
  if (parsed.clarification_needed) {
    replyBody = parsed.clarification_needed
  } else if (parsed.items.length > 0) {
    const subtotal = parsed.items.reduce((s, it) => {
      const m = menu.find((x) => x.id === it.menu_item_id)
      return s + (m ? m.price_aed * it.qty : 0)
    }, 0)

    const { data: order } = (await admin
      .from('orders')
      .insert({
        tenant_id: input.tenantId,
        channel: 'whatsapp',
        status: 'new',
        customer_name: input.profileName ?? null,
        customer_phone: input.from,
        raw_input: input.text,
        parse_confidence: parsed.confidence,
        subtotal_aed: subtotal,
        total_aed: subtotal,
      })
      .select('id')
      .single()) as { data: { id: string } | null }

    if (order && parsed.items.length) {
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
          }
        })
      )
    }

    replyBody = `Order received: ${parsed.items
      .map((it) => {
        const m = menu.find((x) => x.id === it.menu_item_id)!
        return `${it.qty}× ${m.name}`
      })
      .join(', ')}. Total AED ${subtotal.toFixed(2)}. We'll confirm shortly.`
  } else {
    replyBody = 'Hi! Send the items you would like to order, or ask any menu question.'
  }

  await admin.from('messages').insert({
    conversation_id: conv.id,
    direction: 'outbound',
    author: 'ai',
    body: replyBody,
  })

  await sendText({
    phoneNumberId: tenant.whatsapp_phone_number_id,
    accessToken: tenant.whatsapp_access_token,
    to: input.from,
    body: replyBody,
  })
}
