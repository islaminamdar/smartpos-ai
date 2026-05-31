import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth/session'
import { createServiceRole } from '@/lib/db/supabase'
import { formatTicket } from '@/lib/printing/escpos'
import { sendPrint } from '@/lib/printing/printnode'

const Body = z.object({ orderId: z.string().uuid() })

export async function POST(req: Request) {
  const s = await requireSession()
  const { orderId } = Body.parse(await req.json())
  const admin = createServiceRole()
  const { data: tenant } = await admin
    .from('tenants')
    .select('name, printnode_printer_id')
    .eq('id', s.tenantId)
    .single()
  if (!tenant?.printnode_printer_id) {
    return NextResponse.json({ error: 'No printer configured' }, { status: 400 })
  }
  const { data: order } = await admin
    .from('orders')
    .select(
      'id, table_label, total_aed, created_at, order_items(name_snapshot, qty, unit_price_aed, modifiers_snapshot)'
    )
    .eq('id', orderId)
    .eq('tenant_id', s.tenantId)
    .single()
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const raw = formatTicket({
    tenantName: tenant.name,
    orderId: order.id,
    tableLabel: (order as any).table_label,
    items: ((order as any).order_items as any[]).map((i) => ({
      name: i.name_snapshot,
      qty: i.qty,
      price_aed: Number(i.unit_price_aed),
      modifiers: i.modifiers_snapshot as any[],
    })),
    total_aed: Number((order as any).total_aed),
    createdAt: new Date((order as any).created_at),
  })
  const job = await sendPrint(tenant.printnode_printer_id, raw)
  return NextResponse.json({ jobId: job })
}
