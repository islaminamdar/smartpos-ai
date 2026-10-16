import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import LiveCounter from '@/components/pos/LiveCounter'
import { quoteOffer, type Offer } from '@/lib/pos/offers'
import type { LiveBootstrap, LiveOrder } from '@/lib/pos/server/live-contracts'
import { fiscalDocumentSchema } from '@/lib/pos/server/documents'
import type { PendingOnlineRequest } from '@/lib/pos/online-journal'
const journal = vi.hoisted(() => ({
  current: null as PendingOnlineRequest | null,
  save: vi.fn(),
  ack: vi.fn(),
}))
vi.mock('@/lib/pos/online-journal', () => ({
  readPendingRequest: async (actorId: string) =>
    journal.current?.actorId === actorId ? structuredClone(journal.current) : null,
  savePendingRequest: async (request: PendingOnlineRequest) => {
    journal.save(request)
    if (journal.current) throw new Error('Already pending')
    journal.current = structuredClone(request)
  },
  acknowledgePendingRequest: async (actorId: string, id: string) => {
    journal.ack(actorId, id)
    if (journal.current?.id !== id || journal.current.actorId !== actorId)
      throw new Error('Mismatch')
    journal.current = null
  },
}))
vi.mock('@/lib/pos/tab-kitchen-journal', () => ({
  readPendingTabKitchenRequests: async () => [],
  tabKitchenJournalEvent: 'test-tab-kitchen',
}))
vi.mock('@/lib/pos/open-order-journal', () => ({
  readPendingOpenOrderRequests: async () => [],
  openOrderJournalEvent: 'test-open-order-journal',
  savePendingOpenOrderRequest: vi.fn(),
  acknowledgeOpenOrderRequest: vi.fn(),
}))
const id = (digit: number) => `${digit}0000000-0000-4000-8000-000000000001`
const branchId = id(1),
  deviceId = id(2),
  productId = id(3),
  actorId = id(4),
  profileId = id(5),
  shiftId = id(6)
const merchant = {
  id: profileId,
  organizationId: id(7),
  branchId,
  legalName: 'Synthetic offers merchant',
  branchName: 'Test branch',
  address: 'Test address',
  phone: 'Test phone',
  trn: '100000000000001',
  taxRegistered: true as const,
  currency: 'AED' as const,
  timezone: 'Asia/Dubai' as const,
  taxInclusive: true as const,
  calculationVersion: 'line-v2' as const,
  confirmedBy: actorId,
  confirmedAt: '2026-10-16T00:00:00Z',
}
const boot: LiveBootstrap = {
  status: 'ready',
  userId: actorId,
  branches: [
    {
      id: branchId,
      organizationId: id(7),
      name: 'Test branch',
      role: 'manager',
      canSell: true,
      canRefund: true,
      canManageCash: true,
      profile: merchant,
    },
  ],
  catalogue: [
    {
      id: productId,
      branchId,
      name: 'Test tea',
      category: 'Drinks',
      imageUrl: null,
      unit: 'piece',
      unitPriceFils: 500,
      taxRateBps: 500,
      revision: 1,
    },
  ],
  device: { id: deviceId, branchId, name: 'Synthetic counter' },
  shifts: [
    {
      id: shiftId,
      branchId,
      deviceId,
      openedBy: actorId,
      openedAt: '2026-10-16T00:00:00Z',
      openingCashFils: 10000,
      expectedCashFils: 10000,
    },
  ],
  capabilities: { onlineSales: true, offlineSales: false },
}
const offer: Offer = {
  id: id(8),
  branchId,
  revision: 1,
  name: 'Test tea saving',
  active: true,
  benefit: {
    kind: 'percentage',
    basisPoints: 1000,
    maximumDiscountFils: null,
    eligibility: { scope: 'all' },
  },
  schedule: { timezone: 'Asia/Dubai', startsAt: null, endsAt: null, windows: [] },
  minimumSpendFils: 0,
  serviceTypes: ['takeaway', 'dine_in', 'delivery'],
  managerOnly: false,
  coupon: null,
  totalRedemptionsLimit: null,
  perCustomerLimit: null,
}
const quoteFor = (order: Pick<LiveOrder, 'lines' | 'serviceType'>, definition = offer) => {
  const quote = quoteOffer(
    definition,
    order.lines.map((line) => ({
      productId: line.productId,
      category: 'Drinks',
      unit: 'piece',
      quantityMilli: line.quantityMilli,
      unitPriceFils: line.expectedUnitPriceFils,
      taxRateBps: line.expectedTaxRateBps,
    })),
    {
      branchId,
      now: '2026-10-16T10:00:00Z',
      serviceType: order.serviceType,
      role: 'manager',
      coupon: null,
      customerId: null,
      redemptionsUsed: 0,
      customerRedemptionsUsed: 0,
    }
  )
  if (!quote.eligible) throw new Error(quote.reason)
  return quote
}
function invoice(order: LiveOrder) {
  const quote = quoteFor(order)
  return fiscalDocumentSchema.parse({
    schemaVersion: 2,
    id: id(9),
    kind: 'tax_invoice',
    documentNumber: 'TEST-INV-0000000001',
    issuedAt: '2026-10-16T10:00:00Z',
    merchant,
    orderId: order.id,
    branchId,
    deviceId,
    shiftId,
    actorId,
    serviceType: order.serviceType,
    customer: order.customer,
    lines: order.lines.map((line, index) => ({
      lineNumber: index + 1,
      name: 'Test tea',
      unit: 'piece',
      quantityMilli: line.quantityMilli,
      unitPriceFils: line.expectedUnitPriceFils,
      taxRateBps: line.expectedTaxRateBps,
      ...quote.lines[index],
    })),
    totals: {
      beforeDiscountFils: quote.beforeDiscountFils,
      discountFils: quote.discountFils,
      grossFils: quote.grossFils,
      netFils: quote.netFils,
      taxFils: quote.taxFils,
    },
    payments: order.payments,
    paymentSettlement: 'recorded',
    cashTenderedFils: order.cashTenderedFils,
    changeFils: 0,
    appliedOffer: quote,
  })
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
function api(save: (order: LiveOrder) => Response | Promise<Response>) {
  return vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/pos/bootstrap') return response(boot)
    if (url.startsWith('/api/pos/open-orders?'))
      return response({
        status: 'ready',
        organizationId: id(7),
        branchId,
        actorRole: 'manager',
        generatedAt: '2026-10-16T00:00:00Z',
        tables: [],
        openTabs: [],
        openCount: 0,
        openNextCursor: null,
        recentTabs: [],
        recentTruncated: false,
      })
    if (url.startsWith('/api/pos/receipts')) return response({ receipts: [], nextCursor: null })
    if (url === '/api/pos/offers/quote') {
      const body = JSON.parse(options?.body as string)
      return response({
        status: 'ready',
        branchId,
        evaluatedAt: '2026-10-16T10:00:00Z',
        quotes: [quoteFor(body)],
      })
    }
    if (url === '/api/pos/sync') {
      const { order } = JSON.parse(options?.body as string)
      expect(journal.current?.id).toBe(order.id)
      return save(order)
    }
    throw new Error(`Unexpected test endpoint: ${url}`)
  })
}
async function selectOffer() {
  const product = await screen.findByRole('button', { name: /Test tea/ })
  await waitFor(() => expect(product).toBeEnabled())
  fireEvent.click(product)
  fireEvent.click(screen.getByRole('button', { name: 'Check offers' }))
  fireEvent.click(await screen.findByRole('radio', { name: /Test tea saving/ }))
  expect(screen.getByRole('button', { name: 'Save sale · AED 4.50' })).toBeEnabled()
}
beforeEach(() => {
  journal.current = null
  journal.save.mockClear()
  journal.ack.mockClear()
  sessionStorage.clear()
  vi.stubGlobal('scrollTo', vi.fn())
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it.each(['basket', 'service', 'coupon'] as const)(
  'removes the discounted checkout amount when %s changes',
  async (change) => {
    vi.stubGlobal(
      'fetch',
      api(() => response({}, 503))
    )
    render(<LiveCounter />)
    await selectOffer()
    if (change === 'basket')
      fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '2' } })
    if (change === 'service')
      fireEvent.change(screen.getByLabelText('Order type'), { target: { value: 'delivery' } })
    if (change === 'coupon')
      fireEvent.change(screen.getByLabelText('Coupon code (optional)'), {
        target: { value: 'OTHER' },
      })
    expect(
      screen.getByRole('button', {
        name: `Save sale · AED ${change === 'basket' ? '10.00' : '5.00'}`,
      })
    ).toBeEnabled()
    expect(screen.queryByText('Before offer')).toBeNull()
  }
)
it('persists offer identity and discounted payments before dispatch and accepts the matching fiscal ACK', async () => {
  let saved: LiveOrder | undefined
  vi.stubGlobal(
    'fetch',
    api((order) => {
      saved = order
      return response({ status: 'synced', orderId: order.id, receipt: invoice(order) })
    })
  )
  render(<LiveCounter />)
  await selectOffer()
  fireEvent.click(screen.getByRole('button', { name: 'Save sale · AED 4.50' }))
  await waitFor(() => expect(journal.ack).toHaveBeenCalledTimes(1))
  expect(saved).toMatchObject({
    expectedTotalFils: 450,
    cashTenderedFils: 450,
    offerSelection: {
      offerId: offer.id,
      expectedRevision: 1,
      couponCode: null,
      expectedDiscountFils: 50,
    },
    payments: [{ method: 'cash', amountFils: 450 }],
  })
  expect(journal.current).toBeNull()
  expect(await screen.findByText('TEST-INV-0000000001 saved on the server.')).toBeInTheDocument()
})
it.each(['product', 'offer'] as const)(
  'retains the pending sale when a well-formed same-total ACK changes its %s',
  async (mismatch) => {
    vi.stubGlobal(
      'fetch',
      api((order) => {
        const receipt = invoice(order)
        if (receipt.schemaVersion !== 2) throw new Error('Expected v2')
        if (mismatch === 'product') {
          receipt.lines[0].productId = id(7)
          receipt.appliedOffer.lines[0].productId = id(7)
        } else {
          receipt.appliedOffer.offerId = id(7)
          receipt.appliedOffer.appliedDefinition.id = id(7)
        }
        // Establish this is a valid fiscal document, not a schema-error-only test.
        fiscalDocumentSchema.parse(receipt)
        return response({ status: 'synced', orderId: order.id, receipt })
      })
    )
    render(<LiveCounter />)
    await selectOffer()
    fireEvent.click(screen.getByRole('button', { name: 'Save sale · AED 4.50' }))
    await screen.findByText('Invoice amounts did not match the saved sale.')
    expect(journal.ack).not.toHaveBeenCalled()
    expect(journal.current).not.toBeNull()
    expect(screen.queryByText('TEST-INV-0000000001 saved on the server.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save sale · AED 4.50' })).toBeDisabled()
  }
)
it('retries the original offered request after response loss and remount without taking another payment', async () => {
  let attempts = 0
  const sent: LiveOrder[] = []
  vi.stubGlobal(
    'fetch',
    api((order) => {
      sent.push(structuredClone(order))
      if (++attempts === 1) throw new Error('lost reply')
      return response({ status: 'synced', orderId: order.id, receipt: invoice(order) })
    })
  )
  const view = render(<LiveCounter />)
  await selectOffer()
  fireEvent.click(screen.getByRole('button', { name: 'Save sale · AED 4.50' }))
  await screen.findByText(
    'No server confirmation received. Check your connection and retry the saved request.'
  )
  expect(journal.current?.body).toEqual({ order: sent[0] })
  view.unmount()
  render(<LiveCounter />)
  fireEvent.click(await screen.findByRole('button', { name: /Recover saved request/ }))
  await waitFor(() => expect(journal.ack).toHaveBeenCalledTimes(1))
  expect(sent).toHaveLength(2)
  expect(sent[1]).toEqual(sent[0])
  expect(journal.save).toHaveBeenCalledTimes(1)
})

it.each(['Name', 'Address', 'TRN, if registered'])(
  'rejects a new web buyer hidden null character in %s before journal/save',
  async (label) => {
    const save = vi.fn(() => response({}, 503))
    vi.stubGlobal('fetch', api(save))
    render(<LiveCounter />)
    await selectOffer()
    fireEvent.click(screen.getByText('Customer details for the invoice'))
    fireEvent.change(screen.getByLabelText('Name', { exact: true }), {
      target: { value: 'عميل 😀' },
    })
    fireEvent.change(screen.getByLabelText('Address', { exact: true }), {
      target: { value: 'دبي' },
    })
    const field = screen.getByLabelText(label, { exact: true })
    fireEvent.change(field, { target: { value: 'A\u0000B' } })
    expect(field).toHaveValue('A\u0000B')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(
      screen.getByText(/Customer details contain an unsupported hidden character/)
    ).toBeVisible()
    const button = screen.getByRole('button', { name: 'Save sale · AED 4.50' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(journal.save).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: label === 'TRN, if registered' ? '' : 'دبي 😀' } })
    expect(button).toBeEnabled()
  }
)
