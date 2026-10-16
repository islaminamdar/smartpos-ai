import { createHash } from 'node:crypto'
import { z } from 'zod'
import { posClient } from '@/lib/pos/server/client'
import { MENU_PHOTO_MAX_BYTES, menuPhotoFilename } from '@/lib/pos/menu-photo'
import { isWebp } from '@/lib/pos/server/menu-photo-image'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const storedSchema = z
  .object({
    id: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    base64: z
      .string()
      .min(16)
      .max(Math.ceil(MENU_PHOTO_MAX_BYTES / 3) * 4),
    width: z.number().int().min(1).max(1200),
    height: z.number().int().min(1).max(1200),
    byteLength: z.number().int().min(20).max(MENU_PHOTO_MAX_BYTES),
  })
  .strict()
type Context = { params: Promise<{ filename: string }> }
async function serve(request: Request, context: Context, head: boolean) {
  const failure = (status: number) =>
    new Response(null, {
      status,
      headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    })
  try {
    const { filename } = await context.params
    const match = menuPhotoFilename.exec(filename)
    if (!match || new URL(request.url).search) return failure(404)
    const h = match[1]
    const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
    const { data, error } = await posClient(undefined, true).rpc('pos_menu_media_read', {
      p_id: id,
    })
    if (error) return failure(503)
    if (data === null) return failure(404)
    const parsed = storedSchema.safeParse(data)
    if (!parsed.success || parsed.data.id !== id) return failure(503)
    const stored = parsed.data
    const bytes = Buffer.from(stored.base64, 'base64')
    if (
      bytes.length !== stored.byteLength ||
      bytes.toString('base64') !== stored.base64 ||
      !isWebp(bytes) ||
      createHash('sha256').update(bytes).digest('hex') !== stored.sha256
    )
      return failure(503)
    const headers = {
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `inline; filename="${filename}"`,
      ETag: `"${stored.sha256}"`,
    }
    if (request.headers.get('if-none-match') === headers.ETag)
      return new Response(null, { status: 304, headers })
    return new Response(head ? null : new Uint8Array(bytes), {
      headers: { ...headers, 'Content-Length': String(bytes.length) },
    })
  } catch {
    return failure(503)
  }
}
export async function GET(request: Request, context: Context) {
  return serve(request, context, false)
}
export async function HEAD(request: Request, context: Context) {
  return serve(request, context, true)
}
