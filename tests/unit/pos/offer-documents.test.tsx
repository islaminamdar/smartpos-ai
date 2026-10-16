import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import fixtures from '../../fixtures/pos-offer-documents.json'
import { fiscalDocumentSchema } from '@/lib/pos/server/documents'
import { offerQuoteResponseSchema } from '@/lib/pos/server/offers'
import { liveOrderSchema, type LiveOrder } from '@/lib/pos/server/live-contracts'
import { invoiceMatchesSale } from '@/lib/pos/server/sale-ack'
import FiscalReceipt from '@/components/pos/FiscalReceipt'

// These records are output from migration 012 in an isolated, synthetic PostgreSQL database.
const receipt = fiscalDocumentSchema.parse(fixtures.receipts[0])
if (receipt.kind !== 'tax_invoice' || receipt.schemaVersion !== 2) throw Error('Wrong fixture')
const order: LiveOrder = {
  id: receipt.orderId,
  branchId: receipt.branchId,
  deviceId: receipt.deviceId,
  shiftId: receipt.shiftId,
  createdAt: receipt.issuedAt,
  serviceType: receipt.serviceType,
  profileId: receipt.merchant.id,
  customer: receipt.customer,
  expectedTotalFils: receipt.totals.grossFils,
  cashTenderedFils: receipt.cashTenderedFils,
  lines: receipt.lines.map((line) => ({
    productId: line.productId,
    quantityMilli: line.quantityMilli,
    expectedUnitPriceFils: line.unitPriceFils,
    expectedTaxRateBps: line.taxRateBps,
    expectedRevision: 1,
  })),
  payments: receipt.payments,
  offerSelection: {
    offerId: receipt.appliedOffer.offerId,
    expectedRevision: receipt.appliedOffer.offerRevision,
    couponCode: null,
    expectedDiscountFils: receipt.totals.discountFils,
  },
}

describe('SQL-generated discounted document contract', () => {
  it('accepts all benefit types, zero-paid reward lines, quotes and exact full credit from PostgreSQL', () => {
    for (const value of [...fixtures.receipts, fixtures.credit])
      expect(fiscalDocumentSchema.safeParse(value).success).toBe(true)
    expect(offerQuoteResponseSchema.safeParse(fixtures.quoted).success).toBe(true)
    expect(
      fixtures.receipts.some((value) => value.lines.some((line) => line.grossFils === 0))
    ).toBe(true)
    expect(new Set(fixtures.receipts.map((value) => value.appliedOffer.benefit.kind)).size).toBe(4)
  })
  it('rejects tampered totals, allocations, identity, private coupon fields and v1 reinterpretation', () => {
    const alterations = [
      { ...receipt, totals: { ...receipt.totals, discountFils: 99 } },
      { ...receipt, lines: receipt.lines.map((line) => ({ ...line, unitPriceFils: 999 })) },
      {
        ...receipt,
        lines: receipt.lines.map((line) => ({
          ...line,
          eligibleQuantityMilli: line.quantityMilli + 1,
        })),
      },
      { ...receipt, appliedOffer: { ...receipt.appliedOffer, offerRevision: 2 } },
      {
        ...receipt,
        appliedOffer: {
          ...receipt.appliedOffer,
          appliedDefinition: { ...receipt.appliedOffer.appliedDefinition, coupon: 'PRIVATE' },
        },
      },
      {
        ...receipt,
        appliedOffer: {
          ...receipt.appliedOffer,
          lines: receipt.appliedOffer.lines.map((line) => ({ ...line, rewardQuantityMilli: 1 })),
        },
      },
      { ...receipt, schemaVersion: 1 },
      {
        ...receipt,
        lines: receipt.lines.map((line) => ({
          ...line,
          taxFils: line.taxFils + 1,
          netFils: line.netFils - 1,
        })),
      },
      {
        ...fixtures.credit,
        originalInvoice: { ...fixtures.credit.originalInvoice, totalFils: 1000 },
      },
    ]
    for (const value of alterations)
      expect(fiscalDocumentSchema.safeParse(value).success).toBe(false)
  })
  it('matches the complete immutable sale, not just a same-total invoice', () => {
    expect(invoiceMatchesSale(order, receipt)).toBe(true)
    for (const changes of [
      { offerSelection: { ...order.offerSelection!, expectedRevision: 2 } },
      { offerSelection: { ...order.offerSelection!, expectedDiscountFils: 99 } },
      { offerSelection: undefined },
      { serviceType: 'delivery' as const },
      { customer: { name: 'Different', address: 'Test', trn: null } },
      {
        lines: order.lines.map((line) => ({
          ...line,
          productId: '00000000-0000-4000-8000-000000000001',
        })),
      },
      { payments: [{ method: 'card' as const, amountFils: 900 }] },
    ])
      expect(invoiceMatchesSale({ ...order, ...changes }, receipt)).toBe(false)
    expect(invoiceMatchesSale({ ...order, branchId: order.branchId.toUpperCase() }, receipt)).toBe(
      true
    )
  })
  it('requires offer-line revisions and canonical product uniqueness while preserving old non-offer requests', () => {
    expect(liveOrderSchema.safeParse({ order }).success).toBe(true)
    expect(
      liveOrderSchema.safeParse({
        order: { ...order, lines: order.lines.map(({ expectedRevision, ...line }) => line) },
      }).success
    ).toBe(false)
    const duplicate = {
      ...order,
      lines: [
        order.lines[0],
        { ...order.lines[0], productId: order.lines[0].productId.toUpperCase() },
      ],
    }
    expect(liveOrderSchema.safeParse({ order: duplicate }).success).toBe(false)
    expect(
      liveOrderSchema.safeParse({ order: { ...duplicate, offerSelection: undefined } }).success
    ).toBe(true)
  })
  it('renders original prices, discount and actual charged amounts, and labels credit correctly', () => {
    const html = renderToStaticMarkup(<FiscalReceipt document={receipt} />)
    expect(html).toContain('Before offer, incl. VAT')
    expect(html).toContain('Offer discount')
    expect(html).toContain('10.00')
    expect(html).toContain('9.00')
    expect(html).toContain('0.43')
    expect(html).not.toContain('couponCode')
    expect(html).not.toContain('couponRequired')
    const credit = renderToStaticMarkup(
      <FiscalReceipt document={fiscalDocumentSchema.parse(fixtures.credit)} />
    )
    expect(credit).toContain('Original offer discount')
    expect(credit).toContain('Total credit AED')
  })
})
