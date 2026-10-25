import type { FiscalDocument } from './server/documents'

type ReceiptCustomer = NonNullable<FiscalDocument['customer']>

/**
 * A receipt snapshot is the only customer record in the pilot. These helpers deliberately
 * group by the full legal invoice identity, never by a fuzzy name match, so a new sale cannot
 * silently inherit another customer's address or TRN.
 */
export type ReceiptCustomerHistory = {
  customer: ReceiptCustomer
  invoiceCount: number
  creditCount: number
  grossSalesFils: number
  grossCreditsFils: number
  netSalesFils: number
  mostRecentIssuedAt: string
  documentIds: string[]
}

function fold(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

export function receiptCustomerKey(customer: ReceiptCustomer) {
  return [fold(customer.name), fold(customer.address), customer.trn ?? ''].join('\u001f')
}

/** Only documents already returned by the branch-authorised receipt API are included. */
export function receiptCustomerHistories(documents: FiscalDocument[]): ReceiptCustomerHistory[] {
  const histories = new Map<string, ReceiptCustomerHistory>()
  for (const document of documents) {
    if (!document.customer) continue
    const key = receiptCustomerKey(document.customer)
    const existing = histories.get(key)
    const row = existing ?? {
      customer: document.customer,
      invoiceCount: 0,
      creditCount: 0,
      grossSalesFils: 0,
      grossCreditsFils: 0,
      netSalesFils: 0,
      mostRecentIssuedAt: document.issuedAt,
      documentIds: [],
    }
    if (document.kind === 'tax_invoice') {
      row.invoiceCount += 1
      row.grossSalesFils += document.totals.grossFils
      row.netSalesFils += document.totals.grossFils
    } else {
      row.creditCount += 1
      row.grossCreditsFils += document.totals.grossFils
      row.netSalesFils -= document.totals.grossFils
    }
    if (document.issuedAt > row.mostRecentIssuedAt) row.mostRecentIssuedAt = document.issuedAt
    row.documentIds.push(document.id)
    histories.set(key, row)
  }
  return [...histories.values()].sort(
    (a, b) =>
      b.mostRecentIssuedAt.localeCompare(a.mostRecentIssuedAt) ||
      a.customer.name.localeCompare(b.customer.name)
  )
}

/** Search is for staff convenience only; it never becomes a new customer identity. */
export function filterReceiptCustomerHistories(
  histories: ReceiptCustomerHistory[],
  query: string
): ReceiptCustomerHistory[] {
  const term = fold(query)
  if (!term) return histories
  return histories.filter((history) =>
    [history.customer.name, history.customer.address, history.customer.trn ?? ''].some((value) =>
      fold(value).includes(term)
    )
  )
}
