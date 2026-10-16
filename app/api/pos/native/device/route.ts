import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticatedPosClient, deviceCookie, PosServerError } from '@/lib/pos/server/client'
import { hashToken, requireOrigin, requirePilot } from '@/lib/pos/server/live-access'
import { nativeAccess, nativeDeviceSchema } from '@/lib/pos/server/native-access'
import { readBoundedBody } from '@/lib/pos/server/body'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
export const dynamic = 'force-dynamic'
/** Native persists its random binding cookie BEFORE sending. SQL locks/replays that same
 * actor-owned binding, so losing the response never requires allocating a fresh counter. */
export async function POST(request: Request) {
  try {
    requirePilot(); requireOrigin(request)
    const input = z.object({ branchId: z.string().uuid(), name: z.string().trim().min(1).max(80) }).strict().parse(JSON.parse(await readBoundedBody(request,1024)))
    const access = await nativeAccess()
    const branch = access.branches.find(b => b.id === input.branchId)
    if (!branch || !['owner','manager'].includes(branch.role)) throw new PosServerError('access_denied',403)
    const { client,user } = await authenticatedPosClient()
    if (user.id !== access.actorId) throw new PosServerError('access_denied',403)
    const token = (await cookies()).get(deviceCookie(user.id))?.value
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new PosServerError('native_binding_required',422)
    const result = await client.rpc('pos_enroll_device',{p_branch:input.branchId,p_name:input.name,p_binding:hashToken(token)})
    if(result.error) throw new PosServerError(result.error.message.includes('POS_DEVICE_ALREADY_BOUND')?'device_already_bound':result.error.message.includes('POS_ACCESS_DENIED')?'access_denied':'storage_unavailable',result.error.message.includes('POS_DEVICE_ALREADY_BOUND')?409:result.error.message.includes('POS_ACCESS_DENIED')?403:503)
    const device = nativeDeviceSchema.parse(result.data)
    if(device.branchId!==input.branchId) throw new PosServerError('device_already_bound',409)
    return NextResponse.json({status:'enrolled',device},{headers:privateHeaders})
  } catch(error) { return posFailure(error) }
}
