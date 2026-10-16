import { z } from 'zod'
import { syncOrderSchema } from './contracts'
import { merchantProfileSchema, receiptCustomerSchema } from './documents'
import { offerSelectionSchema } from './offers'

export const liveOrderSchema = z
  .object({
    order: syncOrderSchema.shape.order
      .extend({
        lines: z
          .array(
            syncOrderSchema.shape.order.shape.lines.element
              .extend({ expectedRevision: z.number().int().min(1).max(2_147_483_647).optional() })
              .strict()
          )
          .min(1)
          .max(200),
        offerSelection: offerSelectionSchema.optional(),
        sourceTab: z
          .object({
            id: z
              .string()
              .uuid()
              .transform((value) => value.toLowerCase()),
            expectedRevision: z.number().int().min(1).max(2_147_483_646),
          })
          .strict()
          .optional(),
        profileId: z.string().uuid(),
        customer: receiptCustomerSchema.nullable(),
        cashTenderedFils: z.number().int().min(0).max(100_000_000),
        payments: z
          .array(
            z
              .object({
                method: z.enum(['cash', 'card']),
                amountFils: z.number().int().positive().max(100_000_000),
              })
              .strict()
          )
          .min(1)
          .max(2),
      })
      .strict()
      .superRefine((order, ctx) => {
        if (
          (order.offerSelection || order.sourceTab) &&
          (order.lines.some((line) => line.expectedRevision === undefined) ||
            new Set(order.lines.map((line) => line.productId.toLowerCase())).size !==
              order.lines.length)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Offer and saved-order sales require current unique menu lines.',
          })
        }
        if (order.sourceTab?.id === order.id.toLowerCase())
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'A payment request needs its own reference.',
          })
      }),
  })
  .strict()
// New online submissions only. Keep the historical/recovery schema above unchanged.
export const newLiveOrderSchema = liveOrderSchema.superRefine(({ order }, ctx) => {
  for (const field of ['name', 'address', 'trn'] as const) {
    if (order.customer?.[field]?.includes('\u0000'))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['order', 'customer', field],
        message: 'Remove the unsupported hidden character or retype this customer field.',
      })
  }
})
const uuid = z.string().uuid()
const device = { id: uuid, branchId: uuid, deviceId: uuid, shiftId: uuid }
const fils = z.number().int().min(0).max(100_000_000)
export const liveCommandSchema = z
  .object({
    command: z.discriminatedUnion('type', [
      z.object({ ...device, type: z.literal('shift.open'), openingCashFils: fils }).strict(),
      z.object({ ...device, type: z.literal('shift.close'), countedCashFils: fils }).strict(),
      z
        .object({
          ...device,
          type: z.literal('cash.move'),
          amountFils: z
            .number()
            .int()
            .min(-100_000_000)
            .max(100_000_000)
            .refine((n) => n !== 0),
          reason: z.string().trim().min(1).max(240),
        })
        .strict(),
      z
        .object({
          ...device,
          type: z.literal('refund.full'),
          orderId: uuid,
          reason: z.string().trim().min(1).max(240),
        })
        .strict(),
    ]),
  })
  .strict()
export const liveDeviceSchema = z.object({ id: uuid, branchId: uuid, name: z.string() })
export const liveBootstrapSchema = z.object({
  status: z.literal('ready'),
  userId: uuid,
  branches: z.array(
    z.object({
      id: uuid,
      organizationId: uuid,
      name: z.string(),
      role: z.enum(['owner', 'manager', 'cashier']),
      canSell: z.boolean(),
      canRefund: z.boolean(),
      canManageCash: z.boolean(),
      profile: merchantProfileSchema.nullable(),
    })
  ),
  catalogue: z.array(
    z.object({
      id: uuid,
      branchId: uuid,
      name: z.string(),
      category: z.string(),
      imageUrl: z.string().nullable(),
      unit: z.enum(['piece', 'pack', 'kg']),
      unitPriceFils: fils,
      taxRateBps: z.number().int(),
      revision: z.number().int().positive().default(1),
    })
  ),
  device: liveDeviceSchema.nullable(),
  shifts: z.array(
    z.object({
      id: uuid,
      branchId: uuid,
      deviceId: uuid,
      openedBy: uuid,
      openedAt: z.string(),
      openingCashFils: fils,
      expectedCashFils: z.number().int(),
    })
  ),
  capabilities: z.object({ onlineSales: z.boolean(), offlineSales: z.literal(false) }),
})
export type LiveBootstrap = z.infer<typeof liveBootstrapSchema>
export type LiveOrder = z.infer<typeof liveOrderSchema>['order']
export type LiveCommand = z.infer<typeof liveCommandSchema>['command']
export type LiveDevice = z.infer<typeof liveDeviceSchema>

export const liveRecoverySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sale'), request: liveOrderSchema.shape.order }).strict(),
  z.object({ kind: z.literal('command'), request: liveCommandSchema.shape.command }).strict(),
])
