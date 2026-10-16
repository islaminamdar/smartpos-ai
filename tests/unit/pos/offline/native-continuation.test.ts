// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), device: vi.fn(), rpc: vi.fn(), limit: vi.fn() }))
vi.mock('@/lib/pos/server/client', async original => ({ ...await original<typeof import('@/lib/pos/server/client')>(),
  authenticatedPosClient: m.auth, posClient: () => ({ rpc: m.rpc }) }))
vi.mock('@/lib/pos/server/native-access', () => ({ nativeAccess: m.access }))
vi.mock('@/lib/pos/server/live-access', async original => ({ ...await original<typeof import('@/lib/pos/server/live-access')>(), requireDevice: m.device }))
vi.mock('@/lib/pos/offline/server', () => ({ limitOfflineRecovery: m.limit }))
import fixture from '../../../fixtures/pos-offline-output.json'
import { canonicalBytes, encodeBase64Url, sha256Hex } from '@/lib/pos/offline/canonical'
import { publicKeyFingerprint, signEnvelope, verifySignedEnvelope } from '@/lib/pos/offline/authority'
import { nativeOfflineContinuation, nativeContinuationSchema } from '@/lib/pos/offline/native-continuation'
import { POST } from '@/app/api/pos/native/continuation/route'
import type { SignedEnvelope } from '@/lib/pos/offline/contracts'
const a = fixture.reservation.authority, other = '00000000-0000-4000-8000-000000000099'
const request = { challenge: 'a'.repeat(64), authorityId: a.id, sealSha256: '' }
let server: CryptoKeyPair, device: CryptoKeyPair, row: Record<string, unknown>, seal: Record<string, unknown>
const post = (body: unknown = request, origin = 'https://pos.example.test') => new Request('https://pos.example.test/api/pos/native/continuation', { method: 'POST', headers: { Origin: origin }, body: typeof body === 'string' ? body : JSON.stringify(body) })
beforeEach(async () => {
  vi.resetAllMocks()
  for (const flag of ['POS_ONLINE_PILOT','POS_LIVE_SALES_ENABLED','POS_OFFLINE_ISSUANCE_ENABLED']) vi.stubEnv(flag, 'true')
  vi.stubEnv('POS_PUBLIC_ORIGIN', 'https://pos.example.test')
  server = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  device = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  vi.stubEnv('POS_OFFLINE_SIGNING_KEY_ID', 'server')
  vi.stubEnv('POS_OFFLINE_SERVER_KEYS', JSON.stringify([{ id: 'server', publicKeySpki: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', server.publicKey))), privateKeyPkcs8: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', server.privateKey))) }]))
  const fingerprint = await publicKeyFingerprint(device.publicKey)
  const authority = { ...a, deviceKeySha256: fingerprint, snapshotSha256: await sha256Hex(canonicalBytes(fixture.reservation.snapshot)) }
  seal = { kind: 'offline-seal', schemaVersion: 1, id: other, authorityId: a.id, keyEpoch: a.keyEpoch, deviceId: a.deviceId, finalSequence: 0, finalEventSha256: null }
  request.sealSha256 = await sha256Hex(canonicalBytes(seal))
  row = { actorId: a.actorId, organizationId: a.organizationId, branchId: a.branchId, deviceId: a.deviceId, shiftId: a.shiftId, keyEpoch: a.keyEpoch, deviceKeySha256: fingerprint, nextShiftId: a.shiftId,
    snapshotEnvelope: await signEnvelope(fixture.reservation.snapshot, 'server', server.privateKey), authorityEnvelope: await signEnvelope(authority, 'server', server.privateKey),
    sealEnvelope: await signEnvelope(seal, fingerprint, device.privateKey), publicKeySpki: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', device.publicKey))) }
  m.access.mockResolvedValue({ actorId: a.actorId, branches: [{ id: a.branchId, organizationId: a.organizationId }], device: { id: a.deviceId, branchId: a.branchId } })
  m.auth.mockResolvedValue({ user: { id: a.actorId }, client: {} })
  m.rpc.mockImplementation(async (name, args) => {
    expect(name).toBe('pos_offline_continuation_context')
    expect(args).toEqual({ p_actor: a.actorId, p_device: a.deviceId, p_authority: a.id, p_seal_hash: request.sealSha256 })
    return { data: row, error: null }
  })
})
afterEach(() => vi.unstubAllEnvs())
it.each([false, true])('signs verified original scope without creating a shift or grant (closed=%s)', async closed => {
  row.nextShiftId = closed ? null : a.shiftId
  const result = await nativeOfflineContinuation(request)
  const { payload } = await verifySignedEnvelope(result.handoff, nativeContinuationSchema, { server: server.publicKey })
  expect(payload).toMatchObject({ kind: 'native-offline-continuation', purpose: 'prepare-next', challenge: request.challenge,
    priorAuthorityId: a.id, shiftId: a.shiftId, nextShiftId: row.nextShiftId, sealSha256: request.sealSha256 })
  expect(m.rpc).toHaveBeenCalledTimes(1)
  expect(m.device).toHaveBeenCalledWith(expect.anything(), a.branchId, a.deviceId, a.actorId)
})
it('uses a fresh challenge while preserving the original retired allocation', async () => {
  const result = await nativeOfflineContinuation({ ...request, challenge: 'b'.repeat(64) })
  expect((await verifySignedEnvelope(result.handoff, nativeContinuationSchema, { server: server.publicKey })).payload.challenge).toBe('b'.repeat(64))
})
it.each(['actorId','organizationId','branchId','deviceId','shiftId','keyEpoch','nextShiftId'])('rejects stored scope mismatch: %s', async field => {
  row[field] = other
  await expect(nativeOfflineContinuation(request)).rejects.toMatchObject({ code: 'offline_continuation_unavailable' })
})
it('rejects replaced device key, wrong seal signature and an otherwise valid wrong seal hash', async () => {
  const original = row.sealEnvelope
  row.sealEnvelope = await signEnvelope(seal, row.deviceKeySha256 as string, server.privateKey)
  await expect(nativeOfflineContinuation(request)).rejects.toMatchObject({ status: 503 })
  row.sealEnvelope = original
  request.sealSha256 = 'b'.repeat(64)
  await expect(nativeOfflineContinuation(request)).rejects.toMatchObject({ status: 503 })
  request.sealSha256 = await sha256Hex(canonicalBytes(seal))
  row.publicKeySpki = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', server.publicKey)))
  await expect(nativeOfflineContinuation(request)).rejects.toMatchObject({ status: 503 })
})
it('rejects tampered historical bundle before signing continuation', async () => {
  row.authorityEnvelope = { ...(row.authorityEnvelope as SignedEnvelope), signatureBase64Url: 'a'.repeat(90) }
  await expect(nativeOfflineContinuation(request)).rejects.toMatchObject({ status: 503 })
})
it('rejects changing actor, absent binding and revoked binding before the privileged reader', async () => {
  m.auth.mockResolvedValueOnce({ user: { id: other }, client: {} })
  await expect(nativeOfflineContinuation(request)).rejects.toMatchObject({ status: 403 })
  m.access.mockResolvedValueOnce({ actorId: a.actorId, device: null })
  await expect(nativeOfflineContinuation(request)).rejects.toMatchObject({ status: 403 })
  m.device.mockRejectedValueOnce(new Error('revoked'))
  await expect(nativeOfflineContinuation(request)).rejects.toThrow('revoked')
  expect(m.rpc).not.toHaveBeenCalled()
})
it('keeps server holds unavailable and does not disclose private SQL details', async () => {
  m.rpc.mockResolvedValueOnce({ data: null, error: { message: 'POS_OFFLINE_PAYMENT_HOLD' } })
  expect((await POST(post())).status).toBe(409)
  m.rpc.mockResolvedValueOnce({ data: null, error: { message: 'private database details' } })
  const response = await POST(post())
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain('private database')
})
it.each(['POS_ONLINE_PILOT','POS_LIVE_SALES_ENABLED','POS_OFFLINE_ISSUANCE_ENABLED'])('checks release gate before auth: %s', async flag => {
  vi.stubEnv(flag, 'false')
  expect((await POST(post())).status).toBe(503)
  expect(m.access).not.toHaveBeenCalled()
})
it('bounds bytes, checks origin and rejects caller-supplied actor or proposed next shift', async () => {
  expect((await POST(post(request, 'https://wrong.example.test'))).status).toBe(403)
  expect((await POST(post('é'.repeat(513)))).status).toBe(413)
  for (const body of [{ ...request, actorId: a.actorId }, { ...request, nextShiftId: other }, { ...request, challenge: 'A'.repeat(64) }]) expect((await POST(post(body))).status).toBe(422)
  expect(m.rpc).not.toHaveBeenCalled()
  const response = await POST(post())
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
})
