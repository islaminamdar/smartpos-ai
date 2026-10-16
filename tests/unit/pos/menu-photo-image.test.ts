// @vitest-environment node
import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { processMenuPhoto, withMenuPhotoSlot } from '@/lib/pos/server/menu-photo-image'
import { readBoundedBytes, PosBodyReadTimeout, PosPayloadTooLarge } from '@/lib/pos/server/body'
import { createHash } from 'node:crypto'

const picture = () =>
  sharp({ create: { width: 1800, height: 1200, channels: 3, background: '#bd702c' } })
describe('real menu photo processing', () => {
  it.each(['jpeg', 'png', 'webp'] as const)(
    'decodes %s into bounded metadata-free immutable WebP',
    async (format) => {
      const input = await picture()
        .withExif({ IFD0: { Copyright: 'Synthetic private metadata', Orientation: '6' } })
        .toFormat(format)
        .toBuffer()
      const result = await processMenuPhoto(input, `image/${format}`)
      const info = await sharp(result.bytes).metadata()
      expect(info.format).toBe('webp')
      expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(1200)
      expect(info.exif).toBeUndefined()
      expect(info.icc).toBeUndefined()
      expect(info.xmp).toBeUndefined()
      expect(info.orientation).toBeUndefined()
      expect(result.bytes.length).toBeLessThanOrEqual(262144)
      expect(result.sha256).toBe(createHash('sha256').update(result.bytes).digest('hex'))
      const repeat = await processMenuPhoto(input, `image/${format}`)
      expect(repeat.bytes.equals(result.bytes)).toBe(true)
    }
  )
  it('rejects SVG, GIF, raw HTML and corrupted images without accepting a forged content type', async () => {
    for (const bytes of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from('GIF89a'),
      Buffer.from('<script>alert(1)</script>'),
      Buffer.from([255, 216, 255, 0, 0]),
    ]) {
      await expect(processMenuPhoto(bytes, 'image/jpeg')).rejects.toMatchObject({
        code: 'menu_photo_invalid',
      })
    }
    await expect(
      processMenuPhoto(await picture().png().toBuffer(), 'image/jpeg')
    ).rejects.toMatchObject({ code: 'menu_photo_type_mismatch' })
  })
  it('rejects excessive pixels, truncated containers and trailing WebP bytes', async () => {
    const oversized = await sharp({
      create: { width: 4001, height: 4000, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer()
    await expect(processMenuPhoto(oversized, 'image/png')).rejects.toMatchObject({
      code: 'menu_photo_invalid',
    })
    const png = await picture().png().toBuffer()
    await expect(processMenuPhoto(png.subarray(0, png.length - 2), 'image/png')).rejects.toThrow()
    const webp = await picture().webp().toBuffer()
    await expect(
      processMenuPhoto(Buffer.concat([webp, Buffer.from('payload')]), 'image/webp')
    ).rejects.toThrow()
  })
  it('rejects real animated WebP and PNG animation control chunks', async () => {
    const pixels = Buffer.alloc(20 * 40 * 3)
    for (let i = 0; i < 20 * 40; i++) pixels[i * 3 + (i < 400 ? 0 : 2)] = 255
    const animated = await sharp(pixels, {
      raw: { width: 20, height: 40, pageHeight: 20, channels: 3 },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer()
    expect((await sharp(animated).metadata()).pages).toBe(2)
    await expect(processMenuPhoto(animated, 'image/webp')).rejects.toMatchObject({
      code: 'menu_photo_animation',
    })
    const png = await picture().png().toBuffer()
    const chunk = Buffer.alloc(20)
    chunk.writeUInt32BE(8)
    chunk.write('acTL', 4)
    await expect(
      processMenuPhoto(Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]), 'image/png')
    ).rejects.toMatchObject({ code: 'menu_photo_animation' })
  })
  it('bounds decoder concurrency and releases slots on failure', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const a = withMenuPhotoSlot(() => gate),
      b = withMenuPhotoSlot(() => gate)
    await expect(withMenuPhotoSlot(async () => true)).rejects.toMatchObject({
      code: 'menu_photo_busy',
    })
    release()
    await Promise.all([a, b])
    await expect(
      withMenuPhotoSlot(async () => {
        throw new Error('decoder')
      })
    ).rejects.toThrow('decoder')
    expect(await withMenuPhotoSlot(async () => true)).toBe(true)
  })
})
describe('bounded binary upload reading', () => {
  it('preserves binary bytes and rejects declared and streaming oversize bodies', async () => {
    const data = new Uint8Array([255, 0, 128, 200])
    expect(
      await readBoundedBytes(new Request('http://localhost', { method: 'POST', body: data }), 4)
    ).toEqual(data)
    await expect(
      readBoundedBytes(
        new Request('http://localhost', {
          method: 'POST',
          body: data,
          headers: { 'Content-Length': '9' },
        }),
        4
      )
    ).rejects.toBeInstanceOf(PosPayloadTooLarge)
    let cancelled = false
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(data)
        c.enqueue(data)
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(
      readBoundedBytes(
        new Request('http://localhost', {
          method: 'POST',
          body: stream,
          duplex: 'half',
        } as RequestInit),
        4
      )
    ).rejects.toBeInstanceOf(PosPayloadTooLarge)
    expect(cancelled).toBe(true)
  })
  it('cancels a stalled body and frees its reader at the deadline', async () => {
    let cancelled = false
    const stream = new ReadableStream({
      cancel() {
        cancelled = true
      },
    })
    await expect(
      readBoundedBytes(
        new Request('http://localhost', {
          method: 'POST',
          body: stream,
          duplex: 'half',
        } as RequestInit),
        4,
        15
      )
    ).rejects.toBeInstanceOf(PosBodyReadTimeout)
    expect(cancelled).toBe(true)
    expect(stream.locked).toBe(false)
  })
  it('does not await an uncooperative cancellation after detecting oversized data', async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(8))
      },
      cancel() {
        return new Promise(() => {})
      },
    })
    await expect(
      readBoundedBytes(
        new Request('http://localhost', {
          method: 'POST',
          body: stream,
          duplex: 'half',
        } as RequestInit),
        4,
        15
      )
    ).rejects.toBeInstanceOf(PosPayloadTooLarge)
    expect(stream.locked).toBe(false)
  })
})
