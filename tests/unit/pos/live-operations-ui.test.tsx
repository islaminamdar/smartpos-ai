import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import LiveCounter from '@/components/pos/LiveCounter'
import type { LiveBootstrap } from '@/lib/pos/server/live-contracts'
vi.mock('@/components/pos/offline-payments/journal', () => ({
  paymentReviewJournalEvent: 'review',
  readPendingPaymentReviews: async () => [],
}))
vi.mock('@/lib/pos/online-journal', () => ({
  readPendingRequest: async () => null,
  savePendingRequest: vi.fn(),
  acknowledgePendingRequest: vi.fn(),
}))
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
  savePendingOpenOrderRequest: vi.fn(),
  acknowledgeOpenOrderRequest: vi.fn(),
}))
vi.mock('@/components/pos/operations/BranchOperations', () => ({
  default: ({ branchId, branches, disabled, onNavigate }: any) => (
    <section aria-label="Operations integration">
      <p>Bound branch: {branchId}</p>
      <p>
        {branches
          .filter((b: any) => b.role !== 'cashier')
          .map((b: any) => b.name)
          .join(', ')}
      </p>
      <button disabled={disabled} onClick={() => onNavigate('reports')}>
        Reports shortcut
      </button>
    </section>
  ),
}))
const id = (digit: number) => `${digit}0000000-0000-4000-8000-000000000001`
const branchId = id(1),
  deviceId = id(2),
  productId = id(3),
  actorId = id(4),
  profileId = id(5),
  shiftId = id(6)
const merchant = {
  id: profileId,
  organizationId: id(7),
  branchId,
  legalName: 'Synthetic offers merchant',
  branchName: 'Test branch',
  address: 'Test address',
  phone: 'Test phone',
  trn: '100000000000001',
  taxRegistered: true as const,
  currency: 'AED' as const,
  timezone: 'Asia/Dubai' as const,
  taxInclusive: true as const,
  calculationVersion: 'line-v2' as const,
  confirmedBy: actorId,
  confirmedAt: '2026-10-16T00:00:00Z',
}
const initialBoot: LiveBootstrap = {
  status: 'ready',
  userId: actorId,
  branches: [
    {
      id: branchId,
      organizationId: id(7),
      name: 'Test branch',
      role: 'manager',
      canSell: true,
      canRefund: true,
      canManageCash: true,
      profile: merchant,
    },
  ],
  catalogue: [
    {
      id: productId,
      branchId,
      name: 'Test tea',
      category: 'Drinks',
      imageUrl: null,
      unit: 'piece',
      unitPriceFils: 500,
      taxRateBps: 500,
      revision: 1,
    },
  ],
  device: { id: deviceId, branchId, name: 'Synthetic counter' },
  shifts: [
    {
      id: shiftId,
      branchId,
      deviceId,
      openedBy: actorId,
      openedAt: '2026-10-16T00:00:00Z',
      openingCashFils: 10000,
      expectedCashFils: 10000,
    },
  ],
  capabilities: { onlineSales: true, offlineSales: false },
}

let boot: LiveBootstrap
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  boot = structuredClone(initialBoot)
  Element.prototype.scrollIntoView = vi.fn()
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/pos/bootstrap') return new Response(JSON.stringify(boot))
    if (url.startsWith('/api/pos/receipts'))
      return new Response(JSON.stringify({ receipts: [], nextCursor: null }))
    throw new Error(`Unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('allows manager operations without registering a counter and returns to explicit enrollment', async () => {
  boot.device = null
  boot.shifts = []
  render(<LiveCounter />)
  await screen.findByRole('heading', { name: 'Set up this counter' })
  fireEvent.click(screen.getByRole('button', { name: 'Operations' }))
  await screen.findByRole('region', { name: 'Operations integration' })
  expect(
    screen.getByText(/You can review branch activity without registering this browser/)
  ).toBeVisible()
  expect(screen.getByRole('button', { name: 'Reports shortcut' })).toBeDisabled()
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/pos/devices')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Set up counter' }))
  expect(screen.getByRole('button', { name: 'Register this counter' })).toBeVisible()
})
it('allows a manager of another branch to inspect operations without switching the selling branch', async () => {
  const other = {
    ...boot.branches[0],
    id: id(8),
    name: 'Other managed branch',
    role: 'manager' as const,
  }
  boot.branches[0].role = 'cashier'
  boot.branches.push(other)
  render(<LiveCounter />)
  await screen.findByRole('button', { name: 'Operations' })
  fireEvent.click(screen.getByRole('button', { name: 'Operations' }))
  expect(await screen.findByText('Other managed branch')).toBeVisible()
  expect(screen.getByText(`Bound branch: ${branchId}`)).toBeVisible()
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/pos/devices')).toBe(false)
})
it('routes same-branch report shortcut into the existing reports screen', async () => {
  render(<LiveCounter />)
  await screen.findByRole('button', { name: 'Operations' })
  fireEvent.click(screen.getByRole('button', { name: 'Operations' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Reports shortcut' })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Reports shortcut' }))
  expect(await screen.findByRole('region', { name: 'Branch reports' })).toBeVisible()
})
it('does not offer operations to cashier-only accounts', async () => {
  boot.branches[0].role = 'cashier'
  render(<LiveCounter />)
  await screen.findByRole('button', { name: 'Sell' })
  expect(screen.queryByRole('button', { name: 'Operations' })).toBeNull()
})

it('allows Android update handoff only on an idle closed-shift Sell screen', async () => {
  boot.shifts = []
  const { container } = render(<LiveCounter />)
  const ready = () =>
    container
      .querySelector('[data-counter-update-ready]')
      ?.getAttribute('data-counter-update-ready')
  expect(ready()).toBe('false')
  await waitFor(() => expect(ready()).toBe('true'))
  fireEvent.click(screen.getByRole('button', { name: 'Operations' }))
  expect(ready()).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: 'Sell' }))
  await waitFor(() => expect(ready()).toBe('true'))
  fireEvent.click(screen.getByRole('button', { name: /Test tea/ }))
  expect(ready()).toBe('false')
})

it('blocks Android update handoff during an open counter shift', async () => {
  const { container } = render(<LiveCounter />)
  await screen.findByRole('button', { name: 'Sell' })
  expect(container.querySelector('[data-counter-update-ready]')).toHaveAttribute(
    'data-counter-update-ready',
    'false'
  )
})

it('allows a fresh login screen update but blocks the login request in flight', async () => {
  let finishLogin: ((value: Response) => void) | undefined
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/pos/bootstrap') return Promise.resolve(new Response('{}', { status: 401 }))
    if (url === '/api/pos/session')
      return new Promise<Response>((resolve) => {
        finishLogin = resolve
      })
    throw new Error(`Unexpected request ${url}`)
  })
  const { container } = render(<LiveCounter />)
  await screen.findByRole('heading', { name: 'Your counter starts here.' })
  expect(container.querySelector('[data-counter-update-ready]')).toHaveAttribute(
    'data-counter-update-ready',
    'true'
  )
  fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!)
  expect(container.querySelector('[data-counter-update-ready]')).toHaveAttribute(
    'data-counter-update-ready',
    'false'
  )
  finishLogin!(new Response('{}', { status: 401 }))
  await screen.findByText(/Sign in again/)
})

it.each([200, 401])(
  'distinguishes completed signout from an expired loaded session for updates (%s)',
  async (status) => {
    boot.shifts = []
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/pos/bootstrap') return new Response(JSON.stringify(boot))
      if (url === '/api/pos/session') return new Response('{}', { status })
      throw new Error(`Unexpected request ${url}`)
    })
    const { container } = render(<LiveCounter />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByRole('heading', { name: 'Your counter starts here.' })
    expect(container.querySelector('[data-counter-update-ready]')).toHaveAttribute(
      'data-counter-update-ready',
      status === 200 ? 'true' : 'false'
    )
  }
)

// These feature tests isolate empty station journals; station custody has its own race tests.
vi.mock('@/lib/pos/kitchen-station-journal', () => ({
  stationJournalEvent: 'station-config-test',
  readPendingStationRequests: async () => [],
}))
vi.mock('@/lib/pos/kitchen-station-work-journal', () => ({
  stationWorkJournalEvent: 'station-work-test',
  readPendingStationWorkRequests: async () => [],
}))
