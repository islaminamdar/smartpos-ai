import 'server-only'
import nodemailer from 'nodemailer'
import { z } from 'zod'
import { PosServerError } from './client'

function configuration() {
  if (process.env.POS_STAFF_ACCOUNT_SETUP !== 'true') return null
  const from = z.string().email().max(254).safeParse(process.env.POS_STAFF_MAIL_FROM)
  if (!from.success) return null
  // Only the host's fixed loopback MTA may use plaintext. No request or env can redirect it.
  if (process.env.POS_STAFF_MAIL_TRANSPORT === 'local-smtp') {
    return {
      from: from.data,
      transport: {
        host: '127.0.0.1',
        port: 25,
        secure: false,
        ignoreTLS: true,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
      },
    }
  }
  if (process.env.POS_STAFF_MAIL_TRANSPORT === 'sendmail') {
    const path = process.env.POS_STAFF_SENDMAIL_PATH
    if (path !== '/usr/sbin/sendmail' && path !== '/usr/lib/sendmail') return null
    return {
      from: from.data,
      transport: { sendmail: true as const, path, newline: 'unix' as const },
    }
  }
  if (process.env.POS_STAFF_MAIL_TRANSPORT !== 'smtp') return null
  const host = process.env.POS_STAFF_SMTP_HOST ?? ''
  const port = Number(process.env.POS_STAFF_SMTP_PORT)
  const user = process.env.POS_STAFF_SMTP_USER
  const pass = process.env.POS_STAFF_SMTP_PASSWORD
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host) || ![465, 587].includes(port) || !user || !pass)
    return null
  return {
    from: from.data,
    transport: {
      host,
      port,
      secure: port === 465,
      requireTLS: true,
      auth: { user, pass },
      tls: { rejectUnauthorized: true },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    },
  }
}
export function staffAccountSetupAvailable() {
  return configuration() !== null
}
export async function sendStaffSetupCode(email: string, code: string) {
  const config = configuration()
  if (!config || !z.string().email().max(254).safeParse(email).success || !/^\d{6,10}$/.test(code))
    throw new PosServerError('account_setup_unavailable', 503)
  const transport = nodemailer.createTransport(config.transport)
  try {
    const result = await transport.sendMail({
      from: { name: 'Internext POS', address: config.from },
      to: email,
      subject: 'Your Internext POS account setup code',
      text: `Your account setup code is: ${code}\n\nEnter it on the invitation page within 10 minutes. Do not share it, including with your manager. If you did not request account setup, ignore this message. No branch access has been granted.`,
      disableFileAccess: true,
      disableUrlAccess: true,
    })
    // SMTP acceptance / local MTA queue acceptance is not inbox delivery.
    if (
      !('sendmail' in config.transport) &&
      !result.accepted?.some((item: unknown) => item === email)
    )
      throw new PosServerError('verification_request_unconfirmed', 503)
  } catch {
    throw new PosServerError('verification_request_unconfirmed', 503)
  } finally {
    transport.close()
  }
}
