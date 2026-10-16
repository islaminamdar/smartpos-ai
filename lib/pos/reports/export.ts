import { csvTextCell } from '@/lib/pos/csv'
import type { BranchReport } from './contracts'
const money = (value: number) => (value / 100).toFixed(2)
/** Export only aggregate financial data, never buyer/staff identifiers or fiscal snapshots. */
export function reportCsv(report: BranchReport) {
  const rows: string[][] = [
    [
      'Branch',
      'From',
      'Through',
      'Timezone',
      'Section',
      'Date or key',
      'Label',
      'Unit',
      'Invoices',
      'Credit notes',
      'Sold quantity',
      'Refunded quantity',
      'Net quantity',
      'Sales including VAT (AED)',
      'Refunds including VAT (AED)',
      'Net including VAT (AED)',
      'Net excluding VAT (AED)',
      'Net VAT (AED)',
    ],
  ]
  const prefix = [report.branchName, report.startDate, report.endDate, report.timezone]
  const amountCells = (
    row: Pick<
      BranchReport['summary'],
      'salesGrossFils' | 'refundGrossFils' | 'netGrossFils' | 'netExVatFils' | 'vatFils'
    >
  ) => [
    money(row.salesGrossFils),
    money(row.refundGrossFils),
    money(row.netGrossFils),
    money(row.netExVatFils),
    money(row.vatFils),
  ]
  rows.push([
    ...prefix,
    'Summary',
    '',
    '',
    '',
    String(report.summary.invoiceCount),
    String(report.summary.creditNoteCount),
    '',
    '',
    '',
    ...amountCells(report.summary),
  ])
  for (const row of report.days)
    rows.push([
      ...prefix,
      'Day',
      row.date,
      '',
      '',
      String(row.invoiceCount),
      String(row.creditNoteCount),
      '',
      '',
      '',
      ...amountCells(row),
    ])
  for (const row of report.payments)
    rows.push([
      ...prefix,
      'Payment',
      row.method,
      row.method === 'card' ? 'Recorded card' : 'Cash',
      '',
      '',
      '',
      '',
      '',
      '',
      money(row.salesFils),
      money(row.refundsFils),
      money(row.netFils),
      '',
      '',
    ])
  for (const row of report.vatRates)
    rows.push([
      ...prefix,
      'VAT',
      String(row.taxRateBps),
      `${row.taxRateBps / 100}%`,
      '',
      '',
      '',
      '',
      '',
      '',
      ...amountCells(row),
    ])
  for (const row of report.products)
    rows.push([
      ...prefix,
      'Product',
      row.productId,
      row.name,
      row.unit,
      '',
      '',
      (row.soldQuantityMilli / 1000).toFixed(3),
      (row.refundedQuantityMilli / 1000).toFixed(3),
      (row.netQuantityMilli / 1000).toFixed(3),
      ...amountCells(row),
    ])
  rows.push([
    ...prefix,
    'Coverage',
    '',
    'Issued fiscal documents only; credit notes are deducted on their issue date. Recorded card payments do not prove terminal settlement.',
  ])
  rows.push([
    ...prefix,
    'Legacy orders excluded',
    String(report.legacyOrdersExcluded),
    'Orders received in range without an issued invoice are excluded.',
  ])
  rows.push([...prefix, 'Generated at', report.generatedAt])
  // All strings are protected, including formula-like imported menu/branch names. Numeric negative
  // values are emitted as numeric cells so refunds remain calculable in spreadsheet applications.
  return (
    '\uFEFF' +
    rows
      .map((row, index) =>
        row
          .map((value, column) =>
            index > 0 && column >= 8 && /^-?\d+(\.\d+)?$/.test(value) ? value : csvTextCell(value)
          )
          .join(',')
      )
      .join('\r\n') +
    '\r\n'
  )
}
