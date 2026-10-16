import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requireDevice, requireOrigin, requirePilot } from '@/lib/pos/server/live-access'
import { readBoundedBody } from '@/lib/pos/server/body'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import {
  returnRequestSchema,
  returnStateSchema,
  returnPreviewSchema,
} from '@/lib/pos/server/returns'

export const dynamic = 'force-dynamic'
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase())
const querySchema = z.object({ branchId: uuid, deviceId: uuid, orderId: uuid }).strict()
function rpcFailure(message: string): never {
  const forbidden = [
    'POS_ACCESS_DENIED',
    'POS_MANAGER_REQUIRED',
    'POS_DEVICE_INVALID',
    'POS_SHIFT_INVALID',
  ]
  const conflict = [
    'POS_RETURN_STALE',
    'POS_RETURN_QUANTITY',
    'POS_SHIFT_CLOSED',
    'POS_INSUFFICIENT_CASH',
  ]
  const invalid = [
    'POS_INVALID_RETURN',
    'POS_INVALID_COMMAND',
    'POS_INVALID_REQUEST',
    'POS_ORDER_UNAVAILABLE',
  ]
  const unavailable = ['POS_RETURN_UNAVAILABLE', 'POS_PROFILE_REQUIRED']
  const code = [...forbidden, ...conflict, ...invalid, ...unavailable].find((value) =>
    message.includes(value)
  )
  throw new PosServerError(
    code ?? 'storage_unavailable',
    !code || unavailable.includes(code)
      ? 503
      : forbidden.includes(code)
        ? 403
        : conflict.includes(code)
          ? 409
          : 422
  )
}
export async function GET(request: Request) {
  try {
    requirePilot()
    const { client, user } = await authenticatedPosClient()
    const params = new URL(request.url).searchParams
    const parsed = querySchema.safeParse(Object.fromEntries(params))
    if (!parsed.success || [...params.keys()].length !== new Set(params.keys()).size)
      throw new PosServerError('invalid_query', 422)
    const query = parsed.data
    const binding = await requireDevice(client, query.branchId, query.deviceId, user.id)
    const { data, error } = await client.rpc('pos_return_state', {
      p_branch: query.branchId,
      p_device: query.deviceId,
      p_order: query.orderId,
      p_binding: binding,
    })
    if (error) rpcFailure(error.message)
    const state = returnStateSchema.parse(data)
    if (state.invoice.branchId !== query.branchId || state.invoice.orderId !== query.orderId)
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json({ status: 'ready', state }, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
export async function POST(request: Request) {
  try {
    requirePilot(true)
    requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    const parsed = z
      .object({ request: returnRequestSchema })
      .strict()
      .safeParse(JSON.parse(await readBoundedBody(request, 32_768)))
    if (!parsed.success) throw new PosServerError('invalid_return_request', 422)
    const input = parsed.data.request
    const binding = await requireDevice(client, input.branchId, input.deviceId, user.id)
    const { data, error } = await client.rpc('pos_preview_return', {
      p_request: input,
      p_binding: binding,
    })
    if (error) rpcFailure(error.message)
    const preview = returnPreviewSchema.parse(data)
    for (const field of [
      'branchId',
      'deviceId',
      'shiftId',
      'orderId',
      'invoiceId',
      'expectedRevision',
      'reason',
    ] as const)
      if (preview[field] !== input[field]) throw new PosServerError('confirmation_mismatch', 503)
    if (
      preview.lines.length !== input.lines.length ||
      preview.lines.some(
        (line, index) =>
          line.originalLineNumber !== input.lines[index].lineNumber ||
          line.quantityMilli !== input.lines[index].quantityMilli
      )
    )
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json({ status: 'ready', preview }, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
