import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../apps/android-pos/node_modules/react', async () => await import('react'))
const bridge = vi.hoisted(() => ({
  readNativeBundleRecovery: vi.fn(),
  recoverNativeMissingBundle: vi.fn(),
}))
vi.mock('../../../apps/android-pos/src/native', async () => ({
  ...(await vi.importActual('../../../apps/android-pos/src/native')),
  ...bridge,
}))
import NativeBundleRecovery from '../../../apps/android-pos/src/NativeBundleRecovery'
import {
  parseBundleRecoveryState,
  knownBundleRecoveryReason,
  nativeBundleRecoveryError,
} from '../../../apps/android-pos/src/native'
const authorityId = '10000000-0000-4000-8000-000000000001'
const available = {
  schemaVersion: 1,
  status: 'available',
  authorityId,
  reasonCode: null,
  canRecover: true,
}
const retained = { ...available, status: 'retained', canRecover: false }
const props = () => ({
  available: true,
  ready: true,
  revision: 1,
  actionsBlocked: false,
  operationLock: { current: false },
  onBusyChange: vi.fn(),
  onChanged: vi.fn(),
})
beforeEach(() => {
  bridge.readNativeBundleRecovery.mockResolvedValue(available)
  bridge.recoverNativeMissingBundle.mockResolvedValue(retained)
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
async function check() {
  fireEvent.click(screen.getByRole('button', { name: 'Check missing allocation' }))
  await screen.findByText('A missing allocation can be recovered')
}
async function recover() {
  await check()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Recover missing allocation' }))
}
describe('missing allocation recovery UI', () => {
  it('starts with an explicit local check, then exact allocation consent before mutation', async () => {
    const p = props()
    render(<NativeBundleRecovery {...p} />)
    expect(bridge.readNativeBundleRecovery).not.toHaveBeenCalled()
    await check()
    expect(screen.getByRole('button', { name: 'Recover missing allocation' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Recover missing allocation' }))
    await screen.findByText(/Original allocation recovered and permanently finished on this device/)
    expect(bridge.recoverNativeMissingBundle).toHaveBeenCalledExactlyOnceWith(authorityId)
    expect(p.onChanged).toHaveBeenCalledTimes(1)
  })
  it('reads after a lost result and accepts the same canonical retained state without retrying', async () => {
    bridge.recoverNativeMissingBundle.mockRejectedValueOnce(new Error('offline_recovery_uncertain'))
    bridge.readNativeBundleRecovery.mockResolvedValueOnce(available).mockResolvedValueOnce(retained)
    render(<NativeBundleRecovery {...props()} />)
    await recover()
    await screen.findByText(/Original allocation recovered and permanently finished on this device/)
    expect(bridge.readNativeBundleRecovery).toHaveBeenCalledTimes(2)
    expect(bridge.recoverNativeMissingBundle).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('requires a new consent after uncertainty resolves to the same available allocation', async () => {
    bridge.recoverNativeMissingBundle.mockRejectedValueOnce(new Error('offline_recovery_uncertain'))
    render(<NativeBundleRecovery {...props()} />)
    await recover()
    await screen.findByRole('alert')
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled())
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Recover missing allocation' })).toBeDisabled()
    expect(bridge.recoverNativeMissingBundle).toHaveBeenCalledTimes(1)
  })
  it('will not replace an uncertain allocation with a different authority', async () => {
    bridge.recoverNativeMissingBundle.mockRejectedValueOnce(new Error('offline_recovery_uncertain'))
    bridge.readNativeBundleRecovery
      .mockResolvedValueOnce(available)
      .mockResolvedValue({ ...available, authorityId: '10000000-0000-4000-8000-000000000002' })
    render(<NativeBundleRecovery {...props()} />)
    await recover()
    await screen.findByText(/allocation no longer matches/)
    expect(screen.getByRole('button', { name: 'Recover missing allocation' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Check missing allocation' }))
    await waitFor(() => expect(bridge.readNativeBundleRecovery).toHaveBeenCalledTimes(3))
    expect(bridge.recoverNativeMissingBundle).toHaveBeenCalledExactlyOnceWith(authorityId)
  })
  it('binds consent to the exact refreshed allocation identity', async () => {
    render(<NativeBundleRecovery {...props()} />)
    await check()
    fireEvent.click(screen.getByRole('checkbox'))
    bridge.readNativeBundleRecovery.mockResolvedValue({
      ...available,
      authorityId: '10000000-0000-4000-8000-000000000002',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check missing allocation' }))
    await screen.findByText('10000000-0000-4000-8000-000000000002')
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Recover missing allocation' })).toBeDisabled()
  })
  it('permits status reads but blocks recovery while any payment is unresolved', async () => {
    render(<NativeBundleRecovery {...props()} actionsBlocked />)
    await check()
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Recover missing allocation' })).toBeDisabled()
    expect(bridge.recoverNativeMissingBundle).not.toHaveBeenCalled()
  })
  it('respects the synchronous shared lock and prevents double recovery', async () => {
    let resolve!: (value: unknown) => void
    bridge.recoverNativeMissingBundle.mockReturnValue(new Promise((r) => (resolve = r)))
    const p = props()
    render(<NativeBundleRecovery {...p} />)
    await recover()
    expect(p.operationLock.current).toBe(true)
    expect(screen.getByRole('button', { name: 'Check missing allocation' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Recover missing allocation' }))
    expect(bridge.recoverNativeMissingBundle).toHaveBeenCalledTimes(1)
    await act(async () => resolve(retained))
    expect(p.operationLock.current).toBe(false)
  })
  it('does not apply a delayed recovery result after app backgrounding; explicit check resolves it', async () => {
    let resolve!: (value: unknown) => void
    bridge.recoverNativeMissingBundle.mockReturnValue(new Promise((r) => (resolve = r)))
    const p = props()
    render(<NativeBundleRecovery {...p} />)
    await recover()
    await act(async () => window.dispatchEvent(new Event('pagehide')))
    await act(async () => resolve(retained))
    expect(p.onChanged).not.toHaveBeenCalled()
    expect(
      screen.queryByText(/Original allocation recovered and permanently finished on this device/)
    ).toBeNull()
    bridge.readNativeBundleRecovery.mockResolvedValue(retained)
    fireEvent.click(screen.getByRole('button', { name: 'Check missing allocation' }))
    await screen.findByText(/Original allocation recovered and permanently finished on this device/)
    expect(p.onChanged).toHaveBeenCalledTimes(1)
  })
  it('unknown native reason never enables recovery', async () => {
    bridge.readNativeBundleRecovery.mockResolvedValue({
      ...available,
      reasonCode: 'future_unknown_reason',
    })
    render(<NativeBundleRecovery {...props()} />)
    await check()
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Recover missing allocation' })).toBeDisabled()
  })
  it('does not enable actions for stale revision or a failed native read', async () => {
    const p = props()
    const r = render(<NativeBundleRecovery {...p} />)
    await check()
    fireEvent.click(screen.getByRole('checkbox'))
    r.rerender(<NativeBundleRecovery {...p} revision={2} />)
    expect(screen.getByRole('button', { name: 'Recover missing allocation' })).toBeDisabled()
    bridge.readNativeBundleRecovery.mockRejectedValue(new Error('private_native_detail'))
    fireEvent.click(screen.getByRole('button', { name: 'Check missing allocation' }))
    await screen.findByRole('alert')
    expect(screen.queryByText('private_native_detail')).toBeNull()
    expect(screen.getByRole('button', { name: 'Recover missing allocation' })).toBeDisabled()
  })
})
describe('bundle recovery state boundary', () => {
  it.each([
    available,
    retained,
    { ...available, status: 'not_needed', authorityId: null, canRecover: false },
    {
      ...available,
      status: 'blocked',
      reasonCode: 'payment_reconciliation_required',
      canRecover: false,
    },
  ])('accepts bounded native state', (value) =>
    expect(parseBundleRecoveryState(value)).toEqual(value)
  )
  it.each([
    { ...available, schemaVersion: 2 },
    { ...available, authorityId: null },
    { ...available, canRecover: false },
    { ...available, status: 'unknown' },
    { ...retained, canRecover: true },
    { ...available, reasonCode: '<script>' },
    { ...available, extra: 1 },
  ])('rejects malformed or inconsistent native state', (value) =>
    expect(() => parseBundleRecoveryState(value)).toThrow()
  )
  it('does not turn unknown notices or private error text into actionable recovery', () => {
    expect(knownBundleRecoveryReason('future')).toBe(false)
    expect(nativeBundleRecoveryError(new Error('private_detail'))).not.toContain('private_detail')
  })
})
