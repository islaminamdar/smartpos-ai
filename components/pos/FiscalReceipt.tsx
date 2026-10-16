'use client'

import { formatFils } from '@/lib/pos/money'
import type { FiscalDocument } from '@/lib/pos/server/documents'

export default function FiscalReceipt({ document: bill }: { document: FiscalDocument }) {
  const credit = bill.kind === 'tax_credit_note'
  const date = (value: string) =>
    new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', hour12: false })
  return (
    <article className="lc-receipt" aria-label={credit ? 'Tax credit note' : 'Tax invoice'}>
      <header>
        <h2>{bill.merchant.legalName}</h2>
        <p>
          {bill.merchant.branchName}
          <br />
          {bill.merchant.address}
          <br />
          {bill.merchant.phone}
        </p>
        <p>
          <strong>TRN {bill.merchant.trn}</strong>
        </p>
        <h3>{credit ? 'TAX CREDIT NOTE' : 'TAX INVOICE'}</h3>
        <p>
          <strong>{bill.documentNumber}</strong>
          <br />
          {date(bill.issuedAt)} GST
          <br />
          {bill.serviceType.replace('_', '-')}
        </p>
      </header>
      {bill.customer && (
        <section className="lc-receipt-customer">
          <strong>Customer: {bill.customer.name}</strong>
          <p>{bill.customer.address}</p>
          {bill.customer.trn && <p>Customer TRN: {bill.customer.trn}</p>}
        </section>
      )}
      {credit && (
        <section>
          <p>Reason: {bill.reason}</p>
          <p>
            Original invoice: {bill.originalInvoice.documentNumber}
            <br />
            Issued: {date(bill.originalInvoice.issuedAt)} GST
          </p>
        </section>
      )}
      <table>
        <thead>
          <tr>
            <th>Item / Qty × price incl. VAT</th>
            <th>AED</th>
          </tr>
        </thead>
        <tbody>
          {bill.lines.map((line) => (
            <tr key={line.lineNumber}>
              <td>
                {line.name}
                <small>
                  {line.quantityMilli / 1000}
                  {line.unit === 'kg' ? ' kg' : ` ${line.unit}`} × {formatFils(line.unitPriceFils)}
                  <br />
                  VAT {line.taxRateBps / 100}%: {formatFils(line.taxFils)}
                  <br />
                  Line excluding VAT: {formatFils(line.netFils)}
                </small>
              </td>
              <td>{formatFils(line.grossFils)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl>
        <div>
          <dt>{credit ? 'Net amount reversed' : 'Subtotal excluding VAT'}</dt>
          <dd>{formatFils(bill.totals.netFils)}</dd>
        </div>
        <div>
          <dt>{credit ? 'VAT reversed' : 'VAT'}</dt>
          <dd>{formatFils(bill.totals.taxFils)}</dd>
        </div>
        <div className="lc-receipt-total">
          <dt>{credit ? 'Total credit AED' : 'Total AED'}</dt>
          <dd>{formatFils(bill.totals.grossFils)}</dd>
        </div>
      </dl>
      {credit && <p>Invoice total after full credit: AED 0.00</p>}
      <dl>
        {bill.payments.map((payment) => (
          <div key={payment.method}>
            <dt>
              {payment.method === 'cash' ? 'Cash' : 'Card recorded'}
              {credit ? ' refund recorded' : ''}
            </dt>
            <dd>{formatFils(payment.amountFils)}</dd>
          </div>
        ))}
        {!credit && (
          <>
            <div>
              <dt>Cash tendered</dt>
              <dd>{formatFils(bill.cashTenderedFils)}</dd>
            </div>
            <div>
              <dt>Change</dt>
              <dd>{formatFils(bill.changeFils)}</dd>
            </div>
          </>
        )}
      </dl>
      <footer>
        Thank you for visiting.
        <br />
        Powered by Internext POS
      </footer>
    </article>
  )
}
