import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import BranchReports from '@/components/pos/reports/BranchReports'
import { branchReport, reportBranch } from '../../fixtures/pos-report'
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const dates = () => {
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-16' } })
  fireEvent.change(screen.getByLabelText('Through'), { target: { value: '2026-10-16' } })
}
beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(branchReport))
  )
)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
it('loads real scoped results and links export to the verified dates', async () => {
  render(<BranchReports branchId={reportBranch} branchName="Test branch" />)
  expect(screen.queryByText('10.50')).toBeNull()
  dates()
  fireEvent.click(screen.getByRole('button', { name: 'Load report' }))
  await screen.findByRole('link', { name: 'Export CSV' })
  expect(screen.getByRole('link', { name: 'Export CSV' }).getAttribute('href')).toContain(
    `branchId=${reportBranch}&start=2026-10-16&end=2026-10-16&format=csv`
  )
  expect(screen.getByText('Recorded card')).toBeInTheDocument()
  expect(screen.getByText('Bank transfer')).toBeInTheDocument()
  expect(screen.getAllByText('Sweet')).toHaveLength(2)
  fireEvent.change(screen.getByLabelText('Find a product'), { target: { value: 'unmatched' } })
  expect(
    within(screen.getByRole('region', { name: 'Sold and refunded products' })).queryByText('Sweet')
  ).toBeNull()
  fireEvent.change(screen.getByLabelText('Through'), { target: { value: '2026-10-17' } })
  expect(screen.queryByRole('link', { name: 'Export CSV' })).toBeNull()
})
it('shows authentication failure rather than zero financial results', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ code: 'authentication_required' }, 401))
  )
  render(<BranchReports branchId={reportBranch} branchName="Test branch" />)
  dates()
  fireEvent.click(screen.getByRole('button', { name: 'Load report' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('session expired')
  expect(screen.queryByText('Sales including VAT')).toBeNull()
  expect(screen.queryByRole('link', { name: 'Export CSV' })).toBeNull()
})
it('cannot display late responses from the previously selected branch', async () => {
  let resolve!: (value: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        })
    )
  )
  const view = render(<BranchReports branchId={reportBranch} branchName="First" />)
  dates()
  fireEvent.click(screen.getByRole('button', { name: 'Load report' }))
  view.rerender(
    <BranchReports branchId="10000000-0000-4000-8000-000000000002" branchName="Second" />
  )
  resolve(response(branchReport))
  await waitFor(() => expect(screen.queryByRole('link', { name: 'Export CSV' })).toBeNull())
  expect(screen.getByRole('heading', { name: 'Second' })).toBeInTheDocument()
  expect(screen.queryByText('Sweet')).toBeNull()
})

it('recovers from a timeout with a usable retry and no invented zero totals', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'))
      .mockResolvedValueOnce(response(branchReport))
  )
  render(<BranchReports branchId={reportBranch} branchName="Test branch" />)
  dates()
  fireEvent.click(screen.getByRole('button', { name: 'Load report' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection and try again')
  expect(screen.queryByRole('link', { name: 'Export CSV' })).toBeNull()
  expect(screen.queryByText('Sales including VAT')).toBeNull()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Load report' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Load report' }))
  expect(await screen.findByRole('link', { name: 'Export CSV' })).toBeInTheDocument()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('calculates Dubai calendar presets without relying on the browser timezone', async () => {
  const { rangeForReportPreset } = await import('@/components/pos/reports/BranchReports')
  expect(rangeForReportPreset('today', '2026-10-25')).toEqual({
    start: '2026-10-25',
    end: '2026-10-25',
  })
  expect(rangeForReportPreset('yesterday', '2026-10-25')).toEqual({
    start: '2026-10-24',
    end: '2026-10-24',
  })
  expect(rangeForReportPreset('this_week', '2026-10-25')).toEqual({
    start: '2026-10-19',
    end: '2026-10-25',
  })
  expect(rangeForReportPreset('last_week', '2026-10-25')).toEqual({
    start: '2026-10-12',
    end: '2026-10-18',
  })
  expect(rangeForReportPreset('this_month', '2026-10-25')).toEqual({
    start: '2026-10-01',
    end: '2026-10-25',
  })
  expect(rangeForReportPreset('last_month', '2026-01-15')).toEqual({
    start: '2025-12-01',
    end: '2025-12-31',
  })
})

it('loads a quick range and ranks recorded products by net sales', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), 'https://pos.example')
      return response({
        ...branchReport,
        startDate: url.searchParams.get('start'),
        endDate: url.searchParams.get('end'),
        products: [
          branchReport.products[0],
          {
            ...branchReport.products[0],
            productId: '20000000-0000-4000-8000-000000000002',
            name: 'Top sweet',
            soldQuantityMilli: 1000,
            netQuantityMilli: 1000,
            salesGrossFils: 2050,
            netGrossFils: 2050,
            netExVatFils: 1952,
            vatFils: 98,
          },
        ],
        payments: [
          { method: 'cash', salesFils: 600, refundsFils: 0, netFils: 600 },
          { method: 'card', salesFils: 2500, refundsFils: 0, netFils: 2500 },
          { method: 'bank_transfer', salesFils: 0, refundsFils: 0, netFils: 0 },
        ],
        vatRates: [
          {
            taxRateBps: 500,
            salesGrossFils: 3100,
            refundGrossFils: 0,
            netGrossFils: 3100,
            netExVatFils: 2952,
            vatFils: 148,
          },
        ],
        summary: {
          salesGrossFils: 3100,
          refundGrossFils: 0,
          netGrossFils: 3100,
          netExVatFils: 2952,
          vatFils: 148,
          invoiceCount: 1,
          creditNoteCount: 0,
        },
        days: [
          {
            date: url.searchParams.get('start'),
            salesGrossFils: 3100,
            refundGrossFils: 0,
            netGrossFils: 3100,
            netExVatFils: 2952,
            vatFils: 148,
            invoiceCount: 1,
            creditNoteCount: 0,
          },
        ],
      })
    })
  )
  render(<BranchReports branchId={reportBranch} branchName="Test branch" />)
  fireEvent.click(screen.getByRole('button', { name: 'Yesterday' }))
  expect(await screen.findByRole('region', { name: 'Top products by net sales' })).toBeVisible()
  const table = screen.getByRole('region', { name: 'Top products by net sales' })
  expect(table).toHaveTextContent('Top sweet')
  expect(table.textContent?.indexOf('Top sweet')).toBeLessThan(
    table.textContent?.indexOf('Sweet') ?? 0
  )
  expect(screen.getByRole('region', { name: 'Top categories by net sales' })).toHaveTextContent(
    'Mithai'
  )
})
