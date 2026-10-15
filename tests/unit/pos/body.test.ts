import { describe, expect, it } from 'vitest'
import { PosPayloadTooLarge, readBoundedBody } from '@/lib/pos/server/body'

describe('bounded POS request parsing', () => {
  it('rejects oversized chunked payload before reading remaining chunks', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(11)) },
      cancel() { cancelled = true },
    })
    const request = new Request('http://localhost', { method: 'POST', body, duplex: 'half' } as RequestInit)
    await expect(readBoundedBody(request, 10)).rejects.toBeInstanceOf(PosPayloadTooLarge)
    expect(cancelled).toBe(true)
  })
  it('decodes split UTF-8 bytes after enforcing the byte limit', async () => {
    const bytes = new TextEncoder().encode('رسالة')
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, 1)); controller.enqueue(bytes.slice(1)); controller.close() } })
    const request = new Request('http://localhost', { method: 'POST', body, duplex: 'half' } as RequestInit)
    expect(await readBoundedBody(request, bytes.length)).toBe('رسالة')
  })
})
