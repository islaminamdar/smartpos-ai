import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const journal = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), ack: vi.fn() }))
vi.mock('@/lib/pos/kitchen-station-journal', () => ({
  readPendingStationRequests: journal.read,
  savePendingStationRequest: journal.save,
  acknowledgeStationRequest: journal.ack,
  stationJournalEvent: 'station-test-event',
}))
import KitchenStationManager, {
  KitchenStationPendingRecovery,
} from '@/components/pos/kitchen-stations/KitchenStationManager'
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`
const props = {
  actorId: id(1),
  branchId: id(2),
  deviceId: id(3),
  role: 'manager' as const,
  disabled: false,
}
const stamp = '2026-10-16T00:00:00Z'
const station = { id: id(4), name: 'Grill', active: true, createdAt: stamp, updatedAt: stamp }
const product = {
  id: id(5),
  branchId: props.branchId,
  name: 'Chicken skewer',
  category: 'Grill',
  imageUrl: null,
  unit: 'piece',
  unitPriceFils: 1000,
  taxRateBps: 500,
  active: true,
  revision: 1,
}
const snapshot = {
  status: 'ready',
  organizationId: id(6),
  branchId: props.branchId,
  actorRole: 'manager',
  revision: 1,
  generatedAt: stamp,
  stations: [station],
  routes: [],
  routeCount: 0,
  nextProductId: null,
}
const command = {
  id: id(7),
  branchId: props.branchId,
  deviceId: props.deviceId,
  expectedRevision: 1,
  type: 'station.save',
  station: { id: id(8), name: 'Cold kitchen', active: true },
}
const pending = { actorId: props.actorId, command }
const cancelled = {
  status: 'cancelled',
  requestId: command.id,
  branchId: command.branchId,
  replayed: false,
}
let records: (typeof pending)[] = []
const fetcher = vi.fn()
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  vi.resetAllMocks()
  records = []
  journal.read.mockImplementation(async () => records)
  journal.save.mockImplementation(async (record) => {
    records = [record]
  })
  journal.ack.mockImplementation(async () => {
    records = []
  })
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return response({ status: 'unavailable' }, 503)
    return response(
      url.includes('/catalogue') ? { status: 'ready', products: [product] } : snapshot
    )
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
async function ready() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add station' })).toBeDisabled())
  await screen.findByText('1 active station · 0 assigned products')
}
it('shows authentic menu and candidate future-work policy with accessible controls', async () => {
  render(<KitchenStationManager {...props} />)
  await ready()
  expect(screen.getByText('Station setup')).toBeInTheDocument()
  expect(screen.getByText(/Assignments apply to newly sent work/)).toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'Chicken skewer' })).toBeInTheDocument()
  expect(screen.getByLabelText('Prepare at')).toBeDisabled()
})
it('persists before HTTP and keeps exact uncertain command for explicit recovery', async () => {
  render(<KitchenStationManager {...props} />)
  await ready()
  fireEvent.change(screen.getByLabelText('New station name'), { target: { value: 'Cold kitchen' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add station' }))
  await screen.findByRole('button', { name: 'Check saved request' })
  const saved = journal.save.mock.calls[0][0]
  const post = fetcher.mock.calls.find(([, options]) => options?.method === 'POST')!
  expect(JSON.parse(post[1].body as string)).toEqual(saved.command)
  expect(post[1].headers['x-pos-actor']).toBe(props.actorId)
  expect(journal.save.mock.invocationCallOrder[0]).toBeLessThan(
    fetcher.mock.invocationCallOrder[fetcher.mock.calls.indexOf(post)]
  )
  expect(journal.ack).not.toHaveBeenCalled()
  fetcher.mockImplementation(async (url: string, options?: RequestInit) =>
    options?.method === 'POST'
      ? response({
          status: 'cancelled',
          requestId: saved.command.id,
          branchId: props.branchId,
          replayed: false,
        })
      : response(url.includes('/catalogue') ? { status: 'ready', products: [product] } : snapshot)
  )
  fireEvent.click(screen.getByRole('button', { name: 'Check saved request' }))
  await waitFor(() =>
    expect(journal.ack).toHaveBeenCalledWith(
      props.actorId,
      saved.command,
      expect.objectContaining({ status: 'cancelled' })
    )
  )
  expect(
    fetcher.mock.calls.filter(([url, opts]) => url.endsWith('/recovery') && opts?.method === 'POST')
  ).toHaveLength(1)
})
it('never sends a write when local durable storage fails', async () => {
  journal.save.mockRejectedValue(new Error('disk'))
  render(<KitchenStationManager {...props} />)
  await ready()
  fireEvent.change(screen.getByLabelText('New station name'), { target: { value: 'Cold kitchen' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add station' }))
  await screen.findByText(/The change was not sent/)
  expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})
it('blocks unreadable journal without interpreting it as an empty queue', async () => {
  journal.read.mockRejectedValue(new Error('corrupt'))
  render(<KitchenStationManager {...props} />)
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'Add station' })).toBeDisabled()
  expect(fetcher).not.toHaveBeenCalled()
})
it('retains pending request on mismatched ACK including a same-ID wrong station', async () => {
  records = [pending]
  fetcher.mockImplementation(async (url: string, options?: RequestInit) =>
    options?.method === 'POST'
      ? response({
          status: 'applied',
          requestId: command.id,
          branchId: props.branchId,
          replayed: true,
          revision: 2,
          station: { ...station, id: command.station.id, name: 'Wrong' },
          route: null,
        })
      : response(url.includes('/catalogue') ? { status: 'ready', products: [product] } : snapshot)
  )
  render(<KitchenStationManager {...props} />)
  await screen.findByRole('button', { name: 'Check saved request' })
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Check saved request' })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Check saved request' }))
  await screen.findByText(/This change is not confirmed/)
  expect(journal.ack).not.toHaveBeenCalled()
  expect(records).toEqual([pending])
})
it('allows demoted staff to recover original request but does not expose configuration editing', async () => {
  records = [pending]
  fetcher.mockResolvedValue(response(cancelled))
  render(<KitchenStationManager {...props} role="cashier" />)
  const recover = await screen.findByRole('button', { name: 'Check saved request' })
  fireEvent.click(recover)
  await waitFor(() => expect(journal.ack).toHaveBeenCalled())
  expect(screen.queryByRole('button', { name: 'Add station' })).not.toBeInTheDocument()
  expect(fetcher.mock.calls).toHaveLength(1)
  expect(fetcher.mock.calls[0][0]).toBe('/api/pos/kitchen-stations/recovery')
})
it('honors returned demoted role and hides the manager editor', async () => {
  fetcher.mockResolvedValue(response({ ...snapshot, actorRole: 'cashier' }))
  render(<KitchenStationManager {...props} />)
  await waitFor(() =>
    expect(screen.queryByRole('heading', { name: 'Kitchen stations' })).not.toBeInTheDocument()
  )
  expect(fetcher.mock.calls.some(([url]) => url.includes('/catalogue'))).toBe(false)
})
it('preserves old device on recovery but refuses a different branch request', async () => {
  records = [{ ...pending, command: { ...command, branchId: id(99) } }]
  render(<KitchenStationManager {...props} />)
  expect(await screen.findByText(/Return to the original branch/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Check saved request' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Add station' })).toBeDisabled()
})
it('ignores late account response and never acknowledges its saved request', async () => {
  records = [pending]
  let resolve!: (value: Response) => void
  const delayed = new Promise<Response>((r) => (resolve = r))
  fetcher.mockImplementation(async (url: string, options?: RequestInit) =>
    options?.method === 'POST'
      ? delayed
      : response(url.includes('/catalogue') ? { status: 'ready', products: [product] } : snapshot)
  )
  const view = render(<KitchenStationManager {...props} />)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Check saved request' })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Check saved request' }))
  records = []
  view.rerender(<KitchenStationManager {...props} actorId={id(90)} role="cashier" />)
  await act(async () => resolve(response(cancelled)))
  expect(journal.ack).not.toHaveBeenCalled()
  expect(screen.queryByText(/Station configuration saved/)).not.toBeInTheDocument()
})
it('invalidates in-flight result across disabled/re-enabled lifecycle', async () => {
  records = [pending]
  let resolve!: (value: Response) => void
  const delayed = new Promise<Response>((r) => (resolve = r))
  fetcher.mockImplementation(async (url: string, options?: RequestInit) =>
    options?.method === 'POST'
      ? delayed
      : response(url.includes('/catalogue') ? { status: 'ready', products: [product] } : snapshot)
  )
  const view = render(<KitchenStationManager {...props} />)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Check saved request' })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Check saved request' }))
  view.rerender(<KitchenStationManager {...props} disabled />)
  view.rerender(<KitchenStationManager {...props} />)
  await act(async () => resolve(response(cancelled)))
  expect(journal.ack).not.toHaveBeenCalled()
  expect(records).toEqual([pending])
})
it('rejects mixed pagination revisions and retains unavailable rather than partial assignments', async () => {
  const routes = Array.from({ length: 100 }, (_, n) => ({
    productId: id(n + 100),
    stationId: station.id,
  }))
  fetcher.mockImplementation(async (url: string) =>
    response(
      url.includes('afterProductId')
        ? {
            ...snapshot,
            revision: 3,
            routes: [{ productId: id(200), stationId: station.id }],
            routeCount: 101,
          }
        : { ...snapshot, routes, routeCount: 101, nextProductId: id(199) }
    )
  )
  render(<KitchenStationManager {...props} />)
  await screen.findByText(/Stations could not be verified/)
  expect(screen.getByRole('button', { name: 'Add station' })).toBeDisabled()
  expect(fetcher.mock.calls).toHaveLength(2)
})
it('loads every route page before enabling edits and uses General as an explicit clear', async () => {
  const routes = Array.from({ length: 100 }, (_, n) => ({
    productId: id(n + 100),
    stationId: station.id,
  }))
  const products = Array.from({ length: 101 }, (_, n) => ({
    ...product,
    id: id(n + 100),
    name: `Dish ${n}`,
  }))
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return response({}, 503)
    if (url.includes('/catalogue')) return response({ status: 'ready', products })
    return response(
      url.includes('afterProductId')
        ? { ...snapshot, routes: [{ productId: id(200), stationId: station.id }], routeCount: 101 }
        : { ...snapshot, routes, routeCount: 101, nextProductId: id(199) }
    )
  })
  render(<KitchenStationManager {...props} />)
  await screen.findByText('1 active station · 101 assigned products')
  fireEvent.change(screen.getByLabelText('Menu item'), { target: { value: id(200) } })
  fireEvent.change(screen.getByLabelText('Prepare at'), { target: { value: '' } })
  expect(screen.getByLabelText('Menu item')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Save product assignment' }))
  await waitFor(() => expect(journal.save).toHaveBeenCalled())
  expect(journal.save.mock.calls[0][0].command).toMatchObject({
    type: 'route.set',
    productId: id(200),
    stationId: null,
    expectedRevision: 1,
  })
})
it('reports dirty edits and prevents refresh from discarding them', async () => {
  const onBlockedChange = vi.fn()
  render(<KitchenStationManager {...props} onBlockedChange={onBlockedChange} />)
  await ready()
  fireEvent.change(screen.getByLabelText('New station name'), { target: { value: 'Cold kitchen' } })
  expect(screen.getByRole('button', { name: 'Refresh configuration' })).toBeDisabled()
  expect(onBlockedChange).toHaveBeenLastCalledWith(true)
  fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved edits' }))
  expect(onBlockedChange).toHaveBeenLastCalledWith(false)
})
it('demotion during a pending read releases the parent guard when there is no saved work', async () => {
  let resolve!: (value: Response) => void
  fetcher.mockImplementation(() => new Promise<Response>((r) => (resolve = r)))
  const onBlockedChange = vi.fn()
  const view = render(<KitchenStationManager {...props} onBlockedChange={onBlockedChange} />)
  await waitFor(() => expect(fetcher).toHaveBeenCalled())
  view.rerender(
    <KitchenStationManager {...props} role="cashier" onBlockedChange={onBlockedChange} />
  )
  await waitFor(() => expect(onBlockedChange).toHaveBeenLastCalledWith(false))
  await act(async () => resolve(response(snapshot)))
  expect(onBlockedChange).toHaveBeenLastCalledWith(false)
  expect(screen.queryByRole('heading', { name: 'Kitchen stations' })).not.toBeInTheDocument()
})
it('recovery-only panel works without a registered device and never reads the current menu', async () => {
  records = [pending]
  fetcher.mockResolvedValue(response(cancelled))
  render(
    <KitchenStationPendingRecovery
      actorId={props.actorId}
      branchId={props.branchId}
      disabled={false}
    />
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Check saved request' }))
  await waitFor(() => expect(journal.ack).toHaveBeenCalledWith(props.actorId, command, cancelled))
  expect(fetcher.mock.calls).toHaveLength(1)
  expect(fetcher.mock.calls[0][0]).toBe('/api/pos/kitchen-stations/recovery')
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(command)
})
