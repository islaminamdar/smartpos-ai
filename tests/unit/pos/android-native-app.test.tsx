import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../apps/android-pos/node_modules/react', async () => await import('react'))
const bridge = vi.hoisted(() => ({
  getNativePinRecoveryState: vi.fn(),
  startNativePinRecovery: vi.fn(),
  retryNativePinRecovery: vi.fn(),
  getNativeShiftCloseState: vi.fn(),
  checkNativeShiftClose: vi.fn(),
  closeNativeShift: vi.fn(),
  retryNativeShiftClose: vi.fn(),
  getNativeNextAllocationState: vi.fn(),
  continueNativeAfterAllocation: vi.fn(),
  readNativeBundleRecovery: vi.fn(),
  recoverNativeMissingBundle: vi.fn(),
  subscribeNativeCheckoutLock: vi.fn(),
  readNativeCheckout: vi.fn(),
  readNativeReconciliation: vi.fn(),
  reconcileNativeOffline: vi.fn(),
  finishNativeOfflineAuthority: vi.fn(),
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
const reconciliation = {
  schemaVersion: 1,
  pendingReceipts: 1,
  unsealedAuthorities: 1,
  pendingSeals: 0,
  confirmedSeals: 0,
  status: 'pending',
  noticeCode: null,
}
beforeEach(() => {
  bridge.getNativePinRecoveryState.mockResolvedValue({
    schemaVersion: 1,
    status: 'not_available',
    requestId: null,
    canStart: false,
    canRetry: false,
    passwordRequired: false,
    reasonCode: 'pin_not_provisioned',
  })
  bridge.getNativeShiftCloseState.mockResolvedValue({
    schemaVersion: 1,
    status: 'not_available',
    shiftId: null,
    commandId: null,
    countedCashFils: null,
    result: null,
    pinRequired: false,
    canClose: false,
    canRetry: false,
    reasonCode: null,
  })
  bridge.getNativeNextAllocationState.mockResolvedValue({
    schemaVersion: 1,
    status: 'not_available',
    previousAuthorityId: null,
    shiftId: null,
    nextShiftId: null,
    reasonCode: null,
    canContinue: false,
  })
  bridge.readNativeBundleRecovery.mockResolvedValue({
    schemaVersion: 1,
    status: 'not_needed',
    authorityId: null,
    reasonCode: null,
    canRecover: false,
  })
  bridge.subscribeNativeCheckoutLock.mockResolvedValue({
    remove: vi.fn().mockResolvedValue(undefined),
  })
  bridge.readNativeCheckout.mockResolvedValue({
    schemaVersion: 1,
    canIssue: false,
    reasonCode: 'native_checkout_not_enabled',
    context: null,
    pendingIntentId: null,
    lastReceiptId: null,
    lastResolvedIntentId: null,
    lastResolvedIntent: null,
    unresolvedIntent: null,
    lastReceipt: null,
  })
  bridge.readNativeReconciliation.mockResolvedValue(reconciliation)
  bridge.reconcileNativeOffline.mockResolvedValue({
    ...reconciliation,
    pendingReceipts: 0,
    status: 'idle',
  })
  bridge.finishNativeOfflineAuthority.mockResolvedValue({
    ...reconciliation,
    pendingReceipts: 0,
    unsealedAuthorities: 0,
    confirmedSeals: 1,
    status: 'idle',
  })

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
    expect(
      document.querySelector('input[type=password], input[type=email], input[inputmode=numeric]')
    ).toBeNull()
    fireEvent.click(signIn)
    await screen.findByText('Signed in')
    expect(bridge.signInNative).toHaveBeenCalledWith()
    expect(bridge.enrollNativeCounter).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Enroll this counter' })).toBeDisabled()
    await waitFor(() => expect(screen.getByLabelText('Counter name')).toBeEnabled())
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
    await waitFor(() => expect(screen.getByLabelText('Counter name')).toBeEnabled())
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
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Finish sign-out' })).toBeEnabled()
    )
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
    await waitFor(() => expect(screen.getByLabelText('Counter name')).toBeEnabled())
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
    expect(screen.getAllByText('101–200').length).toBeGreaterThan(0)
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
    expect(screen.getAllByText('101–200').length).toBeGreaterThan(0)
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
    expect(screen.getAllByText('101–200').length).toBeGreaterThan(0)
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
    await waitFor(() => expect(prepare).toBeEnabled())
    fireEvent.click(prepare)
    await screen.findByText(/Android PIN dialog cancelled/)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(bridge.prepareNativeOffline).toHaveBeenCalledTimes(1)
  })
})

describe('Native historical reconciliation', () => {
  it('shows finished allocation as retained records without a support alarm or prepare button', async () => {
    bridge.readAccessState.mockResolvedValue(enrolled)
    bridge.readOfflineState.mockResolvedValue({
      ...offlinePrepared,
      status: 'blocked',
      stage: 'recover',
      noticeCode: 'offline_allocation_finished',
    })
    render(<App />)
    await screen.findByText(/This invoice allocation is finished/)
    expect(screen.queryByText(/This app cannot repair/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Prepare this counter' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Finish offline allocation' })).toBeNull()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Upload saved records' })).toBeEnabled()
    )
  })
  it('retains uncertain upload message through local readback and retries only by explicit click', async () => {
    bridge.reconcileNativeOffline.mockRejectedValueOnce({ code: 'offline_upload_uncertain' })
    render(<App />)
    const upload = await screen.findByRole('button', { name: 'Upload saved records' })
    await waitFor(() => expect(upload).toBeEnabled())
    fireEvent.click(upload)
    await screen.findByText(/Receipt upload was not confirmed/)
    await waitFor(() => expect(upload).toBeEnabled())
    expect(screen.getByText(/Receipt upload was not confirmed/)).toBeTruthy()
    expect(bridge.reconcileNativeOffline).toHaveBeenCalledTimes(1)
    expect(bridge.finishNativeOfflineAuthority).not.toHaveBeenCalled()
    expect(bridge.readDeviceSnapshot.mock.calls.length).toBeGreaterThan(1)
    fireEvent.click(upload)
    await waitFor(() => expect(upload).toBeEnabled())
    expect(bridge.reconcileNativeOffline).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/Receipt upload was not confirmed/)).toBeNull()
  })
  it('keeps PIN cancellation quiet and requires fresh finish consent without automatic retry', async () => {
    bridge.readAccessState.mockResolvedValue(enrolled)
    bridge.readOfflineState.mockResolvedValue(offlinePrepared)
    bridge.finishNativeOfflineAuthority.mockRejectedValueOnce({ code: 'native_pin_cancelled' })
    render(<App />)
    const finish = await screen.findByRole('button', { name: 'Finish offline allocation' })
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled())
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(finish)
    await screen.findByText(/Android PIN dialog cancelled. No new finish request/)
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled())
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(bridge.finishNativeOfflineAuthority).toHaveBeenCalledTimes(1)
    expect(bridge.reconcileNativeOffline).not.toHaveBeenCalled()
  })

  it('uploads historical records while signed out without PIN, sign-in or new sealing', async () => {
    render(<App />)
    const upload = await screen.findByRole('button', { name: 'Upload saved records' })
    await waitFor(() => expect(upload).toBeEnabled())
    expect(bridge.reconcileNativeOffline).not.toHaveBeenCalled()
    fireEvent.click(upload)
    await waitFor(() => expect(bridge.reconcileNativeOffline).toHaveBeenCalledExactlyOnceWith())
    await waitFor(() => expect(upload).toBeEnabled())
    expect(bridge.signInNative).not.toHaveBeenCalled()
    expect(bridge.unlockNativeOffline).not.toHaveBeenCalled()
    expect(bridge.finishNativeOfflineAuthority).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Finish offline allocation' })).toBeNull()
  })
  it('requires consent tied to the exact actor and current invoice allocation', async () => {
    bridge.readAccessState.mockResolvedValue(enrolled)
    bridge.readOfflineState.mockResolvedValue(offlinePrepared)
    render(<App />)
    const finish = await screen.findByRole('button', { name: 'Finish offline allocation' })
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled())
    expect(finish).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(finish).toBeEnabled()
    bridge.readOfflineState.mockResolvedValue({
      ...offlinePrepared,
      authority: {
        ...offlinePrepared.authority,
        id: '10000000-0000-4000-8000-000000000009',
        firstInvoice: 201,
        lastInvoice: 300,
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check offline status' }))
    await screen.findAllByText('201–300')
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled())
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Finish offline allocation' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('checkbox')).toBeChecked()
    // Refreshing offline status also refreshes the counter's payment hold. Consent
    // remains scoped, but finishing stays disabled until that native read settles.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Finish offline allocation' })).toBeEnabled()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Finish offline allocation' }))
    await waitFor(() =>
      expect(bridge.finishNativeOfflineAuthority).toHaveBeenCalledExactlyOnceWith(
        '10000000-0000-4000-8000-000000000009'
      )
    )
    expect(bridge.unlockNativeOffline).not.toHaveBeenCalled()
  })
  it('allows explicit finish for an expired current allocation and never calls shift close', async () => {
    bridge.readAccessState.mockResolvedValue(enrolled)
    bridge.readOfflineState.mockResolvedValue({
      ...offlinePrepared,
      status: 'blocked',
      stage: 'recover',
      noticeCode: 'offline_permission_expired',
    })
    render(<App />)
    const finish = await screen.findByRole('button', { name: 'Finish offline allocation' })
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled())
    expect(screen.getByText(/It keeps records, does not close the cash shift/)).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(finish)
    await waitFor(() =>
      expect(bridge.finishNativeOfflineAuthority).toHaveBeenCalledExactlyOnceWith(
        offlinePrepared.authority.id
      )
    )
    expect(bridge.openNativeOfflineShift).not.toHaveBeenCalled()
    expect(bridge.prepareNativeOffline).not.toHaveBeenCalled()
  })
  it('retains counts on failed status read and blocks writes until explicit recovery', async () => {
    render(<App />)
    const upload = await screen.findByRole('button', { name: 'Upload saved records' })
    await waitFor(() => expect(upload).toBeEnabled())
    bridge.readNativeReconciliation.mockRejectedValueOnce(new Error('private detail'))
    fireEvent.click(screen.getByRole('button', { name: 'Check saved-record status' }))
    await screen.findByText(/Last checked counts are shown/)
    expect(upload).toBeDisabled()
    expect(screen.queryByText(/private detail/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check saved-record status' }))
    await waitFor(() => expect(upload).toBeEnabled())
  })
  it('never loops checks if both offline and reconciliation reads fail', async () => {
    bridge.readOfflineState.mockRejectedValue(new Error('native_storage_unavailable'))
    bridge.readNativeReconciliation.mockRejectedValue(new Error('native_storage_unavailable'))
    render(<App />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in securely' })).toBeEnabled()
    )
    expect(bridge.readOfflineState).toHaveBeenCalledTimes(1)
    expect(bridge.readNativeReconciliation).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Upload saved records' })).toBeDisabled()
  })
  it('blocks actions on an unknown notice and keeps the native code out of the UI', async () => {
    bridge.readNativeReconciliation.mockResolvedValue({
      ...reconciliation,
      status: 'attention',
      noticeCode: 'unexpected_internal',
    })
    render(<App />)
    await screen.findByText(/Reconciliation could not be confirmed/)
    expect(screen.getByRole('button', { name: 'Upload saved records' })).toBeDisabled()
    expect(screen.queryByText(/unexpected_internal/)).toBeNull()
  })
  it('does not overlap upload with access, PIN or another upload across navigation', async () => {
    bridge.readAccessState.mockResolvedValue(enrolled)
    bridge.readOfflineState.mockResolvedValue(offlinePrepared)
    let finish!: (value: unknown) => void
    bridge.reconcileNativeOffline.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    render(<App />)
    const upload = await screen.findByRole('button', { name: 'Upload saved records' })
    await waitFor(() => expect(upload).toBeEnabled())
    fireEvent.click(upload)
    expect(screen.getByRole('button', { name: 'Sign out of this app' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Lock offline access' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Saved receipts' }))
    fireEvent.click(screen.getByRole('button', { name: 'This device' }))
    fireEvent.click(upload)
    expect(bridge.reconcileNativeOffline).toHaveBeenCalledTimes(1)
    await act(async () => finish(reconciliation))
  })
})

describe('Native payment custody across app navigation', () => {
  it('blocks setup/sign-out/finish for a locked payment while retaining saved-record upload', async () => {
    bridge.readAccessState.mockResolvedValue(enrolled)
    bridge.readOfflineState.mockResolvedValue(offlinePrepared)
    bridge.readNativeCheckout.mockResolvedValue({
      schemaVersion: 1,
      canIssue: false,
      reasonCode: 'pin_unlock_required',
      context: null,
      pendingIntentId: '10000000-0000-4000-8000-000000000008',
      lastReceiptId: null,
      lastResolvedIntentId: null,
      lastResolvedIntent: null,
      unresolvedIntent: null,
      lastReceipt: null,
    })
    render(<App />)
    await waitFor(() => expect(bridge.readNativeCheckout).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Upload saved records' })).toBeEnabled()
    )
    expect(screen.getByRole('button', { name: 'Sign out of this app' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Finish offline allocation' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Counter · check payment' }))
    await screen.findByRole('heading', { name: 'Saved payment needs checking' })
    fireEvent.click(screen.getByRole('button', { name: 'This device' }))
    expect(screen.getByRole('button', { name: 'Sign out of this app' })).toBeDisabled()
    expect(bridge.signOutNative).not.toHaveBeenCalled()
    expect(bridge.finishNativeOfflineAuthority).not.toHaveBeenCalled()
  })
})

describe('Missing allocation recovery integration', () => {
  it('recovers while signed out without a PIN or upload and refreshes saved record counts', async () => {
    const authorityId = '10000000-0000-4000-8000-000000000007'
    bridge.readNativeBundleRecovery.mockResolvedValue({
      schemaVersion: 1,
      status: 'available',
      authorityId,
      reasonCode: null,
      canRecover: true,
    })
    bridge.recoverNativeMissingBundle.mockResolvedValue({
      schemaVersion: 1,
      status: 'retained',
      authorityId,
      reasonCode: null,
      canRecover: false,
    })
    render(<App />)
    const check = screen.getByRole('button', { name: 'Check missing allocation' })
    await waitFor(() => expect(check).toBeEnabled())
    fireEvent.click(check)
    const consent = await screen.findByRole('checkbox', {
      name: /I confirm recovering and permanently finishing/,
    })
    await waitFor(() => expect(consent).toBeEnabled())
    fireEvent.click(consent)
    const prior = bridge.readNativeReconciliation.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Recover missing allocation' }))
    await screen.findByText(/Original allocation recovered and permanently finished on this device/)
    await waitFor(() =>
      expect(bridge.readNativeReconciliation.mock.calls.length).toBeGreaterThan(prior)
    )
    expect(bridge.recoverNativeMissingBundle).toHaveBeenCalledExactlyOnceWith(authorityId)
    expect(bridge.signInNative).not.toHaveBeenCalled()
    expect(bridge.unlockNativeOffline).not.toHaveBeenCalled()
    expect(bridge.reconcileNativeOffline).not.toHaveBeenCalled()
    expect(bridge.prepareNativeOffline).not.toHaveBeenCalled()
  })
  it('keeps recovery mutation unavailable when Counter discovers a pending intent', async () => {
    bridge.readNativeBundleRecovery.mockResolvedValue({
      schemaVersion: 1,
      status: 'available',
      authorityId: branchId,
      reasonCode: null,
      canRecover: true,
    })
    bridge.readNativeCheckout.mockResolvedValue({
      schemaVersion: 1,
      canIssue: false,
      reasonCode: 'pin_unlock_required',
      context: null,
      pendingIntentId: branchId,
      lastReceiptId: null,
      lastResolvedIntentId: null,
      lastResolvedIntent: null,
      unresolvedIntent: null,
      lastReceipt: null,
    })
    render(<App />)
    const check = screen.getByRole('button', { name: 'Check missing allocation' })
    await waitFor(() => expect(check).toBeEnabled())
    fireEvent.click(check)
    const consent = await screen.findByRole('checkbox', {
      name: /I confirm recovering and permanently finishing/,
    })
    expect(consent).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Recover missing allocation' })).toBeDisabled()
    expect(bridge.recoverNativeMissingBundle).not.toHaveBeenCalled()
  })
})

describe('integrated next allocation setup', () => {
  const nextReady = {
    schemaVersion: 1,
    status: 'ready',
    previousAuthorityId: branchId,
    shiftId: branchId,
    nextShiftId: null,
    reasonCode: null,
    canContinue: true,
  }
  it('reads and continues exact setup, refreshes preparation and keeps sales paused', async () => {
    bridge.readAccessState.mockResolvedValue(enrolled)
    bridge.readOfflineState.mockResolvedValue({
      ...offlinePrepared,
      status: 'blocked',
      stage: 'recover',
      noticeCode: 'offline_allocation_finished',
    })
    bridge.getNativeNextAllocationState.mockResolvedValue(nextReady)
    bridge.continueNativeAfterAllocation.mockImplementation(async () => {
      bridge.readOfflineState.mockResolvedValue({ ...offline, stage: 'prepare', shiftId: branchId })
      return { ...nextReady, status: 'completed', nextShiftId: branchId, canContinue: false }
    })
    render(<App />)
    const check = await screen.findByRole('button', { name: 'Check next setup' })
    await waitFor(() => expect(check).toBeEnabled())
    fireEvent.click(check)
    await screen.findByText('Ready to continue setup')
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled())
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue setup' }))
    await waitFor(() =>
      expect(bridge.continueNativeAfterAllocation).toHaveBeenCalledExactlyOnceWith(branchId)
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Prepare this counter' })).toBeEnabled()
    )
    expect(screen.getByText('New sales paused')).toBeVisible()
    expect(screen.getByText('Original setup handoff completed')).toBeVisible()
    expect(screen.getByText(/Last confirmed status: the original shift is open/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Check shift status' })).toBeDisabled()
    expect(bridge.prepareNativeOffline).not.toHaveBeenCalled()
    expect(bridge.openNativeOfflineShift).not.toHaveBeenCalled()
  })
  it('retains uncertain handoff and blocks account and preparation mutations', async () => {
    bridge.readAccessState.mockResolvedValue(enrolled)
    bridge.readOfflineState.mockResolvedValue({ ...offline, stage: 'prepare', shiftId: branchId })
    bridge.getNativeNextAllocationState.mockResolvedValue(nextReady)
    bridge.continueNativeAfterAllocation.mockRejectedValue(
      new Error('offline_continuation_uncertain')
    )
    render(<App />)
    const check = await screen.findByRole('button', { name: 'Check next setup' })
    await waitFor(() => expect(check).toBeEnabled())
    fireEvent.click(check)
    await screen.findByText('Ready to continue setup')
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled())
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue setup' }))
    await screen.findByText(/The setup handoff was not confirmed/)
    expect(screen.getByRole('button', { name: 'Sign out of this app' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Prepare this counter' })).toBeDisabled()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(bridge.getNativeNextAllocationState).toHaveBeenCalledTimes(2)
    expect(bridge.continueNativeAfterAllocation).toHaveBeenCalledTimes(1)
  })
})

describe('integrated Android drawer close recovery', () => {
  const closePending = {
    schemaVersion: 1,
    status: 'pending',
    shiftId: branchId,
    commandId: '10000000-0000-4000-8000-000000000011',
    countedCashFils: 12345,
    result: null,
    pinRequired: true,
    canClose: false,
    canRetry: false,
    reasonCode: 'native_shift_close_pending',
  }
  it('discovers pending close before enabling new setup, blocks account changes, and leaves historical upload available', async () => {
    bridge.readAccessState.mockResolvedValue(enrolled)
    bridge.readOfflineState.mockResolvedValue({ ...offline, stage: 'prepare', shiftId: branchId })
    bridge.getNativeShiftCloseState.mockResolvedValue(closePending)
    render(<App />)
    await screen.findByText('Original close request needs confirmation')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Upload saved records' })).toBeEnabled()
    )
    expect(screen.getByRole('button', { name: 'Sign out of this app' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Prepare this counter' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /^Counter/ }))
    expect(screen.getByText(/A drawer close request needs checking/)).toBeVisible()
    expect(bridge.closeNativeShift).not.toHaveBeenCalled()
  })
  it('fails closed after a local close-state read error and recovers via explicit online check', async () => {
    bridge.readAccessState.mockResolvedValue(enrolled)
    bridge.readOfflineState.mockResolvedValue({ ...offline, stage: 'prepare', shiftId: branchId })
    bridge.getNativeShiftCloseState.mockRejectedValue(new Error('native_storage_unavailable'))
    bridge.checkNativeShiftClose.mockResolvedValue({
      ...closePending,
      status: 'not_available',
      shiftId: null,
      commandId: null,
      countedCashFils: null,
      pinRequired: false,
      reasonCode: null,
    })
    render(<App />)
    await screen.findByText(/saved drawer record could not be read/)
    expect(screen.getByRole('button', { name: 'Prepare this counter' })).toBeDisabled()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Check drawer for closing' })).toBeEnabled()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check drawer for closing' }))
    await screen.findByText('No drawer is available to close')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Prepare this counter' })).toBeEnabled()
    )
    expect(bridge.closeNativeShift).not.toHaveBeenCalled()
  })
})

it('keeps verified cash closing totals visible after setup refresh and does not open the next shift', async () => {
  const readyClose = {
    schemaVersion: 1,
    status: 'ready',
    shiftId: branchId,
    commandId: null,
    countedCashFils: null,
    result: null,
    pinRequired: false,
    canClose: true,
    canRetry: false,
    reasonCode: null,
  }
  const commandId = '10000000-0000-4000-8000-000000000012'
  const closed = {
    ...readyClose,
    status: 'closed',
    commandId,
    countedCashFils: 12345,
    canClose: false,
    result: {
      commandId,
      shiftId: branchId,
      countedCashFils: 12345,
      expectedCashFils: 12500,
      cashDifferenceFils: -155,
      closedAt: '2026-10-16T07:00:00.000Z',
    },
  }
  bridge.readAccessState.mockResolvedValue(enrolled)
  bridge.readOfflineState.mockResolvedValue({ ...offline, stage: 'prepare', shiftId: branchId })
  bridge.getNativeShiftCloseState.mockResolvedValue({
    ...readyClose,
    status: 'needs_check',
    canClose: false,
  })
  bridge.checkNativeShiftClose.mockResolvedValue(readyClose)
  bridge.closeNativeShift.mockImplementation(async () => {
    bridge.getNativeShiftCloseState.mockResolvedValue(closed)
    bridge.readOfflineState.mockResolvedValue({ ...offline, stage: 'open_shift' })
    return closed
  })
  render(<App />)
  const check = await screen.findByRole('button', { name: 'Check drawer for closing' })
  await waitFor(() => expect(check).toBeEnabled())
  fireEvent.click(check)
  const count = await screen.findByLabelText('Actual cash counted (AED)')
  fireEvent.change(count, { target: { value: '123.45' } })
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled())
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm cash count and close drawer' }))
  await screen.findByText('Original drawer closed')
  await screen.findByRole('button', { name: 'Open counter shift' })
  expect(screen.getByText('AED 125.00')).toBeVisible()
  expect(screen.getByText('AED -1.55')).toBeVisible()
  expect(bridge.closeNativeShift).toHaveBeenCalledExactlyOnceWith(branchId, 12345)
  expect(bridge.openNativeOfflineShift).not.toHaveBeenCalled()
})

const pinReady = {
  schemaVersion: 1,
  status: 'ready',
  requestId: null,
  canStart: true,
  canRetry: false,
  passwordRequired: true,
  reasonCode: null,
}
const pinPending = {
  ...pinReady,
  status: 'pending',
  requestId: '10000000-0000-4000-8000-000000000099',
  canStart: false,
  canRetry: true,
  reasonCode: 'pin_recovery_pending',
}
it('discovers saved PIN recovery before new setup and preserves historical upload and payment reads', async () => {
  bridge.readAccessState.mockResolvedValue(enrolled)
  bridge.readOfflineState.mockResolvedValue({ ...offline, stage: 'prepare', shiftId: branchId })
  bridge.getNativePinRecoveryState.mockResolvedValue(pinPending)
  render(<App />)
  await screen.findByRole('button', { name: 'Check / retry saved PIN recovery' })
  await waitFor(() => expect(bridge.readNativeCheckout).toHaveBeenCalled())
  expect(screen.getByRole('button', { name: 'Sign out of this app' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Prepare this counter' })).toBeDisabled()
  const upload = screen.getByRole('button', { name: 'Upload saved records' })
  await waitFor(() => expect(upload).toBeEnabled())
  fireEvent.click(upload)
  await waitFor(() => expect(bridge.reconcileNativeOffline).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: /^Counter/ }))
  await screen.findByText(/A saved PIN recovery needs checking/)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Check counter status' })).toBeEnabled()
  )
})
it('allows original-account sign-in for a saved PIN recovery but prevents enrollment', async () => {
  bridge.getNativePinRecoveryState.mockResolvedValue({ ...pinPending, passwordRequired: false })
  bridge.signInNative.mockResolvedValue(signedIn)
  render(<App />)
  const signin = await screen.findByRole('button', { name: 'Sign in securely' })
  await waitFor(() => expect(signin).toBeEnabled())
  fireEvent.click(signin)
  await screen.findByText('Signed in')
  await waitFor(() => expect(bridge.getNativePinRecoveryState).toHaveBeenCalledTimes(2))
  expect(screen.getByRole('button', { name: 'Enroll this counter' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Sign out of this app' })).toBeDisabled()
})
it('fails closed on unreadable PIN metadata and releases only after an explicit successful read', async () => {
  bridge.readAccessState.mockResolvedValue(enrolled)
  bridge.readOfflineState.mockResolvedValue({ ...offline, stage: 'prepare', shiftId: branchId })
  bridge.getNativePinRecoveryState
    .mockRejectedValueOnce(new Error('native_storage_unavailable'))
    .mockResolvedValue({
      ...pinReady,
      status: 'not_available',
      canStart: false,
      passwordRequired: false,
      reasonCode: 'pin_not_provisioned',
    })
  render(<App />)
  await screen.findByText(/saved recovery record cannot be read/)
  expect(screen.getByRole('button', { name: 'Prepare this counter' })).toBeDisabled()
  const check = screen.getByRole('button', { name: 'Check saved PIN recovery' })
  await waitFor(() => expect(check).toBeEnabled())
  fireEvent.click(check)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Prepare this counter' })).toBeEnabled()
  )
})
it('completes PIN recovery, refreshes preparation, preserves the completion and requires new-PIN unlock', async () => {
  bridge.readAccessState.mockResolvedValue(enrolled)
  bridge.readOfflineState.mockResolvedValue({
    ...offlinePrepared,
    status: 'locked',
    stage: 'unlock',
  })
  bridge.getNativePinRecoveryState.mockResolvedValue(pinReady)
  const complete = {
    ...pinReady,
    status: 'completed',
    requestId: pinPending.requestId,
    passwordRequired: false,
    reasonCode: 'pin_recovery_completed',
  }
  bridge.startNativePinRecovery.mockImplementation(async () => {
    bridge.getNativePinRecoveryState.mockResolvedValue(complete)
    return complete
  })
  render(<App />)
  const start = await screen.findByRole('button', { name: 'Continue in Android' })
  const consent = screen.getByRole('checkbox', {
    name: /Recover the PIN for this original staff account/,
  })
  await waitFor(() => expect(consent).toBeEnabled())
  fireEvent.click(consent)
  await waitFor(() => expect(start).toBeEnabled())
  fireEvent.click(start)
  await screen.findByText(/PIN recovery complete\./)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Unlock with Android PIN' })).toBeEnabled()
  )
  expect(screen.getByRole('button', { name: 'Recover PIN again' })).toBeDisabled()
  expect(bridge.unlockNativeOffline).not.toHaveBeenCalled()
  expect(bridge.startNativePinRecovery).toHaveBeenCalledTimes(1)
  expect(screen.getByText('New sales paused')).toBeVisible()
})
