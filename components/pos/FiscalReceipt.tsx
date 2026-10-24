'use client'

import { matchingMerchantBranding, type MerchantBranding } from '@/lib/pos/branding'
import { formatFils } from '@/lib/pos/money'
import type { FiscalDocument } from '@/lib/pos/server/documents'

export default function FiscalReceipt({
  document: bill,
  branding,
}: {
  document: FiscalDocument
  branding?: MerchantBranding | null
}) {
  const receiptBranding = matchingMerchantBranding(branding, {
    organizationId: bill.merchant.organizationId,
    branchId: bill.merchant.branchId,
    profileId: bill.merchant.id,
  })
  const credit = bill.kind === 'tax_credit_note'
  const itemReturn = bill.schemaVersion === 3
  const offer =
    bill.schemaVersion === 2
      ? bill.appliedOffer
      : bill.schemaVersion === 3
        ? bill.originalOffer
        : null
  const date = (value: string) =>
    new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', hour12: false })
  return (
    <article className="lc-receipt" aria-label={credit ? 'Tax credit note' : 'Tax invoice'}>
      <header>
        {receiptBranding && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="lc-receipt-logo"
            src={receiptBranding.logoPath}
            width={80}
            height={80}
            alt={`${receiptBranding.displayName} logo`}
          />
        )}
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
      {offer && (
        <section className="lc-receipt-offer">
          <strong>
            {credit ? 'Original offer' : 'Offer'}: {offer.offerName}
          </strong>
          {offer.benefit.kind === 'percentage' && (
            <span> · {offer.benefit.basisPoints / 100}%</span>
          )}
          <p>Discounts are included in the line amounts below.</p>
        </section>
      )}
      <table>
        <thead>
          <tr>
            <th>
              {itemReturn ? 'Returned item / original allocation' : 'Item / Qty × price incl. VAT'}
            </th>
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
                  {line.unit === 'kg' ? ' kg' : ` ${line.unit}`}
                  {'originalLineNumber' in line ? (
                    <>
                      {' '}
                      · Original line {line.originalLineNumber}
                      <br />
                      Originally returned {line.returnedBeforeQuantityMilli / 1000} → now{' '}
                      {line.returnedAfterQuantityMilli / 1000} {line.unit}
                      <br />
                      Original unit price: {formatFils(line.unitPriceFils)}
                    </>
                  ) : (
                    <> × {formatFils(line.unitPriceFils)}</>
                  )}
                  <br />
                  {'discountFils' in line && line.discountFils > 0 && (
                    <>
                      {itemReturn ? 'Allocated before discount' : 'Before offer'}:{' '}
                      {formatFils(line.beforeDiscountFils)} · Discount: −
                      {formatFils(line.discountFils)}
                      <br />
                    </>
                  )}
                  VAT {line.taxRateBps / 100}%{itemReturn ? ' allocated' : ''}:{' '}
                  {formatFils(line.taxFils)}
                  <br />
                  Line excluding VAT: {formatFils(line.netFils)}
                </small>
              </td>
              <td>{formatFils(line.grossFils)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {itemReturn && (
        <p>
          Return amounts allocate the original billed net amount, VAT and discount. Rounding follows
          cumulative returned quantities; this is not a new price calculation.
        </p>
      )}
      <dl>
        {(bill.schemaVersion === 2 || bill.schemaVersion === 3) && (
          <>
            <div>
              <dt>
                {itemReturn
                  ? 'Returned amount before original discount'
                  : credit
                    ? 'Original amount before offer'
                    : 'Before offer, incl. VAT'}
              </dt>
              <dd>{formatFils(bill.totals.beforeDiscountFils)}</dd>
            </div>
            <div>
              <dt>
                {itemReturn
                  ? 'Original discount allocated to return'
                  : credit
                    ? 'Original offer discount'
                    : 'Offer discount'}
              </dt>
              <dd>−{formatFils(bill.totals.discountFils)}</dd>
            </div>
          </>
        )}
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
      {bill.schemaVersion === 3 ? (
        <section aria-label="Invoice adjustment history">
          <h4>Invoice balance for this adjustment</h4>
          <dl>
            <div>
              <dt>Before this credit, excluding VAT</dt>
              <dd>{formatFils(bill.previousAdjustedTotals.netFils)}</dd>
            </div>
            <div>
              <dt>VAT before this credit</dt>
              <dd>{formatFils(bill.previousAdjustedTotals.taxFils)}</dd>
            </div>
            <div>
              <dt>Total before this credit</dt>
              <dd>{formatFils(bill.previousAdjustedTotals.grossFils)}</dd>
            </div>
            <div>
              <dt>Remaining excluding VAT</dt>
              <dd>{formatFils(bill.adjustedTotals.netFils)}</dd>
            </div>
            <div>
              <dt>Remaining VAT</dt>
              <dd>{formatFils(bill.adjustedTotals.taxFils)}</dd>
            </div>
            <div>
              <dt>Remaining invoice total</dt>
              <dd>{formatFils(bill.adjustedTotals.grossFils)}</dd>
            </div>
          </dl>
          <p>
            {bill.fullyReturned
              ? 'All original quantities have been returned.'
              : 'Other original quantities remain available for return.'}
          </p>
          {bill.totals.grossFils === 0 && (
            <p>
              <strong>No refund due. Returned quantities recorded; no cash or card refund.</strong>
            </p>
          )}
        </section>
      ) : (
        credit && <p>Invoice total after full credit: AED 0.00</p>
      )}
      <dl>
        {bill.payments.map((payment) => (
          <div key={payment.method}>
            <dt>
              {credit
                ? payment.method === 'cash'
                  ? 'Cash refund recorded'
                  : payment.method === 'bank_transfer'
                    ? 'Refunded by bank transfer'
                    : 'Card refund to arrange'
                : payment.method === 'cash'
                  ? 'Cash'
                  : 'Card recorded'}
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
