import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth/session'
import { stripe, PRICE_STARTER_AED_100 } from '@/lib/billing/stripe'
import { createServiceRole } from '@/lib/db/supabase'

export async function POST() {
  const s = await requireSession()
  const admin = createServiceRole()
  const { data: t } = (await admin
    .from('tenants')
    .select('stripe_customer_id, name')
    .eq('id', s.tenantId)
    .single()) as { data: { stripe_customer_id: string | null; name: string } | null }
  let customerId = t?.stripe_customer_id ?? null
  if (!customerId) {
    const c = await stripe.customers.create({
      name: t?.name ?? '',
      metadata: { tenant_id: s.tenantId },
    })
    customerId = c.id
    await admin.from('tenants').update({ stripe_customer_id: customerId }).eq('id', s.tenantId)
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: PRICE_STARTER_AED_100, quantity: 1 }],
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/settings/billing?ok=1`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/settings/billing`,
  })
  return NextResponse.json({ url: session.url })
}
