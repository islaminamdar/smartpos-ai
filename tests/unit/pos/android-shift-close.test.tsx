import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../apps/android-pos/node_modules/react', async () => await import('react'))
const bridge = vi.hoisted(() => ({
  getNativeShiftCloseState: vi.fn(),
  checkNativeShiftClose: vi.fn(),
  closeNativeShift: vi.fn(),
  retryNativeShiftClose: vi.fn(),
  subscribeNativeCheckoutLock: vi.fn(),
}))
vi.mock('../../../apps/android-pos/src/native', async () => ({
  ...(await vi.importActual('../../../apps/android-pos/src/native')),
  ...bridge,
}))
import NativeShiftClose, { countedCashToFils } from '../../../apps/android-pos/src/NativeShiftClose'
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const base = {
  schemaVersion: 1,
  status: 'needs_check',
  shiftId: id(1),
  commandId: null,
  countedCashFils: null,
  result: null,
  pinRequired: false,
  canClose: false,
  canRetry: false,
  reasonCode: null,
}
const ready = { ...base, status: 'ready', canClose: true }
const pending = {
  ...base,
  status: 'pending',
  commandId: id(2),
  countedCashFils: 12345,
  canRetry: true,
  reasonCode: 'native_shift_close_pending',
}
const closed = {
  ...pending,
  status: 'closed',
  canRetry: false,
  reasonCode: null,
  result: {
    commandId: id(2),
    shiftId: id(1),
    countedCashFils: 12345,
    expectedCashFils: 12500,
    cashDifferenceFils: -155,
    closedAt: '2026-10-16T07:00:00.000Z',
  },
}
const props = () => ({
  available: true,
  ready: true,
  revision: 1,
  actorId: id(3),
  actionsBlocked: false,
  operationLock: { current: false },
  onBusyChange: vi.fn(),
  onPendingChange: vi.fn(),
  onCheckedVersion: vi.fn(),
  onChanged: vi.fn(),
})
beforeEach(() => {
  bridge.getNativeShiftCloseState.mockResolvedValue(base)
  bridge.checkNativeShiftClose.mockResolvedValue(ready)
  bridge.closeNativeShift.mockResolvedValue(closed)
  bridge.retryNativeShiftClose.mockResolvedValue(closed)
  bridge.subscribeNativeCheckoutLock.mockResolvedValue({
    remove: vi.fn().mockResolvedValue(undefined),
  })
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
async function check() {
  await screen.findByText('Check this drawer before counting')
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Check drawer for closing' })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Check drawer for closing' }))
  await screen.findByLabelText('Actual cash counted (AED)')
}
async function close() {
  await check()
  fireEvent.change(screen.getByLabelText('Actual cash counted (AED)'), {
    target: { value: '123.45' },
  })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm cash count and close drawer' }))
}
describe('native drawer close', () => {
  it('reads local status before readiness, then explicit online check and exact count consent before closing', async () => {
    const p = props()
    render(<NativeShiftClose {...p} />)
    await check()
    expect(bridge.getNativeShiftCloseState).toHaveBeenCalledTimes(1)
    expect(p.onCheckedVersion).toHaveBeenCalledWith(1)
    expect(
      screen.getByRole('button', { name: 'Confirm cash count and close drawer' })
    ).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Actual cash counted (AED)'), {
      target: { value: '123.45' },
    })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cash count and close drawer' }))
    await screen.findByText('Original drawer closed')
    expect(bridge.closeNativeShift).toHaveBeenCalledExactlyOnceWith(id(1), 12345)
    expect(screen.getByText('AED 125.00')).toBeVisible()
    expect(screen.getByText('AED -1.55')).toBeVisible()
    expect(p.onChanged).toHaveBeenCalledTimes(1)
    expect(p.onPendingChange).toHaveBeenLastCalledWith(false)
  })
  it.each(['1.999', '1e2', '-1', '1,000.00', '0.001'])('rejects %s without rounding', (value) =>
    expect(countedCashToFils(value)).toBeNull()
  )
  it('handles normal AED precision exactly', () => {
    expect(countedCashToFils('0')).toBe(0)
    expect(countedCashToFils('123.45')).toBe(12345)
    expect(countedCashToFils('2.5')).toBe(250)
  })
  it('accepts the exact native/server maximum and rejects one fils above it', () => {
    expect(countedCashToFils('1000000.00')).toBe(100_000_000)
    expect(countedCashToFils('1000000.01')).toBeNull()
  })
  it('invalidates count consent when the amount changes', async () => {
    render(<NativeShiftClose {...props()} />)
    await check()
    fireEvent.change(screen.getByLabelText('Actual cash counted (AED)'), {
      target: { value: '123.45' },
    })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText('Actual cash counted (AED)'), {
      target: { value: '123.46' },
    })
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(
      screen.getByRole('button', { name: 'Confirm cash count and close drawer' })
    ).toBeDisabled()
  })
  it('reconciles a lost close acknowledgement by reading the same saved command, without another write', async () => {
    bridge.closeNativeShift.mockRejectedValue(new Error('native_shift_close_uncertain'))
    bridge.getNativeShiftCloseState.mockResolvedValueOnce(base).mockResolvedValue(closed)
    render(<NativeShiftClose {...props()} />)
    await close()
    await screen.findByText('Original drawer closed')
    expect(bridge.closeNativeShift).toHaveBeenCalledTimes(1)
    expect(bridge.retryNativeShiftClose).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Actual cash counted (AED)')).toBeNull()
  })
  it('restores pending close, requires server check before same-ID retry, and never edits the saved amount', async () => {
    bridge.getNativeShiftCloseState.mockResolvedValue(pending)
    bridge.checkNativeShiftClose.mockResolvedValue(pending)
    render(<NativeShiftClose {...props()} />)
    await screen.findByText('Original close request needs confirmation')
    expect(screen.queryByRole('button', { name: 'Retry original close request' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check drawer for closing' }))
    await screen.findByRole('button', { name: 'Retry original close request' })
    expect(screen.queryByLabelText('Actual cash counted (AED)')).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry original close request' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry original close request' }))
    await screen.findByText('Original drawer closed')
    expect(bridge.retryNativeShiftClose).toHaveBeenCalledExactlyOnceWith(id(2))
    expect(bridge.closeNativeShift).not.toHaveBeenCalled()
  })
  it('retains close uncertainty if readback is missing or refers to a different shift', async () => {
    bridge.closeNativeShift.mockRejectedValue(new Error('native_shift_close_uncertain'))
    bridge.getNativeShiftCloseState
      .mockResolvedValueOnce(base)
      .mockResolvedValue({ ...closed, shiftId: id(9) })
    const p = props()
    render(<NativeShiftClose {...p} />)
    await close()
    await screen.findByText(/original shift or staff scope no longer matches/)
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
    expect(p.onChanged).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Confirm cash count and close drawer' })).toBeNull()
  })
  it('keeps pending details private when signed out even if a bridge returns them', async () => {
    bridge.getNativeShiftCloseState.mockResolvedValue(pending)
    render(<NativeShiftClose {...props()} actorId={null} />)
    await screen.findByText('Original close request needs confirmation')
    expect(screen.queryByText(/AED 123.45/)).toBeNull()
    expect(screen.getByText(id(2))).toBeInTheDocument()
  })
  it('blocks new closing and retry under another financial hold but still permits checking status', async () => {
    bridge.getNativeShiftCloseState.mockResolvedValue(pending)
    bridge.checkNativeShiftClose.mockResolvedValue(pending)
    render(<NativeShiftClose {...props()} actionsBlocked />)
    await screen.findByText('Original close request needs confirmation')
    fireEvent.click(screen.getByRole('button', { name: 'Check drawer for closing' }))
    await screen.findByRole('button', { name: 'Retry original close request' })
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(bridge.retryNativeShiftClose).not.toHaveBeenCalled()
  })
  it('native lock wipes cash totals and suppresses delayed close results', async () => {
    let resolve!: (value: unknown) => void
    bridge.closeNativeShift.mockReturnValue(
      new Promise((r) => {
        resolve = r
      })
    )
    const p = props()
    render(<NativeShiftClose {...p} />)
    await close()
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    act(() => bridge.subscribeNativeCheckoutLock.mock.calls[0][0]())
    await act(async () => resolve(closed))
    expect(screen.queryByText('Original drawer closed')).toBeNull()
    expect(screen.queryByText('AED 125.00')).toBeNull()
    expect(p.onChanged).not.toHaveBeenCalled()
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
  })
  it('does not reuse online eligibility after actor or revision changes', async () => {
    const p = props(),
      view = render(<NativeShiftClose {...p} />)
    await check()
    fireEvent.change(screen.getByLabelText('Actual cash counted (AED)'), {
      target: { value: '123.45' },
    })
    fireEvent.click(screen.getByRole('checkbox'))
    view.rerender(<NativeShiftClose {...p} actorId={id(9)} revision={2} />)
    await waitFor(() => expect(screen.queryByLabelText('Actual cash counted (AED)')).toBeNull())
    expect(bridge.closeNativeShift).not.toHaveBeenCalled()
  })
})

it('releases a pre-persistence failure only after explicit same-shift online absence confirmation', async () => {
  bridge.closeNativeShift.mockRejectedValue(new Error('native_storage_unavailable'))
  bridge.getNativeShiftCloseState.mockResolvedValueOnce(base).mockResolvedValue(ready)
  const p = props()
  render(<NativeShiftClose {...p} />)
  await close()
  await screen.findByText(/saved drawer record could not be read/)
  expect(screen.queryByLabelText('Actual cash counted (AED)')).toBeNull()
  expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
  fireEvent.click(screen.getByRole('button', { name: 'Check drawer for closing' }))
  await screen.findByLabelText('Actual cash counted (AED)')
  expect(screen.getByLabelText('Actual cash counted (AED)')).toHaveValue('')
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(p.onPendingChange).toHaveBeenLastCalledWith(false)
  expect(bridge.closeNativeShift).toHaveBeenCalledTimes(1)
})

it('rejects a late Android check/PIN response after background lock', async () => {
  let resolve!: (value: unknown) => void
  bridge.checkNativeShiftClose.mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  const p = props()
  render(<NativeShiftClose {...p} />)
  await screen.findByText('Check this drawer before counting')
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Check drawer for closing' })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Check drawer for closing' }))
  await waitFor(() => expect(resolve).toBeTypeOf('function'))
  act(() => bridge.subscribeNativeCheckoutLock.mock.calls[0][0]())
  await act(async () => resolve(ready))
  expect(screen.queryByLabelText('Actual cash counted (AED)')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Confirm cash count and close drawer' })).toBeNull()
  expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
  expect(bridge.closeNativeShift).not.toHaveBeenCalled()
})

it.each(['pending', 'closed'] as const)(
  'removes already displayed %s drawer cash details on native lock without another read',
  async (status) => {
    bridge.getNativeShiftCloseState.mockResolvedValue(status === 'closed' ? closed : pending)
    const p = props()
    const view = render(<NativeShiftClose {...p} />)
    await screen.findByText(
      status === 'closed' ? 'Original drawer closed' : 'Original close request needs confirmation'
    )
    expect(view.container).toHaveTextContent('AED 123.45')
    if (status === 'closed') {
      expect(view.container).toHaveTextContent('AED 125.00')
      expect(view.container).toHaveTextContent('AED -1.55')
    }

    act(() => bridge.subscribeNativeCheckoutLock.mock.calls[0][0]())

    for (const amount of ['AED 123.45', 'AED 125.00', 'AED -1.55'])
      expect(view.container).not.toHaveTextContent(amount)
    expect(screen.getByText(id(2))).toBeInTheDocument()
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
    expect(bridge.getNativeShiftCloseState).toHaveBeenCalledTimes(1)
    expect(bridge.checkNativeShiftClose).not.toHaveBeenCalled()
    expect(bridge.closeNativeShift).not.toHaveBeenCalled()
    expect(bridge.retryNativeShiftClose).not.toHaveBeenCalled()
  }
)

it.each(['pending', 'closed'] as const)(
  'does not reveal %s cash details from an initial local read completed after native lock',
  async (status) => {
    let resolve!: (value: unknown) => void
    bridge.getNativeShiftCloseState.mockReturnValue(new Promise((done) => (resolve = done)))
    const p = props()
    const view = render(<NativeShiftClose {...p} />)
    await waitFor(() => expect(bridge.getNativeShiftCloseState).toHaveBeenCalledTimes(1))
    act(() => bridge.subscribeNativeCheckoutLock.mock.calls[0][0]())
    await act(async () => resolve(status === 'closed' ? closed : pending))
    for (const amount of ['AED 123.45', 'AED 125.00', 'AED -1.55'])
      expect(view.container).not.toHaveTextContent(amount)
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
    expect(p.onCheckedVersion).not.toHaveBeenCalled()
    expect(p.onChanged).not.toHaveBeenCalled()
    expect(bridge.getNativeShiftCloseState).toHaveBeenCalledTimes(1)
  }
)
