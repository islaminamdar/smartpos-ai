import { beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn(), close: vi.fn() }))
vi.mock('nodemailer', () => ({ default: { createTransport: m.create } }))
import { staffAccountSetupAvailable, sendStaffSetupCode } from '@/lib/pos/server/staff-mail'
beforeEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  for (const name of [
    'POS_STAFF_ACCOUNT_SETUP',
    'POS_STAFF_MAIL_TRANSPORT',
    'POS_STAFF_MAIL_FROM',
    'POS_STAFF_SENDMAIL_PATH',
    'POS_STAFF_SMTP_HOST',
    'POS_STAFF_SMTP_PORT',
    'POS_STAFF_SMTP_USER',
    'POS_STAFF_SMTP_PASSWORD',
  ])
    vi.stubEnv(name, '')
  m.create.mockReturnValue({ sendMail: m.send, close: m.close })
  m.send.mockResolvedValue({ accepted: ['cashier@example.invalid'] })
})
it('defaults off and accepts only explicit fixed sendmail paths', () => {
  expect(staffAccountSetupAvailable()).toBe(false)
  vi.stubEnv('POS_STAFF_ACCOUNT_SETUP', 'true')
  vi.stubEnv('POS_STAFF_MAIL_FROM', 'pos@example.invalid')
  vi.stubEnv('POS_STAFF_MAIL_TRANSPORT', 'sendmail')
  for (const path of ['/bin/sh', '/tmp/sendmail', '/usr/sbin/sendmail -x']) {
    vi.stubEnv('POS_STAFF_SENDMAIL_PATH', path)
    expect(staffAccountSetupAvailable()).toBe(false)
  }
  vi.stubEnv('POS_STAFF_SENDMAIL_PATH', '/usr/sbin/sendmail')
  expect(staffAccountSetupAvailable()).toBe(true)
})
it('requires authenticated TLS SMTP and never logs or returns verification secrets', async () => {
  vi.stubEnv('POS_STAFF_ACCOUNT_SETUP', 'true')
  vi.stubEnv('POS_STAFF_MAIL_FROM', 'pos@example.invalid')
  vi.stubEnv('POS_STAFF_MAIL_TRANSPORT', 'smtp')
  vi.stubEnv('POS_STAFF_SMTP_HOST', 'mail.example.invalid')
  vi.stubEnv('POS_STAFF_SMTP_PORT', '587')
  vi.stubEnv('POS_STAFF_SMTP_USER', 'pos@example.invalid')
  vi.stubEnv('POS_STAFF_SMTP_PASSWORD', 'synthetic')
  expect(staffAccountSetupAvailable()).toBe(true)
  expect(await sendStaffSetupCode('cashier@example.invalid', '123456')).toBeUndefined()
  expect(m.create).toHaveBeenCalledWith(
    expect.objectContaining({ port: 587, requireTLS: true, tls: { rejectUnauthorized: true } })
  )
  expect(m.send).toHaveBeenCalledWith(
    expect.objectContaining({
      to: 'cashier@example.invalid',
      disableFileAccess: true,
      disableUrlAccess: true,
    })
  )
  expect(m.close).toHaveBeenCalledOnce()
  vi.stubEnv('POS_STAFF_SMTP_PORT', '25')
  expect(staffAccountSetupAvailable()).toBe(false)
})
it('rejects recipient/header injection, invalid codes and unaccepted delivery', async () => {
  vi.stubEnv('POS_STAFF_ACCOUNT_SETUP', 'true')
  vi.stubEnv('POS_STAFF_MAIL_FROM', 'pos@example.invalid')
  vi.stubEnv('POS_STAFF_MAIL_TRANSPORT', 'smtp')
  vi.stubEnv('POS_STAFF_SMTP_HOST', 'mail.example.invalid')
  vi.stubEnv('POS_STAFF_SMTP_PORT', '465')
  vi.stubEnv('POS_STAFF_SMTP_USER', 'pos@example.invalid')
  vi.stubEnv('POS_STAFF_SMTP_PASSWORD', 'synthetic')
  await expect(
    sendStaffSetupCode('cashier@example.invalid\nBcc: bad@example.invalid', '123456')
  ).rejects.toMatchObject({ code: 'account_setup_unavailable' })
  await expect(sendStaffSetupCode('cashier@example.invalid', 'not-code')).rejects.toMatchObject({
    code: 'account_setup_unavailable',
  })
  expect(m.send).not.toHaveBeenCalled()
  m.send.mockResolvedValue({ accepted: [] })
  await expect(sendStaffSetupCode('cashier@example.invalid', '123456')).rejects.toMatchObject({
    code: 'verification_request_unconfirmed',
  })
  expect(m.close).toHaveBeenCalledOnce()
})

it('local SMTP is fixed to loopback25 and cannot be redirected by host, port or TLS environment overrides', async () => {
  vi.stubEnv('POS_STAFF_ACCOUNT_SETUP', 'true')
  vi.stubEnv('POS_STAFF_MAIL_FROM', 'pos@example.invalid')
  vi.stubEnv('POS_STAFF_MAIL_TRANSPORT', 'local-smtp')
  vi.stubEnv('POS_STAFF_SMTP_HOST', 'external.example.invalid')
  vi.stubEnv('POS_STAFF_SMTP_PORT', '587')
  expect(staffAccountSetupAvailable()).toBe(true)
  await sendStaffSetupCode('cashier@example.invalid', '123456')
  expect(m.create).toHaveBeenCalledWith(
    expect.objectContaining({ host: '127.0.0.1', port: 25, secure: false, ignoreTLS: true })
  )
})
