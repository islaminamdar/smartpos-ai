import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import fixtures from '../../fixtures/pos-offer-documents.json'
import { offerQuoteResponseSchema, offerResultSchema } from '@/lib/pos/server/offers'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), binding: vi.fn() }))
vi.mock('@/lib/pos/server/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pos/server/client')>()),
  authenticatedPosClient: mocks.auth,
}))
vi.mock('@/lib/pos/server/live-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pos/server/live-access')>()),
  requireDevice: mocks.binding,
}))
import { GET, POST } from '@/app/api/pos/offers/route'
import { POST as QUOTE } from '@/app/api/pos/offers/quote/route'
import { PosServerError } from '@/lib/pos/server/client'
const quoteResponse = offerQuoteResponseSchema.parse(fixtures.quoted)
const receipt = fixtures.receipts[0]
const { couponRequired, ...definition } = quoteResponse.quotes[0].appliedDefinition
const offer = { ...definition, coupon: null }
const { branchId, revision, ...offerInput } = offer
const update = {
  id: receipt.id,
  branchId,
  deviceId: receipt.deviceId,
  expectedRevision: 0,
  reason: 'Synthetic setup',
  offer: offerInput,
}
const result = offerResultSchema.parse({
  status: 'updated',
  requestId: update.id,
  replayed: false,
  offer,
})
const quote = {
  branchId,
  serviceType: 'takeaway',
  lines: receipt.lines.map((line) => ({
    productId: line.productId,
    quantityMilli: line.quantityMilli,
    expectedUnitPriceFils: line.unitPriceFils,
    expectedTaxRateBps: line.taxRateBps,
    expectedRevision: 1,
  })),
  couponCode: null,
}
const req = (path: string, body: unknown, origin = 'http://localhost') =>
  new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
const read = () => new Request(`http://localhost/api/pos/offers?branchId=${branchId}`)
beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  mocks.auth.mockResolvedValue({ client: { rpc: mocks.rpc }, user: { id: receipt.actorId } })
  mocks.binding.mockResolvedValue('private-device-binding')
})
describe('offer management and quote HTTP boundary', () => {
  it('requires enablement, identity, write origin and bound manager device', async () => {
    vi.stubEnv('POS_ONLINE_PILOT', 'false')
    expect((await GET(read())).status).toBe(503)
    expect(mocks.auth).not.toHaveBeenCalled()
    vi.stubEnv('POS_ONLINE_PILOT', 'true')
    expect((await POST(req('/api/pos/offers', update, 'https://outside.example'))).status).toBe(403)
    expect((await QUOTE(req('/api/pos/offers/quote', quote, ''))).status).toBe(403)
    mocks.auth.mockRejectedValueOnce(new PosServerError('authentication_required', 401))
    expect((await GET(read())).status).toBe(401)
    mocks.binding.mockRejectedValueOnce(new PosServerError('device_binding_required', 403))
    expect((await POST(req('/api/pos/offers', update))).status).toBe(403)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('returns private manager responses only for exact matching definitions and revisions', async () => {
    mocks.rpc.mockResolvedValue({
      data: { status: 'ready', offers: [{ offer, redemptionsUsed: 3 }] },
      error: null,
    })
    const listing = await GET(read())
    expect(listing.status).toBe(200)
    expect(listing.headers.get('cache-control')).toBe('private, no-store')
    mocks.rpc.mockResolvedValue({ data: result, error: null })
    expect((await POST(req('/api/pos/offers', update))).status).toBe(200)
    expect(mocks.rpc).toHaveBeenLastCalledWith('pos_manage_offer', {
      p_command: update,
      p_binding: 'private-device-binding',
    })
    for (const altered of [
      { ...offer, revision: 2 },
      { ...offer, name: 'Wrong offer' },
      { ...offer, coupon: 'SECRET' },
    ]) {
      mocks.rpc.mockResolvedValue({ data: { ...result, offer: altered }, error: null })
      expect((await POST(req('/api/pos/offers', update))).status).toBe(503)
    }
  })
  it('maps definitive SQL failures for safe correction, but conceals all internal diagnostics', async () => {
    for (const [sql, code, status] of [
      ['POS_OFFER_CONFLICT', 'offer_conflict', 409],
      ['POS_INVALID_OFFER', 'invalid_offer_update', 422],
      ['POS_OFFER_CUSTOMER_UNSUPPORTED', 'invalid_offer_update', 422],
      ['POS_OFFER_LIMIT_REACHED', 'offer_limit', 422],
      ['POS_MANAGER_REQUIRED', 'manager_access_required', 403],
      ['POS_IDEMPOTENCY_CONFLICT', 'request_conflict', 409],
    ] as const) {
      mocks.rpc.mockResolvedValue({ error: { message: sql } })
      const response = await POST(req('/api/pos/offers', update))
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ code })
    }
    mocks.rpc.mockResolvedValue({ error: { message: 'POS_MANAGER_REQUIRED' } })
    expect((await GET(read())).status).toBe(403)
    mocks.rpc.mockResolvedValue({ error: { message: 'private database detail' } })
    const failed = await GET(read())
    expect(failed.status).toBe(503)
    expect(JSON.stringify(await failed.json())).not.toContain('private database detail')
  })
  it('rejects unsupported customer limits, malformed input, unbounded bodies and duplicate products', async () => {
    expect(
      (
        await POST(
          req('/api/pos/offers', { ...update, offer: { ...offerInput, perCustomerLimit: 1 } })
        )
      ).status
    ).toBe(422)
    expect(
      (
        await QUOTE(
          req('/api/pos/offers/quote', {
            ...quote,
            lines: [
              quote.lines[0],
              { ...quote.lines[0], productId: quote.lines[0].productId.toUpperCase() },
            ],
          })
        )
      ).status
    ).toBe(422)
    expect(
      (
        await QUOTE(
          req('/api/pos/offers/quote', {
            ...quote,
            lines: quote.lines.map(({ expectedRevision, ...line }) => line),
          })
        )
      ).status
    ).toBe(422)
    for (const [handler, path, size] of [
      [POST, '/api/pos/offers', 24001],
      [QUOTE, '/api/pos/offers/quote', 100001],
    ] as const) {
      expect(
        (
          await handler(
            new Request('http://localhost' + path, {
              method: 'POST',
              headers: { origin: 'http://localhost' },
              body: 'x'.repeat(size),
            })
          )
        ).status
      ).toBe(413)
      expect(
        (
          await handler(
            new Request('http://localhost' + path, {
              method: 'POST',
              headers: { origin: 'http://localhost' },
              body: '{',
            })
          )
        ).status
      ).toBe(400)
    }
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('returns only reconciled scoped quotes and rejects wrong basket or VAT allocation', async () => {
    mocks.rpc.mockResolvedValue({ data: quoteResponse, error: null })
    const response = await QUOTE(req('/api/pos/offers/quote', quote))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(mocks.binding).not.toHaveBeenCalled() // Read-only quotation is not permission to write a sale.
    const wrongVat = structuredClone(quoteResponse)
    wrongVat.quotes[0].taxFils++
    wrongVat.quotes[0].netFils--
    wrongVat.quotes[0].lines[0].taxFils++
    wrongVat.quotes[0].lines[0].netFils--
    mocks.rpc.mockResolvedValue({ data: wrongVat, error: null })
    expect((await QUOTE(req('/api/pos/offers/quote', quote))).status).toBe(503)
    mocks.rpc.mockResolvedValue({ data: quoteResponse, error: null })
    expect(
      (
        await QUOTE(
          req('/api/pos/offers/quote', {
            ...quote,
            lines: quote.lines.map((line) => ({ ...line, quantityMilli: 2000 })),
          })
        )
      ).status
    ).toBe(503)
    mocks.rpc.mockResolvedValue({ data: quoteResponse, error: null })
    expect(
      (
        await QUOTE(
          req('/api/pos/offers/quote', {
            ...quote,
            branchId: '00000000-0000-4000-8000-000000000001',
          })
        )
      ).status
    ).toBe(503)
  })
})
