import React from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import StaffAccountSetup from '@/components/pos/staff/StaffAccountSetup'
const token = 'b'.repeat(64),
  email = 'cashier@example.invalid'
const attemptId = '10000000-0000-4000-8000-000000000001'
const accepted = {
  status: 'accepted',
  invitationId: '20000000-0000-4000-8000-000000000001',
  branchId: '30000000-0000-4000-8000-000000000001',
  role: 'cashier',
  replayed: false,
}
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  sessionStorage.clear()
})
it('requests code only after an explicit click, holds only a public attempt ID, and submits recipient secrets only to completion endpoint', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response({ status: 'setup_requested', attemptId }))
    .mockResolvedValueOnce(response(accepted))
  vi.stubGlobal('fetch', fetch)
  const onAccepted = vi.fn(),
    onBusyChange = vi.fn()
  render(
    <StaffAccountSetup token={token} ready onAccepted={onAccepted} onBusyChange={onBusyChange} />
  )
  expect(fetch).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Invited email for new account'), {
    target: { value: email },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send my verification code' }))
  expect(await screen.findByLabelText('Email verification code')).toBeVisible()
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ token, email })
  fireEvent.change(screen.getByLabelText('Email verification code'), {
    target: { value: '123456' },
  })
  fireEvent.change(screen.getByLabelText('Choose password'), {
    target: { value: 'MyChosenSecret123!' },
  })
  fireEvent.change(screen.getByLabelText('Repeat password'), {
    target: { value: 'MyChosenSecret123!' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Verify email, set password and accept' }))
  await waitFor(() => expect(onAccepted).toHaveBeenCalledOnce())
  expect(fetch.mock.calls[1][0]).toBe('/api/pos/staff/setup/complete')
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
    token,
    email,
    attemptId,
    code: '123456',
    password: 'MyChosenSecret123!',
  })
  expect(localStorage.length).toBe(0)
  expect(sessionStorage.length).toBe(0)
  expect(onBusyChange.mock.calls).toEqual([[true], [false], [true], [false]])
})
it('rejects mismatched passwords without sending and preserves uncertain setup guidance instead of declaring acceptance', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response({ status: 'setup_requested', attemptId }))
    .mockResolvedValueOnce(response({ code: 'account_created_access_unconfirmed' }, 503))
  vi.stubGlobal('fetch', fetch)
  const onAccepted = vi.fn()
  render(<StaffAccountSetup token={token} ready onAccepted={onAccepted} />)
  fireEvent.change(screen.getByLabelText('Invited email for new account'), {
    target: { value: email },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send my verification code' }))
  await screen.findByLabelText('Email verification code')
  fireEvent.change(screen.getByLabelText('Email verification code'), {
    target: { value: '123456' },
  })
  fireEvent.change(screen.getByLabelText('Choose password'), {
    target: { value: 'MyChosenSecret123!' },
  })
  fireEvent.change(screen.getByLabelText('Repeat password'), {
    target: { value: 'DifferentSecret123!' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Verify email, set password and accept' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('matching passwords')
  expect(fetch).toHaveBeenCalledTimes(1)
  fireEvent.change(screen.getByLabelText('Repeat password'), {
    target: { value: 'MyChosenSecret123!' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Verify email, set password and accept' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Your password was set, but branch access was not confirmed'
  )
  expect(onAccepted).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Choose password')).toHaveValue('')
})
it('cannot send setup messages before browser recovery checks allow it', () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  render(<StaffAccountSetup token={token} ready={false} onAccepted={vi.fn()} />)
  expect(screen.getByRole('button', { name: 'Send my verification code' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Send my verification code' }))
  expect(fetch).not.toHaveBeenCalled()
})
