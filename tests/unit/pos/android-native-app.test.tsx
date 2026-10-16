import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../apps/android-pos/node_modules/react', async () => await import('react'))
const bridge = vi.hoisted(() => ({ hasNativeLedger: vi.fn(), readDeviceSnapshot: vi.fn() }))
vi.mock('../../../apps/android-pos/src/native', () => bridge)
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
beforeEach(() => {
  bridge.hasNativeLedger.mockReturnValue(true)
  bridge.readDeviceSnapshot.mockResolvedValue(snapshot)
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
