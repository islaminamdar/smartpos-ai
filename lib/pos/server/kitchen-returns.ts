import { z } from 'zod'
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase())
const time = z.string().datetime({ offset: true })
export const kitchenReturnCursorSchema = z.object({ issuedAt: time, id: uuid }).strict()
export const kitchenReturnNoticeSchema = z
  .object({
    id: uuid,
    branchId: uuid,
    orderId: uuid,
    invoiceId: uuid,
    invoiceNumber: z.string().min(1).max(80),
    creditNumber: z.string().min(1).max(80),
    issuedAt: time,
    reason: z.string().min(1).max(240),
    fullyReturned: z.boolean(),
    lines: z
      .array(
        z
          .object({
            originalLineNumber: z.number().int().min(1).max(200),
            productId: uuid,
            name: z.string().min(1).max(240),
            unit: z.enum(['piece', 'pack', 'kg']),
            quantityMilli: z.number().int().min(1).max(1_000_000),
            remainingQuantityMilli: z.number().int().min(0).max(1_000_000),
          })
          .strict()
      )
      .min(1)
      .max(200),
  })
  .strict()
  .superRefine((notice, ctx) => {
    if (
      notice.lines.some(
        (l, i) =>
          (i > 0 && l.originalLineNumber <= notice.lines[i - 1].originalLineNumber) ||
          (l.unit !== 'kg' &&
            (l.quantityMilli % 1000 !== 0 || l.remainingQuantityMilli % 1000 !== 0)) ||
          (notice.fullyReturned && l.remainingQuantityMilli !== 0)
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid returned quantities.' })
  })
export const kitchenReturnListSchema = z
  .object({
    status: z.literal('ready'),
    branchId: uuid,
    pendingCount: z.number().int().min(0).max(50000),
    notices: z.array(kitchenReturnNoticeSchema).max(50),
    nextCursor: kitchenReturnCursorSchema.nullable(),
  })
  .strict()
  .superRefine((list, ctx) => {
    if (
      list.pendingCount < list.notices.length ||
      list.notices.some((n) => n.branchId !== list.branchId) ||
      new Set(list.notices.map((n) => n.id)).size !== list.notices.length ||
      (list.nextCursor &&
        (list.notices.at(-1)?.id !== list.nextCursor.id ||
          Date.parse(list.notices.at(-1)!.issuedAt) !== Date.parse(list.nextCursor.issuedAt)))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid notice page.' })
  })
export const kitchenReturnQuerySchema = z
  .object({
    branchId: uuid,
    deviceId: uuid,
    afterIssuedAt: time.optional(),
    afterId: uuid.optional(),
  })
  .strict()
  .refine((q) => !!q.afterIssuedAt === !!q.afterId)
export const kitchenReturnAckSchema = z
  .object({ branchId: uuid, deviceId: uuid, noticeId: uuid })
  .strict()
export const kitchenReturnAckResultSchema = z
  .object({
    status: z.literal('acknowledged'),
    branchId: uuid,
    noticeId: uuid,
    replayed: z.boolean(),
  })
  .strict()
export type KitchenReturnList = z.infer<typeof kitchenReturnListSchema>
