import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import LiveCounter from '@/components/pos/LiveCounter'
import type { LiveBootstrap, LiveOrder } from '@/lib/pos/server/live-contracts'
import type { OpenOrderCommand, OpenOrderTab } from '@/lib/pos/server/open-order-contracts'
import type { PendingOnlineRequest } from '@/lib/pos/online-journal'
const journals = vi.hoisted(() => ({
  financial: null as PendingOnlineRequest | null,
  orders: [] as { actorId: string; command: OpenOrderCommand }[],
}))
vi.mock('@/lib/pos/online-journal', () => ({
  readPendingRequest: async () => journals.financial,
  savePendingRequest: async (request: PendingOnlineRequest) => {
    if (journals.financial) throw new Error('pending')
    journals.financial = structuredClone(request)
  },
  acknowledgePendingRequest: async () => {
    journals.financial = null
  },
}))
vi.mock('@/lib/pos/tab-kitchen-journal', () => ({
  readPendingTabKitchenRequests: async () => [],
  tabKitchenJournalEvent: 'test-tab-kitchen',
}))
vi.mock('@/lib/pos/kitchen-journal', () => ({
  readPendingKitchenRequests: async () => [],
  kitchenJournalEvent: 'test-kitchen',
}))
vi.mock('@/lib/pos/open-order-journal', () => ({
  openOrderJournalEvent: 'test-open-orders',
  readPendingOpenOrderRequests: async (actor: string) =>
    structuredClone(journals.orders.filter((row) => row.actorId === actor)),
  savePendingOpenOrderRequest: async (row: { actorId: string; command: OpenOrderCommand }) => {
    if (
      journals.orders.some(
        (old) => old.actorId === row.actorId && old.command.branchId === row.command.branchId
      )
    )
      throw new Error('pending')
    journals.orders.push(structuredClone(row))
    window.dispatchEvent(new Event('test-open-orders'))
  },
  acknowledgeOpenOrderRequest: async (actor: string, branch: string, id: string) => {
    journals.orders = journals.orders.filter(
      (row) => !(row.actorId === actor && row.command.branchId === branch && row.command.id === id)
    )
    window.dispatchEvent(new Event('test-open-orders'))
  },
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
const boot: LiveBootstrap = {
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

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
let saved: OpenOrderTab | null = null,
  failFirstSave = false,
  sent: LiveOrder | null = null,
  original: OpenOrderCommand | null = null
function snapshot(
  command: Extract<OpenOrderCommand, { type: 'tab.save' | 'tab.reopen' }>
): OpenOrderTab {
  return {
    id: command.tabId,
    branchId,
    revision: command.expectedRevision + 1,
    status: 'open',
    label: command.label,
    serviceType: command.serviceType,
    tableId: command.tableId,
    guestCount: command.guestCount,
    note: command.note,
    lines: command.lines.map((line) => ({
      productId: line.productId,
      name: 'Test tea',
      category: 'Drinks',
      imageUrl: null,
      unit: 'piece',
      quantityMilli: line.quantityMilli,
      unitPriceFils: line.expectedUnitPriceFils,
      taxRateBps: line.expectedTaxRateBps,
      revision: line.expectedRevision,
    })),
    subtotalFils: command.lines.reduce(
      (sum, line) => sum + (line.expectedUnitPriceFils * line.quantityMilli) / 1000,
      0
    ),
    taxFils: command.lines.reduce(
      (sum, line) =>
        sum +
        Math.round((((line.expectedUnitPriceFils * line.quantityMilli) / 1000) * 500) / 10500),
      0
    ),
    createdBy: actorId,
    updatedBy: actorId,
    createdAt: '2026-10-16T00:00:00Z',
    updatedAt: '2026-10-16T00:00:00Z',
    settledOrderId: null,
  }
}
function list() {
  return {
    status: 'ready',
    organizationId: id(7),
    branchId,
    actorRole: 'manager',
    generatedAt: '2026-10-16T00:00:00Z',
    tables: [],
    openTabs: saved ? [saved] : [],
    openCount: saved ? 1 : 0,
    openNextCursor: null,
    recentTabs: [],
    recentTruncated: false,
  }
}
let kitchenMode: 'clear' | 'unsent' | 'stale' | 'unavailable' = 'clear'
function kitchenStatus() {
  return {
    status: 'ready',
    organizationId: id(7),
    branchId,
    actorRole: 'manager',
    tabId: saved!.id,
    tabRevision: saved!.revision + (kitchenMode === 'stale' ? 1 : 0),
    dispatchRequired: kitchenMode === 'unsent',
    ticket:
      kitchenMode !== 'unsent'
        ? null
        : {
            id: id(9),
            tabId: saved!.id,
            branchId,
            revision: 1,
            generation: 1,
            dispatchedTabRevision: saved!.revision,
            state: 'open',
            payment: 'unpaid',
            paidOrderId: null,
            invoiceId: null,
            invoiceNumber: null,
            paidAt: null,
            refundedAt: null,
            metadata: {
              label: saved!.label,
              serviceType: saved!.serviceType,
              tableId: null,
              tableName: null,
              guestCount: null,
              note: '',
            },
            lines: saved!.lines.map(({ productId, name, unit, quantityMilli }) => ({
              productId,
              name,
              unit,
              quantityMilli,
            })),
            stages: {
              queued: saved!.lines.map(({ productId, name, unit, quantityMilli }) => ({
                productId,
                name,
                unit,
                quantityMilli,
              })),
              preparing: [],
              ready: [],
              served: [],
            },
            eventSequence: 1,
            acknowledgedSequence: 0,
            pendingChangeCount: 1,
            issuedAt: saved!.createdAt,
            updatedAt: saved!.updatedAt,
          },
  }
}
beforeEach(() => {
  kitchenMode = 'clear'
  saved = null
  sent = null
  original = null
  failFirstSave = false
  journals.orders = []
  journals.financial = null
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/pos/bootstrap') return response(boot)
      if (url.startsWith('/api/pos/receipts')) return response({ receipts: [], nextCursor: null })
      if (url.startsWith('/api/pos/tab-kitchen?'))
        return kitchenMode === 'unavailable'
          ? response({ code: 'kitchen_unavailable' }, 503)
          : response(kitchenStatus())
      if (url.startsWith('/api/pos/open-orders?')) {
        if (new URL(url, 'http://localhost').searchParams.has('tabId'))
          return response({
            status: 'ready',
            organizationId: id(7),
            branchId,
            actorRole: 'manager',
            tab: saved,
          })
        return response(list())
      }
      if (url === '/api/pos/open-orders' || url === '/api/pos/open-orders/recovery') {
        const command = JSON.parse(options?.body as string) as Extract<
          OpenOrderCommand,
          { type: 'tab.save' }
        >
        expect(journals.orders[0]?.command).toEqual(command)
        const rawCommand = command as OpenOrderCommand
        if (rawCommand.type === 'table.save')
          return response({
            status: 'updated',
            requestId: rawCommand.id,
            replayed: false,
            table: {
              ...rawCommand.table,
              branchId,
              revision: 1,
              createdAt: '2026-10-16T00:00:00Z',
              updatedAt: '2026-10-16T00:00:00Z',
              occupiedTabId: null,
            },
          })

        if (!original) original = structuredClone(command)
        saved = snapshot(command)
        if (failFirstSave) {
          failFirstSave = false
          throw new Error('response lost')
        }
        return response({
          status: 'updated',
          requestId: command.id,
          replayed: url.endsWith('recovery'),
          tab: saved,
        })
      }
      if (url === '/api/pos/sync') {
        sent = JSON.parse(options?.body as string).order
        return response({ code: 'synthetic_unavailable' }, 503)
      }
      if (url === '/api/pos/offers/quote')
        return response({
          status: 'ready',
          branchId,
          evaluatedAt: '2026-10-16T00:00:00Z',
          quotes: [],
        })
      throw new Error('Unexpected ' + url)
    })
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function start() {
  render(<LiveCounter />)
  const product = await screen.findByRole('button', { name: /Test tea/ })
  await waitFor(() => expect(product).toBeEnabled())
  fireEvent.click(product)
}
async function labelOrder() {
  const summary = screen.getByText('Save this order for later')
  fireEvent.click(summary)
  fireEvent.change(screen.getByLabelText('Order label'), { target: { value: 'Lunch order' } })
}
it('preserves unsaved metadata across views, saves revision and attaches it to the durable payment request', async () => {
  await start()
  await labelOrder()
  expect(screen.getByRole('button', { name: 'Save sale · AED 5.00' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Branch' }))
  fireEvent.click(screen.getByRole('button', { name: 'Sell' }))
  expect(screen.getByLabelText('Order label')).toHaveValue('Lunch order')
  const save = screen.getByRole('button', { name: 'Save unpaid order' })
  await waitFor(() => expect(save).toBeEnabled())
  fireEvent.click(save)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save sale · AED 5.00' })).toBeEnabled()
  )
  expect(saved?.label).toBe('Lunch order')
  expect(journals.orders).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Save sale · AED 5.00' }))
  await waitFor(() => expect(sent).not.toBeNull())
  expect(sent!.sourceTab).toEqual({ id: saved!.id, expectedRevision: 1 })
  expect(sent!.id).not.toBe(saved!.id)
  expect(journals.financial?.body).toEqual({ order: sent })
})
it('recovers a lost unpaid-save response without leaving an unlinked payable basket', async () => {
  failFirstSave = true
  await start()
  await labelOrder()
  const save = screen.getByRole('button', { name: 'Save unpaid order' })
  await waitFor(() => expect(save).toBeEnabled())
  fireEvent.click(save)
  await waitFor(() => expect(journals.orders).toHaveLength(1))
  await screen.findByText(/not confirmed/i)
  expect(screen.getByRole('button', { name: 'Save sale · AED 5.00' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: /Retry saved open-order change/i }))
  await waitFor(() => expect(journals.orders).toHaveLength(0))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save sale · AED 5.00' })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save sale · AED 5.00' }))
  await waitFor(() => expect(sent).not.toBeNull())
  expect(sent!.sourceTab?.id).toBe(saved!.id)
  expect(original?.id).not.toBe(sent!.id)
})
it('requires saving an edited loaded order and keeps the shared order when clearing the counter', async () => {
  await start()
  await labelOrder()
  const save = screen.getByRole('button', { name: 'Save unpaid order' })
  await waitFor(() => expect(save).toBeEnabled())
  fireEvent.click(save)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save sale · AED 5.00' })).toBeEnabled()
  )
  fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '2' } })
  expect(screen.getByRole('button', { name: 'Save sale · AED 10.00' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'New order / clear counter' }))
  expect(screen.getByRole('heading', { name: 'Replace the current basket?' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Replace basket' }))
  expect(saved?.status).toBe('open')
  expect(sent).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Orders & tables' }))
  const open = await screen.findByRole('button', { name: /Open at counter/i })
  await waitFor(() => expect(open).toBeEnabled())
  fireEvent.click(open)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save sale · AED 5.00' })).toBeEnabled()
  )
})

it('keeps an unsaved checkout basket when a manager creates an unrelated table', async () => {
  await start()
  fireEvent.click(screen.getByRole('button', { name: 'Orders & tables' }))
  fireEvent.click(await screen.findByRole('button', { name: /^Tables / }))
  const add = await screen.findByRole('button', { name: 'Add table' })
  await waitFor(() => expect(add).toBeEnabled())
  fireEvent.click(add)
  fireEvent.change(screen.getByLabelText('Table name'), { target: { value: 'New table' } })
  fireEvent.change(screen.getByLabelText('Reason for table change'), {
    target: { value: 'Opening setup' },
  })
  const save = screen.getByRole('button', { name: 'Save table' })
  await waitFor(() => expect(save).toBeEnabled())
  fireEvent.click(save)
  await waitFor(() => expect(screen.queryByLabelText('Table name')).not.toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: 'Sell' }))
  expect(screen.getByLabelText('Quantity')).toHaveValue(1)
  expect(screen.getByRole('button', { name: 'Save sale · AED 5.00' })).toBeEnabled()
  expect(saved).toBeNull()
  expect(sent).toBeNull()
})

for (const mode of ['unsent', 'stale', 'unavailable'] as const) {
  it(`checks current kitchen ${mode} status again before persisting a payment`, async () => {
    await start()
    await labelOrder()
    const save = screen.getByRole('button', { name: 'Save unpaid order' })
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.click(save)
    const pay = screen.getByRole('button', { name: 'Save sale · AED 5.00' })
    await waitFor(() => expect(pay).toBeEnabled())
    // Another counter changes the kitchen after the displayed status was read.
    kitchenMode = mode
    fireEvent.click(pay)
    await screen.findByText(
      mode === 'unsent'
        ? 'Send the saved changes to the kitchen before taking payment.'
        : mode === 'stale'
          ? 'This saved order changed. Reopen it and review the items before payment.'
          : 'The counter service is not ready. Please retry shortly.'
    )
    expect(sent).toBeNull()
    expect(journals.financial).toBeNull()
  })
}
it('disables payment for saved kitchen changes that have not been dispatched', async () => {
  kitchenMode = 'unsent'
  await start()
  await labelOrder()
  const save = screen.getByRole('button', { name: 'Save unpaid order' })
  await waitFor(() => expect(save).toBeEnabled())
  fireEvent.click(save)
  await screen.findByText(
    'Saved changes have not reached the kitchen. Send them before taking payment.'
  )
  expect(screen.getByRole('button', { name: 'Save sale · AED 5.00' })).toBeDisabled()
  expect(sent).toBeNull()
})
