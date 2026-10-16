import { z } from 'zod'

export const catalogueProductSchema = z
  .object({
    id: z.string().uuid(),
    branchId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    category: z.string().trim().min(1).max(120),
    imageUrl: z
      .string()
      .regex(/^\/pos-assets\/menu\/[A-Za-z0-9_-]+\.webp$/)
      .nullable(),
    unit: z.enum(['piece', 'pack', 'kg']),
    unitPriceFils: z.number().int().min(0).max(100_000_000),
    taxRateBps: z.literal(500),
    active: z.boolean(),
    revision: z.number().int().min(1).max(2_147_483_647),
  })
  .strict()
export type CatalogueProduct = z.infer<typeof catalogueProductSchema>
export const catalogueUpdateSchema = z
  .object({
    id: z.string().uuid(),
    branchId: z.string().uuid(),
    deviceId: z.string().uuid(),
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    reason: z.string().trim().min(1).max(240),
    product: catalogueProductSchema.omit({ branchId: true, revision: true }).strict(),
  })
  .strict()
  .refine((v) => !v.product.active || v.product.unitPriceFils > 0, {
    message: 'Available items need a positive price.',
  })
export type CatalogueUpdate = z.infer<typeof catalogueUpdateSchema>
export const catalogueResultSchema = z.object({
  status: z.literal('updated'),
  requestId: z.string().uuid(),
  replayed: z.boolean(),
  product: catalogueProductSchema,
})
