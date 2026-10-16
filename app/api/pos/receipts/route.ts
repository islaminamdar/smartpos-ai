import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requirePilot } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { fiscalDocumentSchema } from '@/lib/pos/server/documents'
import { decodeReceiptCursor, encodeReceiptCursor, receiptCursorFilter } from '@/lib/pos/server/receipt-cursor'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    requirePilot()
    const { client } = await authenticatedPosClient()
    const parsed = z.object({ branchId: z.string().uuid(), orderId: z.string().uuid().optional(), cursor: z.string().max(512).optional(), before: z.string().datetime({ offset: true }).optional() }).strict().safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!parsed.success || (parsed.data.cursor && parsed.data.before)) throw new PosServerError('invalid_query', 422)
    let cursor
    if (parsed.data.cursor) {
      try { cursor = decodeReceiptCursor(parsed.data.cursor) } catch { throw new PosServerError('invalid_cursor', 422) }
    }
    let query = client.from('pos_documents').select('id,issued_at,snapshot').eq('branch_id', parsed.data.branchId).order('issued_at', { ascending: false }).order('id', { ascending: false }).limit(100)
    if (parsed.data.orderId) query = query.eq('order_id', parsed.data.orderId)
    if (cursor) query = query.or(receiptCursorFilter(cursor))
    // Compatibility only. New clients must use nextCursor to preserve timestamp ties.
    if (parsed.data.before) query = query.lt('issued_at', parsed.data.before)
    const { data, error } = await query
    if (error) throw new PosServerError('storage_unavailable', 503)
    const rows = data ?? []
    const receipts = rows.map(row => fiscalDocumentSchema.parse(row.snapshot))
    const last = rows.length === 100 ? rows[rows.length - 1] : null
    return NextResponse.json({ status: 'ready', receipts, nextCursor: last ? encodeReceiptCursor({ issuedAt: last.issued_at, id: last.id }) : null, nextBefore: last?.issued_at ?? null }, { headers: privateHeaders })
  } catch (error) { return posFailure(error) }
}
