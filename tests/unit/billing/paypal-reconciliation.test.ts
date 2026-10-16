// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  get: vi.fn(),
  checkPlan: vi.fn(),
  cancel: vi.fn(),
  transactions: vi.fn(),
  verifyWebhook: vi.fn(),
}))
const config = {
  environment: 'sandbox',
  clientId: 'test',
  secret: 'test',
  planId: 'P-ABCDEFGHIJKLMNOPQRSTUVWX',
  webhookId: 'test',
  base: 'https://api-m.sandbox.paypal.com',
  origin: 'http://127.0.0.1:3048',
}
const row = {
  id: '10000000-0000-4000-8000-000000000001',
  organization_id: '10000000-0000-4000-8000-000000000002',
  branch_id: '10000000-0000-4000-8000-000000000003',
  actor_id: '10000000-0000-4000-8000-000000000004',
  environment: 'sandbox',
  provider_id: 'I-ABCDEF123456',
  plan_id: config.planId,
  status: 'ACTIVE',
  created_at: new Date().toISOString(),
  transactions_checked_through: null,
}
vi.mock('@/lib/pos/server/client', () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: row, error: null }),
  }
  const client = { rpc: mocks.rpc, from: () => chain }
  return {
    posClient: () => client,
    authenticatedPosClient: async () => ({ client, user: { id: row.actor_id } }),
  }
})
vi.mock('@/lib/billing/paypal/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/paypal/config')>()),
  paypalConfig: () => config,
}))
vi.mock('@/lib/billing/paypal/provider', () => ({
  PayPalProvider: class {
    get = mocks.get
    checkPlan = mocks.checkPlan
    cancel = mocks.cancel
    transactions = mocks.transactions
    verifyWebhook = mocks.verifyWebhook
    approval = () => null
  },
}))
import { reconcileBranch, receiveWebhook } from '@/lib/billing/paypal/service'
import { PayPalError } from '@/lib/billing/paypal/config'
beforeEach(() => {
  vi.clearAllMocks()
  mocks.rpc.mockImplementation(async (name: string) => ({
    error: null,
    data:
      name === 'pos_paypal_can_manage'
        ? true
        : name === 'pos_paypal_reserve'
          ? row
          : name === 'pos_paypal_apply'
            ? { status: 'reconciled', reconciliationPending: false }
            : null,
  }))
  mocks.checkPlan.mockRejectedValue(new PayPalError('paypal_plan_mismatch'))
  mocks.get.mockResolvedValue({
    id: row.provider_id,
    plan_id: row.plan_id,
    custom_id: row.id,
    status: 'CANCELLED',
  })
  mocks.transactions.mockResolvedValue([])
  mocks.verifyWebhook.mockResolvedValue(undefined)
})
describe('existing mapped subscription survives commercial plan changes', () => {
  it('does not advance payment checkpoints when the provider result is incomplete', async () => {
    mocks.transactions.mockRejectedValue(new PayPalError('paypal_transactions_unconfirmed'))
    await expect(reconcileBranch(row.branch_id)).rejects.toThrow('paypal_transactions_unconfirmed')
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'pos_paypal_apply')).toBe(false)
    expect(mocks.rpc).toHaveBeenCalledWith(
      'pos_paypal_release',
      expect.objectContaining({ p_id: row.id })
    )
  })

  it.each([undefined, '10000000-0000-4000-8000-000000000099'])(
    'rejects missing or stale cancellation identity after leasing and before provider calls: %s',
    async (expectedId) => {
      await expect(reconcileBranch(row.branch_id, true, expectedId)).rejects.toThrow(
        'paypal_subscription_changed'
      )
      expect(mocks.rpc).toHaveBeenCalledWith(
        'pos_paypal_reserve',
        expect.objectContaining({ p_id: row.id })
      )
      expect(mocks.rpc).toHaveBeenCalledWith(
        'pos_paypal_release',
        expect.objectContaining({ p_id: row.id })
      )
      expect(mocks.get).not.toHaveBeenCalled()
      expect(mocks.cancel).not.toHaveBeenCalled()
      expect(mocks.rpc.mock.calls.some(([name]) => name === 'pos_paypal_apply')).toBe(false)
    }
  )
  it('checks the leased canonical identity rather than only the earlier branch lookup', async () => {
    mocks.rpc.mockImplementation(async (name: string) => ({
      error: null,
      data:
        name === 'pos_paypal_can_manage'
          ? true
          : name === 'pos_paypal_reserve'
            ? { ...row, id: '10000000-0000-4000-8000-000000000099' }
            : null,
    }))
    await expect(reconcileBranch(row.branch_id, true, row.id)).rejects.toThrow(
      'paypal_subscription_changed'
    )
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('reconciles canonical cancellation while marking plan review required', async () => {
    await reconcileBranch(row.branch_id)
    expect(mocks.get).toHaveBeenCalledWith(row.provider_id, row.id, row.plan_id)
    const apply = mocks.rpc.mock.calls.find((c) => c[0] === 'pos_paypal_apply')!
    expect(apply[1].p_snapshot).toMatchObject({
      providerId: row.provider_id,
      status: 'CANCELLED',
      priceReviewRequired: true,
    })
    expect(mocks.cancel).not.toHaveBeenCalled()
  })
  it('processes verified lifecycle webhook when plan is inactive', async () => {
    expect(
      await receiveWebhook(
        JSON.stringify({
          id: 'EVT-CANCEL',
          event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
          resource: { id: row.provider_id },
        }),
        new Headers()
      )
    ).toEqual({ status: 'processed' })
    expect(mocks.verifyWebhook).toHaveBeenCalledOnce()
    expect(mocks.get).toHaveBeenCalledWith(row.provider_id, row.id, row.plan_id)
    expect(mocks.rpc.mock.calls.find((c) => c[0] === 'pos_paypal_apply')![1]).toMatchObject({
      p_event: 'EVT-CANCEL',
      p_snapshot: { status: 'CANCELLED', priceReviewRequired: true },
    })
  })
  it('still attempts cancellation and reads it back after a plan change', async () => {
    mocks.get
      .mockResolvedValueOnce({
        id: row.provider_id,
        plan_id: row.plan_id,
        custom_id: row.id,
        status: 'ACTIVE',
      })
      .mockResolvedValueOnce({
        id: row.provider_id,
        plan_id: row.plan_id,
        custom_id: row.id,
        status: 'CANCELLED',
      })
    await reconcileBranch(row.branch_id, true, row.id)
    expect(mocks.cancel).toHaveBeenCalledWith(row.provider_id)
    expect(mocks.get).toHaveBeenCalledTimes(2)
    expect(
      mocks.rpc.mock.calls.find((c) => c[0] === 'pos_paypal_apply')![1].p_snapshot.status
    ).toBe('CANCELLED')
  })
})
