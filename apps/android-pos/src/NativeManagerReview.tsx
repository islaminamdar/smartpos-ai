import type { NativeIntent } from './native'

const date = (value: string) =>
  new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Dubai',
  }).format(new Date(value))
export function FrozenPaymentReview({
  intent,
  disabled,
  onCheck,
}: {
  intent: Extract<NativeIntent, { state: 'frozen_for_manager' }>
  disabled: boolean
  onCheck: () => void
}) {
  const review = intent.managerReview
  const pending = review.status === 'pending',
    conflict = review.status === 'conflict'
  return (
    <>
      <p className="access-note">
        {conflict
          ? 'The saved payment has conflicting records or needs support review. Its hold remains.'
          : pending
            ? 'Sent for review. A completed manager result is not available on this device yet.'
            : 'Saved on this device. Manager review has not been sent.'}
      </p>
      <p>
        Do not collect this payment again, repeat a return or void, or create another bill for it.
        Further receipt issuance and no-money cancellation are permanently blocked for this payment.
      </p>
      <p className="help">
        {conflict
          ? 'Contact your manager or support and keep this app’s data. A different payment, account or invoice allocation will not resolve the original record.'
          : pending
            ? 'A manager may still be reviewing the case, or the completed result may not be ready. Checking again retrieves the original result; it does not move money.'
            : 'Send the saved record when connected. A branch manager can review it on the website. Sending the record does not refund a payment or create an invoice.'}
      </p>
      <dl className="record-values">
        <div>
          <dt>Freeze reference</dt>
          <dd>
            <span className="reference">{review.freezeId}</span>
          </dd>
        </div>
        <div>
          <dt>Review delivery</dt>
          <dd>
            {conflict
              ? 'On hold · support review needed'
              : pending
                ? 'Sent · completed result pending'
                : 'Saved locally · not sent'}
          </dd>
        </div>
      </dl>
      <button className="secondary" disabled={disabled} onClick={onCheck}>
        {review.status === 'saved_locally' ? 'Send for manager review' : 'Check manager decision'}
      </button>
      <details className="counter-details">
        <summary>Support details</summary>
        <p>Saved proof fingerprint</p>
        <span className="reference">{review.proofSha256}</span>
      </details>
    </>
  )
}
export function AcceptedPaymentReview({
  intent,
}: {
  intent: Extract<NativeIntent, { state: 'manager_resolved' }>
}) {
  const review = intent.managerReview
  return (
    <>
      <p className="access-note">
        <strong>
          {review.decision === 'funds_returned'
            ? 'Manager’s full-return decision saved on this device.'
            : 'Manager’s card-authorization-void decision saved on this device.'}
        </strong>
      </p>
      <p>
        This device verified and saved the manager’s signed result for this original payment. Its
        payment-review hold is resolved locally.
      </p>
      <p className="help">
        This records the manager’s attestation. The app did not return money or void a card
        transaction. No tax invoice or credit note was issued for this payment. Do not collect it
        again or repeat the return or void.
      </p>
      <dl className="record-values">
        <div>
          <dt>Manager recorded</dt>
          <dd>{date(review.resolvedAt)} Dubai time</dd>
        </div>
        <div>
          <dt>Device record</dt>
          <dd>Signed result accepted and saved</dd>
        </div>
      </dl>
      <p className="help">
        Other counter checks may still block new sales. Check counter status before starting a
        different order.
      </p>
      <details className="counter-details">
        <summary>Support details</summary>
        <p>Payment reference</p>
        <span className="reference">{intent.intentId}</span>
        <p>Manager result reference</p>
        <span className="reference">{review.resolutionId}</span>
        <p>Freeze reference</p>
        <span className="reference">{review.freezeId}</span>
        <p>Saved proof fingerprint</p>
        <span className="reference">{review.proofSha256}</span>
      </details>
    </>
  )
}
