import { NextResponse } from 'next/server'
import { stripe } from '@/lib/billing/stripe'
import { createServiceRole } from '@/lib/db/supabase'

export async function POST(req: Request) {
  const sig = req.headers.get('stripe-signature') ?? ''
  const body = await req.text()
  let event
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET ?? '')
  } catch (e: any) {
    return new Response(`Webhook Error: ${e.message}`, { status: 400 })
  }
  const admin = createServiceRole()
  if (
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated'
  ) {
    const sub = event.data.object as any
    const customerId = sub.customer
    const status = sub.status === 'active' || sub.status === 'trialing' ? 'active' : 'past_due'
    await admin
      .from('tenants')
      .update({ subscription_status: status })
      .eq('stripe_customer_id', customerId)
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as any
    await admin
      .from('tenants')
      .update({ subscription_status: 'cancelled' })
      .eq('stripe_customer_id', sub.customer)
  }
  return NextResponse.json({ ok: true })
}
