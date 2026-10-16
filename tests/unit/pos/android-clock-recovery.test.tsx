import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../apps/android-pos/node_modules/react', async () => await import('react'))
const bridge = vi.hoisted(() => ({
  getNativeClockRecoveryState: vi.fn(),
  startNativeClockRecovery: vi.fn(),
  retryNativeClockRecovery: vi.fn(),
  subscribeNativeCheckoutLock: vi.fn(),
}))
vi.mock('../../../apps/android-pos/src/native', async () => ({
  ...(await vi.importActual('../../../apps/android-pos/src/native')),
  ...bridge,
}))
import NativeClockRecovery from '../../../apps/android-pos/src/NativeClockRecovery'
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ready = {
  schemaVersion: 1,
  status: 'ready',
  requestId: null,
  canStart: true,
  canRetry: false,
  passwordRequired: true,
  reasonCode: null,
}
const pending = {
  ...ready,
  status: 'pending',
  requestId: id(1),
  canStart: false,
  canRetry: true,
  reasonCode: 'clock_recovery_pending',
}
const approved = {
  ...pending,
  status: 'approved',
  passwordRequired: false,
  reasonCode: 'clock_recovery_approved',
}
const completed = {
  ...ready,
  status: 'completed',
  canStart: false,
  requestId: id(1),
  passwordRequired: false,
  reasonCode: 'clock_recovery_completed',
}
const props = () => ({
  available: true,
  ready: true,
  revision: 1,
  actorId: id(2),
  operationLock: { current: false },
  onBusyChange: vi.fn(),
  onPendingChange: vi.fn(),
  onCheckedVersion: vi.fn(),
  onChanged: vi.fn(),
})
beforeEach(() => {
  bridge.getNativeClockRecoveryState.mockResolvedValue(ready)
  bridge.startNativeClockRecovery.mockResolvedValue(completed)
  bridge.retryNativeClockRecovery.mockResolvedValue(completed)
  bridge.subscribeNativeCheckoutLock.mockResolvedValue({
    remove: vi.fn().mockResolvedValue(undefined),
  })
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
async function consentStart() {
  await screen.findByRole('button', { name: 'Continue clock recovery in Android' })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Continue clock recovery in Android' }))
}
describe('native clock recovery UI', () => {
  it('requires explicit consent, keeps secrets outside JS and leaves completion locked', async () => {
    const p = props()
    const view = render(<NativeClockRecovery {...p} />)
    const start = await screen.findByRole('button', { name: 'Continue clock recovery in Android' })
    expect(start).toBeDisabled()
    expect(view.container.querySelectorAll('input:not([type=checkbox])')).toHaveLength(0)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(start)
    await screen.findByText(/Clock recovery complete\./)
    expect(bridge.startNativeClockRecovery).toHaveBeenCalledExactlyOnceWith()
    expect(p.onPendingChange).toHaveBeenLastCalledWith(false)
    expect(p.onChanged).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByRole('button', { name: 'Recover device time again' })
    ).not.toBeInTheDocument()
  })
  it('restores exact pending request and uses fresh consent, with no replacement start', async () => {
    bridge.getNativeClockRecoveryState.mockResolvedValue(pending)
    render(<NativeClockRecovery {...props()} />)
    const retry = await screen.findByRole('button', { name: 'Check / retry clock recovery' })
    expect(retry).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(retry)
    await screen.findByText(/Clock recovery complete\./)
    expect(bridge.retryNativeClockRecovery).toHaveBeenCalledExactlyOnceWith({ requestId: id(1) })
    expect(bridge.startNativeClockRecovery).not.toHaveBeenCalled()
  })
  it('handles approved foreground apply with no password field', async () => {
    bridge.getNativeClockRecoveryState.mockResolvedValue(approved)
    render(<NativeClockRecovery {...props()} />)
    await screen.findByRole('button', { name: 'Finish clock recovery' })
    expect(screen.getByText(/Status lookup uses the saved request/)).toBeVisible()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Finish clock recovery' }))
    await screen.findByText(/Clock recovery complete\./)
    expect(bridge.retryNativeClockRecovery).toHaveBeenCalledExactlyOnceWith({ requestId: id(1) })
  })
  it('allows signed-out lookup-only retry without exposing a new PIN request', async () => {
    bridge.getNativeClockRecoveryState.mockResolvedValue({ ...pending, passwordRequired: false })
    bridge.retryNativeClockRecovery.mockResolvedValue({ ...approved, canRetry: false })
    render(<NativeClockRecovery {...props()} actorId={null} />)
    await screen.findByRole('button', { name: 'Check / retry clock recovery' })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Check / retry clock recovery' }))
    await screen.findByText(/Approval is saved\./)
    expect(bridge.retryNativeClockRecovery).toHaveBeenCalledExactlyOnceWith({ requestId: id(1) })
    expect(
      screen.queryByRole('button', { name: 'Continue clock recovery in Android' })
    ).not.toBeInTheDocument()
  })
  it('reads saved state after a lost response and never automatically retries', async () => {
    bridge.startNativeClockRecovery.mockRejectedValue(new Error('clock_recovery_uncertain'))
    bridge.getNativeClockRecoveryState.mockResolvedValueOnce(ready).mockResolvedValue(pending)
    const p = props()
    render(<NativeClockRecovery {...p} />)
    await consentStart()
    await screen.findByRole('button', { name: 'Check / retry clock recovery' })
    expect(bridge.getNativeClockRecoveryState).toHaveBeenCalledTimes(2)
    expect(bridge.retryNativeClockRecovery).not.toHaveBeenCalled()
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })
  it('keeps original request held if a read returns missing or different identity', async () => {
    bridge.getNativeClockRecoveryState
      .mockResolvedValueOnce(pending)
      .mockResolvedValue({ ...pending, requestId: id(9) })
    const p = props()
    render(<NativeClockRecovery {...p} />)
    await screen.findByRole('button', { name: 'Check / retry clock recovery' })
    fireEvent.click(screen.getByRole('button', { name: 'Check saved clock recovery' }))
    await screen.findByRole('alert')
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
    expect(
      screen.queryByRole('button', { name: 'Check / retry clock recovery' })
    ).not.toBeInTheDocument()
  })
  it('failed local discovery holds new work and explicit retry discovers recovery without enabling sales', async () => {
    bridge.getNativeClockRecoveryState
      .mockRejectedValueOnce(new Error('native_storage_unavailable'))
      .mockResolvedValue(ready)
    const p = props()
    render(<NativeClockRecovery {...p} />)
    await screen.findByRole('alert')
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Check saved clock recovery' }))
    await screen.findByRole('button', { name: 'Continue clock recovery in Android' })
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
  })
  it('blocks unknown capabilities/reasons and preserves a blocked request hold', async () => {
    bridge.getNativeClockRecoveryState.mockResolvedValue({
      ...pending,
      status: 'blocked',
      canRetry: false,
      reasonCode: 'clock_recovery_conflict',
    })
    const p = props()
    render(<NativeClockRecovery {...p} />)
    await screen.findByText(/conflicts with another record/)
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
  it('suppresses a delayed native success and clears consent on background', async () => {
    let done!: (v: unknown) => void
    bridge.startNativeClockRecovery.mockReturnValue(
      new Promise((r) => {
        done = r
      })
    )
    const p = props()
    render(<NativeClockRecovery {...p} />)
    await consentStart()
    act(() => window.dispatchEvent(new Event('pagehide')))
    await act(async () => done(completed))
    expect(screen.queryByText(/Clock recovery complete\./)).not.toBeInTheDocument()
    expect(p.onChanged).not.toHaveBeenCalled()
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
  })
  it('suppresses old-account responses even if the native call succeeds', async () => {
    let done!: (v: unknown) => void
    bridge.startNativeClockRecovery.mockReturnValue(
      new Promise((r) => {
        done = r
      })
    )
    const p = props()
    const view = render(<NativeClockRecovery {...p} />)
    await consentStart()
    view.rerender(<NativeClockRecovery {...p} actorId={id(8)} revision={2} />)
    await act(async () => done(completed))
    expect(p.onChanged).not.toHaveBeenCalled()
    expect(screen.queryByText(/Clock recovery complete\./)).not.toBeInTheDocument()
  })
  it('fails closed if native lifecycle monitoring cannot attach', async () => {
    bridge.subscribeNativeCheckoutLock.mockRejectedValue(new Error('unavailable'))
    const p = props()
    render(<NativeClockRecovery {...p} />)
    await screen.findByRole('alert')
    expect(bridge.getNativeClockRecoveryState).not.toHaveBeenCalled()
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
  })
  it('does not enter a native dialog while another operation owns the shared lock', async () => {
    const p = props()
    render(<NativeClockRecovery {...p} />)
    await screen.findByRole('button', { name: 'Continue clock recovery in Android' })
    fireEvent.click(screen.getByRole('checkbox'))
    p.operationLock.current = true
    fireEvent.click(screen.getByRole('button', { name: 'Continue clock recovery in Android' }))
    expect(bridge.startNativeClockRecovery).not.toHaveBeenCalled()
  })
  it('native lock invalidates consent even when account scope is unchanged', async () => {
    render(<NativeClockRecovery {...props()} />)
    await screen.findByRole('button', { name: 'Continue clock recovery in Android' })
    fireEvent.click(screen.getByRole('checkbox'))
    act(() => bridge.subscribeNativeCheckoutLock.mock.calls[0][0]())
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check saved clock recovery' }))
    await screen.findByRole('checkbox')
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })
})

it('does not offer another recovery while healthy or after completion', async () => {
  const p = props()
  bridge.getNativeClockRecoveryState.mockResolvedValue({
    ...ready,
    status: 'not_available',
    canStart: false,
    passwordRequired: false,
    reasonCode: 'clock_healthy',
  })
  render(<NativeClockRecovery {...p} />)
  await screen.findByText(/No clock recovery is needed/)
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  expect(p.onPendingChange).toHaveBeenLastCalledWith(false)
})
it('keeps an approved request and hold when Android time still needs correction', async () => {
  bridge.getNativeClockRecoveryState.mockResolvedValue(approved)
  bridge.retryNativeClockRecovery.mockResolvedValue({
    ...approved,
    reasonCode: 'clock_time_settings_required',
  })
  const p = props()
  render(<NativeClockRecovery {...p} />)
  await screen.findByRole('button', { name: 'Finish clock recovery' })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Finish clock recovery' }))
  await screen.findByText(/Correct automatic date and time in Android Settings/)
  expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
  expect(p.onChanged).not.toHaveBeenCalled()
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(bridge.startNativeClockRecovery).not.toHaveBeenCalled()
})
it('discards a delayed discovery after native lock and exposes no stale action', async () => {
  let done!: (v: unknown) => void
  bridge.getNativeClockRecoveryState.mockReturnValue(
    new Promise((r) => {
      done = r
    })
  )
  const p = props()
  render(<NativeClockRecovery {...p} />)
  await waitFor(() => expect(bridge.getNativeClockRecoveryState).toHaveBeenCalledOnce())
  act(() => bridge.subscribeNativeCheckoutLock.mock.calls[0][0]())
  await act(async () => done(ready))
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  expect(p.onCheckedVersion).not.toHaveBeenCalled()
  expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
})
it('hides the original account reference immediately when actor changes', async () => {
  bridge.getNativeClockRecoveryState.mockResolvedValue(pending)
  const p = props()
  const view = render(<NativeClockRecovery {...p} />)
  await screen.findByText('Recovery reference: ' + id(1))
  bridge.getNativeClockRecoveryState.mockReturnValue(new Promise(() => {}))
  view.rerender(<NativeClockRecovery {...p} actorId={id(8)} revision={2} />)
  expect(screen.queryByText('Recovery reference: ' + id(1))).not.toBeInTheDocument()
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
})
