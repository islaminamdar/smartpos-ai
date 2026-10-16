'use client'

import { useEffect, useRef, useState } from 'react'
import { formatFils } from '@/lib/pos/money'
import { fiscalDocumentSchema, type ReceiptDocument } from '@/lib/pos/server/documents'
import {
  returnRequestSchema,
  returnStateSchema,
  returnPreviewSchema,
  validateReturnPreview,
  type ReturnRequest,
  type ReturnState,
  type ReturnPreview,
} from '@/lib/pos/server/returns'
import styles from './returns.module.css'

type Props = {
  invoice: ReceiptDocument
  actorId: string
  deviceId: string
  shiftId: string | null
  online: boolean
  mayWrite: boolean
  pending: boolean
  onCommit: (request: ReturnRequest, quoteHash: string) => Promise<void>
}
const money = (value: number) => `AED ${formatFils(value)}`
const quantity = (value: number, unit: string) => `${value / 1000} ${unit}`
const messages: Record<string, string> = {
  POS_RETURN_STALE:
    'Another credit changed this invoice. Check remaining items again and review a new return.',
  POS_RETURN_QUANTITY: 'A selected quantity is no longer available. Check remaining items again.',
  POS_RETURN_UNAVAILABLE:
    'This invoice’s return history needs review. Keep its records and contact support.',
  POS_INSUFFICIENT_CASH:
    'Your drawer does not contain enough cash for this return. No credit has been confirmed.',
  POS_SHIFT_INVALID: 'Open your own shift on this counter before reviewing a return.',
  POS_SHIFT_CLOSED: 'Your shift has closed. Open your own shift before reviewing a return.',
  POS_ACCESS_DENIED: 'Your account is not authorised to view this return.',
  POS_MANAGER_REQUIRED: 'A manager or owner must review and confirm this return.',
  POS_DEVICE_INVALID: 'Use an enrolled counter for this branch.',
  device_binding_required: 'Use the original enrolled counter or check its access.',
}
class ReturnError extends Error {
  constructor(public code: string) {
    super(
      messages[code] ??
        'The return could not be verified. Check remaining items again before continuing.'
    )
  }
}
async function load(path: string, signal: AbortSignal, body?: unknown) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const value: unknown = await response.json()
  if (!response.ok)
    throw new ReturnError(
      value && typeof value === 'object' && 'code' in value ? String(value.code) : 'unavailable'
    )
  return value
}
function payload(value: unknown, field: 'state' | 'preview') {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [field, 'status'].sort().join(',') ||
    !('status' in value) ||
    value.status !== 'ready'
  )
    throw new ReturnError('unavailable')
  return (value as Record<string, unknown>)[field]
}
function parseQuantity(value: string, unit: string): number | null {
  if (!(unit === 'kg' ? /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/ : /^(?:0|[1-9]\d*)$/).test(value))
    return null
  const [whole, fraction = ''] = value.split('.')
  const result = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'))
  return Number.isSafeInteger(result) && result > 0 && result <= 1_000_000 ? result : null
}

export default function PartialReturnPanel({
  invoice,
  actorId,
  deviceId,
  shiftId,
  online,
  mayWrite,
  pending,
  onCommit,
}: Props) {
  const scope = `${actorId}:${invoice.branchId}:${deviceId}:${shiftId ?? ''}:${invoice.id}`
  const currentScope = useRef(scope)
  currentScope.current = scope
  const mounted = useRef(false),
    generation = useRef(0),
    active = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const phase = useRef<'read' | 'preview' | 'commit' | null>(null)
  const [state, setState] = useState<ReturnState | null>(null)
  const [readScope, setReadScope] = useState('')
  const [quantities, setQuantities] = useState<Record<number, string>>({})
  const [reason, setReason] = useState(''),
    [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ request: ReturnRequest; value: ReturnPreview } | null>(
    null
  )
  const [confirmed, setConfirmed] = useState(false)
  const reviewHeading = useRef<HTMLHeadingElement>(null)
  const current = (token: number, selected: string) =>
    mounted.current && token === generation.current && selected === currentScope.current
  const invalidate = () => {
    generation.current++
    setPreview(null)
    setConfirmed(false)
  }
  useEffect(() => {
    const lifecycleGeneration = generation
    mounted.current = true
    return () => {
      mounted.current = false
      lifecycleGeneration.current++
      controller.current?.abort()
    }
  }, [])
  useEffect(() => {
    const pause = () => {
      invalidate()
      controller.current?.abort()
      setState(null)
      setError(
        'Check remaining items again after returning to this page. A previous confirmation cannot be reused.'
      )
    }
    const visibility = () => {
      if (document.visibilityState === 'hidden') pause()
    }
    window.addEventListener('pagehide', pause)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('pagehide', pause)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])
  useEffect(() => {
    invalidate()
    setState(null)
    setQuantities({})
    setReason('')
    setError('')
    controller.current?.abort()
    if (online) void read()
    // Every identity change discards both the server preview and manager consent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, online])
  useEffect(() => {
    if (!mayWrite) {
      if (phase.current === 'preview') {
        generation.current++
        controller.current?.abort()
      }
      setPreview(null)
      setConfirmed(false)
    }
  }, [mayWrite])
  async function read() {
    if (!online || active.current) return
    active.current = true
    phase.current = 'read'
    setBusy(true)
    invalidate()
    setState(null)
    setError('')
    const token = generation.current,
      selected = scope
    const abort = new AbortController()
    controller.current = abort
    const timer = setTimeout(() => abort.abort(), 20000)
    try {
      const data = await load(
        `/api/pos/returns?branchId=${encodeURIComponent(invoice.branchId)}&deviceId=${encodeURIComponent(deviceId)}&orderId=${encodeURIComponent(invoice.orderId)}`,
        abort.signal
      )
      const next = returnStateSchema.parse(payload(data, 'state'))
      if (JSON.stringify(next.invoice) !== JSON.stringify(fiscalDocumentSchema.parse(invoice)))
        throw new ReturnError('unavailable')
      if (current(token, selected)) {
        setState(next)
        setReadScope(selected)
        setQuantities({})
      }
    } catch (failure) {
      if (current(token, selected))
        setError(
          failure instanceof ReturnError
            ? failure.message
            : 'Remaining items could not be checked. No return was submitted. Try again when connected.'
        )
    } finally {
      clearTimeout(timer)
      active.current = false
      phase.current = null
      if (mounted.current) setBusy(false)
    }
  }
  const fresh = state && readScope === scope ? state : null
  const selectedLines =
    fresh?.invoice.lines.filter((line) => Object.hasOwn(quantities, line.lineNumber)) ?? []
  const selections = selectedLines.map((line) => ({
    lineNumber: line.lineNumber,
    quantityMilli: parseQuantity(quantities[line.lineNumber], line.unit),
  }))
  const invalidQuantity =
    !selections.length ||
    selections.some((line) => {
      const original = fresh!.invoice.lines.find((row) => row.lineNumber === line.lineNumber)!
      const returned = fresh!.returned.find(
        (row) => row.lineNumber === line.lineNumber
      )!.quantityMilli
      return line.quantityMilli === null || line.quantityMilli > original.quantityMilli - returned
    })
  const paused = busy || pending || !online
  const reviewAllowed =
    !!fresh &&
    !fresh.fullyReturned &&
    !!shiftId &&
    mayWrite &&
    !paused &&
    !invalidQuantity &&
    !!reason.trim() &&
    !reason.includes('\u0000')
  async function review() {
    if (!reviewAllowed || !fresh || !shiftId || active.current) return
    invalidate()
    setError('')
    active.current = true
    phase.current = 'preview'
    setBusy(true)
    const token = generation.current,
      selected = scope
    const abort = new AbortController()
    controller.current = abort
    const timer = setTimeout(() => abort.abort(), 20000)
    try {
      const request = returnRequestSchema.parse({
        branchId: invoice.branchId,
        deviceId,
        shiftId,
        orderId: invoice.orderId,
        invoiceId: invoice.id,
        expectedRevision: fresh.revision,
        lines: selections,
        reason: reason.trim(),
      })
      const response = await load('/api/pos/returns', abort.signal, { request })
      const value = returnPreviewSchema.parse(payload(response, 'preview'))
      validateReturnPreview(fresh, request, value)
      if (current(token, selected)) setPreview({ request, value })
    } catch (failure) {
      if (current(token, selected)) {
        setError(
          failure instanceof ReturnError
            ? failure.message
            : 'The return preview could not be verified. No return was submitted. Check remaining items again.'
        )
        if (
          failure instanceof ReturnError &&
          ['POS_RETURN_STALE', 'POS_RETURN_QUANTITY'].includes(failure.code)
        )
          setState(null)
      }
    } finally {
      clearTimeout(timer)
      active.current = false
      phase.current = null
      if (mounted.current) setBusy(false)
    }
  }
  useEffect(() => {
    if (preview) reviewHeading.current?.focus()
  }, [preview])
  async function commit() {
    if (!preview || !confirmed || !reviewAllowed || active.current) return
    active.current = true
    phase.current = 'commit'
    setBusy(true)
    setConfirmed(false)
    const selected = scope,
      token = generation.current
    try {
      await onCommit(preview.request, preview.value.quoteHash)
    } catch {
      if (current(token, selected))
        setError(
          'The credit was not confirmed. Check the saved request above before returning money or starting another return.'
        )
    } finally {
      active.current = false
      phase.current = null
      if (mounted.current) {
        setBusy(false)
        setPreview(null)
      }
    }
  }
  const change = (lineNumber: number, value: string | null) => {
    invalidate()
    setError('')
    setQuantities((previous) => {
      const next = { ...previous }
      if (value === null) delete next[lineNumber]
      else next[lineNumber] = value
      return next
    })
  }
  return (
    <section className={styles.panel} aria-labelledby="return-items-heading">
      <header className={styles.header}>
        <div>
          <h2 id="return-items-heading">Return items</h2>
          <p>
            Choose from the original invoice. Previously returned items cannot be returned again.
          </p>
        </div>
        <button disabled={paused} onClick={() => void read()}>
          Check remaining items
        </button>
      </header>
      <p className={styles.note}>
        Returns do not restock inventory or send a card refund. Wait for a saved credit note before
        returning money.
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {busy && <p role="status">Checking this return…</p>}
      {!online && <p role="status">Connect to the internet to check or review a return.</p>}
      {pending && (
        <p role="status">
          Resolve the exact saved request above before starting another return. Do not return the
          money twice.
        </p>
      )}
      {!shiftId && (
        <p className={styles.warning}>
          Open your own shift on this counter to review and confirm a return.
        </p>
      )}
      {fresh && (
        <>
          <div className={styles.balance}>
            <span>Invoice balance before this return</span>
            <strong>{money(fresh.adjustedTotals.grossFils)}</strong>
            <small>
              Excluding VAT {money(fresh.adjustedTotals.netFils)} · VAT{' '}
              {money(fresh.adjustedTotals.taxFils)}
            </small>
          </div>
          {fresh.fullyReturned ? (
            <p role="status" className={styles.warning}>
              All original quantities have been returned. No further return is available.
            </p>
          ) : (
            <>
              <div className={styles.actions}>
                <button
                  disabled={paused}
                  onClick={() => {
                    invalidate()
                    setQuantities(
                      Object.fromEntries(
                        fresh.invoice.lines.flatMap((line) => {
                          const remaining =
                            line.quantityMilli -
                            fresh.returned.find((row) => row.lineNumber === line.lineNumber)!
                              .quantityMilli
                          return remaining ? [[line.lineNumber, String(remaining / 1000)]] : []
                        })
                      )
                    )
                  }}
                >
                  Select all remaining items
                </button>
                <button
                  disabled={paused || !selectedLines.length}
                  onClick={() => {
                    invalidate()
                    setQuantities({})
                  }}
                >
                  Clear selection
                </button>
              </div>
              <ul className={styles.lines} aria-label="Original invoice items">
                {fresh.invoice.lines.map((line) => {
                  const returned = fresh.returned.find(
                    (row) => row.lineNumber === line.lineNumber
                  )!.quantityMilli
                  const remaining = line.quantityMilli - returned,
                    chosen = Object.hasOwn(quantities, line.lineNumber)
                  const entered = chosen
                    ? parseQuantity(quantities[line.lineNumber], line.unit)
                    : null
                  const invalid = chosen && (entered === null || entered > remaining)
                  const suffix = `return-line-${line.lineNumber}`
                  return (
                    <li key={line.lineNumber} className={styles.line}>
                      <label className={styles.select}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${line.name}, original line ${line.lineNumber}`}
                          checked={chosen}
                          disabled={paused || !remaining}
                          onChange={(event) =>
                            change(
                              line.lineNumber,
                              event.target.checked ? String(remaining / 1000) : null
                            )
                          }
                        />
                        <span>
                          <strong>{line.name}</strong>
                          <small>
                            Original line {line.lineNumber}
                            {remaining === 0 ? ' · Fully returned' : ''}
                          </small>
                        </span>
                      </label>
                      <dl className={styles.quantities}>
                        <div>
                          <dt>Sold</dt>
                          <dd>{quantity(line.quantityMilli, line.unit)}</dd>
                        </div>
                        <div>
                          <dt>Returned</dt>
                          <dd>{quantity(returned, line.unit)}</dd>
                        </div>
                        <div>
                          <dt>Remaining</dt>
                          <dd>{quantity(remaining, line.unit)}</dd>
                        </div>
                      </dl>
                      {chosen && (
                        <label htmlFor={suffix}>
                          Return {line.unit === 'kg' ? 'weight (kg)' : `quantity (${line.unit})`}
                          <input
                            id={suffix}
                            aria-label={`Return ${line.name}, original line ${line.lineNumber}, ${line.unit}`}
                            inputMode={line.unit === 'kg' ? 'decimal' : 'numeric'}
                            value={quantities[line.lineNumber]}
                            disabled={paused}
                            aria-invalid={invalid}
                            aria-describedby={`${suffix}-help`}
                            onChange={(event) => change(line.lineNumber, event.target.value)}
                          />
                          <small id={`${suffix}-help`}>
                            {invalid
                              ? 'Enter a positive quantity up to the remaining amount. '
                              : ''}
                            {line.unit === 'kg'
                              ? 'Use up to three decimal places (grams).'
                              : 'Use whole units only.'}
                          </small>
                        </label>
                      )}
                    </li>
                  )
                })}
              </ul>
              <label className={styles.reason}>
                Reason for return
                <textarea
                  value={reason}
                  maxLength={240}
                  disabled={paused}
                  onChange={(event) => {
                    invalidate()
                    setReason(event.target.value)
                    setError('')
                  }}
                />
              </label>
              <button
                className={styles.primary}
                disabled={!reviewAllowed}
                onClick={() => void review()}
              >
                Review return
              </button>
            </>
          )}
        </>
      )}
      {preview && (
        <div className={styles.preview}>
          <h3 ref={reviewHeading} tabIndex={-1}>
            Review this exact return
          </h3>
          <p>
            Amounts allocate the original billed discount and VAT. Current menu prices and offers
            are not used.
          </p>
          <p>
            <strong>Reason:</strong> {preview.request.reason}
          </p>
          <ul className={styles.lines}>
            {preview.value.lines.map((line) => (
              <li key={line.originalLineNumber} className={styles.line}>
                <strong>{line.name}</strong>
                <p>
                  Original line {line.originalLineNumber} · Return{' '}
                  {quantity(line.quantityMilli, line.unit)}
                </p>
                <small>
                  Cumulative returned: {quantity(line.returnedBeforeQuantityMilli, line.unit)} →{' '}
                  {quantity(line.returnedAfterQuantityMilli, line.unit)}
                </small>
                <dl className={styles.amounts}>
                  <div>
                    <dt>Before original discount</dt>
                    <dd>{money(line.beforeDiscountFils)}</dd>
                  </div>
                  <div>
                    <dt>Original discount allocated</dt>
                    <dd>−{money(line.discountFils)}</dd>
                  </div>
                  <div>
                    <dt>Excluding VAT</dt>
                    <dd>{money(line.netFils)}</dd>
                  </div>
                  <div>
                    <dt>VAT returned</dt>
                    <dd>{money(line.taxFils)}</dd>
                  </div>
                  <div>
                    <dt>Line credit</dt>
                    <dd>{money(line.grossFils)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
          <dl className={styles.amounts}>
            <div>
              <dt>Total credit</dt>
              <dd>{money(preview.value.totals.grossFils)}</dd>
            </div>
            {preview.value.payments.map((payment) => (
              <div key={payment.method}>
                <dt>
                  {payment.method === 'cash'
                    ? 'Cash to return'
                    : 'Card refund to arrange on terminal'}
                </dt>
                <dd>{money(payment.amountFils)}</dd>
              </div>
            ))}
          </dl>
          {preview.value.totals.grossFils === 0 && (
            <p className={styles.warning}>
              No refund is due. This credit records returned quantities only; no cash or card
              payment will be recorded.
            </p>
          )}
          <div className={styles.balance}>
            <span>Invoice balance after this return</span>
            <strong>{money(preview.value.adjustedTotals.grossFils)}</strong>
            <small>
              Excluding VAT {money(preview.value.adjustedTotals.netFils)} · VAT{' '}
              {money(preview.value.adjustedTotals.taxFils)}
            </small>
          </div>
          <label className={styles.confirm}>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!reviewAllowed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              I confirm these exact items, quantities and amounts. Issue one credit note; I will
              return money only after it is saved.
            </span>
          </label>
          <button
            className={styles.primary}
            disabled={!confirmed || !reviewAllowed}
            onClick={() => void commit()}
          >
            Issue credit note
          </button>
        </div>
      )}
    </section>
  )
}
