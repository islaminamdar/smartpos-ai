import { cleanup, fireEvent, render, screen, waitFor, within, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BranchOperations from '../../../components/pos/operations/BranchOperations'
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
import { operationFixture } from '../../fixtures/pos-operations'
const props = () => ({
  actorId: id(20),
  branchId: id(1),
  branchName: 'Bur Dubai',
  branches: [
    { id: id(1), name: 'Bur Dubai', role: 'manager' as const },
    { id: id(2), name: 'Second branch', role: 'owner' as const },
    { id: id(3), name: 'Cashier branch', role: 'cashier' as const },
  ],
  onNavigate: vi.fn(),
})
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(response(operationFixture()))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
async function loaded() {
  await screen.findByRole('region', { name: 'Today’s recorded sales' })
}
describe('branch operations', () => {
  it('shows verified amounts and distinct custody/workload limits with scope-safe navigation', async () => {
    const p = props()
    render(<BranchOperations {...p} />)
    await loaded()
    expect(screen.getAllByText('AED 140.00').length).toBeGreaterThan(0)
    expect(screen.getByRole('region', { name: 'Owner close-out' })).toBeVisible()
    expect(screen.getByText('Close-out at a glance')).toBeVisible()
    expect(screen.getByText('Recorded payments today')).toBeVisible()
    expect(screen.getByText('Latest recorded drawer close')).toBeVisible()
    expect(screen.getByText(/Discounts, voids and bank settlement are not inferred/)).toBeVisible()
    expect(screen.getByText(/Offline-device activity may be missing/)).toBeVisible()
    fireEvent.click(screen.getByText('What this overview can see'))
    expect(
      screen.getByText(/Sales and problems still saved only on offline devices are unknown/)
    ).toBeVisible()
    expect(screen.getByText(/Batches are preparation groups, not item quantities/)).toBeVisible()
    expect(screen.getByText('Counted minus expected')).toBeVisible()
    expect(screen.getByText('1 open shift')).toBeVisible()
    expect(screen.getByText('1 close')).toBeVisible()
    expect(screen.getByText('1 open order')).toBeVisible()
    expect(screen.getByText(/2 invoices and 1 credit note\./)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Open kitchen' }))
    expect(p.onNavigate).toHaveBeenCalledWith('kitchen')
    expect(screen.queryByRole('option', { name: 'Cashier branch' })).toBeNull()
  })
  it('shows unavailable, not fake zero totals, when the initial read fails', async () => {
    fetchMock.mockRejectedValue(new Error('Network unavailable'))
    render(<BranchOperations {...props()} />)
    await screen.findByRole('alert')
    expect(screen.queryByRole('region', { name: 'Today’s recorded sales' })).toBeNull()
    expect(screen.queryByText('AED 0.00')).toBeNull()
  })
  it('retains labelled stale same-branch data after refresh failure and recovers explicitly', async () => {
    render(<BranchOperations {...props()} />)
    await loaded()
    fetchMock.mockResolvedValueOnce(response({ code: 'operations_unavailable' }, 503))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh overview' }))
    await screen.findByRole('alert')
    expect(screen.getAllByText('AED 140.00').length).toBeGreaterThan(0)
    expect(screen.getByText(/Last saved overview/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Open reports' })).toBeDisabled()
    fetchMock.mockResolvedValueOnce(response(operationFixture()))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh overview' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open reports' })).toBeEnabled())
  })
  it.each([401, 403])('clears old data on access denial %s', async (status) => {
    render(<BranchOperations {...props()} />)
    await loaded()
    fetchMock.mockResolvedValueOnce(response({ code: 'operations_manager_required' }, status))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh overview' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('region', { name: 'Today’s recorded sales' })).toBeNull()
  })
  it('reads another manager branch without rebinding and disables counter workflow shortcuts', async () => {
    const p = props()
    render(<BranchOperations {...p} />)
    await loaded()
    fetchMock.mockResolvedValueOnce(response(operationFixture(id(2))))
    fireEvent.change(screen.getByRole('combobox', { name: 'View branch' }), {
      target: { value: id(2) },
    })
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining(id(2)), expect.anything())
    )
    await loaded()
    expect(screen.getByRole('button', { name: 'Open kitchen' })).toBeDisabled()
    expect(p.onNavigate).not.toHaveBeenCalled()
  })
  it('keeps missing close amounts unavailable rather than zero', async () => {
    const value = operationFixture()
    value.closedShifts.incompleteCount = 1
    value.closedShifts.discrepancyCount = 0
    Object.assign(value.closedShifts, { netDifferenceFils: null })
    Object.assign(value.closedShifts.items[0], { countedCashFils: null, cashDifferenceFils: null })
    fetchMock.mockResolvedValue(response(value))
    render(<BranchOperations {...props()} />)
    await loaded()
    expect(screen.getByText('Unavailable — incomplete close records')).toBeVisible()
    expect(
      within(screen.getByRole('region', { name: 'Recent drawer closes' })).getAllByText(
        'Not recorded'
      )
    ).toHaveLength(2)
  })
  it('ignores delayed previous actor responses', async () => {
    let resolve!: (value: Response) => void
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((r) => {
        resolve = r
      })
    )
    const p = props()
    const view = render(<BranchOperations {...p} />)
    fetchMock.mockResolvedValue(response(operationFixture(id(2))))
    view.rerender(<BranchOperations {...p} actorId={id(21)} branchId={id(2)} />)
    await loaded()
    await act(async () => resolve(response(operationFixture())))
    expect(screen.getByRole('combobox')).toHaveValue(id(2))
    expect(screen.getByText('Second branch', { selector: 'p' })).toBeVisible()
  })
  it('does not make read-only overview unavailable during a financial hold', async () => {
    render(<BranchOperations {...props()} disabled />)
    await loaded()
    expect(screen.getByRole('button', { name: 'Refresh overview' })).toBeEnabled()
    expect(screen.getByRole('combobox')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Open reports' })).toBeDisabled()
  })
  it('rejects a wrong-branch payload rather than displaying its totals', async () => {
    fetchMock.mockResolvedValue(response(operationFixture(id(2))))
    render(<BranchOperations {...props()} />)
    await screen.findByRole('alert')
    expect(screen.queryByRole('region', { name: 'Today’s recorded sales' })).toBeNull()
  })
  it('clears cached totals on a denied response even if its body is invalid', async () => {
    render(<BranchOperations {...props()} />)
    await loaded()
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 403 }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh overview' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('region', { name: 'Today’s recorded sales' })).toBeNull()
  })
  it('labels truncated rows while retaining full aggregate counts', async () => {
    const value = operationFixture()
    value.openShifts.totalCount = 21
    value.openShifts.truncated = true
    value.openShifts.items = Array.from({ length: 20 }, (_, index) => ({
      ...value.openShifts.items[0],
      id: id(100 + index),
      deviceId: id(200 + index),
    }))
    fetchMock.mockResolvedValue(response(value))
    render(<BranchOperations {...props()} />)
    await loaded()
    expect(screen.getAllByText('21 open shifts').length).toBeGreaterThan(0)
    expect(screen.getByText(/Showing 20 of 21 open shifts/)).toBeVisible()
  })
})
