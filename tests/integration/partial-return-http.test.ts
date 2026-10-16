// Production route handlers and real PostgreSQL roles/transactions. Authentication
// and cookie transport are mocked; no real account or external financial action.
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { NextRequest } from 'next/server'
const m = vi.hoisted(() => ({
  actor: '',
  rpc: vi.fn(),
  auth: vi.fn(),
  device: vi.fn(),
  historical: vi.fn(),
}))
vi.mock('@/lib/pos/server/client', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/client')>()),
  authenticatedPosClient: m.auth,
}))
vi.mock('@/lib/pos/server/live-access', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/live-access')>()),
  requireDevice: m.device,
  recoveryBinding: m.historical,
}))
import { GET as readReturn, POST as previewReturn } from '@/app/api/pos/returns/route'
import { POST as executeCommand } from '@/app/api/pos/commands/route'
import { POST as recoverRequest } from '@/app/api/pos/recovery/route'
import { fiscalDocumentSchema } from '@/lib/pos/server/documents'
import {
  returnStateSchema,
  validateReturnPreview,
  returnCreditMatchesCommand,
} from '@/lib/pos/server/returns'
import { canonicalJson } from '@/lib/pos/offline/canonical'
interface PgClient {
  connect(): Promise<void>
  end(): Promise<void>
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, any>[] }>
}
let control: PgClient | undefined, db: PgClient | undefined, database: string | undefined
const ids = Object.fromEntries(
  [
    'owner',
    'cashier',
    'org',
    'branch',
    'device',
    'shift',
    'profile',
    'product',
    'weight',
    'order',
  ].map((k) => [k, randomUUID()])
)
const binding = createHash('sha256').update(randomUUID()).digest('hex')
let invoice: any, preview: any, request: any, command: any, credit: any, originalRows: string
const scalar = async (sql: string, args: unknown[] = []) =>
  Object.values((await db!.query(sql, args)).rows[0])[0]
const url = 'https://pos.example.test'
const post = (path: string, body: unknown) =>
  new NextRequest(url + path, {
    method: 'POST',
    headers: { origin: url, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const original = () =>
  scalar(
    `select jsonb_build_object('orders',(select jsonb_agg(to_jsonb(x)) from public.pos_orders x),'lines',(select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from public.pos_order_lines x),'payments',(select jsonb_agg(to_jsonb(x) order by method) from public.pos_payments x),'invoice',(select snapshot from public.pos_documents where kind='tax_invoice'))::text`
  )
beforeAll(async () => {
  const socket = process.env.OFFLINE_TEST_PG_SOCKET,
    entry = process.env.OFFLINE_TEST_PG_ENTRY
  if (!socket?.startsWith('/tmp/pos-qa-pg-') || socket.includes('..') || !entry)
    throw Error('Private QA Unix socket required')
  const module = await import(/* @vite-ignore */ pathToFileURL(entry).href),
    Client = (module.default ?? module).Client
  const options = {
    host: socket,
    port: 55432,
    user: process.env.USER,
    connectionTimeoutMillis: 5000,
  }
  control = new Client({ ...options, database: 'postgres' })
  await control!.connect()
  expect((await control!.query('select inet_server_addr() is null private')).rows[0].private).toBe(
    true
  )
  database = 'pos_returns_http_' + randomUUID().replaceAll('-', '')
  await control!.query(`create database ${database}`)
  db = new Client({ ...options, database })
  await db!.connect()
  await db!
    .query(`create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`)
  for (const name of (await readdir('supabase/migrations'))
    .filter((n) => /^2026101600(?:0[1-9]|[12][0-9]|30)00_/.test(n))
    .sort())
    await db!.query(await readFile('supabase/migrations/' + name, 'utf8'))
  await db!.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.test',now()),($2,'cashier@example.test',now())",
    [ids.owner, ids.cashier]
  )
  await db!.query(
    "insert into public.pos_organizations(id,legal_name) values($1,'Synthetic returns HTTP')",
    [ids.org]
  )
  await db!.query(
    "insert into public.pos_branches(id,organization_id,name) values($1,$2,'Synthetic')",
    [ids.branch, ids.org]
  )
  await db!.query(
    "insert into public.pos_staff(organization_id,user_id,branch_id,role) values($1,$2,null,'owner'),($1,$3,$4,'cashier')",
    [ids.org, ids.owner, ids.cashier, ids.branch]
  )
  await db!.query(
    "insert into public.pos_devices(id,organization_id,branch_id,name) values($1,$2,$3,'Synthetic counter')",
    [ids.device, ids.org, ids.branch]
  )
  await db!.query(
    'insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)',
    [binding, ids.owner, ids.org, ids.branch, ids.device]
  )
  await db!.query(
    'insert into public.pos_shifts(id,organization_id,branch_id,device_id,opened_by,opening_cash_fils) values($1,$2,$3,$4,$5,10000)',
    [ids.shift, ids.org, ids.branch, ids.device, ids.owner]
  )
  await db!.query(
    "insert into public.pos_merchant_profiles(id,organization_id,branch_id,legal_name,branch_name,address,phone,trn,tax_registered,tax_inclusive,confirmed_by) values($1,$2,$3,'Synthetic','Synthetic','Synthetic','Synthetic','100000000000001',true,true,$4)",
    [ids.profile, ids.org, ids.branch, ids.owner]
  )
  await db!.query("insert into public.pos_branch_receipt_config values($1,$2,$3,'TEST',true)", [
    ids.branch,
    ids.org,
    ids.profile,
  ])
  await db!.query(
    "insert into public.pos_products(id,organization_id,branch_id,name,category,unit,unit_price_fils,tax_rate_bps) values($1,$2,$3,'Piece','Test','piece',101,500),($4,$2,$3,'Weight','Test','kg',103,0)",
    [ids.product, ids.org, ids.branch, ids.weight]
  )
  m.actor = ids.owner
  m.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (!/^[a-z_]+$/.test(name) || Object.keys(args).some((k) => !/^p_[a-z_]+$/.test(k)))
      throw Error('Unsafe test RPC')
    await db!.query("select set_config('app.user_id',$1,false)", [m.actor])
    await db!.query('set role authenticated')
    try {
      const data = await scalar(
        `select public.${name}(${Object.keys(args)
          .map((key, i) => `${key}=>$${i + 1}`)
          .join(',')})`,
        Object.values(args).map((v) =>
          v !== null && typeof v === 'object' ? JSON.stringify(v) : v
        )
      )
      return { data, error: null }
    } catch (error) {
      return { data: null, error: { message: (error as Error).message } }
    } finally {
      await db!.query('reset role')
    }
  })
  m.auth.mockImplementation(async () => ({ client: { rpc: m.rpc }, user: { id: m.actor } }))
  m.device.mockResolvedValue(binding)
  m.historical.mockResolvedValue(binding)
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  vi.stubEnv('POS_LIVE_SALES_ENABLED', 'true')
  vi.stubEnv('POS_PUBLIC_ORIGIN', url)
  const order = {
    id: ids.order,
    branchId: ids.branch,
    deviceId: ids.device,
    shiftId: ids.shift,
    createdAt: new Date().toISOString(),
    serviceType: 'takeaway',
    profileId: ids.profile,
    customer: null,
    cashTenderedFils: 137,
    expectedTotalFils: 337,
    lines: [
      {
        productId: ids.product,
        quantityMilli: 3000,
        expectedUnitPriceFils: 101,
        expectedTaxRateBps: 500,
      },
      {
        productId: ids.weight,
        quantityMilli: 333,
        expectedUnitPriceFils: 103,
        expectedTaxRateBps: 0,
      },
    ],
    payments: [
      { method: 'cash', amountFils: 137 },
      { method: 'card', amountFils: 200 },
    ],
  }
  const created = await m.rpc('pos_record_live_order', { p_order: order, p_binding: binding })
  expect(created.error).toBeNull()
  invoice = created.data.receipt
  originalRows = await original()
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await db?.end()
  if (database && control) await control.query(`drop database ${database}`)
  await control?.end()
})
it('reads actual SQL remaining state and validates the original-components preview through production routes', async () => {
  const response = await readReturn(
    new Request(
      url +
        '/api/pos/returns?' +
        new URLSearchParams({ branchId: ids.branch, deviceId: ids.device, orderId: ids.order })
    )
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toContain('no-store')
  const state = returnStateSchema.parse((await response.json()).state)
  request = {
    branchId: ids.branch,
    deviceId: ids.device,
    shiftId: ids.shift,
    orderId: ids.order,
    invoiceId: invoice.id,
    expectedRevision: 0,
    lines: [{ lineNumber: 1, quantityMilli: 1000 }],
    reason: 'Synthetic return',
  }
  const result = await previewReturn(post('/api/pos/returns', { request }))
  expect(result.status).toBe(200)
  preview = (await result.json()).preview
  expect(validateReturnPreview(state, request, preview)).toEqual(preview)
  const { quoteHash, ...unsigned } = preview
  expect(createHash('sha256').update(canonicalJson(unsigned)).digest('hex')).toBe(quoteHash)
  expect(
    await scalar("select count(*)::int from public.pos_documents where kind='tax_credit_note'")
  ).toBe(0)
})
it('commits and replays one exact v3credit without rewriting invoice/order/payment custody', async () => {
  command = { id: randomUUID(), type: 'refund.items', ...request, quoteHash: preview.quoteHash }
  const result = await executeCommand(post('/api/pos/commands', { command }))
  expect(result.status).toBe(200)
  const ack = await result.json()
  credit = fiscalDocumentSchema.parse(ack.creditNote)
  expect(returnCreditMatchesCommand(command, credit, ids.owner)).toBe(true)
  const retry = await executeCommand(post('/api/pos/commands', { command }))
  expect(retry.status).toBe(200)
  expect((await retry.json()).replayed).toBe(true)
  expect(
    await scalar("select count(*)::int from public.pos_documents where kind='tax_credit_note'")
  ).toBe(1)
  expect(await original()).toBe(originalRows)
})
it('rejects a stale preview under a new request and does not duplicate the credit', async () => {
  const result = await executeCommand(
    post('/api/pos/commands', { command: { ...command, id: randomUUID() } })
  )
  expect(result.status).toBe(409)
  expect((await result.json()).code).toBe('POS_RETURN_STALE')
  expect(
    await scalar("select count(*)::int from public.pos_documents where kind='tax_credit_note'")
  ).toBe(1)
})
it('recovers the exact result after staff and binding revocation, and rejects a different saved body', async () => {
  await db!.query('update public.pos_staff set active=false where user_id=$1', [ids.owner])
  await db!.query('update public.pos_device_bindings set revoked_at=now() where token_hash=$1', [
    binding,
  ])
  const response = await recoverRequest(
    post('/api/pos/recovery', { kind: 'command', request: command })
  )
  expect(response.status).toBe(200)
  expect((await response.json()).creditNote).toEqual(credit)
  const changed = await recoverRequest(
    post('/api/pos/recovery', { kind: 'command', request: { ...command, reason: 'Changed' } })
  )
  expect(changed.status).toBe(409)
  await db!.query('update public.pos_staff set active=true where user_id=$1', [ids.owner])
  await db!.query('update public.pos_device_bindings set revoked_at=null where token_hash=$1', [
    binding,
  ])
})
it('cancels an unsaved request and prevents its delayed financial write', async () => {
  const next = { ...request, expectedRevision: 1 }
  const p = await previewReturn(post('/api/pos/returns', { request: next }))
  expect(p.status).toBe(200)
  const pending = {
    id: randomUUID(),
    type: 'refund.items',
    ...next,
    quoteHash: (await p.json()).preview.quoteHash,
  }
  const cancelled = await recoverRequest(
    post('/api/pos/recovery', { kind: 'command', request: pending })
  )
  expect(cancelled.status).toBe(200)
  expect((await cancelled.json()).status).toBe('cancelled')
  const late = await executeCommand(post('/api/pos/commands', { command: pending }))
  expect(late.status).toBe(409)
  expect((await late.json()).code).toBe('POS_REQUEST_CANCELLED')
})
it('refuses cashier access in the database even when transport returns a manager device binding', async () => {
  m.actor = ids.cashier
  const response = await readReturn(
    new Request(
      url +
        '/api/pos/returns?' +
        new URLSearchParams({ branchId: ids.branch, deviceId: ids.device, orderId: ids.order })
    )
  )
  expect(response.status).toBe(403)
  m.actor = ids.owner
})
