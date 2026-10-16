// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ limit: vi.fn(), register: vi.fn(), recover: vi.fn() }))
vi.mock('@/lib/pos/offline/server', () => ({ limitOfflineRecovery: m.limit }))
vi.mock('@/lib/pos/offline/payment-retrieval', () => ({
  registerAndRecoverOfflinePayment: m.register, recoverOfflinePaymentResolution: m.recover,
}))
import { POST as register } from '@/app/api/pos/offline/payment-freeze/route'
import { POST as recover } from '@/app/api/pos/offline/payment-resolution/route'
import { PosServerError } from '@/lib/pos/server/client'
beforeEach(() => vi.resetAllMocks())
const request = (body: string) => new Request('https://pos.example.test/api/pos/offline/payment-resolution', { method: 'POST', body })
it.each([
  ['registration', register, m.register, 1_420_000],
  ['retrieval', recover, m.recover, 16_384],
] as const)('%s bounds streamed UTF-8 bytes and limits before consuming the request', async (_, route, service, limit) => {
  const oversized = request('é'.repeat(Math.floor(limit / 2) + 1))
  expect((await route(oversized)).status).toBe(413)
  expect(service).not.toHaveBeenCalled()
  m.limit.mockRejectedValueOnce(new PosServerError('rate_limited', 429))
  const unread = request('{}')
  expect((await route(unread)).status).toBe(429)
  expect(unread.bodyUsed).toBe(false)
  expect(service).not.toHaveBeenCalled()
})
it.each([[register, m.register], [recover, m.recover]] as const)('passes device proof to the verifier without requiring a browser session', async (route, service) => {
  const proof = { queryEnvelope: { synthetic: true } }
  service.mockResolvedValueOnce({ state: 'pending' })
  const response = await route(request(JSON.stringify(proof)))
  expect(response.status).toBe(200)
  expect(service).toHaveBeenCalledExactlyOnceWith(proof)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('set-cookie')).toBeNull()
})
it('does not expose internal errors or accept malformed JSON', async () => {
  expect((await recover(request('{'))).status).toBe(400)
  expect(m.recover).not.toHaveBeenCalled()
  m.recover.mockRejectedValueOnce(new Error('private signing material'))
  const response = await recover(request('{}'))
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ status: 'unavailable', code: 'storage_unavailable' })
  expect(response.headers.get('cache-control')).toBe('private, no-store')
})
