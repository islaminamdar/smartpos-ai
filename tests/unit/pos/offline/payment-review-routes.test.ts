// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ actor: vi.fn(), list: vi.fn(), detail: vi.fn(), decide: vi.fn() }))
vi.mock('@/lib/pos/offline/payment-review', () => ({ paymentReviewActor: m.actor,
  listPaymentReviews: m.list, readPaymentReview: m.detail, decidePaymentReview: m.decide }))
import { GET as list } from '@/app/api/pos/manager/offline-payments/route'
import { GET as detail } from '@/app/api/pos/manager/offline-payments/case/route'
import { POST as decide } from '@/app/api/pos/manager/offline-payments/resolve/route'
import { PosServerError } from '@/lib/pos/server/client'
const origin = 'https://pos.example.test'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const user = { id: id(1), email: 'synthetic-manager@example.test' }
const command = { requestId: id(2), freezeId: id(3), freezeSha256: 'a'.repeat(64),
  decision: 'payment_voided', reason: 'Terminal confirms authorization void.',
  evidence: [{ method: 'card', amountFils: 1000, paymentObservedAt: '2026-10-16T10:00:00.000Z',
    completedAt: '2026-10-16T10:02:00.000Z', reference: 'synthetic-void', note: 'Terminal record checked.' }], cashDrawerShiftId: null }
const body = () => ({ branchId: id(4), request: command, currentPassword: 'synthetic-only' })
const post = (value: unknown = body(), headers: Record<string, string> = { Origin: origin }) =>
  new Request(`${origin}/api/pos/manager/offline-payments/resolve`, {
    method: 'POST', headers, body: typeof value === 'string' ? value : JSON.stringify(value),
  })
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('POS_PUBLIC_ORIGIN', origin); m.actor.mockResolvedValue(user) })
afterEach(() => vi.unstubAllEnvs())
it('checks exact Origin before authentication or reading a payment decision', async () => {
  const origins: Record<string, string>[] = [{}, { Origin: 'https://hostile.example.test' }, { Origin: origin, 'sec-fetch-site': 'cross-site' }]
  for (const headers of origins) {
    const result = await decide(post(body(), headers))
    expect(result.status).toBe(403)
    expect(await result.json()).toMatchObject({ code: 'origin_rejected' })
  }
  expect(m.actor).not.toHaveBeenCalled(); expect(m.decide).not.toHaveBeenCalled()
})
it('passes only the authenticated identity with the strict decision and no cache', async () => {
  m.decide.mockResolvedValue({ status: 'delivery_pending' })
  const request = post(), response = await decide(request)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(m.decide).toHaveBeenCalledWith(request, user, id(4), command, 'synthetic-only')
})
it('rejects submitted actors and forged confirmation, nested extras and oversized bodies', async () => {
  for (const value of [{ ...body(), actorId: id(5) }, { ...body(), confirmedAt: new Date().toISOString() },
    { ...body(), request: { ...command, managerActorId: id(5) } }, { ...body(), currentPassword: 'x'.repeat(257) }]) {
    expect((await decide(post(value))).status).toBe(422)
  }
  expect((await decide(post('x'.repeat(16_385)))).status).toBe(413)
  expect((await decide(post('{'))).status).toBe(400)
  expect(m.decide).not.toHaveBeenCalled()
})
it('returns bounded authentication and service failures without leaking details or credentials', async () => {
  m.actor.mockRejectedValueOnce(new PosServerError('authentication_required', 401))
  expect((await decide(post())).status).toBe(401)
  m.decide.mockRejectedValueOnce(new Error('private internal synthetic-only failure'))
  const response = await decide(post())
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ status: 'unavailable', code: 'storage_unavailable' })
  expect(response.headers.get('cache-control')).toBe('private, no-store')
})
it('list and detail use current identity and exact scoped query fields', async () => {
  m.list.mockResolvedValue({ cases: [], nextCursor: null })
  m.detail.mockResolvedValue({ nativeDelivery: 'not_confirmed' })
  const cursor = JSON.stringify({ recordedAt: '2026-10-16T10:00:00.123456Z', caseId: id(3), caseKind: 'freeze' })
  const response = await list(new Request(`${origin}/api/pos/manager/offline-payments?branchId=${id(4)}&cursor=${encodeURIComponent(cursor)}`))
  expect(response.status).toBe(200)
  expect(m.list).toHaveBeenCalledWith(user.id, id(4), cursor)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  const result = await detail(new Request(`${origin}/api/pos/manager/offline-payments/case?branchId=${id(4)}&caseId=${id(3)}&caseKind=raw`))
  expect(result.status).toBe(200)
  expect(m.detail).toHaveBeenCalledWith(user.id, id(4), id(3), 'raw')
  for (const query of ['', `branchId=${id(4)}&actorId=${id(5)}`, `branchId=${id(4)}&cursor=${'x'.repeat(401)}`])
    expect((await list(new Request(`${origin}/api/pos/manager/offline-payments?${query}`))).status).toBe(422)
  expect((await detail(new Request(`${origin}/api/pos/manager/offline-payments/case?branchId=${id(4)}&caseId=${id(3)}&caseKind=other`))).status).toBe(422)
})
