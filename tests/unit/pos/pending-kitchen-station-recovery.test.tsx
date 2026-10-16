import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const journal = vi.hoisted(() => ({
  config: vi.fn(),
  work: vi.fn(),
  configAck: vi.fn(),
  workAck: vi.fn(),
}))
vi.mock('@/lib/pos/kitchen-station-journal', () => ({
  readPendingStationRequests: journal.config,
  acknowledgeStationRequest: journal.configAck,
  savePendingStationRequest: vi.fn(),
  stationJournalEvent: 'config-event',
}))
vi.mock('@/lib/pos/kitchen-station-work-journal', () => ({
  readPendingStationWorkRequests: journal.work,
  acknowledgeStationWorkRequest: journal.workAck,
  savePendingStationWorkRequest: vi.fn(),
  stationWorkJournalEvent: 'work-event',
}))
import PendingKitchenStationRecovery from '@/components/pos/kitchen-stations/PendingKitchenStationRecovery'
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`
const actor = id(1)
const config = {
  actorId: actor,
  command: {
    id: id(2),
    branchId: id(3),
    deviceId: id(4),
    expectedRevision: 1,
    type: 'station.save',
    station: { id: id(5), name: 'Grill', active: true },
  },
}
const work = {
  actorId: actor,
  command: {
    id: id(6),
    branchId: id(7),
    deviceId: id(8),
    workId: id(9),
    expectedRevision: 1,
    type: 'stage',
    from: 'queued',
    to: 'preparing',
    reason: null,
  },
}
const response = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const cancelled = (command: typeof config.command | typeof work.command) => ({
  status: 'cancelled',
  requestId: command.id,
  branchId: command.branchId,
  replayed: false,
  ...('workId' in command ? { workId: command.workId } : {}),
})
const fetcher = vi.fn()
beforeEach(() => {
  vi.resetAllMocks()
  journal.config.mockImplementation(async (who) => (who === actor ? [config] : []))
  journal.work.mockImplementation(async (who) => (who === actor ? [work] : []))
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/pos/session') return response({ status: 'authenticated', userId: actor })
    if (init?.method === 'POST' && url.endsWith('/recovery'))
      return response(cancelled(JSON.parse(init.body as string)))
    throw new Error('No bootstrap, menu, station or work reads are allowed')
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('discovers identity without bootstrap and recovers both original branches/devices with real wrappers', async () => {
  render(<PendingKitchenStationRecovery />)
  fireEvent.click(await screen.findByRole('button', { name: 'Check saved request' }))
  await waitFor(() =>
    expect(journal.configAck).toHaveBeenCalledWith(actor, config.command, cancelled(config.command))
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Check saved action' }))
  await waitFor(() =>
    expect(journal.workAck).toHaveBeenCalledWith(actor, work.command, cancelled(work.command))
  )
  expect(
    fetcher.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([, init]) => JSON.parse(init.body))
  ).toEqual([config.command, work.command])
  expect(
    fetcher.mock.calls.every(
      ([url, init]) =>
        url === '/api/pos/session' || (init?.method === 'POST' && url.endsWith('/recovery'))
    )
  ).toBe(true)
  expect(screen.queryByRole('button', { name: 'Add station' })).not.toBeInTheDocument()
})
it('needs no manager role or current branch and never duplicates another original branch pending row', async () => {
  journal.config.mockResolvedValue([
    config,
    { ...config, command: { ...config.command, id: id(20), branchId: id(21) } },
  ])
  render(<PendingKitchenStationRecovery actorId={actor} />)
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'Check saved request' })).toHaveLength(2)
  )
  expect(screen.getAllByRole('button', { name: 'Check saved action' })).toHaveLength(1)
  expect(fetcher).not.toHaveBeenCalled()
})
it('excludes only matching mounted branch panels while preserving other branch recovery', async () => {
  render(
    <PendingKitchenStationRecovery
      actorId={actor}
      excludeConfigurationBranchId={config.command.branchId}
      excludeWorkBranchId={id(99)}
    />
  )
  await screen.findByRole('button', { name: 'Check saved action' })
  expect(screen.queryByRole('button', { name: 'Check saved request' })).not.toBeInTheDocument()
})
it('rejects malformed authenticated identity and unavailable storage without showing success', async () => {
  fetcher.mockResolvedValue(response({ status: 'authenticated', userId: actor, role: 'manager' }))
  render(<PendingKitchenStationRecovery />)
  await screen.findByRole('alert')
  expect(journal.config).not.toHaveBeenCalled()
  fetcher.mockResolvedValue(response({ status: 'authenticated', userId: actor }))
  journal.config.mockRejectedValue(new Error('blocked IDB'))
  fireEvent.click(screen.getByRole('button', { name: 'Check saved kitchen requests' }))
  await waitFor(() => expect(journal.config).toHaveBeenCalled())
  expect(screen.queryByRole('button', { name: 'Check saved action' })).not.toBeInTheDocument()
})
it('does not clear original saved request on a late ACK after account change', async () => {
  let complete!: (value: Response) => void
  fetcher.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve
      })
  )
  const view = render(<PendingKitchenStationRecovery actorId={actor} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Check saved request' }))
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  view.rerender(<PendingKitchenStationRecovery actorId={id(100)} />)
  await act(async () => {
    complete(response(cancelled(config.command)))
  })
  expect(journal.configAck).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Check saved request' })).not.toBeInTheDocument()
})
it('ignores old identity discovery after a supplied account replaces it', async () => {
  let complete!: (value: Response) => void
  fetcher.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve
      })
  )
  const view = render(<PendingKitchenStationRecovery />)
  view.rerender(<PendingKitchenStationRecovery actorId={id(100)} />)
  await act(async () => {
    complete(response({ status: 'authenticated', userId: actor }))
  })
  expect(journal.config).not.toHaveBeenCalledWith(actor)
  expect(screen.queryByRole('button', { name: 'Check saved request' })).not.toBeInTheDocument()
})
