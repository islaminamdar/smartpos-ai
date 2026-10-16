// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  device: vi.fn(),
  rpc: vi.fn(),
  password: vi.fn(),
  revoke: vi.fn(),
  limit: vi.fn(),
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
vi.mock('@/lib/pos/offline/server', () => ({ limitOfflineRecovery: m.limit }))
import { encodeBase64Url, canonicalBytes, sha256Hex } from '@/lib/pos/offline/canonical'
import {
  publicKeyFingerprint,
  signEnvelope,
  verifySignedEnvelope,
} from '@/lib/pos/offline/authority'
import {
  nativePinRecovery,
  nativePinRecoveryApprovalSchema,
} from '@/lib/pos/offline/native-pin-recovery'
import { POST } from '@/app/api/pos/native/pin-recovery/route'
import type { SignedEnvelope } from '@/lib/pos/offline/contracts'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
let server: CryptoKeyPair,
  device: CryptoKeyPair,
  proof: SignedEnvelope,
  payload: Record<string, any>,
  context: Record<string, any>,
  saved: Record<string, any> | null,
  errorCode: string | null
const http = (body: unknown = {}, origin = 'https://pos.example.test') =>
  new Request('https://pos.example.test/api/pos/native/pin-recovery', {
    method: 'POST',
    headers: { origin, 'x-forwarded-for': '192.0.2.10' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const input = (mode = 'approve') =>
  mode === 'lookup' ? { mode, proof } : { mode, proof, password: 'synthetic-only-password' }
const run = (mode = 'approve') => nativePinRecovery(http(), input(mode))
beforeEach(async () => {
  vi.resetAllMocks()
  vi.stubEnv('POS_LOGIN_SOURCE_MODE', 'apache-rightmost')
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  vi.stubEnv('POS_PUBLIC_ORIGIN', 'https://pos.example.test')
  server = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  device = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const fingerprint = await publicKeyFingerprint(device.publicKey)
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
  payload = {
    kind: 'native-pin-recovery',
    schemaVersion: 1,
    requestId: id(1),
    organizationId: id(2),
    branchId: id(3),
    deviceId: id(4),
    actorId: id(5),
    keyEpoch: id(6),
    deviceKeySha256: fingerprint,
    oldCredentialSha256: 'a'.repeat(64),
    newCredentialSha256: 'b'.repeat(64),
    signedAt: new Date().toISOString(),
  }
  proof = await signEnvelope(payload, fingerprint, device.privateKey)
  context = {
    organizationId: id(2),
    branchId: id(3),
    deviceId: id(4),
    keyEpoch: id(6),
    deviceKeySha256: fingerprint,
    publicKeySpki: encodeBase64Url(
      new Uint8Array(await crypto.subtle.exportKey('spki', device.publicKey))
    ),
  }
  saved = null
  errorCode = null
  m.auth.mockResolvedValue({ user: { id: id(5), email: 'Staff@example.test' }, client: {} })
  m.device.mockResolvedValue('binding-hash')
  m.password.mockResolvedValue({
    data: { user: { id: id(5) }, session: { access_token: 'temporary-token' } },
    error: null,
  })
  m.revoke.mockResolvedValue({ error: null })
  m.rpc.mockImplementation(async (name, args) => {
    if (name === 'pos_native_pin_recovery_context') return { data: context, error: null }
    if (name === 'pos_native_pin_recovery_lookup') return { data: saved, error: null }
    if (name === 'pos_login_attempt') return { data: true, error: null }
    if (name === 'pos_native_pin_recovery_approve') {
      if (errorCode) return { data: null, error: { message: errorCode } }
      const { signedAt: _signedAt, ...core } = payload
      saved = {
        approval: {
          ...core,
          kind: 'native-pin-recovery-approval',
          proofSha256: await sha256Hex(canonicalBytes(payload)),
          approvedAt: new Date().toISOString(),
        },
        approvalEnvelope: null,
      }
      return { data: saved, error: null }
    }
    if (name === 'pos_native_pin_recovery_attach') {
      saved = { ...saved, approvalEnvelope: args.p_envelope }
      return { data: saved, error: null }
    }
    throw new Error('Unexpected RPC')
  })
})
afterEach(() => vi.unstubAllEnvs())
it('verifies registered device, exact password actor and signed grant without leaking secrets to RPC', async () => {
  const result = await run()
  expect(result.status).toBe('approved')
  if (result.status !== 'approved') throw new Error()
  const verified = await verifySignedEnvelope(result.approval, nativePinRecoveryApprovalSchema, {
    server: server.publicKey,
  })
  expect(verified.payload).toMatchObject({
    actorId: id(5),
    oldCredentialSha256: 'a'.repeat(64),
    proofSha256: await sha256Hex(canonicalBytes(payload)),
  })
  expect(m.password).toHaveBeenCalledExactlyOnceWith({
    email: 'staff@example.test',
    password: 'synthetic-only-password',
  })
  expect(m.revoke).toHaveBeenCalledExactlyOnceWith('temporary-token', 'local')
  expect(JSON.stringify(m.rpc.mock.calls)).not.toMatch(/synthetic-only-password|temporary-token/)
  const args = m.rpc.mock.calls.find((c) => c[0] === 'pos_native_pin_recovery_approve')![1]
  expect(Object.keys(args).sort()).toEqual(['p_actor', 'p_binding', 'p_confirmed_at', 'p_proof'])
  expect(args.p_actor).toBe(id(5))
})
it('lookup missing never grants, authenticates, or checks password with pilot disabled', async () => {
  vi.stubEnv('POS_ONLINE_PILOT', 'false')
  await expect(run('lookup')).resolves.toEqual({ status: 'not_found' })
  expect(m.auth).not.toHaveBeenCalled()
  expect(m.password).not.toHaveBeenCalled()
  expect(m.rpc.mock.calls.map((c) => c[0])).toEqual([
    'pos_native_pin_recovery_context',
    'pos_native_pin_recovery_lookup',
  ])
  await expect(run()).rejects.toMatchObject({ status: 503 })
  expect(m.password).not.toHaveBeenCalled()
})
it('recovers first accepted envelope before current authentication, password and proof freshness', async () => {
  const first = await run()
  vi.stubEnv('POS_ONLINE_PILOT', 'false')
  m.auth.mockRejectedValue(new Error('revoked'))
  m.password.mockClear()
  payload = { ...payload, signedAt: '2020-01-01T00:00:00.000Z' }
  proof = await signEnvelope(payload, payload.deviceKeySha256, device.privateKey)
  expect(await run('lookup')).toEqual(first)
  expect(await run()).toEqual(first)
  expect(m.password).not.toHaveBeenCalled()
})
it('repairs signature attachment after accepted request interrupted without another password or acceptance', async () => {
  m.rpc
    .mockImplementationOnce(async () => ({ data: context, error: null }))
    .mockImplementationOnce(async () => ({ data: null, error: null }))
  await run()
  saved!.approvalEnvelope = null
  m.rpc.mockClear()
  m.password.mockClear()
  const result = await run('lookup')
  expect(result.status).toBe('approved')
  expect(m.password).not.toHaveBeenCalled()
  expect(m.rpc.mock.calls.map((c) => c[0])).toEqual([
    'pos_native_pin_recovery_context',
    'pos_native_pin_recovery_lookup',
    'pos_native_pin_recovery_attach',
  ])
})
it.each(['organizationId', 'branchId', 'deviceId', 'keyEpoch', 'deviceKeySha256'])(
  'rejects enrolled context mismatch %s before lookup or auth',
  async (field) => {
    context[field] = field === 'deviceKeySha256' ? 'f'.repeat(64) : id(99)
    await expect(run()).rejects.toMatchObject({ code: 'invalid_pin_recovery_proof' })
    expect(m.auth).not.toHaveBeenCalled()
    expect(m.rpc).toHaveBeenCalledTimes(1)
  }
)
it('rejects forged signature even with valid scope and fingerprint', async () => {
  proof = await signEnvelope(payload, payload.deviceKeySha256, server.privateKey)
  await expect(run()).rejects.toMatchObject({ code: 'invalid_pin_recovery_proof' })
  expect(m.auth).not.toHaveBeenCalled()
})
it('requires exact current original actor before password verification', async () => {
  m.auth.mockResolvedValue({ user: { id: id(99), email: 'other@example.test' }, client: {} })
  await expect(run()).rejects.toMatchObject({ status: 403 })
  expect(m.password).not.toHaveBeenCalled()
})
it('rejects password login returning a different actor and revokes its temporary session', async () => {
  m.password.mockResolvedValue({
    data: { user: { id: id(99) }, session: { access_token: 'temporary-token' } },
    error: null,
  })
  await expect(run()).rejects.toMatchObject({ code: 'current_password_incorrect' })
  expect(m.revoke).toHaveBeenCalledOnce()
  expect(m.rpc.mock.calls.some((c) => c[0] === 'pos_native_pin_recovery_approve')).toBe(false)
})
it('a temporary session revocation failure cannot grant a reset', async () => {
  m.revoke.mockResolvedValue({ error: true })
  await expect(run()).rejects.toMatchObject({ status: 503 })
  expect(m.rpc.mock.calls.some((c) => c[0] === 'pos_native_pin_recovery_approve')).toBe(false)
})
it('invalid signer configuration fails before accepting any reset', async () => {
  vi.stubEnv('POS_OFFLINE_SERVER_KEYS', '[]')
  await expect(run()).rejects.toMatchObject({ code: 'offline_signing_unavailable' })
  expect(m.password).not.toHaveBeenCalled()
})
it.each(['actorId', 'oldCredentialSha256', 'newCredentialSha256', 'requestId', 'proofSha256'])(
  'rejects stored signature tampering %s',
  async (field) => {
    await run()
    saved!.approval[field] = field.endsWith('Sha256') ? 'f'.repeat(64) : id(99)
    await expect(run('lookup')).rejects.toMatchObject({ status: 503 })
  }
)
it('returns exact proof-bound definitive expiry only for locked SQL rejection', async () => {
  errorCode = 'POS_PIN_RECOVERY_PROOF_EXPIRED'
  const result = await POST(http(input()))
  expect(result.status).toBe(409)
  expect(await result.json()).toEqual({
    status: 'not_approved',
    code: 'pin_recovery_proof_expired',
    requestId: payload.requestId,
    proofSha256: await sha256Hex(canonicalBytes(payload)),
  })
  expect(result.headers.get('cache-control')).toContain('no-store')
  errorCode = 'POS_PIN_RECOVERY_CONFLICT'
  const conflict = await POST(http(input()))
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).not.toHaveProperty('proofSha256')
})
it('route checks origin, strict schemas, rate limit, byte limits and private responses', async () => {
  expect((await POST(http(input(), 'https://foreign.example'))).status).toBe(403)
  expect(m.limit).not.toHaveBeenCalled()
  expect((await POST(http('é'.repeat(8193)))).status).toBe(413)
  for (const body of [
    { ...input(), actorId: id(5) },
    { ...input('lookup'), password: 'bad' },
    { ...input(), password: '' },
  ])
    expect((await POST(http(body))).status).toBe(422)
  const result = await POST(http(input('lookup')))
  expect(result.status).toBe(200)
  expect(result.headers.get('cache-control')).toContain('no-store')
})
it('does not expose raw database errors or mislabel an uncertain response as expiry', async () => {
  errorCode = 'private database password details'
  const result = await POST(http(input()))
  expect(result.status).toBe(503)
  expect(await result.json()).toMatchObject({ code: 'pin_recovery_unavailable' })
})
