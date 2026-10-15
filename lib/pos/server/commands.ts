import { z } from 'zod'
const uuid = z.string().uuid()
const base = { id: uuid, branchId: uuid }
const device = { ...base, deviceId: uuid, shiftId: uuid }
const nonnegativeFils = z.number().int().min(0).max(100_000_000)
const reason = z.string().trim().min(1).max(240)
export const posCommandSchema = z.object({
  command: z.discriminatedUnion('type', [
    z.object({ ...device, type: z.literal('shift.open'), openingCashFils: nonnegativeFils }).strict(),
    z.object({ ...device, type: z.literal('shift.close'), countedCashFils: nonnegativeFils }).strict(),
    z.object({ ...device, type: z.literal('cash.move'), amountFils: z.number().int().min(-100_000_000).max(100_000_000).refine(n => n !== 0), reason }).strict(),
    z.object({ ...device, type: z.literal('refund.create'), orderId: uuid, method: z.enum(['cash', 'card', 'other']), amountFils: nonnegativeFils.refine(n => n > 0), reason }).strict(),
    z.object({ ...base, type: z.literal('subscription.update'), status: z.enum(['trial', 'active', 'past_due', 'cancelled']), paidThrough: z.string().date().nullable(), reason }).strict(),
  ]),
}).strict()
