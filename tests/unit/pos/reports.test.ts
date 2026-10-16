import { beforeEach, describe, expect, it, vi } from 'vitest'
import { branchReportSchema, dubaiToday, reportQuerySchema } from '@/lib/pos/reports/contracts'
import { reportCsv } from '@/lib/pos/reports/export'
import { branchReport, reportBranch } from '../../fixtures/pos-report'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn() }))
vi.mock('@/lib/pos/server/client', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/client')>()),
  authenticatedPosClient: mocks.auth,
}))
import { GET } from '@/app/api/pos/reports/route'
import { PosServerError } from '@/lib/pos/server/client'
const request = (extra = '') =>
  new Request(
    `https://pos.example/api/pos/reports?branchId=${reportBranch}&start=2026-10-16&end=2026-10-16${extra}`
  )
beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  mocks.auth.mockResolvedValue({ client: { rpc: mocks.rpc }, user: { id: reportBranch } })
  mocks.rpc.mockResolvedValue({ data: branchReport, error: null })
})
describe('authoritative branch reports', () => {
  it('validates actual calendar dates and93inclusive-day bounds', () => {
    const base = { branchId: reportBranch, start: '2026-01-01', end: '2026-04-03' }
    expect(reportQuerySchema.safeParse(base).success).toBe(true)
    for (const query of [
      { ...base, end: '2026-04-04' },
      { ...base, start: '2026-02-30' },
      { ...base, start: '2026-04-04' },
      { ...base, extra: 'untrusted' },
    ])
      expect(reportQuerySchema.safeParse(query).success).toBe(false)
    expect(dubaiToday(new Date('2026-10-15T20:00:00Z'))).toBe('2026-10-16')
  })
  it('rejects unreconciled breakdowns instead of showing false totals', () => {
    expect(branchReportSchema.parse(branchReport)).toEqual(branchReport)
    for (const changed of [
      { ...branchReport, products: [] },
      { ...branchReport, payments: [branchReport.payments[0], branchReport.payments[0]] },
      { ...branchReport, days: [] },
      { ...branchReport, summary: { ...branchReport.summary, netExVatFils: 999 } },
    ])
      expect(branchReportSchema.safeParse(changed).success).toBe(false)
  })
  it('requires pilot and authentication before querying scopedRPC', async () => {
    vi.stubEnv('POS_ONLINE_PILOT', 'false')
    expect((await GET(request())).status).toBe(503)
    expect(mocks.auth).not.toHaveBeenCalled()
    vi.stubEnv('POS_ONLINE_PILOT', 'true')
    mocks.auth.mockRejectedValue(new PosServerError('authentication_required', 401))
    expect((await GET(request())).status).toBe(401)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('returns private matching branch data without accepting role fromcaller', async () => {
    const result = await GET(request())
    expect(result.status).toBe(200)
    expect(result.headers.get('cache-control')).toBe('private, no-store')
    expect(await result.json()).toEqual(branchReport)
    expect(mocks.rpc).toHaveBeenCalledWith('pos_branch_report', {
      p_branch: reportBranch,
      p_start: '2026-10-16',
      p_end: '2026-10-16',
    })
    expect((await GET(request('&role=owner'))).status).toBe(422)
  })
  it('keeps denied, unavailable and mismatched results out of successful zero reports', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'POS_REPORT_ACCESS_DENIED' } })
    expect((await GET(request())).status).toBe(403)
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'private DB failure' } })
    const failed = await GET(request())
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain('private DB failure')
    mocks.rpc.mockResolvedValueOnce({
      data: { ...branchReport, branchId: '10000000-0000-4000-8000-000000000002' },
      error: null,
    })
    expect((await GET(request())).status).toBe(503)
  })
  it('exports aggregate CSV with formula protection and correct filename/currency', async () => {
    const result = await GET(request('&format=csv'))
    expect(result.status).toBe(200)
    expect(result.headers.get('content-type')).toContain('text/csv')
    expect(result.headers.get('content-disposition')).toContain('2026-10-16-to-2026-10-16.csv')
    expect(await result.text()).toContain('Recorded card')
    const csv = reportCsv({
      ...branchReport,
      branchName: '=HYPERLINK("evil")',
      products: [{ ...branchReport.products[0], name: '\t@SUM(1)' }],
    })
    expect(csv).toContain('"\'=HYPERLINK(""evil"")"')
    expect(csv).toContain('"\'\t@SUM(1)"')
    expect(csv).toContain('0.500')
    expect(csv).not.toContain('customer')
  })
})
