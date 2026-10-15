import { createHmac, timingSafeEqual } from 'node:crypto'
import { readBoundedBody, PosPayloadTooLarge } from '@/lib/pos/server/body'
import { NextResponse } from 'next/server'
import { createServiceRole } from '@/lib/db/supabase'
import { handleInbound } from '@/lib/whatsapp/handler'

// Legacy integration remains off until separately reviewed and explicitly enabled.
const enabled = () => process.env.ENABLE_LEGACY_WHATSAPP_WEBHOOK === 'true'

export async function GET(req: Request) {
  if (!enabled()) return new Response('not found', { status: 404 })
  if (!process.env.META_WEBHOOK_VERIFY_TOKEN) return new Response('not configured', { status: 503 })
  const url = new URL(req.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')
  if (
    mode === 'subscribe' &&
    token === process.env.META_WEBHOOK_VERIFY_TOKEN
  ) {
    return new Response(challenge ?? '', { status: 200 })
  }
  return new Response('forbidden', { status: 403 })
}

export async function POST(req: Request) {
  if (!enabled()) return new Response('not found', { status: 404 })
  const secret = process.env.META_APP_SECRET
  if (!secret) return new Response('not configured', { status: 503 })
  const signature = req.headers.get('x-hub-signature-256') ?? ''
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return new Response('forbidden', { status: 403 })
  let body: string
  try { body = await readBoundedBody(req, 1_000_000) }
  catch (error) {
    if (error instanceof PosPayloadTooLarge) return new Response('payload too large', { status: 413 })
    throw error
  }
  const expected = createHmac('sha256', secret).update(body).digest()
  const supplied = Buffer.from(signature.slice(7), 'hex')
  if (!timingSafeEqual(expected, supplied)) return new Response('forbidden', { status: 403 })
  let payload
  try { payload = JSON.parse(body) } catch { return new Response('invalid json', { status: 400 }) }
  if (!payload || typeof payload !== 'object') return new Response('invalid payload', { status: 400 })
  const entry = payload.entry?.[0]
  const change = entry?.changes?.[0]
  const value = change?.value
  const phoneNumberId = value?.metadata?.phone_number_id
  const msg = value?.messages?.[0]
  if (!msg || !phoneNumberId) return NextResponse.json({ ok: true })

  const admin = createServiceRole()
  const { data: tenant } = (await admin
    .from('tenants')
    .select('id')
    .eq('whatsapp_phone_number_id', phoneNumberId)
    .single()) as { data: { id: string } | null }

  if (!tenant) return NextResponse.json({ ok: true })

  const text = msg.text?.body ?? msg.button?.text ?? ''
  if (!text) return NextResponse.json({ ok: true })

  await handleInbound({
    tenantId: tenant.id,
    from: msg.from,
    text,
    profileName: value.contacts?.[0]?.profile?.name,
  })

  return NextResponse.json({ ok: true })
}
