import { z } from 'zod'
import { offerSchema } from '@/lib/pos/offers'
import { syncOrderSchema } from './contracts'
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const fils = z.number().int().min(0).max(100_000_000)
const revision = z.number().int().min(1).max(2_147_483_647)
const quantity = z.number().int().min(0).max(1_000_000)
export const offerSelectionSchema = z
  .object({
    offerId: uuid,
    expectedRevision: revision,
    couponCode: z.string().max(32).nullable(),
    expectedDiscountFils: fils.refine((value) => value > 0),
  })
  .strict()
export type OfferSelection = z.infer<typeof offerSelectionSchema>
export const offerUpdateSchema = z
  .object({
    id: uuid,
    branchId: uuid,
    deviceId: uuid,
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    reason: z.string().trim().min(1).max(240),
    // Per-customer limits need a verified customer identity, not receipt free text.
    offer: offerSchema
      .omit({ branchId: true, revision: true })
      .extend({ perCustomerLimit: z.null() })
      .strict(),
  })
  .strict()
export type OfferUpdate = z.infer<typeof offerUpdateSchema>
export const offerResultSchema = z
  .object({
    status: z.literal('updated'),
    requestId: uuid,
    replayed: z.boolean(),
    offer: offerSchema,
  })
  .strict()
export const offerListSchema = z
  .object({
    status: z.literal('ready'),
    offers: z
      .array(
        z
          .object({
            offer: offerSchema,
            redemptionsUsed: z.number().int().min(0).max(1_000_000_000),
          })
          .strict()
      )
      .max(200),
  })
  .strict()
export const offerQuoteLineSchema = syncOrderSchema.shape.order.shape.lines.element
  .extend({
    productId: uuid,
    expectedRevision: revision,
  })
  .strict()
export const offerQuoteRequestSchema = z
  .object({
    branchId: uuid,
    serviceType: z.enum(['dine_in', 'takeaway', 'delivery']),
    lines: z
      .array(offerQuoteLineSchema)
      .min(1)
      .max(200)
      .refine((lines) => new Set(lines.map((line) => line.productId)).size === lines.length),
    couponCode: z.string().max(32).nullable(),
  })
  .strict()
const allocationSchema = z
  .object({
    productId: uuid,
    eligibleQuantityMilli: quantity,
    rewardQuantityMilli: quantity,
    bundleQuantityMilli: quantity,
    beforeDiscountFils: fils,
    discountFils: fils,
    grossFils: fils,
    taxFils: fils,
    netFils: fils,
  })
  .strict()
export const offerQuoteSchema = z
  .object({
    eligible: z.literal(true),
    calculationVersion: z.literal('offer-v1'),
    offerId: uuid,
    offerRevision: revision,
    offerName: z.string().trim().min(1).max(120),
    benefit: offerSchema.shape.benefit,
    appliedDefinition: offerSchema
      .omit({ coupon: true })
      .extend({ couponRequired: z.boolean() })
      .strict(),
    applications: z.number().int().min(1).max(200_000),
    beforeDiscountFils: fils,
    discountFils: fils.refine((value) => value > 0),
    grossFils: fils.refine((value) => value > 0),
    taxFils: fils,
    netFils: fils,
    lines: z.array(allocationSchema).min(1).max(200),
  })
  .strict()
  .superRefine((quote, ctx) => {
    const fail = () =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Offer quote does not reconcile.' })
    if (
      quote.offerId !== quote.appliedDefinition.id ||
      quote.offerRevision !== quote.appliedDefinition.revision ||
      quote.offerName !== quote.appliedDefinition.name ||
      JSON.stringify(quote.benefit) !== JSON.stringify(quote.appliedDefinition.benefit) ||
      new Set(quote.lines.map((line) => line.productId)).size !== quote.lines.length
    )
      fail()
    for (const row of [quote, ...quote.lines]) {
      if (
        row.beforeDiscountFils - row.discountFils !== row.grossFils ||
        row.netFils + row.taxFils !== row.grossFils
      )
        fail()
    }
    for (const field of [
      'beforeDiscountFils',
      'discountFils',
      'grossFils',
      'taxFils',
      'netFils',
    ] as const)
      if (quote.lines.reduce((sum, line) => sum + line[field], 0) !== quote[field]) fail()
    if (
      quote.lines.some(
        (line) =>
          line.rewardQuantityMilli > line.eligibleQuantityMilli ||
          line.bundleQuantityMilli > line.eligibleQuantityMilli
      )
    )
      fail()
  })
export const offerQuoteResponseSchema = z
  .object({
    status: z.literal('ready'),
    branchId: uuid,
    evaluatedAt: z.string().datetime({ offset: true }),
    quotes: z.array(offerQuoteSchema).max(200),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (
      result.quotes.some((quote) => quote.appliedDefinition.branchId !== result.branchId) ||
      new Set(result.quotes.map((quote) => quote.offerId)).size !== result.quotes.length
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Offer quote scope does not match.' })
  })
export type EligibleOfferQuote = z.infer<typeof offerQuoteSchema>
