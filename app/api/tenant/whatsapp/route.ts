import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth/session'
import { createServiceRole } from '@/lib/db/supabase'

const Body = z.object({ phoneNumberId: z.string().min(3), token: z.string().min(10) })

export async function POST(req: Request) {
  const s = await requireSession()
  const { phoneNumberId, token } = Body.parse(await req.json())
  const admin = createServiceRole()
  await admin
    .from('tenants')
    .update({
      whatsapp_phone_number_id: phoneNumberId,
      whatsapp_access_token: token,
    })
    .eq('id', s.tenantId)
  return NextResponse.json({ ok: true })
}
