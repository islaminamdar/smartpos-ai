import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  expect(screen.getByText('Sweet')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Find a product'), { target: { value: 'unmatched' } })
  expect(screen.queryByText('Sweet')).toBeNull()
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
