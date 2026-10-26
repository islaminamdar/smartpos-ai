import { describe, expect, it } from 'vitest'
import { validCounterPortalSlug } from '@/lib/pos/counter-portal'
import { publicReleaseAccess } from '@/lib/pos/public-release'

describe('customer counter portals', () => {
  it('accepts only a bounded lower-case customer URL slug', () => {
    for (const slug of ['agsum', 'al-noor-01', 'a']) expect(validCounterPortalSlug(slug)).toBe(true)
    for (const slug of ['', '-agsum', 'Agsum', 'agsum/', 'agsum--branch', 'a'.repeat(64)])
      expect(validCounterPortalSlug(slug)).toBe(false)
  })

  it('permits only a read of a valid portal shell', () => {
    expect(publicReleaseAccess('/agsum', 'GET', true)).toBe('allow')
    expect(publicReleaseAccess('/agsum', 'POST', true)).toBe('not_found')
    expect(publicReleaseAccess('/agsum/orders', 'GET', true)).toBe('not_found')
    expect(publicReleaseAccess('/Agsum', 'GET', true)).toBe('not_found')
  })

  it('permits a QR menu display route without opening a public checkout surface', () => {
    expect(publicReleaseAccess('/menu/agsum', 'GET', true)).toBe('allow')
    expect(publicReleaseAccess('/menu/agsum', 'POST', true)).toBe('not_found')
    expect(publicReleaseAccess('/menu/agsum/checkout', 'GET', true)).toBe('not_found')
    expect(publicReleaseAccess('/menu/Agsum', 'GET', true)).toBe('not_found')
  })
})
