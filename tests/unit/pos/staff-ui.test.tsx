import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import StaffManager from '@/components/pos/staff/StaffManager'
import StaffInvitation from '@/components/pos/staff/StaffInvitation'
import AccountSettings from '@/components/pos/staff/AccountSettings'
const journal = vi.hoisted(() => ({ pending: false }))
vi.mock('@/lib/pos/online-journal', () => ({
  readPendingRequest: async () => (journal.pending ? { id: 'pending-sale' } : null),
}))
const branch = '10000000-0000-4000-8000-000000000001',
  device = '20000000-0000-4000-8000-000000000001',
  user = '30000000-0000-4000-8000-000000000001',
  token = 'a'.repeat(64)
const member = {
  userId: user,
  email: 'cashier@example.test',
  displayName: 'Test cashier',
  role: 'cashier',
  branchId: branch,
  active: true,
  revision: 1,
  openShifts: [],
}
const list = {
  status: 'ready',
  organizationId: '40000000-0000-4000-8000-000000000001',
  branchId: branch,
  actorRole: 'manager',
  staff: [member],
  invitations: [],
  invitationHistoryTruncated: false,
  capabilities: { inviteLinks: true, emailDelivery: false },
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const props = { actorId: user, branchId: branch, deviceId: device, disabled: false }
const key = `pos-staff-request:${user}:${branch}`
async function invitationForm() {
  fireEvent.click(await screen.findByRole('button', { name: 'Invite staff member' }))
  fireEvent.change(screen.getByLabelText('Name for this branch'), {
    target: { value: 'New cashier' },
  })
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.test' } })
  fireEvent.change(screen.getByLabelText('Reason for this change'), {
    target: { value: 'New counter team' },
  })
}
beforeEach(() => {
  sessionStorage.clear()
  journal.pending = false
  window.history.replaceState(null, '', '/counter')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('manager invites only a branch cashier and retries exactly without storing any setup token', async () => {
  const sent: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') {
        sent.push(JSON.parse(options.body as string))
        return response({ code: 'storage_unavailable' }, 503)
      }
      return response(list)
    })
  )
  render(<StaffManager {...props} />)
  await invitationForm()
  expect(screen.queryByLabelText('Role')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }))
  await screen.findByRole('button', { name: 'Retry saved staff change' })
  expect(sent[0]).toMatchObject({
    role: 'cashier',
    assignedBranchId: branch,
    email: 'new@example.test',
  })
  expect(sessionStorage.getItem(key)).not.toContain('setupUrl')
  expect(sessionStorage.getItem(key)).not.toContain('password')
  fireEvent.click(screen.getByRole('button', { name: 'Retry saved staff change' }))
  await waitFor(() => expect(sent).toHaveLength(2))
  expect(sent[1]).toEqual(sent[0])
  expect(screen.getByRole('button', { name: 'Invite staff member' })).toBeDisabled()
})
it('shows the application link only after matching confirmed invite ACK, never as email sent', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') {
        const c = JSON.parse(options.body as string)
        return response({
          status: 'invited',
          requestId: c.id,
          replayed: false,
          invitation: {
            id: c.id,
            email: c.email,
            displayName: c.displayName,
            role: c.role,
            branchId: c.assignedBranchId,
            status: 'pending',
            expiresAt: c.expiresAt,
            createdAt: new Date().toISOString(),
          },
          setupUrl: `${location.origin}/staff/accept#token=${token}`,
        })
      }
      return response(list)
    })
  )
  render(<StaffManager {...props} />)
  await invitationForm()
  fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }))
  await screen.findByText('Invitation created — not sent.')
  expect(screen.getByRole('textbox', { name: 'Private invitation link' })).toHaveValue(
    `${location.origin}/staff/accept#token=${token}`
  )
  expect(sessionStorage.getItem(key)).toBeNull()
})
it('does not permit owner editing or expose a manager promotion control to branch managers', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response({
        ...list,
        actorRole: 'owner',
        staff: [{ ...member, role: 'owner', branchId: null }],
      })
    )
  )
  render(<StaffManager {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Test cashier/ }))
  expect(screen.getByText(/Owner access is read-only/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Save staff access' })).toBeNull()
})
it('holds open-shift rejections pending and never wipes the frozen change', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options?: RequestInit) =>
      options?.method === 'POST' ? response({ code: 'staff_open_shifts' }, 409) : response(list)
    )
  )
  render(<StaffManager {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Test cashier/ }))
  fireEvent.click(screen.getByLabelText('Active access'))
  fireEvent.change(screen.getByLabelText('Reason for this change'), {
    target: { value: 'Staff ended work' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save staff access' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('open shifts')
  expect(sessionStorage.getItem(key)).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Retry saved staff change' })).toBeEnabled()
})
it('fails closed when staff cannot load instead of showing an editable empty list', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({}, 503))
  )
  render(<StaffManager {...props} />)
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: 'Invite staff member' })).toBeDisabled()
  expect(screen.queryByText('No staff memberships are listed for this branch.')).toBeNull()
})
it('scrubs invitation fragment even with strict effects, accepts existing credentials, and stores neither secret', async () => {
  window.history.replaceState(null, '', `/staff/accept#token=${token}`)
  const sent: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/pos/session') return response({}, 401)
      sent.push(JSON.parse(options?.body as string))
      return response({
        status: 'accepted',
        invitationId: user,
        branchId: branch,
        role: 'cashier',
        replayed: false,
      })
    })
  )
  render(
    <StrictMode>
      <StaffInvitation />
    </StrictMode>
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Sign in and accept invitation' })).toBeEnabled()
  )
  expect(location.hash).toBe('')
  fireEvent.change(screen.getByLabelText('Invited email'), {
    target: { value: 'new@example.test' },
  })
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'synthetic-old-password' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in and accept invitation' }))
  await screen.findByText('Your branch access has been accepted.')
  expect(sent[0]).toMatchObject({
    token,
    email: 'new@example.test',
    password: 'synthetic-old-password',
  })
  expect(sessionStorage.length).toBe(0)
})
it('blocks invitation identity switch when the original actor has a pending sale', async () => {
  journal.pending = true
  window.history.replaceState(null, '', `/staff/accept#token=${token}`)
  const fetch = vi.fn(async () => response({ status: 'authenticated', userId: user }))
  vi.stubGlobal('fetch', fetch)
  render(<StaffInvitation />)
  expect(await screen.findByRole('alert')).toHaveTextContent('saved counter request')
  expect(screen.getByRole('button', { name: 'Sign in and accept invitation' })).toBeDisabled()
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('a server sign_out_first rejection gives explicit direction without automatically signing out', async () => {
  window.history.replaceState(null, '', `/staff/accept#token=${token}`)
  const fetch = vi.fn(async (url: string) =>
    url === '/api/pos/session' ? response({}, 401) : response({ code: 'sign_out_first' }, 409)
  )
  vi.stubGlobal('fetch', fetch)
  render(<StaffInvitation />)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Sign in and accept invitation' })).toBeEnabled()
  )
  fireEvent.change(screen.getByLabelText('Invited email'), {
    target: { value: 'new@example.test' },
  })
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'synthetic-old-password' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in and accept invitation' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('sign out first')
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    '/api/pos/session',
    '/api/pos/staff/invitations/accept',
  ])
})
function passwords(next = 'synthetic-new-password') {
  fireEvent.change(screen.getByLabelText('Current password'), {
    target: { value: 'synthetic-old-password' },
  })
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: next } })
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: next } })
}
it('validates UTF8 password limit before sending and keeps secrets out of journals', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  render(<AccountSettings disabled={false} />)
  passwords('🙂'.repeat(30))
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
  expect(screen.getByRole('alert')).toHaveTextContent('72 bytes')
  expect(fetch).not.toHaveBeenCalled()
  expect(sessionStorage.length).toBe(0)
})
it('requires confirmed sign-in-again ACK and clears password fields on submission', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ status: 'password_changed', requiresSignIn: true }))
  )
  render(<AccountSettings disabled={false} />)
  passwords()
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
  await screen.findByText('Password changed. Sign in again with your new password.')
  expect(screen.queryByLabelText('Current password')).toBeNull()
  expect(sessionStorage.length).toBe(0)
})
it('clearly identifies changed password even when global sign-out confirmation fails', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ code: 'password_changed_sign_out_pending' }, 503))
  )
  render(<AccountSettings disabled={false} />)
  passwords()
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Your password changed')
  expect(screen.getByRole('alert')).toHaveTextContent('NEW password')
  expect(screen.queryByRole('button', { name: 'Change password' })).toBeNull()
  expect(sessionStorage.length).toBe(0)
})

it.each([
  [409, 'staff_conflict'],
  [422, 'invalid_staff_request'],
])(
  'refreshes a definite rejected change (%s %s) before allowing a new edit',
  async (status, code) => {
    let gets = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options?: RequestInit) => {
        if (options?.method === 'POST') return response({ code }, status)
        gets++
        return response({ ...list, staff: [{ ...member, revision: gets === 1 ? 1 : 2 }] })
      })
    )
    render(<StaffManager {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /Test cashier/ }))
    fireEvent.change(screen.getByLabelText('Reason for this change'), {
      target: { value: 'Correct name' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save staff access' }))
    await screen.findByText(/The change was not saved. The latest staff access/)
    expect(gets).toBe(2)
    expect(sessionStorage.getItem(key)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry saved staff change' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Invite staff member' })).toBeEnabled()
  }
)
it('keeps editing paused if removing a definitely rejected request fails', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options?: RequestInit) =>
      options?.method === 'POST' ? response({ code: 'staff_conflict' }, 409) : response(list)
    )
  )
  render(<StaffManager {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Test cashier/ }))
  fireEvent.change(screen.getByLabelText('Reason for this change'), {
    target: { value: 'Correct name' },
  })
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new Error('storage blocked')
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save staff access' }))
  await screen.findByText(/The rejected change could not be cleared/)
  expect(sessionStorage.getItem(key)).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Invite staff member' })).toBeDisabled()
})

it('does not expose another actor’s pending management command on the same branch and device', async () => {
  sessionStorage.setItem(
    key,
    JSON.stringify({
      endpoint: '/api/pos/staff/invitations/revoke',
      body: {
        id: '50000000-0000-4000-8000-000000000001',
        branchId: branch,
        deviceId: device,
        invitationId: '60000000-0000-4000-8000-000000000001',
        reason: 'Synthetic prior actor change',
      },
    })
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(list))
  )
  render(<StaffManager {...props} actorId="70000000-0000-4000-8000-000000000001" />)
  expect(await screen.findByRole('button', { name: 'Invite staff member' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: 'Retry saved staff change' })).toBeNull()
  expect(sessionStorage.getItem(key)).not.toBeNull()
})

it('resolves an earlier-device request through recovery without changing its original payload', async () => {
  const original = {
    endpoint: '/api/pos/staff/invitations/revoke',
    body: {
      id: '50000000-0000-4000-8000-000000000001',
      branchId: branch,
      deviceId: device,
      invitationId: '60000000-0000-4000-8000-000000000001',
      reason: 'Synthetic prior counter change',
    },
  }
  sessionStorage.setItem(key, JSON.stringify(original))
  const writes: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') {
        writes.push({ url, body: JSON.parse(options.body as string) })
        return response({
          status: 'cancelled',
          requestId: original.body.id,
          kind: 'invitation.revoke',
          replayed: false,
        })
      }
      return response(list)
    })
  )
  render(<StaffManager {...props} deviceId="80000000-0000-4000-8000-000000000001" />)
  expect(await screen.findByRole('button', { name: 'Check saved change' })).toBeDisabled()
  fireEvent.click(screen.getByLabelText('If this change was not saved, permanently cancel it.'))
  fireEvent.click(screen.getByRole('button', { name: 'Check saved change' }))
  await screen.findByText(/The server confirmed this staff change was not saved/)
  expect(writes).toEqual([
    {
      url: '/api/pos/staff/recovery',
      body: { endpoint: original.endpoint, request: original.body },
    },
  ])
  expect(sessionStorage.getItem(key)).toBeNull()
})

it.each([403, 200])(
  'retains a staff recovery request on denial or mismatched cancellation (%s)',
  async (status) => {
    const original = {
      endpoint: '/api/pos/staff/invitations/revoke',
      body: {
        id: '50000000-0000-4000-8000-000000000001',
        branchId: branch,
        deviceId: device,
        invitationId: '60000000-0000-4000-8000-000000000001',
        reason: 'Synthetic pending change',
      },
    }
    sessionStorage.setItem(key, JSON.stringify(original))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options?: RequestInit) =>
        options?.method === 'POST'
          ? response(
              status === 403
                ? { code: 'staff_forbidden' }
                : {
                    status: 'cancelled',
                    requestId: original.body.id,
                    kind: 'staff.update',
                    replayed: false,
                  },
              status
            )
          : response(list)
      )
    )
    render(<StaffManager {...props} />)
    await screen.findByRole('button', { name: 'Check saved change' })
    fireEvent.click(screen.getByLabelText('If this change was not saved, permanently cancel it.'))
    fireEvent.click(screen.getByRole('button', { name: 'Check saved change' }))
    await screen.findByRole('alert')
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(original)
    expect(screen.getByRole('button', { name: 'Invite staff member' })).toBeDisabled()
  }
)
