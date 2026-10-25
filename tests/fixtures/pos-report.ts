import type { BranchReport } from '@/lib/pos/reports/contracts'
export const reportBranch = '10000000-0000-4000-8000-000000000001'
const amounts = {
  salesGrossFils: 1050,
  refundGrossFils: 0,
  netGrossFils: 1050,
  netExVatFils: 1000,
  vatFils: 50,
}
export const branchReport: BranchReport = {
  status: 'ready',
  branchId: reportBranch,
  branchName: 'Synthetic branch',
  currency: 'AED',
  timezone: 'Asia/Dubai',
  startDate: '2026-10-16',
  endDate: '2026-10-16',
  generatedAt: '2026-10-16T12:00:00Z',
  basis: 'issued_fiscal_documents',
  documentCount: 1,
  legacyOrdersExcluded: 0,
  summary: { ...amounts, invoiceCount: 1, creditNoteCount: 0 },
  days: [{ date: '2026-10-16', ...amounts, invoiceCount: 1, creditNoteCount: 0 }],
  payments: [
    { method: 'cash', salesFils: 600, refundsFils: 0, netFils: 600 },
    { method: 'card', salesFils: 450, refundsFils: 0, netFils: 450 },
    { method: 'bank_transfer', salesFils: 0, refundsFils: 0, netFils: 0 },
  ],
  vatRates: [{ taxRateBps: 500, ...amounts }],
  products: [
    {
      productId: '20000000-0000-4000-8000-000000000001',
      name: 'Sweet',
      unit: 'kg',
      soldQuantityMilli: 500,
      refundedQuantityMilli: 0,
      netQuantityMilli: 500,
      ...amounts,
    },
  ],
  categoryAnalytics: { documentCount: 1, excludedDocumentCount: 0, ...amounts },
  categories: [
    {
      category: 'Mithai',
      soldQuantityMilli: 500,
      refundedQuantityMilli: 0,
      netQuantityMilli: 500,
      ...amounts,
    },
  ],
}
