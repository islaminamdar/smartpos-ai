// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ rpc: vi.fn(), keys: vi.fn() }))
vi.mock('@/lib/pos/server/client', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/client')>()),
  posClient: () => ({ rpc: m.rpc }),
}))
vi.mock('@/lib/pos/offline/server-keys', () => ({ offlineServerKeys: m.keys }))

import { POST } from '@/app/api/pos/native/clock-bootstrap/route'
import { canonicalJson } from '@/lib/pos/offline/canonical'
import { hashToken } from '@/lib/pos/server/live-access'

const input = {
  schemaVersion: 1,
  installationId: '00000000-0000-4000-8000-000000000001',
  deviceKeySha256: 'a'.repeat(64),
  oldClockGeneration: 0,
  oldClockSha256: 'b'.repeat(64),
  challenge: 'c'.repeat(64),
}
const request = (body: BodyInit) =>
  new Request('https://pos.example.test/api/pos/native/clock-bootstrap', {
    method: 'POST',
    headers: { origin: 'https://pos.example.test', 'x-forwarded-for': '192.0.2.10' },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('POS_PUBLIC_ORIGIN', 'https://pos.example.test')
  vi.stubEnv('POS_LOGIN_SOURCE_MODE', 'apache-rightmost')
  m.rpc.mockResolvedValue({ data: true, error: null })
  m.keys.mockRejectedValue(new Error('Synthetic unavailable signer'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

it('expires and cancels a stalled chunked body before any signing work', async () => {
  vi.useFakeTimers()
  const cancelled = vi.fn()
  const stream = new ReadableStream<Uint8Array>({ cancel: cancelled })
  const pending = POST(request(stream))
  await vi.advanceTimersByTimeAsync(10_001)
  const result = await pending
  expect(result.status).toBe(408)
  expect(await result.json()).toEqual({ code: 'upload_timeout' })
  expect(cancelled).toHaveBeenCalledOnce()
  expect(m.rpc).toHaveBeenCalledTimes(2)
  expect(m.keys).not.toHaveBeenCalled()
})

it('bounds actual chunked bytes without trusting Content-Length', async () => {
  const cancelled = vi.fn()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1_024))
      controller.enqueue(new Uint8Array(1_025))
    },
    cancel: cancelled,
  })
  const result = await POST(request(stream))
  expect(result.status).toBe(413)
  expect(cancelled).toHaveBeenCalledOnce()
  expect(m.keys).not.toHaveBeenCalled()
})

it.each([
  ['duplicate key', canonicalJson(input).replace('{', '{"challenge":"' + 'd'.repeat(64) + '",')],
  ['noncanonical whitespace', ' ' + canonicalJson(input)],
  ['noncanonical escape', canonicalJson(input).replace('aaaa', '\\u0061aaa')],
  ['malformed UTF-8', new Uint8Array([123, 34, 255, 34, 58, 48, 125])],
] as const)('rejects %s before fetching a signing key', async (_name, body) => {
  const result = await POST(request(body))
  expect(result.status).toBe(422)
  expect(m.keys).not.toHaveBeenCalled()
  expect(result.headers.get('cache-control')).toBe('private, no-store')
  expect(result.headers.get('set-cookie')).toBeNull()
})

it('exhausted global quota does not create source buckets or perform signing', async () => {
  m.rpc.mockResolvedValueOnce({ data: false, error: null })
  const result = await POST(request(canonicalJson(input)))
  expect(result.status).toBe(429)
  expect(m.rpc.mock.calls).toEqual([
    ['pos_offline_limit', { p_source: hashToken('native-clock-bootstrap-global-v1') }],
  ])
  expect(m.keys).not.toHaveBeenCalled()
})

it.each([null, 'true', 1, {}, []])(
  'denies malformed limiter response %j before signing',
  async (data) => {
    m.rpc.mockResolvedValueOnce({ data, error: null })
    const result = await POST(request(canonicalJson(input)))
    expect(result.status).toBe(503)
    expect(m.rpc).toHaveBeenCalledOnce()
    expect(m.keys).not.toHaveBeenCalled()
  }
)

it('untrusted proxy configuration fails without any rate or signing work', async () => {
  vi.stubEnv('POS_LOGIN_SOURCE_MODE', 'untrusted-forwarded-header')
  const result = await POST(request(canonicalJson(input)))
  expect(result.status).toBe(503)
  expect(m.rpc).not.toHaveBeenCalled()
  expect(m.keys).not.toHaveBeenCalled()
})
