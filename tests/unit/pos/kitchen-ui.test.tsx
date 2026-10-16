import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within, act } from '@testing-library/react'
import KitchenBoard, { KitchenPendingRecovery } from '@/components/pos/kitchen/KitchenBoard'
import type { KitchenCommand, KitchenTicket } from '@/lib/pos/server/kitchen'
const journal = vi.hoisted(() => ({
  records: [] as Array<{ actorId: string; command: KitchenCommand }>,
  fail: false,
}))
vi.mock('@/lib/pos/kitchen-journal', () => ({
  kitchenJournalEvent: 'pos-kitchen-journal-changed',
  readPendingKitchenRequests: vi.fn(async (actor: string) =>
    journal.records.filter((record) => record.actorId === actor)
  ),
  savePendingKitchenRequest: vi.fn(async (record: { actorId: string; command: KitchenCommand }) => {
    if (
      journal.fail ||
      journal.records.some(
        (item) =>
          item.actorId === record.actorId && item.command.branchId === record.command.branchId
      )
    )
      throw new Error('storage')
    journal.records.push(structuredClone(record))
  }),
  acknowledgeKitchenRequest: vi.fn(async (actor: string, branch: string, id: string) => {
    const found = journal.records.find(
      (record) => record.actorId === actor && record.command.branchId === branch
    )
    if (found && found.command.id !== id) throw new Error('wrong request')
    journal.records = journal.records.filter((record) => record !== found)
  }),
}))
const branch = '10000000-0000-4000-8000-000000000001',
  device = '20000000-0000-4000-8000-000000000001',
  actor = '30000000-0000-4000-8000-000000000001'
const ticket: KitchenTicket = {
  orderId: '40000000-0000-4000-8000-000000000001',
  branchId: branch,
  invoiceId: '50000000-0000-4000-8000-000000000001',
  invoiceNumber: 'BD-2026-001',
  issuedAt: '2026-10-16T04:00:00Z',
  updatedAt: '2026-10-16T04:00:00Z',
  serviceType: 'takeaway',
  status: 'queued',
  revision: 1,
  refundedAt: null,
  lines: [
    {
      lineNumber: 1,
      productId: '60000000-0000-4000-8000-000000000001',
      name: 'Kaju Katli',
      unit: 'kg',
      quantityMilli: 250,
    },
  ],
}
const list = {
  status: 'ready',
  organizationId: '70000000-0000-4000-8000-000000000001',
  branchId: branch,
  actorRole: 'manager',
  generatedAt: '2026-10-16T04:05:00Z',
  activeTickets: [ticket],
  terminalTickets: [],
  activeCount: 1,
  activeCounts: { queued: 1, preparing: 0, ready: 0 },
  activeNextCursor: null,
  terminalTruncated: false,
}
const command: KitchenCommand = {
  id: '80000000-0000-4000-8000-000000000001',
  branchId: branch,
  deviceId: device,
  orderId: ticket.orderId,
  expectedRevision: 1,
  status: 'preparing',
  reason: null,
}
const props = {
  actorId: actor,
  branchId: branch,
  branchName: 'Test Bur Dubai',
  deviceId: device,
  disabled: false,
}
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const ack = (c: KitchenCommand) => ({
  status: 'updated',
  requestId: c.id,
  replayed: false,
  ticket: { ...ticket, status: c.status, revision: c.expectedRevision + 1 },
})
beforeEach(() => {
  journal.records = []
  journal.fail = false
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('shows paid scope, weight units, state counts and exact confirmed change', async () => {
  const sent: KitchenCommand[] = []
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
  render(<KitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Start preparing' }))
  await screen.findByText(/Kitchen change confirmed/)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ ...command, id: expect.any(String) })
  expect(journal.records).toHaveLength(0)
  expect(screen.getByText(/Orders paid without prior kitchen dispatch/)).toBeInTheDocument()
  expect(screen.getByText('kg')).toBeInTheDocument()
})
it('retains uncertain request and retries the exact ID and body', async () => {
  const sent: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      if (options?.method === 'POST') {
        sent.push(JSON.parse(options.body))
        return response({}, 503)
      }
      return response(list)
    })
  )
  render(<KitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Start preparing' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry saved kitchen change' }))
  await waitFor(() => expect(sent).toHaveLength(2))
  expect(sent[1]).toEqual(sent[0])
  expect(journal.records).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Start preparing' })).toBeDisabled()
})
it('requires explicit cancellation and keeps a mismatching cancellation response', async () => {
  journal.records = [{ actorId: actor, command }]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) =>
      options?.method === 'POST'
        ? response({ status: 'cancelled', requestId: ticket.orderId, replayed: false })
        : response(list)
    )
  )
  render(<KitchenBoard {...props} />)
  const cancel = await screen.findByRole('button', { name: 'Check or cancel saved change' })
  expect(cancel).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(cancel)
  await screen.findByRole('alert')
  expect(journal.records).toHaveLength(1)
})
it('recovers original device command after replacement and clears only matching ACK', async () => {
  journal.records = [{ actorId: actor, command }]
  const sent: KitchenCommand[] = []
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
  render(<KitchenBoard {...props} deviceId="90000000-0000-4000-8000-000000000001" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Retry saved kitchen change' }))
  await screen.findByText(/Kitchen change confirmed/)
  expect(sent[0]).toEqual(command)
  expect(journal.records).toHaveLength(0)
})
it('storage failure prevents any network mutation', async () => {
  journal.fail = true
  const fetcher = vi.fn(async () => response(list))
  vi.stubGlobal('fetch', fetcher)
  render(<KitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Start preparing' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('no new request was sent')
  expect(
    fetcher.mock.calls.some((call: unknown[]) => (call[1] as RequestInit)?.method === 'POST')
  ).toBe(false)
})
it('retains last confirmed tickets when refresh fails and disables actions', async () => {
  let fail = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => (fail ? response({}, 503) : response(list)))
  )
  render(<KitchenBoard {...props} />)
  await screen.findByText(ticket.invoiceNumber)
  fail = true
  fireEvent.click(screen.getByRole('button', { name: 'Refresh tickets' }))
  await screen.findByRole('alert')
  expect(screen.getByText(ticket.invoiceNumber)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Start preparing' })).toBeDisabled()
  expect(screen.queryByText('No active paid orders in this branch.')).toBeNull()
})
it('never renders a foreign branch response', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ ...list, branchId: device }))
  )
  render(<KitchenBoard {...props} />)
  await screen.findByRole('alert')
  expect(screen.queryByText(ticket.invoiceNumber)).toBeNull()
})
it('requires served confirmation and cashier has no correction controls', async () => {
  const ready = { ...ticket, status: 'ready' }
  const fetcher = vi.fn(async (_url, options) =>
    options?.method === 'POST'
      ? response(ack(JSON.parse(options.body)))
      : response({
          ...list,
          actorRole: 'cashier',
          activeTickets: [ready],
          activeCounts: { queued: 0, preparing: 0, ready: 1 },
        })
  )
  vi.stubGlobal('fetch', fetcher)
  render(<KitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Mark served' }))
  expect(fetcher.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false)
  expect(screen.queryByRole('button', { name: /Correct to/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm served' }))
  await screen.findByText(/Kitchen change confirmed/)
})
it('manager correction requires a reason and keeps the exact prior revision', async () => {
  const sent: KitchenCommand[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      if (options?.method === 'POST') {
        const c = JSON.parse(options.body)
        sent.push(c)
        return response(ack(c))
      }
      return response({
        ...list,
        activeTickets: [{ ...ticket, status: 'preparing', revision: 2 }],
        activeCounts: { queued: 0, preparing: 1, ready: 0 },
      })
    })
  )
  render(<KitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Correct to queued' }))
  expect(screen.getByRole('button', { name: 'Save correction' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Reason for correction'), {
    target: { value: 'Started wrong ticket' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save correction' }))
  await screen.findByText(/Kitchen change confirmed/)
  expect(sent[0]).toMatchObject({
    status: 'queued',
    expectedRevision: 2,
    reason: 'Started wrong ticket',
  })
})
it('shows cancelled refund ticket with no advance or correction action', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response({
        ...list,
        activeTickets: [],
        activeCount: 0,
        activeCounts: { queued: 0, preparing: 0, ready: 0 },
        terminalTickets: [{ ...ticket, status: 'cancelled', refundedAt: ticket.issuedAt }],
      })
    )
  )
  render(<KitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Served & cancelled' }))
  const card = screen.getByRole('article', { name: `Order ${ticket.invoiceNumber}` })
  expect(within(card).getByText(/Stop preparation/)).toBeInTheDocument()
  expect(within(card).queryByRole('button')).toBeNull()
})
it('pagination preserves full counts and replaces rather than appends the prior page', async () => {
  const nextTicket = { ...ticket, orderId: device, invoiceNumber: 'BD-2026-002' }
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      urls.push(String(url))
      return response(
        String(url).includes('afterOrderId')
          ? {
              ...list,
              activeTickets: [nextTicket],
              activeCount: 2,
              activeCounts: { queued: 2, preparing: 0, ready: 0 },
            }
          : {
              ...list,
              activeCount: 2,
              activeCounts: { queued: 2, preparing: 0, ready: 0 },
              activeNextCursor: { issuedAt: ticket.issuedAt, orderId: ticket.orderId },
            }
      )
    })
  )
  render(<KitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Next page' }))
  await screen.findByText(nextTicket.invoiceNumber)
  expect(screen.queryByText(ticket.invoiceNumber)).toBeNull()
  expect(screen.getByRole('button', { name: 'Active (2)' })).toBeInTheDocument()
  expect(urls[1]).toContain('afterOrderId=')
})
it('late read response cannot replace the board after a mutation starts', async () => {
  let resolveRead: ((response: Response) => void) | undefined,
    reads = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      if (options?.method === 'POST') return response(ack(JSON.parse(options.body)))
      reads++
      if (reads === 2)
        return new Promise<Response>((resolve) => {
          resolveRead = resolve
        })
      return response(list)
    })
  )
  render(<KitchenBoard {...props} />)
  await screen.findByText(ticket.invoiceNumber)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh tickets' }))
  expect(screen.getByRole('button', { name: 'Start preparing' })).toBeDisabled()
  await act(async () => resolveRead?.(response({ ...list, branchId: device })))
  await screen.findByRole('alert')
  expect(screen.getByText(ticket.invoiceNumber)).toBeInTheDocument()
})
it('standalone recovery discovers only authenticated actor records without loading a board', async () => {
  journal.records = [
    { actorId: actor, command },
    { actorId: device, command: { ...command, id: device } },
  ]
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
  render(<KitchenPendingRecovery />)
  await screen.findByRole('button', { name: 'Retry saved kitchen change' })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Check or cancel saved change' }))
  await waitFor(() => expect(journal.records).toHaveLength(1))
  expect(journal.records[0].actorId).toBe(device)
  expect(urls).toEqual(['/api/pos/session', '/api/pos/kitchen/recovery'])
})
it('a late polling response cannot override a newer board after recovery confirms a write', async () => {
  journal.records = [{ actorId: actor, command }]
  let reads = 0,
    finishOld: ((value: Response) => void) | undefined
  const newer = {
    ...list,
    activeTickets: [{ ...ticket, status: 'preparing', revision: 2 }],
    activeCounts: { queued: 0, preparing: 1, ready: 0 },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      if (options?.method === 'POST') return response(ack(JSON.parse(options.body)))
      reads++
      if (reads === 2)
        return new Promise<Response>((resolve) => {
          finishOld = resolve
        })
      return response(reads > 2 ? newer : list)
    })
  )
  render(<KitchenBoard {...props} />)
  await screen.findByText(ticket.invoiceNumber)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh tickets' }))
  fireEvent.click(screen.getByRole('button', { name: 'Retry saved kitchen change' }))
  await screen.findByRole('button', { name: 'Mark ready' })
  await act(async () => finishOld?.(response(list)))
  expect(screen.getByRole('button', { name: 'Mark ready' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Start preparing' })).toBeNull()
})
it('desired state in a later GET cannot clear a pending request with a mismatched ACK', async () => {
  let reads = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      if (options?.method === 'POST')
        return response({ ...ack(JSON.parse(options.body)), requestId: device })
      reads++
      return response(
        reads === 1
          ? list
          : {
              ...list,
              activeTickets: [{ ...ticket, status: 'preparing', revision: 2 }],
              activeCounts: { queued: 0, preparing: 1, ready: 0 },
            }
      )
    })
  )
  render(<KitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Start preparing' }))
  const button = await screen.findByRole('button', { name: 'Mark ready' })
  expect(button).toBeDisabled()
  expect(journal.records).toHaveLength(1)
})
it('refresh polling runs only while visible and never overlaps an in-flight read', async () => {
  vi.useFakeTimers()
  let resolveRead: ((value: Response) => void) | undefined
  const fetcher = vi.fn(
    async () =>
      new Promise<Response>((resolve) => {
        resolveRead = resolve
      })
  )
  vi.stubGlobal('fetch', fetcher)
  const visible = vi.spyOn(document, 'visibilityState', 'get')
  visible.mockReturnValue('visible')
  try {
    render(<KitchenBoard {...props} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000)
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveRead?.(response(list))
    })
    visible.mockReturnValue('hidden')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000)
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    visible.mockReturnValue('visible')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => {
      resolveRead?.(response(list))
    })
  } finally {
    vi.useRealTimers()
  }
})
it('cross-tab journal notification locks the board and exposes original saved request', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(list))
  )
  render(<KitchenBoard {...props} />)
  await screen.findByRole('button', { name: 'Start preparing' })
  journal.records = [{ actorId: actor, command }]
  await act(async () => {
    window.dispatchEvent(new Event('pos-kitchen-journal-changed'))
  })
  expect(screen.getByRole('button', { name: 'Start preparing' })).toBeDisabled()
  expect(screen.getByText(`Request ${command.id}`)).toBeInTheDocument()
})
it('a new pending request requires fresh cancellation consent', async () => {
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
  render(<KitchenBoard {...props} />)
  fireEvent.click(await screen.findByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Check or cancel saved change' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start preparing' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Start preparing' }))
  expect(await screen.findByRole('checkbox')).not.toBeChecked()
  expect(screen.getByRole('button', { name: 'Check or cancel saved change' })).toBeDisabled()
})
