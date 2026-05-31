import { NextResponse } from 'next/server'
import { createServiceRole } from '@/lib/db/supabase'
import { handleInbound } from '@/lib/whatsapp/handler'

export async function GET(req: Request) {
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
  const payload = await req.json()
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
