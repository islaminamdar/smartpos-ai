import { describe, expect, it } from 'vitest'
import {
  offerSchema,
  quoteOffer,
  type Offer,
  type OfferBasketLine,
  type OfferContext,
  type OfferQuote,
} from '@/lib/pos/offers'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const context: OfferContext = {
  branchId: id(1),
  now: '2026-10-16T08:00:00Z',
  serviceType: 'takeaway',
  role: 'cashier',
  coupon: null,
  customerId: null,
  redemptionsUsed: 0,
  customerRedemptionsUsed: 0,
}
const base: Offer = {
  id: id(2),
  branchId: id(1),
  revision: 1,
  name: 'Lunch offer',
  active: true,
  benefit: {
    kind: 'percentage',
    basisPoints: 1000,
    maximumDiscountFils: null,
    eligibility: { scope: 'all' },
  },
  schedule: { timezone: 'Asia/Dubai', startsAt: null, endsAt: null, windows: [] },
  minimumSpendFils: 0,
  serviceTypes: ['dine_in', 'takeaway', 'delivery'],
  managerOnly: false,
  coupon: null,
  totalRedemptionsLimit: null,
  perCustomerLimit: null,
}
const line = (n: number, price: number, quantityMilli = 1000): OfferBasketLine => ({
  productId: id(n),
  category: 'Meals',
  unit: 'piece',
  unitPriceFils: price,
  quantityMilli,
  taxRateBps: 500,
})
function eligible(result: OfferQuote) {
  expect(result.eligible).toBe(true)
  if (!result.eligible) throw new Error(result.reason)
  return result
}
const rejected = (offer: Offer, expected: string, ctx = context, lines = [line(3, 1000)]) =>
  expect(quoteOffer(offer, lines, ctx)).toEqual({ eligible: false, reason: expected })

describe('offer allocation and inclusive VAT', () => {
  it('allocates percentage savings before line VAT and preserves the list price', () => {
    const cart = [line(3, 1050), line(4, 2100)]
    const result = eligible(quoteOffer(base, cart, context))
    expect(result).toMatchObject({
      beforeDiscountFils: 3150,
      discountFils: 315,
      grossFils: 2835,
      taxFils: 135,
      netFils: 2700,
      offerRevision: 1,
    })
    expect(result.lines.map((l) => l.discountFils)).toEqual([105, 210])
    expect(cart[0].unitPriceFils).toBe(1050)
  })
  it('allocates fixed odd fils deterministically across eligible items only', () => {
    const offer: Offer = {
      ...base,
      benefit: {
        kind: 'fixed',
        amountFils: 1,
        eligibility: { scope: 'categories', categories: ['Meals'] },
      },
    }
    const cart = [line(4, 100), { ...line(5, 100), category: 'Drinks' }, line(3, 100)]
    const result = eligible(quoteOffer(offer, cart, context))
    expect(result.lines.map((l) => l.discountFils)).toEqual([0, 0, 1])
    expect(eligible(quoteOffer(offer, [...cart].reverse(), context)).lines).toEqual(
      [...result.lines].reverse()
    )
  })
  it('caps fixed discounts at eligible subtotal and percentage at its configured maximum', () => {
    const cart = [line(3, 1000), line(4, 500)]
    const fixed: Offer = {
      ...base,
      benefit: {
        kind: 'fixed',
        amountFils: 5000,
        eligibility: { scope: 'products', productIds: [id(3)] },
      },
    }
    expect(eligible(quoteOffer(fixed, cart, context))).toMatchObject({
      discountFils: 1000,
      grossFils: 500,
    })
    const capped: Offer = {
      ...base,
      benefit: {
        kind: 'percentage',
        basisPoints: 5000,
        maximumDiscountFils: 99,
        eligibility: { scope: 'all' },
      },
    }
    expect(eligible(quoteOffer(capped, cart, context)).discountFils).toBe(99)
  })
  it('calculates weighted items and half-fils with half-up rounding', () => {
    const result = eligible(quoteOffer(base, [{ ...line(3, 1001, 500), unit: 'kg' }], context))
    expect(result).toMatchObject({
      beforeDiscountFils: 501,
      discountFils: 50,
      grossFils: 451,
      taxFils: 21,
    })
    const half: Offer = {
      ...base,
      benefit: {
        kind: 'percentage',
        basisPoints: 5000,
        maximumDiscountFils: null,
        eligibility: { scope: 'all' },
      },
    }
    expect(eligible(quoteOffer(half, [line(3, 3)], context)).discountFils).toBe(2)
  })
  it('never fabricates a 1-fils payment for a fully discounted basket', () => {
    rejected(
      { ...base, benefit: { kind: 'fixed', amountFils: 1000, eligibility: { scope: 'all' } } },
      'zero_total_requires_complimentary_flow'
    )
    rejected(
      {
        ...base,
        benefit: {
          kind: 'percentage',
          basisPoints: 10000,
          maximumDiscountFils: null,
          eligibility: { scope: 'all' },
        },
      },
      'zero_total_requires_complimentary_flow'
    )
  })
  it('does not stack or mutate inputs, and cannot authorize or reserve a redemption', () => {
    const frozen = structuredClone(base)
    const cart = [line(3, 1000)]
    const before = JSON.stringify({ frozen, cart, context })
    const result = eligible(quoteOffer(frozen, cart, context))
    expect(JSON.stringify({ frozen, cart, context })).toBe(before)
    expect(result).not.toHaveProperty('authorized')
    expect(result).not.toHaveProperty('reserved')
    expect(result).not.toHaveProperty('customerId')
  })
})

describe('buy X get Y and bundles', () => {
  const bxgy: Offer = {
    ...base,
    benefit: { kind: 'buy_x_get_y', buyUnits: 2, freeUnits: 1, eligibility: { scope: 'all' } },
  }
  it('requires the reward in the basket and counts the cheapest units without expanding them', () => {
    rejected(bxgy, 'no_saving', context, [line(3, 1000, 2000)])
    expect(eligible(quoteOffer(bxgy, [line(3, 1000, 3000)], context)).discountFils).toBe(1000)
    const result = eligible(quoteOffer(bxgy, [line(3, 1000, 3000), line(4, 100, 3000)], context))
    expect(result.lines.map((l) => l.discountFils)).toEqual([0, 200])
    expect(eligible(quoteOffer(bxgy, [line(3, 100, 1_000_000)], context)).discountFils).toBe(33300)
  })
  it('rejects kg rather than interpreting grams as individual pieces', () => {
    rejected(bxgy, 'whole_units_required', context, [{ ...line(3, 1000, 3000), unit: 'kg' }])
  })
  const bundle: Offer = {
    ...base,
    benefit: {
      kind: 'bundle',
      priceFils: 1200,
      components: [
        { productId: id(3), units: 2 },
        { productId: id(4), units: 1 },
      ],
    },
  }
  it('forms only complete bundles, leaves extras full-price and allocates savings fairly', () => {
    const result = eligible(
      quoteOffer(bundle, [line(3, 500, 5000), line(4, 1000, 2000), line(5, 700)], context)
    )
    expect(result).toMatchObject({ beforeDiscountFils: 5200, discountFils: 1600, grossFils: 3600 })
    expect(result.lines.map((l) => l.discountFils)).toEqual([800, 800, 0])
    rejected(bundle, 'bundle_incomplete', context, [line(3, 500, 5000)])
    rejected(bundle, 'bundle_incomplete', context, [line(3, 500), line(4, 1000)])
  })
  it('never raises a price and never consumes a SKU twice in one bundle definition', () => {
    rejected(bundle, 'no_saving', context, [line(3, 100, 2000), line(4, 200)])
    expect(
      offerSchema.safeParse({
        ...bundle,
        benefit: {
          ...bundle.benefit,
          components: [
            { productId: id(3), units: 1 },
            { productId: id(3), units: 1 },
          ],
        },
      }).success
    ).toBe(false)
  })
})

describe('eligibility and schedule', () => {
  it('enforces branch, activity, role, channel, spend, coupon and current usage', () => {
    rejected({ ...base, branchId: id(50) }, 'branch_mismatch')
    rejected({ ...base, active: false }, 'inactive')
    rejected({ ...base, managerOnly: true }, 'manager_required')
    expect(
      eligible(
        quoteOffer({ ...base, managerOnly: true }, [line(3, 1000)], { ...context, role: 'manager' })
      ).discountFils
    ).toBe(100)
    rejected({ ...base, serviceTypes: ['delivery'] }, 'service_type')
    rejected({ ...base, minimumSpendFils: 1001 }, 'minimum_spend')
    rejected({ ...base, coupon: 'LUNCH10' }, 'coupon_required')
    expect(
      eligible(
        quoteOffer({ ...base, coupon: 'LUNCH10' }, [line(3, 1000)], {
          ...context,
          coupon: ' lunch10 ',
        })
      ).discountFils
    ).toBe(100)
    rejected({ ...base, totalRedemptionsLimit: 5 }, 'usage_limit', {
      ...context,
      redemptionsUsed: 5,
    })
    rejected({ ...base, perCustomerLimit: 1 }, 'customer_required')
    rejected({ ...base, perCustomerLimit: 1 }, 'customer_limit', {
      ...context,
      customerId: id(60),
      customerRedemptionsUsed: 1,
    })
    rejected(
      {
        ...base,
        benefit: {
          kind: 'fixed',
          amountFils: 1,
          eligibility: { scope: 'products', productIds: [id(99)] },
        },
      },
      'no_eligible_items'
    )
  })
  it('uses inclusive start and exclusive expiry, independent of the computer timezone', () => {
    const offer = {
      ...base,
      schedule: { ...base.schedule, startsAt: context.now, endsAt: '2026-10-16T09:00:00Z' },
    }
    expect(quoteOffer(offer, [line(3, 1000)], context).eligible).toBe(true)
    rejected(offer, 'outside_schedule', { ...context, now: '2026-10-16T07:59:59Z' })
    rejected(offer, 'outside_schedule', { ...context, now: '2026-10-16T09:00:00Z' })
    expect(
      quoteOffer(offer, [line(3, 1000)], { ...context, now: '2026-10-16T12:30:00+04:00' }).eligible
    ).toBe(true)
  })
  it('handles Friday happy hour and Sunday overnight into Monday in Dubai', () => {
    const offer = {
      ...base,
      schedule: {
        ...base.schedule,
        windows: [{ weekdays: [5], startMinute: 12 * 60, endMinute: 14 * 60 }],
      },
    }
    expect(quoteOffer(offer, [line(3, 1000)], context).eligible).toBe(true)
    rejected(offer, 'outside_schedule', { ...context, now: '2026-10-16T10:00:00Z' })
    rejected(offer, 'outside_schedule', { ...context, now: '2026-10-17T08:00:00Z' })
    const overnight = {
      ...base,
      schedule: {
        ...base.schedule,
        windows: [{ weekdays: [7], startMinute: 22 * 60, endMinute: 2 * 60 }],
      },
    }
    expect(
      quoteOffer(overnight, [line(3, 1000)], { ...context, now: '2026-10-18T18:00:00Z' }).eligible
    ).toBe(true)
    expect(
      quoteOffer(overnight, [line(3, 1000)], { ...context, now: '2026-10-18T21:00:00Z' }).eligible
    ).toBe(true)
    rejected(overnight, 'outside_schedule', { ...context, now: '2026-10-18T22:00:00Z' })
    rejected(overnight, 'outside_schedule', { ...context, now: '2026-10-17T21:00:00Z' })
  })
  it('rejects ambiguous schedules, duplicate product rows, fractional pieces and unsafe inputs', () => {
    expect(() => quoteOffer(base, [line(3, 1000), line(3, 1000)], context)).toThrow()
    expect(() => quoteOffer(base, [line(3, 1000, 500)], context)).toThrow()
    expect(() => quoteOffer(base, [line(3, 100_000_000, 2000)], context)).toThrow(
      'supported amount'
    )
    expect(() => quoteOffer(base, [line(3, 1000)], { ...context, now: 'invalid' })).toThrow()
    expect(() => quoteOffer({ ...base, clientApproved: true }, [line(3, 1000)], context)).toThrow()
    expect(() =>
      quoteOffer(
        { ...base, benefit: { ...base.benefit, basisPoints: 10001 } },
        [line(3, 1000)],
        context
      )
    ).toThrow()
    expect(
      offerSchema.safeParse({
        ...base,
        schedule: { ...base.schedule, windows: [{ weekdays: [5], startMinute: 0, endMinute: 0 }] },
      }).success
    ).toBe(false)
    expect(
      offerSchema.safeParse({
        ...base,
        schedule: {
          ...base.schedule,
          startsAt: '2026-10-17T00:00:00Z',
          endsAt: '2026-10-16T00:00:00Z',
        },
      }).success
    ).toBe(false)
  })
})

it('reconciles 2,000 deterministic varied baskets and remains invariant under line reordering', () => {
  let seed = 72641
  const random = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % max
  }
  for (let sample = 0; sample < 2000; sample++) {
    const cart = Array.from({ length: 2 + random(8) }, (_, index) => ({
      ...line(index + 3, 1 + random(5_000_000), 1 + random(1000)),
      unit: 'kg' as const,
      taxRateBps: [0, 500, 10000][random(3)],
    }))
    const offer: Offer = {
      ...base,
      benefit:
        sample % 2
          ? {
              kind: 'percentage',
              basisPoints: 1 + random(9999),
              maximumDiscountFils: null,
              eligibility: { scope: 'all' },
            }
          : { kind: 'fixed', amountFils: 1 + random(100_000), eligibility: { scope: 'all' } },
    }
    const result = quoteOffer(offer, cart, context)
    if (!result.eligible) {
      expect(['no_saving', 'zero_total_requires_complimentary_flow']).toContain(result.reason)
      continue
    }
    expect(result.lines.reduce((sum, row) => sum + row.discountFils, 0)).toBe(result.discountFils)
    expect(result.lines.reduce((sum, row) => sum + row.grossFils, 0)).toBe(result.grossFils)
    expect(result.lines.reduce((sum, row) => sum + row.taxFils, 0)).toBe(result.taxFils)
    expect(result.grossFils + result.discountFils).toBe(result.beforeDiscountFils)
    expect(result.netFils + result.taxFils).toBe(result.grossFils)
    for (const row of result.lines) {
      expect(row.discountFils).toBeGreaterThanOrEqual(0)
      expect(row.discountFils).toBeLessThanOrEqual(row.beforeDiscountFils)
      expect(row.netFils + row.taxFils).toBe(row.grossFils)
    }
    const reversed = eligible(quoteOffer(offer, [...cart].reverse(), context))
    expect(reversed.lines).toEqual([...result.lines].reverse())
    expect(reversed.grossFils).toBe(result.grossFils)
  }
})

it('uses PostgreSQL UUID equality for selectors, branches and duplicate detection', () => {
  const canonical = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const upper = canonical.toUpperCase()
  const cart = [{ ...line(3, 1000), productId: canonical }]
  const offer: Offer = {
    ...base,
    branchId: canonical,
    benefit: {
      kind: 'fixed',
      amountFils: 100,
      eligibility: { scope: 'products', productIds: [upper] },
    },
  }
  expect(eligible(quoteOffer(offer, cart, { ...context, branchId: upper })).discountFils).toBe(100)
  expect(() => quoteOffer(base, [cart[0], { ...cart[0], productId: upper }], context)).toThrow()
  expect(
    offerSchema.safeParse({
      ...base,
      benefit: {
        kind: 'bundle',
        priceFils: 100,
        components: [
          { productId: canonical, units: 1 },
          { productId: upper, units: 1 },
        ],
      },
    }).success
  ).toBe(false)
  expect(
    offerSchema.safeParse({
      ...offer,
      benefit: {
        kind: 'fixed',
        amountFils: 100,
        eligibility: { scope: 'products', productIds: [canonical, upper] },
      },
    }).success
  ).toBe(false)
})

it('preserves explainable application quantities without disclosing a coupon in its snapshot', () => {
  const offer: Offer = {
    ...base,
    coupon: 'PRIVATE10',
    benefit: { kind: 'buy_x_get_y', buyUnits: 2, freeUnits: 1, eligibility: { scope: 'all' } },
  }
  const result = eligible(
    quoteOffer(offer, [line(3, 1000, 3000), line(4, 100, 3000)], {
      ...context,
      coupon: 'PRIVATE10',
    })
  )
  expect(result.applications).toBe(2)
  expect(result.lines.map((row) => row.eligibleQuantityMilli)).toEqual([3000, 3000])
  expect(result.lines.map((row) => row.rewardQuantityMilli)).toEqual([0, 2000])
  expect(result.appliedDefinition).toMatchObject({
    revision: 1,
    couponRequired: true,
    schedule: base.schedule,
  })
  expect(result.appliedDefinition).not.toHaveProperty('coupon')
  expect(JSON.stringify(result)).not.toContain('PRIVATE10')
  const bundle: Offer = {
    ...base,
    benefit: {
      kind: 'bundle',
      priceFils: 1200,
      components: [
        { productId: id(3), units: 2 },
        { productId: id(4), units: 1 },
      ],
    },
  }
  const combined = eligible(quoteOffer(bundle, [line(3, 500, 5000), line(4, 1000, 2000)], context))
  expect(combined.applications).toBe(2)
  expect(combined.lines.map((row) => row.bundleQuantityMilli)).toEqual([4000, 2000])
})
