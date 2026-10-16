// Production service + actual private PostgreSQL + real P256. Auth/cookie
// transport is mocked; database permissions, identity and immutable writes are real.
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  password: vi.fn(),
  revoke: vi.fn(),
  device: vi.fn(),
}))
vi.mock('@/lib/pos/server/client', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/client')>()),
  authenticatedPosClient: m.auth,
  posClient: () => ({
    rpc: m.rpc,
    auth: { signInWithPassword: m.password, admin: { signOut: m.revoke } },
  }),
}))
vi.mock('@/lib/pos/server/live-access', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/live-access')>()),
  requireDevice: m.device,
}))
import {
  nativeClockRecovery,
  nativeClockRecoveryApprovalSchema,
  nativeClockRecoveryTimeSchema,
} from '@/lib/pos/offline/native-clock-recovery'
import {
  signEnvelope,
  publicKeyFingerprint,
  verifySignedEnvelope,
} from '@/lib/pos/offline/authority'
import { encodeBase64Url, sha256Hex, canonicalBytes } from '@/lib/pos/offline/canonical'
interface Client {
  connect(): Promise<void>
  end(): Promise<void>
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, any>[] }>
}
let control: Client | undefined,
  db: Client | undefined,
  database: string | undefined,
  failAttach = false
const ids = Object.fromEntries(
  ['actor', 'org', 'branch', 'device', 'epoch'].map((k) => [k, randomUUID()])
)
let device: CryptoKeyPair, server: CryptoKeyPair, fingerprint: string
const scalar = async (sql: string, args: unknown[] = []) =>
  Object.values((await db!.query(sql, args)).rows[0])[0]
const request = new Request('https://pos.example.test/api/pos/native/clock-recovery', {
  method: 'POST',
  headers: { 'x-forwarded-for': '192.0.2.15' },
})
const makeProof = async (patch: Record<string, unknown> = {}) => {
  const payload = {
    kind: 'native-clock-recovery',
    schemaVersion: 1,
    requestId: randomUUID(),
    organizationId: ids.org,
    branchId: ids.branch,
    deviceId: ids.device,
    actorId: ids.actor,
    keyEpoch: ids.epoch,
    deviceKeySha256: fingerprint,
    installationId: randomUUID(),
    oldClockGeneration: 0,
    oldClockSha256: await sha256Hex(canonicalBytes(randomUUID())),
    retirementSha256: await sha256Hex(canonicalBytes(randomUUID())),
    ...patch,
  }
  return { payload, proof: await signEnvelope(payload, fingerprint, device.privateKey) }
}
const approve = (proof: unknown) =>
  nativeClockRecovery(request, {
    mode: 'approve',
    proof,
    challenge: 'a'.repeat(64),
    password: 'synthetic-only',
  })
const lookup = (proof: unknown) =>
  nativeClockRecovery(request, { mode: 'lookup', proof, challenge: 'b'.repeat(64) })
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
  database = 'pos_clock_http_' + randomUUID().replaceAll('-', '')
  await control!.query(`create database ${database}`)
  db = new Constructor({ ...options, database })
  await db!.connect()
  await db!
    .query(`create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`)
  for (const name of (await readdir('supabase/migrations'))
    .filter((n) => /^20261016/.test(n) && !n.includes('007'))
    .sort())
    await db!.query(await readFile('supabase/migrations/' + name, 'utf8'))
  device = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  server = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  fingerprint = await publicKeyFingerprint(device.publicKey)
  const spki = encodeBase64Url(
    new Uint8Array(await crypto.subtle.exportKey('spki', device.publicKey))
  )
  await db!.query(`insert into auth.users values($1,'synthetic@example.test',now());`, [ids.actor])
  await db!.query(
    `insert into pos_organizations(id,legal_name) values($1,'Synthetic clock recovery');`,
    [ids.org]
  )
  await db!.query(
    `insert into pos_branches(id,organization_id,name) values($1,$2,'Synthetic branch');`,
    [ids.branch, ids.org]
  )
  await db!.query(
    `insert into pos_staff(organization_id,user_id,branch_id,role) values($1,$2,$3,'cashier');`,
    [ids.org, ids.actor, ids.branch]
  )
  await db!.query(
    `insert into pos_devices(id,organization_id,branch_id,name) values($1,$2,$3,'Synthetic counter');`,
    [ids.device, ids.org, ids.branch]
  )
  await db!.query(
    `insert into pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)`,
    ['a'.repeat(64), ids.actor, ids.org, ids.branch, ids.device]
  )
  await db!.query(
    `insert into pos_offline_key_epochs(id,organization_id,branch_id,device_id,public_key_spki,device_key_sha256,enrolled_by,request_id,request_payload) values($1,$2,$3,$4,$5,$6,$7,$8,'{}')`,
    [ids.epoch, ids.org, ids.branch, ids.device, spki, fingerprint, ids.actor, randomUUID()]
  )
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  vi.stubEnv('POS_LOGIN_SOURCE_MODE', 'apache-rightmost')
  vi.stubEnv('POS_OFFLINE_SIGNING_KEY_ID', 'server')
  vi.stubEnv(
    'POS_OFFLINE_SERVER_KEYS',
    JSON.stringify([
      {
        id: 'server',
        publicKeySpki: encodeBase64Url(
          new Uint8Array(await crypto.subtle.exportKey('spki', server.publicKey))
        ),
        privateKeyPkcs8: encodeBase64Url(
          new Uint8Array(await crypto.subtle.exportKey('pkcs8', server.privateKey))
        ),
      },
    ])
  )
  m.auth.mockResolvedValue({ user: { id: ids.actor, email: 'synthetic@example.test' }, client: {} })
  m.device.mockResolvedValue('a'.repeat(64))
  m.password.mockResolvedValue({
    data: { user: { id: ids.actor }, session: { access_token: 'temporary-synthetic' } },
    error: null,
  })
  m.revoke.mockResolvedValue({ error: null })
  m.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (
      !/^pos_(native_clock_recovery_(context|lookup|approve|attach)|login_attempt)$/.test(name) ||
      Object.keys(args).some((k) => !/^p_[a-z_]+$/.test(k))
    )
      throw new Error('Unexpected RPC')
    if (failAttach && name === 'pos_native_clock_recovery_attach')
      return { data: null, error: { message: 'simulated lost attachment' } }
    await db!.query('set role service_role')
    try {
      const entries = Object.entries(args)
      return {
        data: await scalar(
          `select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')})`,
          entries.map(([, v]) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v))
        ),
        error: null,
      }
    } catch (error) {
      return { data: null, error: { message: (error as Error).message } }
    } finally {
      await db!.query('reset role')
    }
  })
})
afterAll(async () => {
  try {
    await db?.end()
  } finally {
    try {
      if (database) await control?.query(`drop database ${database}`)
    } finally {
      await control?.end()
    }
  }
  vi.unstubAllEnvs()
})
it('accepts a real original device proof and signs SQL approval with financial records unchanged', async () => {
  const counts = () =>
    scalar(
      "select jsonb_build_object('orders',(select count(*) from pos_orders),'documents',(select count(*) from pos_documents),'epochs',(select jsonb_agg(to_jsonb(e)) from pos_offline_key_epochs e),'shifts',(select count(*) from pos_shifts))"
    )
  const before = await counts(),
    f = await makeProof(),
    r = await approve(f.proof)
  expect(r.status).toBe('approved')
  if (r.status !== 'approved') throw new Error()
  const verified = await verifySignedEnvelope(r.approval, nativeClockRecoveryApprovalSchema, {
    server: server.publicKey,
  })
  expect(verified.payload).toMatchObject({
    requestId: f.payload.requestId,
    proofSha256: await sha256Hex(canonicalBytes(f.payload)),
  })
  expect(await counts()).toEqual(before)
  for (const retry of [await approve(f.proof), await lookup(f.proof)]) {
    if (retry.status !== 'approved') throw new Error()
    expect(retry.approval).toEqual(r.approval)
    const timing = await verifySignedEnvelope(retry.time, nativeClockRecoveryTimeSchema, {
      server: server.publicKey,
    })
    expect(timing.payload.approvalSha256).toBe(await sha256Hex(canonicalBytes(verified.payload)))
    expect(timing.payload.retirementSha256).toBe(f.payload.retirementSha256)
    expect(timing.payload.serverTimeMs).toBeGreaterThanOrEqual(
      Date.parse(verified.payload.approvedAt)
    )
  }
})
it('retrieves exact immutable approval after revocation and signs a new nonce-bound time', async () => {
  const f = await makeProof(),
    first = await approve(f.proof)
  if (first.status !== 'approved') throw new Error()
  await db!.query('update pos_staff set active=false where user_id=$1', [ids.actor])
  await db!.query('update pos_devices set active=false where id=$1', [ids.device])
  vi.stubEnv('POS_ONLINE_PILOT', 'false')
  m.password.mockClear()
  try {
    const recovered = await lookup(f.proof)
    if (recovered.status !== 'approved') throw new Error()
    expect(recovered.approval).toEqual(first.approval)
    const timing = await verifySignedEnvelope(recovered.time, nativeClockRecoveryTimeSchema, {
      server: server.publicKey,
    })
    expect(timing.payload.challenge).toBe('b'.repeat(64))
    expect(m.password).not.toHaveBeenCalled()
    const missing = await makeProof()
    expect(await lookup(missing.proof)).toEqual({ status: 'not_found' })
    await expect(approve(missing.proof)).rejects.toMatchObject({ status: 503 })
  } finally {
    await db!.query('update pos_staff set active=true where user_id=$1', [ids.actor])
    await db!.query('update pos_devices set active=true where id=$1', [ids.device])
    vi.stubEnv('POS_ONLINE_PILOT', 'true')
  }
})
it('recovers accepted unsigned SQL outcome after lost attachment without accepting another grant', async () => {
  const f = await makeProof()
  failAttach = true
  await expect(approve(f.proof)).rejects.toMatchObject({ status: 503 })
  failAttach = false
  m.password.mockClear()
  expect((await lookup(f.proof)).status).toBe('approved')
  expect(m.password).not.toHaveBeenCalled()
  expect(
    await scalar('select count(*)::int from pos_native_clock_recoveries where request_id=$1', [
      f.payload.requestId,
    ])
  ).toBe(1)
})
it('cannot change candidate or consume one old generation under another request ID', async () => {
  const f = await makeProof()
  await approve(f.proof)
  const changed = await signEnvelope(
    { ...f.payload, retirementSha256: 'e'.repeat(64) },
    fingerprint,
    device.privateKey
  )
  await expect(lookup(changed)).rejects.toMatchObject({ code: 'clock_recovery_conflict' })
  const other = await signEnvelope(
    { ...f.payload, requestId: randomUUID() },
    fingerprint,
    device.privateKey
  )
  await expect(approve(other)).rejects.toMatchObject({ code: 'clock_recovery_conflict' })
})
it('rejects a real foreign signature before reading or writing accepted requests', async () => {
  const f = await makeProof(),
    forged = await signEnvelope(f.payload, fingerprint, server.privateKey)
  m.rpc.mockClear()
  await expect(approve(forged)).rejects.toMatchObject({ code: 'invalid_clock_recovery_proof' })
  expect(m.rpc.mock.calls.map((c) => c[0])).toEqual(['pos_native_clock_recovery_context'])
})

it('rejects a new approval after live device revocation even with correct password', async () => {
  const f = await makeProof()
  await db!.query('update pos_devices set active=false where id=$1', [ids.device])
  try {
    await expect(approve(f.proof)).rejects.toMatchObject({ status: 403 })
  } finally {
    await db!.query('update pos_devices set active=true where id=$1', [ids.device])
  }
  expect(await lookup(f.proof)).toEqual({ status: 'not_found' })
})
it('same manifest may be approved for a later generation but cannot rewrite the old generation', async () => {
  const f = await makeProof()
  await approve(f.proof)
  const later = await makeProof({ ...f.payload, requestId: randomUUID(), oldClockGeneration: 1 })
  expect((await approve(later.proof)).status).toBe('approved')
  const changed = await makeProof({ ...f.payload, oldClockSha256: 'f'.repeat(64) })
  await expect(lookup(changed.proof)).rejects.toMatchObject({ code: 'clock_recovery_conflict' })
})
