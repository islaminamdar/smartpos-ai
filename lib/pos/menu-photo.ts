import { z } from 'zod'

export const MENU_PHOTO_MAX_SOURCE_BYTES = 5 * 1024 * 1024
export const MENU_PHOTO_MAX_BYTES = 256 * 1024
export const MENU_PHOTO_MAX_PIXELS = 16_000_000
export const MENU_PHOTO_SOURCE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export const menuPhotoFilename = /^upload_([a-f0-9]{32})\.webp$/
export const menuPhotoUrl = (id: string) => `/pos-assets/menu/upload_${id.replaceAll('-', '')}.webp`
export const menuPhotoSchema = z
  .object({
    id: z
      .string()
      .uuid()
      .regex(/^[a-f0-9-]+$/),
    branchId: z.string().uuid(),
    imageUrl: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.number().int().min(1).max(1200),
    height: z.number().int().min(1).max(1200),
    byteLength: z.number().int().min(12).max(MENU_PHOTO_MAX_BYTES),
  })
  .strict()
  .refine((image) => image.imageUrl === menuPhotoUrl(image.id), 'Photo URL mismatch')
export const menuPhotoResultSchema = z
  .object({
    status: z.literal('ready'),
    image: menuPhotoSchema,
    replayed: z.boolean(),
  })
  .strict()
export type MenuPhotoResult = z.infer<typeof menuPhotoResultSchema>
