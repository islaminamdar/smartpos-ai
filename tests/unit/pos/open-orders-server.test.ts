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
import { GET, POST } from '@/app/api/pos/open-orders/route'
import { POST as RECOVER } from '@/app/api/pos/open-orders/recovery/route'
import { PosServerError } from '@/lib/pos/server/client'
import {
  openOrderCommandSchema,
  openOrderTabSchema,
  openOrderListSchema,
} from '@/lib/pos/server/open-order-contracts'
import { publicReleaseAccess } from '@/lib/pos/public-release'
import { settlementMatchesSale } from '@/lib/pos/server/sale-ack'
import { basketFromOpenOrder, openOrderBasketMatches } from '@/lib/pos/open-order-basket'
import type { LiveOrder } from '@/lib/pos/server/live-contracts'
const id = (n: number) => `${n.toString().padStart(8, '0')}-0000-4000-8000-000000000001`
const actor = id(1),
  branch = id(2),
  device = id(3),
  tabId = id(4),
  requestId = id(5),
  stamp = '2026-10-16T00:00:00Z'
const lines = [
  {
    productId: id(7),
    quantityMilli: 1000,
    expectedUnitPriceFils: 1050,
    expectedTaxRateBps: 500,
    expectedRevision: 1,
  },
]
const command = {
  id: requestId,
  branchId: branch,
  deviceId: device,
  type: 'tab.save',
  tabId,
  expectedRevision: 0,
  label: 'Table 1 lunch',
  serviceType: 'dine_in',
  tableId: id(8),
  guestCount: 2,
  note: 'No cutlery',
  lines,
}
const tab = {
  id: tabId,
  branchId: branch,
  revision: 1,
  status: 'open',
  label: command.label,
  serviceType: 'dine_in',
  tableId: id(8),
  guestCount: 2,
  note: 'No cutlery',
  lines: [
    {
      productId: id(7),
      name: 'Synthetic dish',
      category: 'Mains',
      imageUrl: null,
      unit: 'piece',
      quantityMilli: 1000,
      unitPriceFils: 1050,
      taxRateBps: 500,
      revision: 1,
    },
  ],
  subtotalFils: 1050,
  taxFils: 50,
  createdBy: actor,
  updatedBy: actor,
  createdAt: stamp,
  updatedAt: stamp,
  settledOrderId: null,
}
const table = {
  id: id(8),
  branchId: branch,
  name: 'Table 1',
  area: 'Main',
  seats: 4,
  active: true,
  revision: 1,
  createdAt: stamp,
  updatedAt: stamp,
  occupiedTabId: tabId,
}
const ack = { status: 'updated', requestId, replayed: false, tab }
const list = {
  status: 'ready',
  organizationId: id(9),
  branchId: branch,
  actorRole: 'manager',
  generatedAt: stamp,
  tables: [table],
  openTabs: [tab],
  openCount: 1,
  openNextCursor: null,
  recentTabs: [],
  recentTruncated: false,
}
const read = (extra = '') =>
  new Request(`http://localhost/api/pos/open-orders?branchId=${branch}&deviceId=${device}${extra}`)
const req = (body: unknown, origin = 'http://localhost') =>
  new Request('http://localhost/api/pos/open-orders', {
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
  m.device.mockResolvedValue('binding')
  m.recovery.mockResolvedValue('historical')
  m.rpc.mockResolvedValue({ data: ack, error: null })
})
describe('shared unpaid-order trust boundaries', () => {
  it('requires pilot, sign-in, same origin and bound device, preserving historical recovery', async () => {
    vi.stubEnv('POS_ONLINE_PILOT', 'false')
    expect((await GET(read())).status).toBe(503)
    expect(m.auth).not.toHaveBeenCalled()
    vi.stubEnv('POS_ONLINE_PILOT', 'true')
    expect((await POST(req(command, 'https://foreign.invalid'))).status).toBe(403)
    expect((await RECOVER(req(command, 'https://foreign.invalid'))).status).toBe(403)
    m.device.mockRejectedValue(new PosServerError('device_binding_required', 403))
    expect((await GET(read())).status).toBe(403)
    expect((await POST(req(command))).status).toBe(403)
    expect((await RECOVER(req(command))).status).toBe(200)
    expect(m.rpc).toHaveBeenCalledWith('pos_resolve_tab_request', {
      p_command: command,
      p_binding: 'historical',
    })
    m.auth.mockRejectedValue(new PosServerError('authentication_required', 401))
    expect((await GET(read())).status).toBe(401)
  })
  it('validates cursor pairs and scoped detail without leaking raw data', async () => {
    m.rpc.mockResolvedValue({ data: list, error: null })
    const response = await GET(read())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual(list)
    expect((await GET(read(`&afterCreatedAt=${stamp}&afterId=${tabId}`))).status).toBe(200)
    expect(m.rpc).toHaveBeenLastCalledWith('pos_list_tabs', {
      p_branch: branch,
      p_binding: 'binding',
      p_cursor: { createdAt: stamp, id: tabId },
    })
    for (const extra of [
      `&afterId=${tabId}`,
      `&tabId=${tabId}&afterId=${tabId}&afterCreatedAt=${stamp}`,
      `&branchId=${branch}`,
      '&unknown=true',
    ])
      expect((await GET(read(extra))).status).toBe(422)
    m.rpc.mockResolvedValue({
      data: { status: 'ready', organizationId: id(9), branchId: branch, actorRole: 'cashier', tab },
      error: null,
    })
    expect((await GET(read(`&tabId=${tabId}`))).status).toBe(200)
    expect(m.rpc).toHaveBeenLastCalledWith('pos_get_tab', {
      p_branch: branch,
      p_tab: tabId,
      p_binding: 'binding',
    })
    expect((await GET(read(`&tabId=${id(99)}`))).status).toBe(503)
  })
  it('rejects mixed branches, impossible counts, occupancy, estimates and unapproved private fields', async () => {
    for (const malformed of [
      { ...list, branchId: id(99) },
      { ...list, openCount: 0 },
      { ...list, tables: [{ ...table, occupiedTabId: null }] },
      { ...list, tables: [table, table] },
      { ...list, openTabs: [{ ...tab, status: 'settled' }] },
      { ...list, openNextCursor: { createdAt: stamp, id: id(99) } },
      { ...list, openTabs: [{ ...tab, subtotalFils: 1051 }] },
      { ...list, openTabs: [{ ...tab, customerEmail: 'private@example.invalid' }] },
    ]) {
      m.rpc.mockResolvedValue({ data: malformed, error: null })
      expect((await GET(read())).status).toBe(503)
    }
    // Occupancy is complete even when the occupied order is outside this page.
    expect(openOrderListSchema.safeParse({ ...list, openTabs: [] }).success).toBe(true)
  })
  it('checks every acknowledged command field and revision on ordinary write and replay', async () => {
    expect((await POST(req(command))).status).toBe(200)
    for (const change of [
      { id: id(99) },
      { revision: 2 },
      { label: 'Different bill' },
      { note: 'Other note' },
      { guestCount: 3 },
      { tableId: null },
      { lines: [{ ...tab.lines[0], revision: 2 }] },
      { lines: [{ ...tab.lines[0], quantityMilli: 2000 }], subtotalFils: 2100, taxFils: 100 },
    ]) {
      m.rpc.mockResolvedValue({ data: { ...ack, tab: { ...tab, ...change } }, error: null })
      expect((await POST(req(command))).status).toBe(503)
      expect((await RECOVER(req(command))).status).toBe(503)
    }
    m.rpc.mockResolvedValue({ data: { ...ack, replayed: true }, error: null })
    expect((await RECOVER(req(command))).status).toBe(200)
  })
  it('rejects invalid or oversized commands before RPC and limits allowed public methods', async () => {
    for (const body of [
      { ...command, actorId: actor },
      { ...command, lines: [lines[0], lines[0]] },
      { ...command, serviceType: 'takeaway' },
      { ...command, lines: [{ ...lines[0], expectedRevision: undefined }] },
      { ...command, type: 'tab.reopen', reason: 'reviewed' },
      { ...command, expectedRevision: -1 },
    ])
      expect((await POST(req(body))).status).toBe(422)
    expect((await POST(req({ ...command, note: 'x'.repeat(100001) }))).status).toBe(413)
    expect(m.rpc).not.toHaveBeenCalled()
    expect(publicReleaseAccess('/api/pos/open-orders', 'GET', true)).toBe('allow')
    expect(publicReleaseAccess('/api/pos/open-orders/recovery', 'POST', true)).toBe('allow')
    expect(publicReleaseAccess('/api/pos/open-orders', 'DELETE', true)).toBe('unavailable')
    expect(publicReleaseAccess('/api/pos/open-orders', 'GET', false)).toBe('unavailable')
  })
  it('only accepts exact durable cancellation, and sanitizes database failures', async () => {
    m.rpc.mockResolvedValue({
      data: { status: 'cancelled', requestId, replayed: false },
      error: null,
    })
    expect((await RECOVER(req(command))).status).toBe(200)
    m.rpc.mockResolvedValue({
      data: { status: 'cancelled', requestId: id(99), replayed: false },
      error: null,
    })
    expect((await RECOVER(req(command))).status).toBe(503)
    for (const [message, status] of [
      ['POS_TABLE_OCCUPIED', 409],
      ['POS_MANAGER_REQUIRED', 403],
      ['POS_TAB_NOT_FOUND', 404],
      ['POS_INVALID_TAB_COMMAND', 422],
      ['private database details', 503],
    ] as const) {
      m.rpc.mockResolvedValue({ data: null, error: { message } })
      const response = await POST(req(command))
      expect(response.status).toBe(status)
      expect(JSON.stringify(await response.json())).not.toContain(message)
    }
  })
  it('validates void/reopen distinction, whole-unit quantities and exact table edit ACK', async () => {
    const tableCommand = {
      id: requestId,
      branchId: branch,
      deviceId: device,
      type: 'table.save',
      expectedRevision: 0,
      table: { id: id(8), name: 'Table 1', area: 'Main', seats: 4, active: true },
      reason: 'Opening setup',
    }
    m.rpc.mockResolvedValue({
      data: { status: 'updated', requestId, replayed: false, table },
      error: null,
    })
    expect((await POST(req(tableCommand))).status).toBe(200)
    expect(
      (await POST(req({ ...tableCommand, table: { ...tableCommand.table, seats: 6 } }))).status
    ).toBe(503)
    const voidCommand = {
      id: requestId,
      branchId: branch,
      deviceId: device,
      type: 'tab.void',
      tabId,
      expectedRevision: 1,
      reason: 'Guest left',
    }
    m.rpc.mockResolvedValue({
      data: { ...ack, tab: { ...tab, status: 'voided', revision: 2 } },
      error: null,
    })
    expect((await POST(req(voidCommand))).status).toBe(200)
    expect(
      openOrderCommandSchema.safeParse({
        ...command,
        type: 'tab.reopen',
        expectedRevision: 2,
        reason: 'Guest returned',
      }).success
    ).toBe(true)
    expect(
      openOrderTabSchema.safeParse({
        ...tab,
        lines: [{ ...tab.lines[0], quantityMilli: 250 }],
        subtotalFils: 263,
        taxFils: 13,
      }).success
    ).toBe(false)
    expect(
      openOrderTabSchema.safeParse({
        ...tab,
        lines: [{ ...tab.lines[0], unit: 'kg', quantityMilli: 250 }],
        subtotalFils: 263,
        taxFils: 13,
      }).success
    ).toBe(true)
  })
})
describe('linked saved-order payment', () => {
  it('requires exact canonical settlement link in addition to the fiscal receipt', () => {
    const order = { sourceTab: { id: tabId, expectedRevision: 3 } } as LiveOrder
    expect(settlementMatchesSale(order, {})).toBe(false)
    expect(settlementMatchesSale(order, { settledTab: { id: tabId, revision: 4 } })).toBe(true)
    for (const settledTab of [
      { id: tabId, revision: 3 },
      { id: id(99), revision: 4 },
      { id: tabId, revision: 4, extra: true },
    ])
      expect(settlementMatchesSale(order, { settledTab })).toBe(false)
    expect(settlementMatchesSale({} as LiveOrder, {})).toBe(true)
    expect(settlementMatchesSale({} as LiveOrder, { settledTab: { id: tabId, revision: 4 } })).toBe(
      false
    )
  })
  it('restores saved prices and blocks payment after quantity, service or revision changes and for voided bills', () => {
    const saved = openOrderTabSchema.parse(tab)
    expect(basketFromOpenOrder(saved)[0].product.unitPriceFils).toBe(1050)
    expect(openOrderBasketMatches(saved, 'dine_in', lines)).toBe(true)
    expect(openOrderBasketMatches(saved, 'delivery', lines)).toBe(false)
    expect(openOrderBasketMatches(saved, 'dine_in', [{ ...lines[0], quantityMilli: 2000 }])).toBe(
      false
    )
    expect(openOrderBasketMatches(saved, 'dine_in', [{ ...lines[0], expectedRevision: 2 }])).toBe(
      false
    )
    expect(openOrderBasketMatches({ ...saved, status: 'voided' }, 'dine_in', lines)).toBe(false)
  })
})
