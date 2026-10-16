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
vi.mock('@/components/pos/inventory/StockManager', () => ({
  default: ({actorId, branchId, deviceId, disabled, onBusyChange}: {actorId:string;branchId:string;deviceId:string;disabled:boolean;onBusyChange:(busy:boolean)=>void}) => (
    <section aria-label="Stock integration"><p>{actorId}:{branchId}:{deviceId}</p><button disabled={disabled} onClick={()=>onBusyChange(true)}>Record synthetic stock</button></section>
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
  localStorage.clear()
  boot = structuredClone(initialBoot)
  Element.prototype.scrollIntoView = vi.fn()
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/pos/bootstrap') return new Response(JSON.stringify(boot))
    if (url === '/api/pos/session') return new Response(JSON.stringify({userId: actorId}))
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

it('shows Stock only for a branch manager and binds the current actor and counter', async()=>{
  render(<LiveCounter />)
  fireEvent.click(await screen.findByRole('button',{name:'Stock'}))
  await screen.findByRole('region',{name:'Stock integration'})
  expect(screen.getByText(`${actorId}:${branchId}:${deviceId}`)).toBeVisible()
  await waitFor(()=>expect(screen.getByRole('button',{name:'Record synthetic stock'})).toBeEnabled())
  fireEvent.click(screen.getByRole('button',{name:'Record synthetic stock'}))
  expect(screen.getByRole('button',{name:'Sell'})).toBeDisabled()
  expect(screen.getByRole('button',{name:'Sign out'})).toBeDisabled()
})
it('does not expose stock administration to a cashier', async()=>{
  boot.branches[0].role='cashier'
  render(<LiveCounter />)
  await screen.findByRole('button',{name:'Sell'})
  expect(screen.queryByRole('button',{name:'Stock'})).not.toBeInTheDocument()
})
it('keeps historical stock recovery reachable when the enrolled device is unavailable', async()=>{
  boot.device=null;boot.shifts=[]
  const command={id:id(8),type:'stock.count',branchId,deviceId,itemId:id(9),expectedRevision:1,quantityMilli:0,reason:'Physical count',reference:null}
  localStorage.setItem(`pos-stock-request:${actorId}:${branchId}:${deviceId}`,JSON.stringify(command))
  render(<LiveCounter />)
  await screen.findByRole('heading',{name:'Set up this counter'})
  expect(await screen.findByRole('button',{name:'Check saved stock work'})).toBeVisible()
})
it('keeps historical stock recovery reachable when current bootstrap authorization fails', async()=>{
  const command={id:id(8),type:'stock.count',branchId,deviceId,itemId:id(9),expectedRevision:1,quantityMilli:0,reason:'Physical count',reference:null}
  localStorage.setItem(`pos-stock-request:${actorId}:${branchId}:${deviceId}`,JSON.stringify(command))
  fetchMock.mockImplementation(async(url:string)=>url==='/api/pos/session'?new Response(JSON.stringify({userId:actorId})):new Response(JSON.stringify({code:'branch_access_required'}),{status:403}))
  render(<LiveCounter />)
  expect(await screen.findByRole('button',{name:'Check saved stock work'})).toBeVisible()
})

// These feature tests isolate empty station journals; station custody has its own race tests.
vi.mock('@/lib/pos/kitchen-station-journal', () => ({
  stationJournalEvent: 'station-config-test',
  readPendingStationRequests: async () => [],
}))
vi.mock('@/lib/pos/kitchen-station-work-journal', () => ({
  stationWorkJournalEvent: 'station-work-test',
  readPendingStationWorkRequests: async () => [],
}))
