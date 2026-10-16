// Real private PostgreSQL and production HTTP handler. Cookie/Auth transport is mocked;
// current-actor authorization, every migration and the returned snapshot are real SQL.
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn() }))
vi.mock('@/lib/pos/server/client', async original => ({
  ...(await original<typeof import('@/lib/pos/server/client')>()), authenticatedPosClient: mocks.auth,
}))
import { GET } from '@/app/api/pos/operations/route'
import { branchOperationsSchema } from '@/lib/pos/operations/contracts'

interface Client {
  connect(): Promise<void>
  end(): Promise<void>
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, any>[] }>
}
let control: Client | undefined, db: Client | undefined, database: string | undefined
const ids = Object.fromEntries(['actor', 'cashier', 'org', 'branch', 'otherBranch', 'device', 'shift', 'profile', 'tab'].map(k => [k, randomUUID()]))
let currentActor = ids.actor
const request = (branchId = ids.branch) => new Request(`https://pos.example/api/pos/operations?branchId=${branchId}`)
const scalar = async (sql: string, args?: unknown[]) => Object.values((await db!.query(sql, args)).rows[0])[0]
beforeAll(async () => {
  const socket = process.env.OFFLINE_TEST_PG_SOCKET, entry = process.env.OFFLINE_TEST_PG_ENTRY
  if (!socket?.startsWith('/tmp/pos-qa-pg-') || !entry) throw new Error('Explicit private QA PostgreSQL only; never production.')
  const imported = await import(/* @vite-ignore */ pathToFileURL(entry).href)
  const Constructor = (imported.default ?? imported).Client
  const port = Number(process.env.OFFLINE_TEST_PG_PORT ?? 55432)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid QA port')
  const options = { host: socket, port, user: process.env.USER, connectionTimeoutMillis: 5000 }
  control = new Constructor({ ...options, database: 'postgres' })
  await control!.connect()
  database = 'pos_operations_http_' + randomUUID().replaceAll('-', '')
  await control!.query(`create database ${database}`)
  db = new Constructor({ ...options, database })
  await db!.connect()
  await db!.query(`create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`)
  for (const file of (await readdir('supabase/migrations')).filter(n => /^20261016/.test(n) && !n.includes('007')).sort())
    await db!.query(await readFile('supabase/migrations/' + file, 'utf8'))
  const { actor, cashier, org, branch, otherBranch, device, shift, profile, tab } = ids
  await db!.query(`insert into auth.users values('${actor}','owner@example.test',now()),('${cashier}','cashier@example.test',now());
    insert into pos_organizations(id,legal_name) values('${org}','Synthetic operations HTTP');
    insert into pos_branches(id,organization_id,name) values('${branch}','${org}','Synthetic branch'),('${otherBranch}','${org}','Other branch');
    insert into pos_staff(organization_id,user_id,branch_id,role,display_name) values('${org}','${actor}','${branch}','manager','Synthetic manager'),('${org}','${cashier}','${branch}','cashier','Synthetic cashier');
    insert into pos_devices(id,organization_id,branch_id,name) values('${device}','${org}','${branch}','Counter A');
    insert into pos_shifts(id,organization_id,branch_id,device_id,opened_by,opening_cash_fils,opened_at) values('${shift}','${org}','${branch}','${device}','${actor}',10000,now()-interval '2 days');
    insert into pos_merchant_profiles(id,organization_id,branch_id,legal_name,branch_name,address,phone,trn,tax_registered,tax_inclusive,confirmed_by) values('${profile}','${org}','${branch}','Synthetic merchant','Synthetic branch','Synthetic address','Synthetic phone','100000000000001',true,true,'${actor}');
    insert into pos_branch_receipt_config values('${branch}','${org}','${profile}','TEST',false);
    insert into pos_open_tabs(id,organization_id,branch_id,label,service_type,note,lines,request_lines,subtotal_fils,tax_fils,created_by,updated_by,created_at,updated_at)
    values('${tab}','${org}','${branch}','Older unpaid table','dine_in','','[]','[]',4200,200,'${actor}','${actor}',now()-interval '1 day',now()-interval '1 day');`)
  mocks.auth.mockImplementation(async () => ({ client: { rpc: mocks.rpc }, user: { id: currentActor } }))
  mocks.rpc.mockImplementation(async (name: string, args: { p_branch: string }) => {
    if (name !== 'pos_branch_operations' || Object.keys(args).join(',') !== 'p_branch') throw new Error('Unexpected SQL call')
    await db!.query('set role authenticated')
    await db!.query("select set_config('app.user_id',$1,false)", [currentActor])
    try { return { data: await scalar('select pos_branch_operations($1)', [args.p_branch]), error: null } }
    catch (error) { return { data: null, error: { message: (error as Error).message } } }
    finally { await db!.query('reset role') }
  })
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
})
afterAll(async () => {
  try { await db?.end() }
  finally { try { if (database) await control?.query(`drop database ${database}`) } finally { await control?.end() } }
  vi.unstubAllEnvs()
})

it('serves one real scoped snapshot, including old open work, with no financial/device writes', async () => {
  const before = await scalar("select jsonb_build_object('devices',(select count(*) from pos_devices),'orders',(select count(*) from pos_orders),'documents',(select count(*) from pos_documents),'audit',(select count(*) from pos_audit_events))")
  const result = await GET(request())
  expect(result.status).toBe(200)
  const parsed = branchOperationsSchema.parse(await result.json())
  expect(parsed).toMatchObject({ branchId: ids.branch, offlineDeviceCoverage: 'unknown', sales: { documentCount: 0 }, openShifts: { totalCount: 1 }, unpaidOrders: { totalCount: 1, totalFils: 4200 } })
  expect(parsed.openShifts.items[0]).toMatchObject({ id: ids.shift, deviceName: 'Counter A', staffName: 'Synthetic manager', openingCashFils: 10000 })
  expect(parsed.unpaidOrders.items[0].id).toBe(ids.tab)
  expect(result.headers.get('cache-control')).toBe('private, no-store')
  expect(await scalar("select jsonb_build_object('devices',(select count(*) from pos_devices),'orders',(select count(*) from pos_orders),'documents',(select count(*) from pos_documents),'audit',(select count(*) from pos_audit_events))")).toEqual(before)
})
it('maps real cashier and other-branch denials to 403 without summaries', async () => {
  currentActor = ids.cashier
  expect(await (await GET(request())).json()).toEqual({ status: 'unavailable', code: 'operations_manager_required' })
  currentActor = ids.actor
  expect((await GET(request(ids.otherBranch))).status).toBe(403)
})
it('does not reuse a snapshot after the manager is revoked', async () => {
  await db!.query('update pos_staff set active=false where user_id=$1', [ids.actor])
  try { expect((await GET(request())).status).toBe(403) }
  finally { await db!.query('update pos_staff set active=true where user_id=$1', [ids.actor]) }
})
it('keeps missing fiscal configuration unavailable instead of replacing sales with zero', async () => {
  await db!.query('update pos_staff set branch_id=null,role=\'owner\' where user_id=$1', [ids.actor])
  try {
    const result = await GET(request(ids.otherBranch))
    expect(result.status).toBe(409)
    expect(await result.json()).toEqual({ status: 'unavailable', code: 'operations_profile_required' })
  } finally { await db!.query('update pos_staff set branch_id=$1,role=\'manager\' where user_id=$2', [ids.branch, ids.actor]) }
})
it('reports an incomplete recorded cash close as unknown then rejects contradictory stored cash', async () => {
  await db!.query("update pos_shifts set status='closed',closed_at=clock_timestamp()-interval '1 second',counted_cash_fils=null,expected_cash_fils=null,cash_difference_fils=null where id=$1", [ids.shift])
  const result = await GET(request())
  expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({ closedShifts: { totalCount: 1, incompleteCount: 1, netDifferenceFils: null } })
  await db!.query('update pos_shifts set counted_cash_fils=10000,expected_cash_fils=9000,cash_difference_fils=0 where id=$1', [ids.shift])
  const bad = await GET(request())
  expect(bad.status).toBe(503)
  expect(await bad.json()).toEqual({ status: 'unavailable', code: 'operations_unavailable' })
})
