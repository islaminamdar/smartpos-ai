import OpenAI from 'openai'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const LANG_MAP: Record<string, string> = { en: 'en', ar: 'ar', hi: 'hi', ur: 'ur', tl: 'tl' }
const REVERSE: Record<string, string> = { english: 'en', arabic: 'ar', hindi: 'hi', urdu: 'ur', tagalog: 'tl' }

export async function transcribe(audio: Blob, hintLocale?: string) {
  const file = new File([audio], 'audio.webm', { type: audio.type || 'audio/webm' })
  const resp: any = await client.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    language: hintLocale ? LANG_MAP[hintLocale] : undefined,
    response_format: 'verbose_json',
  })
  return { text: resp.text as string, language: REVERSE[resp.language] ?? hintLocale ?? 'en' }
}
