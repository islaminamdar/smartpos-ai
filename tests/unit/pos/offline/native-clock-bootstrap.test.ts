// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
const m = vi.hoisted(() => ({ rpc: vi.fn(), auth: vi.fn() }))
vi.mock('@/lib/pos/server/client', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/client')>()),
  posClient: () => ({ rpc: m.rpc }),
  authenticatedPosClient: m.auth,
}))
import { POST } from '@/app/api/pos/native/clock-bootstrap/route'
import {
  nativeClockBootstrap,
  nativeClockBootstrapRequestSchema,
  nativeClockBootstrapTimeSchema,
} from '@/lib/pos/offline/native-clock-bootstrap'
import { canonicalJson, encodeBase64Url } from '@/lib/pos/offline/canonical'
import { verifySignedEnvelope } from '@/lib/pos/offline/authority'
import { nativeClockRecoveryTimeSchema } from '@/lib/pos/offline/native-clock-recovery'
import { publicReleaseAccess } from '@/lib/pos/public-release'
import { hashToken } from '@/lib/pos/server/live-access'
import { loginSourceKey } from '@/lib/pos/server/login-source'

let key: CryptoKeyPair
const body = () => ({
  schemaVersion: 1,
  installationId: '00000000-0000-4000-8000-000000000001',
  deviceKeySha256: 'a'.repeat(64),
  oldClockGeneration: 0,
  oldClockSha256: 'b'.repeat(64),
  challenge: 'c'.repeat(64),
})
const http = (value: unknown = body(), headers: Record<string, string> = {}) =>
  new Request('https://pos.example.test/api/pos/native/clock-bootstrap', {
    method: 'POST',
    headers: {
      origin: 'https://pos.example.test',
      'x-forwarded-for': '192.0.2.10',
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof value === 'string' ? value : canonicalJson(value),
  })

beforeEach(async () => {
  vi.resetAllMocks()
  vi.stubEnv('POS_PUBLIC_ORIGIN', 'https://pos.example.test')
  vi.stubEnv('POS_LOGIN_SOURCE_MODE', 'apache-rightmost')
  vi.stubEnv('POS_ONLINE_PILOT', 'false')
  vi.stubEnv('POS_OFFLINE_SALES_ENABLED', 'false')
  key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  vi.stubEnv('POS_OFFLINE_SIGNING_KEY_ID', 'bootstrap-test')
  vi.stubEnv(
    'POS_OFFLINE_SERVER_KEYS',
    JSON.stringify([
      {
        id: 'bootstrap-test',
        publicKeySpki: encodeBase64Url(
          new Uint8Array(await crypto.subtle.exportKey('spki', key.publicKey))
        ),
        privateKeyPkcs8: encodeBase64Url(
          new Uint8Array(await crypto.subtle.exportKey('pkcs8', key.privateKey))
        ),
      },
    ])
  )
  m.rpc.mockResolvedValue({ data: true, error: null })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

it('signs only fresh server time and exact opaque context without granting authority or requiring cookies', async () => {
  const start = Date.now()
  const request = http(body(), { cookie: 'untrusted=ignored' })
  const response = await POST(request)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.has('set-cookie')).toBe(false)
  const result = await response.json()
  expect(Object.keys(result).sort()).toEqual(['status', 'time'])
  expect(result.status).toBe('ready')
  const verified = await verifySignedEnvelope(result.time, nativeClockBootstrapTimeSchema, {
    'bootstrap-test': key.publicKey,
  })
  expect(verified.payload).toEqual({
    ...body(),
    kind: 'native-clock-bootstrap-time',
    serverTimeMs: expect.any(Number),
  })
  expect(verified.payload.serverTimeMs).toBeGreaterThanOrEqual(start)
  expect(verified.payload.serverTimeMs).toBeLessThanOrEqual(Date.now())
  expect(m.auth).not.toHaveBeenCalled()
  expect(m.rpc.mock.calls).toEqual([
    ['pos_offline_limit', { p_source: hashToken('native-clock-bootstrap-global-v1') }],
    [
      'pos_offline_limit',
      { p_source: hashToken(`native-clock-bootstrap-source-v1:${loginSourceKey(request)}`) },
    ],
  ])
  await expect(
    verifySignedEnvelope(result.time, nativeClockRecoveryTimeSchema, {
      'bootstrap-test': key.publicKey,
    })
  ).rejects.toThrow()
})

it('fresh challenges produce independently bound proofs and cannot verify under a different key', async () => {
  const first = await nativeClockBootstrap(body())
  const second = await nativeClockBootstrap({ ...body(), challenge: 'd'.repeat(64) })
  const decoded = await verifySignedEnvelope(second.time, nativeClockBootstrapTimeSchema, {
    'bootstrap-test': key.publicKey,
  })
  expect(decoded.payload.challenge).toBe('d'.repeat(64))
  expect(second.time.payloadBase64Url).not.toBe(first.time.payloadBase64Url)
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  await expect(
    verifySignedEnvelope(second.time, nativeClockBootstrapTimeSchema, {
      'bootstrap-test': other.publicKey,
    })
  ).rejects.toThrow()
  expect(m.rpc).not.toHaveBeenCalled()
})

it.each([
  { schemaVersion: 2 },
  { installationId: 'not-a-uuid' },
  { installationId: '00000000-0000-4000-8000-00000000000A' },
  { deviceKeySha256: 'A'.repeat(64) },
  { oldClockSha256: null },
  { oldClockGeneration: -1 },
  { oldClockGeneration: Number.MAX_SAFE_INTEGER },
  { oldClockGeneration: 0.1 },
  { oldClockGeneration: '0' },
  { challenge: 'c'.repeat(63) },
  { challenge: 'C'.repeat(64) },
  { password: 'must-not-be-accepted' },
  { serverTimeMs: 0 },
  { kind: 'native-clock-recovery-time' },
  { approval: {} },
])('rejects invalid or extra fields %j before signing', async (change) => {
  const input = { ...body(), ...change }
  expect(nativeClockBootstrapRequestSchema.safeParse(input).success).toBe(false)
  const response = await POST(
    http(
      typeof change.oldClockGeneration === 'number' && !Number.isInteger(change.oldClockGeneration)
        ? JSON.stringify(input)
        : input
    )
  )
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({ code: 'invalid_offline_request' })
})

it('accepts the largest generation that can still advance exactly once', async () => {
  const result = await nativeClockBootstrap({
    ...body(),
    oldClockGeneration: Number.MAX_SAFE_INTEGER - 1,
  })
  const verified = await verifySignedEnvelope(result.time, nativeClockBootstrapTimeSchema, {
    'bootstrap-test': key.publicKey,
  })
  expect(verified.payload.oldClockGeneration).toBe(Number.MAX_SAFE_INTEGER - 1)
})

it.each(['{} ', '{', '{"challenge":"x","challenge":"y"}', 'null', '[]'])(
  'rejects malformed/noncanonical body %s',
  async (input) => {
    expect((await POST(http(input))).status).toBe(422)
  }
)

it('bounds chunked and declared bytes before signing', async () => {
  expect((await POST(http('x'.repeat(2049)))).status).toBe(413)
  expect((await POST(http(body(), { 'content-length': '2049' }))).status).toBe(413)
})

it('rejects invalid UTF-8 without replacing bytes', async () => {
  const request = http()
  const response = await POST(
    new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: new Uint8Array([0xff]),
    })
  )
  expect(response.status).toBe(422)
})

it('cancels a stalled body at its deadline', async () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  const base = http()
  const request = new Request(base.url, {
    method: 'POST',
    headers: base.headers,
    body: new ReadableStream({ pull() {}, cancel }),
    duplex: 'half',
  } as RequestInit)
  const pending = POST(request)
  await vi.advanceTimersByTimeAsync(10_001)
  const response = await pending
  expect(response.status).toBe(408)
  expect(cancel).toHaveBeenCalledOnce()
})

it.each([false, null, 'true'])(
  'global limiter %j denies before allocating a source row',
  async (allowed) => {
    m.rpc.mockResolvedValue({ data: allowed, error: null })
    const response = await POST(http())
    expect(response.status).toBe(allowed === false ? 429 : 503)
    expect(m.rpc).toHaveBeenCalledTimes(1)
  }
)

it('source limit denies signing and database failures fail closed', async () => {
  m.rpc
    .mockResolvedValueOnce({ data: true, error: null })
    .mockResolvedValueOnce({ data: false, error: null })
  expect((await POST(http())).status).toBe(429)
  m.rpc.mockResolvedValue({ data: true, error: { message: 'private database detail' } })
  const response = await POST(http())
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain('private database detail')
})

it('rejects wrong origin and untrusted source configuration without consuming quota', async () => {
  expect((await POST(http(body(), { origin: 'https://attacker.test' }))).status).toBe(403)
  expect((await POST(http(body(), { 'sec-fetch-site': 'cross-site' }))).status).toBe(403)
  expect((await POST(http(body(), { 'x-forwarded-for': 'invalid' }))).status).toBe(503)
  vi.stubEnv('POS_LOGIN_SOURCE_MODE', '')
  expect((await POST(http())).status).toBe(503)
  expect(m.rpc).not.toHaveBeenCalled()
})

it('fails closed without a signing key or with a mismatched signer', async () => {
  vi.stubEnv('POS_OFFLINE_SERVER_KEYS', '')
  expect((await POST(http())).status).toBe(503)
  vi.stubEnv(
    'POS_OFFLINE_SERVER_KEYS',
    JSON.stringify([{ id: 'wrong', publicKeySpki: 'bad', privateKeyPkcs8: 'bad' }])
  )
  const response = await POST(http())
  expect(response.status).toBe(503)
  expect(response.headers.has('set-cookie')).toBe(false)
})

it('allows only this exact POST path in paused and online modes', () => {
  for (const pilot of [false, true]) {
    expect(publicReleaseAccess('/api/pos/native/clock-bootstrap', 'POST', pilot)).toBe('allow')
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'])
      expect(publicReleaseAccess('/api/pos/native/clock-bootstrap', method, pilot)).not.toBe(
        'allow'
      )
    expect(publicReleaseAccess('/api/pos/native/clock-bootstrap/extra', 'POST', pilot)).not.toBe(
      'allow'
    )
  }
})

it('processes real captured Android transport through the production route and signer', async () => {
  const fixture = JSON.parse(
    await readFile('tests/unit/pos/fixtures/native-clock-bootstrap-android-output.json', 'utf8')
  )
  const response = await POST(http(fixture.canonicalRequest))
  expect(response.status).toBe(200)
  const result = await response.json()
  const verified = await verifySignedEnvelope(result.time, nativeClockBootstrapTimeSchema, {
    'bootstrap-test': key.publicKey,
  })
  expect(verified.payload).toEqual({
    ...fixture.request,
    kind: 'native-clock-bootstrap-time',
    serverTimeMs: expect.any(Number),
  })
})
