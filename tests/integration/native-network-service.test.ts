// Actual loopback HTTPS -> production handlers/services -> disposable PostgreSQL.
// Only Auth token verification and Supabase transport are test adapters. Native code
// owns its genuine SQLite/Keystore issuance. Never accepts a live database or host.
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { verifyNativeNetworkBoundaries } from './native-network-boundaries'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer, type Server } from 'node:https'
import { randomUUID, randomBytes, createHash, X509Certificate, timingSafeEqual } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TLSSocket } from 'node:tls'
import { NextRequest } from 'next/server'

type ClientModule = typeof import('@/lib/pos/server/client')
const adapter = vi.hoisted(() => ({
  client: undefined as unknown as (...args: unknown[]) => unknown,
  auth: undefined as unknown as () => Promise<unknown>,
  cookies: undefined as unknown as () => unknown,
}))
vi.mock('@/lib/pos/server/client', async (original) => ({
  ...(await original<ClientModule>()),
  posClient: (...args: unknown[]) => adapter.client(...args),
  authenticatedPosClient: () => adapter.auth(),
}))
vi.mock('next/headers', () => ({ cookies: async () => adapter.cookies() }))

import { PosServerError } from '@/lib/pos/server/client'
import { hashToken } from '@/lib/pos/server/live-access'
import { publicReleaseAccess } from '@/lib/pos/public-release'
import { POST as enroll } from '@/app/api/pos/offline/enroll/route'
import { POST as prepare } from '@/app/api/pos/native/prepare/route'
import { POST as preparation } from '@/app/api/pos/native/preparation/route'
import { POST as importReceipt } from '@/app/api/pos/offline/import/route'
import { POST as seal } from '@/app/api/pos/offline/seal/route'
import { POST as continuation } from '@/app/api/pos/native/continuation/route'
import { POST as shiftClose } from '@/app/api/pos/native/shift-close/route'
import { POST as commands } from '@/app/api/pos/commands/route'
import { GET as access } from '@/app/api/pos/native/access/route'
import { canonicalJson, encodeBase64Url } from '@/lib/pos/offline/canonical'
import { verifySignedEnvelope } from '@/lib/pos/offline/authority'
import { offlineIssuanceSchema } from '@/lib/pos/offline/contracts'
import { offlineAckSchema } from '@/lib/pos/offline/server-contracts'
import { importOfflinePublicKey } from '@/lib/pos/offline/server-keys'

interface Db {
  query<R = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<{ rows: R[] }>
  end(): Promise<void>
  connect(): Promise<void>
}
interface Pooled extends Omit<Db, 'end' | 'connect'> {
  release(): void
}
interface Pool {
  connect(): Promise<Pooled>
  end(): Promise<void>
}
type Scope = {
  actorId: string
  deviceId: string
  shiftId: string
  accessToken: string
  deviceToken: string
}
const context = new AsyncLocalStorage<{ cookies: Map<string, string> }>()
const runId = randomUUID(),
  organizationId = randomUUID(),
  branchId = randomUUID(),
  productId = randomUUID()
const devices: Scope[] = Array.from({ length: 2 }, () => ({
  actorId: randomUUID(),
  deviceId: randomUUID(),
  shiftId: randomUUID(),
  accessToken: randomBytes(32).toString('hex'),
  deviceToken: randomBytes(32).toString('hex'),
}))
const ORIGIN = 'https://pos.internext.info'
const routes: Record<string, (request: NextRequest) => Promise<Response>> = {
  'POST /api/pos/offline/enroll': enroll,
  'POST /api/pos/native/preparation': preparation,
  'POST /api/pos/native/prepare': prepare,
  'POST /api/pos/offline/import': importReceipt,
  'POST /api/pos/offline/seal': seal,
  'POST /api/pos/native/continuation': continuation,
  'POST /api/pos/native/shift-close': shiftClose,
  'POST /api/pos/commands': commands,
  'GET /api/pos/native/access': access,
}
let control: Db | undefined,
  database: string | undefined,
  pool: Pool | undefined,
  server: Server | undefined
let ownedDatabase = false
const historicalRevocation = process.env.NATIVE_NETWORK_HISTORICAL_REVOCATION === 'true'
let historicalPhase: 'initial' | 'revoked' | 'restored' | 'failed' = 'initial'
let changingHistoricalState = false
const tlsProtocols = new Set<string>()
let historicalCookieFreeChecks = 0
let bootPath: string, reportPath: string, completionToken: string, serverKey: CryptoKeyPair
let complete: (ids: string[]) => void, completed: Promise<string[]>
const requests: {
  path: string
  status: number
  actorId: string | null
  requestSha256: string
  responseSha256: string
}[] = []
interface Report {
  runId: string
  productionTouched: boolean
  status: string
  limits: string[]
  migrationHashes: Record<string, string>
  checks: string[]
  cleanup: string
  database?: string
  receipts?: unknown[]
  shifts?: unknown[]
  requests?: typeof requests
  historicalRevocation?: boolean
  historicalPhase?: string
  tlsProtocols?: string[]
  historicalCookieFreeChecks?: number
}
interface ReceiptRow {
  issuance_id: string
  document_id: string
  document_number: string
  key_epoch: string
  device_sequence: string | number
  payload_sha256: string
  envelope: unknown
  acknowledgement: unknown
}
interface EpochRow {
  id: string
  device_key_sha256: string
  public_key_spki: string
  last_sequence: string | number
  last_event_sha256: string | null
}
interface AuthorityRow {
  sealed_at: unknown
  authority: { invoiceRange: { prefix: string; first: number; last: number } }
}
interface ShiftRow {
  id: string
  status: string
  counted_cash_fils: string | number
  expected_cash_fils: string | number
  cash_difference_fils: string | number
}
const report: Report = {
  runId,
  productionTouched: false,
  historicalRevocation,
  status: 'pending',
  limits: [
    'Synthetic Auth tokens; no GoTrue login/refresh/password transport',
    'Production Next route handlers invoked by isolated Node HTTPS adapter, not a full deployed Next proxy',
    'Android testing does not certify physical POS durability',
  ],
  migrationHashes: {},
  checks: [],
  cleanup: 'pending',
}
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
const scalar = async (sql: string, args: unknown[] = []) => {
  const client = await pool!.connect()
  try {
    return Object.values((await client.query(sql, args)).rows[0])[0]
  } finally {
    client.release()
  }
}
function identity() {
  const token = context.getStore()?.cookies.get('pos-access')
  const scope = devices.find((d) => d.accessToken === token)
  if (!scope) throw new PosServerError('authentication_required', 401)
  return scope
}
async function withRole<T>(admin: boolean, operation: (client: Pooled) => Promise<T>): Promise<T> {
  const actor = admin ? null : identity().actorId
  const client = await pool!.connect()
  try {
    await client.query('begin')
    await client.query(admin ? 'set local role service_role' : 'set local role authenticated')
    await client.query("select set_config('app.user_id',$1,true)", [actor ?? ''])
    const result = await operation(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}
function sqlClient(admin: boolean) {
  return {
    async rpc(name: string, args: Record<string, unknown> = {}) {
      if (!/^pos_[a-z_]+$/.test(name) || Object.keys(args).some((k) => !/^p_[a-z_]+$/.test(k)))
        throw new Error('Unsafe test RPC')
      try {
        const entries = Object.entries(args)
        const data = await withRole(
          admin,
          async (client) =>
            Object.values(
              (
                await client.query(
                  `select public.${name}(${entries.map(([k], i) => `${k} => $${i + 1}`).join(',')}) as result`,
                  entries.map(([, v]) =>
                    v !== null && typeof v === 'object' ? JSON.stringify(v) : v
                  )
                )
              ).rows[0]
            )[0]
        )
        return { data, error: null }
      } catch (error) {
        const e = error as Error & { code?: string }
        return { data: null, error: { message: e.message, code: e.code } }
      }
    },
    from(table: string) {
      const fields: Record<string, string[]> = {
        pos_branches: ['id', 'organization_id', 'name', 'active'],
        pos_staff: ['organization_id', 'branch_id', 'role', 'user_id', 'active'],
      }
      if (!fields[table]) throw new Error('Unsupported test query')
      let columns: string[] = []
      const filters: [string, unknown][] = []
      const builder = {
        select(value: string) {
          columns = value.split(',')
          if (!columns.length || columns.some((c) => !fields[table].includes(c)))
            throw new Error('Unsupported columns')
          return builder
        },
        eq(key: string, value: unknown) {
          if (!fields[table].includes(key)) throw new Error('Unsupported filter')
          filters.push([key, value])
          return builder
        },
        async limit(limit: number) {
          if (limit !== 501) throw new Error('Unbounded test query')
          try {
            return {
              data: await withRole(
                admin,
                async (c) =>
                  (
                    await c.query(
                      `select ${columns.join(',')} from public.${table} where ${filters.map(([k], i) => `${k}=$${i + 1}`).join(' and ')} limit 501`,
                      filters.map(([, v]) => v)
                    )
                  ).rows
              ),
              error: null,
            }
          } catch {
            return { data: null, error: { message: 'Test transport query failed' } }
          }
        },
      }
      return builder
    },
  }
}
function parseCookies(raw: string | null) {
  const cookies = new Map<string, string>()
  if (!raw) return cookies
  if (raw.length > 24000) throw new Error('Oversized cookies')
  for (const item of raw.split(';')) {
    const match = /^\s*([a-zA-Z0-9-]+)=([A-Za-z0-9._~-]+)\s*$/.exec(item)
    if (!match || cookies.has(match[1])) throw new Error('Malformed cookie')
    cookies.set(match[1], match[2])
  }
  return cookies
}
async function route(
  path: string,
  method: string,
  body: Buffer,
  cookies: string | null,
  origin = ORIGIN,
  fetchSite?: string,
  contentLength?: string
) {
  const handler = routes[`${method} ${path}`]
  if (!handler || publicReleaseAccess(path, method, true) !== 'allow')
    return new Response('{}', { status: 404 })
  const headers = new Headers({
    origin,
    'content-type': 'application/json',
    'x-forwarded-for': '127.0.0.1',
  })
  if (cookies) headers.set('cookie', cookies)
  if (fetchSite) headers.set('sec-fetch-site', fetchSite)
  if (contentLength) headers.set('content-length', contentLength)
  const request = new NextRequest(ORIGIN + path, {
    method,
    headers,
    ...(method === 'POST' ? { body: new Uint8Array(body) } : {}),
  })
  return context.run({ cookies: parseCookies(cookies) }, async () => {
    const response = await handler(request)
    let text = await response.clone().text()
    if (path === '/api/pos/offline/import' && response.status === 200) {
      const value = JSON.parse(text)
      delete value.replayed
      text = canonicalJson(value)
    }
    requests.push({
      path,
      status: response.status,
      actorId:
        devices.find((d) => d.accessToken === context.getStore()?.cookies.get('pos-access'))
          ?.actorId ?? null,
      requestSha256: createHash('sha256').update(body).digest('hex'),
      responseSha256: createHash('sha256').update(text).digest('hex'),
    })
    return response
  })
}
const cookie = (d: Scope) => `pos-access=${d.accessToken}; pos-device-${d.actorId}=${d.deviceToken}`

async function historicalState(target: 'revoked' | 'restored') {
  if (changingHistoricalState) throw new Error('Concurrent test control refused')
  if (historicalPhase === target) return
  if (historicalPhase !== (target === 'revoked' ? 'initial' : 'revoked'))
    throw new Error('Unexpected historical test phase')
  changingHistoricalState = true
  const db = await pool!.connect()
  try {
    await db.query('begin')
    const count = async (table: string) =>
      Object.values((await db.query(`select count(*)::int from public.${table}`)).rows[0])[0]
    expect(await count('pos_offline_key_epochs')).toBe(2)
    expect(await count('pos_offline_authorities')).toBe(2)
    expect(await count('pos_documents')).toBe(target === 'revoked' ? 0 : 4)
    expect(await count('pos_offline_receipts')).toBe(target === 'revoked' ? 0 : 4)
    if (target === 'restored') {
      expect(
        Object.values(
          (
            await db.query(
              'select count(*)::int from public.pos_offline_authorities where sealed_at is not null'
            )
          ).rows[0]
        )[0]
      ).toBe(2)
      expect(
        Object.values(
          (
            await db.query(
              "select count(*)::int from public.pos_documents where snapshot#>>'{lines,0,unitPriceFils}'='1000' and snapshot#>>'{totals,grossFils}'='1000' and snapshot#>>'{totals,netFils}'='952' and snapshot#>>'{totals,taxFils}'='48'"
            )
          ).rows[0]
        )[0]
      ).toBe(4)
    }
    const tables = [
      'pos_offline_key_epochs',
      'pos_offline_authorities',
      'pos_offline_receipts',
      'pos_documents',
      'pos_orders',
      'pos_payments',
    ]
    const fingerprint = async () => {
      const out: Record<string, unknown> = {}
      for (const table of tables)
        out[table] = Object.values(
          (
            await db.query(
              `select md5(coalesce(string_agg(row_to_json(t)::text,E'\n' order by row_to_json(t)::text),'')) from public.${table} t`
            )
          ).rows[0]
        )[0]
      return out
    }
    const before = await fingerprint()
    const active = target === 'restored'
    await db.query('update public.pos_products set unit_price_fils=$1,revision=$2 where id=$3', [
      active ? 1000 : 2500,
      active ? 3 : 2,
      productId,
    ])
    await db.query(
      'update public.pos_staff set active=$1 where organization_id=$2 and user_id=any($3::uuid[])',
      [active, organizationId, devices.map((d) => d.actorId)]
    )
    await db.query(
      'update public.pos_devices set active=$1 where organization_id=$2 and id=any($3::uuid[])',
      [active, organizationId, devices.map((d) => d.deviceId)]
    )
    await db.query('update public.pos_offline_branch_policy set enabled=$1 where branch_id=$2', [
      active,
      branchId,
    ])
    expect(await fingerprint()).toEqual(before)
    await db.query('commit')
    historicalPhase = target
    if (target === 'revoked')
      for (const d of devices) {
        expect(
          (await route('/api/pos/native/access', 'GET', Buffer.alloc(0), cookie(d))).status
        ).toBe(403)
        const probe = Buffer.from(
          JSON.stringify({ challenge: 'd'.repeat(64), branchId, deviceId: d.deviceId })
        )
        expect((await route('/api/pos/native/preparation', 'POST', probe, cookie(d))).status).toBe(
          403
        )
      }
    report.checks.push(
      target === 'revoked'
        ? 'After native offline issuance: synthetic price2500, staff/devices/policy disabled, fresh access/preparation refused, no preupload bills'
        : 'Four historical1000fils bills and both seals accepted while revoked; restore metadata preserves every financial/custody row'
    )
    report.historicalPhase = historicalPhase
    await save()
  } catch (error) {
    await db.query('rollback')
    historicalPhase = 'failed'
    report.historicalPhase = historicalPhase
    await save()
    throw error
  } finally {
    db.release()
    changingHistoricalState = false
  }
}

beforeAll(async () => {
  const socket = process.env.OFFLINE_TEST_PG_SOCKET,
    entry = process.env.OFFLINE_TEST_PG_ENTRY
  bootPath = resolve(process.env.NATIVE_NETWORK_BOOT_PATH ?? '')
  if (
    !socket?.startsWith('/tmp/pos-qa-pg-') ||
    socket.includes('..') ||
    !entry ||
    !process.env.NATIVE_NETWORK_BOOT_PATH ||
    !bootPath.startsWith('/home/islaminamdar/.local/state/codex-tasks/')
  )
    throw new Error('Explicit isolated socket and private boot path required')
  reportPath = resolve(dirname(bootPath), 'native-network-service-report.json')
  completionToken = process.env.NATIVE_NETWORK_COMPLETION_TOKEN ?? ''
  if (!/^[a-f0-9]{64}$/.test(completionToken) || process.env.NATIVE_NETWORK_PORT !== '9443')
    throw new Error('Explicit private listener configuration required')
  const port = Number(process.env.OFFLINE_TEST_PG_PORT ?? '55432')
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Invalid QA PostgreSQL port')
  const imported = await import(/* @vite-ignore */ pathToFileURL(entry).href),
    pg = imported.default ?? imported
  const options = { host: socket, port, user: process.env.USER, connectionTimeoutMillis: 5000 }
  control = new pg.Client({ ...options, database: 'postgres' })
  await control!.connect()
  if (
    Object.values((await control!.query('select inet_server_addr() is null')).rows[0])[0] !== true
  )
    throw new Error('Nonlocal PostgreSQL refused')
  database = 'pos_native_network_' + runId.replaceAll('-', '')
  await control!.query(`create database ${database}`)
  ownedDatabase = true
  pool = new pg.Pool({ ...options, database, max: 8 })
  const db = await pool!.connect()
  try {
    for (const role of ['anon', 'authenticated', 'service_role'])
      if (!(await db.query('select 1 from pg_roles where rolname=$1', [role])).rows.length)
        await db.query(`create role ${role}`)
    await db.query(`create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
      grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`)
    for (const file of (await readdir('supabase/migrations'))
      .filter((f) => /^2026101600(?:0[1-9]|[12][0-9]|30)00_/.test(f))
      .sort()) {
      const sql = await readFile('supabase/migrations/' + file, 'utf8')
      await db.query(sql)
      report.migrationHashes[file] = createHash('sha256').update(sql).digest('hex')
    }
    expect(Object.keys(report.migrationHashes)).toHaveLength(30)
    const profile = randomUUID()
    await db.query('insert into public.pos_organizations(id,legal_name) values($1,$2)', [
      organizationId,
      'Synthetic native commissioning',
    ])
    await db.query('insert into public.pos_branches(id,organization_id,name) values($1,$2,$3)', [
      branchId,
      organizationId,
      'Synthetic branch',
    ])
    for (const [i, d] of devices.entries()) {
      await db.query('insert into auth.users values($1,$2,now())', [
        d.actorId,
        `native-${i}@example.test`,
      ])
      await db.query(
        "insert into public.pos_staff(organization_id,user_id,branch_id,role) values($1,$2,$3,'manager')",
        [organizationId, d.actorId, branchId]
      )
      await db.query(
        'insert into public.pos_devices(id,organization_id,branch_id,name) values($1,$2,$3,$4)',
        [d.deviceId, organizationId, branchId, `Synthetic device ${i + 1}`]
      )
      await db.query(
        'insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)',
        [hashToken(d.deviceToken), d.actorId, organizationId, branchId, d.deviceId]
      )
      await db.query(
        'insert into public.pos_shifts(id,organization_id,branch_id,device_id,opened_by,opening_cash_fils) values($1,$2,$3,$4,$5,10000)',
        [d.shiftId, organizationId, branchId, d.deviceId, d.actorId]
      )
    }
    await db.query(
      "insert into public.pos_merchant_profiles(id,organization_id,branch_id,legal_name,branch_name,address,phone,trn,tax_registered,tax_inclusive,confirmed_by) values($1,$2,$3,'Synthetic merchant','Synthetic branch','Synthetic address','Synthetic phone','100000000000001',true,true,$4)",
      [profile, organizationId, branchId, devices[0].actorId]
    )
    await db.query("insert into public.pos_branch_receipt_config values($1,$2,$3,'NETTEST',true)", [
      branchId,
      organizationId,
      profile,
    ])
    await db.query(
      "insert into public.pos_products(id,organization_id,branch_id,name,category,unit_price_fils,tax_rate_bps) values($1,$2,$3,'Synthetic piece','Synthetic',1000,500)",
      [productId, organizationId, branchId]
    )
    await db.query(
      'insert into public.pos_offline_branch_policy(branch_id,enabled) values($1,true)',
      [branchId]
    )
  } finally {
    db.release()
  }
  adapter.client = (_token, admin) => sqlClient(admin === true)
  adapter.auth = async () => ({ user: { id: identity().actorId }, client: sqlClient(false) })
  adapter.cookies = () => ({
    get: (name: string) => {
      const value = context.getStore()?.cookies.get(name)
      return value === undefined ? undefined : { value }
    },
  })
  serverKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const publicKeySpki = encodeBase64Url(
    new Uint8Array(await crypto.subtle.exportKey('spki', serverKey.publicKey))
  )
  vi.stubEnv('POS_OFFLINE_SIGNING_KEY_ID', 'synthetic-network-server')
  vi.stubEnv(
    'POS_OFFLINE_SERVER_KEYS',
    JSON.stringify([
      {
        id: 'synthetic-network-server',
        publicKeySpki,
        privateKeyPkcs8: encodeBase64Url(
          new Uint8Array(await crypto.subtle.exportKey('pkcs8', serverKey.privateKey))
        ),
      },
    ])
  )
  for (const name of ['POS_ONLINE_PILOT', 'POS_LIVE_SALES_ENABLED', 'POS_OFFLINE_ISSUANCE_ENABLED'])
    vi.stubEnv(name, 'true')
  for (const name of [
    'POS_OFFLINE_PAYMENT_REVIEW_ENABLED',
    'POS_OFFLINE_PAYMENT_RESOLUTION_ENABLED',
    'PAYPAL_BILLING_ENABLED',
  ])
    vi.stubEnv(name, 'false')
  vi.stubEnv('POS_PUBLIC_ORIGIN', ORIGIN)
  vi.stubEnv('POS_LOGIN_SOURCE_MODE', 'apache-rightmost')
  completed = new Promise((resolve) => {
    complete = resolve
  })
  const tlsKey = await readFile(process.env.NATIVE_NETWORK_TLS_KEY!),
    tlsCert = await readFile(process.env.NATIVE_NETWORK_TLS_CERT!)
  const cert = new X509Certificate(tlsCert)
  if (!cert.checkIP('127.0.0.1')) throw new Error('TLS certificate must bind loopback IP')
  server = createServer({ key: tlsKey, cert: tlsCert, minVersion: 'TLSv1.2' }, async (req, res) => {
    try {
      if (req.socket.remoteAddress !== '127.0.0.1') {
        res.writeHead(403).end()
        return
      }
      const protocol = (req.socket as TLSSocket).getProtocol()
      if (protocol !== 'TLSv1.2' && protocol !== 'TLSv1.3') {
        res.writeHead(403).end()
        return
      }
      tlsProtocols.add(protocol)
      const path = req.url ?? ''
      if (path.includes('?') || path.includes('#') || !path.startsWith('/')) {
        res.writeHead(404).end()
        return
      }
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        const b = Buffer.from(chunk)
        size += b.length
        if (size > 1_420_000) {
          res.writeHead(413).end()
          return
        }
        chunks.push(b)
      }
      const body = Buffer.concat(chunks)
      if (path === '/__test/historical-revoke' || path === '/__test/historical-restore') {
        if (!historicalRevocation || req.method !== 'POST') {
          res.writeHead(404).end()
          return
        }
        if (body.length > 1024) {
          res.writeHead(413).end()
          return
        }
        const input = JSON.parse(body.toString('utf8'))
        if (
          Object.keys(input).sort().join(',') !== 'runId,token' ||
          input.runId !== runId ||
          typeof input.token !== 'string' ||
          !/^[a-f0-9]{64}$/.test(input.token) ||
          !timingSafeEqual(Buffer.from(input.token), Buffer.from(completionToken))
        ) {
          res.writeHead(403).end()
          return
        }
        await historicalState(path.endsWith('-revoke') ? 'revoked' : 'restored')
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"applied"}')
        return
      }
      if (path === '/__test/complete' && req.method === 'POST') {
        const token = req.headers['x-test-token']
        if (
          typeof token !== 'string' ||
          !/^[a-f0-9]{64}$/.test(token) ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(completionToken))
        ) {
          res.writeHead(403).end()
          return
        }
        const value = JSON.parse(body.toString('utf8'))
        if (
          Object.keys(value).sort().join(',') !== 'receiptIds,runId' ||
          value.runId !== runId ||
          !Array.isArray(value.receiptIds) ||
          value.receiptIds.length !== 6 ||
          new Set(value.receiptIds).size !== 6 ||
          value.receiptIds.some(
            (id: unknown) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)
          )
        ) {
          res.writeHead(422).end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"accepted":true}')
        complete(value.receiptIds)
        return
      }
      const historical = path === '/api/pos/offline/import' || path === '/api/pos/offline/seal'
      if (historical) expect(req.headers.cookie).toBeUndefined()
      const response = await route(
        path,
        req.method ?? '',
        body,
        typeof req.headers.cookie === 'string' ? req.headers.cookie : null,
        typeof req.headers.origin === 'string' ? req.headers.origin : '',
        typeof req.headers['sec-fetch-site'] === 'string'
          ? req.headers['sec-fetch-site']
          : undefined,
        typeof req.headers['content-length'] === 'string'
          ? req.headers['content-length']
          : undefined
      )
      if (historical) {
        expect(response.headers.has('set-cookie')).toBe(false)
        historicalCookieFreeChecks++
      }
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"code":"test_adapter_error"}')
    }
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(9443, '127.0.0.1', resolve)
  })
  const protectedTables = [
    'pos_offline_key_epochs',
    'pos_offline_authorities',
    'pos_documents',
    'pos_orders',
    'pos_payments',
  ]
  const fingerprint = async () =>
    Object.fromEntries(
      await Promise.all(
        protectedTables.map(async (table) => [
          table,
          await scalar(
            `select md5(coalesce(string_agg(row_to_json(t)::text,E'\\n' order by row_to_json(t)::text),'')) from public.${table} t`
          ),
        ])
      )
    )
  const before = await fingerprint()
  const boundary = await verifyNativeNetworkBoundaries({
    port: 9443,
    ca: tlsCert,
    devices,
    branchId,
  })
  expect(await fingerprint()).toEqual(before)
  report.checks.push(
    ...boundary.checks,
    'Read-only network preflight preserves all epoch/authority/document/order/payment fingerprints'
  )
  await writeFile(
    bootPath,
    JSON.stringify(
      {
        runId,
        localPort: 9443,
        caDerBase64: cert.raw.toString('base64'),
        serverKeyId: 'synthetic-network-server',
        serverPublicKeySpkiBase64Url: publicKeySpki,
        organizationId,
        branchId,
        productId,
        devices,
        ...(historicalRevocation
          ? { historicalRevocation: true, testControlToken: completionToken }
          : {}),
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  )
  report.status = 'ready'
  report.database = database
  await save()
}, 60000)

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => {
      server!.close(() => resolve())
      server!.closeAllConnections()
    })
  await pool?.end()
  if (control) {
    try {
      if (database && ownedDatabase) await control.query(`drop database ${database}`)
      report.cleanup = 'owned database dropped; listener closed'
    } finally {
      await control.end()
    }
  }
  vi.unstubAllEnvs()
  if (report.status !== 'passed')
    report.status = 'failed; see retained test log and native evidence'
  report.historicalPhase = historicalPhase
  report.tlsProtocols = [...tlsProtocols]
  if (reportPath) await save()
}, 30000)

it('commissions two real Android ledgers through isolated HTTPS and verifies durable SQL custody', async () => {
  const probe = Buffer.from(
    JSON.stringify({ challenge: 'a'.repeat(64), branchId, deviceId: devices[0].deviceId })
  )
  expect((await route('/api/pos/native/preparation', 'POST', probe, null)).status).toBe(401)
  expect(
    (
      await route(
        '/api/pos/native/preparation',
        'POST',
        probe,
        `pos-access=${devices[0].accessToken}`
      )
    ).status
  ).toBe(403)
  expect(
    (await route('/api/pos/native/preparation', 'POST', probe, cookie(devices[1]))).status
  ).toBe(403)
  expect(
    (
      await route(
        '/api/pos/native/preparation',
        'POST',
        probe,
        cookie(devices[0]),
        'https://foreign.example'
      )
    ).status
  ).toBe(403)
  expect(
    (await route('/api/pos/native/preparation', 'POST', probe, cookie(devices[0]))).status
  ).toBe(200)
  report.checks.push(
    'Missing authentication/binding, foreign device and foreign origin denied through production handlers and SQL'
  )
  const timeout = Number(process.env.NATIVE_NETWORK_TIMEOUT_MS ?? 600000)
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000)
    throw new Error('Invalid commissioning timeout')
  let timer: ReturnType<typeof setTimeout> | undefined
  let ids: string[]
  try {
    ids = await Promise.race([
      completed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Android completion not received')), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  const db = await pool!.connect()
  try {
    const receipts = (
      await db.query<ReceiptRow>(
        'select * from public.pos_offline_receipts order by key_epoch,device_sequence'
      )
    ).rows
    expect(receipts).toHaveLength(6)
    expect(receipts.map((r) => r.issuance_id).sort()).toEqual(ids!.sort())
    const epochs = (await db.query<EpochRow>('select * from public.pos_offline_key_epochs')).rows
    expect(epochs).toHaveLength(2)
    expect(new Set(epochs.map((e) => e.device_key_sha256)).size).toBe(2)
    const authorities = (
      await db.query<AuthorityRow>('select * from public.pos_offline_authorities')
    ).rows
    expect(authorities).toHaveLength(4)
    expect(authorities.every((a) => a.sealed_at !== null)).toBe(true)
    for (let i = 0; i < authorities.length; i++)
      for (let j = i + 1; j < authorities.length; j++) {
        const a = authorities[i].authority.invoiceRange,
          b = authorities[j].authority.invoiceRange
        expect(a.prefix !== b.prefix || a.last < b.first || b.last < a.first).toBe(true)
      }
    for (const epoch of epochs) {
      expect(Number(epoch.last_sequence)).toBe(3)
      const own = receipts.filter((r) => r.key_epoch === epoch.id)
      expect(own.map((r) => Number(r.device_sequence))).toEqual([1, 2, 3])
      let previous: string | null = null
      const key = await importOfflinePublicKey(epoch.public_key_spki)
      for (const receipt of own) {
        const verified = await verifySignedEnvelope(receipt.envelope, offlineIssuanceSchema, {
          [epoch.device_key_sha256]: key,
        })
        expect(verified.payloadSha256).toBe(receipt.payload_sha256)
        expect(verified.payload.previousEventSha256).toBe(previous)
        previous = receipt.payload_sha256
        expect(verified.payload.document.totals).toEqual({
          grossFils: 1000,
          netFils: 952,
          taxFils: 48,
        })
        expect(verified.payload.document.lines).toHaveLength(1)
        expect(verified.payload.document.lines[0]).toMatchObject({
          productId,
          quantityMilli: 1000,
          unitPriceFils: 1000,
          grossFils: 1000,
          netFils: 952,
          taxFils: 48,
        })
        expect(
          (
            await db.query('select snapshot from public.pos_documents where id=$1', [
              receipt.document_id,
            ])
          ).rows[0].snapshot
        ).toEqual(verified.payload.document)
        const ack = await verifySignedEnvelope(receipt.acknowledgement, offlineAckSchema, {
          'synthetic-network-server': serverKey.publicKey,
        })
        expect(ack.payload.payloadSha256).toBe(receipt.payload_sha256)
        expect(ack.payload.issuanceId).toBe(receipt.issuance_id)
      }
      expect(epoch.last_event_sha256).toBe(previous)
    }
    expect(await scalar('select count(*)::int from public.pos_orders')).toBe(6)
    expect(await scalar('select count(*)::int from public.pos_documents')).toBe(6)
    expect(
      await scalar('select count(distinct document_number)::int from public.pos_documents')
    ).toBe(6)
    expect(await scalar('select sum(total_fils)::int from public.pos_orders')).toBe(6000)
    expect(
      await scalar("select sum(amount_fils)::int from public.pos_payments where method='cash'")
    ).toBe(6000)
    expect(await scalar('select count(*)::int from public.pos_payments')).toBe(6)
    expect(await scalar('select count(*)::int from public.pos_offline_exceptions')).toBe(0)
    const shifts = (
      await db.query<ShiftRow>(
        'select id,status,counted_cash_fils,expected_cash_fils,cash_difference_fils from public.pos_shifts'
      )
    ).rows
    expect(shifts).toHaveLength(2)
    for (const shift of shifts) {
      expect(shift.status).toBe('closed')
      expect(Number(shift.counted_cash_fils)).toBe(13000)
      expect(Number(shift.expected_cash_fils)).toBe(13000)
      expect(Number(shift.cash_difference_fils)).toBe(0)
    }
    expect(
      requests.filter((r) => r.path === '/api/pos/offline/import' && r.status === 200).length
    ).toBeGreaterThan(6)
    const grouped = new Map<string, Set<string>>()
    for (const r of requests.filter(
      (r) => r.path === '/api/pos/offline/import' && r.status === 200
    )) {
      const hashes = grouped.get(r.requestSha256) ?? new Set()
      hashes.add(r.responseSha256)
      grouped.set(r.requestSha256, hashes)
    }
    expect(grouped.size).toBe(6)
    for (const values of grouped.values()) expect(values.size).toBe(1)
    if (historicalRevocation) {
      expect(historicalPhase).toBe('restored')
      expect(
        await scalar('select revision::int from public.pos_products where id=$1', [productId])
      ).toBe(3)
    }
    report.historicalPhase = historicalPhase
    report.tlsProtocols = [...tlsProtocols]
    expect(historicalCookieFreeChecks).toBeGreaterThanOrEqual(10)
    report.historicalCookieFreeChecks = historicalCookieFreeChecks
    report.status = 'passed'
    report.checks.push(
      'Six exact native signed receipts and ACKs, two distinct key epochs, four disjoint sealed authorities',
      'Per-device chain 1..3 across continuation, no reused number, duplicate imports retain the same financial payload and signed ACK; replay flag may differ',
      'Six immutable invoices/orders/cash rows total6000; both counted drawers13000 with zero difference; no exceptions'
    )
    report.receipts = receipts.map((r) => ({
      id: r.issuance_id,
      documentId: r.document_id,
      number: r.document_number,
      payloadSha256: r.payload_sha256,
      keyEpoch: r.key_epoch,
      sequence: r.device_sequence,
    }))
    report.shifts = shifts
    report.requests = requests
    await save()
  } finally {
    db.release()
  }
}, 620000)
