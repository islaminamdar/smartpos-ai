import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TabKitchenBoard, {
  TabKitchenPendingRecovery,
} from '@/components/pos/tab-kitchen/TabKitchenBoard'
import TabKitchenDispatch from '@/components/pos/tab-kitchen/TabKitchenDispatch'
import type {
  TabKitchenCommand,
  TabKitchenTicket,
  TabKitchenEvent,
} from '@/lib/pos/server/tab-kitchen'
import type { OpenOrderTab } from '@/lib/pos/server/open-order-contracts'
const storage = vi.hoisted(() => ({
  records: [] as Array<{ actorId: string; command: TabKitchenCommand }>,
  fail: false,
}))
vi.mock('@/lib/pos/tab-kitchen-journal', () => ({
  tabKitchenJournalEvent: 'pos-tab-kitchen-journal-changed',
  readPendingTabKitchenRequests: vi.fn(async (actorId: string) =>
    storage.records.filter((record) => record.actorId === actorId)
  ),
  savePendingTabKitchenRequest: vi.fn(
    async (record: { actorId: string; command: TabKitchenCommand }) => {
      if (
        storage.fail ||
        storage.records.some(
          (item) =>
            item.actorId === record.actorId && item.command.branchId === record.command.branchId
        )
      )
        throw new Error('storage')
      storage.records.push(structuredClone(record))
    }
  ),
  acknowledgeTabKitchenRequest: vi.fn(async (actorId: string, branchId: string, id: string) => {
    const record = storage.records.find(
      (item) => item.actorId === actorId && item.command.branchId === branchId
    )
    if (record && record.command.id !== id) throw new Error('mismatch')
    storage.records = storage.records.filter((item) => item !== record)
  }),
}))
const branch = '10000000-0000-4000-8000-000000000001',
  device = '20000000-0000-4000-8000-000000000001',
  actor = '30000000-0000-4000-8000-000000000001',
  org = '70000000-0000-4000-8000-000000000001'
const line = {
  productId: '60000000-0000-4000-8000-000000000001',
  name: 'Masala tea',
  unit: 'piece' as const,
  quantityMilli: 10000,
}
const metadata = {
  label: 'Lunch group',
  serviceType: 'takeaway' as const,
  tableId: null,
  tableName: null,
  guestCount: 4,
  note: 'Less sugar',
}
const ticket: TabKitchenTicket = {
  id: '40000000-0000-4000-8000-000000000002',
  tabId: '40000000-0000-4000-8000-000000000001',
  branchId: branch,
  revision: 4,
  generation: 1,
  dispatchedTabRevision: 2,
  state: 'open',
  payment: 'unpaid',
  paidOrderId: null,
  invoiceId: null,
  invoiceNumber: null,
  paidAt: null,
  refundedAt: null,
  metadata,
  lines: [line],
  stages: {
    queued: [{ ...line, quantityMilli: 2000 }],
    preparing: [],
    ready: [],
    served: [{ ...line, quantityMilli: 8000 }],
  },
  eventSequence: 2,
  acknowledgedSequence: 2,
  pendingChangeCount: 0,
  issuedAt: '2026-10-16T04:00:00Z',
  updatedAt: '2026-10-16T04:05:00Z',
}
const scope = {
  status: 'ready',
  organizationId: org,
  branchId: branch,
  actorRole: 'manager',
  generatedAt: '2026-10-16T04:05:00Z',
}
const list = (t = ticket) => ({
  ...scope,
  activeTickets: [t],
  terminalTickets: [],
  activeCount: 1,
  pendingCount: t.pendingChangeCount ? 1 : 0,
  activeNextCursor: null,
  terminalTruncated: false,
})
const event: TabKitchenEvent = {
  sequence: 2,
  generation: 1,
  kind: 'dispatch',
  tabRevision: 2,
  reason: null,
  createdAt: ticket.updatedAt,
  before: { metadata, lines: [{ ...line, quantityMilli: 8000 }] },
  after: { metadata, lines: [line] },
  additions: [{ ...line, quantityMilli: 2000 }],
  withdrawals: [],
}
const detail = (t = ticket, events = [event]) => ({
  status: 'ready',
  organizationId: org,
  branchId: branch,
  actorRole: 'manager',
  ticket: t,
  events,
  eventsNextAfter: null,
})
const props = {
  actorId: actor,
  branchId: branch,
  branchName: 'Test branch',
  deviceId: device,
  disabled: false,
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const stageCommand: TabKitchenCommand = {
  id: '80000000-0000-4000-8000-000000000001',
  branchId: branch,
  deviceId: device,
  type: 'stage',
  ticketId: ticket.id,
  expectedRevision: 4,
  from: 'queued',
  to: 'preparing',
  reason: null,
}
const tab: OpenOrderTab = {
  id: ticket.tabId,
  branchId: branch,
  revision: 2,
  status: 'open',
  label: metadata.label,
  serviceType: metadata.serviceType,
  tableId: null,
  guestCount: 4,
  note: metadata.note,
  lines: [
    {
      ...line,
      category: 'Drinks',
      imageUrl: null,
      unitPriceFils: 500,
      taxRateBps: 500,
      revision: 1,
    },
  ],
  subtotalFils: 5000,
  taxFils: 238,
  createdBy: actor,
  updatedBy: actor,
  createdAt: ticket.issuedAt,
  updatedAt: ticket.updatedAt,
  settledOrderId: null,
}
const openList = {
  ...scope,
  tables: [],
  openTabs: [tab],
  openCount: 1,
  openNextCursor: null,
  recentTabs: [],
  recentTruncated: false,
}
const byTab = (t: TabKitchenTicket | null = ticket, required = false) => ({
  status: 'ready',
  organizationId: org,
  branchId: branch,
  actorRole: 'manager',
  tabId: tab.id,
  tabRevision: tab.revision,
  ticket: t,
  dispatchRequired: required,
})
function stageAck(command: TabKitchenCommand) {
  if (command.type !== 'stage') throw new Error('command')
  const next = structuredClone(ticket)
  next.revision = command.expectedRevision + 1
  next.stages[command.to] = next.stages[command.from]
  next.stages[command.from] = []
  return { status: 'updated', requestId: command.id, replayed: false, ticket: next }
}
beforeEach(() => {
  storage.records = []
  storage.fail = false
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('shows served8 plus queued2 and moves only queued quantities after durable storage', async () => {
  const sent: TabKitchenCommand[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      if (options?.method === 'POST') {
        const command = JSON.parse(options.body)
        expect(storage.records[0].command).toEqual(command)
        sent.push(command)
        return response(stageAck(command))
      }
      return response(list())
    })
  )
  render(<TabKitchenBoard {...props} />)
  expect(await screen.findByText('8 piece')).toBeInTheDocument()
  expect(screen.getByText('2 piece')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Start queued items' }))
  await waitFor(() => expect(storage.records).toHaveLength(0))
  expect(sent[0]).toMatchObject({
    type: 'stage',
    from: 'queued',
    to: 'preparing',
    expectedRevision: 4,
  })
})
it('pending changes block all stages until exact visible-prefix acknowledgement', async () => {
  const pending = { ...ticket, acknowledgedSequence: 1, pendingChangeCount: 1 },
    sent: TabKitchenCommand[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      if (options?.method === 'POST') {
        const c = JSON.parse(options.body)
        sent.push(c)
        return response({
          status: 'updated',
          requestId: c.id,
          replayed: false,
          ticket: { ...ticket, revision: 5 },
        })
      }
      return response(String(url).includes('ticketId') ? detail(pending) : list(pending))
    })
  )
  render(<TabKitchenBoard {...props} />)
  expect(await screen.findByRole('button', { name: 'Start queued items' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Review notices' }))
  expect(await screen.findByText('Masala tea: 8 piece → 10 piece')).toBeInTheDocument()
  const ack = screen.getByRole('button', { name: 'Acknowledge 1 shown notices' })
  expect(ack).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(ack)
  await waitFor(() => expect(sent).toHaveLength(1))
  expect(sent[0]).toMatchObject({ type: 'acknowledge', throughSequence: 2, expectedRevision: 4 })
})
it('acknowledges only first20 displayed notices and keeps later changes blocked', async () => {
  const pending = { ...ticket, eventSequence: 22, acknowledgedSequence: 0, pendingChangeCount: 22 }
  const events = Array.from({ length: 20 }, (_, i) => ({ ...event, sequence: i + 1 }))
  const sent: TabKitchenCommand[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      if (options?.method === 'POST') {
        const c = JSON.parse(options.body)
        sent.push(c)
        return response({
          status: 'updated',
          requestId: c.id,
          replayed: false,
          ticket: { ...pending, revision: 5, acknowledgedSequence: 20, pendingChangeCount: 2 },
        })
      }
      return response(
        String(url).includes('ticketId')
          ? { ...detail(pending, events), eventsNextAfter: 20 }
          : list(pending)
      )
    })
  )
  render(<TabKitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Review notices' }))
  await screen.findByRole('article', { name: 'Kitchen notice 20' })
  expect(screen.queryByRole('article', { name: 'Kitchen notice 21' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge 20 shown notices' }))
  await waitFor(() => expect(sent).toHaveLength(1))
  expect(sent[0]).toMatchObject({ throughSequence: 20 })
})
it('never acknowledges a missing prefix or a newer ticket from the detail response', async () => {
  const pending = { ...ticket, eventSequence: 3, acknowledgedSequence: 0, pendingChangeCount: 3 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      response(
        String(url).includes('ticketId')
          ? detail({ ...pending, revision: 5 }, [event])
          : list(pending)
      )
    )
  )
  render(<TabKitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Review notices' }))
  expect(await screen.findByRole('button', { name: 'Acknowledge 1 shown notices' })).toBeDisabled()
  expect(screen.getByRole('checkbox')).toBeDisabled()
})
it('voided preparation stays active with withdrawn served work and explicit stop notice', async () => {
  const stopped: TabKitchenTicket = {
    ...ticket,
    state: 'cancelled',
    lines: [],
    stages: { queued: [], preparing: [], ready: [], served: [] },
    acknowledgedSequence: 1,
    pendingChangeCount: 1,
  }
  const stop: TabKitchenEvent = {
    ...event,
    kind: 'void',
    reason: 'Customer cancelled',
    before: { metadata, lines: [line] },
    after: { metadata, lines: [] },
    additions: [],
    withdrawals: [{ ...line, quantityMilli: 8000, stage: 'served' }],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      response(String(url).includes('ticketId') ? detail(stopped, [stop]) : list(stopped))
    )
  )
  render(<TabKitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Review notices' }))
  expect(await screen.findByText('Stop: order voided')).toBeInTheDocument()
  expect(screen.getByText('8 piece Masala tea from served')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Start queued items' })).not.toBeInTheDocument()
})
it('paid linked ticket keeps one identity and shows invoice separately from preparation', async () => {
  const paid = {
    ...ticket,
    payment: 'paid',
    paidOrderId: '90000000-0000-4000-8000-000000000001',
    invoiceId: '90000000-0000-4000-8000-000000000002',
    invoiceNumber: 'BD-42',
    paidAt: ticket.updatedAt,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(list(paid as TabKitchenTicket)))
  )
  render(<TabKitchenBoard {...props} />)
  expect(await screen.findByText('Paid')).toBeInTheDocument()
  expect(screen.getByText('Invoice BD-42')).toBeInTheDocument()
  expect(screen.getAllByRole('article')).toHaveLength(1)
  expect(screen.getByText('8 piece')).toBeInTheDocument()
})
it('uncertain stage retries same body and replacement device preserves original command', async () => {
  storage.records = [{ actorId: actor, command: stageCommand }]
  const sent: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      if (options?.method === 'POST') {
        sent.push(JSON.parse(options.body))
        return response(stageAck(stageCommand))
      }
      return response(list())
    })
  )
  render(<TabKitchenBoard {...props} deviceId="90000000-0000-4000-8000-000000000099" />)
  fireEvent.click(
    await screen.findByRole('button', { name: 'Retry saved kitchen dispatch change' })
  )
  await waitFor(() => expect(storage.records).toHaveLength(0))
  expect(sent).toEqual([stageCommand])
})
it('storage failure sends no mutation and keeps preparation locked', async () => {
  storage.fail = true
  const fetcher = vi.fn(async () => response(list()))
  vi.stubGlobal('fetch', fetcher)
  render(<TabKitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Start queued items' }))
  await screen.findByText(/could not be stored safely/)
  expect(
    fetcher.mock.calls.every(
      (call) =>
        (call as unknown[])[1] === undefined ||
        ((call as unknown[])[1] as RequestInit)?.method !== 'POST'
    )
  ).toBe(true)
})
it('mismatched ACK retains exact original request', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) =>
      options?.method === 'POST'
        ? response({ ...stageAck(JSON.parse(options.body)), requestId: ticket.id })
        : response(list())
    )
  )
  render(<TabKitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Start queued items' }))
  await screen.findByRole('button', { name: 'Retry saved kitchen dispatch change' })
  expect(storage.records).toHaveLength(1)
})
it('requires served confirmation and manager reason for backwards preparation', async () => {
  const ready = { ...ticket, stages: { ...ticket.stages, queued: [], ready: ticket.stages.queued } }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(list(ready)))
  )
  render(<TabKitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Mark ready items served' }))
  expect(screen.getByText(/Confirm all ready quantities shown/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Keep current preparation' }))
  fireEvent.click(screen.getByRole('button', { name: 'Correct ready items' }))
  expect(screen.getByRole('button', { name: 'Confirm preparation change' })).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox', { name: 'Reason for preparation correction' }), {
    target: { value: 'Incorrect ready mark' },
  })
  expect(screen.getByRole('button', { name: 'Confirm preparation change' })).toBeEnabled()
})
it('cashier has no backward correction controls', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ ...list(), actorRole: 'cashier' }))
  )
  render(<TabKitchenBoard {...props} />)
  await screen.findByText('8 piece')
  expect(screen.queryByRole('button', { name: /Correct/ })).not.toBeInTheDocument()
})
it('read failure retains stale card with disabled stage actions', async () => {
  let fail = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => (fail ? response({}, 503) : response(list())))
  )
  render(<TabKitchenBoard {...props} />)
  await screen.findByText('8 piece')
  fail = true
  fireEvent.click(screen.getByRole('button', { name: 'Refresh sent orders' }))
  await screen.findByText(/could not refresh/)
  expect(screen.getByText('8 piece')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Start queued items' })).toBeDisabled()
})
it('undispatched saved order permits legacy payment and requires dispatch confirmation', async () => {
  const ready = vi.fn(),
    sent: TabKitchenCommand[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      if (options?.method === 'POST') {
        const c = JSON.parse(options.body)
        sent.push(c)
        return response({
          status: 'updated',
          requestId: c.id,
          replayed: false,
          ticket: { ...ticket, revision: 1 },
        })
      }
      return response(String(url).includes('/open-orders?') ? openList : byTab(null))
    })
  )
  render(<TabKitchenDispatch {...props} tab={tab} onPaymentReady={ready} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Send to kitchen' }))
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true))
  expect(sent).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Confirm send to kitchen' }))
  await waitFor(() => expect(sent).toHaveLength(1))
  expect(sent[0]).toMatchObject({
    type: 'dispatch',
    expectedTabRevision: 2,
    expectedTicketRevision: 0,
  })
})
it('saved unsent changes block payment but price-only equal content does not', async () => {
  let required = true
  const ready = vi.fn()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      response(String(url).includes('/open-orders?') ? openList : byTab(ticket, required))
    )
  )
  render(<TabKitchenDispatch {...props} tab={tab} onPaymentReady={ready} />)
  await screen.findByText(/Saved changes have not reached/)
  expect(ready).toHaveBeenLastCalledWith(false)
  required = false
  fireEvent.click(screen.getByRole('button', { name: 'Refresh kitchen dispatch' }))
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true))
  expect(screen.getByRole('button', { name: 'Review kitchen changes' })).toBeDisabled()
})
it('a current tab revision mismatch blocks dispatch and checkout', async () => {
  const ready = vi.fn()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      response(
        String(url).includes('/open-orders?')
          ? openList
          : { ...byTab(ticket, true), tabRevision: 3 }
      )
    )
  )
  render(<TabKitchenDispatch {...props} tab={tab} onPaymentReady={ready} />)
  await screen.findByText(/changed at another counter/)
  expect(ready).toHaveBeenLastCalledWith(false)
  expect(screen.getByRole('button', { name: 'Review kitchen changes' })).toBeDisabled()
})
it('manager must reason a withdrawal touching served quantities', async () => {
  const reduced = {
    ...tab,
    lines: [{ ...tab.lines[0], quantityMilli: 1000 }],
    subtotalFils: 500,
    taxFils: 24,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      response(
        String(url).includes('/open-orders?')
          ? { ...openList, openTabs: [reduced] }
          : byTab(ticket, true)
      )
    )
  )
  render(<TabKitchenDispatch {...props} tab={reduced} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Review kitchen changes' }))
  expect(screen.getByText(/withdraws quantities already/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Confirm send to kitchen' })).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox', { name: 'Reason for kitchen change' }), {
    target: { value: 'Customer reduced order' },
  })
  expect(screen.getByRole('button', { name: 'Confirm send to kitchen' })).toBeEnabled()
})
it('cashier cannot dispatch a reduction beyond queued quantities', async () => {
  const reduced = {
    ...tab,
    lines: [{ ...tab.lines[0], quantityMilli: 1000 }],
    subtotalFils: 500,
    taxFils: 24,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      response(
        String(url).includes('/open-orders?')
          ? { ...openList, openTabs: [reduced] }
          : { ...byTab(ticket, true), actorRole: 'cashier' }
      )
    )
  )
  render(<TabKitchenDispatch {...props} tab={reduced} />)
  await screen.findByText(/withdraws quantities already/)
  expect(screen.getByRole('button', { name: 'Review kitchen changes' })).toBeDisabled()
})
it('redispatch after cancellation explains new preparation and requires a manager reason', async () => {
  const cancelled: TabKitchenTicket = {
    ...ticket,
    state: 'cancelled',
    lines: [],
    stages: { queued: [], preparing: [], ready: [], served: [] },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      response(String(url).includes('/open-orders?') ? openList : byTab(cancelled, true))
    )
  )
  render(<TabKitchenDispatch {...props} tab={tab} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Review kitchen changes' }))
  expect(
    screen.getByText(/All current quantities will queue as new preparation/)
  ).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Confirm send to kitchen' })).toBeDisabled()
})
it('global recovery discovers authenticated original actor without a device or bootstrap', async () => {
  storage.records = [{ actorId: actor, command: stageCommand }]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) =>
      String(url).endsWith('/session')
        ? response({ status: 'authenticated', userId: actor })
        : response({ status: 'cancelled', requestId: JSON.parse(options.body).id, replayed: false })
    )
  )
  render(<TabKitchenPendingRecovery />)
  fireEvent.click(await screen.findByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Check or cancel saved change' }))
  await waitFor(() => expect(storage.records).toHaveLength(0))
})
it('foreign branch detail does not expose or acknowledge notices', async () => {
  const pending = { ...ticket, acknowledgedSequence: 1, pendingChangeCount: 1 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      response(
        String(url).includes('ticketId')
          ? { ...detail(pending), branchId: '90000000-0000-4000-8000-000000000099' }
          : list(pending)
      )
    )
  )
  render(<TabKitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Review notices' }))
  await screen.findByText(/notices could not be checked/)
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
})
it('cross-tab notification locks current stage until original request resolves', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(list()))
  )
  render(<TabKitchenBoard {...props} />)
  await screen.findByRole('button', { name: 'Start queued items' })
  storage.records = [{ actorId: actor, command: stageCommand }]
  await act(async () => {
    window.dispatchEvent(new Event('pos-tab-kitchen-journal-changed'))
  })
  expect(screen.getByRole('button', { name: 'Start queued items' })).toBeDisabled()
})
it('history pagination never offers acknowledgement controls', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      response(
        String(url).includes('ticketId')
          ? { ...detail(ticket, [{ ...event, sequence: 1 }]), eventsNextAfter: 1 }
          : list()
      )
    )
  )
  render(<TabKitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'View dispatch history' }))
  await screen.findByRole('button', { name: 'Next history page' })
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
})
it('cancellation consent resets when a new exact request replaces the resolved one', async () => {
  storage.records = [{ actorId: actor, command: stageCommand }]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) =>
      options?.method === 'POST'
        ? response({ status: 'cancelled', requestId: JSON.parse(options.body).id, replayed: false })
        : response(list())
    )
  )
  render(<TabKitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Check or cancel saved change' }))
  await waitFor(() => expect(storage.records).toHaveLength(0))
  storage.records = [
    { actorId: actor, command: { ...stageCommand, id: '80000000-0000-4000-8000-000000000002' } },
  ]
  await act(async () => {
    window.dispatchEvent(new Event('pos-tab-kitchen-journal-changed'))
  })
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(screen.getByRole('button', { name: 'Check or cancel saved change' })).toBeDisabled()
})
it('parent dirty basket guard prevents dispatch even when server detail is current', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => response(String(url).includes('/open-orders?') ? openList : byTab(null)))
  )
  render(<TabKitchenDispatch {...props} disabled tab={tab} />)
  await screen.findByText(/Not sent to the kitchen/)
  expect(screen.getByRole('button', { name: 'Send to kitchen' })).toBeDisabled()
})
it('dispatch read failure revokes payment readiness while retaining status', async () => {
  const ready = vi.fn()
  let fail = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      fail
        ? response({}, 503)
        : response(String(url).includes('/open-orders?') ? openList : byTab())
    )
  )
  render(<TabKitchenDispatch {...props} tab={tab} onPaymentReady={ready} />)
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true))
  fail = true
  fireEvent.click(screen.getByRole('button', { name: 'Refresh kitchen dispatch' }))
  await screen.findByText(/dispatch could not be checked/)
  expect(ready).toHaveBeenLastCalledWith(false)
})
it('caller adoption failure keeps the kitchen request recoverable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) =>
      options?.method === 'POST' ? response(stageAck(JSON.parse(options.body))) : response(list())
    )
  )
  render(
    <TabKitchenBoard
      {...props}
      onResolved={() => {
        throw new Error('caller failed')
      }}
    />
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Start queued items' }))
  await screen.findByRole('button', { name: 'Retry saved kitchen dispatch change' })
  expect(storage.records).toHaveLength(1)
})
it('an in-flight detail refresh temporarily revokes payment readiness', async () => {
  const ready = vi.fn()
  let hold = false,
    release!: (value: Response) => void
  const delayed = new Promise<Response>((resolve) => {
    release = resolve
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      String(url).includes('/open-orders?')
        ? response(openList)
        : hold
          ? delayed
          : response(byTab())
    )
  )
  render(<TabKitchenDispatch {...props} tab={tab} onPaymentReady={ready} />)
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true))
  hold = true
  fireEvent.click(screen.getByRole('button', { name: 'Refresh kitchen dispatch' }))
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(false))
  await act(async () => {
    release(response(byTab()))
  })
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true))
})
