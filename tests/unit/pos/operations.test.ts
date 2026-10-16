import { beforeEach, describe, expect, it, vi } from 'vitest'
import { branchOperationsSchema, operationsQuerySchema } from '@/lib/pos/operations/contracts'
import { operationFixture } from '../../fixtures/pos-operations'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn() }))
vi.mock('@/lib/pos/server/client', async original => ({
  ...(await original<typeof import('@/lib/pos/server/client')>()), authenticatedPosClient: mocks.auth,
}))
import { GET } from '@/app/api/pos/operations/route'
import { PosServerError } from '@/lib/pos/server/client'

const branch = '10000000-0000-4000-8000-000000000001'
const request = (query = `branchId=${branch}`) => new Request(`https://pos.example/api/pos/operations?${query}`)
beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  mocks.auth.mockResolvedValue({ client: { rpc: mocks.rpc }, user: { id: branch } })
  mocks.rpc.mockResolvedValue({ data: operationFixture(), error: null })
})

describe('operations snapshot consistency', () => {
  it('accepts a complete snapshot with exact money, missing staff name and unknown device coverage', () => {
    expect(branchOperationsSchema.parse(operationFixture())).toEqual(operationFixture())
    expect(operationsQuerySchema.parse({ branchId: branch })).toEqual({ branchId: branch })
  })
  it.each([
    ['wrong currency', (f: any) => { f.currency = 'USD' }],
    ['claimed offline completeness', (f: any) => { f.offlineDeviceCoverage = 'complete' }],
    ['wrong Dubai date', (f: any) => { f.businessDate = '2026-10-15' }],
    ['invented document count', (f: any) => { f.sales.documentCount++ }],
    ['unbalanced VAT', (f: any) => { f.sales.summary.vatFils++ }],
    ['unbalanced sales', (f: any) => { f.sales.summary.netGrossFils++ }],
    ['duplicate tender', (f: any) => { f.sales.payments[1] = f.sales.payments[0] }],
    ['tender including change', (f: any) => { f.sales.payments[0].salesFils += 1000 }],
    ['partial list posing as complete', (f: any) => { f.openShifts.totalCount = 2 }],
    ['false truncation', (f: any) => { f.openShifts.truncated = true }],
    ['unsafe integer', (f: any) => { f.unpaidOrders.totalFils = Number.MAX_SAFE_INTEGER + 1 }],
    ['fractional fils', (f: any) => { f.unpaidOrders.totalFils += 0.5 }],
    ['missing unpaid order value', (f: any) => { f.unpaidOrders.totalFils++ }],
    ['wrong oldest unpaid order', (f: any) => { f.unpaidOrders.oldestCreatedAt = null }],
    ['extra notice count', (f: any) => { f.kitchen.tabTickets.withUnacknowledgedChanges = 3 }],
    ['closed cash mismatch', (f: any) => { f.closedShifts.items[0].countedCashFils++ }],
    ['closed aggregate mismatch', (f: any) => { f.closedShifts.netDifferenceFils++ }],
    ['missing discrepancy', (f: any) => { f.closedShifts.discrepancyCount = 0 }],
    ['incorrect window start', (f: any) => { f.closedShifts.windowStart = '2026-09-17T00:00:00Z' }],
    ['unsafe private payload', (f: any) => { f.customerPassword = 'should never be returned' }],
  ])('rejects %s rather than presenting a successful dashboard', (_name, change) => {
    const fixture = structuredClone(operationFixture())
    change(fixture)
    expect(branchOperationsSchema.safeParse(fixture).success).toBe(false)
  })
  it('requires incomplete legacy closes to remain unknown in the aggregate', () => {
    const f: any = structuredClone(operationFixture())
    f.closedShifts.items[0].countedCashFils = null
    f.closedShifts.incompleteCount = 1
    f.closedShifts.discrepancyCount = 0
    f.closedShifts.netDifferenceFils = null
    expect(branchOperationsSchema.safeParse(f).success).toBe(true)
    f.closedShifts.netDifferenceFils = 0
    expect(branchOperationsSchema.safeParse(f).success).toBe(false)
  })
  it('preserves PostgreSQL microseconds at an exclusive close-window boundary', () => {
    const f = structuredClone(operationFixture())
    f.generatedAt = '2026-10-16T09:00:00.123900Z'
    f.closedShifts.windowEnd = f.generatedAt
    f.closedShifts.items[0].closedAt = '2026-10-16T09:00:00.123100Z'
    expect(branchOperationsSchema.safeParse(f).success).toBe(true)
    f.closedShifts.items[0].closedAt = '2026-10-16T09:00:00.123900Z'
    expect(branchOperationsSchema.safeParse(f).success).toBe(false)
    f.closedShifts.items[0].closedAt = '2026-10-16T09:00:00.123999Z'
    expect(branchOperationsSchema.safeParse(f).success).toBe(false)
  })
  it('accepts prior-period refunds causing negative daily sales and VAT', () => {
    const f = structuredClone(operationFixture())
    f.sales.summary = {
      invoiceCount: 0, creditNoteCount: 1, salesGrossFils: 0, refundGrossFils: 1050,
      netGrossFils: -1050, netExVatFils: -1000, vatFils: -50,
    }
    f.sales.documentCount = 1
    f.sales.payments = [
      { method: 'cash', salesFils: 0, refundsFils: 1050, netFils: -1050 },
      { method: 'card', salesFils: 0, refundsFils: 0, netFils: 0 },
    ]
    expect(branchOperationsSchema.safeParse(f).success).toBe(true)
  })
  it('requires complete aggregate amounts beyond a capped display list without adding hidden rows', () => {
    const f = structuredClone(operationFixture())
    const row = f.unpaidOrders.items[0]
    f.unpaidOrders.items = Array.from({ length: 20 }, (_, i) => ({
      ...row, id: `10000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`,
    }))
    f.unpaidOrders.totalCount = 21
    f.unpaidOrders.totalFils = row.totalFils * 21
    f.unpaidOrders.truncated = true
    expect(branchOperationsSchema.safeParse(f).success).toBe(true)
    f.unpaidOrders.totalFils = 1
    expect(branchOperationsSchema.safeParse(f).success).toBe(false)
  })
})

describe('operations read endpoint', () => {
  it('requires pilot and verified identity without accepting browser-supplied roles', async () => {
    vi.stubEnv('POS_ONLINE_PILOT', 'false')
    expect((await GET(request())).status).toBe(503)
    expect(mocks.auth).not.toHaveBeenCalled()
    vi.stubEnv('POS_ONLINE_PILOT', 'true')
    mocks.auth.mockRejectedValueOnce(new PosServerError('authentication_required', 401))
    expect((await GET(request())).status).toBe(401)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it.each(['', 'branchId=not-a-uuid', `branchId=${branch}&branchId=${branch}`,
    `branchId=${branch}&role=owner`, `branchId=${branch}&date=2026-10-16`, `branchId=${branch}&limit=100000`])(
    'rejects invalid or ambiguous query %s before a database read', async query => {
      expect((await GET(request(query))).status).toBe(422)
      expect(mocks.rpc).not.toHaveBeenCalled()
    })
  it('returns one private current-actor snapshot without registering a counter', async () => {
    const result = await GET(request())
    expect(result.status).toBe(200)
    expect(result.headers.get('cache-control')).toBe('private, no-store')
    expect(await result.json()).toEqual(operationFixture())
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('pos_branch_operations', { p_branch: branch })
  })
  it.each([
    ['POS_ACCESS_DENIED', 403, 'operations_manager_required'],
    ['POS_OPERATIONS_ACCESS_DENIED', 403, 'operations_manager_required'],
    ['POS_REPORT_PROFILE_REQUIRED', 409, 'operations_profile_required'],
    ['POS_OPERATIONS_TOO_LARGE', 503, 'operations_too_large'],
    ['POS_OPERATIONS_INVALID_DATA', 503, 'operations_unavailable'],
    ['private database failure', 503, 'operations_unavailable'],
  ])('maps %s without leaking internal evidence', async (message, status, code) => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message } })
    const result = await GET(request())
    expect(result.status).toBe(status)
    expect(await result.json()).toEqual({ status: 'unavailable', code })
    expect(result.headers.get('cache-control')).toBe('private, no-store')
  })
  it('rejects wrong branch and malformed results without zero-filled fallbacks', async () => {
    for (const data of [null, {}, { ...operationFixture(), branchId: '20000000-0000-4000-8000-000000000001' }]) {
      mocks.rpc.mockResolvedValueOnce({ data, error: null })
      const result = await GET(request())
      expect(result.status).toBe(503)
      expect(await result.json()).toEqual({ status: 'unavailable', code: 'operations_unavailable' })
    }
  })
})
