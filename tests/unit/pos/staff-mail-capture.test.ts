// An isolated local SMTP sink captures the real Nodemailer DATA message. No mail leaves this process.
import { createServer, type Socket } from 'node:net'
import { expect, it, vi } from 'vitest'
const capture = vi.hoisted(() => ({ port: 0, options: null as unknown }))
vi.mock('nodemailer', async (original) => {
  const actual = await original<typeof import('nodemailer')>()
  return {
    default: {
      createTransport: (options: object) => {
        capture.options = options
        // Production target remains fixed127.0.0.1:25; only this test redirects to its disposable sink.
        return actual.default.createTransport({ ...options, host: '127.0.0.1', port: capture.port })
      },
    },
  }
})
import { sendStaffSetupCode } from '@/lib/pos/server/staff-mail'
it('submits a single recipient-only message to a captured SMTP session without auth link or password', async () => {
  const clients: Socket[] = [],
    messages: string[] = [],
    commands: string[] = []
  const server = createServer((socket) => {
    clients.push(socket)
    socket.setEncoding('utf8')
    socket.write('220 isolated-capture ESMTP\r\n')
    let buffer = '',
      data = false,
      message = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'),
          line = buffer.slice(0, index + 1)
        buffer = buffer.slice(index + 1)
        if (data) {
          if (line.trim() === '.') {
            messages.push(message)
            message = ''
            data = false
            socket.write('250 message-captured\r\n')
          } else message += line
          continue
        }
        commands.push(line.trim())
        if (/^EHLO|^HELO/.test(line)) socket.write('250 isolated-capture\r\n')
        else if (/^MAIL FROM|^RCPT TO/.test(line)) socket.write('250 ok\r\n')
        else if (/^DATA/.test(line)) {
          data = true
          socket.write('354 end-with-dot\r\n')
        } else if (/^QUIT/.test(line)) socket.end('221 bye\r\n')
        else socket.write('250 ok\r\n')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No isolated port')
  capture.port = address.port
  vi.stubEnv('POS_STAFF_ACCOUNT_SETUP', 'true')
  vi.stubEnv('POS_STAFF_MAIL_TRANSPORT', 'local-smtp')
  vi.stubEnv('POS_STAFF_MAIL_FROM', 'noreply@example.invalid')
  try {
    await sendStaffSetupCode('recipient@example.invalid', '123456')
    expect(capture.options).toMatchObject({ host: '127.0.0.1', port: 25, ignoreTLS: true })
    expect(messages).toHaveLength(1)
    expect(commands.filter((x) => x.startsWith('RCPT TO:'))).toEqual([
      'RCPT TO:<recipient@example.invalid>',
    ])
    expect(messages[0]).toContain('To: recipient@example.invalid')
    expect(messages[0]).toContain('123456')
    expect(messages[0].replace(/=\r?\n/g, '')).toContain('No branch access has been granted')
    expect(messages[0]).not.toMatch(/https?:|token=|Bcc:|Cc:/)
  } finally {
    vi.unstubAllEnvs()
    for (const client of clients) client.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
