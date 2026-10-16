import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import StockManager from '@/components/pos/inventory/StockManager'
import PendingStockRecovery from '@/components/pos/inventory/PendingStockRecovery'
import {
  clearStockRequest,
  readStockRequest,
  readStockRequests,
  saveStockRequest,
} from '@/components/pos/inventory/journal'
import type {
  InventoryCommand,
  InventoryResult,
  StockItem,
  StockMovement,
} from '@/lib/pos/inventory'

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const actorId = id(1),
  branchId = id(2),
  deviceId = id(3),
  itemId = id(4)
const timestamp = '2026-10-16T08:00:00.000Z'
const base: StockItem = {
  id: itemId,
  branchId,
  name: 'Flour',
  sku: 'FLOUR',
  unit: 'kg',
  reorderLevelMilli: 2000,
  active: true,
  revision: 1,
  onHandMilli: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  movementCount: 0,
}
const props = { actorId, branchId, branchName: 'Synthetic branch', deviceId, disabled: false }
const storageKey = `pos-stock-request:${actorId}:${branchId}:${deviceId}`
const countCommand: InventoryCommand = {
  id: id(8),
  type: 'stock.count',
  branchId,
  deviceId,
  itemId,
  expectedRevision: 1,
  quantityMilli: 0,
  reason: 'Opening stock checked',
  reference: null,
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
let items: StockItem[],
  movements: StockMovement[],
  commands: InventoryCommand[],
  saved: Map<string, InventoryResult>
let failWrite = false,
  failRead = false,
  failHistory = false,
  malformedAck = false
function apply(command: InventoryCommand): InventoryResult {
  const existing = saved.get(command.id)
  if (existing) return { ...existing, replayed: true }
  const old = items.find(
    (value) => value.id === (command.type === 'item.save' ? command.item.id : command.itemId)
  )
  let item: StockItem,
    movement: StockMovement | null = null
  if (command.type === 'item.save')
    item = {
      ...(old ?? base),
      ...command.item,
      branchId,
      revision: command.expectedRevision + 1,
      onHandMilli: old?.onHandMilli ?? null,
      movementCount: old?.movementCount ?? 0,
    }
  else {
    const before = old!.onHandMilli
    const after =
      command.type === 'stock.count'
        ? command.quantityMilli
        : before! +
          (command.type === 'stock.waste' ? -command.quantityMilli : command.quantityMilli)
    item = {
      ...old!,
      onHandMilli: after,
      revision: old!.revision + 1,
      movementCount: old!.movementCount + 1,
    }
    movement = {
      id: command.id,
      itemId: item.id,
      type: command.type,
      quantityMilli: command.quantityMilli,
      beforeMilli: before,
      deltaMilli: before === null ? null : after - before,
      afterMilli: after,
      reason: command.reason,
      reference: command.reference,
      actorId,
      deviceId,
      actorName: 'Synthetic manager',
      deviceName: 'Test counter',
      recordedAt: timestamp,
      revision: item.revision,
    }
    movements.unshift(movement)
  }
  items = items
    .filter((value) => value.id !== item.id)
    .concat(item)
    .sort((a, b) => a.id.localeCompare(b.id))
  const result: InventoryResult = {
    status: 'applied',
    requestId: command.id,
    replayed: false,
    item,
    movement,
  }
  saved.set(command.id, result)
  return result
}
const backend = async (url: string | URL | Request, init?: RequestInit) => {
  const target = new URL(String(url), 'http://localhost')
  if (target.pathname === '/api/pos/session') return json({ userId: actorId })
  if (init?.method === 'POST') expect(new Headers(init.headers).get('X-POS-Actor')).toBe(actorId)
  if (target.pathname === '/api/pos/inventory/recovery') {
    const body = JSON.parse(String(init?.body)) as {
      mode: 'lookup' | 'cancel'
      command: InventoryCommand
    }
    const result = saved.get(body.command.id)
    if (result) return json({ ...result, replayed: true })
    if (body.mode === 'lookup') return json({ status: 'not_found', requestId: body.command.id })
    const cancelled: InventoryResult = {
      status: 'cancelled',
      requestId: body.command.id,
      replayed: false,
    }
    saved.set(body.command.id, cancelled)
    return json(cancelled)
  }
  if (target.pathname === '/api/pos/inventory/history') {
    if (failHistory) return json({ code: 'unavailable' }, 503)
    const item = items.find((value) => value.id === target.searchParams.get('itemId'))!
    return json({
      status: 'ready',
      branchId: item.branchId,
      asOf: timestamp,
      item,
      entries: movements.filter((value) => value.itemId === item.id),
      nextBeforeRevision: null,
    })
  }
  if (init?.method === 'POST') {
    const command = JSON.parse(String(init.body)) as InventoryCommand
    commands.push(command)
    expect(readStockRequest(actorId, branchId, deviceId)).toEqual(command)
    const result = apply(command)
    if (failWrite) {
      failWrite = false
      throw new TypeError('Response lost after database save')
    }
    return json(malformedAck ? { ...result, requestId: id(999) } : result)
  }
  if (failRead) return json({ code: 'unavailable' }, 503)
  let visible = items.filter((item) => item.branchId === target.searchParams.get('branchId'))
  const active = visible.filter((item) => item.active)
  const low = active.filter(
    (item) => item.onHandMilli !== null && item.onHandMilli <= item.reorderLevelMilli
  )
  const uncounted = active.filter((item) => item.onHandMilli === null)
  const counts = {
    totalItems: visible.length,
    activeItems: active.length,
    inactiveItems: visible.length - active.length,
    lowStockItems: low.length,
    uncountedItems: uncounted.length,
  }
  const filter = target.searchParams.get('filter')
  if (filter === 'low') visible = low
  if (filter === 'uncounted') visible = uncounted
  if (filter === 'inactive') visible = visible.filter((item) => !item.active)
  const search = target.searchParams.get('search')?.toLowerCase() ?? ''
  visible = visible.filter((item) =>
    `${item.name} ${item.sku ?? ''}`.toLowerCase().includes(search)
  )
  return json({
    status: 'ready',
    branchId: target.searchParams.get('branchId'),
    asOf: timestamp,
    counts,
    matchingItems: visible.length,
    items: visible,
    nextCursor: null,
  })
}
beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  items = [{ ...base }]
  movements = []
  commands = []
  saved = new Map()
  failWrite = false
  failRead = false
  failHistory = false
  malformedAck = false
  Element.prototype.scrollIntoView = vi.fn()
  const queues = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (name: string, callback: () => unknown) => {
        const job = (queues.get(name) ?? Promise.resolve()).catch(() => {}).then(callback)
        queues.set(name, job)
        return job
      },
    },
  })
  vi.stubGlobal('fetch', vi.fn(backend))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'locks')
})
const openFlour = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /Flour/ }))
  await screen.findByRole('button', { name: 'Edit item details' })
}
const fillMovement = (quantity: string, reason = 'Manager checked stock') => {
  fireEvent.change(screen.getByPlaceholderText(/Enter quantity|For example, 2/), {
    target: { value: quantity },
  })
  fireEvent.change(screen.getByLabelText('Reason for movement'), { target: { value: reason } })
}

describe('stock manager quantities and movements', () => {
  it('loads stock pages without losing prior items and resets the page on a search change', async () => {
    items = Array.from({ length: 52 }, (_, index) => ({
      ...base,
      id: id(100 + index),
      name: `Ingredient ${index + 1}`,
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const target = new URL(url, 'http://localhost')
        const searched = target.searchParams.get('search') !== ''
        const after = target.searchParams.get('afterId')
        const visible = searched ? items.slice(-1) : after ? items.slice(50) : items.slice(0, 50)
        return json({
          status: 'ready',
          branchId,
          asOf: timestamp,
          counts: {
            totalItems: 52,
            activeItems: 52,
            inactiveItems: 0,
            lowStockItems: 0,
            uncountedItems: 52,
          },
          matchingItems: searched ? 1 : 52,
          items: visible,
          nextCursor: !searched && !after ? items[49].id : null,
        })
      })
    )
    render(<StockManager {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Load more stock items' }))
    await screen.findByRole('button', { name: /Ingredient 52/ })
    expect(screen.getByRole('button', { name: /Ingredient 1FLOUR/ })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Find stock'), { target: { value: 'Ingredient 52' } })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Ingredient 1FLOUR/ })).not.toBeInTheDocument()
    )
    expect(screen.getByRole('button', { name: /Ingredient 52/ })).toBeInTheDocument()
  })

  it('loads older movement pages while preserving the current item scope', async () => {
    apply({ ...countCommand, quantityMilli: 10000, reason: 'Opening physical count' })
    for (let index = 0; index < 50; index++)
      apply({
        ...countCommand,
        id: id(100 + index),
        type: 'stock.receive',
        expectedRevision: 2 + index,
        quantityMilli: 1000,
        reason: `Delivery ${index + 1}`,
      })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = new URL(String(url), 'http://localhost')
        if (target.pathname !== '/api/pos/inventory/history') return backend(url, init)
        const older = target.searchParams.has('beforeRevision')
        return json({
          status: 'ready',
          branchId,
          asOf: timestamp,
          item: items[0],
          entries: older ? movements.slice(50) : movements.slice(0, 50),
          nextBeforeRevision: older ? null : movements[49].revision,
        })
      })
    )
    render(<StockManager {...props} />)
    await openFlour()
    expect(screen.queryByText('Opening physical count')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load older movements' }))
    await screen.findByText('Opening physical count')
    expect(screen.getByText('Delivery 50')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load older movements' })).not.toBeInTheDocument()
  })

  it('ignores an old item history response after a branch change', async () => {
    let complete!: (value: Response) => void
    const waiting = new Promise<Response>((resolve) => {
      complete = resolve
    })
    const otherBranch = id(99)
    items.push({ ...base, id: id(77), branchId: otherBranch, name: 'Other branch stock' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
        String(url).includes('/history?') ? waiting : backend(url, init)
      )
    )
    const view = render(<StockManager {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /Flour/ }))
    await screen.findByText('Loading item history…')
    view.rerender(<StockManager {...props} branchId={otherBranch} branchName="Another branch" />)
    await screen.findByRole('button', { name: /Other branch stock/ })
    await act(async () =>
      complete(
        json({
          status: 'ready',
          branchId,
          asOf: timestamp,
          item: base,
          entries: [],
          nextBeforeRevision: null,
        })
      )
    )
    expect(screen.queryByRole('button', { name: 'Record physical count' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Select a stock item' })).toBeInTheDocument()
  })
  it('keeps uncounted stock unknown and requires a first physical count, including explicit zero', async () => {
    render(<StockManager {...props} />)
    await openFlour()
    expect(screen.getByText(/Sales do not deduct stock automatically/)).toBeInTheDocument()
    expect(screen.getAllByText('Not counted').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Receive' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Waste' })).toBeDisabled()
    fillMovement('0', 'Opening stock checked')
    fireEvent.click(screen.getByRole('button', { name: 'Record physical count' }))
    await screen.findByText(/Physical count confirmed for Flour/)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Receive' })).toBeEnabled())
    expect(commands[0]).toMatchObject({
      type: 'stock.count',
      quantityMilli: 0,
      expectedRevision: 1,
    })
    expect(localStorage.getItem(storageKey)).toBeNull()
    expect(screen.getByRole('region', { name: 'Stock movement history' })).toHaveTextContent(
      'Opening stock checked'
    )
  })

  it.each([
    ['Receive', 'Record receive', 'stock.receive', '1.125', 1125, 11125],
    ['Waste', 'Record waste', 'stock.waste', '0.25', 250, 9750],
    ['Adjustment', 'Record adjustment', 'stock.adjust', '-0.005', -5, 9995],
    ['Physical count', 'Record physical count', 'stock.count', '7.5', 7500, 7500],
  ])(
    'records %s with integer milli quantities and exact revision',
    async (action, submit, type, value, milli, balance) => {
      apply({ ...countCommand, quantityMilli: 10000 })
      render(<StockManager {...props} />)
      await openFlour()
      fireEvent.click(screen.getByRole('button', { name: String(action) }))
      fillMovement(String(value))
      fireEvent.change(screen.getByLabelText('Reference (optional)'), {
        target: { value: 'DEL-123' },
      })
      fireEvent.click(screen.getByRole('button', { name: String(submit) }))
      await waitFor(() => expect(commands).toHaveLength(1))
      await waitFor(() => expect(localStorage.getItem(storageKey)).toBeNull())
      expect(commands[0]).toMatchObject({
        type,
        quantityMilli: milli,
        expectedRevision: 2,
        reference: 'DEL-123',
      })
      expect(items[0].onHandMilli).toBe(balance)
    }
  )

  it('rejects fractional pieces and excessive precision without sending a request', async () => {
    items[0] = { ...base, unit: 'piece' }
    render(<StockManager {...props} />)
    await openFlour()
    fillMovement('1.25')
    fireEvent.click(screen.getByRole('button', { name: 'Record physical count' }))
    await screen.findByText(/Check the quantity and reason/)
    expect(commands).toHaveLength(0)
    fillMovement('1.0001')
    fireEvent.click(screen.getByRole('button', { name: 'Record physical count' }))
    expect(commands).toHaveLength(0)
  })

  it('adds an item without inventing an opening balance and edits metadata without changing the unit', async () => {
    render(<StockManager {...props} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add stock item' })).toBeEnabled()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add stock item' }))
    fireEvent.change(screen.getByLabelText('Stock item name'), { target: { value: 'Milk' } })
    fireEvent.change(screen.getByLabelText('Stock code (optional)'), {
      target: { value: ' milk-1 ' },
    })
    fireEvent.change(screen.getByLabelText('Stock unit'), { target: { value: 'litre' } })
    fireEvent.change(screen.getByLabelText('Reorder level'), { target: { value: '2.5' } })
    fireEvent.change(screen.getByLabelText('Reason for item change'), {
      target: { value: 'Add dairy stock' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save stock item' }))
    await screen.findByText(/Milk saved/)
    expect(commands[0]).toMatchObject({
      type: 'item.save',
      expectedRevision: 0,
      item: { name: 'Milk', sku: 'MILK-1', unit: 'litre', reorderLevelMilli: 2500 },
    })
    const milk = items.find((item) => item.name === 'Milk')!
    expect(milk.onHandMilli).toBeNull()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit item details' })).toBeEnabled()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit item details' }))
    expect(screen.queryByLabelText('Stock unit')).not.toBeInTheDocument()
    expect(screen.getByText(/unit of a saved item cannot be changed/)).toBeInTheDocument()
  })

  it('does not turn an unavailable list into zero counts and blocks writes', async () => {
    failRead = true
    render(<StockManager {...props} />)
    await screen.findByText(/Stock could not be loaded/)
    expect(screen.queryByText(/0 active items/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add stock item' })).toBeDisabled()
  })

  it('does not mutate an item when its authoritative history cannot be refreshed', async () => {
    failHistory = true
    render(<StockManager {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /Flour/ }))
    await screen.findByText(/This item could not be verified/)
    expect(screen.queryByRole('button', { name: 'Record physical count' })).not.toBeInTheDocument()
    expect(commands).toHaveLength(0)
  })

  it('honours external offline and financial holds', async () => {
    render(<StockManager {...props} disabled />)
    await openFlour()
    expect(screen.getByRole('button', { name: 'Add stock item' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Record physical count' })).toBeDisabled()
  })
})

describe('durable stock command recovery', () => {
  it('survives closing and reopening with exact lookup instead of a second movement', async () => {
    failWrite = true
    const first = render(<StockManager {...props} />)
    await openFlour()
    fillMovement('2.25')
    fireEvent.click(screen.getByRole('button', { name: 'Record physical count' }))
    await screen.findByText(/This stock change could not be confirmed/)
    const original = readStockRequest(actorId, branchId, deviceId)!
    expect(original).toEqual(commands[0])
    first.unmount()
    render(<StockManager {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Check saved request' }))
    await screen.findByText(/Physical count confirmed for Flour/)
    expect(commands).toHaveLength(1)
    expect(localStorage.getItem(storageKey)).toBeNull()
  })

  it('requires lookup and explicit consent before cancelling an unsaved command', async () => {
    await saveStockRequest(actorId, countCommand)
    render(<StockManager {...props} />)
    expect(screen.queryByRole('button', { name: 'Cancel unsaved request' })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Check saved request' }))
    await screen.findByText(/No saved result was found yet/)
    expect(screen.getByRole('button', { name: 'Cancel unsaved request' })).toBeDisabled()
    fireEvent.click(
      screen.getByLabelText('Cancel this request only if it has not already been saved.')
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel unsaved request' }))
    await screen.findByText(/confirmed this stock request was cancelled/)
    expect(commands).toHaveLength(0)
    expect(localStorage.getItem(storageKey)).toBeNull()
  })

  it('retains a mismatched acknowledgement and never calls it saved', async () => {
    malformedAck = true
    render(<StockManager {...props} />)
    await openFlour()
    fillMovement('1')
    fireEvent.click(screen.getByRole('button', { name: 'Record physical count' }))
    await screen.findByText(/This stock change could not be confirmed/)
    expect(readStockRequest(actorId, branchId, deviceId)).not.toBeNull()
    expect(screen.queryByText(/Physical count confirmed for/)).not.toBeInTheDocument()
  })

  it('sends nothing when durable storage is unavailable', async () => {
    render(<StockManager {...props} />)
    await openFlour()
    fillMovement('1')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('disk full')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record physical count' }))
    await screen.findByText(/Nothing was sent/)
    expect(commands).toHaveLength(0)
  })

  it('serializes competing requests and refuses to overwrite a different pending command', async () => {
    const outcomes = await Promise.allSettled([
      saveStockRequest(actorId, countCommand),
      saveStockRequest(actorId, { ...countCommand, id: id(9) }),
    ])
    expect(outcomes.map((value) => value.status)).toEqual(['fulfilled', 'rejected'])
    expect(readStockRequest(actorId, branchId, deviceId)).toEqual(countCommand)
    await expect(clearStockRequest(actorId, { ...countCommand, id: id(9) })).rejects.toThrow(
      'stock_journal_conflict'
    )
    expect(readStockRequest(actorId, branchId, deviceId)).toEqual(countCommand)
  })

  it('discovers another tab pending request and disables new stock writes', async () => {
    render(<StockManager {...props} />)
    await openFlour()
    localStorage.setItem(storageKey, JSON.stringify(countCommand))
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: storageKey })))
    expect(await screen.findByRole('button', { name: 'Check saved request' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Record physical count' })).toBeDisabled()
  })

  it('can look up a historical request without Web Locks and retains it if local clearing fails', async () => {
    await saveStockRequest(actorId, countCommand)
    apply(countCommand)
    Reflect.deleteProperty(navigator, 'locks')
    render(<StockManager {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Check saved request' }))
    await screen.findByText(/server confirmed the request, but local recovery/)
    expect(readStockRequest(actorId, branchId, deviceId)).toEqual(countCommand)
    expect(commands).toHaveLength(0)
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/recovery') &&
            new Headers(init?.headers).get('X-POS-Actor') === actorId
        )
    ).toBe(true)
  })

  it('keeps a saved request if the server rejects an account change before applying it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') {
          expect(new Headers(init.headers).get('X-POS-Actor')).toBe(actorId)
          return json({ code: 'inventory_actor_mismatch' }, 401)
        }
        return backend(url, init)
      })
    )
    render(<StockManager {...props} />)
    await openFlour()
    fillMovement('1')
    fireEvent.click(screen.getByRole('button', { name: 'Record physical count' }))
    await screen.findByText(/Sign in to the original account again/)
    expect(readStockRequest(actorId, branchId, deviceId)).not.toBeNull()
    expect(commands).toHaveLength(0)
  })

  it('resets lookup and cancellation consent when another tab replaces the pending request', async () => {
    await saveStockRequest(actorId, countCommand)
    render(<StockManager {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Check saved request' }))
    await screen.findByText(/No saved result was found yet/)
    fireEvent.click(
      screen.getByLabelText('Cancel this request only if it has not already been saved.')
    )
    expect(screen.getByRole('button', { name: 'Cancel unsaved request' })).toBeEnabled()
    localStorage.setItem(storageKey, JSON.stringify({ ...countCommand, id: id(91) }))
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: storageKey })))
    expect(screen.queryByRole('button', { name: 'Cancel unsaved request' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry exact request' })).not.toBeInTheDocument()
  })

  it('fails closed without Web Locks and retains corrupt journals', async () => {
    Reflect.deleteProperty(navigator, 'locks')
    await expect(saveStockRequest(actorId, countCommand)).rejects.toThrow(
      'stock_journal_lock_unavailable'
    )
    localStorage.setItem(storageKey, '{broken')
    render(<StockManager {...props} />)
    await screen.findByText(/saved stock request could not be read/)
    expect(localStorage.getItem(storageKey)).toBe('{broken')
    expect(screen.getByRole('button', { name: 'Add stock item' })).toBeDisabled()
  })
})

describe('stock recovery outside current manager access', () => {
  it('recovers the original actor saved result without loading current branch stock', async () => {
    await saveStockRequest(actorId, countCommand)
    apply(countCommand)
    render(<PendingStockRecovery />)
    fireEvent.click(await screen.findByRole('button', { name: 'Check saved stock work' }))
    await screen.findByText(/original stock request was confirmed as saved/)
    expect(readStockRequest(actorId, branchId, deviceId)).toBeNull()
    expect(commands).toHaveLength(0)
    expect(
      vi.mocked(fetch).mock.calls.some((call) => String(call[0]).includes('/inventory?'))
    ).toBe(false)
  })

  it('never reads another actor values and keeps another counter request visible', async () => {
    localStorage.setItem(
      `pos-stock-request:${id(99)}:${branchId}:${deviceId}`,
      'private-invalid-other-staff-value'
    )
    const otherCounter = { ...countCommand, deviceId: id(88) }
    await saveStockRequest(actorId, otherCounter)
    expect(readStockRequests(actorId)).toEqual([otherCounter])
    render(
      <PendingStockRecovery
        actorId={actorId}
        excludeBranchId={branchId}
        excludeDeviceId={deviceId}
      />
    )
    expect(
      await screen.findByRole('button', { name: 'Check saved stock work' })
    ).toBeInTheDocument()
    expect(screen.queryByText(/Saved stock work could not be checked/)).not.toBeInTheDocument()
  })

  it('rechecks the account before recovery and preserves work if the signed-in actor changed', async () => {
    await saveStockRequest(actorId, countCommand)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ userId: id(99) }))
    )
    render(<PendingStockRecovery actorId={actorId} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Check saved stock work' }))
    await screen.findByText(/saved stock request could not be confirmed/)
    expect(readStockRequest(actorId, branchId, deviceId)).toEqual(countCommand)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })
})
