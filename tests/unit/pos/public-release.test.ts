import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { publicReleaseAccess } from '@/lib/pos/public-release'
import { middleware } from '@/middleware'

it('exposes only exact manager review reads and keeps candidate payment decisions unreachable', () => {
  for (const pilot of [true, false]) {
    for (const path of ['/api/pos/manager/offline-payments', '/api/pos/manager/offline-payments/case']) {
      expect(publicReleaseAccess(path, 'GET', pilot)).toBe('allow')
      expect(publicReleaseAccess(path, 'POST', pilot)).not.toBe('allow')
      expect(publicReleaseAccess(path + '/other', 'GET', pilot)).not.toBe('allow')
    }
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
      expect(publicReleaseAccess('/api/pos/manager/offline-payments/resolve', method, pilot)).not.toBe('allow')
  }
})

it('keeps signed historical offline recovery reachable when new selling is paused', () => {
  for (const enabled of [false, true]) {
    for (const suffix of ['import', 'seal', 'bundle-recovery', 'payment-freeze', 'payment-resolution']) {
      const path = '/api/pos/offline/' + suffix
      expect(publicReleaseAccess(path, 'POST', enabled)).toBe('allow')
      for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) expect(publicReleaseAccess(path, method, enabled)).not.toBe('allow')
      expect(publicReleaseAccess(path + '/extra', 'POST', enabled)).not.toBe('allow')
    }
    for (const suffix of ['enroll', 'authority']) expect(publicReleaseAccess('/api/pos/offline/' + suffix, 'POST', enabled) === 'allow').toBe(enabled)
  }
})

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
      ['/api/pos/native/continuation', 'POST'],
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
    '/api/pos/offers': ['GET', 'POST'],
    '/api/pos/offers/quote': ['POST'],
    '/api/pos/reports': ['GET'],
    '/api/pos/operations': ['GET'],
    '/api/pos/tab-kitchen': ['GET', 'POST'],
    '/api/pos/tab-kitchen/recovery': ['POST'],
    '/api/pos/staff': ['GET', 'POST'],
    '/api/pos/staff/invitations': ['POST'],
    '/api/pos/staff/recovery': ['POST'],
    '/api/pos/staff/invitations/revoke': ['POST'],
    '/api/pos/staff/invitations/accept': ['POST'],
    '/api/pos/account/password': ['POST'],
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
  expect(publicReleaseAccess('/staff/accept', 'GET', true)).toBe('allow')
  expect(publicReleaseAccess('/staff/accept', 'POST', true)).toBe('not_found')
  expect(publicReleaseAccess('/staff/accept', 'GET', false)).toBe('not_found')
})

it('passes kitchen dispatch through middleware only in the online pilot', () => {
  try {
    for (const enabled of [false, true]) {
      vi.stubEnv('POS_ONLINE_PILOT', String(enabled))
      for (const [path, method] of [
        ['/api/pos/tab-kitchen', 'GET'],
        ['/api/pos/tab-kitchen', 'POST'],
        ['/api/pos/tab-kitchen/recovery', 'POST'],
      ]) {
        const response = middleware(new NextRequest('https://pos.internext.info' + path, { method }))
        expect(response.status).toBe(enabled ? 200 : 503)
      }
    }
  } finally {
    vi.unstubAllEnvs()
  }
})


it('keeps only exact native drawer-close POST reachable for historical recovery',()=>{
 for(const pilot of [true,false]){
  expect(publicReleaseAccess('/api/pos/native/shift-close','POST',pilot)).toBe('allow')
  for(const method of ['GET','PUT','PATCH','DELETE','OPTIONS'])expect(publicReleaseAccess('/api/pos/native/shift-close',method,pilot)).not.toBe('allow')
  expect(publicReleaseAccess('/api/pos/native/shift-close/extra','POST',pilot)).not.toBe('allow')
 }
})

it('exposes only exact native PIN recovery POST even when new selling is paused',()=>{
 for(const pilot of [true,false]){
  expect(publicReleaseAccess('/api/pos/native/pin-recovery','POST',pilot)).toBe('allow')
  for(const method of ['GET','PUT','PATCH','DELETE','OPTIONS'])expect(publicReleaseAccess('/api/pos/native/pin-recovery',method,pilot)).not.toBe('allow')
  expect(publicReleaseAccess('/api/pos/native/pin-recovery/extra','POST',pilot)).not.toBe('allow')
 }
})
