export type PayPalEnvironment = 'sandbox' | 'live'
export class PayPalError extends Error {
  constructor(
    public code: string,
    public status = 503
  ) {
    super(code)
  }
}
export type PayPalConfig = {
  environment: PayPalEnvironment
  clientId: string
  secret: string
  planId: string
  webhookId: string
  base: string
  origin: string
}
export function paypalConfig(): PayPalConfig {
  if (process.env.PAYPAL_BILLING_ENABLED !== 'true') throw new PayPalError('paypal_not_configured')
  const environment = process.env.PAYPAL_ENVIRONMENT
  if (environment !== 'sandbox' && environment !== 'live')
    throw new PayPalError('paypal_not_configured')
  const prefix = `PAYPAL_${environment.toUpperCase()}_`
  const clientId = process.env[prefix + 'CLIENT_ID'],
    secret = process.env[prefix + 'CLIENT_SECRET'],
    planId = process.env[prefix + 'PLAN_ID'],
    webhookId = process.env[prefix + 'WEBHOOK_ID']
  const origin = process.env.POS_PUBLIC_ORIGIN
  if (!clientId || !secret || !planId || !webhookId || !origin || !/^P-[A-Z0-9]{24}$/.test(planId))
    throw new PayPalError('paypal_not_configured')
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new PayPalError('paypal_not_configured')
  }
  if (
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== 'https:' &&
      !(environment === 'sandbox' && ['localhost', '127.0.0.1'].includes(parsed.hostname)))
  )
    throw new PayPalError('paypal_not_configured')
  return {
    environment,
    clientId,
    secret,
    planId,
    webhookId,
    origin,
    base: environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
  }
}
