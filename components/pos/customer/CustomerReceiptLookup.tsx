'use client'

import { useMemo, useState } from 'react'
import type { FiscalDocument } from '@/lib/pos/server/documents'

type ReceiptCustomer = NonNullable<FiscalDocument['customer']>
import {
  filterReceiptCustomerHistories,
  receiptCustomerHistories,
} from '@/lib/pos/customer-receipt-history'
import { formatFils } from '@/lib/pos/money'

type Props = {
  documents: FiscalDocument[]
  onUseCustomer: (customer: ReceiptCustomer) => void
}

/**
 * Searches only the receipts already visible to this branch staff member. It neither writes a
 * customer profile nor changes historical fiscal snapshots.
 */
export default function CustomerReceiptLookup({ documents, onUseCustomer }: Props) {
  const [query, setQuery] = useState('')
  const histories = useMemo(() => receiptCustomerHistories(documents), [documents])
  const visible = useMemo(
    () => filterReceiptCustomerHistories(histories, query).slice(0, 12),
    [histories, query]
  )

  return (
    <section className="lc-customer-lookup" aria-label="Recent invoice customer lookup">
      <h2>Customer from recent invoices</h2>
      <p className="lc-help">
        Search the receipts currently loaded for this branch. Choosing a customer fills this new
        invoice only; review the details before payment.
      </p>
      <label>
        Search name, address or TRN
        <input
          value={query}
          maxLength={400}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Start typing"
        />
      </label>
      {query.trim() && visible.length === 0 && <p>No matching customer in the loaded receipts.</p>}
      <ul>
        {visible.map((history) => (
          <li
            key={`${history.customer.name}\u001f${history.customer.address}\u001f${history.customer.trn ?? ''}`}
          >
            <button type="button" onClick={() => onUseCustomer(history.customer)}>
              <strong>{history.customer.name}</strong>
              <span>{history.customer.address}</span>
              {history.customer.trn && <span>TRN {history.customer.trn}</span>}
              <small>
                {history.invoiceCount} invoice{history.invoiceCount === 1 ? '' : 's'} · Net AED{' '}
                {formatFils(history.netSalesFils)}
                {history.creditCount
                  ? ` after ${history.creditCount} credit note${history.creditCount === 1 ? '' : 's'}`
                  : ''}
              </small>
            </button>
          </li>
        ))}
      </ul>
      {histories.length > 12 && !query.trim() && (
        <p className="lc-help">Search to narrow the loaded customer list.</p>
      )}
    </section>
  )
}
