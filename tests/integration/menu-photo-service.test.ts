// Real PostgreSQL roles/transactions, real Sharp and production route handlers.
// Only authentication/cookie transport and Supabase HTTP transport are substituted.
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
const m = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), device: vi.fn() }))
vi.mock('@/lib/pos/server/client', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/client')>()),
  authenticatedPosClient: m.auth,
  posClient: () => ({ rpc: m.rpc }),
}))
vi.mock('@/lib/pos/server/live-access', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/live-access')>()),
  requireDevice: m.device,
}))
import { POST } from '@/app/api/pos/catalogue/photo/route'
import { GET, HEAD } from '@/app/pos-assets/menu/[filename]/route'
import { POST as saveItem } from '@/app/api/pos/catalogue/route'
interface Client {
  connect(): Promise<void>
  end(): Promise<void>
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, any>[] }>
}
let control: Client | undefined,
  db: Client | undefined,
  database: string | undefined,
  savedImage: any,
  lostRegister = false
const ids = Object.fromEntries(
  ['actor', 'org', 'branch', 'device', 'profile', 'product'].map((k) => [k, randomUUID()])
)
const scalar = async (sql: string, args: unknown[] = []) =>
  Object.values((await db!.query(sql, args)).rows[0])[0]
const binding = 'a'.repeat(64)
const png = () =>
  sharp({ create: { width: 160, height: 120, channels: 3, background: '#af6324' } })
    .withExif({ IFD0: { Copyright: 'Synthetic hidden metadata' } })
    .png()
    .toBuffer()
const upload = async () =>
  POST(
    new Request(
      `http://localhost/api/pos/catalogue/photo?branchId=${ids.branch}&deviceId=${ids.device}`,
      {
        method: 'POST',
        headers: { origin: 'http://localhost', 'content-type': 'image/png' },
        body: new Uint8Array(await png()),
      }
    )
  )
beforeAll(async () => {
  const socket = process.env.OFFLINE_TEST_PG_SOCKET,
    entry = process.env.OFFLINE_TEST_PG_ENTRY
  if (!socket?.startsWith('/tmp/pos-qa-pg-') || socket.includes('..') || !entry)
    throw new Error('Private QA Unix socket required; never production')
  const imported = await import(/* @vite-ignore */ pathToFileURL(entry).href),
    Constructor = (imported.default ?? imported).Client
  const options = {
    host: socket,
    port: 55432,
    user: process.env.USER,
    connectionTimeoutMillis: 5000,
  }
  control = new Constructor({ ...options, database: 'postgres' })
  await control!.connect()
  database = 'pos_photo_http_' + randomUUID().replaceAll('-', '')
  await control!.query(`create database ${database}`)
  db = new Constructor({ ...options, database })
  await db!.connect()
  await db!.query(
    `create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`
  )
  for (const name of (await readdir('supabase/migrations'))
    .filter((n) => /^20261016/.test(n) && !n.includes('007'))
    .sort())
    await db!.query(await readFile('supabase/migrations/' + name, 'utf8'))
  await db!.query(`insert into auth.users values($1,'synthetic-photo@example.test',now())`, [
    ids.actor,
  ])
  await db!.query(
    `insert into pos_organizations(id,legal_name) values($1,'Synthetic photo review')`,
    [ids.org]
  )
  await db!.query(`insert into pos_branches(id,organization_id,name) values($1,$2,'Synthetic')`, [
    ids.branch,
    ids.org,
  ])
  await db!.query(
    `insert into pos_staff(organization_id,user_id,branch_id,role) values($1,$2,$3,'manager')`,
    [ids.org, ids.actor, ids.branch]
  )
  await db!.query(
    `insert into pos_devices(id,organization_id,branch_id,name) values($1,$2,$3,'Synthetic')`,
    [ids.device, ids.org, ids.branch]
  )
  await db!.query(
    `insert into pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)`,
    [binding, ids.actor, ids.org, ids.branch, ids.device]
  )
  await db!.query(
    `insert into pos_merchant_profiles(id,organization_id,branch_id,legal_name,branch_name,address,phone,trn,tax_registered,tax_inclusive,confirmed_by) values($1,$2,$3,'Synthetic','Synthetic','Synthetic','Synthetic','100000000000001',true,true,$4)`,
    [ids.profile, ids.org, ids.branch, ids.actor]
  )
  await db!.query(`insert into pos_branch_receipt_config values($1,$2,$3,'TEST',true)`, [
    ids.branch,
    ids.org,
    ids.profile,
  ])
  await db!.query(
    `insert into pos_products(id,organization_id,branch_id,name,category,unit_price_fils,tax_rate_bps) values($1,$2,$3,'Synthetic sweets','Test',1000,500)`,
    [ids.product, ids.org, ids.branch]
  )
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  vi.stubEnv('POS_PUBLIC_ORIGIN', 'http://localhost')
  m.device.mockResolvedValue(binding)
  m.auth.mockResolvedValue({ user: { id: ids.actor }, client: { rpc: m.rpc } })
  m.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (
      ![
        'pos_menu_media_context',
        'pos_menu_media_register',
        'pos_menu_media_read',
        'pos_manage_catalogue',
      ].includes(name)
    )
      throw new Error('Unexpected RPC')
    const authenticated = name === 'pos_manage_catalogue'
    await db!.query('set role ' + (authenticated ? 'authenticated' : 'service_role'))
    if (authenticated) await db!.query("select set_config('app.user_id',$1,false)", [ids.actor])
    try {
      const keys = Object.keys(args)
      const data = await scalar(
        `select public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')})`,
        keys.map((k) => (typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]))
      )
      if (name === 'pos_menu_media_register' && lostRegister) {
        lostRegister = false
        throw new Error('Synthetic lost reply after commit')
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
it('production upload stores real sanitized WebP and retries lost acknowledgement with one row', async () => {
  lostRegister = true
  expect((await upload()).status).toBe(503)
  const result = await upload()
  expect(result.status).toBe(200)
  const body = await result.json()
  savedImage = body.image
  expect(body.replayed).toBe(true)
  expect(Number(await scalar('select count(*) from pos_menu_media'))).toBe(1)
  expect(await scalar('select image_url from pos_products where id=$1', [ids.product])).toBeNull()
  expect(Number(await scalar('select count(*) from pos_catalogue_commands'))).toBe(0)
})
it('public production GET/HEAD yields stored pixels without EXIF and without exposing identity', async () => {
  const req = new Request('http://localhost' + savedImage.imageUrl),
    ctx = { params: Promise.resolve({ filename: savedImage.imageUrl.split('/').pop() }) }
  const response = await GET(req, ctx)
  expect(response.status).toBe(200)
  const info = await sharp(Buffer.from(await response.arrayBuffer())).metadata()
  expect(info.format).toBe('webp')
  expect(info.exif).toBeUndefined()
  expect(info.width).toBe(160)
  expect((await HEAD(req, ctx)).headers.get('content-length')).toBe(String(savedImage.byteLength))
})
it('existing catalogue route attaches the photo with revision and immutable replay then removes it with another audited edit', async () => {
  const command = {
    id: randomUUID(),
    branchId: ids.branch,
    deviceId: ids.device,
    expectedRevision: 1,
    reason: 'Synthetic photo review',
    product: {
      id: ids.product,
      name: 'Synthetic sweets',
      category: 'Test',
      imageUrl: savedImage.imageUrl,
      unit: 'piece',
      unitPriceFils: 1000,
      taxRateBps: 500,
      active: true,
    },
  }
  const save = (c: unknown) =>
    saveItem(
      new Request('http://localhost/api/pos/catalogue', {
        method: 'POST',
        headers: { origin: 'http://localhost', 'content-type': 'application/json' },
        body: JSON.stringify(c),
      })
    )
  const result = await save(command)
  expect(result.status).toBe(200)
  expect((await result.json()).product.revision).toBe(2)
  expect((await (await save(command)).json()).replayed).toBe(true)
  expect(
    (
      await save({
        ...command,
        id: randomUUID(),
        expectedRevision: 2,
        product: { ...command.product, imageUrl: null },
      })
    ).status
  ).toBe(200)
  expect((await (await save(command)).json()).product.imageUrl).toBe(savedImage.imageUrl)
  expect(await scalar('select image_url from pos_products where id=$1', [ids.product])).toBeNull()
  expect(
    Number(
      await scalar("select count(*) from pos_audit_events where event_type='catalogue.updated'")
    )
  ).toBe(2)
  expect(Number(await scalar('select count(*) from pos_menu_media'))).toBe(1)
})
it('role revocation rejects upload admission while immutable public image remains readable', async () => {
  await db!.query('update pos_staff set active=false where user_id=$1', [ids.actor])
  expect((await upload()).status).toBe(403)
  const ctx = { params: Promise.resolve({ filename: savedImage.imageUrl.split('/').pop() }) }
  expect((await GET(new Request('http://localhost' + savedImage.imageUrl), ctx)).status).toBe(200)
})
