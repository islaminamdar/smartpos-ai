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
import { GET, POST } from '@/app/api/pos/kitchen/route'
import { POST as RECOVER } from '@/app/api/pos/kitchen/recovery/route'
import { PosServerError } from '@/lib/pos/server/client'
import { kitchenTicketSchema } from '@/lib/pos/server/kitchen'
import { publicReleaseAccess } from '@/lib/pos/public-release'

const id = (n: number) => `${n}0000000-0000-4000-8000-000000000001`
const actor = id(1),
  branch = id(2),
  device = id(3),
  order = id(4),
  requestId = id(5)
const command = {
  id: requestId,
  branchId: branch,
  deviceId: device,
  orderId: order,
  expectedRevision: 1,
  status: 'preparing',
  reason: null,
}
const ticket = {
  orderId: order,
  branchId: branch,
  invoiceId: id(6),
  invoiceNumber: 'TEST-INV-0000000001',
  issuedAt: '2026-10-16T00:00:00Z',
  serviceType: 'takeaway',
  lines: [
    { lineNumber: 1, productId: id(7), name: 'Synthetic dish', unit: 'piece', quantityMilli: 1000 },
  ],
  status: 'preparing',
  revision: 2,
  updatedAt: '2026-10-16T00:00:01Z',
  refundedAt: null,
}
const ack = { status: 'updated', requestId, replayed: false, ticket }
const list = {
  status: 'ready',
  organizationId: id(8),
  branchId: branch,
  actorRole: 'cashier',
  generatedAt: '2026-10-16T00:00:02Z',
  activeTickets: [ticket],
  terminalTickets: [],
  activeCount: 1,
  activeCounts: { queued: 0, preparing: 1, ready: 0 },
  activeNextCursor: null,
  terminalTruncated: false,
}
const read = (extra = '') =>
  new Request(`http://localhost/api/pos/kitchen?branchId=${branch}&deviceId=${device}${extra}`)
const req = (body: unknown, origin = 'http://localhost') =>
  new Request('http://localhost/api/pos/kitchen', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
beforeEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  vi.stubEnv('POS_PUBLIC_ORIGIN', 'http://localhost')
  m.auth.mockResolvedValue({ client: { rpc: m.rpc }, user: { id: actor } })
  m.device.mockResolvedValue('synthetic-binding')
  m.recovery.mockResolvedValue('historical-binding')
  m.rpc.mockResolvedValue({ data: ack, error: null })
})
describe('live kitchen HTTP trust boundaries', () => {
  it('requires enabled pilot and authentication, and same-origin mutations', async () => {
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
  it('requires branch-bound device for reads and writes, but historical binding for recovery', async () => {
    m.device.mockRejectedValue(new PosServerError('device_binding_required', 403))
    expect((await GET(read())).status).toBe(403)
    expect((await POST(req(command))).status).toBe(403)
    expect(m.rpc).not.toHaveBeenCalled()
    expect((await RECOVER(req(command))).status).toBe(200)
    expect(m.rpc).toHaveBeenLastCalledWith('pos_resolve_kitchen_request', {
      p_command: command,
      p_binding: 'historical-binding',
    })
  })
  it('returns private minimal kitchen data and passes complete cursor pairs', async () => {
    m.rpc.mockResolvedValue({ data: list, error: null })
    const response = await GET(read())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual(list)
    expect(m.device).toHaveBeenCalledWith(expect.anything(), branch, device, actor)
    const stamp = '2026-10-16T00:00:00Z'
    expect((await GET(read(`&afterIssuedAt=${stamp}&afterOrderId=${order}`))).status).toBe(200)
    expect(m.rpc).toHaveBeenLastCalledWith('pos_list_kitchen', {
      p_branch: branch,
      p_binding: 'synthetic-binding',
      p_cursor: { issuedAt: stamp, orderId: order },
    })
    for (const extra of [
      `&afterOrderId=${order}`,
      '&afterIssuedAt=invalid',
      `&branchId=${branch}`,
      '&unexpected=1',
    ])
      expect((await GET(read(extra))).status).toBe(422)
  })
  it('fails closed on mixed branch, inconsistent counts, stages, cursors or private fields', async () => {
    for (const malformed of [
      { ...list, branchId: id(9), activeTickets: [{ ...ticket, branchId: id(9) }] },
      { ...list, activeTickets: [{ ...ticket, branchId: id(9) }] },
      { ...list, activeCount: 2 },
      { ...list, activeTickets: [{ ...ticket, status: 'served' }] },
      { ...list, activeNextCursor: { issuedAt: ticket.issuedAt, orderId: id(9) } },
      { ...list, activeTickets: [{ ...ticket, customer: { email: 'private@example.invalid' } }] },
      {
        ...list,
        activeTickets: [ticket, ticket],
        activeCount: 2,
        activeCounts: { queued: 0, preparing: 2, ready: 0 },
      },
    ]) {
      m.rpc.mockResolvedValue({ data: malformed, error: null })
      expect((await GET(read())).status).toBe(503)
    }
  })
  it('strictly validates command data and bounded bodies before RPC', async () => {
    for (const invalid of [
      { ...command, actorId: actor },
      { ...command, status: 'cancelled' },
      { ...command, expectedRevision: 0 },
      { ...command, reason: '  ' },
      { ...command, reason: 'x'.repeat(241) },
      { ...command, deviceId: 'bad' },
    ])
      expect((await POST(req(invalid))).status).toBe(422)
    const large = req({ ...command, reason: 'x'.repeat(5000) })
    expect((await POST(large)).status).toBe(413)
    expect(m.rpc).not.toHaveBeenCalled()
  })
  it('checks exact canonical acknowledgement in write and recovery, including old replay state', async () => {
    expect((await POST(req(command))).status).toBe(200)
    m.rpc.mockResolvedValue({ data: { ...ack, replayed: true }, error: null })
    expect((await RECOVER(req(command))).status).toBe(200)
    for (const malformed of [
      { ...ack, requestId: id(9) },
      { ...ack, ticket: { ...ticket, orderId: id(9) } },
      { ...ack, ticket: { ...ticket, revision: 3 } },
      { ...ack, ticket: { ...ticket, status: 'ready' } },
      { ...ack, ticket: { ...ticket, branchId: id(9) } },
    ]) {
      m.rpc.mockResolvedValue({ data: malformed, error: null })
      expect((await POST(req(command))).status).toBe(503)
      expect((await RECOVER(req(command))).status).toBe(503)
    }
  })
  it('only acknowledges an exact durable cancellation and does not require current device enrollment', async () => {
    m.rpc.mockResolvedValue({
      data: { status: 'cancelled', requestId, replayed: false },
      error: null,
    })
    expect((await RECOVER(req(command))).status).toBe(200)
    expect(m.device).not.toHaveBeenCalled()
    m.rpc.mockResolvedValue({
      data: { status: 'cancelled', requestId: id(9), replayed: false },
      error: null,
    })
    expect((await RECOVER(req(command))).status).toBe(503)
    m.recovery.mockRejectedValue(new PosServerError('device_binding_required', 403))
    expect((await RECOVER(req(command))).status).toBe(403)
  })
  it('sanitizes known conflicts and unexpected database errors', async () => {
    for (const [message, expected] of [
      ['POS_KITCHEN_CHANGED', 409],
      ['POS_ACCESS_DENIED', 403],
      ['POS_INVALID_KITCHEN_COMMAND', 422],
      ['private database information', 503],
    ] as const) {
      m.rpc.mockResolvedValue({ data: null, error: { message } })
      const response = await POST(req(command))
      expect(response.status).toBe(expected)
      expect(JSON.stringify(await response.json())).not.toContain(message)
    }
  })
  it('validates weighed lines and cancellation semantics without money or customer fields', () => {
    expect(kitchenTicketSchema.safeParse(ticket).success).toBe(true)
    expect(kitchenTicketSchema.safeParse({ ...ticket, status: 'cancelled' }).success).toBe(false)
    expect(
      kitchenTicketSchema.safeParse({
        ...ticket,
        lines: [{ ...ticket.lines[0], quantityMilli: 250 }],
      }).success
    ).toBe(false)
    expect(
      kitchenTicketSchema.safeParse({
        ...ticket,
        lines: [{ ...ticket.lines[0], unit: 'kg', quantityMilli: 250 }],
      }).success
    ).toBe(true)
  })
  it('only exposes exact kitchen methods during the online pilot', () => {
    expect(publicReleaseAccess('/api/pos/kitchen', 'GET', true)).toBe('allow')
    expect(publicReleaseAccess('/api/pos/kitchen', 'POST', true)).toBe('allow')
    expect(publicReleaseAccess('/api/pos/kitchen/recovery', 'POST', true)).toBe('allow')
    expect(publicReleaseAccess('/api/pos/kitchen', 'DELETE', true)).toBe('unavailable')
    expect(publicReleaseAccess('/api/pos/kitchen', 'GET', false)).toBe('unavailable')
    expect(publicReleaseAccess('/kds', 'GET', true)).toBe('not_found')
  })
})
