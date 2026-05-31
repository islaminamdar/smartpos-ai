import { describe, it, expect, vi } from 'vitest'
import { transcribe } from '@/lib/ai/transcribe'

vi.mock('openai', () => ({
  default: class {
    audio = {
      transcriptions: {
        create: vi.fn(async () => ({ text: 'two karak less sugar', language: 'english' })),
      },
    }
  },
}))

describe('transcribe', () => {
  it('returns text and detected language', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' })
    const result = await transcribe(blob, 'en')
    expect(result.text).toContain('karak')
    expect(result.language).toBe('en')
  })
})
