import { describe, expect, it } from 'vitest'
import { browserUuid, installBrowserUuidCompatibility } from '@/lib/pos/browser-uuid'

describe('browser UUID compatibility', () => {
  it('uses secure random values to produce a UUID v4 when randomUUID is unavailable', () => {
    const values = new Uint8Array(16).map((_, index) => index)
    const uuid = browserUuid({
      getRandomValues: (target: Uint8Array) => (target.set(values), target),
    } as Crypto)
    expect(uuid).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
  })

  it('installs the fallback on a compatible legacy WebView crypto object', () => {
    const legacy = { getRandomValues: (target: Uint8Array) => target.fill(1) }
    installBrowserUuidCompatibility(legacy as Crypto)
    expect((legacy as unknown as { randomUUID: () => string }).randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })
})
