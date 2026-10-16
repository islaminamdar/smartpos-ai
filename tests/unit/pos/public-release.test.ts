import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { publicReleaseAccess } from '@/lib/pos/public-release'
import { middleware } from '@/middleware'

describe('training-only hosted release', () => {
  it('allows only required public pages and assets', () => {
    for (const path of [
      '/',
      '/pos',
      '/pos/',
      '/pos-sw.js',
      '/pos.webmanifest',
      '/_next/static/app.js',
      '/pos-assets/menu/photo.webp',
      '/api/pos/health',
    ])
      expect(publicReleaseAccess(path, 'GET')).toBe('allow')
    for (const path of [
      '/login',
      '/signup',
      '/dashboard',
      '/api/ai/parse-order',
      '/api/stripe/webhook',
      '/api/print',
      '/_next/image',
      '/.env',
    ])
      expect(publicReleaseAccess(path, 'GET')).toBe('not_found')
  })
  it('blocks Server Actions even when posted to an allowed public page', async () => {
    vi.stubEnv('POS_PUBLIC_RELEASE_ONLY', 'true')
    try {
      const result = await middleware(
        new NextRequest('https://pos.internext.info/pos', {
          method: 'POST',
          headers: { 'next-action': 'any-id' },
        })
      )
      expect(result.status).toBe(404)
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
        expect(publicReleaseAccess('/', method)).toBe('not_found')
    } finally {
      vi.unstubAllEnvs()
    }
  })
  it('never advertises live financial APIs as working', async () => {
    vi.stubEnv('POS_PUBLIC_RELEASE_ONLY', 'true')
    try {
      const response = await middleware(
        new NextRequest('https://pos.internext.info/api/pos/sync', { method: 'POST' })
      )
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ code: 'live_sales_not_enabled' })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('online pilot route isolation', () => {
  it('permits only exact pilot endpoints and keeps every legacy route blocked', () => {
    for (const [path, method] of [
      ['/counter', 'GET'],
      ['/api/pos/session', 'POST'],
      ['/api/pos/session', 'DELETE'],
      ['/api/pos/bootstrap', 'GET'],
      ['/api/pos/sync', 'POST'],
      ['/api/pos/commands', 'POST'],
      ['/api/pos/receipts', 'GET'],
      ['/api/pos/devices', 'POST'],
    ])
      expect(publicReleaseAccess(path, method, true)).toBe('allow')
    for (const path of [
      '/login',
      '/signup',
      '/dashboard',
      '/api/ai/parse-order',
      '/api/print',
      '/api/stripe/webhook',
      '/api/whatsapp/webhook',
    ])
      expect(publicReleaseAccess(path, 'POST', true)).toBe('not_found')
    expect(publicReleaseAccess('/counter', 'POST', true)).toBe('not_found')
    expect(publicReleaseAccess('/api/pos/session', 'PUT', true)).toBe('unavailable')
  })
  it('never falls back to legacy auth/routes when release flags are absent', async () => {
    vi.stubEnv('POS_PUBLIC_RELEASE_ONLY', 'false')
    vi.stubEnv('POS_ONLINE_PILOT', 'false')
    try {
      expect((await middleware(new NextRequest('https://pos.internext.info/signup'))).status).toBe(
        404
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

it('allows explicit pending recovery even when sale writes are paused', () => {
  expect(publicReleaseAccess('/api/pos/recovery', 'POST', true)).toBe('allow')
  expect(publicReleaseAccess('/api/pos/recovery', 'GET', true)).toBe('unavailable')
})

it('limits new manager and recurring billing surfaces to exact methods', () => {
  for (const [path, methods] of Object.entries({
    '/api/pos/catalogue': ['GET', 'POST'],
    '/api/billing/paypal/status': ['GET'],
    '/api/billing/paypal/checkout': ['POST'],
    '/api/billing/paypal/reconcile': ['POST'],
    '/api/billing/paypal/cancel': ['POST'],
    '/api/billing/paypal/webhook': ['POST'],
  })) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
      expect(publicReleaseAccess(path, method, true) === 'allow').toBe(methods.includes(method))
    expect(publicReleaseAccess(path + '/extra', 'POST', true)).not.toBe('allow')
  }
  expect(publicReleaseAccess('/billing', 'GET', true)).toBe('allow')
  expect(publicReleaseAccess('/billing', 'POST', true)).toBe('not_found')
  expect(publicReleaseAccess('/billing', 'GET', false)).toBe('not_found')
})
