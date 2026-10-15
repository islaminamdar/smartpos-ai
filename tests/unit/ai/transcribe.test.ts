import { afterEach, describe, it, expect, vi } from 'vitest'
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

afterEach(() => vi.unstubAllEnvs())

describe('transcribe', () => {
  it('fails closed when optional transcription is not configured', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    await expect(transcribe(new Blob())).rejects.toThrow('TRANSCRIPTION_NOT_CONFIGURED')
  })
  it('returns text and detected language', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'unit-test-sdk-is-mocked')
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' })
    const result = await transcribe(blob, 'en')
    expect(result.text).toContain('karak')
    expect(result.language).toBe('en')
  })
})
