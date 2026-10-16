import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import OfferManager from '@/components/pos/offers/OfferManager'
import OfferPicker from '@/components/pos/offers/OfferPicker'
import { quoteOffer, type Offer } from '@/lib/pos/offers'
const branchId = '10000000-0000-4000-8000-000000000001',
  deviceId = '20000000-0000-4000-8000-000000000001'
const products = [
  {
    id: '30000000-0000-4000-8000-000000000001',
    branchId,
    name: 'Tea',
    category: 'Drinks',
    imageUrl: null,
    unit: 'piece',
    unitPriceFils: 500,
    taxRateBps: 500,
    active: true,
    revision: 1,
  },
  {
    id: '30000000-0000-4000-8000-000000000002',
    branchId,
    name: 'Snack pack',
    category: 'Snacks',
    imageUrl: null,
    unit: 'pack',
    unitPriceFils: 1000,
    taxRateBps: 500,
    active: true,
    revision: 1,
  },
]
const offer: Offer = {
  id: '40000000-0000-4000-8000-000000000001',
  branchId,
  revision: 1,
  name: 'Tea time',
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
const lines = [
  {
    productId: products[0].id,
    quantityMilli: 3000,
    expectedUnitPriceFils: 500,
    expectedTaxRateBps: 500,
    expectedRevision: 1,
  },
]
const quote = quoteOffer(
  offer,
  [
    {
      productId: products[0].id,
      category: 'Drinks',
      unit: 'piece',
      quantityMilli: 3000,
      unitPriceFils: 500,
      taxRateBps: 500,
    },
  ],
  {
    branchId,
    now: '2026-10-16T10:00:00Z',
    serviceType: 'takeaway',
    role: 'manager',
    coupon: null,
    customerId: null,
    redemptionsUsed: 0,
    customerRedemptionsUsed: 0,
  }
)
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const quoteResponse = {
  status: 'ready',
  branchId,
  evaluatedAt: '2026-10-16T10:00:00Z',
  quotes: [quote],
}
const listResponse = { status: 'ready', offers: [{ offer, redemptionsUsed: 2 }] }
function mockManager(post?: (body: Record<string, unknown>) => Promise<Response>) {
  return vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST')
      return post ? post(JSON.parse(options.body as string)) : response({}, 503)
    return response(url.includes('catalogue') ? { status: 'ready', products } : listResponse)
  })
}
async function newOffer() {
  fireEvent.click(await screen.findByRole('button', { name: 'Create offer' }))
  fireEvent.change(screen.getByLabelText('Offer name'), { target: { value: 'Lunch deal' } })
  fireEvent.change(screen.getByLabelText('Reason for this change'), {
    target: { value: 'Approved lunch campaign' },
  })
}
beforeEach(() => {
  sessionStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('writes an immutable percentage command with Dubai windows and unsupported customer limits null', async () => {
  const fetch = mockManager()
  vi.stubGlobal('fetch', fetch)
  render(<OfferManager branchId={branchId} deviceId={deviceId} disabled={false} />)
  await newOffer()
  fireEvent.change(screen.getByLabelText('Percentage off (%)'), { target: { value: '12.50' } })
  fireEvent.change(screen.getByLabelText('Maximum saving (AED, optional)'), {
    target: { value: '20' },
  })
  fireEvent.change(screen.getByLabelText('Coupon code (optional)'), {
    target: { value: 'lunch_10' },
  })
  fireEvent.change(screen.getByLabelText('Starts at (optional)'), {
    target: { value: '2026-10-16T12:00' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add weekly happy hour' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save offer' }))
  await screen.findByRole('button', { name: 'Retry saved change' })
  const first = JSON.parse(
    fetch.mock.calls.find(([, options]) => options?.method === 'POST')![1]!.body as string
  )
  expect(first.offer).toMatchObject({
    perCustomerLimit: null,
    coupon: 'LUNCH_10',
    benefit: { kind: 'percentage', basisPoints: 1250, maximumDiscountFils: 2000 },
    schedule: {
      startsAt: '2026-10-16T08:00:00.000Z',
      windows: [{ startMinute: 960, endMinute: 1140, weekdays: [1, 2, 3, 4, 5, 6, 7] }],
    },
  })
  expect(JSON.parse(sessionStorage.getItem(`pos-offer-request:${branchId}:${deviceId}`)!)).toEqual(
    first
  )
  expect(screen.getByRole('button', { name: 'Save offer' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Retry saved change' }))
  await waitFor(() =>
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(2)
  )
  expect(
    JSON.parse(
      fetch.mock.calls.filter(([, options]) => options?.method === 'POST')[1][1]!.body as string
    )
  ).toEqual(first)
})
it.each(['fixed', 'buy_x_get_y', 'bundle'] as const)(
  'creates structured %s definition',
  async (kind) => {
    const fetch = mockManager()
    vi.stubGlobal('fetch', fetch)
    render(<OfferManager branchId={branchId} deviceId={deviceId} disabled={false} />)
    await newOffer()
    fireEvent.change(screen.getByLabelText('Saving type'), { target: { value: kind } })
    if (kind === 'fixed') {
      fireEvent.change(screen.getByLabelText('Saving (AED)'), { target: { value: '2.50' } })
      fireEvent.change(screen.getByLabelText('Eligible items'), { target: { value: 'categories' } })
      fireEvent.click(screen.getByLabelText('Drinks'))
    }
    if (kind === 'buy_x_get_y') {
      fireEvent.change(screen.getByLabelText('Eligible items'), { target: { value: 'products' } })
      fireEvent.click(screen.getByLabelText('Tea · piece'))
    }
    if (kind === 'bundle') {
      fireEvent.change(screen.getByLabelText('Price per complete bundle (AED)'), {
        target: { value: '12' },
      })
      fireEvent.change(screen.getByLabelText('Bundle item 1'), {
        target: { value: products[0].id },
      })
      fireEvent.change(screen.getByLabelText('Bundle item 2'), {
        target: { value: products[1].id },
      })
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save offer' }))
    await screen.findByRole('button', { name: 'Retry saved change' })
    const sent = JSON.parse(
      fetch.mock.calls.find(([, options]) => options?.method === 'POST')![1]!.body as string
    )
    expect(sent.offer.benefit).toEqual(
      kind === 'fixed'
        ? { kind, amountFils: 250, eligibility: { scope: 'categories', categories: ['Drinks'] } }
        : kind === 'buy_x_get_y'
          ? {
              kind,
              buyUnits: 2,
              freeUnits: 1,
              eligibility: { scope: 'products', productIds: [products[0].id] },
            }
          : {
              kind,
              priceFils: 1200,
              components: [
                { productId: products[0].id, units: 1 },
                { productId: products[1].id, units: 1 },
              ],
            }
    )
  }
)
it('restores pending change after remount and never creates a new request ID', async () => {
  const { branchId: _, revision: __, ...definition } = offer
  void _
  void __
  const command = {
    id: '50000000-0000-4000-8000-000000000001',
    branchId,
    deviceId,
    expectedRevision: 1,
    reason: 'Retry original',
    offer: definition,
  }
  sessionStorage.setItem(`pos-offer-request:${branchId}:${deviceId}`, JSON.stringify(command))
  const fetch = mockManager(async () =>
    response({
      status: 'updated',
      requestId: command.id,
      replayed: true,
      offer: { ...offer, revision: 2 },
    })
  )
  vi.stubGlobal('fetch', fetch)
  render(<OfferManager branchId={branchId} deviceId={deviceId} disabled={false} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Retry saved change' }))
  await screen.findByText(/Tea time saved/)
  expect(sessionStorage.getItem(`pos-offer-request:${branchId}:${deviceId}`)).toBeNull()
  expect(
    JSON.parse(
      fetch.mock.calls.find(([, options]) => options?.method === 'POST')![1]!.body as string
    )
  ).toEqual(command)
})
it('does not send any change when storage fails', async () => {
  const fetch = mockManager()
  vi.stubGlobal('fetch', fetch)
  render(<OfferManager branchId={branchId} deviceId={deviceId} disabled={false} />)
  await newOffer()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('full')
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save offer' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('No change was sent')
  expect(fetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})
it('does not clear the journal after a mismatched acknowledgement', async () => {
  const fetch = mockManager(async (body) =>
    response({
      status: 'updated',
      requestId: body.id,
      replayed: false,
      offer: { ...offer, revision: 1 },
    })
  )
  vi.stubGlobal('fetch', fetch)
  render(<OfferManager branchId={branchId} deviceId={deviceId} disabled={false} />)
  await newOffer()
  fireEvent.click(screen.getByRole('button', { name: 'Save offer' }))
  await screen.findByText(/could not be confirmed/)
  expect(sessionStorage.getItem(`pos-offer-request:${branchId}:${deviceId}`)).not.toBeNull()
})
it('clears a chosen quote on coupon and basket changes but retains it when disabled during payment', async () => {
  const onSelection = vi.fn()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(quoteResponse))
  )
  const props = { branchId, serviceType: 'takeaway' as const, lines, disabled: false, onSelection }
  const view = render(<OfferPicker {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Check offers' }))
  fireEvent.click(await screen.findByRole('radio', { name: /Tea time/ }))
  expect(onSelection).toHaveBeenLastCalledWith(
    { offerId: offer.id, expectedRevision: 1, couponCode: null, expectedDiscountFils: 150 },
    quote
  )
  view.rerender(<OfferPicker {...props} disabled />)
  expect(onSelection.mock.calls.at(-1)?.[0]?.offerId).toBe(offer.id)
  view.rerender(<OfferPicker {...props} />)
  fireEvent.change(screen.getByLabelText('Coupon code (optional)'), {
    target: { value: 'NEWCODE' },
  })
  expect(onSelection).toHaveBeenLastCalledWith(null, null)
  expect(screen.queryByRole('radio', { name: /Tea time/ })).toBeNull()
  view.rerender(<OfferPicker {...props} lines={[{ ...lines[0], quantityMilli: 4000 }]} />)
  expect(onSelection).toHaveBeenLastCalledWith(null, null)
})
it('rejects a stale quote response after service changes', async () => {
  let resolve!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        })
    )
  )
  const onSelection = vi.fn()
  const view = render(
    <OfferPicker
      branchId={branchId}
      serviceType="takeaway"
      lines={lines}
      disabled={false}
      onSelection={onSelection}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Check offers' }))
  view.rerender(
    <OfferPicker
      branchId={branchId}
      serviceType="delivery"
      lines={lines}
      disabled={false}
      onSelection={onSelection}
    />
  )
  await act(async () => resolve(response(quoteResponse)))
  expect(screen.queryByRole('radio', { name: /Tea time/ })).toBeNull()
  expect(onSelection).toHaveBeenLastCalledWith(null, null)
})
it('does not offer malformed or other-branch quote results', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ ...quoteResponse, branchId: deviceId }))
  )
  render(
    <OfferPicker
      branchId={branchId}
      serviceType="takeaway"
      lines={lines}
      disabled={false}
      onSelection={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Check offers' }))
  await screen.findByRole('alert')
  expect(screen.queryByRole('radio', { name: /Tea time/ })).toBeNull()
})
it('clears only a definite stale edit rejection and reloads before allowing a new edit', async () => {
  let latest = false
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      latest = true
      return response({ code: 'offer_conflict' }, 409)
    }
    return response(
      url.includes('catalogue')
        ? { status: 'ready', products }
        : {
            status: 'ready',
            offers: [{ offer: { ...offer, revision: latest ? 2 : 1 }, redemptionsUsed: 2 }],
          }
    )
  })
  vi.stubGlobal('fetch', fetch)
  render(<OfferManager branchId={branchId} deviceId={deviceId} disabled={false} />)
  fireEvent.click(await screen.findByRole('button', { name: /Tea time/ }))
  fireEvent.change(screen.getByLabelText('Reason for this change'), {
    target: { value: 'Change it' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save offer' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Another manager changed')
  expect(sessionStorage.getItem(`pos-offer-request:${branchId}:${deviceId}`)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Tea time/ }))
  expect(screen.getByText(/Current version 2/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Save offer' })).toBeEnabled()
})
it('keeps a request conflict or a failed removal paused instead of replacing the request', async () => {
  const fetch = mockManager(async () => response({ code: 'request_conflict' }, 409))
  vi.stubGlobal('fetch', fetch)
  render(<OfferManager branchId={branchId} deviceId={deviceId} disabled={false} />)
  await newOffer()
  fireEvent.click(screen.getByRole('button', { name: 'Save offer' }))
  await screen.findByText(/could not be confirmed/)
  expect(sessionStorage.getItem(`pos-offer-request:${branchId}:${deviceId}`)).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Create offer' })).toBeDisabled()
})
it('pauses if removing a definitively rejected request from storage fails', async () => {
  const fetch = mockManager(async () => response({ code: 'invalid_offer_update' }, 422))
  vi.stubGlobal('fetch', fetch)
  render(<OfferManager branchId={branchId} deviceId={deviceId} disabled={false} />)
  await newOffer()
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new Error('storage unavailable')
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save offer' }))
  await screen.findByText(/rejected change could not be cleared/)
  expect(screen.getByRole('button', { name: 'Create offer' })).toBeDisabled()
  expect(sessionStorage.getItem(`pos-offer-request:${branchId}:${deviceId}`)).not.toBeNull()
})
it('distinguishes confirmed save from a subsequent refresh failure', async () => {
  let saved = false
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(options.body as string)
      saved = true
      return response({
        status: 'updated',
        requestId: body.id,
        replayed: false,
        offer: { ...body.offer, branchId, revision: 1 },
      })
    }
    if (saved) return response({}, 503)
    return response(url.includes('catalogue') ? { status: 'ready', products } : listResponse)
  })
  vi.stubGlobal('fetch', fetch)
  render(<OfferManager branchId={branchId} deviceId={deviceId} disabled={false} />)
  await newOffer()
  fireEvent.click(screen.getByRole('button', { name: 'Save offer' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('offer was saved')
  expect(sessionStorage.getItem(`pos-offer-request:${branchId}:${deviceId}`)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Retry saved change' })).toBeNull()
})
it('failed initial loading is unavailable rather than an empty editable list', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({}, 503))
  )
  render(<OfferManager branchId={branchId} deviceId={deviceId} disabled={false} />)
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: 'Create offer' })).toBeDisabled()
  expect(screen.queryByText(/No offers yet/)).toBeNull()
})
