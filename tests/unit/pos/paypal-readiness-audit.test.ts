import { createElement, Profiler } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import BillingClient from '@/app/billing/BillingClient'
import { PayPalProvider } from '@/lib/billing/paypal/provider'
import type { PayPalConfig } from '@/lib/billing/paypal/config'
import { cancelSchema } from '@/lib/billing/paypal/contracts'

const config: PayPalConfig = {
  environment: 'sandbox',
  clientId: 'synthetic-client',
  secret: 'synthetic-secret',
  planId: 'P-ABCDEFGHIJKLMNOPQRSTUVWX',
  webhookId: 'synthetic-webhook',
  base: 'https://api-m.sandbox.paypal.com',
  origin: 'http://localhost',
}
const branch = '10000000-0000-4000-8000-000000000001'
const actor = '10000000-0000-4000-8000-000000000002'
const first = '10000000-0000-4000-8000-000000000003'
const second = '10000000-0000-4000-8000-000000000004'
const transaction = {
  id: 'TX-ABCDE12345',
  status: 'COMPLETED',
  time: '2026-10-15T00:00:00Z',
  amount_with_breakdown: { gross_amount: { currency_code: 'USD', value: '100.00' } },
}
function mockTransactions(body: unknown) {
  const fetcher = vi.fn(async (url: string | URL | Request) =>
    Response.json(String(url).endsWith('/token') ? { access_token: 'synthetic-token' } : body)
  )
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
function transactions() {
  return new PayPalProvider(config).transactions(
    'I-ABCDEF123456',
    '2026-10-01T00:00:00Z',
    '2026-10-16T00:00:00Z'
  )
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('PayPal transaction completeness before checkpoint advancement', () => {
  it('accepts a complete provider result and converts exact cents', async () => {
    mockTransactions({ transactions: [transaction], total_items: 1, total_pages: 1, links: [] })
    expect(await transactions()).toEqual([
      {
        id: transaction.id,
        status: 'COMPLETED',
        time: transaction.time,
        amountCents: 10000,
        currency: 'USD',
      },
    ])
  })
  it.each([
    { transactions: [transaction], total_items: 2, total_pages: 2, links: [] },
    { transactions: [transaction], total_items: 2, total_pages: 1, links: [] },
    {
      transactions: [transaction],
      links: [{ rel: 'next', href: 'https://untrusted.invalid/next' }],
    },
  ])(
    'rejects an explicitly incomplete result without following provider URLs: %j',
    async (body) => {
      const fetcher = mockTransactions(body)
      await expect(transactions()).rejects.toThrow('paypal_transactions_unconfirmed')
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(config.base))).toBe(true)
    }
  )
  it.each([
    { transactions: [transaction], total_items: '1' },
    { transactions: [transaction], total_pages: 0 },
    { transactions: [], total_pages: -1 },
    { transactions: [transaction], links: null },
  ])('rejects malformed completeness metadata: %j', async (body) => {
    mockTransactions(body)
    await expect(transactions()).rejects.toThrow('paypal_transactions_unconfirmed')
  })
  it('accepts an empty complete window and optional metadata omission', async () => {
    mockTransactions({ transactions: [], total_items: 0, total_pages: 0 })
    expect(await transactions()).toEqual([])
    mockTransactions({ transactions: [transaction] })
    expect(await transactions()).toHaveLength(1)
  })
  it('rejects foreign currency and malformed transaction data', async () => {
    mockTransactions({
      transactions: [
        {
          ...transaction,
          amount_with_breakdown: { gross_amount: { currency_code: 'AED', value: '100.00' } },
        },
      ],
    })
    await expect(transactions()).rejects.toThrow()
  })
})

describe('branch billing cancellation consent belongs to one agreement', () => {
  it('requires exact agreement identity in cancellation API payload', () => {
    expect(cancelSchema.safeParse({ branchId: branch, confirmCancellation: true }).success).toBe(
      false
    )
    expect(
      cancelSchema.parse({ branchId: branch, subscriptionId: first, confirmCancellation: true })
    ).toMatchObject({ subscriptionId: first })
  })
  it('sends the displayed agreement identity when cancelling', async () => {
    const fetcher = vi.fn(async (url: string) =>
      Response.json(
        url === '/api/pos/bootstrap'
          ? { userId: actor, branches: [{ id: branch, name: 'Synthetic branch', role: 'manager' }] }
          : {
              environment: 'sandbox',
              transactions: [],
              subscription: {
                id: first,
                status: 'ACTIVE',
                checked_at: null,
                next_billing_time: null,
                last_payment_cents: null,
                last_payment_at: null,
              },
            }
      )
    )
    vi.stubGlobal('fetch', fetcher)
    render(createElement(BillingClient))
    fireEvent.click(
      await screen.findByRole('checkbox', {
        name: 'Stop future recurring payments for this branch.',
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel recurring subscription' }))
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        '/api/billing/paypal/cancel',
        expect.objectContaining({
          body: JSON.stringify({
            branchId: branch,
            subscriptionId: first,
            confirmCancellation: true,
          }),
        })
      )
    )
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'The latest status below was confirmed with PayPal.'
      )
    )
  })

  it('requires new cancellation consent after another manager replaces the agreement', async () => {
    let subscriptionId = first
    const body = () => ({
      environment: 'sandbox',
      transactions: [],
      subscription: {
        id: subscriptionId,
        status: 'ACTIVE',
        checked_at: null,
        next_billing_time: null,
        last_payment_cents: null,
        last_payment_at: null,
      },
    })
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/pos/bootstrap')
        return Response.json({
          userId: actor,
          branches: [{ id: branch, name: 'Synthetic branch', role: 'manager' }],
        })
      if (url.endsWith('/reconcile')) {
        subscriptionId = second
        return Response.json({ status: 'reconciled' })
      }
      return Response.json(body())
    })
    vi.stubGlobal('fetch', fetcher)
    const replacementCommits: { checked: boolean; disabled: boolean }[] = []
    render(
      createElement(
        Profiler,
        {
          id: 'billing-consent',
          onRender: () => {
            // Inspect the actual commit, before passive effects could repair it.
            // Waiting for an effect would hide the original unsafe render.
            const status = screen.queryByRole('status')
            if (
              !status?.textContent?.includes('The latest status below was confirmed with PayPal.')
            )
              return
            const checkbox = screen.getByRole('checkbox', {
              name: 'Stop future recurring payments for this branch.',
            }) as HTMLInputElement
            const button = screen.getByRole('button', {
              name: 'Cancel recurring subscription',
            }) as HTMLButtonElement
            replacementCommits.push({ checked: checkbox.checked, disabled: button.disabled })
          },
        },
        createElement(BillingClient)
      )
    )
    const consent = await screen.findByRole('checkbox', {
      name: 'Stop future recurring payments for this branch.',
    })
    fireEvent.click(consent)
    expect(screen.getByRole('button', { name: 'Cancel recurring subscription' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Check PayPal' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'The latest status below was confirmed with PayPal.'
      )
    )
    expect(
      screen.getByRole('checkbox', { name: 'Stop future recurring payments for this branch.' })
    ).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Cancel recurring subscription' })).toBeDisabled()
    expect(replacementCommits.length).toBeGreaterThan(0)
    expect(replacementCommits.every((commit) => !commit.checked && commit.disabled)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel recurring subscription' }))
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/cancel'))).toBe(false)
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Stop future recurring payments for this branch.' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel recurring subscription' }))
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        '/api/billing/paypal/cancel',
        expect.objectContaining({
          body: JSON.stringify({
            branchId: branch,
            subscriptionId: second,
            confirmCancellation: true,
          }),
        })
      )
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check PayPal' })).toBeEnabled())
  })
})
