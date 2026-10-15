import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ session: vi.fn(), serviceRole: vi.fn() }))
vi.mock('@/lib/auth/session', () => ({ requireSession: mocks.session }))
vi.mock('@/lib/db/supabase', () => ({ createServiceRole: mocks.serviceRole }))
// Real SDK/module imports verify there is no module-level initialization failure.
import { getStripeClient } from '@/lib/billing/stripe'
import { POST as webhook } from '@/app/api/stripe/webhook/route'
import { POST as checkout } from '@/app/api/billing/checkout/route'

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_PRICE_STARTER','NEXT_PUBLIC_APP_URL']) vi.stubEnv(key, '')
})
afterEach(() => vi.unstubAllEnvs())
describe('optional legacy Stripe configuration', () => {
  it('imports safely and does not construct a client without a configured key', () => {
    expect(getStripeClient()).toBeNull()
    vi.stubEnv('STRIPE_SECRET_KEY', '   ')
    expect(getStripeClient()).toBeNull()
  })
  it('returns 503 before authentication, database work or checkout creation when unconfigured', async () => {
    const response = await checkout()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'BILLING_NOT_CONFIGURED' })
    expect(mocks.session).not.toHaveBeenCalled()
    expect(mocks.serviceRole).not.toHaveBeenCalled()
  })
  it('fails a webhook closed without reading its body or touching the database', async () => {
    const request = new Request('http://localhost/api/stripe/webhook', { method: 'POST', body: '{}' })
    const read = vi.spyOn(request, 'text')
    const response = await webhook(request)
    expect(response.status).toBe(503)
    expect(read).not.toHaveBeenCalled()
    expect(mocks.serviceRole).not.toHaveBeenCalled()
  })
})
