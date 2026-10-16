import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../apps/android-pos/node_modules/react', async () => await import('react'))
const bridge = vi.hoisted(() => ({
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
beforeEach(() => {
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
