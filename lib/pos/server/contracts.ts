import { z } from 'zod'

const fils = z.number().int().min(0).max(100_000_000)
export const syncOrderSchema = z.object({
  order: z.object({
    id: z.string().uuid(),
    branchId: z.string().uuid(),
    deviceId: z.string().uuid(),
    shiftId: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    serviceType: z.enum(['dine_in', 'takeaway', 'delivery']),
    lines: z.array(z.object({
      productId: z.string().uuid(),
      quantityMilli: z.number().int().min(1).max(1_000_000),
      expectedUnitPriceFils: fils,
      expectedTaxRateBps: z.number().int().min(0).max(10_000),
    }).strict()).min(1).max(200),
    payments: z.array(z.object({
      method: z.enum(['cash', 'card', 'other']),
      amountFils: fils.refine(value => value > 0),
    }).strict()).min(1).max(10),
    expectedTotalFils: fils.refine(value => value > 0),
  }).strict(),
}).strict()

export type SyncOrder = z.infer<typeof syncOrderSchema>['order']

// The same inclusive-tax rounding used by the SQL RPC: per line, then sum.
export function catalogueLineTotals(unitPriceFils: number, quantityMilli: number, taxRateBps: number) {
  const grossFils = Math.round(unitPriceFils * quantityMilli / 1000)
  const taxFils = Math.round(grossFils * taxRateBps / (10000 + taxRateBps))
  return { grossFils, taxFils }
}
