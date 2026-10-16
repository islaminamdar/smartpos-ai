import { z } from 'zod'
import { PayPalError, type PayPalConfig } from './config'
export const branchSchema = z.object({ branchId: z.string().uuid() }).strict()
export const checkoutSchema = branchSchema
  .extend({ requestId: z.string().uuid(), acceptRecurring: z.literal(true) })
  .strict()
export const cancelSchema = branchSchema.extend({ confirmCancellation: z.literal(true) }).strict()
export const providerId = z.string().regex(/^I-[A-Z0-9]{6,30}$/)
export const subscriptionStatus = z.enum([
  'APPROVAL_PENDING',
  'APPROVED',
  'ACTIVE',
  'SUSPENDED',
  'CANCELLED',
  'EXPIRED',
])
const money = z.object({
  currency_code: z.literal('USD'),
  value: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/),
})
export function cents(value: string) {
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(value)) throw new PayPalError('paypal_invalid_amount')
  const [whole, fraction = ''] = value.split('.')
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(result)) throw new PayPalError('paypal_invalid_amount')
  return result
}
const cycle = z.object({
  tenure_type: z.literal('REGULAR'),
  sequence: z.literal(1),
  total_cycles: z.literal(0),
  frequency: z.object({ interval_unit: z.literal('MONTH'), interval_count: z.literal(1) }),
  pricing_scheme: z.object({
    fixed_price: money,
    tiers: z.array(z.unknown()).max(0).optional(),
    pricing_model: z.string().optional(),
  }),
})
const planShape = z.object({
  billing_cycles: z.array(cycle).length(1),
  quantity_supported: z.literal(false).optional(),
  taxes: z.object({ percentage: z.string() }).optional(),
  payment_preferences: z.object({ setup_fee: money.optional() }).optional(),
})
export function validatePlan(value: unknown, expectedId?: string) {
  const schema = expectedId
    ? planShape.extend({ id: z.literal(expectedId), status: z.literal('ACTIVE') })
    : planShape
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new PayPalError('paypal_plan_mismatch')
  const plan = parsed.data
  if (
    cents(plan.billing_cycles[0].pricing_scheme.fixed_price.value) !== 10000 ||
    (plan.taxes && !/^0(?:\.0+)?$/.test(plan.taxes.percentage)) ||
    (plan.payment_preferences?.setup_fee && cents(plan.payment_preferences.setup_fee.value) !== 0)
  )
    throw new PayPalError('paypal_plan_mismatch')
  return plan
}
export const providerSubscriptionSchema = z.object({
  id: providerId,
  plan_id: z.string(),
  custom_id: z.string().uuid(),
  status: subscriptionStatus,
  quantity: z.string().optional(),
  plan_overridden: z.boolean().optional(),
  plan: z.unknown().optional(),
  shipping_amount: money.optional(),
  status_update_time: z.string().datetime({ offset: true }).optional(),
  update_time: z.string().datetime({ offset: true }).optional(),
  billing_info: z
    .object({
      next_billing_time: z.string().datetime({ offset: true }).optional(),
      failed_payments_count: z.number().int().nonnegative().optional(),
      outstanding_balance: money.optional(),
      last_payment: z
        .object({ amount: money, time: z.string().datetime({ offset: true }) })
        .optional(),
    })
    .optional(),
  links: z
    .array(z.object({ rel: z.string(), href: z.string(), method: z.string().optional() }))
    .optional(),
})
export function validateSubscription(
  value: unknown,
  config: PayPalConfig,
  checkoutId: string,
  expectedProviderId?: string | null,
  identityOnly = false
) {
  const parsed = providerSubscriptionSchema.safeParse(value)
  if (!parsed.success) throw new PayPalError('paypal_subscription_mismatch')
  const subscription = parsed.data
  if (
    subscription.plan_id !== config.planId ||
    subscription.custom_id !== checkoutId ||
    (expectedProviderId && subscription.id !== expectedProviderId) ||
    (!identityOnly &&
      ((subscription.quantity && Number(subscription.quantity) !== 1) ||
        (subscription.shipping_amount && cents(subscription.shipping_amount.value) !== 0)))
  )
    throw new PayPalError('paypal_subscription_mismatch')
  if (!identityOnly && subscription.plan !== undefined) validatePlan(subscription.plan)
  else if (!identityOnly && subscription.plan_overridden)
    throw new PayPalError('paypal_subscription_mismatch')
  return subscription
}
export function approvalUrl(value: unknown, environment: PayPalConfig['environment']) {
  if (typeof value !== 'string') throw new PayPalError('paypal_approval_unavailable')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PayPalError('paypal_approval_unavailable')
  }
  const host = environment === 'live' ? 'www.paypal.com' : 'www.sandbox.paypal.com'
  if (
    url.protocol !== 'https:' ||
    url.hostname !== host ||
    url.port ||
    url.username ||
    url.password ||
    !['/webapps/billing/subscriptions', '/agreements/approve'].some((path) => url.pathname === path)
  )
    throw new PayPalError('paypal_approval_unavailable')
  return url.href
}
export const transactionSchema = z.object({
  id: z.string().regex(/^[A-Z0-9-]{5,64}$/),
  status: z.string().regex(/^[A-Z_]{3,40}$/),
  time: z.string().datetime({ offset: true }),
  amount_with_breakdown: z.object({ gross_amount: money }),
})
