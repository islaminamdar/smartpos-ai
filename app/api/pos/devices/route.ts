import { randomBytes } from 'node:crypto'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticatedPosClient, cookieOptions, deviceCookie, PosServerError } from '@/lib/pos/server/client'
import { boundDevice, hashToken, requireOrigin, requirePilot } from '@/lib/pos/server/live-access'
import { readBoundedBody } from '@/lib/pos/server/body'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { liveDeviceSchema } from '@/lib/pos/server/live-contracts'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requirePilot(); requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    const parsed = z.object({ branchId: z.string().uuid(), name: z.string().trim().min(1).max(80) }).strict().safeParse(JSON.parse(await readBoundedBody(request, 1024)))
    if (!parsed.success) return NextResponse.json({ code: 'invalid_device' }, { status: 422, headers: privateHeaders })
    const existing = await boundDevice(client, user.id)
    if (existing) {
      if (existing.device.branchId !== parsed.data.branchId) throw new PosServerError('device_already_bound', 409)
      return NextResponse.json({ status: 'enrolled', device: existing.device }, { headers: privateHeaders })
    }
    const token = randomBytes(32).toString('hex')
    const { data, error } = await client.rpc('pos_enroll_device', { p_branch: parsed.data.branchId, p_name: parsed.data.name, p_binding: hashToken(token) })
    if (error) throw new PosServerError(error.message.includes('POS_ACCESS_DENIED') ? 'access_denied' : 'storage_unavailable', error.message.includes('POS_ACCESS_DENIED') ? 403 : 503)
    const device = liveDeviceSchema.parse(data)
    ;(await cookies()).set(deviceCookie(user.id), token, { ...cookieOptions, maxAge: 60 * 60 * 24 * 365 })
    return NextResponse.json({ status: 'enrolled', device }, { headers: privateHeaders })
  } catch (error) { return posFailure(error) }
}
