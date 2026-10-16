// Actual isolated PostgreSQL roles/ledger with production route handlers.
// Only authentication/cookies and Supabase transport are mocked; never production.
import { beforeAll, afterAll, it, expect, vi } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
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
import { POST as recovery } from '@/app/api/pos/inventory/recovery/route'
import { inventoryResultSchema, type StockItem, type InventoryCommand } from '@/lib/pos/inventory'
interface Client {
  connect(): Promise<void>
  end(): Promise<void>
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, any>[] }>
}
let control: Client | undefined,
  db: Client | undefined,
  database: string | undefined,
  stock: StockItem,
  lostReply = false,
  savedCount: InventoryCommand
const ids = Object.fromEntries(
  ['actor', 'org', 'branch', 'device', 'item'].map((k) => [k, randomUUID()])
)
const scalar = async (sql: string, args: unknown[] = []) =>
  Object.values((await db!.query(sql, args)).rows[0])[0]
const request = (value: unknown) =>
  new Request('http://localhost/api/pos/inventory', {
    method: 'POST',
    headers: {
      origin: 'http://localhost',
      'content-type': 'application/json',
      'x-pos-actor': ids.actor,
    },
    body: JSON.stringify(value),
  })
const make = (
  type: 'stock.count' | 'stock.receive' | 'stock.waste' | 'stock.adjust',
  quantityMilli: number
): InventoryCommand => ({
  id: randomUUID(),
  type,
  branchId: ids.branch,
  deviceId: ids.device,
  itemId: stock.id,
  expectedRevision: stock.revision,
  quantityMilli,
  reason: 'Synthetic stock verification',
  reference: 'TEST-DELIVERY',
})
const apply = async (command: InventoryCommand) => {
  const r = await POST(request(command))
  expect(r.status).toBe(200)
  const b = inventoryResultSchema.parse(await r.json())
  expect(b.status).toBe('applied')
  if (b.status === 'applied') stock = b.item
  return b
}
const read = () => GET(new Request(`http://localhost/api/pos/inventory?branchId=${ids.branch}`))
beforeAll(async () => {
  const socket = process.env.OFFLINE_TEST_PG_SOCKET,
    entry = process.env.OFFLINE_TEST_PG_ENTRY
  if (!socket?.startsWith('/tmp/pos-qa-pg-') || socket.includes('..') || !entry)
    throw new Error('Only isolated QA Unix socket accepted')
  const imported = await import(/* @vite-ignore */ pathToFileURL(entry).href),
    Constructor = (imported.default ?? imported).Client,
    options = { host: socket, port: 55432, user: process.env.USER, connectionTimeoutMillis: 5000 }
  control = new Constructor({ ...options, database: 'postgres' })
  await control!.connect()
  database = 'pos_inventory_http_' + randomUUID().replaceAll('-', '')
  await control!.query(`create database ${database}`)
  db = new Constructor({ ...options, database })
  await db!.connect()
  await db!.query(
    `create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`
  )
  for (const f of (await readdir('supabase/migrations'))
    .filter((n) => /^20261016/.test(n) && !n.includes('007'))
    .sort())
    await db!.query(await readFile('supabase/migrations/' + f, 'utf8'))
  await db!.query(`insert into auth.users values($1,'synthetic-stock@example.test',now())`, [
    ids.actor,
  ])
  await db!.query(`insert into pos_organizations(id,legal_name) values($1,'Synthetic stock QA')`, [
    ids.org,
  ])
  await db!.query(
    `insert into pos_branches(id,organization_id,name) values($1,$2,'Synthetic branch')`,
    [ids.branch, ids.org]
  )
  await db!.query(
    `insert into pos_staff(organization_id,user_id,branch_id,role,display_name) values($1,$2,$3,'manager','Test manager')`,
    [ids.org, ids.actor, ids.branch]
  )
  await db!.query(
    `insert into pos_devices(id,organization_id,branch_id,name) values($1,$2,$3,'Test counter')`,
    [ids.device, ids.org, ids.branch]
  )
  await db!.query(
    `insert into pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)`,
    ['a'.repeat(64), ids.actor, ids.org, ids.branch, ids.device]
  )
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  vi.stubEnv('POS_PUBLIC_ORIGIN', 'http://localhost')
  m.device.mockResolvedValue('a'.repeat(64))
  m.recovery.mockResolvedValue('a'.repeat(64))
  m.auth.mockResolvedValue({ user: { id: ids.actor }, client: { rpc: m.rpc } })
  m.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (
      ![
        'pos_inventory',
        'pos_inventory_history',
        'pos_manage_inventory',
        'pos_inventory_request',
      ].includes(name)
    )
      throw new Error('Unexpected RPC')
    await db!.query('set role authenticated')
    await db!.query("select set_config('app.user_id',$1,false)", [ids.actor])
    try {
      const keys = Object.keys(args),
        data = await scalar(
          `select public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')})`,
          keys.map((k) =>
            args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]
          )
        )
      if (name === 'pos_manage_inventory' && lostReply) {
        lostReply = false
        throw new Error('Lost synthetic reply after committed movement')
      }
      return { data, error: null }
    } catch (error) {
      return { data: null, error: { message: String(error) } }
    } finally {
      await db!.query('reset role')
    }
  })
})
afterAll(async () => {
  await db?.end()
  if (database) await control?.query(`drop database ${database}`)
  await control?.end()
  vi.unstubAllEnvs()
})
it('creates an uncounted item with no invented stock movement or financial mutation', async () => {
  const command: InventoryCommand = {
    id: randomUUID(),
    type: 'item.save',
    branchId: ids.branch,
    deviceId: ids.device,
    expectedRevision: 0,
    reason: 'Synthetic ingredient setup',
    item: {
      id: ids.item,
      name: 'Sugar',
      sku: 'SUGAR',
      unit: 'kg',
      reorderLevelMilli: 5000,
      active: true,
    },
  }
  const r = await apply(command)
  expect(r.status === 'applied' && r.item.onHandMilli).toBeNull()
  expect(Number(await scalar('select count(*) from pos_stock_movements'))).toBe(0)
  const list = await (await read()).json()
  expect(list.counts).toEqual({
    totalItems: 1,
    activeItems: 1,
    inactiveItems: 0,
    lowStockItems: 0,
    uncountedItems: 1,
  })
  expect((await POST(request(make('stock.receive', 1000)))).status).toBe(409)
  for (const table of ['pos_orders', 'pos_payments', 'pos_documents', 'pos_cash_movements'])
    expect(Number(await scalar('select count(*) from ' + table))).toBe(0)
})
it('records first physical count with unknown delta and exact kg movements', async () => {
  savedCount = make('stock.count', 3125)
  const r = await apply(savedCount)
  expect(r.status === 'applied' && r.movement?.beforeMilli).toBeNull()
  expect(r.status === 'applied' && r.movement?.deltaMilli).toBeNull()
  await apply(make('stock.receive', 1200))
  await apply(make('stock.waste', 500))
  await apply(make('stock.adjust', -1))
  expect(stock.onHandMilli).toBe(3824)
  const count = await apply(make('stock.count', 3800))
  expect(count.status === 'applied' && count.movement?.deltaMilli).toBe(-24)
  const list = await (await read()).json()
  expect(list.counts.lowStockItems).toBe(1)
  expect(list.counts.uncountedItems).toBe(0)
  const h = await history(
    new Request(
      `http://localhost/api/pos/inventory/history?branchId=${ids.branch}&itemId=${ids.item}`
    )
  )
  expect(h.status).toBe(200)
  const detail = await h.json()
  expect(detail.entries).toHaveLength(5)
  expect(detail.entries[0].actorName).toBe('Test manager')
  expect(detail.entries[0].deviceName).toBe('Test counter')
})
it('recovers lost receipt of a stock update without incrementing again', async () => {
  const command = make('stock.receive', 1000)
  lostReply = true
  expect((await POST(request(command))).status).toBe(503)
  const response = await recovery(request({ mode: 'lookup', command }))
  expect(response.status).toBe(200)
  const recovered = inventoryResultSchema.parse(await response.json())
  expect(recovered.status).toBe('applied')
  if (recovered.status === 'applied') {
    expect(recovered.item.onHandMilli).toBe(4800)
    stock = recovered.item
  }
  const replay = await apply(command)
  expect(replay.replayed).toBe(true)
  expect(Number(await scalar('select count(*) from pos_stock_movements'))).toBe(6)
})
it('definitively cancels a rejected overdraw and prevents delayed retry after later replenishment', async () => {
  const command = make('stock.waste', 9000)
  expect((await POST(request(command))).status).toBe(409)
  const missing = await recovery(request({ mode: 'lookup', command }))
  expect((await missing.json()).status).toBe('not_found')
  const cancelled = await recovery(request({ mode: 'cancel', command }))
  expect((await cancelled.json()).status).toBe('cancelled')
  await apply(make('stock.receive', 10000))
  const retry = await POST(request(command))
  expect((await retry.json()).status).toBe('cancelled')
  expect(
    await scalar('select on_hand_milli::float8 from pos_stock_items where id=$1', [ids.item])
  ).toBe(14800)
})
it('does not reinterpret existing unit, old result or snapshots after later changes', async () => {
  const cmd: InventoryCommand = {
    id: randomUUID(),
    type: 'item.save',
    branchId: ids.branch,
    deviceId: ids.device,
    expectedRevision: stock.revision,
    reason: 'Synthetic invalid unit',
    item: {
      id: stock.id,
      name: 'Sugar',
      sku: 'SUGAR',
      unit: 'litre',
      reorderLevelMilli: 5000,
      active: true,
    },
  }
  expect((await POST(request(cmd))).status).toBe(422)
  const old = await recovery(request({ mode: 'cancel', command: savedCount }))
  const result = await old.json()
  expect(result.status).toBe('applied')
  expect(result.item.onHandMilli).toBe(3125)
  expect(
    await scalar('select on_hand_milli::float8 from pos_stock_items where id=$1', [ids.item])
  ).toBe(14800)
})
it('preserves SQL-valid immutable Unicode labels and direct-RPC text across HTTP reads and recovery', async () => {
  const actorName = '\t' + '😀'.repeat(119),
    deviceName = '\t' + '😀'.repeat(79)
  await db!.query('update pos_staff set display_name=$1 where user_id=$2', [actorName, ids.actor])
  await db!.query('update pos_devices set name=$1 where id=$2', [deviceName, ids.device])
  const ordinary = make('stock.receive', 1),
    applied = await apply(ordinary)
  expect(applied.status === 'applied' && applied.movement?.actorName).toBe(actorName)
  expect(applied.status === 'applied' && applied.movement?.deviceName).toBe(deviceName)
  const ack = await recovery(request({ mode: 'lookup', command: ordinary }))
  expect(ack.status).toBe(200)
  expect((await ack.json()).movement.actorName).toBe(actorName)
  const itemId = randomUUID(),
    name = '\t' + '😀'.repeat(159),
    reason = '\t' + '😀'.repeat(239),
    reference = '\t' + '😀'.repeat(119)
  const create = {
    id: randomUUID(),
    type: 'item.save',
    branchId: ids.branch,
    deviceId: ids.device,
    expectedRevision: 0,
    reason,
    item: { id: itemId, name, sku: null, unit: 'kg', reorderLevelMilli: 0, active: true },
  }
  const created = await m.rpc('pos_manage_inventory', {
    p_command: create,
    p_binding: 'a'.repeat(64),
  })
  expect(created.error).toBeNull()
  expect(inventoryResultSchema.parse(created.data).status).toBe('applied')
  const count = {
    id: randomUUID(),
    type: 'stock.count',
    branchId: ids.branch,
    deviceId: ids.device,
    itemId,
    expectedRevision: 1,
    quantityMilli: 0,
    reason,
    reference,
  }
  const recorded = await m.rpc('pos_manage_inventory', {
    p_command: count,
    p_binding: 'a'.repeat(64),
  })
  expect(recorded.error).toBeNull()
  expect(inventoryResultSchema.parse(recorded.data).status).toBe('applied')
  const recovered = await m.rpc('pos_inventory_request', {
    p_mode: 'lookup',
    p_command: count,
    p_binding: 'a'.repeat(64),
  })
  expect(recovered.error).toBeNull()
  const parsed = inventoryResultSchema.parse(recovered.data)
  expect(parsed.status === 'applied' && parsed.movement?.reason).toBe(reason)
  const response = await read()
  expect(response.status).toBe(200)
  expect((await response.json()).items.find((item: StockItem) => item.id === itemId).name).toBe(
    name
  )
  const h = await history(
    new Request(
      `http://localhost/api/pos/inventory/history?branchId=${ids.branch}&itemId=${itemId}`
    )
  )
  expect(h.status).toBe(200)
  const snapshot = await h.json()
  expect(snapshot.entries[0].reference).toBe(reference)
  expect(snapshot.entries[0].deviceName).toBe(deviceName)
})
it('retains exact own historical recovery after staff/device revocation without granting stock read or write', async () => {
  await db!.query('update pos_staff set active=false where user_id=$1', [ids.actor])
  await db!.query('update pos_devices set active=false where id=$1', [ids.device])
  await db!.query('update pos_device_bindings set revoked_at=now() where device_id=$1', [
    ids.device,
  ])
  expect((await read()).status).toBe(403)
  expect((await POST(request(make('stock.receive', 1000)))).status).toBe(403)
  vi.stubEnv('POS_ONLINE_PILOT', 'false')
  const r = await recovery(request({ mode: 'lookup', command: savedCount }))
  expect(r.status).toBe(200)
  expect((await r.json()).item.onHandMilli).toBe(3125)
})
