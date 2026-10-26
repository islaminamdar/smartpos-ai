import { describe, expect, it } from 'vitest'
import { fiscalDocumentSchema, merchantProfileSchema, type ReceiptDocument } from '@/lib/pos/server/documents'

const id = '00000000-0000-4000-8000-000000000001'
const date = '2026-10-16T10:00:00Z'
const invoice: ReceiptDocument = {
  schemaVersion: 1, id, kind: 'tax_invoice', documentNumber: 'TEST-INV-0000000001', issuedAt: date,
  merchant: { id, organizationId: id, branchId: id, legalName: 'Synthetic test merchant', branchName: 'Test branch', address: 'Test address', phone: 'Test phone', trn: '100000000000001', taxRegistered: true, currency: 'AED', timezone: 'Asia/Dubai', taxInclusive: true, calculationVersion: 'line-v2', confirmedBy: id, confirmedAt: date },
  orderId: id, branchId: id, deviceId: id, shiftId: id, actorId: id, serviceType: 'takeaway', customer: null,
  lines: ['One', 'Two'].map((name, index) => ({ lineNumber: index + 1, productId: id, name, unit: 'piece', quantityMilli: 1000, unitPriceFils: 300, taxRateBps: 500, grossFils: 300, netFils: 286, taxFils: 14 })),
  totals: { grossFils: 600, netFils: 572, taxFils: 28 },
  payments: [{ method: 'cash', amountFils: 200 }, { method: 'card', amountFils: 400 }], paymentSettlement: 'recorded', cashTenderedFils: 500, changeFils: 300,
}

describe('immutable live fiscal document response contract', () => {
  it('accepts confirmed server profile and reconciled mixed-tender receipt with per-line VAT', () => {
    expect(fiscalDocumentSchema.parse(invoice)).toEqual(invoice)
    expect(
      fiscalDocumentSchema.parse({
        ...invoice,
        lines: invoice.lines.map((line) => ({ ...line, category: 'Mithai' })),
      }).lines[0]?.category
    ).toBe('Mithai')
    expect(
      fiscalDocumentSchema.parse({
        ...invoice,
        lines: invoice.lines.map((line, index) =>
          index === 0 ? { ...line, modifiers: ['No sugar', 'Separate packing'] } : line
        ),
      }).lines[0]?.modifiers
    ).toEqual(['No sugar', 'Separate packing'])
    expect(merchantProfileSchema.safeParse({ ...invoice.merchant, taxInclusive: false }).success).toBe(false)
    expect(merchantProfileSchema.safeParse({ ...invoice.merchant, trn: 'unconfirmed' }).success).toBe(false)
    expect(merchantProfileSchema.safeParse({ ...invoice.merchant, password: 'must not be present' }).success).toBe(false)
  })
  it('rejects inconsistent VAT, totals, cash, line order, branch scope and document numbers', () => {
    for (const changes of [
      { totals: { ...invoice.totals, taxFils: 29 } },
      { changeFils: 301 },
      { cashTenderedFils: 199 },
      { lines: invoice.lines.map(line => ({ ...line, lineNumber: 1 })) },
      { branchId: '00000000-0000-4000-8000-000000000002' },
      { documentNumber: 'TEST-CN-0000000001' },
      { payments: [{ method: 'cash', amountFils: 600 }, { method: 'cash', amountFils: 1 }] },
    ]) expect(fiscalDocumentSchema.safeParse({ ...invoice, ...changes }).success).toBe(false)
  })
  it('requires buyer details beyond the simplified pilot limit', () => {
    const large = { ...invoice, lines: [{ ...invoice.lines[0], unitPriceFils: 1_050_000, grossFils: 1_050_000, netFils: 1_000_000, taxFils: 50_000 }], totals: { grossFils: 1_050_000, netFils: 1_000_000, taxFils: 50_000 }, payments: [{ method: 'card', amountFils: 1_050_000 }], cashTenderedFils: 0, changeFils: 0 }
    expect(fiscalDocumentSchema.safeParse(large).success).toBe(false)
    expect(fiscalDocumentSchema.safeParse({ ...large, customer: { name: 'Synthetic buyer', address: 'Buyer test address', trn: null } }).success).toBe(true)
  })
  it('validates an exact full-credit reversal and refuses partial or mismatched original amounts', () => {
    const { cashTenderedFils: _cash, changeFils: _change, ...common } = invoice
    const credit = { ...common, kind: 'tax_credit_note', documentNumber: 'TEST-CN-0000000001', reason: 'Full test cancellation', originalInvoice: { documentId: id, documentNumber: invoice.documentNumber, issuedAt: date, totalFils: 600, taxFils: 28 }, adjustedTotals: { grossFils: 0, netFils: 0, taxFils: 0 } }
    expect(fiscalDocumentSchema.safeParse(credit).success).toBe(true)
    expect(fiscalDocumentSchema.safeParse({ ...credit, originalInvoice: { ...credit.originalInvoice, taxFils: 29 } }).success).toBe(false)
    expect(fiscalDocumentSchema.safeParse({ ...credit, adjustedTotals: { grossFils: 100, netFils: 95, taxFils: 5 } }).success).toBe(false)
  })
})
