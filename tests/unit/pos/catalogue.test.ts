import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { catalogueUpdateSchema } from '@/lib/pos/server/catalogue'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), binding: vi.fn() }))
vi.mock('@/lib/pos/server/client', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/client')>()),
  authenticatedPosClient: mocks.auth,
}))
vi.mock('@/lib/pos/server/live-access', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/live-access')>()),
  requireDevice: mocks.binding,
}))
import { POST, GET } from '@/app/api/pos/catalogue/route'
import { PosServerError } from '@/lib/pos/server/client'
const id = '10000000-0000-4000-8000-000000000001'
const other = '20000000-0000-4000-8000-000000000002'
const command = {
  id,
  branchId: id,
  deviceId: id,
  expectedRevision: 1,
  reason: 'Price reviewed',
  product: {
    id,
    name: 'Sweets',
    category: 'Sweets',
    imageUrl: null,
    unit: 'kg',
    unitPriceFils: 2400,
    taxRateBps: 500,
    active: true,
  },
}
const result = {
  status: 'updated',
  requestId: id,
  replayed: false,
  product: { ...command.product, branchId: id, revision: 2 },
}
const request = (body: unknown, origin = 'http://localhost') =>
  new NextRequest('http://localhost/api/pos/catalogue', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { origin, 'Content-Type': 'application/json' },
  })
beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  mocks.auth.mockResolvedValue({ client: { rpc: mocks.rpc }, user: { id } })
  mocks.binding.mockResolvedValue('binding-hash')
  mocks.rpc.mockResolvedValue({ data: result, error: null })
})
describe('manager catalogue boundary', () => {
  it('requires authentication, pilot gate, origin and original enrolled device', async () => {
    vi.stubEnv('POS_ONLINE_PILOT', 'false')
    expect((await POST(request(command))).status).toBe(503)
    expect(mocks.auth).not.toHaveBeenCalled()
    vi.stubEnv('POS_ONLINE_PILOT', 'true')
    expect((await POST(request(command, 'https://evil.example'))).status).toBe(403)
    expect(mocks.auth).not.toHaveBeenCalled()
    mocks.auth.mockRejectedValueOnce(new PosServerError('authentication_required', 401))
    expect((await POST(request(command))).status).toBe(401)
    mocks.binding.mockRejectedValueOnce(new PosServerError('device_binding_required', 403))
    expect((await POST(request(command))).status).toBe(403)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('rejects unsafe assets, free active items, fractional money, unexpected tax and injected fields', async () => {
    for (const patch of [
      { imageUrl: 'https://evil.example/a.webp' },
      { imageUrl: '/pos-assets/menu/../a.webp' },
      { unitPriceFils: 0 },
      { unitPriceFils: 1.5 },
      { taxRateBps: 0 },
      { revision: 7 },
      { unit: 'each' },
    ]) {
      expect(
        (await POST(request({ ...command, product: { ...command.product, ...patch } }))).status
      ).toBe(422)
    }
    expect(
      catalogueUpdateSchema.safeParse({
        ...command,
        expectedRevision: 0,
        product: { ...command.product, unitPriceFils: 0, active: false },
      }).success
    ).toBe(true)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('sends frozen revision and request ID, validates matching ACK, never caches menu replies', async () => {
    const response = await POST(request(command))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(mocks.rpc).toHaveBeenCalledWith('pos_manage_catalogue', {
      p_command: command,
      p_binding: 'binding-hash',
    })
    mocks.rpc.mockResolvedValue({ data: { ...result, requestId: other }, error: null })
    expect((await POST(request(command))).status).toBe(503)
  })
  it('preserves edit conflicts and permissions while hiding database details', async () => {
    for (const [message, status] of [
      ['POS_CATALOGUE_CONFLICT', 409],
      ['POS_IDEMPOTENCY_CONFLICT', 409],
      ['POS_ACCESS_DENIED', 403],
      ['POS_DEVICE_INVALID', 403],
      ['POS_INVALID_COMMAND', 422],
      ['private diagnostic', 503],
    ] as const) {
      mocks.rpc.mockResolvedValue({ data: null, error: { message } })
      const response = await POST(request(command))
      expect(response.status).toBe(status)
      expect(JSON.stringify(await response.json())).not.toContain('private diagnostic')
    }
  })
  it('requires an explicit manager branch membership before reading unavailable items', async () => {
    const chain = (data: unknown) => {
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data, error: null }),
      }
      return q
    }
    mocks.auth.mockResolvedValue({
      client: {
        from: (table: string) =>
          chain(
            table === 'pos_branches' ? { organization_id: id } : { role: 'cashier', branch_id: id }
          ),
      },
      user: { id },
    })
    expect(
      (await GET(new Request(`http://localhost/api/pos/catalogue?branchId=${id}`))).status
    ).toBe(403)
    mocks.auth.mockResolvedValue({
      client: {
        from: (table: string) =>
          chain(
            table === 'pos_branches'
              ? { organization_id: id }
              : { role: 'manager', branch_id: other }
          ),
      },
      user: { id },
    })
    expect(
      (await GET(new Request(`http://localhost/api/pos/catalogue?branchId=${id}`))).status
    ).toBe(403)
    expect(
      (await GET(new Request(`http://localhost/api/pos/catalogue?branchId=${id}&other=value`)))
        .status
    ).toBe(422)
  })
})
