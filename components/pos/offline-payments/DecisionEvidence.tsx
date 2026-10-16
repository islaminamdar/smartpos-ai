import type { PaymentDecisionRequest } from '@/lib/pos/offline/payment-review-contracts'
import { money } from './decision'
import styles from './offline-payments.module.css'
const time = (instant: string) =>
  new Date(instant).toLocaleString('en-GB', {
    timeZone: 'Asia/Dubai',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
export default function DecisionEvidence({ request }: { request: PaymentDecisionRequest }) {
  return (
    <>
      {request.evidence.map((leg) => (
        <section className={styles.section} key={leg.method}>
          <h4>
            {leg.method === 'cash' ? 'Cash' : 'Card'} · {money(leg.amountFils)}
          </h4>
          <p>
            <strong>Reference:</strong> {leg.reference}
          </p>
          <p>
            {request.decision === 'payment_voided' ? 'Authorization observed' : 'Payment received'}:{' '}
            {time(leg.paymentObservedAt)} (Dubai)
            <br />
            {request.decision === 'payment_voided'
              ? 'Void completed'
              : 'Full return completed'}: {time(leg.completedAt)} (Dubai)
          </p>
          <p>
            <strong>Evidence:</strong> {leg.note}
          </p>
        </section>
      ))}
    </>
  )
}
