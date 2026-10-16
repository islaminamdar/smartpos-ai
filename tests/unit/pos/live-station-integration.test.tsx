import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import LiveCounter from '@/components/pos/LiveCounter'
import { liveBootstrapSchema } from '@/lib/pos/server/live-contracts'
import { boot as fixtureBoot } from './fixtures/partial-return-ui'
const m = vi.hoisted(() => ({
  config: [] as unknown[],
  work: [] as unknown[],
  configRead: vi.fn(),
  workRead: vi.fn(),
}))
vi.mock('@/lib/pos/kitchen-station-journal', () => ({
  stationJournalEvent: 'station-config-test',
  readPendingStationRequests: m.configRead,
}))
vi.mock('@/lib/pos/kitchen-station-work-journal', () => ({
  stationWorkJournalEvent: 'station-work-test',
  readPendingStationWorkRequests: m.workRead,
}))
vi.mock('@/components/pos/offline-payments/journal', () => ({
  paymentReviewJournalEvent: 'review',
  readPendingPaymentReviews: async () => [],
}))
vi.mock('@/lib/pos/online-journal', () => ({ readPendingRequest: async () => null }))
vi.mock('@/lib/pos/tab-kitchen-journal', () => ({
  tabKitchenJournalEvent: 'tab',
  readPendingTabKitchenRequests: async () => [],
}))
vi.mock('@/lib/pos/kitchen-journal', () => ({
  kitchenJournalEvent: 'kitchen',
  readPendingKitchenRequests: async () => [],
}))
vi.mock('@/lib/pos/open-order-journal', () => ({
  openOrderJournalEvent: 'order',
  readPendingOpenOrderRequests: async () => [],
}))
vi.mock('@/components/pos/kitchen-stations/KitchenStationManager', () => ({
  default: ({ onBlockedChange }: { onBlockedChange: (blocked: boolean) => void }) => (
    <section aria-label="Station manager integration">
      <button onClick={() => onBlockedChange(true)}>Edit station</button>
      <button onClick={() => onBlockedChange(false)}>Discard station edit</button>
    </section>
  ),
  KitchenStationPendingRecovery: () => <p>Saved station configuration recovery</p>,
}))
vi.mock('@/components/pos/kitchen-stations/StationWorkBoard', () => ({
  default: () => <p>Station work board</p>,
  StationWorkPendingRecovery: () => <p>Saved station preparation recovery</p>,
}))
let boot = liveBootstrapSchema.parse(fixtureBoot)
beforeEach(() => {
  vi.resetAllMocks()
  m.config = []
  m.work = []
  m.configRead.mockImplementation(async () => m.config)
  m.workRead.mockImplementation(async () => m.work)
  boot = liveBootstrapSchema.parse(fixtureBoot)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/pos/bootstrap') return new Response(JSON.stringify(boot))
      if (url.startsWith('/api/pos/receipts'))
        return new Response(JSON.stringify({ receipts: [], nextCursor: null }))
      throw Error('Unexpected ' + url)
    })
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('keeps unfinished station entry hidden when feature is off', async () => {
  render(<LiveCounter />)
  await screen.findByRole('button', { name: 'Sign out' })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).not.toBeDisabled())
  expect(screen.queryByRole('button', { name: 'Kitchen stations' })).toBeNull()
})
it('dirty station edit holds navigation and account changes until discarded', async () => {
  render(<LiveCounter kitchenStationsEnabled />)
  fireEvent.click(await screen.findByRole('button', { name: 'Kitchen stations' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Edit station' }))
  expect(screen.getByRole('button', { name: 'Sell' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Discard station edit' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).not.toBeDisabled())
})
it('recovers pending work after flag rollback or manager demotion', async () => {
  m.config = [{}]
  m.work = [{}]
  boot.branches[0].role = 'cashier'
  render(<LiveCounter />)
  await screen.findByText('Saved station configuration recovery')
  expect(screen.getByText('Saved station preparation recovery')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Kitchen stations' })).toBeNull()
  m.config = []
  m.work = []
  await act(async () => window.dispatchEvent(new Event('station-work-test')))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).not.toBeDisabled())
})
it('pending request on another branch prevents replacement enrollment but remains recoverable', async () => {
  boot.device = null
  boot.shifts = []
  m.work = [{ command: { branchId: 'another-branch' } }]
  render(<LiveCounter kitchenStationsEnabled />)
  await screen.findByText('Saved station preparation recovery')
  expect(screen.getByRole('button', { name: 'Register this counter' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled()
})
it('unreadable station storage fails closed on account change', async () => {
  m.configRead.mockRejectedValue(Error('corrupt'))
  render(<LiveCounter />)
  await screen.findByRole('button', { name: 'Sign out' })
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Check saved station changes' })).toBeVisible()
})

vi.mock('@/components/pos/kitchen-stations/PendingKitchenStationRecovery', () => ({
  default: () => (
    <>
      {m.config.length > 0 && <p>Saved station configuration recovery</p>}
      {m.work.length > 0 && <p>Saved station preparation recovery</p>}
    </>
  ),
}))

it('mounts station recovery when bootstrap is unavailable', async () => {
  m.config = [{}]
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify({ code: 'live_sales_not_enabled' }), { status: 503 })
    )
  )
  render(<LiveCounter />)
  await screen.findByRole('heading', { name: 'Counter setup' })
  expect(await screen.findByText('Saved station configuration recovery')).toBeVisible()
})
