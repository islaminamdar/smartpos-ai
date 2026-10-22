'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  paymentReviewListSchema,
  paymentReviewDetailSchema,
  paymentDecisionResponseSchema,
  type PaymentReviewDetail,
  type PaymentReviewList,
  type PaymentReviewSummary,
  type PaymentDecisionRequest,
} from '@/lib/pos/offline/payment-review-contracts'
import {
  acknowledgePaymentReview,
  paymentReviewJournalEvent,
  readPendingPaymentReviews,
  samePaymentDecision,
  savePendingPaymentReview,
  type PendingPaymentReview,
} from './journal'
import { eligible, money, validateDecisionForCase } from './decision'
import DecisionForm from './DecisionForm'
import DecisionEvidence from './DecisionEvidence'
import styles from './offline-payments.module.css'

type Props = {
  actorId: string
  branchId: string
  branchName: string
  disabled?: boolean
  allowDecisions?: boolean
  onBusyChange?: (busy: boolean) => void
  onPendingChange?: (pending: boolean) => void
}
const api = '/api/pos/manager/offline-payments'
const labels: Record<PaymentReviewSummary['state'], string> = {
  pending: 'Awaiting manager review',
  conflict: 'Conflicting records · on hold',
  unsupported_text: 'Original text needs support',
  delivery_pending: 'Decision saved · signature pending',
  resolved: 'Signed result ready',
}
async function readJson(url: string, init?: RequestInit) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'Sign in again to check this payment.'
        : response.status === 403
          ? 'This account cannot review this payment, or manager decisions are not enabled.'
          : 'The server could not confirm this request. Check the saved case before retrying.'
    )
  return response.json()
}
const exactFreeze = (detail: PaymentReviewDetail, pending: PendingPaymentReview) =>
  detail.summary.caseId === pending.caseId &&
  detail.summary.branchId === pending.branchId &&
  detail.summary.freezeId === pending.request.freezeId &&
  detail.summary.freezeSha256 === pending.request.freezeSha256
function accepted(detail: PaymentReviewDetail, pending: PendingPaymentReview) {
  return (
    exactFreeze(detail, pending) &&
    !!detail.decisionRequest &&
    samePaymentDecision(detail.decisionRequest, pending.request) &&
    detail.resolution?.managerActorId === pending.actorId &&
    detail.resolution.branchId === pending.branchId &&
    detail.resolution.decision === pending.request.decision &&
    detail.resolution.paymentIntentId === detail.summary.paymentIntentId &&
    detail.resolution.requestId === pending.request.requestId &&
    detail.resolution.freezeId === pending.request.freezeId &&
    detail.resolution.freezeSha256 === pending.request.freezeSha256
  )
}
export default function OfflinePaymentReviews(props: Props) {
  return <ScopedReviews key={`${props.actorId}:${props.branchId}`} {...props} />
}
function ScopedReviews({
  actorId,
  branchId,
  branchName,
  disabled = false,
  allowDecisions = true,
  onBusyChange,
  onPendingChange,
}: Props) {
  const [list, setList] = useState<PaymentReviewList | null>(null),
    [detail, setDetail] = useState<PaymentReviewDetail | null>(null)
  const [selected, setSelected] = useState<{ caseId: string; caseKind: 'freeze' | 'raw' } | null>(
    null
  )
  const [pending, setPending] = useState<PendingPaymentReview | null>(null),
    [journalReady, setJournalReady] = useState(false)
  const [busy, setBusy] = useState(false),
    [fresh, setFresh] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('')
  const [dismiss, setDismiss] = useState(false),
    [formEpoch, setFormEpoch] = useState(0)
  const listRef = useRef<HTMLDivElement>(null),
    detailRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (fresh && detail && window.matchMedia?.('(max-width: 900px)').matches)
      detailRef.current?.scrollIntoView({ block: 'start' })
  }, [fresh, detail])
  const mounted = useRef(true),
    epoch = useRef(0),
    locked = useRef(false)
  const callbacks = useRef({ onBusyChange, onPendingChange })
  callbacks.current = { onBusyChange, onPendingChange }
  useEffect(() => {
    mounted.current = true
    const generation = epoch
    return () => {
      mounted.current = false
      locked.current = false
      generation.current++
      callbacks.current.onBusyChange?.(false)
    }
  }, [])
  const setOperation = (value: boolean) => {
    locked.current = value
    if (mounted.current) setBusy(value)
    callbacks.current.onBusyChange?.(value)
  }
  const scan = useCallback(async () => {
    try {
      const records = await readPendingPaymentReviews(actorId)
      if (!mounted.current) return
      setPending(records.find((record) => record.branchId === branchId) ?? null)
      setJournalReady(true)
      callbacks.current.onPendingChange?.(records.length > 0)
    } catch (cause) {
      if (!mounted.current) return
      setJournalReady(false)
      setFresh(false)
      callbacks.current.onPendingChange?.(true)
      setError(
        cause instanceof Error
          ? cause.message
          : 'Saved decisions could not be read. Keep browser data intact.'
      )
    }
  }, [actorId, branchId])
  useEffect(() => {
    void scan()
    const changed = () => {
      void scan()
    }
    window.addEventListener(paymentReviewJournalEvent, changed)
    window.addEventListener('focus', changed)
    let channel: BroadcastChannel | null = null
    try {
      channel = new BroadcastChannel(paymentReviewJournalEvent)
      channel.onmessage = changed
    } catch {
      /* Focus scan remains available. */
    }
    return () => {
      window.removeEventListener(paymentReviewJournalEvent, changed)
      window.removeEventListener('focus', changed)
      channel?.close()
    }
  }, [scan])
  async function loadList(cursor?: string) {
    if (locked.current || disabled) return
    setOperation(true)
    setFresh(false)
    setError('')
    const token = ++epoch.current
    try {
      const query = new URLSearchParams({ branchId })
      if (cursor) query.set('cursor', cursor)
      const next = paymentReviewListSchema.parse(await readJson(`${api}?${query}`))
      if (next.branchId !== branchId || next.cases.some((item) => item.branchId !== branchId))
        throw new Error('Case list scope differs. Refresh the branch.')
      if (mounted.current && token === epoch.current) setList(next)
    } catch (cause) {
      if (mounted.current && token === epoch.current)
        setError(cause instanceof Error ? cause.message : 'The case list is unavailable.')
    } finally {
      if (mounted.current && token === epoch.current) setOperation(false)
    }
  }
  // Initial read only; the scoped instance remounts for a different actor or branch.
  useEffect(() => {
    void loadList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  async function readDetail(
    target: { caseId: string; caseKind: 'freeze' | 'raw' },
    token: number,
    saved = pending
  ) {
    const query = new URLSearchParams({
      branchId,
      caseId: target.caseId,
      caseKind: target.caseKind,
    })
    const next = paymentReviewDetailSchema.parse(await readJson(`${api}/case?${query}`))
    if (
      next.summary.branchId !== branchId ||
      next.summary.caseId !== target.caseId ||
      next.summary.caseKind !== target.caseKind
    )
      throw new Error('The returned case does not match this branch and payment.')
    if (!mounted.current || token !== epoch.current) return null
    setDetail(next)
    setList((previous) =>
      previous
        ? {
            ...previous,
            cases: previous.cases.map((item) =>
              item.caseId === next.summary.caseId && item.caseKind === next.summary.caseKind
                ? next.summary
                : item
            ),
          }
        : previous
    )
    setFresh(true)
    if (saved && accepted(next, saved)) {
      await acknowledgePaymentReview(saved)
      if (!mounted.current || token !== epoch.current) return null
      setPending(null)
      await scan()
      setMessage('The exact saved decision is accepted. Device confirmation is still unavailable.')
    }
    return next
  }
  async function open(target: { caseId: string; caseKind: 'freeze' | 'raw' }) {
    if (locked.current || disabled) return
    setOperation(true)
    setSelected(target)
    setFresh(false)
    setDismiss(false)
    setError('')
    setMessage('')
    setFormEpoch((value) => value + 1)
    if (detail?.summary.caseId !== target.caseId) setDetail(null)
    const token = ++epoch.current
    try {
      await readDetail(target, token)
    } catch (cause) {
      if (mounted.current && token === epoch.current) {
        setFresh(false)
        setError(cause instanceof Error ? cause.message : 'The case could not be verified.')
      }
    } finally {
      if (mounted.current && token === epoch.current) setOperation(false)
    }
  }
  useEffect(() => {
    const hide = () => {
      if (!document.hidden) return
      setFresh(false)
      setFormEpoch((value) => value + 1)
      setDismiss(false)
      // A submitted operation may finish, but its response cannot repopulate a hidden review.
      epoch.current++
      locked.current = false
      setBusy(false)
      callbacks.current.onBusyChange?.(false)
    }
    document.addEventListener('visibilitychange', hide)
    return () => document.removeEventListener('visibilitychange', hide)
  }, [])
  async function submit(request: PaymentDecisionRequest, currentPassword: string) {
    if (
      locked.current ||
      disabled ||
      !allowDecisions ||
      !journalReady ||
      !fresh ||
      !detail ||
      !eligible(detail)
    )
      return
    const checked = validateDecisionForCase(request, detail)
    if (pending && !samePaymentDecision(pending.request, checked))
      throw new Error('Recover the original saved decision first.')
    setOperation(true)
    setError('')
    setFresh(false)
    const token = ++epoch.current
    const record = pending ?? { actorId, branchId, caseId: detail.summary.caseId, request: checked }
    try {
      if (!pending) await savePendingPaymentReview(record)
      if (!mounted.current || token !== epoch.current) return
      setPending(record)
      callbacks.current.onPendingChange?.(true)
      const result = paymentDecisionResponseSchema.parse(
        await readJson(`${api}/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ branchId, request: checked, currentPassword }),
        })
      )
      if (!mounted.current || token !== epoch.current) return
      if (
        !samePaymentDecision(result.decisionRequest, checked) ||
        result.resolution.managerActorId !== actorId ||
        result.resolution.branchId !== branchId ||
        result.resolution.decision !== checked.decision ||
        result.resolution.freezeId !== checked.freezeId ||
        result.resolution.freezeSha256 !== checked.freezeSha256 ||
        result.resolution.requestId !== checked.requestId
      )
        throw new Error('The response did not confirm the exact saved decision.')
      // Detail is authoritative after success as well as uncertainty; no replacement request is generated.
      await readDetail({ caseId: record.caseId, caseKind: 'freeze' }, token, record)
      if (mounted.current && token === epoch.current)
        setMessage(
          result.status === 'delivery_pending'
            ? 'Decision saved. Its signature is pending; do not return funds again.'
            : 'Signed result ready. Check the original Android device to confirm it accepted the decision.'
        )
    } catch (cause) {
      if (mounted.current && token === epoch.current) {
        setFresh(false)
        setError(
          cause instanceof Error
            ? cause.message
            : 'The decision is uncertain. Check the same saved case before retrying.'
        )
        await scan()
      }
    } finally {
      currentPassword = ''
      if (mounted.current && token === epoch.current) setOperation(false)
    }
  }
  const superseded = !!(
    pending &&
    detail &&
    fresh &&
    exactFreeze(detail, pending) &&
    detail.decisionRequest &&
    detail.resolution &&
    detail.resolution.freezeId === pending.request.freezeId &&
    detail.resolution.freezeSha256 === pending.request.freezeSha256 &&
    detail.resolution.requestId === detail.decisionRequest.requestId &&
    !samePaymentDecision(detail.decisionRequest, pending.request)
  )
  async function dismissRetry() {
    if (!superseded || !dismiss || !pending || busy || disabled) return
    setOperation(true)
    try {
      await acknowledgePaymentReview(pending)
      if (mounted.current) {
        setPending(null)
        setDismiss(false)
        await scan()
        setMessage(
          'Only the local retry was dismissed. The accepted decision and device records are unchanged.'
        )
      }
    } catch {
      if (mounted.current)
        setError('The local retry could not be dismissed. Keep browser data intact.')
    } finally {
      if (mounted.current) setOperation(false)
    }
  }
  const canForm = !!(
    allowDecisions &&
    detail &&
    eligible(detail) &&
    fresh &&
    journalReady &&
    (!pending || exactFreeze(detail, pending))
  )
  return (
    <section className={styles.board} aria-label="Offline payment reviews">
      <header className={styles.header}>
        <div>
          <p className={styles.scope}>{branchName} · Manager review</p>
          <h2>Offline payment reviews</h2>
          <p className={styles.help}>
            Review money already handled outside the app. No replacement bill or new payment is
            created here.
          </p>
        </div>
        <button disabled={busy || disabled} onClick={() => void loadList()}>
          Refresh cases
        </button>
      </header>
      {!allowDecisions && (
        <p className={styles.warning}>
          New manager decisions and retries are disabled. Your exact saved request is retained;
          checking its server status does not submit it again.
        </p>
      )}
      <p className={styles.notice}>
        Device confirmation is not available on this screen. A saved or signed manager decision does
        not show whether the original Android device has accepted it, or prove a provider processed
        a payment.
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {message && (
        <p role="status" className={styles.notice}>
          {message}
        </p>
      )}
      {pending && (
        <div className={styles.warning}>
          <strong>A decision is saved on this browser.</strong>
          <p>
            Check its server status before any retry. Do not repeat the external return or void.
          </p>
          <button
            disabled={busy || disabled}
            onClick={() => void open({ caseId: pending.caseId, caseKind: 'freeze' })}
          >
            Check saved decision
          </button>
        </div>
      )}
      <div className={styles.layout}>
        <div>
          <div ref={listRef} className={styles.list} aria-label="Review cases">
            {list?.cases.map((item) => (
              <button
                className={styles.caseButton}
                key={`${item.caseKind}:${item.caseId}`}
                aria-pressed={
                  selected?.caseId === item.caseId && selected.caseKind === item.caseKind
                }
                disabled={busy || disabled}
                onClick={() => void open(item)}
              >
                <span className={styles.caseTop}>
                  <strong>{item.deviceName}</strong>
                  <strong>{money(item.grossFils)}</strong>
                </span>
                <span className={styles.tag}>{labels[item.state]}</span>
                <span className={styles.meta}>
                  {new Date(item.recordedAt).toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })} ·
                  Dubai
                </span>
                <span className={styles.reference}>Payment {item.paymentIntentId.slice(0, 8)}</span>
              </button>
            ))}
          </div>
          {list?.cases.length === 0 && (
            <p className={styles.empty}>No review cases on this page.</p>
          )}
          <div className={styles.pagination}>
            <button disabled={busy || disabled || !list} onClick={() => void loadList()}>
              First page
            </button>
            <button
              disabled={busy || disabled || !list?.nextCursor}
              onClick={() => void loadList(list?.nextCursor ?? undefined)}
            >
              Next page
            </button>
          </div>
          <p className={styles.help}>
            Up to 50 cases per page. This is not a count of every branch case.
          </p>
        </div>
        <div ref={detailRef} className={styles.detail}>
          {!detail ? (
            <p className={styles.empty}>
              {busy ? 'Loading saved records…' : 'Choose a payment to inspect its original record.'}
            </p>
          ) : (
            <>
              <div className={styles.header}>
                <div>
                  <h3>{detail.summary.deviceName}</h3>
                  <p className={styles.tag}>{labels[detail.summary.state]}</p>
                </div>
                <button disabled={busy || disabled} onClick={() => selected && void open(selected)}>
                  Check case status
                </button>
              </div>
              {!fresh && (
                <p className={styles.warning}>
                  This view has not been freshly verified. Decisions are disabled until you check
                  case status.
                </p>
              )}
              <button
                className={styles.back}
                onClick={() => listRef.current?.scrollIntoView({ block: 'start' })}
              >
                Back to case list
              </button>
              <Evidence detail={detail} />
              {!eligible(detail) && !detail.decisionRequest && (
                <p className={styles.warning}>
                  {!detail.capabilities.policyEnabled
                    ? 'Manager decisions are not enabled for this branch.'
                    : detail.summary.caseKind === 'raw' ||
                        detail.summary.state === 'unsupported_text'
                      ? 'Original signed text is retained. Support must review this case; it cannot be decided here.'
                      : detail.summary.state === 'conflict' || detail.conflicts.length
                        ? 'Conflicting evidence needs support. Do not return funds again or create another bill.'
                        : !detail.capabilities.originalShiftOpen &&
                            (detail.summary.cashFils ?? 0) > 0
                          ? 'The original cash drawer is closed. A different drawer cannot be used here.'
                          : 'This case is on hold. Check its status or contact support.'}
                </p>
              )}
              {detail.decisionRequest && (
                <section className={styles.section}>
                  <h4>Accepted manager decision</h4>
                  <p>
                    <strong>
                      {detail.decisionRequest.decision === 'funds_returned'
                        ? 'All funds returned'
                        : 'Card authorization voided'}
                    </strong>
                  </p>
                  <p>{detail.decisionRequest.reason}</p>
                  <DecisionEvidence request={detail.decisionRequest} />
                  <p>
                    {detail.resolutionEnvelope
                      ? 'Signed server result ready.'
                      : 'Decision recorded; signature still pending.'}{' '}
                    Do not perform the external action again.
                  </p>
                  <p className={styles.warning}>
                    Check the original Android device for confirmation. This screen cannot tell
                    whether its payment hold has been resolved.
                  </p>
                </section>
              )}
              {superseded && (
                <section className={styles.section}>
                  <p>
                    The server accepted a different immutable decision for this exact frozen
                    payment. Your local retry cannot replace it.
                  </p>
                  <label className={styles.confirm}>
                    <input
                      type="checkbox"
                      checked={dismiss}
                      disabled={busy || disabled}
                      onChange={(e) => setDismiss(e.target.checked)}
                    />
                    <span>
                      Dismiss only my local retry. Keep the accepted decision and device records
                      unchanged.
                    </span>
                  </label>
                  <button
                    disabled={busy || disabled || !dismiss}
                    onClick={() => void dismissRetry()}
                  >
                    Dismiss this local retry
                  </button>
                </section>
              )}
              {canForm && (
                <DecisionForm
                  key={`${detail.summary.caseId}:${pending?.request.requestId ?? 'new'}:${formEpoch}`}
                  detail={detail}
                  saved={pending?.request}
                  disabled={busy || disabled}
                  onSubmit={submit}
                />
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
function Evidence({ detail }: { detail: PaymentReviewDetail }) {
  const { summary: s, freeze, quote } = detail
  return (
    <>
      <section className={styles.section}>
        <h4>Original saved payment</h4>
        <dl className={styles.values}>
          <div>
            <dt>Total</dt>
            <dd>{money(s.grossFils)}</dd>
          </div>
          <div>
            <dt>Cash</dt>
            <dd>{money(s.cashFils)}</dd>
          </div>
          <div>
            <dt>Recorded card</dt>
            <dd>{money(s.cardFils)}</dd>
          </div>
          <div>
            <dt>Order type</dt>
            <dd>{freeze?.request.serviceType.replace('_', ' ') ?? 'Unavailable'}</dd>
          </div>
        </dl>
        {quote && (
          <>
            <ul className={styles.lines}>
              {quote.lines.map((line) => (
                <li key={line.lineNumber}>
                  <span className={styles.lineName}>
                    {line.name}
                    <small>
                      {line.quantityMilli / 1000} {line.unit}
                    </small>
                  </span>
                  <strong>{money(line.grossFils)}</strong>
                </li>
              ))}
            </ul>
            <p className={styles.help}>
              Cash tendered: {money(quote.cashTenderedFils)} · Change: {money(quote.changeFils)}.
              Return amounts use the recorded net cash and card legs.
            </p>
          </>
        )}
        {freeze ? (
          <p className={styles.notice}>
            The device declared this payment permanently frozen before any local invoice was issued.{' '}
            {detail.capabilities.canDecide
              ? 'Current server checks found no original invoice, order, or payment record blocking this decision.'
              : 'Server eligibility is not confirmed here; a device declaration alone is not proof of invoice absence.'}
          </p>
        ) : (
          <p className={styles.warning}>
            No readable verified basket is available. Original evidence is retained for support.
          </p>
        )}
      </section>
      <details className={styles.section}>
        <summary>Original references and support details</summary>
        <dl>
          <dt>Payment intent</dt>
          <dd className={styles.reference}>{s.paymentIntentId}</dd>
          <dt>Original drawer / shift</dt>
          <dd className={styles.reference}>{s.shiftId}</dd>
          <dt>Reserved document ID (not an invoice)</dt>
          <dd className={styles.reference}>{s.documentId}</dd>
          <dt>Frozen proof</dt>
          <dd className={styles.reference}>{s.freezeSha256 ?? 'Unavailable'}</dd>
          <dt>Current hold</dt>
          <dd>{detail.capabilities.holdCode ?? 'None reported'}</dd>
        </dl>
        {detail.conflicts.map((conflict) => (
          <p className={styles.reference} key={conflict.conflictId}>
            {conflict.code} · {conflict.createdAt}
            <br />
            {conflict.payloadSha256}
          </p>
        ))}
        {detail.conflictsTruncated && (
          <p>More conflicts exist. Support must inspect the complete record.</p>
        )}
      </details>
    </>
  )
}
