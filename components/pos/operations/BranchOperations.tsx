'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  branchOperationsSchema,
  type BranchOperations as Snapshot,
} from '@/lib/pos/operations/contracts'
import styles from './operations.module.css'
import { formatFils } from '@/lib/pos/money'

export type OperationsDestination = 'reports' | 'open-orders' | 'kitchen' | 'shift'
type Branch = { id: string; name: string; role: 'owner' | 'manager' | 'cashier' }
type Props = {
  actorId: string
  branchId: string
  branchName: string
  branches: Branch[]
  disabled?: boolean
  onNavigate: (destination: OperationsDestination) => void
}
const time = (value: string) =>
  new Date(value).toLocaleString('en-AE', {
    timeZone: 'Asia/Dubai',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
const money = (value: number | null) =>
  value === null ? 'Not recorded' : `AED ${formatFils(value)}`
const counted = (count: number, label: string) => `${count} ${label}${count === 1 ? '' : 's'}`
const service = { dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' }
const errors: Record<string, string> = {
  operations_manager_required:
    'Manager or owner access is required for this branch. No branch information is available.',
  operations_profile_required:
    'This branch needs its receipt profile before the operations overview is available.',
  operations_too_large:
    'This overview contains too many records to load safely. Use the existing reports and counter screens while the branch overview is checked.',
}
export default function BranchOperations(props: Props) {
  return <Board key={`${props.actorId}:${props.branchId}`} {...props} />
}
function Board(props: Props) {
  const eligible = props.branches.filter(
    (branch) => branch.role === 'manager' || branch.role === 'owner'
  )
  const [selected, setSelected] = useState(() =>
    eligible.some((branch) => branch.id === props.branchId)
      ? props.branchId
      : (eligible[0]?.id ?? '')
  )
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [fresh, setFresh] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const permitted = eligible.some((branch) => branch.id === selected)
  const load = useCallback(async () => {
    if (!selected || !permitted) return
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    const sequence = ++generation.current
    setLoading(true)
    setFresh(false)
    setError('')
    try {
      const response = await fetch(
        `/api/pos/operations?${new URLSearchParams({ branchId: selected })}`,
        {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
        }
      )
      if (
        sequence === generation.current &&
        selectedRef.current === selected &&
        (response.status === 401 || response.status === 403)
      )
        setSnapshot(null)
      const data: unknown = await response.json()
      if (sequence !== generation.current || selectedRef.current !== selected) return
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) setSnapshot(null)
        const code = data && typeof data === 'object' && 'code' in data ? String(data.code) : ''
        throw new Error(
          response.status === 401
            ? 'Your session expired. Sign in again to view branch operations.'
            : (errors[code] ??
                'Branch operations could not be loaded. Check your connection and retry.')
        )
      }
      const verified = branchOperationsSchema.parse(data)
      if (verified.branchId !== selected)
        throw new Error(
          'The response did not match this branch. Refresh before using the overview.'
        )
      setSnapshot(verified)
      setFresh(true)
    } catch (failure) {
      if (sequence !== generation.current || selectedRef.current !== selected) return
      setError(
        failure instanceof Error && failure.name !== 'ZodError'
          ? failure.message
          : 'Branch operations could not be verified. Refresh before using the overview.'
      )
    } finally {
      if (sequence === generation.current) setLoading(false)
    }
  }, [selected, permitted])
  const invalidate = useCallback(() => {
    generation.current++
    controller.current?.abort()
  }, [])
  useEffect(() => {
    setSnapshot(null)
    setFresh(false)
    setError('')
    void load()
    return invalidate
  }, [load, invalidate])
  const current = permitted && snapshot?.branchId === selected ? snapshot : null
  const name = eligible.find((branch) => branch.id === selected)?.name ?? props.branchName
  const canNavigate =
    !!current && fresh && !loading && !props.disabled && selected === props.branchId
  return (
    <section className={styles.operations} aria-label="Branch operations">
      <header className={styles.header}>
        <div>
          <h2>Daily operations</h2>
          <p>{name}</p>
        </div>

        <div className={styles.toolbar}>
          <label>
            View branch
            <select
              value={selected}
              disabled={loading}
              onChange={(event) => {
                generation.current++
                controller.current?.abort()
                setSnapshot(null)
                setFresh(false)
                setSelected(event.target.value)
              }}
            >
              {eligible.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
          <button
            aria-label="Refresh overview"
            className={styles.primary}
            disabled={loading || !permitted}
            onClick={() => void load()}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {!permitted && (
        <p role="alert" className={styles.error}>
          Manager or owner access is required to view branch operations.
        </p>
      )}
      {error && (
        <div role="alert" className={styles.error}>
          <strong>Overview needs checking</strong>
          <p>{error}</p>
        </div>
      )}
      {loading && !current && <p role="status">Loading recorded branch operations…</p>}
      {current && (
        <>
          <p className={styles.meta}>
            Business date: {current.businessDate} (Dubai). Last successful refresh:{' '}
            {time(current.generatedAt)} Dubai time.
          </p>
          {!fresh && (
            <p className={styles.warning}>
              Last saved overview — figures may have changed. Refresh successfully before opening
              related work.
            </p>
          )}
          <p className={styles.coverage}>
            Offline-device activity may be missing. Server-recorded activity only.
          </p>
          <section className={styles.section} aria-label="Today’s recorded sales">
            <div className={styles.sectionHeading}>
              <h3>Today’s recorded sales</h3>
            </div>
            <dl className={styles.summary}>
              <div>
                <dt>Issued sales</dt>
                <dd>{money(current.sales.summary.salesGrossFils)}</dd>
              </div>
              <div>
                <dt>Credit notes</dt>
                <dd>{money(current.sales.summary.refundGrossFils)}</dd>
              </div>
              <div>
                <dt>Net including VAT</dt>
                <dd>{money(current.sales.summary.netGrossFils)}</dd>
              </div>
            </dl>
            <p className={styles.help}>
              {counted(current.sales.summary.invoiceCount, 'invoice')} and{' '}
              {counted(current.sales.summary.creditNoteCount, 'credit note')}. Issued fiscal
              documents only; unpaid orders are excluded.
            </p>
            <dl className={styles.values}>
              {current.sales.payments.map((payment) => (
                <div key={payment.method}>
                  <dt>{payment.method === 'cash' ? 'Recorded net cash' : 'Recorded net card'}</dt>
                  <dd>{money(payment.netFils)}</dd>
                </div>
              ))}
              <div>
                <dt>Net excluding VAT</dt>
                <dd>{money(current.sales.summary.netExVatFils)}</dd>
              </div>
              <div>
                <dt>Net VAT</dt>
                <dd>{money(current.sales.summary.vatFils)}</dd>
              </div>
            </dl>
            <p className={styles.help}>
              Card totals are recorded payments, not bank-settlement confirmation.
              {current.sales.legacyOrdersExcluded > 0
                ? ` ${current.sales.legacyOrdersExcluded} legacy orders are excluded.`
                : ''}
            </p>
          </section>
          <details className={styles.coverageDetails}>
            <summary>What this overview can see</summary>
            <p>
              Sales and problems still saved only on offline devices are unknown here. No recorded
              exceptions does not mean every device is synchronized.
            </p>
            <p>Viewing a branch here does not change this counter’s branch or saved order.</p>
          </details>
          <div className={styles.actions}>
            <button disabled={!canNavigate} onClick={() => props.onNavigate('reports')}>
              Open reports
            </button>
            <button disabled={!canNavigate} onClick={() => props.onNavigate('open-orders')}>
              Open orders &amp; tables
            </button>
            <button disabled={!canNavigate} onClick={() => props.onNavigate('kitchen')}>
              Open kitchen
            </button>
            <button disabled={!canNavigate} onClick={() => props.onNavigate('shift')}>
              View this counter’s shift
            </button>
          </div>
          {selected !== props.branchId && (
            <p className={styles.help}>
              Workflow shortcuts are available only for this counter’s bound branch. This selected
              branch overview is read-only.
            </p>
          )}
          <div className={styles.grid}>
            <section className={styles.section} aria-label="Open counters">
              <div className={styles.sectionHeading}>
                <h3>Open counters</h3>
                <strong>{counted(current.openShifts.totalCount, 'open shift')}</strong>
              </div>
              <p className={styles.help}>
                Opening cash is the saved float, not the cash currently in the drawer.
              </p>
              {current.openShifts.totalCount === 0 && (
                <p className={styles.empty}>No open shifts are recorded for this branch.</p>
              )}
              <ul className={styles.rows}>
                {current.openShifts.items.map((item) => (
                  <li key={item.id} className={styles.row}>
                    <h4>{item.deviceName}</h4>
                    <p className={styles.meta}>{item.staffName ?? 'Staff name unavailable'}</p>
                    <dl className={styles.values}>
                      <div>
                        <dt>Opened</dt>
                        <dd>{time(item.openedAt)}</dd>
                      </div>
                      <div>
                        <dt>Opening cash</dt>
                        <dd>{money(item.openingCashFils)}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
              {current.openShifts.truncated && (
                <p className={styles.warning}>
                  Showing {current.openShifts.items.length} of {current.openShifts.totalCount} open
                  shifts. The total includes rows not shown.
                </p>
              )}
            </section>
            <section className={styles.section} aria-label="Recent drawer closes">
              <div className={styles.sectionHeading}>
                <h3>Recent drawer closes</h3>
                <strong>{counted(current.closedShifts.totalCount, 'close')}</strong>
              </div>
              <p className={styles.help}>
                Last 30 Dubai days, {time(current.closedShifts.windowStart)} through{' '}
                {time(current.closedShifts.windowEnd)}.
              </p>
              <p>
                {counted(current.closedShifts.discrepancyCount, 'recorded difference')}. Net
                difference:{' '}
                <strong>
                  {current.closedShifts.netDifferenceFils === null
                    ? 'Unavailable — incomplete close records'
                    : money(current.closedShifts.netDifferenceFils)}
                </strong>
                .
              </p>
              {current.closedShifts.incompleteCount > 0 && (
                <p className={styles.warning}>
                  {counted(current.closedShifts.incompleteCount, 'close record')}{' '}
                  {current.closedShifts.incompleteCount === 1 ? 'has' : 'have'} missing amounts.
                  Missing values are not zero.
                </p>
              )}
              {current.closedShifts.totalCount === 0 && (
                <p className={styles.empty}>No drawer closes are recorded in this period.</p>
              )}
              <ul className={styles.rows}>
                {current.closedShifts.items.map((item) => (
                  <li key={item.id} className={styles.row}>
                    <h4>{item.deviceName}</h4>
                    <p className={styles.meta}>
                      {item.staffName ?? 'Staff name unavailable'} · Closed {time(item.closedAt)}
                    </p>
                    <dl className={styles.values}>
                      <div>
                        <dt>Counted cash</dt>
                        <dd>{money(item.countedCashFils)}</dd>
                      </div>
                      <div>
                        <dt>Expected cash</dt>
                        <dd>{money(item.expectedCashFils)}</dd>
                      </div>
                      <div>
                        <dt>Counted minus expected</dt>
                        <dd>{money(item.cashDifferenceFils)}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
              {current.closedShifts.truncated && (
                <p className={styles.warning}>
                  Showing {current.closedShifts.items.length} of {current.closedShifts.totalCount}{' '}
                  closes. Summary values cover the full period.
                </p>
              )}
            </section>
            <section className={styles.section} aria-label="Unpaid orders">
              <div className={styles.sectionHeading}>
                <h3>Unpaid orders</h3>
                <strong>{counted(current.unpaidOrders.totalCount, 'open order')}</strong>
              </div>
              <p>
                Saved basket estimate:{' '}
                <strong className={styles.amount}>{money(current.unpaidOrders.totalFils)}</strong>
              </p>
              <p className={styles.help}>
                Not collected sales. Final offers and payment totals can differ.
                {current.unpaidOrders.oldestCreatedAt
                  ? ` Oldest saved order: ${time(current.unpaidOrders.oldestCreatedAt)} Dubai time.`
                  : ''}
              </p>
              {current.unpaidOrders.totalCount === 0 && (
                <p className={styles.empty}>No unpaid orders are recorded.</p>
              )}
              <ul className={styles.rows}>
                {current.unpaidOrders.items.map((item) => (
                  <li key={item.id} className={styles.row}>
                    <h4>{item.label || 'Untitled order'}</h4>
                    <p className={styles.meta}>
                      {service[item.serviceType]}
                      {item.tableName ? ` · ${item.tableName}` : ''}
                    </p>
                    <dl className={styles.values}>
                      <div>
                        <dt>Saved</dt>
                        <dd>{time(item.createdAt)}</dd>
                      </div>
                      <div>
                        <dt>Basket estimate</dt>
                        <dd>{money(item.totalFils)}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
              {current.unpaidOrders.truncated && (
                <p className={styles.warning}>
                  Showing {current.unpaidOrders.items.length} of {current.unpaidOrders.totalCount}{' '}
                  orders. The count and estimate include orders not shown.
                </p>
              )}
            </section>
            <section className={styles.section} aria-label="Kitchen workload">
              <div className={styles.sectionHeading}>
                <h3>Kitchen workload</h3>
              </div>
              <h4>Tickets sent after payment</h4>
              <dl className={styles.values}>
                <div>
                  <dt>Queued tickets</dt>
                  <dd>{current.kitchen.paidTickets.queued}</dd>
                </div>
                <div>
                  <dt>Preparing tickets</dt>
                  <dd>{current.kitchen.paidTickets.preparing}</dd>
                </div>
                <div>
                  <dt>Ready tickets</dt>
                  <dd>{current.kitchen.paidTickets.ready}</dd>
                </div>
              </dl>
              <h4>Saved-order kitchen work</h4>
              <p>
                {counted(current.kitchen.tabTickets.activeCount, 'active ticket')};{' '}
                <strong>
                  {current.kitchen.tabTickets.withUnacknowledgedChanges}{' '}
                  {current.kitchen.tabTickets.withUnacknowledgedChanges === 1 ? 'needs' : 'need'}{' '}
                  change or stop-notice review
                </strong>
                .
              </p>
              <dl className={styles.values}>
                <div>
                  <dt>Queued batches</dt>
                  <dd>{current.kitchen.tabBatches.queued}</dd>
                </div>
                <div>
                  <dt>Preparing batches</dt>
                  <dd>{current.kitchen.tabBatches.preparing}</dd>
                </div>
                <div>
                  <dt>Ready batches</dt>
                  <dd>{current.kitchen.tabBatches.ready}</dd>
                </div>
              </dl>
              <p className={styles.help}>
                Batches are preparation groups, not item quantities. A ticket can contain several
                batches; these counts must not be added together. Offline bills do not automatically
                reach this kitchen.
              </p>
            </section>
          </div>
          <section className={styles.section} aria-label="Recorded offline attention">
            <h3>Recorded offline attention</h3>
            <p className={styles.help}>
              These server-known categories can overlap. They are not a combined issue total, and do
              not include records still stored only on a device.
            </p>
            <dl className={styles.values}>
              <div>
                <dt>Invoice allocations not finished</dt>
                <dd>{current.offlineCustody.unsealedAuthorities}</dd>
              </div>
              <div>
                <dt>Unresolved upload exceptions</dt>
                <dd>{current.offlineCustody.unresolvedUploadExceptions}</dd>
              </div>
              <div>
                <dt>Frozen payments awaiting signed results</dt>
                <dd>{current.offlineCustody.pendingPaymentFreezes}</dd>
              </div>
              <div>
                <dt>Conflict records, including history</dt>
                <dd>{current.offlineCustody.conflictRecords}</dd>
              </div>
              <div>
                <dt>Unsupported evidence records</dt>
                <dd>{current.offlineCustody.unsupportedEvidenceRecords}</dd>
              </div>
              <div>
                <dt>Blocked device registrations</dt>
                <dd>{current.offlineCustody.blockedDeviceEpochs}</dd>
              </div>
            </dl>
            <p className={styles.help}>
              An unfinished allocation can still be in use. Conflict history and evidence counts do
              not establish a current payment outcome. Use the original device and authorized
              recovery workflow to investigate; this screen cannot clear records or return money.
            </p>
          </section>
        </>
      )}
    </section>
  )
}
