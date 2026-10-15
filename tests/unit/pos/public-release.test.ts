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
