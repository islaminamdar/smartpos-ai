// @vitest-environment node
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), admin: vi.fn(), rpc: vi.fn(), binding: vi.fn() }))
vi.mock('@/lib/pos/server/client', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/client')>()),
  authenticatedPosClient: mocks.auth,
  posClient: mocks.admin,
}))
vi.mock('@/lib/pos/server/live-access', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/live-access')>()),
  requireDevice: mocks.binding,
}))
import { POST } from '@/app/api/pos/catalogue/photo/route'
import { GET, HEAD } from '@/app/pos-assets/menu/[filename]/route'
import { PosServerError } from '@/lib/pos/server/client'
import { menuPhotoUrl } from '@/lib/pos/menu-photo'
import { publicReleaseAccess } from '@/lib/pos/public-release'
const branch = '10000000-0000-4000-8000-000000000001',
  device = '20000000-0000-4000-8000-000000000002',
  actor = '30000000-0000-4000-8000-000000000003',
  photo = '40000000-0000-4000-8000-000000000004'
const context = { organizationId: branch, branchId: branch, deviceId: device, actorId: actor }
const url = `http://localhost/api/pos/catalogue/photo?branchId=${branch}&deviceId=${device}`
const request = (body: Uint8Array, extra: Record<string, string> = {}) =>
  new Request(url, {
    method: 'POST',
    body: new Uint8Array(body),
    headers: { origin: 'http://localhost', 'Content-Type': 'image/png', ...extra },
  })
const png = async () =>
  sharp({ create: { width: 40, height: 30, channels: 3, background: 'red' } })
    .png()
    .toBuffer()
let stored: Record<string, unknown>
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  vi.stubEnv('POS_PUBLIC_ORIGIN', 'http://localhost')
  mocks.auth.mockResolvedValue({ client: {}, user: { id: actor } })
  mocks.binding.mockResolvedValue('a'.repeat(64))
  mocks.admin.mockReturnValue({ rpc: mocks.rpc })
  mocks.rpc.mockImplementation(async (name: string, args: any) => {
    if (name === 'pos_menu_media_context') return { data: context, error: null }
    if (name === 'pos_menu_media_read') return { data: stored, error: null }
    const media = args.p_media
    stored = { ...media, id: photo }
    return {
      data: {
        status: 'ready',
        image: {
          id: photo,
          branchId: branch,
          imageUrl: menuPhotoUrl(photo),
          sha256: media.sha256,
          width: media.width,
          height: media.height,
          byteLength: media.byteLength,
        },
        replayed: true,
      },
      error: null,
    }
  })
})
afterEach(() => vi.unstubAllEnvs())
it('uploads real processed pixels with verified actor/binding, returns dedup ID and never changes catalogue', async () => {
  const response = await POST(request(await png()))
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect((await response.json()).image.imageUrl).toBe(menuPhotoUrl(photo))
  expect(mocks.rpc.mock.calls.map((c) => c[0])).toEqual([
    'pos_menu_media_context',
    'pos_menu_media_register',
  ])
  expect(mocks.rpc.mock.calls[1][1]).toMatchObject({
    p_actor: actor,
    p_branch: branch,
    p_device: device,
    p_binding: 'a'.repeat(64),
  })
  const data = Buffer.from(stored.base64 as string, 'base64')
  expect((await sharp(data).metadata()).format).toBe('webp')
})
it('denies origin, auth, binding, cashier and rate-limited requests before consuming bytes', async () => {
  const bytes = await png()
  expect((await POST(request(bytes, { origin: 'https://other.example' }))).status).toBe(403)
  expect(mocks.auth).not.toHaveBeenCalled()
  mocks.auth.mockRejectedValueOnce(new PosServerError('authentication_required', 401))
  expect((await POST(request(bytes))).status).toBe(401)
  mocks.binding.mockRejectedValueOnce(new PosServerError('device_binding_required', 403))
  expect((await POST(request(bytes))).status).toBe(403)
  for (const [code, status] of [
    ['POS_MANAGER_REQUIRED', 403],
    ['POS_MEDIA_RATE_LIMIT', 429],
    ['private diagnostic', 503],
  ] as const) {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: code } })
    const req = request(bytes)
    const response = await POST(req)
    expect(response.status).toBe(status)
    expect(req.bodyUsed).toBe(false)
    expect(await response.text()).not.toContain('private diagnostic')
  }
})
it('fails closed for pilot gate, duplicate query keys, extra parameters and unsupported MIME', async () => {
  const bytes = await png()
  vi.stubEnv('POS_ONLINE_PILOT', 'false')
  expect((await POST(request(bytes))).status).toBe(503)
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  for (const suffix of [`&branchId=${branch}`, '&actor=else'])
    expect(
      (
        await POST(
          new Request(url + suffix, {
            method: 'POST',
            body: new Uint8Array(bytes),
            headers: { origin: 'http://localhost', 'content-type': 'image/png' },
          })
        )
      ).status
    ).toBe(422)
  expect((await POST(request(bytes, { 'Content-Type': 'image/svg+xml' }))).status).toBe(415)
  expect(mocks.rpc).not.toHaveBeenCalled()
})
it('checks actual payload limits and decoder errors without registering media', async () => {
  expect((await POST(request(Buffer.from('not an image')))).status).toBe(422)
  expect((await POST(request(await png(), { 'Content-Length': '6000000' }))).status).toBe(413)
  expect(mocks.rpc.mock.calls.every((c) => c[0] === 'pos_menu_media_context')).toBe(true)
})
it('rejects altered context and contradictory stored confirmations', async () => {
  mocks.rpc.mockResolvedValueOnce({ data: { ...context, actorId: branch }, error: null })
  expect((await POST(request(await png()))).status).toBe(503)
  const normal = mocks.rpc.getMockImplementation()!
  for (const patch of [
    { branchId: device },
    { sha256: 'f'.repeat(64) },
    { width: 999 },
    { imageUrl: '/pos-assets/menu/other.webp' },
    { byteLength: 999 },
  ]) {
    mocks.rpc.mockImplementation(async (name, args) => {
      const r = await normal(name, args)
      return name === 'pos_menu_media_register'
        ? { ...r, data: { ...r.data, image: { ...r.data.image, ...patch } } }
        : r
    })
    expect((await POST(request(await png()))).status).toBe(503)
  }
})
it('maps a revoked manager and storage quota at final registration without reporting upload success', async () => {
  for (const [code, status] of [
    ['POS_MANAGER_REQUIRED', 403],
    ['POS_DEVICE_INVALID', 403],
    ['POS_MEDIA_CAPACITY', 409],
    ['POS_MEDIA_DAILY_LIMIT', 409],
    ['POS_MEDIA_INVALID', 422],
  ] as const) {
    mocks.rpc
      .mockResolvedValueOnce({ data: context, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: code } })
    expect((await POST(request(await png()))).status).toBe(status)
  }
})
it('serves only verified public WebP bytes, supports HEAD/ETag, leaks no storage metadata', async () => {
  await POST(request(await png()))
  const name = menuPhotoUrl(photo).split('/').pop()!,
    ctx = { params: Promise.resolve({ filename: name }) },
    req = new Request('http://localhost' + menuPhotoUrl(photo))
  const response = await GET(req, ctx)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('image/webp')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('cache-control')).toContain('immutable')
  expect(
    createHash('sha256')
      .update(Buffer.from(await response.arrayBuffer()))
      .digest('hex')
  ).toBe(stored.sha256)
  const head = await HEAD(req, ctx)
  expect(await head.text()).toBe('')
  expect(Number(head.headers.get('content-length'))).toBe(stored.byteLength)
  const cached = await GET(
    new Request(req, { headers: { 'if-none-match': response.headers.get('etag')! } }),
    ctx
  )
  expect(cached.status).toBe(304)
  expect(mocks.auth).toHaveBeenCalledTimes(1)
})
it('never caches missing, malformed or corrupt storage results', async () => {
  await POST(request(await png()))
  const ctx = { params: Promise.resolve({ filename: menuPhotoUrl(photo).split('/').pop()! }) },
    req = new Request('http://localhost' + menuPhotoUrl(photo))
  for (const data of [
    null,
    { ...stored, id: branch },
    { ...stored, base64: 'invalid' },
    { ...stored, sha256: 'e'.repeat(64) },
    { ...stored, privateField: 'secret' },
  ]) {
    mocks.rpc.mockResolvedValueOnce({ data, error: null })
    const r = await GET(req, ctx)
    expect(r.status).toBe(data === null ? 404 : 503)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(await r.text()).toBe('')
  }
  mocks.rpc.mockClear()
  for (const name of ['legacy.webp', 'upload_BAD.webp', '../private'])
    expect((await GET(req, { params: Promise.resolve({ filename: name }) })).status).toBe(404)
  expect((await GET(new Request(req.url + '?anything=1'), ctx)).status).toBe(404)
  expect(mocks.rpc).not.toHaveBeenCalled()
})
it('exposes upload only in online pilot and keeps public photo reads available', () => {
  expect(publicReleaseAccess('/api/pos/catalogue/photo', 'POST', true)).toBe('allow')
  expect(publicReleaseAccess('/api/pos/catalogue/photo', 'POST', false)).toBe('unavailable')
  expect(publicReleaseAccess('/api/pos/catalogue/photo', 'GET', true)).toBe('unavailable')
  expect(publicReleaseAccess(menuPhotoUrl(photo), 'GET', false)).toBe('allow')
  expect(publicReleaseAccess(menuPhotoUrl(photo), 'POST', true)).toBe('not_found')
})
