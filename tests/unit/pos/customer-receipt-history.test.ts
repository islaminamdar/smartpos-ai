import { describe, expect, it } from 'vitest'
import {
  filterReceiptCustomerHistories,
  receiptCustomerHistories,
} from '@/lib/pos/customer-receipt-history'
import { fiscalDocumentSchema } from '@/lib/pos/server/documents'
import fixture from '../../fixtures/pos-offer-documents.json'

const source = fiscalDocumentSchema.parse(fixture.receipts[0])
const buyer = { name: '  Fatima  Ali ', address: 'Dubai Marina', trn: '100000000000001' }
function invoice(id: string, issuedAt: string, total: number) {
  return fiscalDocumentSchema.parse({
    schemaVersion: 1,
    id,
    kind: 'tax_invoice',
    documentNumber: `QA-INV-${id.slice(-10)}`,
    issuedAt,
    merchant: source.merchant,
    orderId: id,
    branchId: source.branchId,
    deviceId: source.deviceId,
    shiftId: source.shiftId,
    actorId: source.actorId,
    serviceType: 'takeaway',
    customer: buyer,
    lines: [
      {
        lineNumber: 1,
        productId: source.lines[0].productId,
        name: 'Test item',
        unit: 'piece',
        quantityMilli: 1000,
        unitPriceFils: total,
        taxRateBps: 500,
        grossFils: total,
        netFils: total - Math.round((total * 500) / 10500),
        taxFils: Math.round((total * 500) / 10500),
      },
    ],
    totals: {
      grossFils: total,
      netFils: total - Math.round((total * 500) / 10500),
      taxFils: Math.round((total * 500) / 10500),
    },
    payments: [{ method: 'cash', amountFils: total }],
    paymentSettlement: 'recorded',
    cashTenderedFils: total,
    changeFils: 0,
  })
}

describe('receipt customer history', () => {
  it('groups only the same complete invoice identity, normalising harmless whitespace', () => {
    const first = invoice('10000000-0000-4000-8000-000000000101', '2026-10-20T10:00:00.000Z', 105)
    const second = invoice('10000000-0000-4000-8000-000000000102', '2026-10-21T10:00:00.000Z', 210)
    const changedAddress = fiscalDocumentSchema.parse({
      ...second,
      id: '10000000-0000-4000-8000-000000000103',
      orderId: '10000000-0000-4000-8000-000000000103',
      documentNumber: 'QA-INV-0000000103',
      customer: { ...buyer, name: 'Fatima Ali', address: 'Different address' },
    })
    const histories = receiptCustomerHistories([first, second, changedAddress])
    expect(histories).toHaveLength(2)
    expect(histories.find((row) => row.customer.address === buyer.address)).toMatchObject({
      invoiceCount: 2,
      grossSalesFils: 315,
      netSalesFils: 315,
      mostRecentIssuedAt: second.issuedAt,
    })
  })

  it('searches receipt-derived data only and has no fuzzy identity merge', () => {
    const row = invoice('10000000-0000-4000-8000-000000000104', '2026-10-21T10:00:00.000Z', 105)
    const histories = receiptCustomerHistories([row])
    expect(filterReceiptCustomerHistories(histories, 'marina')).toHaveLength(1)
    expect(filterReceiptCustomerHistories(histories, '100000000000001')).toHaveLength(1)
    expect(filterReceiptCustomerHistories(histories, 'other customer')).toEqual([])
  })
})
