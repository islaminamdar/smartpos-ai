import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), binding: vi.fn() }))
vi.mock('@/lib/pos/server/client', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/client')>()),
  authenticatedPosClient: mocks.auth,
}))
vi.mock('@/lib/pos/server/live-access', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/live-access')>()),
  recoveryBinding: mocks.binding,
}))
import { POST } from '@/app/api/pos/recovery/route'
const id = '00000000-0000-4000-8000-000000000001'
const payload = {
  id,
  branchId: id,
  deviceId: id,
  shiftId: id,
  type: 'shift.open',
  openingCashFils: 1000,
}
const request = () =>
  new Request('https://pos.example/api/pos/recovery', {
    method: 'POST',
    headers: { origin: 'https://pos.example' },
    body: JSON.stringify({ kind: 'command', request: payload }),
  })
beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  vi.stubEnv('POS_LIVE_SALES_ENABLED', 'false')
  mocks.auth.mockResolvedValue({ client: { rpc: mocks.rpc }, user: { id } })
  mocks.binding.mockResolvedValue('binding-hash')
})
describe('durable online request recovery', () => {
  it('works while financial writes paused but requires exact tombstone acknowledgement', async () => {
    mocks.rpc.mockResolvedValue({
      data: { status: 'cancelled', requestId: id, kind: 'command', replayed: false },
      error: null,
    })
    expect((await POST(request())).status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith('pos_resolve_live_request', {
      p_kind: 'command',
      p_request: payload,
      p_binding: 'binding-hash',
    })
    mocks.rpc.mockResolvedValue({
      data: { status: 'cancelled', requestId: 'another', kind: 'command' },
      error: null,
    })
    expect((await POST(request())).status).toBe(503)
  })
  it('returns an already committed matching acknowledgement without cancelling it', async () => {
    mocks.rpc.mockResolvedValue({
      data: { status: 'applied', commandId: id, replayed: true },
      error: null,
    })
    const result = await POST(request())
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ status: 'applied', commandId: id })
  })
  it('only accepts committed acknowledgements after access is revoked', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ error: { message: 'POS_ACCESS_DENIED' } })
      .mockResolvedValueOnce({
        data: { status: 'applied', commandId: id, replayed: true },
        error: null,
      })
    expect((await POST(request())).status).toBe(200)
    expect(mocks.rpc).toHaveBeenLastCalledWith('pos_lookup_own_committed_request', {
      p_kind: 'command',
      p_request: payload,
      p_binding: 'binding-hash',
    })
    mocks.rpc
      .mockResolvedValueOnce({ error: { message: 'POS_ACCESS_DENIED' } })
      .mockResolvedValueOnce({
        data: { status: 'cancelled', requestId: id, kind: 'command' },
        error: null,
      })
    expect((await POST(request())).status).toBe(503)
    mocks.rpc
      .mockResolvedValueOnce({ error: { message: 'POS_ACCESS_DENIED' } })
      .mockResolvedValueOnce({ error: { message: 'POS_STAFF_INACTIVE' } })
    const inactive = await POST(request())
    expect(inactive.status).toBe(403)
    expect(await inactive.json()).toMatchObject({ code: 'staff_inactive' })
  })
  it('never clears on ambiguous storage errors or payload conflicts', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'db unavailable' } })
    expect((await POST(request())).status).toBe(503)
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'POS_IDEMPOTENCY_CONFLICT' } })
    expect((await POST(request())).status).toBe(409)
  })
})
