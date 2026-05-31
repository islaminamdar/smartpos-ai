import * as Sentry from '@sentry/nextjs'

export const log = {
  info: (msg: string, ctx?: Record<string, unknown>) => {
    console.log('[info]', msg, ctx ?? '')
  },
  warn: (msg: string, ctx?: Record<string, unknown>) => {
    console.warn('[warn]', msg, ctx)
    Sentry.captureMessage(msg, { level: 'warning', extra: ctx })
  },
  error: (e: unknown, ctx?: Record<string, unknown>) => {
    console.error('[err]', e, ctx)
    Sentry.captureException(e, { extra: ctx })
  },
}
