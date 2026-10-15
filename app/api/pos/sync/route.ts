import { readBoundedBody } from '@/lib/pos/server/body'
import { NextRequest, NextResponse } from 'next/server'
import { authenticatedPosClient } from '@/lib/pos/server/client'
import { syncOrderSchema } from '@/lib/pos/server/contracts'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'

export const dynamic = 'force-dynamic'
export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get('origin')
    if (origin && origin !== new URL(request.url).origin) {
      return NextResponse.json({ code: 'origin_rejected' }, { status: 403, headers: privateHeaders })
    }
    const { client } = await authenticatedPosClient()
    const body = await readBoundedBody(request, 100_000)
    let raw: unknown
    try { raw = JSON.parse(body) } catch {
      return NextResponse.json({ code: 'invalid_json' }, { status: 400, headers: privateHeaders })
    }
    const parsed = syncOrderSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json({ code: 'invalid_order', fields: parsed.error.issues.map(issue => issue.path.join('.')) }, { status: 422, headers: privateHeaders })
    }
    const { data, error } = await client.rpc('pos_record_paid_order', { p_order: parsed.data.order })
    if (error) {
      const conflictCodes = ['POS_PRICE_CHANGED', 'POS_TOTAL_MISMATCH', 'POS_PAYMENT_MISMATCH', 'POS_IDEMPOTENCY_CONFLICT', 'POS_SHIFT_CLOSED']
      const authorizationCodes = ['POS_ACCESS_DENIED', 'POS_DEVICE_INVALID', 'POS_SHIFT_INVALID']
      const validationCodes = ['POS_INVALID_ORDER', 'POS_PRODUCT_UNAVAILABLE']
      const code = [...conflictCodes, ...authorizationCodes, ...validationCodes].find(item => error.message.includes(item))
      const status = code ? conflictCodes.includes(code) ? 409 : authorizationCodes.includes(code) ? 403 : 422 : 503
      return NextResponse.json({ status: 'pending', code: code ?? 'storage_unavailable' }, { status, headers: privateHeaders })
    }
    if (!data || data.status !== 'synced') throw new Error('Invalid synchronization acknowledgement')
    return NextResponse.json(data, { headers: privateHeaders })
  } catch (error) { return posFailure(error) }
}
