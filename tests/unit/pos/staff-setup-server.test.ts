import { beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({
  cookies: vi.fn(),
  rpc: vi.fn(),
  client: vi.fn(),
  generate: vi.fn(),
  verify: vi.fn(),
  update: vi.fn(),
  signOut: vi.fn(),
  save: vi.fn(),
  mail: vi.fn(),
  available: vi.fn(),
}))
vi.mock('next/headers', () => ({ cookies: m.cookies }))
vi.mock('@/lib/pos/server/client', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/client')>()),
  posClient: m.client,
  saveSession: m.save,
}))
vi.mock('@/lib/pos/server/staff-mail', () => ({
  staffAccountSetupAvailable: m.available,
  sendStaffSetupCode: m.mail,
}))
import { POST as REQUEST } from '@/app/api/pos/staff/setup/request/route'
import { POST as COMPLETE } from '@/app/api/pos/staff/setup/complete/route'
import { hashToken } from '@/lib/pos/server/live-access'
const id = (n: number) => `${n}0000000-0000-4000-8000-000000000001`
const token = 'a'.repeat(64),
  email = 'new-cashier@example.invalid',
  code = '123456'
const identity = { token, email },
  attemptId = id(2),
  invitationId = id(3),
  userId = id(4)
const complete = { ...identity, attemptId, code, password: 'RecipientChosenSecret123!' }
const context = {
  invitationId,
  email,
  existingConfirmed: false,
  attemptId,
  setupUserId: userId,
  codeHash: hashToken(token + ':' + code),
  setupExpiresAt: '2099-01-01T00:00:00Z',
}
const user = { id: userId, email, email_confirmed_at: '2026-10-17T00:00:00Z' }
const session = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', user }
const accepted = {
  status: 'accepted',
  invitationId,
  branchId: id(5),
  role: 'cashier',
  replayed: false,
}
const req = (body: unknown, origin = 'http://localhost') =>
  new Request('http://localhost/api/pos/staff/setup/request', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
beforeEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  vi.stubEnv('POS_PUBLIC_ORIGIN', 'http://localhost')
  vi.stubEnv('POS_LOGIN_SOURCE_MODE', 'loopback-development')
  m.available.mockReturnValue(true)
  m.cookies.mockResolvedValue({ get: () => undefined })
  m.client.mockImplementation(() => ({
    rpc: m.rpc,
    auth: {
      verifyOtp: m.verify,
      updateUser: m.update,
      admin: { generateLink: m.generate, signOut: m.signOut },
    },
  }))
  m.rpc.mockImplementation(async (name: string) => ({
    data:
      name === 'pos_login_attempt' || name === 'pos_staff_setup_bind'
        ? true
        : name === 'pos_accept_staff_invitation'
          ? accepted
          : context,
    error: null,
  }))
  m.generate.mockResolvedValue({
    data: {
      user: { ...user, email_confirmed_at: null },
      properties: {
        verification_type: 'invite',
        email_otp: code,
        action_link: 'secret-provider-link',
        hashed_token: 'secret-provider-hash',
      },
    },
    error: null,
  })
  m.verify.mockResolvedValue({ data: { user, session }, error: null })
  m.update.mockResolvedValue({ data: { user }, error: null })
  m.signOut.mockResolvedValue({ error: null })
  m.mail.mockResolvedValue(undefined)
})
describe('recipient-only staff account setup', () => {
  it('fails closed without mail configuration, pilot, origin or on a signed-in shared browser', async () => {
    m.available.mockReturnValue(false)
    expect((await REQUEST(req(identity))).status).toBe(503)
    m.available.mockReturnValue(true)
    vi.stubEnv('POS_ONLINE_PILOT', 'false')
    expect((await REQUEST(req(identity))).status).toBe(503)
    vi.stubEnv('POS_ONLINE_PILOT', 'true')
    expect((await REQUEST(req(identity, 'https://foreign.invalid'))).status).toBe(403)
    m.cookies.mockResolvedValue({ get: () => ({ value: 'old-counter-session' }) })
    expect((await COMPLETE(req(complete))).status).toBe(409)
    expect(m.generate).not.toHaveBeenCalled()
    expect(m.verify).not.toHaveBeenCalled()
    expect(m.mail).not.toHaveBeenCalled()
  })
  it('checks source/email budget and invitation authority before creating any account or sending', async () => {
    m.rpc.mockResolvedValueOnce({ data: false, error: null })
    expect((await REQUEST(req(identity))).status).toBe(429)
    m.rpc.mockImplementation(async (name) =>
      name === 'pos_login_attempt'
        ? { data: true }
        : { error: { message: 'POS_INVITATION_UNAVAILABLE' } }
    )
    expect((await REQUEST(req(identity))).status).toBe(409)
    expect(m.generate).not.toHaveBeenCalled()
    expect(m.mail).not.toHaveBeenCalled()
  })
  it('returns only a non-secret attempt ID and sends the code only to the exact invited recipient', async () => {
    const response = await REQUEST(req(identity)),
      result = await response.json()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(result).toEqual({ status: 'setup_requested', attemptId: expect.any(String) })
    expect(JSON.stringify(result)).not.toContain(code)
    expect(JSON.stringify(result)).not.toContain('secret-provider')
    expect(m.generate).toHaveBeenCalledWith({ type: 'invite', email })
    expect(m.mail).toHaveBeenCalledWith(email, code)
    expect(m.rpc).toHaveBeenCalledWith('pos_staff_setup_bind', {
      p_token_hash: hashToken(token),
      p_email: email,
      p_attempt: result.attemptId,
      p_user: userId,
      p_code_hash: hashToken(token + ':' + code),
    })
    expect(JSON.stringify(m.rpc.mock.calls)).not.toContain(token)
    expect(m.save).not.toHaveBeenCalled()
    expect(m.update).not.toHaveBeenCalled()
  })
  it('never resets or generates recovery codes for an existing confirmed account', async () => {
    m.rpc.mockImplementation(async (name) => ({
      data: name === 'pos_login_attempt' ? true : { ...context, existingConfirmed: true },
      error: null,
    }))
    expect((await REQUEST(req(identity))).status).toBe(200)
    expect(m.generate).not.toHaveBeenCalled()
    expect(m.mail).not.toHaveBeenCalled()
    expect(m.update).not.toHaveBeenCalled()
  })
  it('rejects provider mismatched email, confirmed identities, wrong type and missing code', async () => {
    for (const data of [
      {
        user: { ...user, email: 'wrong@example.invalid' },
        properties: { verification_type: 'invite', email_otp: code },
      },
      { user, properties: { verification_type: 'invite', email_otp: code } },
      {
        user: { ...user, email_confirmed_at: null },
        properties: { verification_type: 'recovery', email_otp: code },
      },
      { user: { ...user, email_confirmed_at: null }, properties: { verification_type: 'invite' } },
    ]) {
      m.generate.mockResolvedValueOnce({ data, error: null })
      expect((await REQUEST(req(identity))).status).toBe(503)
    }
    expect(m.mail).not.toHaveBeenCalled()
  })
  it('does not claim delivery after failed binding or failed transport', async () => {
    m.rpc.mockImplementation(async (name) => ({
      data: name === 'pos_login_attempt' ? true : name === 'pos_staff_setup_bind' ? false : context,
      error: null,
    }))
    expect((await REQUEST(req(identity))).status).toBe(503)
    expect(m.mail).not.toHaveBeenCalled()
    m.rpc.mockImplementation(async (name) => ({
      data: name === 'pos_login_attempt' || name === 'pos_staff_setup_bind' ? true : context,
      error: null,
    }))
    m.mail.mockRejectedValueOnce(new Error('private smtp credentials failure'))
    const response = await REQUEST(req(identity))
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private smtp')
  })
  it('rejects weak passwords, extra authority fields, forged attempts, expired setups and wrong codes before verification', async () => {
    for (const body of [
      { ...complete, password: 'short' },
      { ...complete, password: 'é'.repeat(37) },
      { ...complete, role: 'owner' },
    ])
      expect((await COMPLETE(req(body))).status).toBe(422)
    for (const changed of [
      { ...context, existingConfirmed: true },
      { ...context, attemptId: id(9) },
      { ...context, setupExpiresAt: '2000-01-01T00:00:00Z' },
      { ...context, setupUserId: null },
      { ...context, codeHash: hashToken('wrong') },
    ]) {
      m.rpc.mockImplementation(async (name) => ({
        data: name === 'pos_login_attempt' ? true : changed,
        error: null,
      }))
      expect((await COMPLETE(req(complete))).status).toBe(401)
    }
    expect(m.verify).not.toHaveBeenCalled()
    expect(m.update).not.toHaveBeenCalled()
  })
  it('sets the recipient password only after a matching one-time provider verification, then accepts exact branch invitation', async () => {
    const response = await COMPLETE(req(complete))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(accepted)
    expect(m.rpc).toHaveBeenCalledWith('pos_staff_setup_consume', {
      p_token_hash: hashToken(token),
      p_email: email,
      p_attempt: attemptId,
      p_code_hash: hashToken(token + ':' + code),
    })
    expect(m.verify).toHaveBeenCalledWith({ email, token: code, type: 'invite' })
    expect(m.update).toHaveBeenCalledWith({ password: complete.password })
    expect(m.verify.mock.invocationCallOrder[0]).toBeLessThan(m.update.mock.invocationCallOrder[0])
    expect(m.rpc).toHaveBeenCalledWith('pos_accept_staff_invitation', {
      p_token_hash: hashToken(token),
    })
    expect(m.save).toHaveBeenCalledWith(session)
    expect(m.signOut).not.toHaveBeenCalled()
  })
  it('never sets a password for a mismatched or unverified provider account and revokes transient session', async () => {
    for (const bad of [
      { ...user, id: id(8) },
      { ...user, email: 'wrong@example.invalid' },
      { ...user, email_confirmed_at: null },
    ]) {
      m.verify.mockResolvedValueOnce({ data: { user: bad, session }, error: null })
      expect((await COMPLETE(req(complete))).status).toBe(403)
    }
    expect(m.update).not.toHaveBeenCalled()
    expect(m.save).not.toHaveBeenCalled()
    expect(m.signOut).toHaveBeenCalledTimes(3)
  })
  it('reports a password set but branch acceptance unconfirmed and does not save a session', async () => {
    m.rpc.mockImplementation(async (name) =>
      name === 'pos_accept_staff_invitation'
        ? { error: { message: 'POS_INVITATION_REVOKED' } }
        : { data: name === 'pos_login_attempt' ? true : context, error: null }
    )
    const response = await COMPLETE(req(complete))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'account_created_access_unconfirmed' })
    expect(m.save).not.toHaveBeenCalled()
    expect(m.signOut).toHaveBeenCalledWith(session.access_token, 'local')
  })
  it('does not accept an unrelated invitation ACK', async () => {
    m.rpc.mockImplementation(async (name) => ({
      data:
        name === 'pos_accept_staff_invitation'
          ? { ...accepted, invitationId: id(9) }
          : name === 'pos_login_attempt'
            ? true
            : context,
      error: null,
    }))
    expect((await COMPLETE(req(complete))).status).toBe(503)
    expect(m.save).not.toHaveBeenCalled()
  })
})

it('a consumed completion claim cannot contact Auth or overwrite a password', async () => {
  m.rpc.mockImplementation(async (name) =>
    name === 'pos_login_attempt'
      ? { data: true, error: null }
      : { error: { message: 'POS_SETUP_CODE_INVALID' } }
  )
  expect((await COMPLETE(req(complete))).status).toBe(401)
  expect(m.verify).not.toHaveBeenCalled()
  expect(m.update).not.toHaveBeenCalled()
  expect(m.save).not.toHaveBeenCalled()
})
