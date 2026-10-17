import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import OpenOrdersBoard from '@/components/pos/open-orders/OpenOrdersBoard'
import OpenOrderSave from '@/components/pos/open-orders/OpenOrderSave'
import { OpenOrderPendingRecovery } from '@/components/pos/open-orders/OpenOrderPendingRecovery'
import type { OpenOrderCommand, OpenOrderTab } from '@/lib/pos/server/open-order-contracts'
const journal = vi.hoisted(() => ({
  records: [] as Array<{ actorId: string; command: OpenOrderCommand }>,
  fail: false,
}))
vi.mock('@/lib/pos/open-order-journal', () => ({
  openOrderJournalEvent: 'pos-open-order-journal-changed',
  readPendingOpenOrderRequests: vi.fn(async (actor: string) =>
    journal.records.filter((record) => record.actorId === actor)
  ),
  savePendingOpenOrderRequest: vi.fn(
    async (record: { actorId: string; command: OpenOrderCommand }) => {
      if (
        journal.fail ||
        journal.records.some(
          (item) =>
            item.actorId === record.actorId && item.command.branchId === record.command.branchId
        )
      )
        throw new Error('storage')
      journal.records.push(structuredClone(record))
    }
  ),
  acknowledgeOpenOrderRequest: vi.fn(async (actor: string, branch: string, id: string) => {
    const found = journal.records.find(
      (record) => record.actorId === actor && record.command.branchId === branch
    )
    if (found && found.command.id !== id) throw new Error('wrong request')
    journal.records = journal.records.filter((record) => record !== found)
  }),
}))
const branch = '10000000-0000-4000-8000-000000000001',
  device = '20000000-0000-4000-8000-000000000001',
  actor = '30000000-0000-4000-8000-000000000001',
  org = '70000000-0000-4000-8000-000000000001',
  tableId = '90000000-0000-4000-8000-000000000001'
const timestamp = '2026-10-16T04:00:00Z'
const line = {
  productId: '60000000-0000-4000-8000-000000000001',
  name: 'Kaju Katli',
  category: 'Sweets',
  imageUrl: null,
  unit: 'kg' as const,
  quantityMilli: 250,
  unitPriceFils: 2000,
  taxRateBps: 500,
  revision: 1,
}
const tab: OpenOrderTab = {
  id: '40000000-0000-4000-8000-000000000001',
  branchId: branch,
  revision: 1,
  status: 'open',
  label: 'Table 4 lunch',
  serviceType: 'dine_in',
  tableId,
  guestCount: 2,
  note: 'No extra garnish',
  lines: [line],
  subtotalFils: 500,
  taxFils: 24,
  createdBy: actor,
  updatedBy: actor,
  createdAt: timestamp,
  updatedAt: timestamp,
  settledOrderId: null,
}
const table = {
  id: tableId,
  branchId: branch,
  revision: 1,
  name: '4',
  area: 'Main hall',
  seats: 4,
  active: true,
  createdAt: timestamp,
  updatedAt: timestamp,
  occupiedTabId: tab.id,
}
const freeTable = {
  ...table,
  id: '90000000-0000-4000-8000-000000000002',
  name: '5',
  occupiedTabId: null,
}
const list = {
  status: 'ready',
  organizationId: org,
  branchId: branch,
  actorRole: 'manager',
  generatedAt: timestamp,
  tables: [table, freeTable],
  openTabs: [tab],
  openCount: 1,
  openNextCursor: null,
  recentTabs: [],
  recentTruncated: false,
}
const requestLines = [
  {
    productId: line.productId,
    quantityMilli: line.quantityMilli,
    expectedUnitPriceFils: line.unitPriceFils,
    expectedTaxRateBps: line.taxRateBps,
    expectedRevision: line.revision,
  },
]
const command: OpenOrderCommand = {
  id: '80000000-0000-4000-8000-000000000001',
  branchId: branch,
  deviceId: device,
  type: 'tab.save',
  tabId: tab.id,
  expectedRevision: 1,
  label: tab.label,
  serviceType: tab.serviceType,
  tableId,
  guestCount: 2,
  note: tab.note,
  lines: requestLines,
}
const scope = { actorId: actor, branchId: branch, deviceId: device, disabled: false }
const props = { ...scope, branchName: 'Test branch', onOpen: vi.fn(), onStartTable: vi.fn() }
const saveProps = {
  ...scope,
  sourceTab: null,
  serviceType: 'takeaway' as const,
  lines: requestLines,
  onSaved: vi.fn(),
}
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
function ack(c: OpenOrderCommand) {
  if (c.type === 'table.save')
    return {
      status: 'updated',
      requestId: c.id,
      replayed: false,
      table: { ...freeTable, ...c.table, branchId: c.branchId, revision: c.expectedRevision + 1 },
    }
  return {
    status: 'updated',
    requestId: c.id,
    replayed: false,
    tab: {
      ...tab,
      ...(c.type === 'tab.void'
        ? {}
        : {
            label: c.label,
            serviceType: c.serviceType,
            tableId: c.tableId,
            guestCount: c.guestCount,
            note: c.note,
            lines: c.lines.map((l) => ({
              ...line,
              productId: l.productId,
              quantityMilli: l.quantityMilli,
              unitPriceFils: l.expectedUnitPriceFils,
              taxRateBps: l.expectedTaxRateBps,
              revision: l.expectedRevision,
            })),
          }),
      id: c.tabId,
      branchId: c.branchId,
      revision: c.expectedRevision + 1,
      status: c.type === 'tab.void' ? 'voided' : 'open',
    },
  }
}
async function newForm() {
  fireEvent.click(screen.getByText('Save this order for later'))
  fireEvent.change(screen.getByLabelText('Order label'), { target: { value: 'Ahmed takeaway' } })
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save unpaid order' })).toBeEnabled()
  )
}
beforeEach(() => {
  journal.records = []
  journal.fail = false
  props.onOpen.mockReset()
  props.onStartTable.mockReset()
  saveProps.onSaved.mockReset()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('untouched new optional form leaves ordinary walk-in checkout clean; edits mark metadata dirty', async () => {
  const dirty = vi.fn()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(list))
  )
  render(<OpenOrderSave {...saveProps} onDirtyChange={dirty} />)
  await waitFor(() => expect(dirty).toHaveBeenCalledWith(false))
  await newForm()
  expect(dirty).toHaveBeenLastCalledWith(true)
})
it('persists exact new save before network and adopts canonical source before clearing journal', async () => {
  const saved = vi.fn(async () => {
    expect(journal.records).toHaveLength(1)
  })
  const sent: OpenOrderCommand[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      if (options?.method === 'POST') {
        const c = JSON.parse(options.body)
        sent.push(c)
        expect(journal.records[0].command).toEqual(c)
        return response(ack(c))
      }
      return response(list)
    })
  )
  render(<OpenOrderSave {...saveProps} onSaved={saved} />)
  await newForm()
  fireEvent.click(screen.getByRole('button', { name: 'Save unpaid order' }))
  await waitFor(() => expect(journal.records).toHaveLength(0))
  expect(saved).toHaveBeenCalledOnce()
  expect(sent[0]).toMatchObject({
    type: 'tab.save',
    expectedRevision: 0,
    label: 'Ahmed takeaway',
    tableId: null,
    lines: requestLines,
  })
})
it('uncertain saved order retries original body after replacement device and invokes onSaved on replay', async () => {
  journal.records = [{ actorId: actor, command }]
  const sent: OpenOrderCommand[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      if (options?.method === 'POST') {
        const c = JSON.parse(options.body)
        sent.push(c)
        return response({ ...ack(c), replayed: true })
      }
      return response(list)
    })
  )
  render(<OpenOrderSave {...saveProps} deviceId={freeTable.id} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Retry saved open-order change' }))
  await waitFor(() => expect(saveProps.onSaved).toHaveBeenCalledOnce())
  expect(sent[0]).toEqual(command)
  expect(journal.records).toHaveLength(0)
})
it('cancellation invokes resolution callback but never adopts a saved order', async () => {
  journal.records = [{ actorId: actor, command }]
  const resolved = vi.fn()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) =>
      options?.method === 'POST'
        ? response({ status: 'cancelled', requestId: command.id, replayed: false })
        : response(list)
    )
  )
  render(<OpenOrderSave {...saveProps} onResolved={resolved} />)
  fireEvent.click(await screen.findByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Check or cancel saved change' }))
  await waitFor(() => expect(journal.records).toHaveLength(0))
  expect(saveProps.onSaved).not.toHaveBeenCalled()
  expect(resolved).toHaveBeenCalledWith(command, {
    status: 'cancelled',
    requestId: command.id,
    replayed: false,
  })
})
it('mismatched ACK or cancellation retains immutable request', async () => {
  journal.records = [{ actorId: actor, command }]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) =>
      options?.method === 'POST' ? response({ ...ack(command), requestId: device }) : response(list)
    )
  )
  render(<OpenOrderSave {...saveProps} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Retry saved open-order change' }))
  await screen.findByRole('alert')
  expect(journal.records[0].command).toEqual(command)
  expect(saveProps.onSaved).not.toHaveBeenCalled()
})
it('failure to adopt canonical order keeps the original request recoverable', async () => {
  journal.records = [{ actorId: actor, command }]
  const saved = vi.fn(async () => {
    throw new Error('counter failed')
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) =>
      options?.method === 'POST' ? response(ack(command)) : response(list)
    )
  )
  render(<OpenOrderSave {...saveProps} onSaved={saved} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Retry saved open-order change' }))
  await screen.findByRole('alert')
  expect(journal.records).toHaveLength(1)
})
it('storage failure sends no mutation', async () => {
  journal.fail = true
  const fetcher = vi.fn(async () => response(list))
  vi.stubGlobal('fetch', fetcher)
  render(<OpenOrderSave {...saveProps} />)
  await newForm()
  fireEvent.click(screen.getByRole('button', { name: 'Save unpaid order' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('no new request was sent')
  expect(fetcher.mock.calls.some((c: unknown[]) => (c[1] as RequestInit)?.method === 'POST')).toBe(
    false
  )
})
it('background refresh does not reset edited notes or guest count', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(list))
  )
  render(<OpenOrderSave {...saveProps} sourceTab={tab} serviceType="dine_in" />)
  await screen.findByRole('button', { name: 'Save order changes' })
  fireEvent.change(screen.getByLabelText('Order note'), {
    target: { value: 'Keep this edited note' },
  })
  fireEvent.change(screen.getByLabelText('Guests (optional)'), { target: { value: '3' } })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh table availability' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Refresh table availability' })).toBeEnabled()
  )
  expect(screen.getByLabelText('Order note')).toHaveValue('Keep this edited note')
  expect(screen.getByLabelText('Guests (optional)')).toHaveValue(3)
})
it('manager reopening uses full edited metadata and reason; cashier cannot reopen', async () => {
  const voided = { ...tab, status: 'voided' as const, tableId: null }
  const sent: OpenOrderCommand[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      if (options?.method === 'POST') {
        const c = JSON.parse(options.body)
        sent.push(c)
        return response(ack(c))
      }
      return response(list)
    })
  )
  render(<OpenOrderSave {...saveProps} sourceTab={voided} serviceType="dine_in" />)
  const button = await screen.findByRole('button', { name: 'Reopen unpaid order' })
  expect(button).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Reason for reopening'), {
    target: { value: 'Customer returned' },
  })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  await waitFor(() => expect(sent).toHaveLength(1))
  expect(sent[0]).toMatchObject({
    type: 'tab.reopen',
    expectedRevision: 1,
    reason: 'Customer returned',
    lines: requestLines,
    tableId: null,
  })
})
it('occupied table assigned to another order cannot be selected or saved', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(list))
  )
  render(<OpenOrderSave {...saveProps} serviceType="dine_in" initialTableId={tableId} />)
  await screen.findByText(/This table is no longer available/)
  fireEvent.change(screen.getByLabelText('Order label'), { target: { value: 'New table order' } })
  expect(screen.getByRole('button', { name: 'Save unpaid order' })).toBeDisabled()
})
it('table tiles select a free table without submitting and preserve the selected table in the save', async () => {
  const sent: OpenOrderCommand[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      if (options?.method === 'POST') {
        const command = JSON.parse(options.body)
        sent.push(command)
        return response(ack(command))
      }
      return response({
        ...list,
        tables: [...list.tables, { ...freeTable, id: actor, name: 'Closed table', active: false }],
      })
    })
  )
  render(<OpenOrderSave {...saveProps} serviceType="dine_in" />)
  await newForm()
  const group = screen.getByRole('group', { name: 'Table' })
  expect(within(group).getByRole('radio', { name: 'No table assigned' })).toBeChecked()
  expect(within(group).queryByRole('radio', { name: '4 — Main hall' })).not.toBeInTheDocument()
  expect(within(group).queryByRole('radio', { name: /Closed table/ })).not.toBeInTheDocument()
  fireEvent.click(within(group).getByRole('radio', { name: '5 — Main hall' }))
  expect(within(group).getByRole('radio', { name: '5 — Main hall' })).toBeChecked()
  expect(sent).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Save unpaid order' }))
  await waitFor(() => expect(sent).toHaveLength(1))
  expect(sent[0]).toMatchObject({ type: 'tab.save', serviceType: 'dine_in', tableId: freeTable.id })
})
it('table tiles preserve an order own table and disable every choice when availability is stale', async () => {
  const fetcher = vi.fn(async () => response(list))
  vi.stubGlobal('fetch', fetcher)
  render(<OpenOrderSave {...saveProps} sourceTab={tab} serviceType="dine_in" />)
  const ownTable = await screen.findByRole('radio', { name: '4 — Main hall' })
  expect(ownTable).toBeChecked()
  expect(ownTable).toBeEnabled()
  fireEvent(window, new Event('offline'))
  for (const radio of within(screen.getByRole('group', { name: 'Table' })).getAllByRole('radio')) {
    expect(radio).toBeDisabled()
  }
  expect(screen.getByRole('button', { name: 'Save order changes' })).toBeDisabled()
  expect(ownTable).toBeChecked()
})
it('board opens latest server detail and explains explicit kitchen dispatch', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      response(
        String(url).includes('tabId=')
          ? {
              status: 'ready',
              organizationId: org,
              branchId: branch,
              actorRole: 'manager',
              tab: { ...tab, revision: 2 },
            }
          : list
      )
    )
  )
  render(<OpenOrdersBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Open at counter' }))
  await waitFor(() => expect(props.onOpen).toHaveBeenCalledWith({ ...tab, revision: 2 }))
  expect(screen.getByText(/use Kitchen preparation to send it before payment/)).toBeInTheDocument()
})
it('table overview opens off-page occupied order and starts free table without creating an order', async () => {
  const sent: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      sent.push(String(url))
      return response(
        String(url).includes('tabId=')
          ? { status: 'ready', organizationId: org, branchId: branch, actorRole: 'manager', tab }
          : { ...list, openTabs: [] }
      )
    })
  )
  render(<OpenOrdersBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Tables (2)' }))
  fireEvent.click(
    within(screen.getByRole('article', { name: 'Table 4' })).getByRole('button', {
      name: 'Open order',
    })
  )
  await waitFor(() => expect(props.onOpen).toHaveBeenCalledOnce())
  fireEvent.click(
    within(screen.getByRole('article', { name: 'Table 5' })).getByRole('button', {
      name: 'Start order',
    })
  )
  await waitFor(() => expect(props.onStartTable).toHaveBeenCalledWith(freeTable))
  expect(sent.every((url) => url.startsWith('/api/pos/open-orders?'))).toBe(true)
})
it('void requires manager reason and exact current revision; cashier sees no void/config controls', async () => {
  const sent: OpenOrderCommand[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      if (options?.method === 'POST') {
        const c = JSON.parse(options.body)
        sent.push(c)
        return response(ack(c))
      }
      return response(list)
    })
  )
  render(<OpenOrdersBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Void order' }))
  expect(screen.getByRole('button', { name: 'Confirm void' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Reason for voiding'), {
    target: { value: 'Duplicate unpaid order' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm void' }))
  await waitFor(() => expect(sent).toHaveLength(1))
  expect(sent[0]).toMatchObject({
    type: 'tab.void',
    tabId: tab.id,
    expectedRevision: 1,
    reason: 'Duplicate unpaid order',
  })
})
it('cashier cannot access manager void, reopen or table setup controls', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response({
        ...list,
        actorRole: 'cashier',
        recentTabs: [{ ...tab, id: device, status: 'voided', tableId: null }],
      })
    )
  )
  render(<OpenOrdersBoard {...props} />)
  await screen.findByText(tab.label)
  expect(screen.queryByRole('button', { name: 'Void order' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Tables (2)' }))
  expect(screen.queryByRole('button', { name: 'Add table' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Edit table' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Recent history' }))
  expect(screen.queryByRole('button', { name: 'Review and reopen' })).toBeNull()
})
it('occupied table cannot be deactivated; table edits require reason and correct revision', async () => {
  const sent: OpenOrderCommand[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      if (options?.method === 'POST') {
        const c = JSON.parse(options.body)
        sent.push(c)
        return response({
          ...ack(c),
          table: {
            ...table,
            ...(c as Extract<OpenOrderCommand, { type: 'table.save' }>).table,
            revision: 2,
          },
        })
      }
      return response(list)
    })
  )
  render(<OpenOrdersBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Tables (2)' }))
  fireEvent.click(
    within(screen.getByRole('article', { name: 'Table 4' })).getByRole('button', {
      name: 'Edit table',
    })
  )
  expect(screen.getByLabelText('Active table')).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Save table' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Reason for table change'), {
    target: { value: 'Correct table name' },
  })
  fireEvent.change(screen.getByLabelText('Table name'), { target: { value: '4A' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save table' }))
  await waitFor(() => expect(sent).toHaveLength(1))
  expect(sent[0]).toMatchObject({
    type: 'table.save',
    expectedRevision: 1,
    table: { id: tableId, name: '4A', active: true },
  })
})
it('stale read retains orders and table state while disabling actions', async () => {
  let fail = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => (fail ? response({}, 503) : response(list)))
  )
  render(<OpenOrdersBoard {...props} />)
  await screen.findByText(tab.label)
  fail = true
  fireEvent.click(screen.getByRole('button', { name: 'Refresh orders' }))
  await screen.findByRole('alert')
  expect(screen.getByText(tab.label)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Open at counter' })).toBeDisabled()
})
it('foreign list or mismatched detail never opens an order', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      response(
        String(url).includes('tabId=')
          ? {
              status: 'ready',
              organizationId: org,
              branchId: branch,
              actorRole: 'manager',
              tab: { ...tab, id: device },
            }
          : list
      )
    )
  )
  render(<OpenOrdersBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Open at counter' }))
  await screen.findByRole('alert')
  expect(props.onOpen).not.toHaveBeenCalled()
})
it('global recovery discovers authenticated original actor and resolves only matching command', async () => {
  journal.records = [
    { actorId: actor, command },
    { actorId: device, command: { ...command, id: device } },
  ]
  const resolved = vi.fn()
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      urls.push(String(url))
      return response(
        options?.method === 'POST'
          ? { status: 'cancelled', requestId: command.id, replayed: false }
          : { status: 'authenticated', userId: actor }
      )
    })
  )
  render(<OpenOrderPendingRecovery onResolved={resolved} />)
  fireEvent.click(await screen.findByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Check or cancel saved change' }))
  await waitFor(() => expect(journal.records).toHaveLength(1))
  expect(journal.records[0].actorId).toBe(device)
  expect(resolved).toHaveBeenCalledOnce()
  expect(urls).toEqual(['/api/pos/session', '/api/pos/open-orders/recovery'])
})
it('a second pending request requires fresh cancellation consent', async () => {
  journal.records = [{ actorId: actor, command }]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) =>
      options?.method === 'POST'
        ? String(url).endsWith('/recovery')
          ? response({
              status: 'cancelled',
              requestId: JSON.parse(options.body).id,
              replayed: false,
            })
          : response({}, 503)
        : response(list)
    )
  )
  render(<OpenOrderSave {...saveProps} />)
  fireEvent.click(await screen.findByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Check or cancel saved change' }))
  await waitFor(() => expect(journal.records).toHaveLength(0))
  await newForm()
  fireEvent.click(screen.getByRole('button', { name: 'Save unpaid order' }))
  expect(await screen.findByRole('checkbox')).not.toBeChecked()
  expect(screen.getByRole('button', { name: 'Check or cancel saved change' })).toBeDisabled()
})
it('busy guard is raised before persistence and released only after canonical callback', async () => {
  const busy = vi.fn(),
    saved = vi.fn(async () => {
      expect(busy).toHaveBeenLastCalledWith(true)
      expect(journal.records).toHaveLength(1)
    })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) =>
      options?.method === 'POST' ? response(ack(JSON.parse(options.body))) : response(list)
    )
  )
  render(<OpenOrderSave {...saveProps} onBusyChange={busy} onSaved={saved} />)
  await newForm()
  fireEvent.click(screen.getByRole('button', { name: 'Save unpaid order' }))
  await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false))
  expect(saved).toHaveBeenCalledOnce()
})
it('pagination replaces visible orders while complete occupancy remains', async () => {
  const another = { ...tab, id: device, label: 'Next-page order', tableId: null }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      response(
        String(url).includes('afterId=')
          ? { ...list, openTabs: [another], openCount: 2 }
          : { ...list, openCount: 2, openNextCursor: { createdAt: tab.createdAt, id: tab.id } }
      )
    )
  )
  render(<OpenOrdersBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Next page' }))
  await screen.findByText('Next-page order')
  expect(screen.queryByText(tab.label)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Tables (2)' }))
  expect(
    within(screen.getByRole('article', { name: 'Table 4' })).getByText('Order open')
  ).toBeInTheDocument()
})
it('foreign branch list is rejected and paid detail is never reopened', async () => {
  let foreign = true
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      response(
        String(url).includes('tabId=')
          ? {
              status: 'ready',
              organizationId: org,
              branchId: branch,
              actorRole: 'manager',
              tab: { ...tab, status: 'settled', settledOrderId: device },
            }
          : foreign
            ? { ...list, branchId: device }
            : list
      )
    )
  )
  render(<OpenOrdersBoard {...props} />)
  await screen.findByRole('alert')
  expect(screen.queryByText(tab.label)).toBeNull()
  foreign = false
  fireEvent.click(screen.getByRole('button', { name: 'Refresh orders' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Open at counter' }))
  await screen.findByRole('alert')
  expect(props.onOpen).not.toHaveBeenCalled()
})
it('same-branch cross-tab event blocks actions without overwriting the saved request', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(list))
  )
  render(<OpenOrdersBoard {...props} />)
  await screen.findByRole('button', { name: 'Open at counter' })
  journal.records = [{ actorId: actor, command }]
  await act(async () => {
    window.dispatchEvent(new Event('pos-open-order-journal-changed'))
  })
  expect(screen.getByRole('button', { name: 'Open at counter' })).toBeDisabled()
  expect(screen.getByText(`Request ${command.id}`)).toBeInTheDocument()
})
it('visible polling never overlaps and stops while hidden', async () => {
  vi.useFakeTimers()
  let finish: ((value: Response) => void) | undefined
  const visible = vi.spyOn(document, 'visibilityState', 'get')
  visible.mockReturnValue('visible')
  const fetcher = vi.fn(
    async () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      })
  )
  vi.stubGlobal('fetch', fetcher)
  try {
    render(<OpenOrdersBoard {...props} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000)
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => finish?.(response(list)))
    visible.mockReturnValue('hidden')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000)
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    visible.mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => finish?.(response(list)))
  } finally {
    vi.useRealTimers()
  }
})
