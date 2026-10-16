import { z } from 'zod'

/** Deterministic preview rules. Only the transactional database writer may authorize a sale. */
const money = z.number().int().min(0).max(100_000_000)
const positiveMoney = money.refine((n) => n > 0)
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const uniqueIds = z
  .array(uuid)
  .min(1)
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length)
const eligibility = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('all') }).strict(),
  z.object({ scope: z.literal('products'), productIds: uniqueIds }).strict(),
  z
    .object({
      scope: z.literal('categories'),
      categories: z
        .array(z.string().trim().min(1).max(120))
        .min(1)
        .max(100)
        .refine((values) => new Set(values).size === values.length),
    })
    .strict(),
])
const windowSchema = z
  .object({
    // ISO weekday: Monday=1, Sunday=7. An overnight window belongs to its start day.
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(0).max(1440),
  })
  .strict()
  .refine((window) => window.startMinute !== window.endMinute)
const instant = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)))
const schedule = z
  .object({
    timezone: z.literal('Asia/Dubai'),
    startsAt: instant.nullable(),
    endsAt: instant.nullable(),
    windows: z.array(windowSchema).max(14),
  })
  .strict()
  .refine(
    (value) =>
      !value.startsAt || !value.endsAt || Date.parse(value.startsAt) < Date.parse(value.endsAt)
  )
const benefit = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('percentage'),
      basisPoints: z.number().int().min(1).max(10_000),
      maximumDiscountFils: positiveMoney.nullable(),
      eligibility,
    })
    .strict(),
  z.object({ kind: z.literal('fixed'), amountFils: positiveMoney, eligibility }).strict(),
  z
    .object({
      kind: z.literal('buy_x_get_y'),
      buyUnits: z.number().int().min(1).max(1000),
      freeUnits: z.number().int().min(1).max(1000),
      eligibility,
    })
    .strict(),
  z
    .object({
      kind: z.literal('bundle'),
      priceFils: positiveMoney,
      components: z
        .array(z.object({ productId: uuid, units: z.number().int().min(1).max(1000) }).strict())
        .min(2)
        .max(20)
        .refine((items) => new Set(items.map((item) => item.productId)).size === items.length),
    })
    .strict(),
])
export const offerSchema = z
  .object({
    id: uuid,
    branchId: uuid,
    revision: z.number().int().min(1).max(2_147_483_647),
    name: z.string().trim().min(1).max(120),
    active: z.boolean(),
    benefit,
    schedule,
    minimumSpendFils: money,
    serviceTypes: z
      .array(z.enum(['dine_in', 'takeaway', 'delivery']))
      .min(1)
      .max(3)
      .refine((types) => new Set(types).size === types.length),
    managerOnly: z.boolean(),
    coupon: z
      .string()
      .regex(/^[A-Z0-9][A-Z0-9_-]{2,31}$/)
      .nullable(),
    totalRedemptionsLimit: z.number().int().min(1).max(1_000_000_000).nullable(),
    perCustomerLimit: z.number().int().min(1).max(1_000_000).nullable(),
  })
  .strict()
export type Offer = z.infer<typeof offerSchema>
export const offerBasketLineSchema = z
  .object({
    productId: uuid,
    category: z.string().min(1).max(120),
    unit: z.enum(['piece', 'pack', 'kg']),
    quantityMilli: z.number().int().min(1).max(1_000_000),
    unitPriceFils: positiveMoney,
    taxRateBps: z.number().int().min(0).max(10_000),
  })
  .strict()
  .refine((line) => line.unit === 'kg' || line.quantityMilli % 1000 === 0)
export const offerContextSchema = z
  .object({
    branchId: uuid,
    now: instant,
    serviceType: z.enum(['dine_in', 'takeaway', 'delivery']),
    role: z.enum(['owner', 'manager', 'cashier']),
    coupon: z.string().max(32).nullable(),
    customerId: uuid.nullable(),
    // Supplied from locked database state at commit; browser counts are estimates only.
    redemptionsUsed: z.number().int().min(0).max(1_000_000_000),
    customerRedemptionsUsed: z.number().int().min(0).max(1_000_000_000),
  })
  .strict()
export type OfferBasketLine = z.infer<typeof offerBasketLineSchema>
export type OfferContext = z.infer<typeof offerContextSchema>
export type OfferLineAmounts = {
  productId: string
  eligibleQuantityMilli: number
  rewardQuantityMilli: number
  bundleQuantityMilli: number
  beforeDiscountFils: number
  discountFils: number
  grossFils: number
  taxFils: number
  netFils: number
}
export type OfferFailure =
  | 'branch_mismatch'
  | 'inactive'
  | 'outside_schedule'
  | 'service_type'
  | 'manager_required'
  | 'coupon_required'
  | 'minimum_spend'
  | 'usage_limit'
  | 'customer_required'
  | 'customer_limit'
  | 'no_eligible_items'
  | 'whole_units_required'
  | 'bundle_incomplete'
  | 'no_saving'
  | 'zero_total_requires_complimentary_flow'
export type OfferQuote =
  | { eligible: false; reason: OfferFailure }
  | {
      eligible: true
      calculationVersion: 'offer-v1'
      offerId: string
      offerRevision: number
      offerName: string
      benefit: Offer['benefit']
      appliedDefinition: Omit<Offer, 'coupon'> & { couponRequired: boolean }
      applications: number
      beforeDiscountFils: number
      discountFils: number
      grossFils: number
      taxFils: number
      netFils: number
      lines: OfferLineAmounts[]
    }

// BigInt intermediates prevent a 1-fils drift at the upper supported basket limits.
const halfUp = (numerator: bigint, denominator: bigint) =>
  Number((numerator * BigInt(2) + denominator) / (denominator * BigInt(2)))
export function offerLineGross(line: OfferBasketLine): number {
  return halfUp(BigInt(line.unitPriceFils) * BigInt(line.quantityMilli), BigInt(1000))
}

/** Largest remainder, then product UUID order. Allocations reconcile and do not depend on cart order. */
function allocate(total: number, weights: number[], ids: string[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (!sum || !total) return weights.map(() => 0)
  const denominator = BigInt(sum)
  const shares = weights.map((weight, index) => {
    const numerator = BigInt(total) * BigInt(weight)
    return {
      index,
      value: Number(numerator / denominator),
      remainder: numerator % denominator,
      id: ids[index],
    }
  })
  let left = total - shares.reduce((a, row) => a + row.value, 0)
  const ranked = [...shares].sort((a, b) =>
    a.remainder === b.remainder
      ? a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0
      : a.remainder > b.remainder
        ? -1
        : 1
  )
  for (const row of ranked) {
    if (left-- <= 0) break
    row.value++
  }
  return shares.map((row) => row.value)
}

function inSchedule(schedule: Offer['schedule'], now: string): boolean {
  const timestamp = Date.parse(now)
  if (schedule.startsAt && timestamp < Date.parse(schedule.startsAt)) return false
  if (schedule.endsAt && timestamp >= Date.parse(schedule.endsAt)) return false
  if (!schedule.windows.length) return true
  const local = new Date(timestamp + 4 * 60 * 60 * 1000)
  const day = local.getUTCDay() || 7
  const previousDay = day === 1 ? 7 : day - 1
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes()
  return schedule.windows.some((window) =>
    window.startMinute < window.endMinute
      ? window.weekdays.includes(day) && minute >= window.startMinute && minute < window.endMinute
      : (window.weekdays.includes(day) && minute >= window.startMinute) ||
        (window.weekdays.includes(previousDay) && minute < window.endMinute)
  )
}

function matches(line: OfferBasketLine, selector: z.infer<typeof eligibility>): boolean {
  return (
    selector.scope === 'all' ||
    (selector.scope === 'products'
      ? selector.productIds.includes(line.productId)
      : selector.categories.includes(line.category))
  )
}

/**
 * Pure preview only: it deliberately cannot issue an invoice or reserve redemptions.
 * The eventual writer must recompute from current catalogue/rules and locked usage.
 * One offer per order: select the best or explicitly choose one; never silently stack.
 */
export function quoteOffer(rawOffer: unknown, rawLines: unknown, rawContext: unknown): OfferQuote {
  const offer = offerSchema.parse(rawOffer)
  const lines = z
    .array(offerBasketLineSchema)
    .min(1)
    .max(200)
    .refine(
      (items) => new Set(items.map((line) => line.productId)).size === items.length,
      'Consolidate duplicate products before quoting an offer.'
    )
    .parse(rawLines)
  const context = offerContextSchema.parse(rawContext)
  const gross = lines.map(offerLineGross)
  const subtotal = gross.reduce((a, b) => a + b, 0)
  if (subtotal > 100_000_000) throw new Error('Basket exceeds the supported amount.')
  const fail = (reason: OfferFailure): OfferQuote => ({ eligible: false, reason })
  if (offer.branchId !== context.branchId) return fail('branch_mismatch')
  if (!offer.active) return fail('inactive')
  if (!inSchedule(offer.schedule, context.now)) return fail('outside_schedule')
  if (!offer.serviceTypes.includes(context.serviceType)) return fail('service_type')
  if (offer.managerOnly && context.role === 'cashier') return fail('manager_required')
  if (offer.coupon && context.coupon?.trim().toUpperCase() !== offer.coupon)
    return fail('coupon_required')
  if (subtotal < offer.minimumSpendFils) return fail('minimum_spend')
  if (
    offer.totalRedemptionsLimit !== null &&
    context.redemptionsUsed >= offer.totalRedemptionsLimit
  )
    return fail('usage_limit')
  if (offer.perCustomerLimit !== null) {
    if (!context.customerId) return fail('customer_required')
    if (context.customerRedemptionsUsed >= offer.perCustomerLimit) return fail('customer_limit')
  }
  let discounts = gross.map(() => 0)
  const eligibleQuantities = gross.map(() => 0)
  const rewardQuantities = gross.map(() => 0)
  const bundleQuantities = gross.map(() => 0)
  let applications = 1
  const rule = offer.benefit
  const ids = lines.map((line) => line.productId)
  if (rule.kind === 'bundle') {
    const componentRows = rule.components.map((component) => ({
      ...component,
      index: lines.findIndex((line) => line.productId === component.productId),
    }))
    if (componentRows.some((row) => row.index === -1)) return fail('bundle_incomplete')
    if (componentRows.some((row) => lines[row.index].unit === 'kg'))
      return fail('whole_units_required')
    const bundles = Math.min(
      ...componentRows.map((row) => Math.floor(lines[row.index].quantityMilli / (1000 * row.units)))
    )
    if (!bundles) return fail('bundle_incomplete')
    applications = bundles
    const weights = lines.map(() => 0)
    for (const row of componentRows) {
      weights[row.index] = row.units * bundles * lines[row.index].unitPriceFils
      eligibleQuantities[row.index] = lines[row.index].quantityMilli
      bundleQuantities[row.index] = row.units * bundles * 1000
    }
    const regular = weights.reduce((a, b) => a + b, 0)
    // Never increase the customer's price when the ordinary menu is cheaper.
    const saving = regular - rule.priceFils * bundles
    if (saving <= 0) return fail('no_saving')
    discounts = allocate(saving, weights, ids)
  } else {
    const weights = lines.map((line, index) => (matches(line, rule.eligibility) ? gross[index] : 0))
    lines.forEach((line, index) => {
      if (matches(line, rule.eligibility)) eligibleQuantities[index] = line.quantityMilli
    })
    const eligibleSubtotal = weights.reduce((a, b) => a + b, 0)
    if (!eligibleSubtotal) return fail('no_eligible_items')
    if (rule.kind === 'buy_x_get_y') {
      const candidates = lines
        .map((line, index) => ({ ...line, index }))
        .filter((line) => matches(line, rule.eligibility))
      if (candidates.some((line) => line.unit === 'kg')) return fail('whole_units_required')
      const units = candidates.reduce((a, line) => a + line.quantityMilli / 1000, 0)
      applications = Math.floor(units / (rule.buyUnits + rule.freeUnits))
      let free = applications * rule.freeUnits
      // Reward units are included in the basket; the cheapest eligible units are free.
      candidates.sort(
        (a, b) => a.unitPriceFils - b.unitPriceFils || (a.productId < b.productId ? -1 : 1)
      )
      for (const line of candidates) {
        const count = Math.min(free, line.quantityMilli / 1000)
        discounts[line.index] = count * line.unitPriceFils
        rewardQuantities[line.index] = count * 1000
        free -= count
      }
    } else {
      const saving =
        rule.kind === 'fixed'
          ? Math.min(rule.amountFils, eligibleSubtotal)
          : Math.min(
              halfUp(BigInt(eligibleSubtotal) * BigInt(rule.basisPoints), BigInt(10000)),
              rule.maximumDiscountFils ?? eligibleSubtotal
            )
      discounts = allocate(saving, weights, ids)
    }
  }
  const discount = discounts.reduce((a, b) => a + b, 0)
  if (!discount) return fail('no_saving')
  if (subtotal === discount) return fail('zero_total_requires_complimentary_flow')
  const amounts = lines.map((line, index) => {
    const paid = gross[index] - discounts[index]
    const tax = halfUp(BigInt(paid) * BigInt(line.taxRateBps), BigInt(10000 + line.taxRateBps))
    return {
      productId: line.productId,
      eligibleQuantityMilli: eligibleQuantities[index],
      rewardQuantityMilli: rewardQuantities[index],
      bundleQuantityMilli: bundleQuantities[index],
      beforeDiscountFils: gross[index],
      discountFils: discounts[index],
      grossFils: paid,
      taxFils: tax,
      netFils: paid - tax,
    }
  })
  const totalTax = amounts.reduce((a, line) => a + line.taxFils, 0)
  const { coupon, ...definition } = offer
  return {
    eligible: true,
    calculationVersion: 'offer-v1',
    offerId: offer.id,
    offerRevision: offer.revision,
    offerName: offer.name,
    benefit: offer.benefit,
    appliedDefinition: { ...definition, couponRequired: coupon !== null },
    applications,
    beforeDiscountFils: subtotal,
    discountFils: discount,
    grossFils: subtotal - discount,
    taxFils: totalTax,
    netFils: subtotal - discount - totalTax,
    lines: amounts,
  }
}
