import { readBoundedBody } from '@/lib/pos/server/body'
import { NextRequest, NextResponse } from 'next/server'
import { authenticatedPosClient } from '@/lib/pos/server/client'
import { liveCommandSchema } from '@/lib/pos/server/live-contracts'
import { fiscalDocumentSchema } from '@/lib/pos/server/documents'
import { requirePilot, requireOrigin, requireDevice } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
export const dynamic = 'force-dynamic'
export async function POST(request: NextRequest) {
  try {
    requirePilot(true); requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    const body = await readBoundedBody(request, 10_000)
    let raw: unknown
    try { raw = JSON.parse(body) } catch { return NextResponse.json({ code: 'invalid_json' }, { status: 400, headers: privateHeaders }) }
    const parsed = liveCommandSchema.safeParse(raw)
    if (!parsed.success) return NextResponse.json({ code: 'invalid_command' }, { status: 422, headers: privateHeaders })
    const binding = await requireDevice(client, parsed.data.command.branchId, parsed.data.command.deviceId, user.id)
    const { data, error } = await client.rpc('pos_execute_live_command', { p_command: parsed.data.command, p_binding: binding })
    if (error) {
      const forbidden = ['POS_ACCESS_DENIED','POS_MANAGER_REQUIRED','POS_ADMIN_REQUIRED','POS_DEVICE_INVALID','POS_SHIFT_INVALID']
      const conflicts = ['POS_IDEMPOTENCY_CONFLICT', 'POS_REQUEST_CANCELLED','POS_SHIFT_ALREADY_OPEN','POS_SHIFT_CLOSED','POS_REFUND_LIMIT','POS_PRIOR_REFUND_EXISTS','POS_INSUFFICIENT_CASH','POS_LIVE_CONTRACT_REQUIRED']
      const invalid = ['POS_INVALID_COMMAND','POS_ORDER_UNAVAILABLE']
      const code = [...forbidden,...conflicts,...invalid].find(value => error.message.includes(value))
      return NextResponse.json({ status: 'pending', code: code ?? 'storage_unavailable' }, { status: !code ? 503 : forbidden.includes(code) ? 403 : conflicts.includes(code) ? 409 : 422, headers: privateHeaders })
    }
    if (!data || data.status !== 'applied' || data.commandId !== parsed.data.command.id || (parsed.data.command.type === 'refund.full' && !fiscalDocumentSchema.safeParse(data.creditNote).success)) throw new Error('Missing command acknowledgement')
    return NextResponse.json(data, { headers: privateHeaders })
  } catch (error) { return posFailure(error) }
}
