import { describe, expect, it } from 'vitest'
import {
  liveOrderSchema,
  newLiveOrderSchema,
  liveRecoverySchema,
} from '@/lib/pos/server/live-contracts'
import { receiptCustomerSchema } from '@/lib/pos/server/documents'
import { parseNativeReceipt, parseNativeIntent } from '../../../apps/android-pos/src/native'
import { intent, receipt, id } from './fixtures/native-checkout'
const order = {
  id: id(20),
  branchId: id(21),
  deviceId: id(22),
  shiftId: id(23),
  profileId: id(24),
  createdAt: '2026-10-16T10:00:00Z',
  serviceType: 'takeaway',
  lines: [
    { productId: id(25), quantityMilli: 1000, expectedUnitPriceFils: 525, expectedTaxRateBps: 500 },
  ],
  payments: [{ method: 'cash', amountFils: 525 }],
  expectedTotalFils: 525,
  cashTenderedFils: 525,
  customer: { name: 'عميل 😀', address: 'دبي 🏠', trn: null },
}
describe('new buyer input versus immutable historical records', () => {
  it('accepts normal Arabic and emoji without rewriting the buyer', () => {
    expect(newLiveOrderSchema.parse({ order }).order.customer).toEqual(order.customer)
  })
  it.each(['name', 'address'] as const)(
    'rejects a new %s containing U+0000 while preserving recovery and historical parsers',
    (field) => {
      const customer = { ...order.customer, [field]: 'A\u0000B' }
      const original = { ...order, customer }
      const parsed = newLiveOrderSchema.safeParse({ order: original })
      expect(parsed.success).toBe(false)
      if (!parsed.success) expect(parsed.error.issues[0].path).toEqual(['order', 'customer', field])
      expect(liveOrderSchema.parse({ order: original }).order.customer).toEqual(customer)
      expect(liveRecoverySchema.parse({ kind: 'sale', request: original }).request).toEqual(
        original
      )
      expect(receiptCustomerSchema.parse(customer)).toEqual(customer)
      expect(parseNativeReceipt({ ...receipt, customer }).customer).toEqual(customer)
      const request = { ...intent.request, customer }
      expect(
        parseNativeIntent({ ...intent, request, quote: { ...intent.quote, request } }).request
          .customer
      ).toEqual(customer)
      expect(customer[field]).toBe('A\u0000B')
    }
  )
})

describe('direct paid-order notes', () => {
  it('keeps a valid note in a new recoverable sale request', () => {
    const noted = { ...order, orderNote: 'No chilli, please' }
    expect(newLiveOrderSchema.parse({ order: noted }).order.orderNote).toBe('No chilli, please')
    expect(liveRecoverySchema.parse({ kind: 'sale', request: noted }).request).toEqual(noted)
  })
  it('rejects hidden characters and notes added after an unpaid order was saved', () => {
    expect(newLiveOrderSchema.safeParse({ order: { ...order, orderNote: 'A\u0000B' } }).success).toBe(false)
    expect(
      newLiveOrderSchema.safeParse({
        order: {
          ...order,
          orderNote: 'No chilli',
          sourceTab: { id: id(26), expectedRevision: 1 },
        },
      }).success
    ).toBe(false)
  })
})
