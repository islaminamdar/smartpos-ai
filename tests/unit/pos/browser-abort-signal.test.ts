import { describe, expect, it } from 'vitest'
import { installBrowserAbortSignalCompatibility } from '@/lib/pos/browser-abort-signal'

describe('counter request compatibility', () => {
  it('provides timeout and combined abort signals for older browser engines', async () => {
    const legacy = {} as typeof AbortSignal
    installBrowserAbortSignalCompatibility(legacy)

    expect(typeof legacy.timeout).toBe('function')
    expect(typeof legacy.any).toBe('function')
    const controller = new AbortController()
    const combined = legacy.any!([controller.signal, legacy.timeout!(1000)])
    controller.abort()
    expect(combined.aborted).toBe(true)
  })
})
