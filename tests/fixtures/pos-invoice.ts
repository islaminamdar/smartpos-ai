import type { ReceiptDocument } from "@/lib/pos/server/documents"
const id = '00000000-0000-4000-8000-000000000001'
const date = '2026-10-16T10:00:00Z'
export const invoice: ReceiptDocument = {
  schemaVersion: 1, id, kind: 'tax_invoice', documentNumber: 'TEST-INV-0000000001', issuedAt: date,
  merchant: { id, organizationId: id, branchId: id, legalName: 'Synthetic test merchant', branchName: 'Test branch', address: 'Test address', phone: 'Test phone', trn: '100000000000001', taxRegistered: true, currency: 'AED', timezone: 'Asia/Dubai', taxInclusive: true, calculationVersion: 'line-v2', confirmedBy: id, confirmedAt: date },
  orderId: id, branchId: id, deviceId: id, shiftId: id, actorId: id, serviceType: 'takeaway', customer: null,
  lines: ['One', 'Two'].map((name, index) => ({ lineNumber: index + 1, productId: id, name, unit: 'piece', quantityMilli: 1000, unitPriceFils: 300, taxRateBps: 500, grossFils: 300, netFils: 286, taxFils: 14 })),
  totals: { grossFils: 600, netFils: 572, taxFils: 28 },
  payments: [{ method: 'cash', amountFils: 200 }, { method: 'card', amountFils: 400 }], paymentSettlement: 'recorded', cashTenderedFils: 500, changeFils: 300,
}
