// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { paypalConfig, type PayPalConfig } from '@/lib/billing/paypal/config'
import { approvalUrl, validatePlan, validateSubscription } from '@/lib/billing/paypal/contracts'
import { PayPalProvider } from '@/lib/billing/paypal/provider'
const config: PayPalConfig = {
  environment: 'sandbox',
  clientId: 'test-client',
  secret: 'test-secret',
  planId: 'P-ABCDEFGHIJKLMNOPQRSTUVWX',
  webhookId: 'test-webhook',
  base: 'https://api-m.sandbox.paypal.com',
  origin: 'http://127.0.0.1:3048',
}
const checkout = '10000000-0000-4000-8000-000000000001'
const plan = () => ({
  id: config.planId,
  status: 'ACTIVE',
  billing_cycles: [
    {
      tenure_type: 'REGULAR',
      sequence: 1,
      total_cycles: 0,
      frequency: { interval_unit: 'MONTH', interval_count: 1 },
      pricing_scheme: { fixed_price: { currency_code: 'USD', value: '100.00' } },
    },
  ],
})
const subscription = () => ({
  id: 'I-ABCDEF123456',
  plan_id: config.planId,
  custom_id: checkout,
  status: 'APPROVAL_PENDING',
  links: [
    {
      rel: 'approve',
      href: 'https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=TEST',
    },
  ],
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
describe('PayPal fixed recurring contract', () => {
  it('fails closed without explicit same-environment credentials before any fetch', () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    vi.stubEnv('PAYPAL_BILLING_ENABLED', 'false')
    expect(() => paypalConfig()).toThrow('paypal_not_configured')
    vi.stubEnv('PAYPAL_BILLING_ENABLED', 'true')
    vi.stubEnv('PAYPAL_ENVIRONMENT', 'live')
    vi.stubEnv('PAYPAL_LIVE_CLIENT_SECRET', '')
    vi.stubEnv('PAYPAL_SANDBOX_CLIENT_SECRET', 'available-only-in-sandbox')
    expect(() => paypalConfig()).toThrow('paypal_not_configured')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('accepts exactly100USD monthly with no trial/setup/tax', () => {
    expect(() => validatePlan(plan(), config.planId)).not.toThrow()
    for (const change of [
      { billing_cycles: [] },
      { billing_cycles: [{ ...plan().billing_cycles[0], tenure_type: 'TRIAL' }] },
      { billing_cycles: [{ ...plan().billing_cycles[0], total_cycles: 12 }] },
      {
        billing_cycles: [
          { ...plan().billing_cycles[0], frequency: { interval_unit: 'YEAR', interval_count: 1 } },
        ],
      },
      {
        billing_cycles: [
          {
            ...plan().billing_cycles[0],
            pricing_scheme: { fixed_price: { currency_code: 'AED', value: '100' } },
          },
        ],
      },
      {
        billing_cycles: [
          {
            ...plan().billing_cycles[0],
            pricing_scheme: { fixed_price: { currency_code: 'USD', value: '101' } },
          },
        ],
      },
      { taxes: { percentage: '5' } },
      { payment_preferences: { setup_fee: { currency_code: 'USD', value: '1' } } },
      { quantity_supported: true },
    ])
      expect(() => validatePlan({ ...plan(), ...change }, config.planId)).toThrow()
  })
  it('binds provider identity to exact server checkout and plan, but allows cancellation after price changes', () => {
    expect(() =>
      validateSubscription(
        { ...subscription(), custom_id: '10000000-0000-4000-8000-000000000002' },
        config,
        checkout
      )
    ).toThrow()
    expect(() =>
      validateSubscription({ ...subscription(), quantity: '2' }, config, checkout)
    ).toThrow()
    expect(() =>
      validateSubscription({ ...subscription(), plan_overridden: true }, config, checkout)
    ).toThrow()
    expect(() =>
      validateSubscription(
        { ...subscription(), quantity: '2', plan_overridden: true },
        config,
        checkout,
        subscription().id,
        true
      )
    ).not.toThrow()
    expect(() =>
      validateSubscription(
        { ...subscription(), custom_id: '10000000-0000-4000-8000-000000000002' },
        config,
        checkout,
        subscription().id,
        true
      )
    ).toThrow()
  })
  it('rejects unsafe or cross-environment approval URLs', () => {
    for (const link of [
      'https://evil.example',
      'https://www.paypal.com/webapps/billing/subscriptions',
      'https://www.sandbox.paypal.com.evil.example/webapps/billing/subscriptions',
      'https://evil@www.sandbox.paypal.com/webapps/billing/subscriptions',
      'javascript:alert(1)',
      'https://www.sandbox.paypal.com/logout',
    ])
      expect(() => approvalUrl(link, 'sandbox')).toThrow()
  })
  it('creates with the durable server UUID and returns only canonical lookup', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        return Response.json(
          url.endsWith('/token')
            ? { access_token: 'test-token' }
            : url.includes('/plans/')
              ? plan()
              : url.endsWith('/subscriptions')
                ? { id: subscription().id }
                : subscription()
        )
      })
    )
    const result = await new PayPalProvider(config).create(
      checkout,
      '10000000-0000-4000-8000-000000000003'
    )
    expect(result.id).toBe(subscription().id)
    const create = calls.find((c) => c.url.endsWith('/subscriptions'))!
    expect((create.init?.headers as Record<string, string>)['PayPal-Request-Id']).toBe(checkout)
    expect(JSON.parse(create.init?.body as string)).toMatchObject({
      plan_id: config.planId,
      custom_id: checkout,
    })
    expect(calls.at(-1)?.url).toContain(subscription().id + '?fields=plan,last_failed_payment')
    expect(calls.every((c) => c.url.startsWith(config.base))).toBe(true)
  })
  it('preserves signed raw webhook event bytes and rejects failed verification', async () => {
    const raw = '{ "id" : "EVT-1", "resource" : {"x": 1.0} }'
    const headers = new Headers({
      'paypal-transmission-id': 'test-id',
      'paypal-transmission-time': '2026-10-16T00:00:00Z',
      'paypal-transmission-sig': 'signature',
      'paypal-cert-url': 'https://api.paypal.com/cert',
      'paypal-auth-algo': 'SHA256withRSA',
    })
    let sent = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/token')) return Response.json({ access_token: 'test' })
        sent = init?.body as string
        return Response.json({ verification_status: 'FAILURE' })
      })
    )
    await expect(new PayPalProvider(config).verifyWebhook(raw, headers)).rejects.toThrow(
      'invalid_webhook_signature'
    )
    expect(sent).toContain('"webhook_event":' + raw)
    await expect(new PayPalProvider(config).verifyWebhook(raw, new Headers())).rejects.toThrow(
      'invalid_webhook_signature'
    )
  })
  it('never reports a cancellation success from an ambiguous provider response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/token')
          ? Response.json({ access_token: 'test' })
          : new Response('unavailable', { status: 503 })
      )
    )
    await expect(new PayPalProvider(config).cancel(subscription().id)).rejects.toThrow(
      'paypal_response_unconfirmed'
    )
  })
})
