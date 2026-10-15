import { NextResponse } from 'next/server'
import { getStripeClient } from '@/lib/billing/stripe'
import { createServiceRole } from '@/lib/db/supabase'

export async function POST(req: Request) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim()
  if (!webhookSecret || !process.env.STRIPE_SECRET_KEY?.trim()) {
    return NextResponse.json({ error: 'BILLING_NOT_CONFIGURED' }, { status: 503 })
  }
  const stripe = getStripeClient()
  if (!stripe) return NextResponse.json({ error: 'BILLING_NOT_CONFIGURED' }, { status: 503 })
  const sig = req.headers.get('stripe-signature') ?? ''
  const body = await req.text()
  let event
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret)
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
