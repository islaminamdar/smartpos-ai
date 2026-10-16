import { beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), device: vi.fn() }))
vi.mock('@/lib/pos/server/client', async (o) => ({
  ...(await o<typeof import('@/lib/pos/server/client')>()),
  authenticatedPosClient: m.auth,
}))
vi.mock('@/lib/pos/server/live-access', async (o) => ({
  ...(await o<typeof import('@/lib/pos/server/live-access')>()),
  requireDevice: m.device,
}))
import { GET, POST } from '@/app/api/pos/kitchen-returns/route'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  actor = id(1),
  branch = id(2),
  device = id(3),
  noticeId = id(4)
const body = { branchId: branch, deviceId: device, noticeId },
  list = { status: 'ready', branchId: branch, pendingCount: 0, notices: [], nextCursor: null },
  ack = { status: 'acknowledged', branchId: branch, noticeId, replayed: false }
const get = (suffix = '') =>
  new Request(
    `http://localhost/api/pos/kitchen-returns?branchId=${branch}&deviceId=${device}${suffix}`
  )
const post = (data: unknown = body, origin = 'http://localhost', who = actor) =>
  new Request('http://localhost/api/pos/kitchen-returns', {
    method: 'POST',
    headers: { origin, 'x-pos-actor': who },
    body: JSON.stringify(data),
  })
beforeEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  m.auth.mockResolvedValue({ client: { rpc: m.rpc }, user: { id: actor } })
  m.device.mockResolvedValue('binding')
})
it('binds reads and acknowledgements, including when selling is paused', async () => {
  vi.stubEnv('POS_LIVE_SALES_ENABLED', 'false')
  m.rpc
    .mockResolvedValueOnce({ data: list, error: null })
    .mockResolvedValueOnce({ data: ack, error: null })
  expect((await GET(get())).status).toBe(200)
  expect((await POST(post())).status).toBe(200)
  expect(m.rpc).toHaveBeenLastCalledWith('pos_acknowledge_kitchen_return', {
    p_branch: branch,
    p_device: device,
    p_notice: noticeId,
    p_binding: 'binding',
  })
})
it('rejects crossed actor, foreign origin, oversized data and unknown fields before RPC', async () => {
  expect((await POST(post(body, 'http://localhost', id(9)))).status).toBe(409)
  expect((await POST(post(body, 'https://other.invalid'))).status).toBe(403)
  expect((await POST(post({ ...body, amount: 1 }))).status).toBe(422)
  expect((await POST(post({ padding: 'x'.repeat(1025) }))).status).toBe(413)
  expect(m.rpc).not.toHaveBeenCalled()
})
it('rejects duplicate/partial cursors and foreign ACK instead of removing notice', async () => {
  expect((await GET(get('&deviceId=' + device))).status).toBe(422)
  expect((await GET(get('&afterId=' + noticeId))).status).toBe(422)
  m.rpc.mockResolvedValue({ data: { ...ack, noticeId: id(8) }, error: null })
  expect((await POST(post())).status).toBe(503)
})
it('checks response list scope and maps permission failures', async () => {
  m.rpc
    .mockResolvedValueOnce({ data: { ...list, branchId: id(8) }, error: null })
    .mockResolvedValueOnce({ data: null, error: { message: 'POS_ACCESS_DENIED' } })
  expect((await GET(get())).status).toBe(503)
  expect((await GET(get())).status).toBe(403)
})
