import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { posClient, authenticatedPosClient } from '@/lib/pos/server/client'
import { PayPalError, paypalConfig, type PayPalConfig } from './config'
import { PayPalProvider } from './provider'
import { cents, providerId, validateSubscription } from './contracts'
const rowSchema = z
  .object({
    id: z.string().uuid(),
    organization_id: z.string().uuid(),
    branch_id: z.string().uuid(),
    actor_id: z.string().uuid(),
    environment: z.enum(['sandbox', 'live']),
    provider_id: z.string().nullable(),
    plan_id: z.string(),
    status: z.string(),
    created_at: z.string(),
    transactions_checked_through: z.string().nullable(),
  })
  .passthrough()
type Row = z.infer<typeof rowSchema>
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await posClient(undefined, true).rpc(name, args)
  if (error) {
    const code = [
      'PAYPAL_ACCESS_DENIED',
      'PAYPAL_BUSY',
      'PAYPAL_PLAN_CHANGED',
      'PAYPAL_IDEMPOTENCY_CONFLICT',
      'PAYPAL_MANUAL_RECONCILIATION_REQUIRED',
      'PAYPAL_EVENT_CONFLICT',
    ].find((code) => error.message.includes(code))
    throw new PayPalError(
      code ?? 'billing_storage_unavailable',
      code === 'PAYPAL_ACCESS_DENIED' ? 403 : code ? 409 : 503
    )
  }
  return data
}
export async function billingActor(branchId: string) {
  const { client, user } = await authenticatedPosClient()
  const { data, error } = await client.rpc('pos_paypal_can_manage', { p_branch: branchId })
  if (error) throw new PayPalError('billing_storage_unavailable')
  if (data !== true) throw new PayPalError('billing_manager_required', 403)
  return { client, user }
}
async function current(branchId: string, config: PayPalConfig) {
  const { data, error } = await posClient(undefined, true)
    .from('pos_paypal_subscriptions')
    .select('*')
    .eq('branch_id', branchId)
    .eq('environment', config.environment)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new PayPalError('billing_storage_unavailable')
  return data ? rowSchema.parse(data) : null
}
async function reconcileRow(
  row: Row,
  lease: string,
  config: PayPalConfig,
  provider: PayPalProvider,
  subscription: Awaited<ReturnType<PayPalProvider['get']>>,
  eventId: string | null = null,
  affectedPaymentTime: string | null = null
) {
  let through: string | null = row.transactions_checked_through
  let complete = true
  let transactions: Awaited<ReturnType<PayPalProvider['transactions']>> = []
  if (!['APPROVAL_PENDING', 'APPROVED'].includes(subscription.status)) {
    // Catch up one bounded month per call, overlapping recent data to observe refunds/reversals.
    const start = new Date(
      row.transactions_checked_through
        ? new Date(row.transactions_checked_through).getTime() - 3 * 86400000
        : new Date(row.created_at).getTime() - 60000
    )
    const now = Date.now()
    const end = new Date(Math.min(start.getTime() + 31 * 86400000, now))
    transactions = await provider.transactions(
      subscription.id,
      start.toISOString(),
      end.toISOString()
    )
    through = end.toISOString()
    complete = end.getTime() >= now
  }
  if (affectedPaymentTime) {
    const center = new Date(affectedPaymentTime).getTime()
    const older = await provider.transactions(
      subscription.id,
      new Date(center - 60000).toISOString(),
      new Date(Math.min(center + 60000, Date.now())).toISOString()
    )
    transactions = [...new Map([...transactions, ...older].map((tx) => [tx.id, tx])).values()]
  }
  // An existing agreement must remain observable/cancellable if its plan is later changed.
  // Commercial validation is recorded separately and never grants POS entitlements.
  let priceReviewRequired = false
  try {
    await provider.checkPlan(row.plan_id)
    validateSubscription(subscription, { ...config, planId: row.plan_id }, row.id, subscription.id)
  } catch {
    priceReviewRequired = true
  }
  const info = subscription.billing_info
  const result = await rpc('pos_paypal_apply', {
    p_id: row.id,
    p_lease: lease,
    p_snapshot: {
      checkoutId: row.id,
      priceReviewRequired,
      providerId: subscription.id,
      planId: subscription.plan_id,
      status: subscription.status,
      approvalUrl: provider.approval(subscription),
      nextBillingTime: info?.next_billing_time ?? null,
      lastPaymentAt: info?.last_payment?.time ?? null,
      lastPaymentCents: info?.last_payment ? cents(info.last_payment.amount.value) : null,
      outstandingCents: info?.outstanding_balance ? cents(info.outstanding_balance.value) : 0,
      failedPayments: info?.failed_payments_count ?? 0,
    },
    p_transactions: transactions,
    p_through: through,
    p_event: eventId,
    p_complete: complete,
  })
  return {
    ...result,
    approvalUrl: provider.approval(subscription),
    environment: config.environment,
  }
}
export async function startCheckout(branchId: string, requestId: string) {
  const { user } = await billingActor(branchId)
  const config = paypalConfig(),
    lease = randomUUID(),
    provider = new PayPalProvider(config)
  const row = rowSchema.parse(
    await rpc('pos_paypal_begin', {
      p_branch: branchId,
      p_actor: user.id,
      p_environment: config.environment,
      p_plan: config.planId,
      p_request: requestId,
      p_lease: lease,
    })
  )
  try {
    await provider.checkPlan()
    const subscription = row.provider_id
      ? await provider.get(row.provider_id, row.id)
      : await provider.create(row.id, row.branch_id)
    return await reconcileRow(row, lease, config, provider, subscription)
  } finally {
    await rpc('pos_paypal_release', { p_id: row.id, p_lease: lease }).catch(() => undefined)
  }
}
export async function reconcileBranch(branchId: string, cancel = false) {
  const { user } = await billingActor(branchId)
  const config = paypalConfig(),
    provider = new PayPalProvider(config),
    lease = randomUUID()
  const existing = await current(branchId, config)
  if (!existing || !existing.provider_id)
    throw new PayPalError('checkout_confirmation_pending', 409)
  const row = rowSchema.parse(
    await rpc('pos_paypal_reserve', {
      p_id: existing.id,
      p_actor: user.id,
      p_environment: config.environment,
      p_lease: lease,
    })
  )
  try {
    let subscription = await provider.get(existing.provider_id, row.id, row.plan_id)
    if (cancel && !['CANCELLED', 'EXPIRED'].includes(subscription.status)) {
      await provider.cancel(subscription.id)
      subscription = await provider.get(subscription.id, row.id, row.plan_id)
      if (subscription.status !== 'CANCELLED')
        throw new PayPalError('cancellation_confirmation_pending', 409)
    }
    return await reconcileRow(row, lease, config, provider, subscription)
  } finally {
    await rpc('pos_paypal_release', { p_id: row.id, p_lease: lease }).catch(() => undefined)
  }
}
export async function billingStatus(branchId: string) {
  const { client } = await billingActor(branchId)
  const config = paypalConfig()
  const { data, error } = await client
    .from('pos_paypal_subscriptions')
    .select(
      'id,provider_id,status,approval_url,next_billing_time,last_payment_at,last_payment_cents,outstanding_cents,failed_payments,checked_at,transactions_checked_through,price_review_required'
    )
    .eq('branch_id', branchId)
    .eq('environment', config.environment)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new PayPalError('billing_storage_unavailable')
  let transactions: unknown[] = []
  if (data) {
    const response = await client
      .from('pos_paypal_transactions')
      .select('provider_transaction_id,status,amount_cents,currency,occurred_at')
      .eq('subscription_id', data.id)
      .order('occurred_at', { ascending: false })
      .limit(100)
    if (response.error) throw new PayPalError('billing_storage_unavailable')
    transactions = response.data ?? []
  }
  return {
    status: 'ready',
    environment: config.environment,
    price: { amount: '100.00', currency: 'USD', interval: 'month' },
    subscription: data,
    transactions,
  }
}
export async function receiveWebhook(raw: string, headers: Headers) {
  const config = paypalConfig(),
    provider = new PayPalProvider(config)
  await provider.verifyWebhook(raw, headers)
  const event = z
    .object({
      id: z.string().min(1).max(100),
      event_type: z.string().max(100),
      resource: z.record(z.unknown()),
    })
    .parse(JSON.parse(raw))
  let affectedPaymentTime: string | null = null
  let candidate = event.event_type.startsWith('BILLING.SUBSCRIPTION.')
    ? event.resource.id
    : event.resource.billing_agreement_id
  if (event.event_type.startsWith('PAYMENT.SALE.')) {
    const saleId = event.resource.sale_id ?? event.resource.id
    if (typeof saleId === 'string') {
      const sale = await provider.saleReference(saleId)
      candidate = sale.billing_agreement_id
      affectedPaymentTime = sale.create_time
    }
  }
  const parsedId = providerId.safeParse(candidate)
  if (!parsedId.success) return { status: 'ignored', reason: 'unmapped_event' }
  const admin = posClient(undefined, true)
  let lookup = await admin
    .from('pos_paypal_subscriptions')
    .select('*')
    .eq('provider_id', parsedId.data)
    .eq('environment', config.environment)
    .maybeSingle()
  if (lookup.error) throw new PayPalError('billing_storage_unavailable')
  if (!lookup.data && z.string().uuid().safeParse(event.resource.custom_id).success)
    lookup = await admin
      .from('pos_paypal_subscriptions')
      .select('*')
      .eq('id', event.resource.custom_id as string)
      .eq('environment', config.environment)
      .maybeSingle()
  if (lookup.error) throw new PayPalError('billing_storage_unavailable')
  if (!lookup.data) return { status: 'ignored', reason: 'unmapped_subscription' }
  const existing = rowSchema.parse(lookup.data),
    lease = randomUUID()
  const reserved = await rpc('pos_paypal_reserve', {
    p_id: existing.id,
    p_actor: null,
    p_environment: config.environment,
    p_lease: lease,
    p_event: event.id,
    p_digest: createHash('sha256').update(raw).digest('hex'),
  })
  if (reserved?.duplicate) return { status: 'duplicate' }
  const row = rowSchema.parse(reserved)
  try {
    const subscription = await provider.get(parsedId.data, row.id, row.plan_id)
    const result = await reconcileRow(
      row,
      lease,
      config,
      provider,
      subscription,
      event.id,
      affectedPaymentTime
    )
    if (result.reconciliationPending) throw new PayPalError('billing_reconciliation_pending')
    return { status: 'processed' }
  } finally {
    await rpc('pos_paypal_release', { p_id: row.id, p_lease: lease }).catch(() => undefined)
  }
}
