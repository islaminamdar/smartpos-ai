import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../apps/android-pos/node_modules/react', async () => await import('react'))
const bridge = vi.hoisted(() => ({
  readOfflineState: vi.fn(),
  openNativeOfflineShift: vi.fn(),
  prepareNativeOffline: vi.fn(),
  unlockNativeOffline: vi.fn(),
  lockNativeOffline: vi.fn(),
  hasNativeLedger: vi.fn(),
  readDeviceSnapshot: vi.fn(),
  readAccessState: vi.fn(),
  signInNative: vi.fn(),
  signOutNative: vi.fn(),
  enrollNativeCounter: vi.fn(),
}))
vi.mock('../../../apps/android-pos/src/native', async () => ({
  ...(await vi.importActual('../../../apps/android-pos/src/native')),
  ...bridge,
}))
import App from '../../../apps/android-pos/src/App'
const snapshot = {
  identity: { installationId: 'qa-installation', deviceKeySha256: 'b'.repeat(64) },
  status: { receiptCount: 2, pendingCount: 1, lastAcknowledgedAt: null },
  history: {
    receipts: [
      {
        id: 'qa-1',
        documentNumber: 'QA-0001',
        totalFils: 525,
        issuedAt: '2026-10-16T04:00:00.000Z',
        syncState: 'pending',
      },
    ],
    hasMore: true,
  },
  checkedAt: '2026-10-16T04:05:00.000Z',
}
const signedOut = {
  schemaVersion: 1,
  status: 'signed_out',
  actorId: null,
  branches: [],
  device: null,
  canPrepareOffline: false,
}
const branchId = '10000000-0000-4000-8000-000000000001'
const signedIn = {
  ...signedOut,
  status: 'signed_in',
  actorId: '10000000-0000-4000-8000-000000000002',
  branches: [
    {
      id: branchId,
      organizationId: '10000000-0000-4000-8000-000000000003',
      name: 'Synthetic restaurant',
      role: 'manager',
    },
  ],
}
const enrolled = {
  ...signedIn,
  device: { id: '10000000-0000-4000-8000-000000000004', branchId, name: 'Front counter' },
}
const offline = {
  schemaVersion: 1,
  status: 'not_prepared',
  stage: 'sign_in',
  canIssue: false,
  shiftId: null,
  authority: null,
  pinProvisioned: false,
  noticeCode: null,
  pendingAction: null,
  pendingOpeningCashFils: null,
}
const offlinePrepared = {
  ...offline,
  status: 'prepared',
  stage: 'prepared',
  pinProvisioned: true,
  shiftId: branchId,
  authority: {
    id: branchId,
    expiresAt: '2026-10-17T08:00:00.000Z',
    firstInvoice: 101,
    lastInvoice: 200,
  },
}
beforeEach(() => {
  bridge.readOfflineState.mockResolvedValue(offline)
  bridge.openNativeOfflineShift.mockResolvedValue({
    ...offline,
    stage: 'prepare',
    shiftId: branchId,
  })
  bridge.prepareNativeOffline.mockResolvedValue(offlinePrepared)
  bridge.unlockNativeOffline.mockResolvedValue(offlinePrepared)
  bridge.lockNativeOffline.mockResolvedValue({
    ...offlinePrepared,
    status: 'locked',
    stage: 'unlock',
  })

  bridge.hasNativeLedger.mockReturnValue(true)
  bridge.readDeviceSnapshot.mockResolvedValue(snapshot)
  bridge.readAccessState.mockResolvedValue(signedOut)
  bridge.signInNative.mockResolvedValue(signedIn)
  bridge.signOutNative.mockResolvedValue(signedOut)
  bridge.enrollNativeCounter.mockResolvedValue(enrolled)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
describe('Android foundation screens', () => {
  it('keeps unavailable browser counts distinct from zero and cannot sell', () => {
    bridge.hasNativeLedger.mockReturnValue(false)
    render(<App />)
    expect(screen.getAllByText('Unavailable')).toHaveLength(3)
    expect(screen.getByText('New sales paused')).toBeTruthy()
    expect(bridge.readDeviceSnapshot).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /sale|payment/i })).toBeNull()
  })
  it('shows real summary amounts and pending status with honest incomplete history', async () => {
    render(<App />)
    await screen.findByText('2')
    fireEvent.click(screen.getByRole('button', { name: 'Saved receipts' }))
    expect(screen.getByText('QA-0001')).toBeTruthy()
    expect(screen.getByText('AED 5.25')).toBeTruthy()
    expect(screen.getByText('Saved on this device · awaiting sync')).toBeTruthy()
    expect(screen.getByText(/More receipts remain/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /print/i })).toBeNull()
  })
  it('preserves last checked history on read failure and recovers with the refresh control', async () => {
    render(<App />)
    await screen.findByText('2')
    bridge.readDeviceSnapshot.mockRejectedValueOnce(new Error('read failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh device status' }))
    await screen.findByRole('alert')
    expect(screen.getByText('2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Saved receipts' }))
    expect(screen.getByText('QA-0001')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry check' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
  it('does not overlap refresh reads', async () => {
    let resolve!: (value: unknown) => void
    bridge.readDeviceSnapshot.mockReturnValue(
      new Promise((r) => {
        resolve = r
      })
    )
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Checking…' }))
    expect(bridge.readDeviceSnapshot).toHaveBeenCalledTimes(1)
    await act(async () => resolve(snapshot))
  })
})

describe('Native secure access', () => {
  it('uses native sign-in without credential fields and requires explicit manager enrollment', async () => {
    render(<App />)
    const signIn = await screen.findByRole('button', { name: 'Sign in securely' })
    await waitFor(() => expect(signIn).toBeEnabled())
    expect(document.querySelector('input[type=password]')).toBeNull()
    expect(screen.queryByLabelText(/password|email|pin/i)).toBeNull()
    fireEvent.click(signIn)
    await screen.findByText('Signed in')
    expect(bridge.signInNative).toHaveBeenCalledWith()
    expect(bridge.enrollNativeCounter).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Enroll this counter' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Counter name'), {
      target: { value: ' Front counter ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Enroll this counter' }))
    await screen.findByText('Enrolled counter')
    expect(bridge.enrollNativeCounter).toHaveBeenCalledWith({ branchId, name: 'Front counter' })
    expect(screen.getByText('New sales paused')).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: /record payment|prepare offline|save sale/i })
    ).toBeNull()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign out of this app' })).toBeEnabled()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of this app' }))
    await screen.findByRole('button', { name: 'Sign in securely' })
    expect(bridge.signOutNative).toHaveBeenCalledTimes(1)
  })
  it('handles native dialog cancellation quietly without enrollment', async () => {
    bridge.signInNative.mockRejectedValueOnce(new Error('native_sign_in_cancelled'))
    render(<App />)
    const button = await screen.findByRole('button', { name: 'Sign in securely' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    await screen.findByText('Sign-in cancelled.')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(button).toBeEnabled()
    expect(bridge.enrollNativeCounter).not.toHaveBeenCalled()
  })
  it('blocks cashier enrollment and keeps signed-in access separate from permission to sell', async () => {
    bridge.readAccessState.mockResolvedValue({
      ...signedIn,
      branches: [{ ...signedIn.branches[0], role: 'cashier' }],
    })
    render(<App />)
    await screen.findByText(/A manager or owner must enroll/)
    expect(screen.queryByRole('button', { name: 'Enroll this counter' })).toBeNull()
    expect(screen.getByText('New sales paused')).toBeTruthy()
  })
  it('requires a readback after uncertain enrollment and preserves access work across history navigation', async () => {
    bridge.readAccessState.mockResolvedValue(signedIn)
    bridge.enrollNativeCounter.mockRejectedValueOnce(new Error('native_enrollment_uncertain'))
    render(<App />)
    await screen.findByLabelText('Counter name')
    fireEvent.change(screen.getByLabelText('Counter name'), { target: { value: 'Front counter' } })
    fireEvent.click(screen.getByRole('button', { name: 'Saved receipts' }))
    fireEvent.click(screen.getByRole('button', { name: 'This device' }))
    expect(screen.getByLabelText('Counter name')).toHaveValue('Front counter')
    fireEvent.click(screen.getByRole('button', { name: 'Enroll this counter' }))
    await screen.findByText(/Counter enrollment needs confirmation/)
    expect(screen.getByRole('button', { name: 'Enroll this counter' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Enroll this counter' }))
    expect(bridge.enrollNativeCounter).toHaveBeenCalledTimes(1)
    bridge.readAccessState.mockResolvedValue(enrolled)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check access' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Check access' }))
    await screen.findByText('Enrolled counter')
    expect(bridge.enrollNativeCounter).toHaveBeenCalledTimes(1)
  })
  it('keeps receipts readable when access fails and never exposes raw native error text', async () => {
    bridge.readAccessState.mockRejectedValue(new Error('private unexpected error payload'))
    render(<App />)
    await screen.findByText('Access needs checking')
    expect(screen.queryByText('private unexpected error payload')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sign in securely' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Saved receipts' }))
    await screen.findByText('QA-0001')
  })
})

describe('Native sign-out completion', () => {
  it('reads local signed-out state after failed revocation and requires explicit finish before sign-in', async () => {
    bridge.readAccessState.mockResolvedValue(signedIn)
    bridge.signOutNative
      .mockRejectedValueOnce(new Error('native_sign_out_pending'))
      .mockResolvedValueOnce(signedOut)
    render(<App />)
    const signOut = await screen.findByRole('button', { name: 'Sign out of this app' })
    bridge.readAccessState.mockResolvedValue(signedOut)
    await waitFor(() => expect(signOut).toBeEnabled())
    fireEvent.click(signOut)
    await screen.findByText('Signed out on this device. Connect to finish server sign-out.')
    expect(screen.getByRole('button', { name: 'Sign in securely' })).toBeDisabled()
    expect(bridge.signOutNative).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Finish sign-out' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in securely' })).toBeEnabled()
    )
    expect(bridge.signOutNative).toHaveBeenCalledTimes(2)
    expect(bridge.signInNative).not.toHaveBeenCalled()
  })
  it('discovers retained pending sign-out after restart without retrying sign-in automatically', async () => {
    bridge.signInNative.mockRejectedValueOnce(new Error('native_sign_out_pending'))
    render(<App />)
    const button = await screen.findByRole('button', { name: 'Sign in securely' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    await screen.findByRole('button', { name: 'Finish sign-out' })
    expect(bridge.signInNative).toHaveBeenCalledTimes(1)
    expect(bridge.signOutNative).not.toHaveBeenCalled()
    expect(button).toBeDisabled()
  })
})

describe('Native access operation lifetime', () => {
  it('keeps one enrollment in flight while switching receipt and device views', async () => {
    bridge.readAccessState.mockResolvedValue(signedIn)
    let finish!: (value: unknown) => void
    bridge.enrollNativeCounter.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    render(<App />)
    await screen.findByLabelText('Counter name')
    fireEvent.change(screen.getByLabelText('Counter name'), { target: { value: 'Front counter' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enroll this counter' }))
    fireEvent.click(screen.getByRole('button', { name: 'Saved receipts' }))
    fireEvent.click(screen.getByRole('button', { name: 'This device' }))
    expect(screen.getByRole('button', { name: 'Enroll this counter' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Check access' })).toBeDisabled()
    expect(bridge.enrollNativeCounter).toHaveBeenCalledTimes(1)
    await act(async () => finish(enrolled))
    await screen.findByText('Enrolled counter')
  })
})

describe('Native offline preparation', () => {
  it('does not briefly enable account changes before the first local setup check completes', async () => {
    let finish!: (value: unknown) => void
    bridge.readOfflineState.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    render(<App />)
    const signIn = await screen.findByRole('button', { name: 'Sign in securely' })
    expect(signIn).toBeDisabled()
    fireEvent.click(signIn)
    expect(bridge.signInNative).not.toHaveBeenCalled()
    await act(async () => finish(offline))
    expect(signIn).toBeEnabled()
  })

  it('keeps expired authority readable and routes unsupported renewal to support without an action', async () => {
    bridge.readOfflineState.mockResolvedValue({
      ...offlinePrepared,
      status: 'blocked',
      stage: 'recover',
      noticeCode: 'offline_permission_expired',
    })
    render(<App />)
    await screen.findByText(/Saved offline permission has expired/)
    expect(screen.getByText('101–200')).toBeTruthy()
    expect(
      screen.queryByRole('button', {
        name: /Prepare this counter|Retry saved|Lock offline|Unlock with/,
      })
    ).toBeNull()
    expect(screen.getByText(/A local status check does not renew access/)).toBeTruthy()
    expect(bridge.prepareNativeOffline).not.toHaveBeenCalled()
  })

  it('requires renewed opening-cash consent after account access is refreshed', async () => {
    bridge.readAccessState.mockResolvedValue(enrolled)
    bridge.readOfflineState.mockResolvedValue({ ...offline, stage: 'open_shift' })
    render(<App />)
    const input = await screen.findByLabelText('Opening cash (AED)')
    await waitFor(() => expect(input).toBeEnabled())
    fireEvent.change(input, { target: { value: '100.00' } })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Open counter shift' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Check access' }))
    await waitFor(() => expect(input).toBeEnabled())
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Open counter shift' })).toBeDisabled()
    expect(bridge.openNativeOfflineShift).not.toHaveBeenCalled()
  })

  it('prepares explicitly despite canPrepareOffline false, keeps PIN native and sales paused', async () => {
    bridge.readAccessState.mockResolvedValue(enrolled)
    bridge.readOfflineState.mockResolvedValue({ ...offline, stage: 'prepare' })
    render(<App />)
    const prepare = await screen.findByRole('button', { name: 'Prepare this counter' })
    await waitFor(() => expect(prepare).toBeEnabled())
    expect(bridge.prepareNativeOffline).not.toHaveBeenCalled()
    expect(document.querySelector('input[type=password]')).toBeNull()
    fireEvent.click(prepare)
    await screen.findByText('Offline preparation saved')
    expect(bridge.prepareNativeOffline).toHaveBeenCalledWith()
    expect(screen.getByText('101–200')).toBeTruthy()
    expect(screen.getByText('New sales paused')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /payment|sale/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Lock offline access' }))
    await screen.findByRole('button', { name: 'Unlock with Android PIN' })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock with Android PIN' }))
    await screen.findByRole('button', { name: 'Lock offline access' })
    expect(bridge.unlockNativeOffline).toHaveBeenCalledWith()
  })
  it('requires exact opening cash confirmation and resets consent when amount changes', async () => {
    bridge.readOfflineState.mockResolvedValue({ ...offline, stage: 'open_shift' })
    render(<App />)
    const input = await screen.findByLabelText('Opening cash (AED)')
    await waitFor(() => expect(input).toBeEnabled())
    fireEvent.change(input, { target: { value: '125.50' } })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Open counter shift' })).toBeEnabled()
    fireEvent.change(input, { target: { value: '126.50' } })
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Open counter shift' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Open counter shift' }))
    await screen.findByRole('button', { name: 'Prepare this counter' })
    expect(bridge.openNativeOfflineShift).toHaveBeenCalledExactlyOnceWith(12650)
    expect(bridge.prepareNativeOffline).not.toHaveBeenCalled()
  })
  it('restores immutable pending shift amount after restart and retries only on explicit action', async () => {
    bridge.readOfflineState.mockResolvedValue({
      ...offline,
      status: 'blocked',
      stage: 'recover',
      pendingAction: 'open_shift',
      pendingOpeningCashFils: 23505,
      noticeCode: 'offline_preparation_uncertain',
    })
    render(<App />)
    const retry = await screen.findByRole('button', { name: 'Retry saved shift request' })
    await waitFor(() => expect(retry).toBeEnabled())
    expect(screen.getByText(/Opening cash: AED 235.05/)).toBeTruthy()
    expect(screen.queryByLabelText('Opening cash (AED)')).toBeNull()
    expect(bridge.openNativeOfflineShift).not.toHaveBeenCalled()
    fireEvent.click(retry)
    await screen.findByRole('button', { name: 'Prepare this counter' })
    expect(bridge.openNativeOfflineShift).toHaveBeenCalledExactlyOnceWith(23505)
  })
  it('reconciles an uncertain prepare by local read without automatic mutation retry', async () => {
    bridge.readOfflineState.mockResolvedValue({ ...offline, stage: 'prepare' })
    bridge.prepareNativeOffline.mockRejectedValueOnce({ code: 'offline_preparation_uncertain' })
    render(<App />)
    const prepare = await screen.findByRole('button', { name: 'Prepare this counter' })
    await waitFor(() => expect(prepare).toBeEnabled())
    bridge.readOfflineState.mockResolvedValue({
      ...offline,
      status: 'blocked',
      stage: 'recover',
      pendingAction: 'prepare',
    })
    fireEvent.click(prepare)
    await screen.findByRole('button', { name: 'Retry saved preparation' })
    expect(bridge.prepareNativeOffline).toHaveBeenCalledTimes(1)
    expect(bridge.openNativeOfflineShift).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Check offline status' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry saved preparation' })).toBeEnabled()
    )
    expect(bridge.prepareNativeOffline).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry saved preparation' }))
    await screen.findByText('Offline preparation saved')
    expect(bridge.prepareNativeOffline).toHaveBeenCalledTimes(2)
  })
  it('blocks account changes and duplicate preparation across navigation until native call resolves', async () => {
    bridge.readAccessState.mockResolvedValue(enrolled)
    bridge.readOfflineState.mockResolvedValue({ ...offline, stage: 'prepare' })
    let resolve!: (value: unknown) => void
    bridge.prepareNativeOffline.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r
      })
    )
    render(<App />)
    const prepare = await screen.findByRole('button', { name: 'Prepare this counter' })
    await waitFor(() => expect(prepare).toBeEnabled())
    fireEvent.click(prepare)
    expect(screen.getByRole('button', { name: 'Sign out of this app' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Saved receipts' }))
    fireEvent.click(screen.getByRole('button', { name: 'This device' }))
    fireEvent.click(screen.getByRole('button', { name: 'Prepare this counter' }))
    expect(bridge.prepareNativeOffline).toHaveBeenCalledTimes(1)
    expect(bridge.signOutNative).not.toHaveBeenCalled()
    await act(async () => resolve(offlinePrepared))
    expect(screen.getByRole('button', { name: 'Sign out of this app' })).toBeEnabled()
  })
  it('retains stale prepared details on read failure but disables unlock or lock actions', async () => {
    bridge.readOfflineState.mockResolvedValue(offlinePrepared)
    render(<App />)
    await screen.findByRole('button', { name: 'Lock offline access' })
    bridge.readOfflineState.mockRejectedValueOnce(new Error('unexpected sensitive text'))
    fireEvent.click(screen.getByRole('button', { name: 'Check offline status' }))
    await screen.findByText('Last checked setup — check again')
    expect(screen.getByText('101–200')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Lock offline access' })).toBeDisabled()
    expect(screen.queryByText(/unexpected sensitive text/)).toBeNull()
  })
  it('refreshes local offline state after enrollment and handles PIN cancellation quietly', async () => {
    bridge.readAccessState.mockResolvedValue(signedIn)
    render(<App />)
    const input = await screen.findByLabelText('Counter name')
    await waitFor(() => expect(input).toBeEnabled())
    bridge.readOfflineState.mockResolvedValue({ ...offline, stage: 'prepare' })
    fireEvent.change(input, { target: { value: 'Front counter' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enroll this counter' }))
    const prepare = await screen.findByRole('button', { name: 'Prepare this counter' })
    bridge.prepareNativeOffline.mockRejectedValueOnce({ code: 'native_pin_cancelled' })
    fireEvent.click(prepare)
    await screen.findByText(/Android PIN dialog cancelled/)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(bridge.prepareNativeOffline).toHaveBeenCalledTimes(1)
  })
})
