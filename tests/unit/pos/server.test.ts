import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { syncOrderSchema, catalogueLineTotals } from '@/lib/pos/server/contracts'

const mocks = vi.hoisted(() => ({ createServer: vi.fn(), rpc: vi.fn(), getUser: vi.fn() }))
vi.mock('@/lib/db/supabase', () => ({ createServer: mocks.createServer }))
import { POST } from '@/app/api/pos/sync/route'

const id = '00000000-0000-4000-8000-000000000001'
const order = { id, branchId: id, deviceId: id, shiftId: id, createdAt: '2026-10-16T10:00:00Z', serviceType: 'takeaway', lines: [{ productId: id, quantityMilli: 1500, expectedUnitPriceFils: 1050, expectedTaxRateBps: 500 }], payments: [{ method: 'cash', amountFils: 1575 }], expectedTotalFils: 1575 }
const request = (body: unknown, headers: Record<string, string> = {}) => new NextRequest('http://localhost/api/pos/sync', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'public-test-key')
  mocks.createServer.mockResolvedValue({ auth: { getUser: mocks.getUser }, rpc: mocks.rpc })
  mocks.getUser.mockResolvedValue({ data: { user: { id } }, error: null })
})

describe('POS synchronization boundary', () => {
  it('validates weighted sales and rejects fractional fils and unsupported financial adjustments', () => {
    expect(syncOrderSchema.safeParse({ order }).success).toBe(true)
    expect(syncOrderSchema.safeParse({ order: { ...order, discountFils: 100 } }).success).toBe(false)
    expect(syncOrderSchema.safeParse({ order: { ...order, expectedTotalFils: 1.1 } }).success).toBe(false)
    expect(catalogueLineTotals(1050, 1500, 500)).toEqual({ grossFils: 1575, taxFils: 75 })
  })
  it('returns setup-required without initializing Supabase when credentials are absent', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    const result = await POST(request({ order }))
    expect(result.status).toBe(503)
    expect(await result.json()).toMatchObject({ code: 'setup_required' })
    expect(mocks.createServer).not.toHaveBeenCalled()
  })
  it('does not accept unauthenticated training orders', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null })
    expect((await POST(request({ order }))).status).toBe(401)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('rejects cross-origin requests before accessing a session', async () => {
    expect((await POST(request({ order }, { origin: 'https://evil.example' }))).status).toBe(403)
    expect(mocks.createServer).not.toHaveBeenCalled()
  })
  it('never invokes the RPC for invalid sale data', async () => {
    expect((await POST(request({ order: { ...order, expectedTotalFils: -1 } }))).status).toBe(422)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('passes only validated order data and requires a database acknowledgement', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'synced', orderId: id, totalFils: 1575, taxFils: 75, replayed: false }, error: null })
    const response = await POST(request({ order }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(mocks.rpc).toHaveBeenCalledWith('pos_record_paid_order', { p_order: order })
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    expect((await POST(request({ order }))).status).toBe(503)
  })
  it('preserves pending status for stale price conflicts and hides database diagnostics', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'POS_PRICE_CHANGED' } })
    const conflict = await POST(request({ order }))
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ status: 'pending', code: 'POS_PRICE_CHANGED' })
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'private database diagnostic' } })
    const unavailable = await POST(request({ order }))
    expect(unavailable.status).toBe(503)
    expect(JSON.stringify(await unavailable.json())).not.toContain('private database')
  })
})
