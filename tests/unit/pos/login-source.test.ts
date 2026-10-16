// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
vi.mock('@/lib/pos/server/client', () => ({
  PosServerError: class extends Error {
    constructor(
      public code: string,
      public status: number
    ) {
      super(code)
    }
  },
}))
import { loginSourceKey } from '@/lib/pos/server/login-source'
const request = (source?: string, url = 'https://pos.example/api/pos/session') =>
  new Request(url, { headers: source ? { 'x-forwarded-for': source } : {} })
afterEach(() => vi.unstubAllEnvs())
describe('explicit trusted login source boundary', () => {
  it('fails closed unless the source mode is configured', () => {
    vi.stubEnv('POS_LOGIN_SOURCE_MODE', '')
    expect(() => loginSourceKey(request('198.51.100.1'))).toThrow('login_source_unavailable')
  })
  it('only trusts rightmost proxy appended IP, ignoring spoofed leftmost entries', () => {
    vi.stubEnv('POS_LOGIN_SOURCE_MODE', 'apache-rightmost')
    const key = loginSourceKey(request('198.51.100.2'))
    expect(loginSourceKey(request('203.0.113.20, 198.51.100.2'))).toBe(key)
    expect(loginSourceKey(request('forged, 198.51.100.2'))).toBe(key)
    expect(loginSourceKey(request('198.51.100.3'))).not.toBe(key)
  })
  it('rejects missing/malformed final proxy values rather than using a shared bucket', () => {
    vi.stubEnv('POS_LOGIN_SOURCE_MODE', 'apache-rightmost')
    for (const value of [
      undefined,
      '198.51.100.1,',
      '198.51.100.1, invalid',
      'localhost',
      '198.51.100.1:443',
      'a'.repeat(8193),
    ])
      expect(() => loginSourceKey(request(value))).toThrow()
  })
  it('normalizes IPv4 mapped forms and groups IPv6 at /64', () => {
    vi.stubEnv('POS_LOGIN_SOURCE_MODE', 'apache-rightmost')
    expect(loginSourceKey(request('::ffff:198.51.100.2'))).toBe(
      loginSourceKey(request('198.51.100.2'))
    )
    expect(loginSourceKey(request('2001:db8:1234:5678::1'))).toBe(
      loginSourceKey(request('2001:0db8:1234:5678:ffff:1:2:3'))
    )
    expect(loginSourceKey(request('2001:db8:1234:5679::1'))).not.toBe(
      loginSourceKey(request('2001:db8:1234:5678::1'))
    )
  })
  it('local preview mode requires both configured and actual loopback origin', () => {
    vi.stubEnv('POS_LOGIN_SOURCE_MODE', 'loopback-development')
    vi.stubEnv('POS_PUBLIC_ORIGIN', 'http://127.0.0.1:3048')
    expect(loginSourceKey(request(undefined, 'http://127.0.0.1:3048/api/pos/session'))).toMatch(
      /^[a-f0-9]{64}$/
    )
    expect(loginSourceKey(new NextRequest('http://127.0.0.1:3048/api/pos/session'))).toMatch(
      /^[a-f0-9]{64}$/
    )
    expect(loginSourceKey(request(undefined, 'http://localhost:3048/api/pos/session'))).toMatch(
      /^[a-f0-9]{64}$/
    )
    expect(() =>
      loginSourceKey(request(undefined, 'http://localhost:3049/api/pos/session'))
    ).toThrow()
    expect(() =>
      loginSourceKey(request(undefined, 'https://localhost:3048/api/pos/session'))
    ).toThrow()
    expect(() => loginSourceKey(request())).toThrow()
    vi.stubEnv('POS_PUBLIC_ORIGIN', 'https://pos.example')
    expect(() => loginSourceKey(request())).toThrow()
  })
})
