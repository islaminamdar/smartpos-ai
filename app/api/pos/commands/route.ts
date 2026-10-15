import { readBoundedBody } from '@/lib/pos/server/body'
import { NextRequest, NextResponse } from 'next/server'
import { authenticatedPosClient } from '@/lib/pos/server/client'
import { posCommandSchema } from '@/lib/pos/server/commands'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
export const dynamic = 'force-dynamic'
export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get('origin')
    if (origin && origin !== new URL(request.url).origin) return NextResponse.json({ code: 'origin_rejected' }, { status: 403, headers: privateHeaders })
    const { client } = await authenticatedPosClient()
    const body = await readBoundedBody(request, 10_000)
    let raw: unknown
    try { raw = JSON.parse(body) } catch { return NextResponse.json({ code: 'invalid_json' }, { status: 400, headers: privateHeaders }) }
    const parsed = posCommandSchema.safeParse(raw)
    if (!parsed.success) return NextResponse.json({ code: 'invalid_command' }, { status: 422, headers: privateHeaders })
    const { data, error } = await client.rpc('pos_execute_command', { p_command: parsed.data.command })
    if (error) {
      const forbidden = ['POS_ACCESS_DENIED','POS_MANAGER_REQUIRED','POS_ADMIN_REQUIRED','POS_DEVICE_INVALID','POS_SHIFT_INVALID']
      const conflicts = ['POS_IDEMPOTENCY_CONFLICT','POS_SHIFT_ALREADY_OPEN','POS_SHIFT_CLOSED','POS_REFUND_LIMIT']
      const invalid = ['POS_INVALID_COMMAND','POS_ORDER_UNAVAILABLE']
      const code = [...forbidden,...conflicts,...invalid].find(value => error.message.includes(value))
      return NextResponse.json({ status: 'pending', code: code ?? 'storage_unavailable' }, { status: !code ? 503 : forbidden.includes(code) ? 403 : conflicts.includes(code) ? 409 : 422, headers: privateHeaders })
    }
    if (!data || data.status !== 'applied') throw new Error('Missing command acknowledgement')
    return NextResponse.json(data, { headers: privateHeaders })
  } catch (error) { return posFailure(error) }
}
