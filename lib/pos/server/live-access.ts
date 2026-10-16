import { createHash } from 'node:crypto'
import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deviceCookie, PosServerError } from './client'
import { liveDeviceSchema } from './live-contracts'
export function requirePilot(financial = false) {
  if (process.env.POS_ONLINE_PILOT !== 'true')
    throw new PosServerError('live_sales_not_enabled', 503)
  if (financial && process.env.POS_LIVE_SALES_ENABLED !== 'true')
    throw new PosServerError('live_sales_not_enabled', 503)
}
export function requireOrigin(request: Request) {
  const origin = request.headers.get('origin')
  if (
    !origin ||
    origin !== (process.env.POS_PUBLIC_ORIGIN || new URL(request.url).origin) ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    throw new PosServerError('origin_rejected', 403)
}
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
/** Recovery only: SQL verifies the historical binding and original actor/request.
 * This does not authorize a device to sell or to perform any other mutation. */
export async function recoveryBinding(userId: string) {
  const token = (await cookies()).get(deviceCookie(userId))?.value
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new PosServerError('device_binding_required', 403)
  return hashToken(token)
}
export async function boundDevice(client: SupabaseClient, userId: string) {
  const token = (await cookies()).get(deviceCookie(userId))?.value
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null
  const hash = hashToken(token)
  const { data, error } = await client.rpc('pos_bound_device', { p_binding: hash })
  if (error) throw new PosServerError('storage_unavailable', 503)
  if (!data) return null
  const parsed = liveDeviceSchema.safeParse(data)
  if (!parsed.success) throw new PosServerError('storage_unavailable', 503)
  return { device: parsed.data, hash }
}
export async function requireDevice(
  client: SupabaseClient,
  branchId: string,
  deviceId: string,
  userId: string
) {
  const binding = await boundDevice(client, userId)
  if (!binding || binding.device.id !== deviceId || binding.device.branchId !== branchId)
    throw new PosServerError('device_binding_required', 403)
  return binding.hash
}
