import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requirePilot, requireOrigin, recoveryBinding } from '@/lib/pos/server/live-access'
import { readBoundedBody } from '@/lib/pos/server/body'
import { liveRecoverySchema } from '@/lib/pos/server/live-contracts'
import { fiscalDocumentSchema } from '@/lib/pos/server/documents'
import { invoiceMatchesSale } from '@/lib/pos/server/sale-ack'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requirePilot()
    requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    const parsed = liveRecoverySchema.safeParse(JSON.parse(await readBoundedBody(request, 100_000)))
    if (!parsed.success) throw new PosServerError('invalid_recovery_request', 422)
    const payload = parsed.data.request
    const binding = await recoveryBinding(user.id)
    const args = {
      p_kind: parsed.data.kind,
      p_request: payload,
      p_binding: binding,
    }
    let { data, error } = await client.rpc('pos_resolve_live_request', args)
    let committedOnly = false
    if (error?.message.includes('POS_ACCESS_DENIED')) {
      committedOnly = true
      const result = await client.rpc('pos_lookup_own_committed_request', args)
      data = result.data
      error = result.error
    }
    if (error) {
      const conflict = error.message.includes('POS_IDEMPOTENCY_CONFLICT')
      const inactive = error.message.includes('POS_STAFF_INACTIVE')
      const denied = ['POS_ACCESS_DENIED', 'POS_DEVICE_INVALID'].some((code) =>
        error.message.includes(code)
      )
      throw new PosServerError(
        conflict
          ? 'POS_IDEMPOTENCY_CONFLICT'
          : inactive
            ? 'staff_inactive'
            : denied
              ? 'device_binding_required'
              : 'recovery_unavailable',
        conflict ? 409 : denied || inactive ? 403 : 503
      )
    }
    const cancelled =
      !committedOnly &&
      data?.status === 'cancelled' &&
      data.requestId === payload.id &&
      data.kind === parsed.data.kind
    const invoice = fiscalDocumentSchema.safeParse(data?.receipt)
    const sale =
      parsed.data.kind === 'sale' &&
      data?.status === 'synced' &&
      data.orderId === payload.id.toLowerCase() &&
      invoice.success &&
      invoice.data.actorId.toLowerCase() === user.id.toLowerCase() &&
      invoiceMatchesSale(parsed.data.request, invoice.data)
    const credit = fiscalDocumentSchema.safeParse(data?.creditNote)
    const command =
      parsed.data.kind === 'command' &&
      data?.status === 'applied' &&
      data.commandId === payload.id &&
      (parsed.data.request.type !== 'refund.full' ||
        (credit.success &&
          credit.data.kind === 'tax_credit_note' &&
          credit.data.orderId === parsed.data.request.orderId &&
          credit.data.actorId === user.id &&
          credit.data.branchId === payload.branchId &&
          credit.data.deviceId === payload.deviceId))
    if (!cancelled && !sale && !command)
      throw new PosServerError('invalid_recovery_acknowledgement', 503)
    return NextResponse.json(data, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
