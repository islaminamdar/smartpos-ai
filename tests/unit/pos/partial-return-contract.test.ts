import { describe, expect, it } from 'vitest'
import offerFixtures from '../../fixtures/pos-offer-documents.json'
import {
  fiscalDocumentSchema,
  originalReturnInvoiceSchema,
  partialCreditDocumentSchema,
  type ReceiptDocument,
} from '@/lib/pos/server/documents'
import {
  returnRequestSchema,
  returnStateSchema,
  returnPreviewSchema,
  validateReturnPreview,
  returnCreditMatchesCommand,
  type ReturnRequest,
  type ReturnState,
} from '@/lib/pos/server/returns'
import {
  allocateReturnAmounts,
  allocateReturnLine,
  allocateReturnPayments,
  cumulativeReturnComponent,
  originalReturnAmounts,
  returnAmountFields,
  subtractReturnAmounts,
  sumReturnAmounts,
} from '@/lib/pos/return-allocation'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const hash = 'b'.repeat(64)
const invoice: ReceiptDocument = {
  schemaVersion: 1,
  id: id(1),
  kind: 'tax_invoice',
  documentNumber: 'TEST-INV-0000000001',
  issuedAt: '2026-10-16T10:00:00Z',
  merchant: {
    id: id(2),
    organizationId: id(3),
    branchId: id(4),
    legalName: 'Synthetic return merchant',
    branchName: 'Test branch',
    address: 'Synthetic address',
    phone: 'Test phone',
    trn: '100000000000001',
    taxRegistered: true,
    currency: 'AED',
    timezone: 'Asia/Dubai',
    taxInclusive: true,
    calculationVersion: 'line-v2',
    confirmedBy: id(5),
    confirmedAt: '2026-10-16T09:00:00Z',
  },
  orderId: id(6),
  branchId: id(4),
  deviceId: id(7),
  shiftId: id(8),
  actorId: id(5),
  serviceType: 'takeaway',
  customer: null,
  lines: [
    {
      lineNumber: 1,
      productId: id(9),
      name: 'Weight',
      unit: 'kg',
      quantityMilli: 5,
      unitPriceFils: 2200,
      taxRateBps: 500,
      grossFils: 11,
      netFils: 10,
      taxFils: 1,
    },
    {
      lineNumber: 2,
      productId: id(9),
      name: 'Second original line',
      unit: 'piece',
      quantityMilli: 2000,
      unitPriceFils: 105,
      taxRateBps: 500,
      grossFils: 210,
      netFils: 200,
      taxFils: 10,
    },
  ],
  totals: { grossFils: 221, netFils: 210, taxFils: 11 },
  payments: [
    { method: 'cash', amountFils: 100 },
    { method: 'card', amountFils: 121 },
  ],
  paymentSettlement: 'recorded',
  cashTenderedFils: 100,
  changeFils: 0,
}
function stateFor(
  bill: ReceiptDocument,
  returned: number[] = bill.lines.map(() => 0),
  revision = 0
): ReturnState {
  const amounts = sumReturnAmounts(
    bill.lines.map((line, i) => allocateReturnAmounts(line, 0, returned[i]))
  )
  return returnStateSchema.parse({
    schemaVersion: 1,
    invoice: bill,
    revision,
    returned: bill.lines.map((line, i) => ({
      lineNumber: line.lineNumber,
      quantityMilli: returned[i],
    })),
    refundedPayments: allocateReturnPayments(
      bill.payments,
      0,
      amounts.grossFils,
      bill.totals.grossFils
    ),
    adjustedTotals: subtractReturnAmounts(originalReturnAmounts(bill.totals), amounts),
    fullyReturned: bill.lines.every((line, i) => line.quantityMilli === returned[i]),
  })
}
function previewFor(
  state: ReturnState,
  selections: { lineNumber: number; quantityMilli: number }[]
) {
  const request: ReturnRequest = {
    branchId: state.invoice.branchId,
    deviceId: id(20),
    shiftId: id(21),
    orderId: state.invoice.orderId,
    invoiceId: state.invoice.id,
    expectedRevision: state.revision,
    lines: selections,
    reason: 'Actual test return',
  }
  const lines = selections.map((selection, i) =>
    allocateReturnLine(
      state.invoice.lines[selection.lineNumber - 1],
      state.returned[selection.lineNumber - 1].quantityMilli,
      selection.quantityMilli,
      i + 1
    )
  )
  const totals = sumReturnAmounts(lines),
    { lines: _selected, ...scope } = request
  const preview = returnPreviewSchema.parse({
    ...scope,
    schemaVersion: 1,
    lines,
    previousAdjustedTotals: state.adjustedTotals,
    totals,
    adjustedTotals: subtractReturnAmounts(state.adjustedTotals, totals),
    payments: allocateReturnPayments(
      state.invoice.payments,
      state.invoice.totals.grossFils - state.adjustedTotals.grossFils,
      totals.grossFils,
      state.invoice.totals.grossFils
    ),
    fullyReturned: state.invoice.lines.every(
      (line, i) =>
        state.returned[i].quantityMilli +
          (selections.find((s) => s.lineNumber === line.lineNumber)?.quantityMilli ?? 0) ===
        line.quantityMilli
    ),
    quoteHash: hash,
  })
  return { request, preview }
}
function creditFor(
  state: ReturnState,
  selections: { lineNumber: number; quantityMilli: number }[]
) {
  const { request, preview } = previewFor(state, selections),
    bill = state.invoice
  const credit = {
    schemaVersion: 3,
    id: id(30),
    kind: 'tax_credit_note',
    documentNumber: 'TEST-CN-0000000001',
    issuedAt: '2026-10-16T11:00:00Z',
    merchant: bill.merchant,
    orderId: bill.orderId,
    branchId: bill.branchId,
    deviceId: request.deviceId,
    shiftId: request.shiftId,
    actorId: id(5),
    serviceType: bill.serviceType,
    customer: bill.customer,
    reason: request.reason,
    lines: preview.lines,
    totals: preview.totals,
    payments: preview.payments,
    paymentSettlement: 'recorded',
    originalInvoice: {
      documentId: bill.id,
      documentNumber: bill.documentNumber,
      issuedAt: bill.issuedAt,
      schemaVersion: bill.schemaVersion,
      totalFils: bill.totals.grossFils,
      taxFils: bill.totals.taxFils,
      netFils: bill.totals.netFils,
      beforeDiscountFils: originalReturnAmounts(bill.totals).beforeDiscountFils,
      discountFils: originalReturnAmounts(bill.totals).discountFils,
    },
    originalOffer: bill.schemaVersion === 2 ? bill.appliedOffer : null,
    previousAdjustedTotals: preview.previousAdjustedTotals,
    adjustedTotals: preview.adjustedTotals,
    returnRevision: state.revision + 1,
    fullyReturned: preview.fullyReturned,
    quoteHash: preview.quoteHash,
  }
  return {
    request,
    preview,
    credit,
    command: { id: id(40), type: 'refund.items' as const, ...request, quoteHash: hash },
  }
}

describe('partial return allocation conservation', () => {
  it('returns the exact saved undiscounted unit price and allocates discounts before VAT', () => {
    const original = {
      ...invoice.lines[1],
      quantityMilli: 3000,
      unitPriceFils: 101,
      grossFils: 303,
      netFils: 289,
      taxFils: 14,
    }
    const parts = [0, 1000, 2000].map((q) => allocateReturnAmounts(original, q, 1000))
    expect(parts.map((p) => p.grossFils)).toEqual([101, 101, 101])
    expect(parts.map((p) => p.taxFils)).toEqual([4, 5, 5])
    expect(sumReturnAmounts(parts)).toEqual(originalReturnAmounts(original))
    const discounted = {
      ...original,
      beforeDiscountFils: 303,
      discountFils: 101,
      grossFils: 202,
      netFils: 192,
      taxFils: 10,
    }
    const discountedParts = [0, 1000, 2000].map((q) => allocateReturnAmounts(discounted, q, 1000))
    expect(discountedParts.map((p) => p.beforeDiscountFils)).toEqual([101, 101, 101])
    expect(discountedParts.map((p) => p.discountFils)).toEqual([33, 34, 34])
    expect(discountedParts.map((p) => p.grossFils)).toEqual([68, 67, 67])
    expect(sumReturnAmounts(discountedParts)).toEqual(originalReturnAmounts(discounted))
    expect(() => allocateReturnAmounts({ ...original, beforeDiscountFils: 302 }, 0, 1000)).toThrow()
    expect(() => allocateReturnAmounts({ ...original, netFils: 290 }, 0, 1000)).toThrow()
  })
  it('conserves every original component across all unit partitions and never creates negative residuals', () => {
    let partitions = 0
    for (let q = 1; q <= 12; q++)
      for (let net = 0; net <= 16; net++)
        for (let tax = 0; tax <= 3; tax++)
          for (let discount = 0; discount <= 7; discount++) {
            const original = {
              ...invoice.lines[0],
              quantityMilli: q,
              netFils: net,
              taxFils: tax,
              grossFils: net + tax,
              discountFils: discount,
              beforeDiscountFils: net + tax + discount,
            }
            const all = Array.from({ length: q }, (_, before) =>
              allocateReturnAmounts(original, before, 1)
            )
            const sum = sumReturnAmounts(all)
            if (
              all.some((value) => returnAmountFields.some((field) => value[field] < 0)) ||
              sum.netFils !== net ||
              sum.taxFils !== tax ||
              sum.discountFils !== discount ||
              sum.grossFils !== net + tax ||
              sum.beforeDiscountFils !== net + tax + discount
            )
              throw Error(`Nonconserving partition ${q}/${net}/${tax}/${discount}`)
            partitions++
          }
    expect(partitions).toBe(6528)
  })
  it('keeps cash and card within their original caps at every partial return and exhausts both exactly', () => {
    for (let gross = 1; gross <= 70; gross++)
      for (let cash = 0; cash <= gross; cash++) {
        const original = (
          [
            { method: 'cash', amountFils: cash },
            { method: 'card', amountFils: gross - cash },
          ] as const
        ).filter((p) => p.amountFils > 0)
        let returnedCash = 0,
          returnedCard = 0
        for (let before = 0; before < gross; before++) {
          const delta = allocateReturnPayments(original, before, 1, gross)
          returnedCash += delta.find((p) => p.method === 'cash')?.amountFils ?? 0
          returnedCard += delta.find((p) => p.method === 'card')?.amountFils ?? 0
          if (
            returnedCash > cash ||
            returnedCard > gross - cash ||
            returnedCash + returnedCard !== before + 1
          )
            throw Error('Tender cap exceeded')
        }
        if (returnedCash !== cash || returnedCard !== gross - cash)
          throw Error('Tender not exhausted')
      }
  })
  it('keeps the final VAT residual and rejects unsafe integers, excess and fractional piece quantities', () => {
    expect(
      [0, 1, 2, 3, 4].map((before) => allocateReturnAmounts(invoice.lines[0], before, 1).grossFils)
    ).toEqual([2, 2, 2, 2, 3])
    expect(cumulativeReturnComponent(100_000_000, 999_999, 1_000_000)).toBe(99_999_900)
    for (const args of [
      [1, -1, 2],
      [1, 3, 2],
      [1, 1, 0],
      [1.1, 1, 2],
      [Number.MAX_SAFE_INTEGER, 1, 2],
    ])
      expect(() => cumulativeReturnComponent(...(args as [number, number, number]))).toThrow()
    expect(() => allocateReturnAmounts(invoice.lines[1], 0, 1)).toThrow()
    expect(() => allocateReturnAmounts(invoice.lines[0], 4, 2)).toThrow()
  })
})
describe('immutable partial return contracts', () => {
  it('accepts duplicate product IDs as separate original line identities and authentic fractional allocations', () => {
    expect(fiscalDocumentSchema.parse(invoice)).toEqual(invoice)
    const state = stateFor(invoice),
      { request, preview, credit, command } = creditFor(state, [
        { lineNumber: 1, quantityMilli: 1 },
      ])
    expect(validateReturnPreview(state, request, preview)).toEqual(preview)
    expect(partialCreditDocumentSchema.parse(credit)).toEqual(credit)
    expect(returnCreditMatchesCommand(command, credit, id(5))).toBe(true)
    expect(returnCreditMatchesCommand(command, credit, id(51))).toBe(false)
  })
  it('uses the previous adjusted supply value and carries the last original VAT and tender residual', () => {
    const state = stateFor(invoice, [4, 2000], 2),
      { request, preview, credit } = creditFor(state, [{ lineNumber: 1, quantityMilli: 1 }])
    expect(preview.totals).toMatchObject({ grossFils: 3, netFils: 2, taxFils: 1 })
    expect(preview.previousAdjustedTotals.grossFils).toBe(3)
    expect(preview.adjustedTotals.grossFils).toBe(0)
    expect(preview.fullyReturned).toBe(true)
    expect(validateReturnPreview(state, request, preview)).toEqual(preview)
    expect(fiscalDocumentSchema.safeParse(credit).success).toBe(true)
  })
  it('preserves every original offer and accepts a zero-value reward return with no fabricated tender', () => {
    let zero = false
    for (const raw of offerFixtures.receipts) {
      const bill = originalReturnInvoiceSchema.parse(raw),
        state = stateFor(bill)
      for (const line of bill.lines) {
        const { request, preview, credit } = creditFor(state, [
          { lineNumber: line.lineNumber, quantityMilli: line.quantityMilli },
        ])
        expect(validateReturnPreview(state, request, preview)).toEqual(preview)
        expect(fiscalDocumentSchema.safeParse(credit).success).toBe(true)
        if (line.grossFils === 0) {
          zero = true
          expect(preview.payments).toEqual([])
          expect(preview.totals.grossFils).toBe(0)
        }
      }
    }
    expect(zero).toBe(true)
  })
  it('rejects mismatched preview scope, selection, returned state, balances and original evidence', () => {
    const state = stateFor(invoice),
      { request, preview } = previewFor(state, [{ lineNumber: 2, quantityMilli: 1000 }])
    for (const altered of [
      { ...preview, invoiceId: id(90) },
      { ...preview, shiftId: id(90) },
      { ...preview, expectedRevision: 1 },
      { ...preview, reason: 'Other' },
      { ...preview, fullyReturned: true },
      { ...preview, lines: preview.lines.map((l) => ({ ...l, originalLineNumber: 1 })) },
      {
        ...preview,
        lines: preview.lines.map((l) => ({
          ...l,
          originalLine: { ...l.originalLine, name: 'Changed' },
        })),
      },
      { ...preview, payments: [{ method: 'cash', amountFils: preview.totals.grossFils }] },
    ])
      expect(() => validateReturnPreview(state, request, altered)).toThrow()
    expect(returnStateSchema.safeParse({ ...state, revision: 1 }).success).toBe(false)
    expect(
      returnStateSchema.safeParse({ ...state, returned: [{ lineNumber: 1, quantityMilli: 0 }] })
        .success
    ).toBe(false)
    expect(
      returnStateSchema.safeParse({
        ...state,
        refundedPayments: [{ method: 'cash', amountFils: 1 }],
      }).success
    ).toBe(false)
  })
  it('rejects tampered credit quantities, tax, discount, tender, original offer and request acknowledgement', () => {
    const state = stateFor(invoice),
      { credit, command } = creditFor(state, [{ lineNumber: 1, quantityMilli: 1 }])
    const bad = [
      { ...credit, returnRevision: 0 },
      { ...credit, quoteHash: 'bad' },
      { ...credit, fullyReturned: true },
      { ...credit, previousAdjustedTotals: { ...credit.previousAdjustedTotals, netFils: 209 } },
      { ...credit, lines: credit.lines.map((l) => ({ ...l, taxFils: 1, netFils: 1 })) },
      { ...credit, lines: credit.lines.map((l) => ({ ...l, returnedAfterQuantityMilli: 5 })) },
      {
        ...credit,
        lines: credit.lines.map((l) => ({
          ...l,
          returnedBeforeQuantityMilli: 1,
          returnedAfterQuantityMilli: 2,
        })),
      },
      { ...credit, originalInvoice: { ...credit.originalInvoice, schemaVersion: 2 } },
      { ...credit, payments: [{ method: 'cash', amountFils: 3 }] },
    ]
    for (const value of bad) expect(fiscalDocumentSchema.safeParse(value).success).toBe(false)
    for (const changed of [
      { ...command, invoiceId: id(60) },
      { ...command, quoteHash: 'c'.repeat(64) },
      { ...command, reason: 'Changed' },
      { ...command, lines: [{ lineNumber: 2, quantityMilli: 1 }] },
      { ...command, expectedRevision: 1 },
    ])
      expect(returnCreditMatchesCommand(changed, credit, id(5))).toBe(false)
  })
  it('rejects duplicate/out-of-order line selections, hidden text and caller authored amounts', () => {
    const { request } = previewFor(stateFor(invoice), [{ lineNumber: 1, quantityMilli: 1 }])
    for (const changed of [
      { ...request, lines: [...request.lines, ...request.lines] },
      { ...request, lines: [{ lineNumber: 2, quantityMilli: 1000 }, ...request.lines] },
      { ...request, reason: 'x\u0000y' },
      { ...request, branchId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
      { ...request, amountFils: 2 },
    ])
      expect(returnRequestSchema.safeParse(changed).success).toBe(false)
  })
})
