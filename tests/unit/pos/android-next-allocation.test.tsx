import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../apps/android-pos/node_modules/react', async () => await import('react'))
const bridge = vi.hoisted(() => ({
  getNativeNextAllocationState: vi.fn(),
  continueNativeAfterAllocation: vi.fn(),
  subscribeNativeCheckoutLock: vi.fn(),
}))
vi.mock('../../../apps/android-pos/src/native', async () => ({
  ...(await vi.importActual('../../../apps/android-pos/src/native')),
  ...bridge,
}))
import NativeNextAllocation from '../../../apps/android-pos/src/NativeNextAllocation'
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ready = {
  schemaVersion: 1,
  status: 'ready',
  previousAuthorityId: id(1),
  shiftId: id(2),
  nextShiftId: null,
  reasonCode: null,
  canContinue: true,
}
const complete = { ...ready, status: 'completed', nextShiftId: id(2), canContinue: false }
const props = () => ({
  available: true,
  ready: true,
  revision: 1,
  actorId: id(3),
  actionsBlocked: false,
  operationLock: { current: false },
  onBusyChange: vi.fn(),
  onPendingChange: vi.fn(),
  onChanged: vi.fn(),
})
beforeEach(() => {
  bridge.subscribeNativeCheckoutLock.mockResolvedValue({
    remove: vi.fn().mockResolvedValue(undefined),
  })
  bridge.getNativeNextAllocationState.mockResolvedValue(ready)
  bridge.continueNativeAfterAllocation.mockResolvedValue(complete)
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
async function check() {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Check next setup' })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Check next setup' }))
  await screen.findByText('Ready to continue setup')
}
async function proceed() {
  await check()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Continue setup' }))
}
describe('controlled next allocation setup', () => {
  it('requires an explicit read and exact consent, preserves the original open shift and does not claim new preparation', async () => {
    const p = props()
    render(<NativeNextAllocation {...p} />)
    expect(bridge.getNativeNextAllocationState).not.toHaveBeenCalled()
    expect(screen.getByText(/Closing this Android cash drawer is not available/)).toBeVisible()
    expect(screen.queryByText(/use the online web counter with your manager/)).toBeNull()
    await check()
    expect(screen.getByRole('button', { name: 'Continue setup' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue setup' }))
    await screen.findByText('Original setup handoff completed')
    expect(bridge.continueNativeAfterAllocation).toHaveBeenCalledExactlyOnceWith(id(1))
    expect(screen.getByText(/Last confirmed status: the original shift is open/)).toBeVisible()
    expect(screen.getByText(/No new invoice allocation was prepared by this handoff/)).toBeVisible()
    expect(p.onChanged).toHaveBeenCalledTimes(1)
    expect(p.onPendingChange).toHaveBeenLastCalledWith(false)
  })
  it('only shows the opening-cash next step when native confirms the original shift is closed', async () => {
    bridge.continueNativeAfterAllocation.mockResolvedValue({ ...complete, nextShiftId: null })
    render(<NativeNextAllocation {...props()} />)
    await proceed()
    await screen.findByText(/The original shift is closed/)
    expect(screen.queryByText(/Last confirmed status: the original shift is open/)).toBeNull()
  })
  it('reads after a lost response and accepts the exact completed outcome without repeating the write', async () => {
    bridge.continueNativeAfterAllocation.mockRejectedValue(
      new Error('offline_continuation_uncertain')
    )
    bridge.getNativeNextAllocationState.mockResolvedValueOnce(ready).mockResolvedValueOnce(complete)
    render(<NativeNextAllocation {...props()} />)
    await proceed()
    await screen.findByText('Original setup handoff completed')
    expect(bridge.getNativeNextAllocationState).toHaveBeenCalledTimes(2)
    expect(bridge.continueNativeAfterAllocation).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('restores a durable pending handoff after restart and requires fresh consent for the same allocation', async () => {
    bridge.getNativeNextAllocationState.mockResolvedValue({
      ...ready,
      status: 'pending',
      reasonCode: 'offline_continuation_uncertain',
    })
    const p = props()
    render(<NativeNextAllocation {...p} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Check next setup' })).toBeEnabled()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check next setup' }))
    await screen.findByText('Original setup needs confirmation')
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole('button', { name: 'Retry same setup handoff' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry same setup handoff' }))
    await screen.findByText('Original setup handoff completed')
    expect(bridge.continueNativeAfterAllocation).toHaveBeenCalledExactlyOnceWith(id(1))
  })
  it('does not permit a different allocation to replace an uncertain request', async () => {
    bridge.continueNativeAfterAllocation.mockRejectedValue(
      new Error('offline_continuation_uncertain')
    )
    bridge.getNativeNextAllocationState
      .mockResolvedValueOnce(ready)
      .mockResolvedValue({ ...ready, previousAuthorityId: id(4) })
    const p = props()
    render(<NativeNextAllocation {...p} />)
    await proceed()
    await screen.findByText(/original staff, counter, shift or allocation no longer matches/)
    expect(screen.getByRole('button', { name: 'Continue setup' })).toBeDisabled()
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
    expect(p.onChanged).not.toHaveBeenCalled()
  })
  it.each([
    'offline_seal_confirmation_required',
    'offline_upload_required',
    'payment_reconciliation_required',
    'future_unknown',
  ])('keeps %s blocked and does not trust aggregate counts', async (reasonCode) => {
    bridge.getNativeNextAllocationState.mockResolvedValue({
      ...ready,
      status: 'pending',
      canContinue: false,
      reasonCode,
    })
    render(<NativeNextAllocation {...props()} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Check next setup' })).toBeEnabled()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check next setup' }))
    await screen.findByText('Original setup needs confirmation')
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(bridge.continueNativeAfterAllocation).not.toHaveBeenCalled()
  })
  it('permits local status reads during a payment hold but blocks continuation', async () => {
    render(<NativeNextAllocation {...props()} actionsBlocked />)
    await check()
    expect(screen.getByRole('checkbox')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Continue setup' }))
    expect(bridge.continueNativeAfterAllocation).not.toHaveBeenCalled()
  })
  it('rejects old consent on actor or revision change', async () => {
    const p = props(),
      view = render(<NativeNextAllocation {...p} />)
    await check()
    fireEvent.click(screen.getByRole('checkbox'))
    view.rerender(<NativeNextAllocation {...p} actorId={id(4)} />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    view.rerender(<NativeNextAllocation {...p} revision={2} />)
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
  it('does not enter a native operation while another action owns the shared lock', async () => {
    const p = props()
    render(<NativeNextAllocation {...p} />)
    await check()
    fireEvent.click(screen.getByRole('checkbox'))
    p.operationLock.current = true
    fireEvent.click(screen.getByRole('button', { name: 'Continue setup' }))
    expect(bridge.continueNativeAfterAllocation).not.toHaveBeenCalled()
  })
  it('native lock clears consent and suppresses a delayed completed response', async () => {
    let resolve!: (value: unknown) => void
    bridge.continueNativeAfterAllocation.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const p = props()
    render(<NativeNextAllocation {...p} />)
    await proceed()
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    act(() => bridge.subscribeNativeCheckoutLock.mock.calls[0][0]())
    await act(async () => resolve(complete))
    expect(screen.queryByText('Original setup handoff completed')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(p.onChanged).not.toHaveBeenCalled()
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
  })
  it('fails closed when native lock monitoring is unavailable', async () => {
    bridge.subscribeNativeCheckoutLock.mockRejectedValue(new Error('unavailable'))
    render(<NativeNextAllocation {...props()} />)
    await screen.findByText(/Device lock monitoring is unavailable/)
    expect(screen.getByRole('button', { name: 'Check next setup' })).toBeDisabled()
    expect(bridge.getNativeNextAllocationState).not.toHaveBeenCalled()
  })
})

it('checks the original shift explicitly after server-confirmed closure, without reusing initial consent', async () => {
  bridge.getNativeNextAllocationState.mockResolvedValue(complete)
  bridge.continueNativeAfterAllocation.mockResolvedValue({ ...complete, nextShiftId: null })
  const p = props()
  render(<NativeNextAllocation {...p} />)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Check next setup' })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Check next setup' }))
  await screen.findByText('Original setup handoff completed')
  expect(screen.getByRole('button', { name: 'Check shift status' })).toBeDisabled()
  expect(bridge.continueNativeAfterAllocation).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Check shift status' }))
  await screen.findByText(/The original shift is closed/)
  expect(bridge.continueNativeAfterAllocation).toHaveBeenCalledExactlyOnceWith(id(1))
  expect(screen.queryByRole('button', { name: 'Check shift status' })).toBeNull()
  expect(p.onChanged).toHaveBeenCalledTimes(2)
})
it('does not treat an old completed record as confirmation of an uncertain online shift recheck', async () => {
  bridge.getNativeNextAllocationState.mockResolvedValue(complete)
  bridge.continueNativeAfterAllocation.mockRejectedValue(
    new Error('offline_continuation_uncertain')
  )
  render(<NativeNextAllocation {...props()} />)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Check next setup' })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Check next setup' }))
  await screen.findByText('Original setup handoff completed')
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Check shift status' }))
  await screen.findByText(/The online shift check was not confirmed/)
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(bridge.continueNativeAfterAllocation).toHaveBeenCalledTimes(1)
})
