import { beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  client: vi.fn(),
  rpc: vi.fn(),
  binding: vi.fn(),
  cookies: vi.fn(),
  signIn: vi.fn(),
  update: vi.fn(),
  signOut: vi.fn(),
  save: vi.fn(),
  clear: vi.fn(),
}))
vi.mock('next/headers', () => ({ cookies: m.cookies }))
vi.mock('@/lib/pos/server/client', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/client')>()),
  authenticatedPosClient: m.auth,
  posClient: m.client,
  saveSession: m.save,
  clearSession: m.clear,
}))
vi.mock('@/lib/pos/server/live-access', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/live-access')>()),
  requireDevice: m.binding,
  recoveryBinding: m.binding,
}))
import { GET, POST } from '@/app/api/pos/staff/route'
import { POST as RECOVER } from '@/app/api/pos/staff/recovery/route'
import { POST as INVITE } from '@/app/api/pos/staff/invitations/route'
import { POST as REVOKE } from '@/app/api/pos/staff/invitations/revoke/route'
import { POST as ACCEPT } from '@/app/api/pos/staff/invitations/accept/route'
import { POST as PASSWORD } from '@/app/api/pos/account/password/route'
import { PosServerError } from '@/lib/pos/server/client'
import { hashToken } from '@/lib/pos/server/live-access'
import { invitationToken, invitationUrl } from '@/lib/pos/server/staff-access'
const id = (n: number) => String(n) + '0000000-0000-4000-8000-000000000001'
const actor = id(1),
  branch = id(2),
  device = id(3),
  target = id(4),
  requestId = id(5)
const user = {
  id: actor,
  email: 'manager@example.invalid',
  email_confirmed_at: '2026-10-16T00:00:00Z',
}
const session = { access_token: 'synthetic-session', refresh_token: 'synthetic-refresh', user }
const staff = {
  userId: target,
  email: 'cashier@example.invalid',
  displayName: 'Cashier',
  role: 'cashier',
  branchId: branch,
  active: true,
  revision: 2,
}
const command = {
  id: requestId,
  branchId: branch,
  deviceId: device,
  targetUserId: target,
  expectedRevision: 1,
  displayName: 'Cashier',
  active: true,
  role: 'cashier',
  assignedBranchId: branch,
  reason: 'Synthetic access review',
}
const invite = {
  id: requestId,
  branchId: branch,
  deviceId: device,
  email: 'cashier@example.invalid',
  displayName: 'Cashier',
  role: 'cashier',
  assignedBranchId: branch,
  reason: 'Synthetic invitation',
  expiresAt: '2026-10-20T00:00:00Z',
}
const invitation = {
  id: requestId,
  email: invite.email,
  displayName: invite.displayName,
  role: 'cashier',
  branchId: branch,
  status: 'pending',
  expiresAt: invite.expiresAt,
  createdAt: '2026-10-16T00:00:00Z',
}
const accept = { token: 'b'.repeat(64), email: user.email, password: 'SyntheticCurrent123!' }
const changed = { currentPassword: 'SyntheticCurrent123!', newPassword: 'SyntheticChanged456!' }
const req = (path: string, body: unknown, origin = 'http://localhost') =>
  new Request('http://localhost' + path, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const read = () => new Request('http://localhost/api/pos/staff?branchId=' + branch)
beforeEach(() => {
  vi.resetAllMocks()
  m.client.mockImplementation(() => ({
    rpc: m.rpc,
    auth: { signInWithPassword: m.signIn, updateUser: m.update, admin: { signOut: m.signOut } },
  }))
  vi.unstubAllEnvs()
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  vi.stubEnv('POS_PUBLIC_ORIGIN', 'http://localhost')
  vi.stubEnv('POS_LOGIN_SOURCE_MODE', 'loopback-development')
  vi.stubEnv('POS_INVITATION_SECRET', 'a'.repeat(64))
  m.auth.mockResolvedValue({ client: { rpc: m.rpc }, user })
  m.binding.mockResolvedValue('synthetic-binding')
  m.cookies.mockResolvedValue({ get: () => undefined })
  m.rpc.mockImplementation(async (name: string) => ({
    data: name === 'pos_login_attempt' ? true : name === 'pos_open_shift_summaries' ? [] : null,
    error: null,
  }))
  m.signIn.mockResolvedValue({ data: { user, session }, error: null })
  m.update.mockResolvedValue({ data: { user }, error: null })
  m.signOut.mockResolvedValue({ error: null })
  m.save.mockResolvedValue(undefined)
  m.clear.mockResolvedValue(undefined)
})
describe('staff HTTP security and uncertain outcome boundaries', () => {
  it('requires enabled pilot, identity, origin and a bound device before staff writes', async () => {
    vi.stubEnv('POS_ONLINE_PILOT', 'false')
    expect((await GET(read())).status).toBe(503)
    expect(m.auth).not.toHaveBeenCalled()
    vi.stubEnv('POS_ONLINE_PILOT', 'true')
    expect((await POST(req('/api/pos/staff', command, 'https://foreign.invalid'))).status).toBe(403)
    m.auth.mockRejectedValueOnce(new PosServerError('authentication_required', 401))
    expect((await GET(read())).status).toBe(401)
    m.binding.mockRejectedValueOnce(new PosServerError('device_binding_required', 403))
    expect((await POST(req('/api/pos/staff', command))).status).toBe(403)
    expect(m.rpc).not.toHaveBeenCalled()
  })
  it('returns private branch-scoped lists and rejects another branch in provider results', async () => {
    const data = {
      status: 'ready',
      organizationId: id(6),
      branchId: branch,
      actorRole: 'manager',
      staff: [{ ...staff, openShifts: [] }],
      invitations: [],
      invitationHistoryTruncated: false,
    }
    m.rpc.mockResolvedValue({ data, error: null })
    const response = await GET(read())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toMatchObject({
      capabilities: { inviteLinks: true, emailDelivery: false },
    })
    m.rpc.mockResolvedValue({
      data: { ...data, staff: [{ ...staff, branchId: id(7), openShifts: [] }] },
      error: null,
    })
    expect((await GET(read())).status).toBe(503)
  })
  it('accepts only exact updates and rejects owner promotion, unscoped cashiers and actor injection', async () => {
    const result = { status: 'updated', requestId, replayed: false, staff }
    m.rpc.mockResolvedValue({ data: result, error: null })
    expect((await POST(req('/api/pos/staff', command))).status).toBe(200)
    for (const update of [
      { ...staff, revision: 3 },
      { ...staff, active: false },
      { ...staff, userId: actor },
      { ...staff, displayName: 'Other' },
    ]) {
      m.rpc.mockResolvedValue({ data: { ...result, staff: update }, error: null })
      expect((await POST(req('/api/pos/staff', command))).status).toBe(503)
    }
    for (const input of [
      { ...command, role: 'owner' },
      { ...command, assignedBranchId: null },
      { ...command, actorId: actor },
    ])
      expect((await POST(req('/api/pos/staff', input))).status).toBe(422)
  })
  it('distinguishes permanent stale revisions from potentially future revisions and conceals internals', async () => {
    for (const [message, code, status] of [
      ['POS_STAFF_CHANGED', 'staff_conflict', 409],
      ['POS_STAFF_REVISION_AHEAD', 'staff_revision_ahead', 409],
      ['POS_STAFF_OPEN_SHIFT', 'staff_open_shifts', 409],
      ['POS_INVALID_STAFF_COMMAND', 'invalid_staff_request', 422],
      ['POS_STAFF_SCOPE_FORBIDDEN', 'staff_forbidden', 403],
      ['private SQL detail', 'staff_unavailable', 503],
    ] as const) {
      m.rpc.mockResolvedValue({ error: { message } })
      const r = await POST(req('/api/pos/staff', command))
      expect(r.status).toBe(status)
      expect(await r.json()).toMatchObject({ code })
    }
  })
  it('uses stable scope-bound invitation tokens, fragment-only links and only hashes in SQL', async () => {
    const token = invitationToken(actor, branch, requestId)
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(invitationToken(actor, branch, requestId)).toBe(token)
    expect(invitationToken(target, branch, requestId)).not.toBe(token)
    expect(invitationToken(actor, id(8), requestId)).not.toBe(token)
    const url = new URL(invitationUrl(token))
    expect(url.pathname).toBe('/staff/accept')
    expect(url.search).toBe('')
    expect(url.hash).toBe('#token=' + token)
    m.rpc.mockResolvedValue({
      data: { status: 'invited', requestId, replayed: false, invitation },
      error: null,
    })
    const r = await INVITE(req('/api/pos/staff/invitations', invite))
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ setupUrl: url.toString() })
    expect(m.rpc).toHaveBeenLastCalledWith('pos_create_staff_invitation', {
      p_command: invite,
      p_binding: 'synthetic-binding',
      p_token_hash: hashToken(token),
    })
    expect(JSON.stringify(m.rpc.mock.calls)).not.toContain(token)
    m.rpc.mockResolvedValue({
      data: {
        status: 'invited',
        requestId,
        replayed: false,
        invitation: { ...invitation, email: 'wrong@example.invalid' },
      },
      error: null,
    })
    expect((await INVITE(req('/api/pos/staff/invitations', invite))).status).toBe(503)
  })
  it('does not create an invitation if secret configuration is missing', async () => {
    vi.stubEnv('POS_INVITATION_SECRET', '')
    expect((await INVITE(req('/api/pos/staff/invitations', invite))).status).toBe(503)
    expect(m.rpc).not.toHaveBeenCalled()
  })
  it('bounds input and validates revocation acknowledgement', async () => {
    const revoke = {
      id: requestId,
      branchId: branch,
      deviceId: device,
      invitationId: id(7),
      reason: 'Synthetic revoke',
    }
    m.rpc.mockResolvedValue({
      data: { status: 'revoked', requestId, replayed: false, invitationId: id(7) },
      error: null,
    })
    expect((await REVOKE(req('/api/pos/staff/invitations/revoke', revoke))).status).toBe(200)
    m.rpc.mockResolvedValue({
      data: { status: 'revoked', requestId, replayed: false, invitationId: requestId },
      error: null,
    })
    expect((await REVOKE(req('/api/pos/staff/invitations/revoke', revoke))).status).toBe(503)
    expect(
      (
        await POST(
          new Request('http://localhost/api/pos/staff', {
            method: 'POST',
            headers: { origin: 'http://localhost' },
            body: 'x'.repeat(8001),
          })
        )
      ).status
    ).toBe(413)
  })
  it('requires verified recipient credentials and saves cookies only after confirmed membership', async () => {
    const result = {
      status: 'accepted',
      invitationId: requestId,
      branchId: branch,
      role: 'cashier',
      replayed: false,
    }
    m.rpc.mockImplementation(async (name: string) => ({
      data: name === 'pos_login_attempt' ? true : result,
      error: null,
    }))
    expect((await ACCEPT(req('/api/pos/staff/invitations/accept', accept))).status).toBe(200)
    expect(m.signIn).toHaveBeenCalledWith({ email: accept.email, password: accept.password })
    expect(m.rpc).toHaveBeenLastCalledWith('pos_accept_staff_invitation', {
      p_token_hash: hashToken(accept.token),
    })
    expect(m.save).toHaveBeenCalledWith(session)
    expect(m.signOut).not.toHaveBeenCalled()
  })
  it('never silently replaces another signed-in person', async () => {
    m.cookies.mockResolvedValue({ get: () => ({ value: 'existing-cookie' }) })
    m.auth.mockResolvedValue({
      client: { rpc: m.rpc },
      user: { ...user, email: 'other@example.invalid' },
    })
    const r = await ACCEPT(req('/api/pos/staff/invitations/accept', accept))
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ code: 'sign_out_first' })
    expect(m.signIn).not.toHaveBeenCalled()
    expect(m.clear).not.toHaveBeenCalled()
  })
  it('rates credential attempts before authentication and rejects unconfirmed identities', async () => {
    m.rpc.mockResolvedValueOnce({ data: false, error: null })
    expect((await ACCEPT(req('/api/pos/staff/invitations/accept', accept))).status).toBe(429)
    expect(m.signIn).not.toHaveBeenCalled()
    m.signIn.mockResolvedValue({
      data: { user: { ...user, email_confirmed_at: null }, session },
      error: null,
    })
    expect((await ACCEPT(req('/api/pos/staff/invitations/accept', accept))).status).toBe(403)
    expect(m.save).not.toHaveBeenCalled()
    expect(m.signOut).toHaveBeenCalledWith(session.access_token, 'local')
  })
  it('revokes a transient session if invitation acceptance fails or its acknowledgement is malformed', async () => {
    for (const result of [
      { error: { message: 'POS_INVITATION_IDENTITY_MISMATCH' } },
      { data: { status: 'accepted' }, error: null },
    ]) {
      m.rpc.mockImplementation(async (name: string) =>
        name === 'pos_login_attempt' ? { data: true, error: null } : result
      )
      expect((await ACCEPT(req('/api/pos/staff/invitations/accept', accept))).status).toBe(
        result.error ? 403 : 503
      )
    }
    expect(m.save).not.toHaveBeenCalled()
    expect(m.signOut).toHaveBeenCalledTimes(2)
  })
  it('reauthenticates only the current account, changes its password, revokes refresh sessions and clears cookies', async () => {
    const r = await PASSWORD(req('/api/pos/account/password', changed))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ status: 'password_changed', requiresSignIn: true })
    expect(m.signIn).toHaveBeenCalledWith({ email: user.email, password: changed.currentPassword })
    expect(m.update).toHaveBeenCalledWith({ password: changed.newPassword })
    expect(m.signOut).toHaveBeenCalledWith(session.access_token, 'global')
    expect(m.clear).toHaveBeenCalledOnce()
  })
  it('rejects weak, unchanged, oversized UTF8 passwords and arbitrary target identities', async () => {
    for (const body of [
      { ...changed, newPassword: 'short' },
      { ...changed, newPassword: changed.currentPassword },
      { ...changed, newPassword: 'é'.repeat(37) },
      { ...changed, targetUserId: target },
    ])
      expect((await PASSWORD(req('/api/pos/account/password', body))).status).toBe(422)
    expect(m.signIn).not.toHaveBeenCalled()
    expect(m.update).not.toHaveBeenCalled()
  })
  it('rejects incorrect current credentials without attempting an update', async () => {
    m.signIn.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'invalid' },
    })
    expect((await PASSWORD(req('/api/pos/account/password', changed))).status).toBe(401)
    expect(m.update).not.toHaveBeenCalled()
  })
  it('reports changed-password status even when global session revocation returns or throws an error', async () => {
    for (const throws of [false, true]) {
      if (throws) m.signOut.mockRejectedValueOnce(new Error('private failure'))
      else m.signOut.mockResolvedValueOnce({ error: { message: 'private failure' } })
      const r = await PASSWORD(req('/api/pos/account/password', changed))
      expect(r.status).toBe(503)
      expect(await r.json()).toMatchObject({ code: 'password_changed_sign_out_pending' })
    }
    expect(m.clear).toHaveBeenCalledTimes(2)
  })
  it('distinguishes unknown update results from a confirmed change whose cookie clearing failed', async () => {
    m.update.mockResolvedValueOnce({ data: { user: null }, error: { message: 'unavailable' } })
    const unknown = await PASSWORD(req('/api/pos/account/password', changed))
    expect(await unknown.json()).toMatchObject({ code: 'password_change_unconfirmed' })
    expect(m.signOut).toHaveBeenCalledWith(session.access_token, 'local')
    m.clear.mockRejectedValueOnce(new Error('cookie failure'))
    const pending = await PASSWORD(req('/api/pos/account/password', changed))
    expect(await pending.json()).toMatchObject({ code: 'password_changed_sign_out_pending' })
  })
})

it('staff recovery accepts only exact committed ACKs or exact permanent cancellation', async () => {
  const body = { endpoint: '/api/pos/staff', request: command }
  m.rpc.mockResolvedValue({
    data: { status: 'updated', requestId, replayed: true, staff },
    error: null,
  })
  expect((await RECOVER(req('/api/pos/staff/recovery', body))).status).toBe(200)
  expect(m.rpc).toHaveBeenLastCalledWith('pos_resolve_staff_request', {
    p_kind: 'staff.update',
    p_command: command,
    p_binding: 'synthetic-binding',
    p_token_hash: null,
  })
  m.rpc.mockResolvedValue({
    data: { status: 'cancelled', requestId, kind: 'staff.update', replayed: false },
    error: null,
  })
  expect((await RECOVER(req('/api/pos/staff/recovery', body))).status).toBe(200)
  m.rpc.mockResolvedValue({
    data: { status: 'cancelled', requestId: target, kind: 'staff.update', replayed: false },
    error: null,
  })
  expect((await RECOVER(req('/api/pos/staff/recovery', body))).status).toBe(503)
  m.rpc.mockResolvedValue({ error: { message: 'POS_STAFF_INACTIVE' } })
  expect((await RECOVER(req('/api/pos/staff/recovery', body))).status).toBe(403)
})

it('updates the password on the exact Auth client that holds the reauthenticated in-memory session', async () => {
  m.client.mockImplementation(() => {
    let hasSession = false
    return {
      rpc: m.rpc,
      auth: {
        admin: { signOut: m.signOut },
        signInWithPassword: async () => {
          hasSession = true
          return { data: { user, session }, error: null }
        },
        updateUser: async () => {
          if (!hasSession) throw new Error('AuthSessionMissingError')
          return { data: { user }, error: null }
        },
      },
    }
  })
  const result = await PASSWORD(req('/api/pos/account/password', changed))
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ status: 'password_changed', requiresSignIn: true })
})
