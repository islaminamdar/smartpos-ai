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
import { GET, POST } from '@/app/api/pos/kitchen-station-work/route'
import { GET as IDENTITY } from '@/app/api/pos/session/route'
import { GET as DETAIL } from '@/app/api/pos/kitchen-station-work/detail/route'
import { POST as RECOVER } from '@/app/api/pos/kitchen-station-work/recovery/route'
import {
  stationWorkSchema,
  stationWorkCommandSchema,
  stationWorkNoticeSchema,
  stationWorkListSchema,
} from '@/lib/pos/server/kitchen-station-work'
import { PosServerError } from '@/lib/pos/server/client'
import { publicReleaseAccess } from '@/lib/pos/public-release'
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`
const actor = id(1),
  branch = id(2),
  device = id(3),
  timestamp = '2026-10-16T00:00:00.000001Z'
const line = { productId: id(4), name: 'Tea', unit: 'piece', quantityMilli: 1000 }
const work = {
  id: id(5),
  branchId: branch,
  family: 'paid',
  stationId: null,
  stationName: 'General',
  generation: 1,
  revision: 1,
  orderId: id(6),
  tabId: null,
  ticketId: null,
  invoiceId: id(7),
  invoiceNumber: 'INV-1',
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
  issuedAt: timestamp,
  updatedAt: timestamp,
}
const command = {
  id: id(8),
  branchId: branch,
  deviceId: device,
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
  branchId: branch,
  replayed: false,
  work: { ...work, revision: 2, stages: { ...work.stages, queued: [], preparing: [line] } },
  acknowledgedNoticeId: null,
}
const list = {
  status: 'ready',
  organizationId: id(9),
  branchId: branch,
  actorRole: 'cashier',
  generatedAt: timestamp,
  items: [work],
  matchingCount: 1,
  nextCursor: null,
  attentionCount: 0,
  stations: [
    { stationId: null, name: 'General', active: true, activeCount: 1, pendingNoticeCount: 0 },
  ],
}
const notice = {
  id: id(10),
  workId: work.id,
  sequence: 1,
  kind: 'return',
  createdAt: timestamp,
  reason: 'Guest changed order',
  acknowledgedAt: null,
  source: {
    invoiceId: work.invoiceId,
    invoiceNumber: work.invoiceNumber,
    creditNoteId: id(11),
    creditNumber: 'CR-1',
    fullyReturned: false,
  },
  detail: { lines: [{ ...line, originalLineNumber: 1, remainingQuantityMilli: 1000 }] },
}
const detail = {
  status: 'ready',
  organizationId: id(9),
  branchId: branch,
  actorRole: 'cashier',
  work: { ...work, pendingNoticeCount: 1 },
  notices: [notice],
  noticeCount: 1,
  nextAfterSequence: null,
}
const read = (extra = '', view = 'active') =>
  new Request(
    `http://localhost/api/pos/kitchen-station-work?branchId=${branch}&deviceId=${device}&station=all&view=${view}${extra}`
  )
const readDetail = (extra = '') =>
  new Request(
    `http://localhost/api/pos/kitchen-station-work/detail?branchId=${branch}&deviceId=${device}&workId=${work.id}&noticeView=pending&afterSequence=0${extra}`
  )
const req = (body: unknown = command, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/pos/kitchen-station-work', {
    method: 'POST',
    headers: { origin: 'http://localhost', 'x-pos-actor': actor, ...headers },
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
describe('station workflow authority and durable acknowledgement boundary', () => {
  it('exposes scoped online workflow and keeps historical recovery available when paused', () => {
    for (const pilot of [true, false])
      for (const [path, method] of [
        ['/api/pos/kitchen-station-work', 'GET'],
        ['/api/pos/kitchen-station-work', 'POST'],
        ['/api/pos/kitchen-station-work/detail', 'GET'],
        ['/api/pos/kitchen-station-work/recovery', 'POST'],
      ])
        expect(publicReleaseAccess(path, method, pilot)).toBe(
          path.endsWith('/recovery') || pilot ? 'allow' : 'unavailable'
        )
  })
  it('pauses current actions without blocking historical exact recovery', async () => {
    vi.stubEnv('POS_ONLINE_PILOT', 'false')
    expect((await GET(read())).status).toBe(503)
    expect((await DETAIL(readDetail())).status).toBe(503)
    expect((await POST(req())).status).toBe(503)
    expect(m.auth).not.toHaveBeenCalled()
    expect((await RECOVER(req())).status).toBe(200)
    expect(m.device).not.toHaveBeenCalled()
    expect(m.rpc).toHaveBeenCalledWith('pos_resolve_kitchen_station_work_request', {
      p_command: command,
      p_binding: 'historical',
    })
  })
  it('enforces session, origin, actor and current device independently', async () => {
    for (const action of [POST, RECOVER])
      for (const headers of [
        { origin: 'https://foreign.invalid' },
        { 'sec-fetch-site': 'cross-site' },
        { 'x-pos-actor': id(99) },
        { 'x-pos-actor': '' },
      ] as Record<string, string>[])
        expect((await action(req(command, headers))).status).toBe(403)
    expect(m.rpc).not.toHaveBeenCalled()
    m.device.mockRejectedValue(new PosServerError('device_binding_required', 403))
    expect((await POST(req())).status).toBe(403)
    expect((await GET(read())).status).toBe(403)
    expect((await DETAIL(readDetail())).status).toBe(403)
    expect((await RECOVER(req())).status).toBe(200)
    m.auth.mockRejectedValue(new PosServerError('authentication_required', 401))
    for (const action of [POST, RECOVER]) expect((await action(req())).status).toBe(401)
  })
  it('preserves exact command and private responses, including historical replay', async () => {
    const response = await POST(req())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(ack)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(m.rpc).toHaveBeenCalledWith('pos_execute_kitchen_station_work_command', {
      p_command: command,
      p_binding: 'current',
    })
    m.rpc.mockResolvedValue({ data: { ...ack, replayed: true }, error: null })
    expect((await RECOVER(req())).status).toBe(200)
    expect(m.rpc).toHaveBeenCalledTimes(2)
  })
  it('refuses wrong identity, revision, stage and ACK snapshots', async () => {
    for (const value of [
      { ...ack, requestId: id(99) },
      { ...ack, branchId: id(99) },
      { ...ack, acknowledgedNoticeId: id(10) },
      { ...ack, work: { ...ack.work, id: id(99) } },
      { ...ack, work: { ...ack.work, revision: 3 } },
      { ...ack, work: { ...ack.work, pendingNoticeCount: 1 } },
      { ...ack, work: { ...ack.work, stages: work.stages } },
    ]) {
      m.rpc.mockResolvedValue({ data: value, error: null })
      expect((await POST(req())).status).toBe(503)
      expect((await RECOVER(req())).status).toBe(503)
    }
    const ackCommand = {
      id: id(8),
      branchId: branch,
      deviceId: device,
      workId: work.id,
      expectedRevision: 1,
      type: 'notice.ack',
      noticeId: notice.id,
    }
    m.rpc.mockResolvedValue({ data: { ...ack, acknowledgedNoticeId: notice.id }, error: null })
    expect((await POST(req(ackCommand))).status).toBe(200)
    m.rpc.mockResolvedValue({ data: { ...ack, acknowledgedNoticeId: id(99) }, error: null })
    expect((await POST(req(ackCommand))).status).toBe(503)
    const cancelled = {
      status: 'cancelled',
      requestId: command.id,
      branchId: branch,
      workId: work.id,
      replayed: true,
    }
    m.rpc.mockResolvedValue({ data: cancelled, error: null })
    expect((await RECOVER(req())).status).toBe(200)
    expect((await POST(req())).status).toBe(503)
    m.rpc.mockResolvedValue({ data: { ...cancelled, workId: id(99) }, error: null })
    expect((await RECOVER(req())).status).toBe(503)
  })
  it('rejects bad JSON, oversized payloads and command extras before SQL', async () => {
    for (const action of [POST, RECOVER]) {
      expect((await action(req({ ...command, stationId: id(99) }))).status).toBe(422)
      expect((await action(req({ large: 'x'.repeat(4097) }))).status).toBe(413)
      const invalid = new Request('http://localhost/api/pos/kitchen-station-work', {
        method: 'POST',
        headers: { origin: 'http://localhost', 'x-pos-actor': actor },
        body: '{',
      })
      expect((await action(invalid)).status).toBe(400)
    }
    expect(m.rpc).not.toHaveBeenCalled()
  })
  it.each([
    ['POS_STATION_WORK_INVALID', 422],
    ['POS_STATION_WORK_CONFLICT', 409],
    ['POS_STATION_WORK_NOT_FOUND', 404],
    ['POS_STATION_WORK_NO_CHANGES', 409],
    ['POS_STATION_WORK_NOTICE_PENDING', 409],
    ['POS_STATION_WORK_CLOSED', 409],
    ['POS_ACCESS_DENIED', 403],
    ['POS_MANAGER_REQUIRED', 403],
    ['POS_DEVICE_INVALID', 403],
    ['POS_IDEMPOTENCY_CONFLICT', 409],
    ['POS_REQUEST_CANCELLED', 409],
    ['POS_STATION_WORK_INVALID_UNKNOWN private', 503],
  ])('maps %s without disclosing SQL internals', async (message, status) => {
    m.rpc.mockResolvedValue({ data: null, error: { message } })
    const response = await POST(req())
    expect(response.status).toBe(status)
    expect(JSON.stringify(await response.json())).not.toContain(message)
  })
})
describe('station work wire and complete paging', () => {
  it('rejects noncanonical commands and impossible transitions without rewriting them', () => {
    for (const value of [
      { ...command, id: id(10).toUpperCase() },
      { ...command, expectedRevision: '1' },
      { ...command, expectedRevision: 0 },
      { ...command, expectedRevision: 2147483647 },
      { ...command, to: 'served' },
      { ...command, from: 'preparing', to: 'queued' },
      { ...command, reason: ' padded ' },
      { ...command, from: command.to },
    ])
      expect(stationWorkCommandSchema.safeParse(value).success).toBe(false)
    const backwards = { ...command, from: 'ready', to: 'preparing', reason: 'Remake requested' }
    expect(stationWorkCommandSchema.parse(backwards)).toEqual(backwards)
  })
  it('keeps old cancelled generations separate from new paid work', () => {
    const old = {
      ...work,
      family: 'tab',
      tabId: id(12),
      ticketId: id(13),
      state: 'cancelled',
      payment: 'unpaid',
      orderId: null,
      invoiceId: null,
      invoiceNumber: null,
      metadata: { ...work.metadata, label: 'Table 4', note: '' },
      stages: { queued: [], preparing: [], ready: [], served: [] },
      pendingNoticeCount: 1,
    }
    expect(stationWorkSchema.safeParse(old).success).toBe(true)
    for (const bad of [
      { ...old, invoiceId: id(7) },
      { ...old, stages: work.stages },
      { ...old, metadata: { ...old.metadata, label: null } },
      { ...work, stationName: 'Grill' },
      { ...work, stationId: id(14) },
      { ...work, generation: 2 },
      { ...work, stages: { ...work.stages, served: [line] } },
      { ...work, updatedAt: '2026-10-16T00:00:00.000000Z' },
    ])
      expect(stationWorkSchema.safeParse(bad).success).toBe(false)
  })
  it('accepts a grouped duplicate-product invoice up to200m but rejects invalid whole units', () => {
    expect(
      stationWorkSchema.safeParse({
        ...work,
        stages: { ...work.stages, queued: [{ ...line, quantityMilli: 200_000_000 }] },
      }).success
    ).toBe(true)
    expect(
      stationWorkSchema.safeParse({
        ...work,
        stages: { ...work.stages, queued: [{ ...line, quantityMilli: 1001 }] },
      }).success
    ).toBe(false)
  })
  it('checks full selected page, station scope, totals and cursor filters', async () => {
    m.rpc.mockResolvedValue({ data: list, error: null })
    expect((await GET(read())).status).toBe(200)
    expect(m.rpc).toHaveBeenLastCalledWith('pos_list_kitchen_station_work', {
      p_branch: branch,
      p_device: device,
      p_binding: 'current',
      p_query: { station: 'all', view: 'active', cursor: null },
    })
    for (const extra of [
      '&unknown=1',
      `&branchId=${branch}`,
      '&cursorAt=bad',
      `&cursorId=${id(20)}`,
    ])
      expect((await GET(read(extra))).status).toBe(422)
    for (const value of [
      { ...list, branchId: id(99) },
      { ...list, matchingCount: 2 },
      { ...list, nextCursor: { at: timestamp, id: work.id } },
      { ...list, items: [] },
      { ...list, stations: [] },
      { ...list, items: [work, work], matchingCount: 2 },
    ]) {
      m.rpc.mockResolvedValue({ data: value, error: null })
      expect((await GET(read())).status).toBe(503)
    }
    expect(
      stationWorkListSchema.safeParse({ ...list, stations: [...list.stations, ...list.stations] })
        .success
    ).toBe(false)
  })
  it('uses microseconds before UUID when verifying exclusive cursor order', async () => {
    const earlier = {
      ...work,
      id: id(100),
      issuedAt: '2026-10-16T00:00:00.000001Z',
      updatedAt: '2026-10-16T00:00:00.000002Z',
    }
    const later = {
      ...work,
      id: id(99),
      issuedAt: '2026-10-16T00:00:00.000002Z',
      updatedAt: '2026-10-16T00:00:00.000003Z',
    }
    m.rpc.mockResolvedValue({
      data: { ...list, items: [earlier, later], matchingCount: 2 },
      error: null,
    })
    expect((await GET(read())).status).toBe(200)
    m.rpc.mockResolvedValue({
      data: { ...list, items: [later, earlier], matchingCount: 2 },
      error: null,
    })
    expect((await GET(read())).status).toBe(503)
    m.rpc.mockResolvedValue({ data: { ...list, items: [later] }, error: null })
    expect((await GET(read(`&cursorAt=${earlier.issuedAt}&cursorId=${earlier.id}`))).status).toBe(
      200
    )
    expect((await GET(read(`&cursorAt=${later.issuedAt}&cursorId=${later.id}`))).status).toBe(503)
  })
  it('does not hide a101st active or historical work row', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ ...work, id: id(100 + i) }))
    m.rpc.mockResolvedValue({
      data: {
        ...list,
        items: rows,
        matchingCount: 101,
        nextCursor: { at: timestamp, id: rows[99].id },
      },
      error: null,
    })
    expect((await GET(read())).status).toBe(200)
    m.rpc.mockResolvedValue({ data: { ...list, items: rows, matchingCount: 101 }, error: null })
    expect((await GET(read())).status).toBe(503)
    const history = rows
      .toReversed()
      .map((row) => ({ ...row, stages: { ...row.stages, queued: [], served: [line] } }))
    m.rpc.mockResolvedValue({
      data: {
        ...list,
        items: history,
        matchingCount: 101,
        nextCursor: { at: timestamp, id: history[99].id },
      },
      error: null,
    })
    expect((await GET(read('', 'history'))).status).toBe(200)
    expect((await GET(read())).status).toBe(503)
  })
  it('rejects foreign or hidden notice content, quantities and incomplete pending pages', async () => {
    m.rpc.mockResolvedValue({ data: detail, error: null })
    expect((await DETAIL(readDetail())).status).toBe(200)
    expect(m.rpc).toHaveBeenLastCalledWith('pos_get_kitchen_station_work', {
      p_branch: branch,
      p_device: device,
      p_binding: 'current',
      p_work: work.id,
      p_query: { noticeView: 'pending', afterSequence: 0 },
    })
    for (const value of [
      { ...detail, noticeCount: 2 },
      { ...detail, notices: [] },
      { ...detail, notices: [{ ...notice, acknowledgedAt: timestamp }] },
      { ...detail, notices: [{ ...notice, workId: id(99) }] },
      { ...detail, notices: [{ ...notice, source: { ...notice.source, invoiceId: id(99) } }] },
      { ...detail, notices: [{ ...notice, detail: { ...notice.detail, customer: 'private' } }] },
    ]) {
      m.rpc.mockResolvedValue({ data: value, error: null })
      expect((await DETAIL(readDetail())).status).toBe(503)
    }
    for (const value of [
      { ...notice, source: { ...notice.source, fullyReturned: true } },
      { ...notice, detail: { lines: [{ ...notice.detail.lines[0], remainingQuantityMilli: 1 }] } },
      { ...notice, detail: { lines: [notice.detail.lines[0], notice.detail.lines[0]] } },
    ])
      expect(stationWorkNoticeSchema.safeParse(value).success).toBe(false)
    expect((await DETAIL(readDetail('&afterSequence=1'))).status).toBe(422)
  })
})

it('keeps final-order cancellation quantities distinct from credit-note quantities', async () => {
  const cancellation = {
    ...notice,
    kind: 'cancel',
    source: { ...notice.source, fullyReturned: true },
    detail: { lines: [line] },
  }
  expect(stationWorkNoticeSchema.safeParse(cancellation).success).toBe(true)
  expect(
    stationWorkNoticeSchema.safeParse({ ...cancellation, source: notice.source }).success
  ).toBe(false)
  expect(
    stationWorkNoticeSchema.safeParse({ ...cancellation, detail: notice.detail }).success
  ).toBe(false)
  expect(
    stationWorkNoticeSchema.safeParse({ ...cancellation, detail: { lines: [] } }).success
  ).toBe(false)
  m.rpc.mockResolvedValue({
    data: {
      ...detail,
      work: {
        ...detail.work,
        state: 'cancelled',
        payment: 'refunded',
        stages: { queued: [], preparing: [], ready: [], served: [] },
      },
      notices: [cancellation],
    },
    error: null,
  })
  expect((await DETAIL(readDetail())).status).toBe(200)
})

it('accepts existing PostgreSQL Unicode character limits without rewriting names', () => {
  const unicodeWork = {
    ...work,
    family: 'tab',
    tabId: id(12),
    ticketId: id(13),
    metadata: { ...work.metadata, label: '🍲'.repeat(120), note: '🍲'.repeat(400) },
    stages: { ...work.stages, queued: [{ ...line, name: '🍲'.repeat(200) }] },
  }
  expect(stationWorkSchema.parse(unicodeWork)).toEqual(unicodeWork)
  expect(
    stationWorkSchema.safeParse({
      ...unicodeWork,
      metadata: { ...unicodeWork.metadata, note: '🍲'.repeat(401) },
    }).success
  ).toBe(false)
  const correction = { ...command, from: 'preparing', to: 'queued', reason: '🍲'.repeat(240) }
  expect(stationWorkCommandSchema.parse(correction)).toEqual(correction)
  expect(stationWorkCommandSchema.safeParse({ ...correction, reason: 'bad\nreason' }).success).toBe(
    false
  )
})

it('preserves valid legacy reason text so a station notice can be acknowledged', async () => {
  const reason = 'Damaged\npackaging\tchecked'
  const value = { ...detail, notices: [{ ...notice, reason }] }
  m.rpc.mockResolvedValue({ data: value, error: null })
  expect((await DETAIL(readDetail())).status).toBe(200)
  expect(stationWorkNoticeSchema.parse(value.notices[0]).reason).toBe(reason)
  expect(stationWorkCommandSchema.safeParse({ ...command, reason }).success).toBe(false)
})
it('allows identity discovery but no fresh login or station action during pause', () => {
  expect(publicReleaseAccess('/api/pos/session', 'GET', false)).toBe('allow')
  expect(publicReleaseAccess('/api/pos/session', 'POST', false)).toBe('unavailable')
  expect(publicReleaseAccess('/api/pos/session', 'DELETE', false)).toBe('unavailable')
  expect(publicReleaseAccess('/api/pos/kitchen-station-work/recovery', 'GET', false)).toBe(
    'not_found'
  )
})

it('discovers only authenticated identity while selling is paused', async () => {
  vi.stubEnv('POS_ONLINE_PILOT', 'false')
  const response = await IDENTITY()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'authenticated', userId: actor })
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  m.auth.mockRejectedValue(new PosServerError('authentication_required', 401))
  expect((await IDENTITY()).status).toBe(401)
  expect(publicReleaseAccess('/counter', 'GET', false)).toBe('allow')
  expect(publicReleaseAccess('/counter', 'POST', false)).toBe('not_found')
  expect(publicReleaseAccess('/api/pos/sync', 'POST', false)).toBe('unavailable')
})
