import offerDocuments from '../../../fixtures/pos-offer-documents.json'
import { fiscalDocumentSchema, type ReceiptDocument } from '@/lib/pos/server/documents'
import {
  returnStateSchema,
  returnPreviewSchema,
  type ReturnState,
  type ReturnRequest,
} from '@/lib/pos/server/returns'
import {
  allocateReturnAmounts,
  allocateReturnLine,
  allocateReturnPayments,
  originalReturnAmounts,
  sumReturnAmounts,
  subtractReturnAmounts,
} from '@/lib/pos/return-allocation'
export const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const original = offerDocuments.receipts[0]
export const invoice = fiscalDocumentSchema.parse({
  schemaVersion: 1,
  kind: 'tax_invoice',
  id: id(1),
  documentNumber: 'QA-INV-0000000001',
  issuedAt: '2026-10-16T06:00:00Z',
  merchant: original.merchant,
  orderId: id(2),
  branchId: original.branchId,
  deviceId: original.deviceId,
  shiftId: original.shiftId,
  actorId: original.actorId,
  serviceType: 'takeaway',
  customer: null,
  lines: [
    {
      lineNumber: 1,
      productId: id(3),
      name: 'Pistachio cake',
      unit: 'kg',
      quantityMilli: 1500,
      unitPriceFils: 1050,
      taxRateBps: 500,
      grossFils: 1575,
      netFils: 1500,
      taxFils: 75,
    },
    {
      lineNumber: 2,
      productId: id(4),
      name: 'Masala tea',
      unit: 'piece',
      quantityMilli: 3000,
      unitPriceFils: 105,
      taxRateBps: 500,
      grossFils: 315,
      netFils: 300,
      taxFils: 15,
    },
    {
      lineNumber: 3,
      productId: id(4),
      name: 'Masala tea',
      unit: 'piece',
      quantityMilli: 1000,
      unitPriceFils: 105,
      taxRateBps: 500,
      grossFils: 105,
      netFils: 100,
      taxFils: 5,
    },
  ],
  totals: { grossFils: 1995, netFils: 1900, taxFils: 95 },
  payments: [
    { method: 'cash', amountFils: 1000 },
    { method: 'card', amountFils: 995 },
  ],
  paymentSettlement: 'recorded',
  cashTenderedFils: 1000,
  changeFils: 0,
}) as ReceiptDocument
export function stateFor(
  bill: ReceiptDocument = invoice,
  returned = bill.lines.map(() => 0)
): ReturnState {
  const totals = sumReturnAmounts(
    bill.lines.map((line, i) => allocateReturnAmounts(line, 0, returned[i]))
  )
  return returnStateSchema.parse({
    schemaVersion: 1,
    invoice: bill,
    revision: returned.some(Boolean) ? 1 : 0,
    returned: bill.lines.map((line, i) => ({
      lineNumber: line.lineNumber,
      quantityMilli: returned[i],
    })),
    refundedPayments: allocateReturnPayments(
      bill.payments,
      0,
      totals.grossFils,
      bill.totals.grossFils
    ),
    adjustedTotals: subtractReturnAmounts(originalReturnAmounts(bill.totals), totals),
    fullyReturned: bill.lines.every((line, i) => line.quantityMilli === returned[i]),
  })
}
export function previewFor(state: ReturnState, request: ReturnRequest) {
  const lines = request.lines.map((line, i) =>
    allocateReturnLine(
      state.invoice.lines[line.lineNumber - 1],
      state.returned[line.lineNumber - 1].quantityMilli,
      line.quantityMilli,
      i + 1
    )
  )
  const totals = sumReturnAmounts(lines)
  return returnPreviewSchema.parse({
    schemaVersion: 1,
    branchId: request.branchId,
    deviceId: request.deviceId,
    shiftId: request.shiftId,
    orderId: request.orderId,
    invoiceId: request.invoiceId,
    expectedRevision: request.expectedRevision,
    reason: request.reason,
    lines,
    previousAdjustedTotals: state.adjustedTotals,
    totals,
    adjustedTotals: subtractReturnAmounts(state.adjustedTotals, totals),
    payments: request.refundMethod
      ? totals.grossFils
        ? [{ method: request.refundMethod, amountFils: totals.grossFils }]
        : []
      : allocateReturnPayments(
          state.invoice.payments,
          state.invoice.totals.grossFils - state.adjustedTotals.grossFils,
          totals.grossFils,
          state.invoice.totals.grossFils
        ),
    fullyReturned: state.invoice.lines.every(
      (line, i) =>
        state.returned[i].quantityMilli +
          (request.lines.find((row) => row.lineNumber === line.lineNumber)?.quantityMilli ?? 0) ===
        line.quantityMilli
    ),
    quoteHash: 'a'.repeat(64),
  })
}
export function creditFor(state: ReturnState, request: ReturnRequest) {
  const preview = previewFor(state, request),
    bill = state.invoice
  return fiscalDocumentSchema.parse({
    schemaVersion: 3,
    kind: 'tax_credit_note',
    id: id(9),
    documentNumber: 'QA-CN-0000000001',
    issuedAt: '2026-10-16T07:00:00Z',
    merchant: bill.merchant,
    orderId: bill.orderId,
    branchId: bill.branchId,
    deviceId: request.deviceId,
    shiftId: request.shiftId,
    actorId: bill.actorId,
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
    returnRevision: request.expectedRevision + 1,
    fullyReturned: preview.fullyReturned,
    quoteHash: preview.quoteHash,
  })
}
export const offeredInvoice = fiscalDocumentSchema.parse(
  offerDocuments.receipts.find((value) => value.lines.some((line) => line.grossFils === 0))
) as ReceiptDocument
export const boot = {
  status: 'ready',
  userId: invoice.actorId,
  branches: [
    {
      id: invoice.branchId,
      organizationId: invoice.merchant.organizationId,
      name: 'Synthetic branch',
      role: 'manager',
      canSell: true,
      canRefund: true,
      canManageCash: true,
      profile: invoice.merchant,
    },
  ],
  catalogue: [],
  device: { id: invoice.deviceId, branchId: invoice.branchId, name: 'QA counter' },
  shifts: [
    {
      id: invoice.shiftId,
      deviceId: invoice.deviceId,
      branchId: invoice.branchId,
      openedBy: invoice.actorId,
      openedAt: invoice.issuedAt,
      openingCashFils: 10000,
      expectedCashFils: 10000,
    },
  ],
  capabilities: { onlineSales: true, offlineSales: false },
}
