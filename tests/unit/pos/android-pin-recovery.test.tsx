import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../apps/android-pos/node_modules/react', async () => await import('react'))
const bridge = vi.hoisted(() => ({
  getNativePinRecoveryState: vi.fn(),
  startNativePinRecovery: vi.fn(),
  retryNativePinRecovery: vi.fn(),
  subscribeNativeCheckoutLock: vi.fn(),
}))
vi.mock('../../../apps/android-pos/src/native', async () => ({
  ...(await vi.importActual('../../../apps/android-pos/src/native')),
  ...bridge,
}))
import NativePinRecovery from '../../../apps/android-pos/src/NativePinRecovery'
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
  reasonCode: 'pin_recovery_pending',
}
const approved = {
  ...pending,
  status: 'approved',
  passwordRequired: false,
  reasonCode: 'pin_recovery_approved',
}
const completed = {
  ...ready,
  status: 'completed',
  requestId: id(1),
  passwordRequired: false,
  reasonCode: 'pin_recovery_completed',
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
  bridge.getNativePinRecoveryState.mockResolvedValue(ready)
  bridge.startNativePinRecovery.mockResolvedValue(completed)
  bridge.retryNativePinRecovery.mockResolvedValue(completed)
  bridge.subscribeNativeCheckoutLock.mockResolvedValue({
    remove: vi.fn().mockResolvedValue(undefined),
  })
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
async function consentStart() {
  await screen.findByRole('button', { name: 'Continue in Android' })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Continue in Android' }))
}
describe('native PIN recovery UI', () => {
  it('requires explicit consent, keeps secrets outside JS and leaves completion locked', async () => {
    const p = props()
    const view = render(<NativePinRecovery {...p} />)
    const start = await screen.findByRole('button', { name: 'Continue in Android' })
    expect(start).toBeDisabled()
    expect(view.container.querySelectorAll('input:not([type=checkbox])')).toHaveLength(0)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(start)
    await screen.findByText(/PIN recovery complete\./)
    expect(bridge.startNativePinRecovery).toHaveBeenCalledExactlyOnceWith()
    expect(p.onPendingChange).toHaveBeenLastCalledWith(false)
    expect(p.onChanged).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Recover PIN again' })).toBeDisabled()
  })
  it('restores exact pending request and uses fresh consent, with no replacement start', async () => {
    bridge.getNativePinRecoveryState.mockResolvedValue(pending)
    render(<NativePinRecovery {...props()} />)
    const retry = await screen.findByRole('button', { name: 'Check / retry saved PIN recovery' })
    expect(retry).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(retry)
    await screen.findByText(/PIN recovery complete\./)
    expect(bridge.retryNativePinRecovery).toHaveBeenCalledExactlyOnceWith(id(1))
    expect(bridge.startNativePinRecovery).not.toHaveBeenCalled()
  })
  it('handles approved foreground apply with no password field', async () => {
    bridge.getNativePinRecoveryState.mockResolvedValue(approved)
    render(<NativePinRecovery {...props()} />)
    await screen.findByRole('button', { name: 'Finish saved PIN recovery' })
    expect(screen.getByText(/No account password is needed/)).toBeVisible()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Finish saved PIN recovery' }))
    await screen.findByText(/PIN recovery complete\./)
    expect(bridge.retryNativePinRecovery).toHaveBeenCalledExactlyOnceWith(id(1))
  })
  it('allows signed-out lookup-only retry without exposing a new PIN request', async () => {
    bridge.getNativePinRecoveryState.mockResolvedValue({ ...pending, passwordRequired: false })
    bridge.retryNativePinRecovery.mockResolvedValue({ ...approved, canRetry: false })
    render(<NativePinRecovery {...props()} actorId={null} />)
    await screen.findByRole('button', { name: 'Check / retry saved PIN recovery' })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Check / retry saved PIN recovery' }))
    await screen.findByText(/Approval is saved\./)
    expect(bridge.retryNativePinRecovery).toHaveBeenCalledExactlyOnceWith(id(1))
    expect(screen.queryByRole('button', { name: 'Continue in Android' })).not.toBeInTheDocument()
  })
  it('reads saved state after a lost response and never automatically retries', async () => {
    bridge.startNativePinRecovery.mockRejectedValue(new Error('pin_recovery_uncertain'))
    bridge.getNativePinRecoveryState.mockResolvedValueOnce(ready).mockResolvedValue(pending)
    const p = props()
    render(<NativePinRecovery {...p} />)
    await consentStart()
    await screen.findByRole('button', { name: 'Check / retry saved PIN recovery' })
    expect(bridge.getNativePinRecoveryState).toHaveBeenCalledTimes(2)
    expect(bridge.retryNativePinRecovery).not.toHaveBeenCalled()
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })
  it('keeps original request held if a read returns missing or different identity', async () => {
    bridge.getNativePinRecoveryState
      .mockResolvedValueOnce(pending)
      .mockResolvedValue({ ...pending, requestId: id(9) })
    const p = props()
    render(<NativePinRecovery {...p} />)
    await screen.findByRole('button', { name: 'Check / retry saved PIN recovery' })
    fireEvent.click(screen.getByRole('button', { name: 'Check saved PIN recovery' }))
    await screen.findByRole('alert')
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
    expect(
      screen.queryByRole('button', { name: 'Check / retry saved PIN recovery' })
    ).not.toBeInTheDocument()
  })
  it('failed local discovery holds new work and allows only explicit read retry', async () => {
    bridge.getNativePinRecoveryState
      .mockRejectedValueOnce(new Error('native_storage_unavailable'))
      .mockResolvedValue(ready)
    const p = props()
    render(<NativePinRecovery {...p} />)
    await screen.findByRole('alert')
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Check saved PIN recovery' }))
    await screen.findByRole('button', { name: 'Continue in Android' })
    expect(p.onPendingChange).toHaveBeenLastCalledWith(false)
  })
  it('blocks unknown capabilities/reasons and preserves a blocked request hold', async () => {
    bridge.getNativePinRecoveryState.mockResolvedValue({
      ...pending,
      status: 'blocked',
      canRetry: false,
      reasonCode: 'pin_recovery_conflict',
    })
    const p = props()
    render(<NativePinRecovery {...p} />)
    await screen.findByText(/conflicts with another record/)
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
  it('suppresses a delayed native success and clears consent on background', async () => {
    let done!: (v: unknown) => void
    bridge.startNativePinRecovery.mockReturnValue(
      new Promise((r) => {
        done = r
      })
    )
    const p = props()
    render(<NativePinRecovery {...p} />)
    await consentStart()
    act(() => window.dispatchEvent(new Event('pagehide')))
    await act(async () => done(completed))
    expect(screen.queryByText(/PIN recovery complete\./)).not.toBeInTheDocument()
    expect(p.onChanged).not.toHaveBeenCalled()
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
  })
  it('suppresses old-account responses even if the native call succeeds', async () => {
    let done!: (v: unknown) => void
    bridge.startNativePinRecovery.mockReturnValue(
      new Promise((r) => {
        done = r
      })
    )
    const p = props()
    const view = render(<NativePinRecovery {...p} />)
    await consentStart()
    view.rerender(<NativePinRecovery {...p} actorId={id(8)} revision={2} />)
    await act(async () => done(completed))
    expect(p.onChanged).not.toHaveBeenCalled()
    expect(screen.queryByText(/PIN recovery complete\./)).not.toBeInTheDocument()
  })
  it('fails closed if native lifecycle monitoring cannot attach', async () => {
    bridge.subscribeNativeCheckoutLock.mockRejectedValue(new Error('unavailable'))
    const p = props()
    render(<NativePinRecovery {...p} />)
    await screen.findByRole('alert')
    expect(bridge.getNativePinRecoveryState).not.toHaveBeenCalled()
    expect(p.onPendingChange).toHaveBeenLastCalledWith(true)
  })
  it('does not enter a native dialog while another operation owns the shared lock', async () => {
    const p = props()
    render(<NativePinRecovery {...p} />)
    await screen.findByRole('button', { name: 'Continue in Android' })
    fireEvent.click(screen.getByRole('checkbox'))
    p.operationLock.current = true
    fireEvent.click(screen.getByRole('button', { name: 'Continue in Android' }))
    expect(bridge.startNativePinRecovery).not.toHaveBeenCalled()
  })
  it('native lock invalidates consent even when account scope is unchanged', async () => {
    render(<NativePinRecovery {...props()} />)
    await screen.findByRole('button', { name: 'Continue in Android' })
    fireEvent.click(screen.getByRole('checkbox'))
    act(() => bridge.subscribeNativeCheckoutLock.mock.calls[0][0]())
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check saved PIN recovery' }))
    await screen.findByRole('checkbox')
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })
})
