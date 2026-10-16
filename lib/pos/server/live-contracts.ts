import { z } from 'zod'
import { syncOrderSchema } from './contracts'
import { merchantProfileSchema, receiptCustomerSchema } from './documents'

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
      .strict(),
  })
  .strict()
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
