import sharp from 'sharp'
import { createHash } from 'node:crypto'
import {
  MENU_PHOTO_MAX_BYTES,
  MENU_PHOTO_MAX_PIXELS,
  MENU_PHOTO_MAX_SOURCE_BYTES,
} from '@/lib/pos/menu-photo'
import { PosServerError } from './client'

const invalid = () => new PosServerError('menu_photo_invalid', 422)
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** Check container identity before invoking a decoder. SVG/PDF and animation never enter it. */
function sourceFormat(bytes: Buffer): 'jpeg' | 'png' | 'webp' {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(pngSignature)) {
    let offset = 8
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) throw invalid()
      const length = bytes.readUInt32BE(offset)
      const type = bytes.toString('ascii', offset + 4, offset + 8)
      if (type === 'acTL') throw new PosServerError('menu_photo_animation', 422)
      offset += 12 + length
      if (offset > bytes.length) throw invalid()
      if (type === 'IEND') {
        if (length !== 0 || offset !== bytes.length) throw invalid()
        return 'png'
      }
    }
    throw invalid()
  }
  if (isWebp(bytes)) {
    let offset = 12
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) throw invalid()
      const type = bytes.toString('ascii', offset, offset + 4)
      const length = bytes.readUInt32LE(offset + 4)
      if (
        type === 'ANIM' ||
        type === 'ANMF' ||
        (type === 'VP8X' && length >= 1 && bytes[offset + 8] & 2)
      )
        throw new PosServerError('menu_photo_animation', 422)
      offset += 8 + length + (length % 2)
    }
    if (offset !== bytes.length) throw invalid()
    return 'webp'
  }
  throw invalid()
}
export function isWebp(bytes: Buffer) {
  return (
    bytes.length >= 20 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP' &&
    bytes.readUInt32LE(4) === bytes.length - 8
  )
}

export async function processMenuPhoto(bytes: Buffer, contentType: string) {
  if (!bytes.length || bytes.length > MENU_PHOTO_MAX_SOURCE_BYTES) throw invalid()
  const format = sourceFormat(bytes)
  if (contentType !== `image/${format}`) throw new PosServerError('menu_photo_type_mismatch', 415)
  try {
    const options = {
      limitInputPixels: MENU_PHOTO_MAX_PIXELS,
      failOn: 'warning' as const,
      sequentialRead: true,
    }
    const metadata = await sharp(bytes, options).metadata()
    if (
      metadata.format !== format ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > MENU_PHOTO_MAX_PIXELS ||
      (metadata.pages ?? 1) !== 1
    )
      throw invalid()
    // Deliberately do not call keepMetadata/withMetadata: EXIF, GPS, XMP and ICC are stripped.
    for (const [size, quality] of [
      [1200, 80],
      [1200, 65],
      [900, 65],
    ] as const) {
      const { data, info } = await sharp(bytes, options)
        .rotate()
        .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .webp({ quality, effort: 3 })
        .timeout({ seconds: 5 })
        .toBuffer({ resolveWithObject: true })
      if (data.length <= MENU_PHOTO_MAX_BYTES && isWebp(data))
        return {
          bytes: data,
          sha256: createHash('sha256').update(data).digest('hex'),
          width: info.width,
          height: info.height,
        }
    }
    throw new PosServerError('menu_photo_too_complex', 422)
  } catch (error) {
    if (error instanceof PosServerError) throw error
    throw invalid()
  }
}

let active = 0
/** Bound simultaneous decoder work per server worker, including in-flight upload bodies. */
export async function withMenuPhotoSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 2) throw new PosServerError('menu_photo_busy', 429)
  active++
  try {
    return await work()
  } finally {
    active--
  }
}
