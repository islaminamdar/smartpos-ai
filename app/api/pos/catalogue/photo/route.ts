import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticatedPosClient, posClient, PosServerError } from '@/lib/pos/server/client'
import { requireDevice, requireOrigin, requirePilot } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { readBoundedBytes } from '@/lib/pos/server/body'
import { processMenuPhoto, withMenuPhotoSlot } from '@/lib/pos/server/menu-photo-image'
import {
  MENU_PHOTO_MAX_SOURCE_BYTES,
  MENU_PHOTO_SOURCE_TYPES,
  menuPhotoResultSchema,
} from '@/lib/pos/menu-photo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const scopeSchema = z.object({ branchId: z.string().uuid(), deviceId: z.string().uuid() }).strict()
const contextSchema = z
  .object({
    organizationId: z.string().uuid(),
    branchId: z.string().uuid(),
    deviceId: z.string().uuid(),
    actorId: z.string().uuid(),
  })
  .strict()
function databaseFailure(message: string): never {
  if (/POS_(ACCESS_DENIED|DEVICE_INVALID|MANAGER_REQUIRED)/.test(message))
    throw new PosServerError('manager_access_required', 403)
  if (/POS_MEDIA_RATE_LIMIT/.test(message)) throw new PosServerError('menu_photo_rate_limit', 429)
  if (/POS_MEDIA_(CAPACITY|DAILY_LIMIT)/.test(message))
    throw new PosServerError('menu_photo_quota', 409)
  if (/POS_(MEDIA_INVALID|INVALID_COMMAND)/.test(message))
    throw new PosServerError('menu_photo_invalid', 422)
  throw new PosServerError('storage_unavailable', 503)
}
export async function POST(request: Request) {
  try {
    requirePilot()
    requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    const params = new URL(request.url).searchParams
    if ([...params.keys()].length !== 2) throw new PosServerError('invalid_query', 422)
    const parsed = scopeSchema.safeParse(Object.fromEntries(params))
    if (!parsed.success) throw new PosServerError('invalid_query', 422)
    const type = request.headers.get('content-type') || ''
    if (!(MENU_PHOTO_SOURCE_TYPES as readonly string[]).includes(type))
      throw new PosServerError('menu_photo_type', 415)
    const binding = await requireDevice(client, parsed.data.branchId, parsed.data.deviceId, user.id)
    const admin = posClient(undefined, true)
    const args = {
      p_actor: user.id,
      p_branch: parsed.data.branchId,
      p_device: parsed.data.deviceId,
      p_binding: binding,
    }
    // Both admission and final register independently lock/recheck current authority in SQL.
    const admission = await admin.rpc('pos_menu_media_context', args)
    if (admission.error) databaseFailure(admission.error.message)
    const context = contextSchema.safeParse(admission.data)
    if (
      !context.success ||
      context.data.actorId !== user.id ||
      context.data.branchId !== parsed.data.branchId ||
      context.data.deviceId !== parsed.data.deviceId
    )
      throw new PosServerError('confirmation_mismatch', 503)
    return await withMenuPhotoSlot(async () => {
      const source = await readBoundedBytes(request, MENU_PHOTO_MAX_SOURCE_BYTES, 10000)
      const processed = await processMenuPhoto(Buffer.from(source), type)
      const saved = await admin.rpc('pos_menu_media_register', {
        ...args,
        p_media: {
          id: randomUUID(),
          sha256: processed.sha256,
          base64: processed.bytes.toString('base64'),
          width: processed.width,
          height: processed.height,
          byteLength: processed.bytes.length,
        },
      })
      if (saved.error) databaseFailure(saved.error.message)
      const result = menuPhotoResultSchema.safeParse(saved.data)
      if (
        !result.success ||
        result.data.image.branchId !== parsed.data.branchId ||
        result.data.image.sha256 !== processed.sha256 ||
        result.data.image.width !== processed.width ||
        result.data.image.height !== processed.height ||
        result.data.image.byteLength !== processed.bytes.length
      )
        throw new PosServerError('confirmation_mismatch', 503)
      return NextResponse.json(result.data, { headers: privateHeaders })
    })
  } catch (error) {
    return posFailure(error)
  }
}
