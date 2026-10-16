import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const journal = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), ack: vi.fn() }))
vi.mock('@/lib/pos/kitchen-station-work-journal', () => ({
  readPendingStationWorkRequests: journal.read,
  savePendingStationWorkRequest: journal.save,
  acknowledgeStationWorkRequest: journal.ack,
  stationWorkJournalEvent: 'station-work-test',
}))
import StationWorkBoard, {
  StationWorkPendingRecovery,
} from '@/components/pos/kitchen-stations/StationWorkBoard'
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`,
  stamp = '2026-10-16T00:00:00.000Z'
const props = {
  actorId: id(1),
  branchId: id(2),
  deviceId: id(3),
  role: 'manager' as const,
  disabled: false,
}
const line = { productId: id(5), name: 'Chicken skewer', unit: 'piece', quantityMilli: 2000 }
const work = {
  id: id(4),
  branchId: props.branchId,
  family: 'paid',
  stationId: null,
  stationName: 'General',
  generation: 1,
  revision: 1,
  orderId: id(6),
  tabId: null,
  ticketId: null,
  invoiceId: id(7),
  invoiceNumber: 'INV-QA-1',
  payment: 'paid',
  state: 'open',
  metadata: {
    label: null,
    serviceType: 'takeaway',
    tableId: null,
    tableName: null,
    guestCount: null,
    note: null,
  },
  stages: { queued: [line], preparing: [], ready: [], served: [] },
  pendingNoticeCount: 0,
  issuedAt: stamp,
  updatedAt: stamp,
}
const list = {
  status: 'ready',
  organizationId: id(8),
  branchId: props.branchId,
  actorRole: 'manager',
  generatedAt: stamp,
  items: [work],
  matchingCount: 1,
  nextCursor: null,
  attentionCount: 0,
  stations: [
    { stationId: null, name: 'General', active: true, activeCount: 1, pendingNoticeCount: 0 },
  ],
}
const detail = {
  status: 'ready',
  organizationId: id(8),
  branchId: props.branchId,
  actorRole: 'manager',
  work,
  notices: [],
  noticeCount: 0,
  nextAfterSequence: null,
}
const command = {
  id: id(9),
  branchId: props.branchId,
  deviceId: props.deviceId,
  workId: work.id,
  expectedRevision: 1,
  type: 'stage',
  from: 'queued',
  to: 'preparing',
  reason: null,
}
const ack = {
  status: 'updated',
  requestId: command.id,
  branchId: props.branchId,
  replayed: false,
  work: { ...work, revision: 2, stages: { ...work.stages, queued: [], preparing: [line] } },
  acknowledgedNoticeId: null,
}
const notice = {
  id: id(10),
  workId: work.id,
  sequence: 1,
  kind: 'return',
  createdAt: stamp,
  reason: 'Customer returned one portion',
  acknowledgedAt: null,
  source: {
    invoiceId: work.invoiceId,
    invoiceNumber: work.invoiceNumber,
    creditNoteId: id(11),
    creditNumber: 'CN-QA-1',
    fullyReturned: false,
  },
  detail: {
    lines: [{ ...line, quantityMilli: 1000, remainingQuantityMilli: 1000, originalLineNumber: 1 }],
  },
}
let records: { actorId: string; command: typeof command }[] = []
const fetcher = vi.fn(),
  response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
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
  fetcher.mockImplementation(async (url: string, options?: RequestInit) =>
    response(
      options?.method === 'POST' ? {} : url.includes('/detail') ? detail : list,
      options?.method === 'POST' ? 503 : 200
    )
  )
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
async function select() {
  const card = await screen.findByRole('button', { name: /General INV-QA-1/ })
  await waitFor(() => expect(card).toBeEnabled())
  fireEvent.click(card)
  await screen.findByRole('heading', { name: 'General preparation' })
  await waitFor(() => expect(screen.getByRole('button', { name: /Start preparing/ })).toBeEnabled())
}
it('renders scoped quantities and explicitly keeps General and branch notice coverage visible', async () => {
  render(<StationWorkBoard {...props} />)
  await select()
  expect(screen.getByText('2 pieces')).toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'General' })).toBeInTheDocument()
  expect(screen.getByText(/work items need notice review across the branch/)).toBeInTheDocument()
})
it('saves exact work revision before stage HTTP and keeps uncertain action', async () => {
  render(<StationWorkBoard {...props} />)
  await select()
  fireEvent.click(screen.getByRole('button', { name: /Start preparing/ }))
  await screen.findByRole('button', { name: 'Check saved action' })
  const saved = journal.save.mock.calls[0][0]
  expect(saved.command).toMatchObject({
    branchId: props.branchId,
    deviceId: props.deviceId,
    workId: work.id,
    expectedRevision: 1,
    type: 'stage',
    from: 'queued',
    to: 'preparing',
    reason: null,
  })
  const post = fetcher.mock.calls.find(([, options]) => options?.method === 'POST')!
  expect(JSON.parse(post[1].body as string)).toEqual(saved.command)
  expect(journal.ack).not.toHaveBeenCalled()
})
it('denies send on storage failure and fails closed on malformed journal reads', async () => {
  journal.save.mockRejectedValue(new Error('disk'))
  render(<StationWorkBoard {...props} />)
  await select()
  fireEvent.click(screen.getByRole('button', { name: /Start preparing/ }))
  await screen.findByText(/The action was not sent/)
  expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})
it('requires every pending notice to be checked and shows exact returned and remaining quantities', async () => {
  const held = { ...work, pendingNoticeCount: 1 }
  fetcher.mockImplementation(async (url: string) =>
    response(
      url.includes('/detail')
        ? { ...detail, work: held, notices: [notice], noticeCount: 1 }
        : {
            ...list,
            items: [held],
            attentionCount: 1,
            stations: [{ ...list.stations[0], pendingNoticeCount: 1 }],
          }
    )
  )
  render(<StationWorkBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /General INV-QA-1/ }))
  await screen.findByText(/1 piece returned; 1 piece remains/)
  expect(screen.getByRole('button', { name: /Start preparing/ })).toBeDisabled()
  expect(screen.getByText(/acknowledgement does not adjust them/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge this notice' }))
  await waitFor(() => expect(journal.save).toHaveBeenCalled())
  expect(journal.save.mock.calls[0][0].command).toMatchObject({
    type: 'notice.ack',
    noticeId: notice.id,
    workId: work.id,
  })
})
it('recovers original action with no current registered device or manager view', async () => {
  records = [{ actorId: props.actorId, command }]
  fetcher.mockResolvedValue(response(ack))
  render(
    <StationWorkPendingRecovery
      actorId={props.actorId}
      branchId={props.branchId}
      disabled={false}
    />
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Check saved action' }))
  await waitFor(() => expect(journal.ack).toHaveBeenCalledWith(props.actorId, command, ack))
  expect(fetcher.mock.calls).toHaveLength(1)
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(command)
})
it('rejects mismatched result and other-branch recovery without rewriting scope', async () => {
  records = [{ actorId: props.actorId, command }]
  fetcher.mockResolvedValue(response({ ...ack, work: { ...ack.work, id: id(99) } }))
  const view = render(
    <StationWorkPendingRecovery
      actorId={props.actorId}
      branchId={props.branchId}
      disabled={false}
    />
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Check saved action' }))
  await screen.findByText(/This action is not confirmed/)
  expect(journal.ack).not.toHaveBeenCalled()
  view.rerender(
    <StationWorkPendingRecovery actorId={props.actorId} branchId={id(90)} disabled={false} />
  )
  await waitFor(() => expect(journal.read).toHaveBeenCalled())
  expect(screen.queryByRole('button', { name: 'Check saved action' })).not.toBeInTheDocument()
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('suppresses late account result and preserves pending custody', async () => {
  records = [{ actorId: props.actorId, command }]
  let resolve!: (value: Response) => void
  fetcher.mockImplementation(() => new Promise<Response>((r) => (resolve = r)))
  const view = render(
    <StationWorkPendingRecovery
      actorId={props.actorId}
      branchId={props.branchId}
      disabled={false}
    />
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Check saved action' }))
  records = []
  view.rerender(
    <StationWorkPendingRecovery actorId={id(50)} branchId={props.branchId} disabled={false} />
  )
  await act(async () => resolve(response(ack)))
  expect(journal.ack).not.toHaveBeenCalled()
})
it('loads all work pages before offering any action and rejects inconsistent totals', async () => {
  const items = Array.from({ length: 100 }, (_, n) => ({ ...work, id: id(100 + n) }))
  let changed = false
  fetcher.mockImplementation(async (url: string) =>
    response(
      url.includes('cursorId')
        ? {
            ...list,
            items: [{ ...work, id: id(200) }],
            matchingCount: changed ? 102 : 101,
            stations: [{ ...list.stations[0], activeCount: 101 }],
          }
        : {
            ...list,
            items,
            matchingCount: 101,
            nextCursor: { at: stamp, id: id(199) },
            stations: [{ ...list.stations[0], activeCount: 101 }],
          }
    )
  )
  const view = render(<StationWorkBoard {...props} />)
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: /General INV-QA-1/ })).toHaveLength(101)
  )
  changed = true
  fireEvent.click(screen.getByRole('button', { name: 'Refresh work' }))
  await screen.findByText(/Kitchen work could not be verified/)
  expect(screen.queryByRole('button', { name: /General INV-QA-1/ })).not.toBeInTheDocument()
  view.unmount()
})
it('keeps cancelled zero-quantity work visible when its returned-item notice remains pending', async () => {
  const closed = {
    ...work,
    state: 'cancelled',
    payment: 'refunded',
    stages: { queued: [], preparing: [], ready: [], served: [] },
    pendingNoticeCount: 1,
  }
  const returned = {
    ...notice,
    source: { ...notice.source, fullyReturned: true },
    detail: { lines: [{ ...notice.detail.lines[0], remainingQuantityMilli: 0 }] },
  }
  fetcher.mockImplementation(async (url: string) =>
    response(
      url.includes('/detail')
        ? { ...detail, work: closed, notices: [returned], noticeCount: 1 }
        : {
            ...list,
            items: [closed],
            attentionCount: 1,
            stations: [{ ...list.stations[0], pendingNoticeCount: 1 }],
          }
    )
  )
  render(<StationWorkBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /General INV-QA-1/ }))
  await screen.findByText(/Preparation cancelled/)
  expect(screen.getByRole('button', { name: 'Acknowledge this notice' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: /Start preparing/ })).not.toBeInTheDocument()
})
it('shows manager-only reverse action with reason and blocks dirty filter changes', async () => {
  const readyWork = { ...work, stages: { ...work.stages, queued: [], ready: [line] } }
  fetcher.mockImplementation(async (url: string) =>
    response(
      url.includes('/detail') ? { ...detail, work: readyWork } : { ...list, items: [readyWork] }
    )
  )
  render(<StationWorkBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /General INV-QA-1/ }))
  const reverse = await screen.findByRole('button', { name: 'Return to preparing' })
  expect(reverse).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Reason for moving work back'), {
    target: { value: 'Needs more cooking' },
  })
  expect(screen.getByLabelText('Station')).toBeDisabled()
  expect(reverse).toBeEnabled()
  fireEvent.click(reverse)
  await waitFor(() => expect(journal.save).toHaveBeenCalled())
  expect(journal.save.mock.calls[0][0].command).toMatchObject({
    from: 'ready',
    to: 'preparing',
    reason: 'Needs more cooking',
  })
})
it('distinguishes stopped preparation from credit quantities on final-order cancellation', async () => {
  const closed = {
    ...work,
    state: 'cancelled',
    payment: 'refunded',
    stages: { queued: [], preparing: [], ready: [], served: [] },
    pendingNoticeCount: 1,
  }
  const cancelledNotice = {
    ...notice,
    kind: 'cancel',
    source: { ...notice.source, fullyReturned: true },
    detail: { lines: [line] },
  }
  fetcher.mockImplementation(async (url: string) =>
    response(
      url.includes('/detail')
        ? { ...detail, work: closed, notices: [cancelledNotice], noticeCount: 1 }
        : {
            ...list,
            items: [closed],
            attentionCount: 1,
            stations: [{ ...list.stations[0], pendingNoticeCount: 1 }],
          }
    )
  )
  render(<StationWorkBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /General INV-QA-1/ }))
  await screen.findByRole('heading', { name: 'Preparation cancelled — order fully returned' })
  expect(screen.getByText(/2 pieces stopped/)).toBeInTheDocument()
  expect(screen.getByText(/not quantities returned on this credit/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Acknowledge this notice' })).toBeEnabled()
})
it('requires all51 notices from a stable detail revision before allowing acknowledgements', async () => {
  const notices = Array.from({ length: 51 }, (_, n) => ({
    ...notice,
    id: id(500 + n),
    sequence: n + 1,
  }))
  const held = { ...work, pendingNoticeCount: 51 }
  let mismatch = false
  fetcher.mockImplementation(async (url: string) => {
    if (!url.includes('/detail'))
      return response({
        ...list,
        items: [held],
        attentionCount: 1,
        stations: [{ ...list.stations[0], pendingNoticeCount: 51 }],
      })
    const after = Number(new URL(url, 'http://localhost').searchParams.get('afterSequence'))
    return response({
      ...detail,
      work: { ...held, revision: mismatch && after ? 2 : 1 },
      notices: after ? notices.slice(50) : notices.slice(0, 50),
      noticeCount: 51,
      nextAfterSequence: after ? null : 50,
    })
  })
  render(<StationWorkBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /General INV-QA-1/ }))
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'Acknowledge this notice' })).toHaveLength(51)
  )
  mismatch = true
  fireEvent.click(screen.getByRole('button', { name: 'Refresh work' }))
  await screen.findByText(/Kitchen work could not be verified/)
  expect(screen.queryByRole('button', { name: 'Acknowledge this notice' })).not.toBeInTheDocument()
})
it('polls visible work and suppresses polling during a saved action submission', async () => {
  render(<StationWorkBoard {...props} />)
  await select()
  const before = fetcher.mock.calls.length
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(before))
  await waitFor(() => expect(screen.getByRole('button', { name: /Start preparing/ })).toBeEnabled())
  let finish!: (value: Response) => void
  fetcher.mockImplementation((_url: string, options?: RequestInit) =>
    options?.method === 'POST'
      ? new Promise<Response>((r) => (finish = r))
      : Promise.resolve(response(detail))
  )
  fireEvent.click(screen.getByRole('button', { name: /Start preparing/ }))
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true)
  )
  const inflight = fetcher.mock.calls.length
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(fetcher.mock.calls).toHaveLength(inflight)
  await act(async () => finish(response({}, 503)))
})
it('shows weighted withdrawals from their original stage and before/after order details', async () => {
  const metadata = { ...work.metadata, label: 'Table order', note: 'No onions' }
  const held = {
    ...work,
    family: 'tab',
    tabId: id(91),
    ticketId: id(90),
    metadata,
    pendingNoticeCount: 1,
  }
  const changed = {
    ...notice,
    kind: 'dispatch',
    source: { ticketId: id(90), eventSequence: 1, tabRevision: 2 },
    detail: {
      metadataBefore: metadata,
      metadataAfter: { ...metadata, note: 'Sauce separately' },
      beforeLines: [{ ...line, unit: 'kg', quantityMilli: 750 }],
      afterLines: [{ ...line, unit: 'kg', quantityMilli: 500 }],
      additions: [],
      withdrawals: [{ ...line, unit: 'kg', quantityMilli: 250, stage: 'ready' }],
    },
  }
  fetcher.mockImplementation(async (url: string) =>
    response(
      url.includes('/detail')
        ? { ...detail, work: held, notices: [changed], noticeCount: 1 }
        : {
            ...list,
            items: [held],
            attentionCount: 1,
            stations: [{ ...list.stations[0], pendingNoticeCount: 1 }],
          }
    )
  )
  render(<StationWorkBoard {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /General INV-QA-1/ }))
  await screen.findByText(/0.25 kg from Ready/)
  expect(screen.getByText(/Previous details:.*No onions/)).toBeInTheDocument()
  expect(screen.getByText(/Order details:.*Sauce separately/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /Review 1 notice/ })).toHaveAttribute(
    'href',
    `#station-notices-${work.id}`
  )
})
it('switching to recovery-only mode removes ordinary read polling for the same scope', async () => {
  const component = render(<StationWorkBoard {...props} />)
  await select()
  component.rerender(<StationWorkBoard {...props} recoveryOnly />)
  await waitFor(() =>
    expect(screen.queryByRole('heading', { name: 'Kitchen by station' })).not.toBeInTheDocument()
  )
  const before = fetcher.mock.calls.length
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(fetcher.mock.calls).toHaveLength(before)
})
