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
import { GET, POST } from '@/app/api/pos/kitchen-stations/route'
import { POST as RECOVER } from '@/app/api/pos/kitchen-stations/recovery/route'
import {
  stationCommandSchema,
  stationListSchema,
  stationResultSchema,
} from '@/lib/pos/server/kitchen-stations'
import { PosServerError } from '@/lib/pos/server/client'
import { publicReleaseAccess } from '@/lib/pos/public-release'
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`
const actor = id(1),
  branch = id(2),
  device = id(3)
const station = {
  id: id(4),
  name: 'Hot kitchen',
  active: true,
  createdAt: '2026-10-16T00:00:00Z',
  updatedAt: '2026-10-16T00:00:00Z',
}
const command = {
  id: id(5),
  branchId: branch,
  deviceId: device,
  expectedRevision: 0,
  type: 'station.save',
  station: { id: station.id, name: station.name, active: true },
}
const routeCommand = {
  id: id(6),
  branchId: branch,
  deviceId: device,
  expectedRevision: 1,
  type: 'route.set',
  productId: id(7),
  stationId: station.id,
}
const ack = {
  status: 'applied',
  requestId: command.id,
  branchId: branch,
  replayed: false,
  revision: 1,
  station,
  route: null,
}
const list = {
  status: 'ready',
  organizationId: id(8),
  branchId: branch,
  actorRole: 'cashier',
  revision: 2,
  generatedAt: station.createdAt,
  stations: [station],
  routes: [{ productId: id(7), stationId: station.id }],
  routeCount: 1,
  nextProductId: null,
}
const read = (extra = '') =>
  new Request(
    `http://localhost/api/pos/kitchen-stations?branchId=${branch}&deviceId=${device}${extra}`
  )
const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/pos/kitchen-stations', {
    method: 'POST',
    headers: {
      origin: 'http://localhost',
      'x-pos-actor': actor,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
beforeEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  vi.stubEnv('POS_PUBLIC_ORIGIN', 'http://localhost')
  m.auth.mockResolvedValue({ client: { rpc: m.rpc }, user: { id: actor } })
  m.device.mockResolvedValue('current')
  m.recovery.mockResolvedValue('historical')
  m.rpc.mockResolvedValue({ data: ack, error: null })
})
describe('station strict contracts', () => {
  it('counts Unicode code points without mutating saved names', () => {
    for (const name of ['🍲'.repeat(60), 'Grill\u00a0inside', '焼き場']) {
      const value = { ...command, station: { ...command.station, name } }
      expect(stationCommandSchema.parse(value)).toEqual(value)
    }
    for (const name of [
      '',
      ' General',
      'GENERAL',
      'x ',
      '\u00a0x',
      'x\ufeff',
      '🍲'.repeat(61),
      'x\ny',
      'x\ty',
      'x\u0000y',
      'x\u007fy',
    ])
      expect(
        stationCommandSchema.safeParse({ ...command, station: { ...command.station, name } })
          .success
      ).toBe(false)
  })
  it('rejects unknown fields, uppercase identifiers, coercion and exhausted revisions', () => {
    for (const value of [
      { ...command, extra: true },
      { ...command, id: id(10).toUpperCase() },
      { ...command, expectedRevision: '0' },
      { ...command, expectedRevision: 0.5 },
      { ...command, expectedRevision: 2147483647 },
      { ...command, station: { ...command.station, branchId: branch } },
      { ...routeCommand, station: command.station },
    ])
      expect(stationCommandSchema.safeParse(value).success).toBe(false)
    expect(
      stationCommandSchema.safeParse({ ...command, expectedRevision: 2147483646 }).success
    ).toBe(true)
    expect(stationCommandSchema.safeParse({ ...routeCommand, stationId: null }).success).toBe(true)
  })
  it('requires exactly one result variant and monotonic station timestamps', () => {
    for (const value of [
      { ...ack, station: null },
      { ...ack, route: list.routes[0] },
      { ...ack, station: { ...station, updatedAt: '2026-10-15T00:00:00Z' } },
      { ...ack, revision: 2147483648 },
      { ...ack, private: true },
    ])
      expect(stationResultSchema.safeParse(value).success).toBe(false)
  })
  it('rejects duplicate, unsorted, missing or archived station references and false totals', () => {
    for (const value of [
      { ...list, stations: [station, station] },
      { ...list, stations: [{ ...station, id: id(9) }, station] },
      { ...list, stations: [{ ...station, active: false }] },
      { ...list, stations: [] },
      { ...list, stations: [], routes: [] },
      { ...list, stations: [{ ...station, active: false }], routes: [] },
      { ...list, routes: [list.routes[0], list.routes[0]], routeCount: 2 },
      { ...list, routeCount: 0 },
      { ...list, routeCount: 2147483648 },
      { ...list, nextProductId: id(7) },
      { ...list, revision: 0 },
      { ...list, routes: [{ productId: id(7), stationId: null }] },
    ])
      expect(stationListSchema.safeParse(value).success).toBe(false)
    expect(
      stationListSchema.safeParse({ ...list, revision: 0, stations: [], routes: [], routeCount: 0 })
        .success
    ).toBe(true)
  })
})
describe('station HTTP authority and exact confirmations', () => {
  it('gates new configuration while preserving historical recovery during pause', () => {
    for (const onlinePilot of [true, false]) {
      expect(publicReleaseAccess('/api/pos/kitchen-stations', 'GET', onlinePilot)).toBe(
        onlinePilot ? 'allow' : 'unavailable'
      )
      expect(publicReleaseAccess('/api/pos/kitchen-stations', 'POST', onlinePilot)).toBe(
        onlinePilot ? 'allow' : 'unavailable'
      )
      expect(publicReleaseAccess('/api/pos/kitchen-stations/recovery', 'POST', onlinePilot)).toBe(
        'allow'
      )
    }
  })
  it('gates current reads/writes, preserves origin-bound historical recovery during pause', async () => {
    vi.stubEnv('POS_ONLINE_PILOT', 'false')
    expect((await GET(read())).status).toBe(503)
    expect((await POST(req(command))).status).toBe(503)
    expect(m.auth).not.toHaveBeenCalled()
    expect((await RECOVER(req(command))).status).toBe(200)
    expect(m.device).not.toHaveBeenCalled()
    expect(m.rpc).toHaveBeenLastCalledWith('pos_resolve_kitchen_station_request', {
      p_command: command,
      p_binding: 'historical',
    })
  })
  it('rejects missing sessions, foreign origin, cross-site fetches and changed actors', async () => {
    for (const action of [POST, RECOVER]) {
      for (const headers of [
        { origin: 'https://foreign.invalid' },
        { 'sec-fetch-site': 'cross-site' },
        { 'x-pos-actor': id(9) },
        { 'x-pos-actor': '' },
      ] as Record<string, string>[])
        expect((await action(req(command, headers))).status).toBe(403)
    }
    expect(m.rpc).not.toHaveBeenCalled()
    m.auth.mockRejectedValue(new PosServerError('authentication_required', 401))
    for (const action of [POST, RECOVER]) expect((await action(req(command))).status).toBe(401)
    expect((await GET(read())).status).toBe(401)
  })
  it('requires current device for reads and writes, historical binding for recovery', async () => {
    m.device.mockRejectedValue(new PosServerError('device_binding_required', 403))
    expect((await GET(read())).status).toBe(403)
    expect((await POST(req(command))).status).toBe(403)
    expect((await RECOVER(req(command))).status).toBe(200)
    m.recovery.mockRejectedValue(new PosServerError('device_binding_required', 403))
    expect((await RECOVER(req(command))).status).toBe(403)
  })
  it('sends the exact unchanged command and returns private responses', async () => {
    const response = await POST(req(command))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(ack)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(m.device).toHaveBeenCalledWith(expect.anything(), branch, device, actor)
    expect(m.rpc).toHaveBeenCalledWith('pos_execute_kitchen_station_command', {
      p_command: command,
      p_binding: 'current',
    })
  })
  it('checks every saved station and route acknowledgement field and cancellation identity', async () => {
    for (const malformed of [
      { ...ack, requestId: id(9) },
      { ...ack, branchId: id(9) },
      { ...ack, revision: 2 },
      { ...ack, station: { ...station, id: id(9) } },
      { ...ack, station: { ...station, name: 'Other' } },
      { ...ack, station: { ...station, active: false } },
      { ...ack, station: null, route: list.routes[0] },
    ]) {
      m.rpc.mockResolvedValue({ data: malformed, error: null })
      expect((await POST(req(command))).status).toBe(503)
      expect((await RECOVER(req(command))).status).toBe(503)
    }
    for (const stationId of [station.id, null]) {
      const input = { ...routeCommand, stationId }
      const result = {
        ...ack,
        requestId: input.id,
        revision: 2,
        station: null,
        route: { productId: input.productId, stationId },
      }
      m.rpc.mockResolvedValue({ data: result, error: null })
      expect((await POST(req(input))).status).toBe(200)
      for (const route of [
        { ...result.route, productId: id(9) },
        { ...result.route, stationId: id(9) },
      ]) {
        m.rpc.mockResolvedValue({ data: { ...result, route }, error: null })
        expect((await POST(req(input))).status).toBe(503)
      }
    }
    const cancelled = {
      status: 'cancelled',
      requestId: command.id,
      branchId: branch,
      replayed: true,
    }
    m.rpc.mockResolvedValue({ data: cancelled, error: null })
    expect((await RECOVER(req(command))).status).toBe(200)
    expect((await POST(req(command))).status).toBe(503)
    m.rpc.mockResolvedValue({ data: { ...cancelled, branchId: id(9) }, error: null })
    expect((await RECOVER(req(command))).status).toBe(503)
  })
  it('preserves original replay snapshots rather than fetching current configuration', async () => {
    m.rpc.mockResolvedValue({ data: { ...ack, replayed: true }, error: null })
    expect((await RECOVER(req(command))).status).toBe(200)
    expect(m.rpc).toHaveBeenCalledTimes(1)
  })
  it('checks full first-page counts, later exclusive cursor and query bounds', async () => {
    m.rpc.mockResolvedValue({ data: list, error: null })
    expect((await GET(read())).status).toBe(200)
    expect(m.rpc).toHaveBeenLastCalledWith('pos_list_kitchen_stations', {
      p_branch: branch,
      p_device: device,
      p_binding: 'current',
      p_after_product: null,
    })
    expect((await GET(read(`&afterProductId=${id(6)}`))).status).toBe(200)
    expect((await GET(read(`&afterProductId=${id(7)}`))).status).toBe(503)
    for (const extra of [
      `&branchId=${branch}`,
      '&unknown=1',
      '&afterProductId=bad',
      `&afterProductId=${id(10).toUpperCase()}`,
    ])
      expect((await GET(read(extra))).status).toBe(422)
    for (const malformed of [
      { ...list, branchId: id(9) },
      { ...list, routeCount: 2 },
      { ...list, routes: [], routeCount: 1 },
    ]) {
      m.rpc.mockResolvedValue({ data: malformed, error: null })
      expect((await GET(read())).status).toBe(503)
    }
    const routes = Array.from({ length: 100 }, (_, i) => ({
      productId: id(i + 100),
      stationId: station.id,
    }))
    m.rpc.mockResolvedValue({
      data: { ...list, routes, routeCount: 101, nextProductId: routes[99].productId },
      error: null,
    })
    expect((await GET(read())).status).toBe(200)
    m.rpc.mockResolvedValue({
      data: { ...list, routes, routeCount: 101, nextProductId: null },
      error: null,
    })
    expect((await GET(read())).status).toBe(503)
  })
  it('rejects invalid, malformed and oversized bodies before any RPC', async () => {
    for (const action of [POST, RECOVER]) {
      expect((await action(req({ ...command, unknown: true }))).status).toBe(422)
      expect((await action(req({ large: '🍲'.repeat(1100) }))).status).toBe(413)
      expect((await action(req(command, { 'content-length': '4097' }))).status).toBe(413)
      const malformed = new Request('http://localhost/api/pos/kitchen-stations', {
        method: 'POST',
        headers: { origin: 'http://localhost', 'x-pos-actor': actor },
        body: '{',
      })
      expect((await action(malformed)).status).toBe(400)
    }
    expect(m.rpc).not.toHaveBeenCalled()
  })
  it.each([
    ['POS_STATION_INVALID', 422],
    ['POS_STATION_PRODUCT_INVALID', 422],
    ['POS_STATION_CONFLICT', 409],
    ['POS_STATION_NAME_CONFLICT', 409],
    ['POS_STATION_CAPACITY', 409],
    ['POS_STATION_ASSIGNED', 409],
    ['POS_STATION_NOT_FOUND', 404],
    ['POS_STATION_NO_CHANGES', 409],
    ['POS_ACCESS_DENIED', 403],
    ['POS_DEVICE_INVALID', 403],
    ['POS_MANAGER_REQUIRED', 403],
    ['POS_IDEMPOTENCY_CONFLICT', 409],
    ['POS_REQUEST_CANCELLED', 409],
    ['POS_STATION_INVALID_UNKNOWN private details', 503],
  ])('maps %s without leaking database details', async (message, status) => {
    m.rpc.mockResolvedValue({ data: null, error: { message } })
    const response = await POST(req(command))
    expect(response.status).toBe(status)
    expect(JSON.stringify(await response.json())).not.toContain(message)
  })
})
