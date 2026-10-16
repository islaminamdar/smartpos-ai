import { readBoundedBody } from '@/lib/pos/server/body'
import { NextRequest, NextResponse } from 'next/server'
import { authenticatedPosClient } from '@/lib/pos/server/client'
import { liveOrderSchema } from '@/lib/pos/server/live-contracts'
import { fiscalDocumentSchema } from '@/lib/pos/server/documents'
import { invoiceMatchesSale } from '@/lib/pos/server/sale-ack'
import { requirePilot, requireOrigin, requireDevice } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'

export const dynamic = 'force-dynamic'
export async function POST(request: NextRequest) {
  try {
    requirePilot(true)
    requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    const body = await readBoundedBody(request, 100_000)
    let raw: unknown
    try {
      raw = JSON.parse(body)
    } catch {
      return NextResponse.json({ code: 'invalid_json' }, { status: 400, headers: privateHeaders })
    }
    const parsed = liveOrderSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { code: 'invalid_order', fields: parsed.error.issues.map((issue) => issue.path.join('.')) },
        { status: 422, headers: privateHeaders }
      )
    }
    const binding = await requireDevice(
      client,
      parsed.data.order.branchId,
      parsed.data.order.deviceId,
      user.id
    )
    const { data, error } = await client.rpc('pos_record_live_order', {
      p_order: parsed.data.order,
      p_binding: binding,
    })
    if (error) {
      const conflictCodes = [
        'POS_PRICE_CHANGED',
        'POS_TOTAL_MISMATCH',
        'POS_PAYMENT_MISMATCH',
        'POS_IDEMPOTENCY_CONFLICT',
        'POS_REQUEST_CANCELLED',
        'POS_SHIFT_CLOSED',
        'POS_PROFILE_CHANGED',
        'POS_LIVE_CONTRACT_REQUIRED',
        'POS_LEGACY_RECEIPT_UNAVAILABLE',
        'POS_OFFER_CHANGED',
        'POS_OFFER_UNAVAILABLE',
        'POS_OFFER_LIMIT_REACHED',
        'POS_DISCOUNT_MISMATCH',
      ]
      const authorizationCodes = ['POS_ACCESS_DENIED', 'POS_DEVICE_INVALID', 'POS_SHIFT_INVALID']
      const validationCodes = [
        'POS_INVALID_ORDER',
        'POS_PRODUCT_UNAVAILABLE',
        'POS_FULL_INVOICE_REQUIRED',
        'POS_INVALID_CUSTOMER',
        'POS_INSUFFICIENT_CASH',
        'POS_OFFER_INELIGIBLE',
        'POS_INVALID_OFFER',
        'POS_OFFER_CUSTOMER_UNSUPPORTED',
      ]
      const code = [...conflictCodes, ...authorizationCodes, ...validationCodes].find((item) =>
        error.message.includes(item)
      )
      const status = code
        ? conflictCodes.includes(code)
          ? 409
          : authorizationCodes.includes(code)
            ? 403
            : 422
        : 503
      return NextResponse.json(
        { status: 'pending', code: code ?? 'storage_unavailable' },
        { status, headers: privateHeaders }
      )
    }
    const receipt = fiscalDocumentSchema.safeParse(data?.receipt)
    if (
      !data ||
      data.status !== 'synced' ||
      data.orderId !== parsed.data.order.id.toLowerCase() ||
      !receipt.success ||
      receipt.data.actorId.toLowerCase() !== user.id.toLowerCase() ||
      !invoiceMatchesSale(parsed.data.order, receipt.data)
    )
      throw new Error('Invalid synchronization acknowledgement')
    return NextResponse.json(data, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
