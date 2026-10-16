import { beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), device: vi.fn(), recovery: vi.fn() }))
vi.mock('@/lib/pos/server/client', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/client')>()),
  authenticatedPosClient: m.auth,
}))
vi.mock('@/lib/pos/server/live-access', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/live-access')>()),
  requireDevice: m.device,
  recoveryBinding: m.recovery,
}))
import { GET, POST } from '@/app/api/pos/tab-kitchen/route'
import { POST as RECOVER } from '@/app/api/pos/tab-kitchen/recovery/route'
import { PosServerError } from '@/lib/pos/server/client'
import {
  tabKitchenTicketSchema,
  tabKitchenAckMatches,
  tabKitchenCommandSchema,
} from '@/lib/pos/server/tab-kitchen'
const id = (n: number) => `${n}0000000-0000-4000-8000-000000000001`
const actor = id(1),
  branch = id(2),
  device = id(3),
  tab = id(4),
  requestId = id(5)
const stamp = '2026-10-16T00:00:00Z'
const line = { productId: id(7), name: 'Test tea', unit: 'piece' as const, quantityMilli: 1000 }
const metadata = {
  label: 'Test table',
  serviceType: 'dine_in' as const,
  tableId: null,
  tableName: null,
  guestCount: 2,
  note: '',
}
const ticket = {
  id: id(6),
  tabId: tab,
  branchId: branch,
  revision: 1,
  generation: 1,
  dispatchedTabRevision: 2,
  state: 'open' as const,
  payment: 'unpaid' as const,
  paidOrderId: null,
  invoiceId: null,
  invoiceNumber: null,
  paidAt: null,
  refundedAt: null,
  metadata,
  lines: [line],
  stages: { queued: [line], preparing: [], ready: [], served: [] },
  eventSequence: 1,
  acknowledgedSequence: 0,
  pendingChangeCount: 1,
  issuedAt: stamp,
  updatedAt: stamp,
}
const command = {
  id: requestId,
  branchId: branch,
  deviceId: device,
  type: 'dispatch' as const,
  tabId: tab,
  expectedTabRevision: 2,
  expectedTicketRevision: 0,
  reason: null,
}
const ack = { status: 'updated', requestId, replayed: false, ticket }
const scope = { status: 'ready', organizationId: id(8), branchId: branch, actorRole: 'cashier' }
const list = {
  ...scope,
  generatedAt: stamp,
  activeTickets: [ticket],
  terminalTickets: [],
  activeCount: 1,
  pendingCount: 1,
  activeNextCursor: null,
  terminalTruncated: false,
}
const tabDetail = { ...scope, tabId: tab, tabRevision: 2, ticket, dispatchRequired: false }
const event = {
  sequence: 1,
  generation: 1,
  kind: 'dispatch',
  tabRevision: 2,
  reason: null,
  createdAt: stamp,
  before: null,
  after: { metadata, lines: [line] },
  additions: [line],
  withdrawals: [],
}
const detail = { ...scope, ticket, events: [event], eventsNextAfter: null }
const req = (body: unknown, origin = 'http://localhost') =>
  new Request('http://localhost/api/pos/tab-kitchen', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const read = (extra = '') =>
  new Request(`http://localhost/api/pos/tab-kitchen?branchId=${branch}&deviceId=${device}${extra}`)
beforeEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  vi.stubEnv('POS_PUBLIC_ORIGIN', 'http://localhost')
  m.auth.mockResolvedValue({ client: { rpc: m.rpc }, user: { id: actor } })
  m.device.mockResolvedValue('bound')
  m.recovery.mockResolvedValue('historical')
  m.rpc.mockResolvedValue({ data: ack, error: null })
})
describe('unpaid kitchen HTTP and snapshot trust boundaries', () => {
  it('requires pilot, authenticated identity and same-origin mutations', async () => {
    vi.stubEnv('POS_ONLINE_PILOT', 'false')
    expect((await GET(read())).status).toBe(503)
    expect(m.auth).not.toHaveBeenCalled()
    vi.stubEnv('POS_ONLINE_PILOT', 'true')
    expect((await POST(req(command, 'https://foreign.invalid'))).status).toBe(403)
    expect((await RECOVER(req(command, 'https://foreign.invalid'))).status).toBe(403)
    m.auth.mockRejectedValue(new PosServerError('authentication_required', 401))
    expect((await GET(read())).status).toBe(401)
    expect(m.rpc).not.toHaveBeenCalled()
  })
  it('requires branch-bound device normally and historical proof for recovery', async () => {
    m.device.mockRejectedValue(new PosServerError('device_binding_required', 403))
    expect((await GET(read())).status).toBe(403)
    expect((await POST(req(command))).status).toBe(403)
    expect(m.rpc).not.toHaveBeenCalled()
    expect((await RECOVER(req(command))).status).toBe(200)
    expect(m.rpc).toHaveBeenLastCalledWith('pos_resolve_tab_kitchen_request', {
      p_command: command,
      p_binding: 'historical',
    })
  })
  it('routes list cursors, tab status and event detail as distinct private reads', async () => {
    m.rpc.mockResolvedValue({ data: list, error: null })
    const response = await GET(read())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual(list)
    expect(m.device).toHaveBeenCalledWith(expect.anything(), branch, device, actor)
    expect((await GET(read(`&afterIssuedAt=${stamp}&afterId=${ticket.id}`))).status).toBe(200)
    expect(m.rpc).toHaveBeenLastCalledWith('pos_list_tab_kitchen', {
      p_branch: branch,
      p_binding: 'bound',
      p_cursor: { issuedAt: stamp, id: ticket.id },
    })
    m.rpc.mockResolvedValue({ data: tabDetail, error: null })
    expect((await GET(read(`&tabId=${tab}`))).status).toBe(200)
    expect(m.rpc).toHaveBeenLastCalledWith('pos_get_tab_kitchen_for_tab', {
      p_branch: branch,
      p_binding: 'bound',
      p_tab: tab,
    })
    m.rpc.mockResolvedValue({ data: detail, error: null })
    expect((await GET(read(`&ticketId=${ticket.id}&afterSequence=0`))).status).toBe(200)
    expect(m.rpc).toHaveBeenLastCalledWith('pos_get_tab_kitchen', {
      p_branch: branch,
      p_binding: 'bound',
      p_ticket: ticket.id,
      p_after_sequence: 0,
    })
  })
  it('rejects mixed modes, duplicate query keys, lone cursors and numeric ambiguity', async () => {
    for (const extra of [
      `&tabId=${tab}&ticketId=${ticket.id}`,
      '&afterSequence=0',
      `&afterId=${ticket.id}`,
      `&ticketId=${ticket.id}&afterSequence=01`,
      `&ticketId=${ticket.id}&afterSequence=-1`,
      `&ticketId=${ticket.id}&afterSequence=2147483648`,
      `&tabId=${tab}&afterIssuedAt=${stamp}&afterId=${ticket.id}`,
      `&branchId=${branch}`,
      '&extra=true',
    ])
      expect((await GET(read(extra))).status).toBe(422)
    expect(m.rpc).not.toHaveBeenCalled()
  })
  it('rejects invented command authority, oversized payloads and invalid transitions', async () => {
    for (const bad of [
      { ...command, actorId: actor },
      { ...command, reason: ' ' },
      { ...command, expectedTicketRevision: -1 },
      { ...command, expectedTabRevision: 0 },
      { ...command, type: 'pay' },
      {
        id: requestId,
        branchId: branch,
        deviceId: device,
        type: 'stage',
        ticketId: ticket.id,
        expectedRevision: 1,
        from: 'queued',
        to: 'served',
        reason: null,
      },
    ])
      expect((await POST(req(bad))).status).toBe(422)
    expect((await POST(req({ ...command, reason: 'x'.repeat(5000) }))).status).toBe(413)
    expect(m.rpc).not.toHaveBeenCalled()
  })
  it('requires canonical matching saved revision and stable ticket identity for acknowledgements', async () => {
    expect((await POST(req(command))).status).toBe(200)
    for (const bad of [
      { ...ack, requestId: id(9) },
      { ...ack, ticket: { ...ticket, tabId: id(9) } },
      { ...ack, ticket: { ...ticket, revision: 2 } },
      { ...ack, ticket: { ...ticket, dispatchedTabRevision: 3 } },
      { ...ack, ticket: { ...ticket, branchId: id(9) } },
    ]) {
      m.rpc.mockResolvedValue({ data: bad, error: null })
      expect((await POST(req(command))).status).toBe(503)
      expect((await RECOVER(req(command))).status).toBe(503)
    }
    m.rpc.mockResolvedValue({ data: { ...ack, replayed: true }, error: null })
    expect((await RECOVER(req(command))).status).toBe(200)
  })
  it('only clears exact durable cancellations, with no current device requirement', async () => {
    m.rpc.mockResolvedValue({
      data: { status: 'cancelled', requestId, replayed: false },
      error: null,
    })
    expect((await RECOVER(req(command))).status).toBe(200)
    expect(m.device).not.toHaveBeenCalled()
    m.rpc.mockResolvedValue({
      data: { status: 'cancelled', requestId: id(9), replayed: true },
      error: null,
    })
    expect((await RECOVER(req(command))).status).toBe(503)
  })
  it('retains cancelled or served tickets in active attention while notices remain', async () => {
    const cancelled = {
      ...ticket,
      state: 'cancelled',
      lines: [],
      stages: { queued: [], preparing: [], ready: [], served: [] },
    }
    m.rpc.mockResolvedValue({ data: { ...list, activeTickets: [cancelled] }, error: null })
    expect((await GET(read())).status).toBe(200)
    m.rpc.mockResolvedValue({
      data: { ...list, activeTickets: [], terminalTickets: [cancelled] },
      error: null,
    })
    expect((await GET(read())).status).toBe(503)
    const served = { ...ticket, stages: { queued: [], preparing: [], ready: [], served: [line] } }
    m.rpc.mockResolvedValue({ data: { ...list, activeTickets: [served] }, error: null })
    expect((await GET(read())).status).toBe(200)
  })
  it('rejects cross-branch, duplicate tickets, inaccurate counts and wrong cursor responses', async () => {
    for (const bad of [
      { ...list, branchId: id(9), activeTickets: [{ ...ticket, branchId: id(9) }] },
      { ...list, activeCount: 0 },
      { ...list, pendingCount: 0 },
      { ...list, pendingCount: 2 },
      { ...list, activeTickets: [ticket, ticket], activeCount: 2, pendingCount: 2 },
      { ...list, activeNextCursor: { issuedAt: stamp, id: id(9) } },
    ]) {
      m.rpc.mockResolvedValue({ data: bad, error: null })
      expect((await GET(read())).status).toBe(503)
    }
  })
  it('does not expose money or accept preparation quantities inconsistent with source', () => {
    for (const bad of [
      { ...ticket, customer: 'private' },
      { ...ticket, payment: 'paid' },
      { ...ticket, acknowledgedSequence: 2 },
      { ...ticket, pendingChangeCount: 0 },
      { ...ticket, stages: { ...ticket.stages, queued: [{ ...line, quantityMilli: 2000 }] } },
      { ...ticket, stages: { ...ticket.stages, queued: [{ ...line, name: 'Different' }] } },
      { ...ticket, stages: { ...ticket.stages, queued: [{ ...line, unit: 'kg' }] } },
      { ...ticket, metadata: { ...metadata, tableId: id(9) } },
      { ...ticket, lines: [{ ...line, quantityMilli: 1001 }] },
    ])
      expect(tabKitchenTicketSchema.safeParse(bad).success).toBe(false)
    expect(tabKitchenTicketSchema.safeParse(ticket).success).toBe(true)
  })
  it('requires complete contiguous displayed history before acknowledging its prefix', async () => {
    for (const bad of [
      { ...detail, events: [] },
      { ...detail, eventsNextAfter: 1 },
      { ...detail, ticket: { ...ticket, eventSequence: 2, pendingChangeCount: 2 } },
      { ...detail, ticket: { ...ticket, id: id(9) } },
    ]) {
      m.rpc.mockResolvedValue({ data: bad, error: null })
      expect((await GET(read(`&ticketId=${ticket.id}`))).status).toBe(503)
    }
    const acknowledged = { ...ticket, acknowledgedSequence: 1, pendingChangeCount: 0 }
    m.rpc.mockResolvedValue({ data: { ...detail, ticket: acknowledged, events: [] }, error: null })
    expect((await GET(read(`&ticketId=${ticket.id}`))).status).toBe(200)
  })
  it('distinguishes undispatched orders from unsent changes and rejects wrong tab readback', async () => {
    m.rpc.mockResolvedValue({ data: { ...tabDetail, ticket: null }, error: null })
    expect((await GET(read(`&tabId=${tab}`))).status).toBe(200)
    for (const bad of [
      { ...tabDetail, ticket: null, dispatchRequired: true },
      { ...tabDetail, tabId: id(9) },
      { ...tabDetail, ticket: { ...ticket, tabId: id(9) } },
    ]) {
      m.rpc.mockResolvedValue({ data: bad, error: null })
      expect((await GET(read(`&tabId=${tab}`))).status).toBe(503)
    }
  })
  it('checks stage and acknowledgement results without treating served work as queued', () => {
    const t = tabKitchenTicketSchema.parse({
      ...ticket,
      revision: 2,
      acknowledgedSequence: 1,
      pendingChangeCount: 0,
    })
    const c = tabKitchenCommandSchema.parse({
      id: requestId,
      branchId: branch,
      deviceId: device,
      type: 'acknowledge',
      ticketId: ticket.id,
      expectedRevision: 1,
      throughSequence: 1,
    })
    expect(
      tabKitchenAckMatches(c, { status: 'updated', requestId, replayed: false, ticket: t })
    ).toBe(true)
    const stage = tabKitchenCommandSchema.parse({
      id: requestId,
      branchId: branch,
      deviceId: device,
      type: 'stage',
      ticketId: ticket.id,
      expectedRevision: 2,
      from: 'queued',
      to: 'preparing',
      reason: null,
    })
    expect(
      tabKitchenAckMatches(stage, {
        status: 'updated',
        requestId,
        replayed: false,
        ticket: { ...t, revision: 3 },
      })
    ).toBe(false)
    expect(
      tabKitchenAckMatches(stage, {
        status: 'updated',
        requestId,
        replayed: false,
        ticket: {
          ...t,
          revision: 3,
          stages: { queued: [], preparing: [line], ready: [], served: [] },
        },
      })
    ).toBe(true)
  })
  it('normalizes operational errors without leaking raw database text', async () => {
    for (const [code, status] of [
      ['POS_TAB_KITCHEN_PENDING_ACK', 409],
      ['POS_MANAGER_REQUIRED', 403],
      ['POS_TAB_KITCHEN_CHANGED', 409],
      ['POS_KITCHEN_REASON_REQUIRED', 422],
      ['POS_INVALID_ORDER', 422],
      ['POS_TAB_KITCHEN_NOT_FOUND', 404],
      ['private SQL internal', 503],
    ] as const) {
      m.rpc.mockResolvedValue({ data: null, error: { message: code + ' sensitive-details' } })
      const r = await POST(req(command))
      expect(r.status).toBe(status)
      expect(await r.text()).not.toContain('sensitive-details')
    }
  })
})
