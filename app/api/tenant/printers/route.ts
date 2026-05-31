import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth/session'
import { createServiceRole } from '@/lib/db/supabase'

export async function GET() {
  await requireSession()
  if (!process.env.PRINTNODE_API_KEY) return NextResponse.json({ printers: [] })
  const auth = Buffer.from(process.env.PRINTNODE_API_KEY + ':').toString('base64')
  const r = await fetch('https://api.printnode.com/printers', {
    headers: { Authorization: `Basic ${auth}` },
  })
  if (!r.ok) return NextResponse.json({ printers: [] })
  const list = (await r.json()) as { id: number; name: string }[]
  return NextResponse.json({ printers: list.map((p) => ({ id: p.id, name: p.name })) })
}

const Body = z.object({ printerId: z.number().int() })

export async function POST(req: Request) {
  const s = await requireSession()
  const { printerId } = Body.parse(await req.json())
  const admin = createServiceRole()
  await admin.from('tenants').update({ printnode_printer_id: printerId }).eq('id', s.tenantId)
  return NextResponse.json({ ok: true })
}
