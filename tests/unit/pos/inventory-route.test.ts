// @vitest-environment node
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
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
import { GET, POST } from '@/app/api/pos/inventory/route'
import { GET as history } from '@/app/api/pos/inventory/history/route'
import { POST as recover } from '@/app/api/pos/inventory/recovery/route'
import { PosServerError } from '@/lib/pos/server/client'
import { publicReleaseAccess } from '@/lib/pos/public-release'
const id = '10000000-0000-4000-8000-000000000001',
  other = '20000000-0000-4000-8000-000000000002',
  now = '2026-10-16T14:00:00Z'
const item = {
  id,
  branchId: id,
  name: 'Sugar',
  sku: null,
  unit: 'kg',
  reorderLevelMilli: 1000,
  active: true,
  revision: 1,
  onHandMilli: null,
  createdAt: now,
  updatedAt: now,
  movementCount: 0,
}
const command = {
  id,
  type: 'item.save',
  branchId: id,
  deviceId: id,
  expectedRevision: 0,
  reason: 'Opening stock catalogue',
  item: { id, name: 'Sugar', sku: null, unit: 'kg', reorderLevelMilli: 1000, active: true },
}
const result = { status: 'applied', requestId: id, replayed: false, item, movement: null }
const req = (body: unknown, origin = 'http://localhost') =>
  new Request('http://localhost/api/pos/inventory', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-pos-actor': id },
    body: JSON.stringify(body),
  })
const list = {
  status: 'ready',
  branchId: id,
  asOf: now,
  counts: { totalItems: 1, activeItems: 1, inactiveItems: 0, lowStockItems: 0, uncountedItems: 1 },
  matchingItems: 1,
  items: [item],
  nextCursor: null,
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  vi.stubEnv('POS_PUBLIC_ORIGIN', 'http://localhost')
  m.auth.mockResolvedValue({ user: { id }, client: { rpc: m.rpc } })
  m.device.mockResolvedValue('a'.repeat(64))
  m.recovery.mockResolvedValue('a'.repeat(64))
  m.rpc.mockResolvedValue({ data: result, error: null })
})
afterEach(() => vi.unstubAllEnvs())
it('uses current authenticated device for writes and returns only exact immutable acknowledgement', async () => {
  const response = await POST(req(command))
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(m.device).toHaveBeenCalledWith(expect.anything(), id, id, id)
  expect(m.rpc).toHaveBeenCalledWith('pos_manage_inventory', {
    p_command: command,
    p_binding: 'a'.repeat(64),
  })
  for (const patch of [
    { requestId: other },
    { item: { ...item, branchId: other } },
    { item: { ...item, name: 'Other' } },
    { item: { ...item, revision: 2 } },
  ]) {
    m.rpc.mockResolvedValueOnce({ data: { ...result, ...patch }, error: null })
    expect((await POST(req(command))).status).toBe(503)
  }
})
it('requires origin, pilot, authentication and device before stock writes', async () => {
  expect((await POST(req(command, 'https://evil.test'))).status).toBe(403)
  expect(m.auth).not.toHaveBeenCalled()
  vi.stubEnv('POS_ONLINE_PILOT', 'false')
  expect((await POST(req(command))).status).toBe(503)
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  m.auth.mockRejectedValueOnce(new PosServerError('authentication_required', 401))
  expect((await POST(req(command))).status).toBe(401)
  m.device.mockRejectedValueOnce(new PosServerError('device_binding_required', 403))
  expect((await POST(req(command))).status).toBe(403)
  expect(m.rpc).not.toHaveBeenCalled()
})
it('rejects malformed, oversized and authority-injected commands', async () => {
  expect((await POST(req({ ...command, actorId: id }))).status).toBe(422)
  expect((await POST(req({ ...command, reason: 'a'.repeat(9000) }))).status).toBe(413)
  expect(
    (
      await POST(
        new Request('http://localhost', {
          method: 'POST',
          headers: { origin: 'http://localhost', 'x-pos-actor': id },
          body: '{',
        })
      )
    ).status
  ).toBe(400)
  expect(m.rpc).not.toHaveBeenCalled()
})
it('reads an explicitly authorized branch without requiring a registered selling counter', async () => {
  m.rpc.mockResolvedValueOnce({ data: list, error: null })
  const r = await GET(new Request('http://localhost/api/pos/inventory?branchId=' + id))
  expect(r.status).toBe(200)
  expect(m.device).not.toHaveBeenCalled()
  expect(m.rpc).toHaveBeenCalledWith('pos_inventory', {
    p_branch: id,
    p_query: { search: '', filter: 'all', afterId: null },
  })
  for (const suffix of ['&role=owner', '&branchId=' + other, '&filter=unknown', '&afterId=bad'])
    expect(
      (await GET(new Request('http://localhost/api/pos/inventory?branchId=' + id + suffix))).status
    ).toBe(422)
})
it('rejects wrong branch and contradictory paging in read replies', async () => {
  m.rpc.mockResolvedValueOnce({ data: { ...list, branchId: other }, error: null })
  expect((await GET(new Request('http://localhost/api/pos/inventory?branchId=' + id))).status).toBe(
    503
  )
  m.rpc.mockResolvedValueOnce({ data: list, error: null })
  expect(
    (await GET(new Request('http://localhost/api/pos/inventory?branchId=' + id + '&afterId=' + id)))
      .status
  ).toBe(503)
})
it('validates history scope/cursor and never converts a failed read to zero stock', async () => {
  m.rpc.mockResolvedValueOnce({
    data: { status: 'ready', branchId: id, asOf: now, item, entries: [], nextBeforeRevision: null },
    error: null,
  })
  expect(
    (
      await history(
        new Request(`http://localhost/api/pos/inventory/history?branchId=${id}&itemId=${id}`)
      )
    ).status
  ).toBe(200)
  expect(m.rpc).toHaveBeenCalledWith('pos_inventory_history', {
    p_branch: id,
    p_item: id,
    p_before_revision: null,
  })
  for (const cursor of ['1', '2147483647', '-2', '1.5', 'foo'])
    expect(
      (
        await history(
          new Request(
            `http://localhost/api/pos/inventory/history?branchId=${id}&itemId=${id}&beforeRevision=${cursor}`
          )
        )
      ).status
    ).toBe(422)
  m.rpc.mockResolvedValueOnce({ data: null, error: { message: 'private database diagnostic' } })
  const r = await GET(new Request('http://localhost/api/pos/inventory?branchId=' + id))
  expect(r.status).toBe(503)
  expect(await r.text()).not.toContain('private database diagnostic')
})
it('exposes exact-own-request recovery when selling is disabled and does not require current device authority', async () => {
  vi.stubEnv('POS_ONLINE_PILOT', 'false')
  const r = await recover(req({ mode: 'lookup', command }))
  expect(r.status).toBe(200)
  expect(m.device).not.toHaveBeenCalled()
  expect(m.recovery).toHaveBeenCalledWith(id)
  expect(m.rpc).toHaveBeenCalledWith('pos_inventory_request', {
    p_mode: 'lookup',
    p_command: command,
    p_binding: 'a'.repeat(64),
  })
  expect(publicReleaseAccess('/api/pos/inventory/recovery', 'POST', false)).toBe('allow')
  expect(publicReleaseAccess('/api/pos/inventory', 'POST', false)).toBe('unavailable')
})
it('keeps not-found separate from cancellation and rejects contradictory cancel responses', async () => {
  m.rpc.mockResolvedValueOnce({ data: { status: 'not_found', requestId: id }, error: null })
  expect((await recover(req({ mode: 'lookup', command }))).status).toBe(200)
  m.rpc.mockResolvedValueOnce({ data: { status: 'not_found', requestId: id }, error: null })
  expect((await recover(req({ mode: 'cancel', command }))).status).toBe(503)
  m.rpc.mockResolvedValueOnce({
    data: { status: 'cancelled', requestId: id, replayed: true },
    error: null,
  })
  expect((await recover(req({ mode: 'cancel', command }))).status).toBe(200)
  expect((await recover(req({ mode: 'cancel', command }, 'https://other.test'))).status).toBe(403)
})
it('maps conflicts/quantity/authority errors without leaking database text', async () => {
  for (const [message, status] of [
    ['POS_MANAGER_REQUIRED', 403],
    ['POS_DEVICE_INVALID', 403],
    ['POS_IDEMPOTENCY_CONFLICT', 409],
    ['POS_INVENTORY_CONFLICT', 409],
    ['POS_INVENTORY_COUNT_REQUIRED', 409],
    ['POS_INVENTORY_INSUFFICIENT', 409],
    ['POS_INVENTORY_SKU_CONFLICT', 409],
    ['POS_INVENTORY_CAPACITY', 409],
    ['POS_INVENTORY_INACTIVE', 409],
    ['POS_INVENTORY_NOT_FOUND', 404],
    ['POS_INVENTORY_INVALID', 422],
    ['POS_INVENTORY_UNIT_IMMUTABLE', 422],
  ] as const) {
    m.rpc.mockResolvedValueOnce({ data: null, error: { message } })
    expect((await POST(req(command))).status).toBe(status)
  }
})

it('rejects stale or absent browser actor identity before any device or ledger operation', async () => {
  for (const handler of [POST, recover])
    for (const actor of [null, other]) {
      const request = req(handler === POST ? command : { mode: 'cancel', command })
      if (actor) request.headers.set('x-pos-actor', actor)
      else request.headers.delete('x-pos-actor')
      const response = await handler(request)
      expect(response.status).toBe(403)
      expect((await response.json()).code).toBe('inventory_actor_changed')
    }
  expect(m.device).not.toHaveBeenCalled()
  expect(m.recovery).not.toHaveBeenCalled()
  expect(m.rpc).not.toHaveBeenCalled()
})
