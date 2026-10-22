'use client'

import { browserUuid } from '@/lib/pos/browser-uuid'
import { useEffect, useState } from 'react'
import type {
  PaymentDecisionRequest,
  PaymentReviewDetail,
} from '@/lib/pos/offline/payment-review-contracts'
import { dubaiInstant, money, validateDecisionForCase } from './decision'
import styles from './offline-payments.module.css'
import DecisionEvidence from './DecisionEvidence'

type Leg = { observed: string; completed: string; reference: string; note: string }
const blankLeg = (): Leg => ({ observed: '', completed: '', reference: '', note: '' })
export default function DecisionForm({
  detail,
  disabled,
  saved,
  onSubmit,
}: {
  detail: PaymentReviewDetail
  disabled: boolean
  saved?: PaymentDecisionRequest
  onSubmit: (request: PaymentDecisionRequest, password: string) => Promise<void>
}) {
  const [decision, setDecision] = useState<PaymentDecisionRequest['decision']>('funds_returned')
  const [reason, setReason] = useState(''),
    [cash, setCash] = useState(blankLeg),
    [card, setCard] = useState(blankLeg)
  const [consent, setConsent] = useState(false),
    [password, setPassword] = useState(''),
    [error, setError] = useState('')
  const [requestId] = useState(() => browserUuid())
  const s = detail.summary
  const clearConsent = () => {
    setConsent(false)
    setPassword('')
    setError('')
  }
  useEffect(() => {
    const hide = () => {
      if (document.hidden) {
        setPassword('')
        setConsent(false)
      }
    }
    window.addEventListener('pagehide', clearConsent)
    document.addEventListener('visibilitychange', hide)
    return () => {
      window.removeEventListener('pagehide', clearConsent)
      document.removeEventListener('visibilitychange', hide)
    }
  }, []) // Form is remounted for each immutable case or saved request.
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (disabled || !consent || !password) return
    const currentPassword = password
    setPassword('')
    setConsent(false)
    setError('')
    try {
      const evidence = (['cash', 'card'] as const).flatMap((method) => {
        const amountFils = method === 'cash' ? s.cashFils : s.cardFils
        if (!amountFils) return []
        const value = method === 'cash' ? cash : card
        return [
          {
            method,
            amountFils,
            paymentObservedAt: dubaiInstant(value.observed),
            completedAt: dubaiInstant(value.completed),
            reference: value.reference.trim(),
            note: value.note.trim(),
          },
        ]
      })
      const request =
        saved ??
        validateDecisionForCase(
          {
            requestId,
            freezeId: s.freezeId!,
            freezeSha256: s.freezeSha256!,
            decision,
            reason: reason.trim(),
            evidence,
            cashDrawerShiftId: s.cashFils ? s.shiftId : null,
          },
          detail
        )
      await onSubmit(request, currentPassword)
    } catch (cause) {
      setError(
        cause instanceof Error && !('issues' in cause)
          ? cause.message
          : 'Complete every evidence field with valid dates, a reference, and a note.'
      )
    }
  }
  // A saved retry never rebuilds evidence from editable fields.
  const submitSaved = async (event: React.FormEvent) => {
    if (!saved) return submit(event)
    event.preventDefault()
    if (disabled || !consent || !password) return
    const currentPassword = password
    setPassword('')
    setConsent(false)
    setError('')
    try {
      await onSubmit(saved, currentPassword)
    } catch {
      setError('The same request is still saved. Check its server status before trying again.')
    }
  }
  const methodField = (method: 'cash' | 'card', value: Leg, setter: (v: Leg) => void) => (
    <fieldset key={method} disabled={disabled}>
      <legend>
        {method === 'cash' ? 'Cash' : 'Card'} · {money(method === 'cash' ? s.cashFils : s.cardFils)}{' '}
        in full
      </legend>
      <div className={styles.fields}>
        <label>
          {method === 'card' && decision === 'payment_voided'
            ? 'Authorization observed'
            : 'Payment received'}{' '}
          (Dubai time)
          <input
            type="datetime-local"
            required
            value={value.observed}
            onChange={(e) => {
              clearConsent()
              setter({ ...value, observed: e.target.value })
            }}
          />
        </label>
        <label>
          {decision === 'payment_voided' ? 'Void completed' : 'Full return completed'} (Dubai time)
          <input
            type="datetime-local"
            required
            value={value.completed}
            onChange={(e) => {
              clearConsent()
              setter({ ...value, completed: e.target.value })
            }}
          />
        </label>
        <label className={styles.full}>
          {method === 'cash' ? 'Cash return reference' : 'Provider / terminal reference'}
          <input
            required
            maxLength={120}
            value={value.reference}
            onChange={(e) => {
              clearConsent()
              setter({ ...value, reference: e.target.value })
            }}
          />
        </label>
        <label className={styles.full}>
          Evidence note
          <textarea
            required
            maxLength={400}
            value={value.note}
            onChange={(e) => {
              clearConsent()
              setter({ ...value, note: e.target.value })
            }}
          />
        </label>
      </div>
    </fieldset>
  )
  return (
    <form onSubmit={submitSaved} className={styles.section}>
      <h4>{saved ? 'Retry the exact saved decision' : 'Record a completed outcome'}</h4>
      <p className={styles.warning}>
        This records what you have already verified. It does not move money, contact a card
        provider, issue an invoice, or clear the Android device.
      </p>
      {saved ? (
        <>
          <p>
            Saved outcome:{' '}
            <strong>
              {saved.decision === 'funds_returned'
                ? 'Funds returned in full'
                : 'Card authorization voided'}
            </strong>
          </p>
          <p>{saved.reason}</p>
          <DecisionEvidence request={saved} />
          <p className={styles.reference}>Request {saved.requestId}</p>
        </>
      ) : (
        <>
          <label>
            Outcome
            <select
              disabled={disabled}
              value={decision}
              onChange={(e) => {
                clearConsent()
                setDecision(e.target.value as typeof decision)
              }}
            >
              <option value="funds_returned">All collected funds returned</option>
              {s.cashFils === 0 && (s.cardFils ?? 0) > 0 && (
                <option value="payment_voided">Card authorization voided before settlement</option>
              )}
            </select>
          </label>
          <p className={styles.help}>
            {decision === 'payment_voided'
              ? 'Use only a verified authorization void before settlement. A settled card refund belongs under funds returned.'
              : 'Every original cash and card amount must have been returned in full. Partial returns and mixed return/void outcomes need support.'}
          </p>
          <label>
            Reason
            <textarea
              required
              maxLength={240}
              disabled={disabled}
              value={reason}
              onChange={(e) => {
                clearConsent()
                setReason(e.target.value)
              }}
            />
          </label>
          {(s.cashFils ?? 0) > 0 && (
            <p className={styles.notice}>
              Cash must be returned from the same original open drawer. No different drawer is
              supported.<span className={styles.reference}>{s.shiftId}</span>
            </p>
          )}
          {(s.cashFils ?? 0) > 0 && methodField('cash', cash, setCash)}
          {(s.cardFils ?? 0) > 0 && methodField('card', card, setCard)}
          <p className={styles.help}>
            All times are Dubai time (UTC+4). Do not enter card numbers, security codes, passwords,
            or unnecessary customer information in evidence.
          </p>
        </>
      )}
      <label className={styles.confirm}>
        <input
          type="checkbox"
          checked={consent}
          disabled={disabled}
          onChange={(e) => setConsent(e.target.checked)}
        />
        <span>
          I verified this exact payment and the complete outcome above
          {(s.cashFils ?? 0) > 0 ? ', including the same original cash drawer' : ''}. I understand
          this decision cannot be edited after acceptance.
        </span>
      </label>
      <label>
        My current account password
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          disabled={disabled}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <button type="submit" className={styles.primary} disabled={disabled || !consent || !password}>
        {saved ? 'Retry saved decision' : 'Record verified outcome'}
      </button>
    </form>
  )
}
