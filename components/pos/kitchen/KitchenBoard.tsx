'use client'

import { browserUuid } from '@/lib/pos/browser-uuid'

import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import {
  kitchenListSchema,
  kitchenCommandSchema,
  kitchenUpdateResultSchema,
  kitchenAckMatches,
  kitchenCancellationSchema,
  type KitchenCommand,
  type KitchenList,
  type KitchenTicket,
} from '@/lib/pos/server/kitchen'
import {
  readPendingKitchenRequests,
  savePendingKitchenRequest,
  acknowledgeKitchenRequest,
  kitchenJournalEvent,
} from '@/lib/pos/kitchen-journal'
import styles from './kitchen.module.css'

type Scope = {
  actorId: string
  branchId: string
  disabled: boolean
  onPendingChange?: (pending: boolean) => void
}
type Props = Scope & { branchName: string; deviceId: string }
type Cursor = { issuedAt: string; orderId: string } | null
const states = ['queued', 'preparing', 'ready', 'served'] as const
const labels = {
  queued: 'Queued',
  preparing: 'Preparing',
  ready: 'Ready',
  served: 'Served',
  cancelled: 'Cancelled',
}
const actionLabels = { preparing: 'Start preparing', ready: 'Mark ready', served: 'Mark served' }
const serviceLabels = { dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' }
const watchAfterMinutes = 10
const lateAfterMinutes = 20
function elapsedMinutes(value: string, now: number) {
  return Math.max(0, Math.floor((now - new Date(value).getTime()) / 60000))
}
function urgency(value: string, now: number) {
  const minutes = elapsedMinutes(value, now)
  return minutes >= lateAfterMinutes ? 'late' : minutes >= watchAfterMinutes ? 'watch' : 'normal'
}
function time(value: string) {
  return new Date(value).toLocaleTimeString('en-AE', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Dubai',
  })
}
function age(value: string, now: number) {
  const minutes = elapsedMinutes(value, now)
  return minutes < 1
    ? 'Just received'
    : minutes < 60
      ? `${minutes} min elapsed`
      : `${Math.floor(minutes / 60)}h ${minutes % 60}m elapsed`
}
class KitchenError extends Error {
  constructor(public code: string) {
    super(code)
  }
}
async function call(url: string, body?: KitchenCommand, signal?: AbortSignal) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
      : AbortSignal.timeout(20000),
  })
  const data: unknown = await response.json()
  if (!response.ok)
    throw new KitchenError(
      data && typeof data === 'object' && 'code' in data ? String(data.code) : 'unavailable'
    )
  return data
}
function usePending({ actorId, branchId, disabled, onPendingChange }: Scope) {
  const [pending, setPending] = useState<KitchenCommand | null>(null)
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false)
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const alive = useRef(false),
    locked = useRef(false),
    callback = useRef(onPendingChange)
  callback.current = onPendingChange
  useEffect(() => {
    alive.current = true
    let active = true,
      checking = false
    async function check() {
      if (checking || locked.current) return
      checking = true
      try {
        const records = await readPendingKitchenRequests(actorId)
        if (!active || locked.current) return
        const saved =
          records.find((record) => record.command.branchId === branchId)?.command ?? null
        setPending(saved)
        setReady(true)
        callback.current?.(!!saved)
      } catch {
        if (active) {
          setReady(false)
          callback.current?.(true)
          setError(
            'Saved kitchen changes could not be read. Editing is paused. Keep browser data intact and ask your administrator for help.'
          )
        }
      } finally {
        checking = false
      }
    }
    void check()
    const refresh = () => {
      void check()
    }
    window.addEventListener(kitchenJournalEvent, refresh)
    window.addEventListener('focus', refresh)
    let channel: BroadcastChannel | null = null
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(kitchenJournalEvent)
        channel.onmessage = refresh
      }
    } catch {
      /* Atomic storage still prevents overwrite. */
    }
    return () => {
      active = false
      alive.current = false
      window.removeEventListener(kitchenJournalEvent, refresh)
      window.removeEventListener('focus', refresh)
      channel?.close()
    }
  }, [actorId, branchId])
  useEffect(() => {
    if (!pending) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pending])
  async function execute(
    command: KitchenCommand,
    recovery = false,
    existing = false
  ): Promise<boolean> {
    if (disabled || locked.current || !ready) return false
    locked.current = true
    setBusy(true)
    setError('')
    setNotice('')
    let persisted = existing
    try {
      if (!existing) {
        await savePendingKitchenRequest({ actorId, command })
        persisted = true
      }
      if (alive.current) setPending(command)
      callback.current?.(true)
      const raw = await call(recovery ? '/api/pos/kitchen/recovery' : '/api/pos/kitchen', command)
      const cancellation = kitchenCancellationSchema.safeParse(raw)
      const cancelled =
        recovery && cancellation.success && cancellation.data.requestId === command.id
      if (!cancelled) {
        const result = kitchenUpdateResultSchema.parse(raw)
        if (!kitchenAckMatches(command, result)) throw new Error('ack_mismatch')
      }
      await acknowledgeKitchenRequest(actorId, branchId, command.id)
      callback.current?.(false)
      if (alive.current) {
        setPending(null)
        setNotice(
          cancelled
            ? 'This unsaved change was permanently cancelled. Refresh and check the ticket before another action.'
            : 'Kitchen change confirmed. Refreshing the saved tickets…'
        )
      }
      return true
    } catch (cause) {
      if (!alive.current) return false
      if (!persisted) {
        try {
          const saved =
            (await readPendingKitchenRequests(actorId)).find(
              (record) => record.command.branchId === branchId
            )?.command ?? null
          setPending(saved)
          callback.current?.(!!saved)
          if (!saved) setReady(false)
        } catch {
          setReady(false)
        }
        setError(
          'The change could not be stored safely, so no new request was sent. Recover any saved change before continuing.'
        )
      } else {
        setError(
          cause instanceof KitchenError && cause.code === 'kitchen_return_acknowledgement_required'
            ? 'Check and acknowledge the return notice before changing preparation. Keep this saved change for recovery.'
            : cause instanceof KitchenError && /conflict|revision/.test(cause.code)
              ? 'Another operator may have changed this ticket. Check the saved change below before trying a new action.'
              : 'The kitchen change is not confirmed. Keep this request and check it below; do not repeat the action as a new change.'
        )
      }
      return false
    } finally {
      locked.current = false
      if (alive.current) setBusy(false)
    }
  }
  return { pending, ready, busy, error, notice, execute }
}
type PendingState = ReturnType<typeof usePending>
function PendingPanel({
  state,
  disabled,
  run,
}: {
  state: PendingState
  disabled: boolean
  run: (recover: boolean) => void
}) {
  const [cancelAllowed, setCancelAllowed] = useState(false)
  return (
    <>
      {state.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
      {state.notice && (
        <p className={styles.notice} role="status">
          {state.notice}
        </p>
      )}
      {state.pending && (
        <section className={styles.pending} aria-label="Saved kitchen change">
          <h3>A kitchen change needs confirmation</h3>
          <p>
            Requested state: <strong>{labels[state.pending.status]}</strong>. The saved request is
            kept until the server confirms its result.
          </p>
          <p className={styles.reference}>Request {state.pending.id}</p>
          <button disabled={disabled || state.busy} onClick={() => run(false)}>
            {state.busy ? 'Checking…' : 'Retry saved kitchen change'}
          </button>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={cancelAllowed}
              onChange={(event) => setCancelAllowed(event.target.checked)}
              disabled={state.busy}
            />
            Cancel this change permanently if the server confirms it was never saved.
          </label>
          <button disabled={disabled || state.busy || !cancelAllowed} onClick={() => run(true)}>
            Check or cancel saved change
          </button>
          <p className={styles.help}>
            This cancels only an unsaved status change. It does not cancel an order or refund a
            payment.
          </p>
        </section>
      )}
    </>
  )
}
export function KitchenPendingRecovery(props: {
  actorId?: string
  branchId?: string
  excludeBranchId?: string
  disabled?: boolean
  onPendingChange?: (pending: boolean) => void
}) {
  const [actor, setActor] = useState(props.actorId ?? '')
  const [branches, setBranches] = useState<string[]>([]),
    [error, setError] = useState('')
  const callback = useRef(props.onPendingChange)
  callback.current = props.onPendingChange
  useEffect(() => {
    let alive = true,
      reading = false
    async function discover() {
      if (reading) return
      reading = true
      try {
        const actorId =
          props.actorId ??
          z
            .object({ status: z.literal('authenticated'), userId: z.string().uuid() })
            .strict()
            .parse(await call('/api/pos/session')).userId
        const records = await readPendingKitchenRequests(actorId)
        if (!alive) return
        setActor(actorId)
        setBranches(
          records
            .filter(
              (record) =>
                (!props.branchId || record.command.branchId === props.branchId) &&
                record.command.branchId !== props.excludeBranchId
            )
            .map((record) => record.command.branchId)
        )
        setError('')
        callback.current?.(records.length > 0)
      } catch {
        if (alive) {
          setError(
            'Kitchen recovery could not be checked. Sign in with the original staff account and keep browser data intact.'
          )
          callback.current?.(true)
        }
      } finally {
        reading = false
      }
    }
    void discover()
    const change = () => {
      void discover()
    }
    window.addEventListener(kitchenJournalEvent, change)
    window.addEventListener('focus', change)
    let channel: BroadcastChannel | null = null
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(kitchenJournalEvent)
        channel.onmessage = change
      }
    } catch {
      /* Focus checks remain available. */
    }
    return () => {
      alive = false
      window.removeEventListener(kitchenJournalEvent, change)
      window.removeEventListener('focus', change)
      channel?.close()
    }
  }, [props.actorId, props.branchId, props.excludeBranchId])
  return (
    <>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {branches.map((branchId) => (
        <Recovery
          key={`${actor}:${branchId}`}
          actorId={actor}
          branchId={branchId}
          disabled={props.disabled ?? false}
        />
      ))}
    </>
  )
}
function Recovery(props: Scope) {
  const state = usePending(props)
  return (
    <section className={styles.board} aria-label="Kitchen request recovery">
      <PendingPanel
        key={state.pending?.id ?? 'none'}
        state={state}
        disabled={props.disabled}
        run={(recover) => {
          if (state.pending) void state.execute(state.pending, recover, true)
        }}
      />
    </section>
  )
}
export default function KitchenBoard(props: Props) {
  return <Board key={`${props.actorId}:${props.branchId}:${props.deviceId}`} {...props} />
}
function Board(props: Props) {
  const { branchId, branchName, deviceId, disabled } = props
  const state = usePending(props)
  const [data, setData] = useState<KitchenList | null>(null),
    [fresh, setFresh] = useState(false)
  const [loading, setLoading] = useState(false),
    [loadError, setLoadError] = useState('')
  const [terminal, setTerminal] = useState(false),
    [cursor, setCursor] = useState<Cursor>(null)
  const [now, setNow] = useState(Date.now),
    [confirm, setConfirm] = useState<{
      ticket: KitchenTicket
      status: KitchenCommand['status']
    } | null>(null)
  const [reason, setReason] = useState('')
  const alive = useRef(false),
    controller = useRef<AbortController | null>(null),
    generation = useRef(0)
  const reading = useRef(false),
    writing = useRef(false),
    cursorRef = useRef<Cursor>(null)
  const load = useCallback(
    async (next: Cursor = cursorRef.current) => {
      if (reading.current || writing.current) return
      reading.current = true
      setLoading(true)
      const id = ++generation.current
      const abort = new AbortController()
      controller.current = abort
      const query = new URLSearchParams({ branchId, deviceId })
      if (next) {
        query.set('afterIssuedAt', next.issuedAt)
        query.set('afterOrderId', next.orderId)
      }
      try {
        const result = kitchenListSchema.parse(
          await call(`/api/pos/kitchen?${query}`, undefined, abort.signal)
        )
        if (
          result.branchId !== branchId ||
          [...result.activeTickets, ...result.terminalTickets].some(
            (ticket) => ticket.branchId !== branchId
          )
        )
          throw new Error('scope')
        if (alive.current && id === generation.current) {
          setData(result)
          setFresh(true)
          setLoadError('')
          setCursor(next)
          cursorRef.current = next
          setNow(Date.now())
        }
      } catch {
        if (alive.current && id === generation.current) {
          setFresh(false)
          setLoadError(
            'The kitchen could not refresh. Any tickets below are the last confirmed view; actions are paused until a fresh update arrives.'
          )
        }
      } finally {
        if (id === generation.current) {
          reading.current = false
          if (alive.current) setLoading(false)
        }
      }
    },
    [branchId, deviceId]
  )
  useEffect(() => {
    alive.current = true
    void load(null)
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        setNow(Date.now())
        void load()
      }
    }
    const timer = window.setInterval(refresh, 10000)
    const offline = () => {
      setFresh(false)
      setLoadError(
        'Connection lost. Tickets are the last confirmed view. Reconnect to refresh before changing a ticket.'
      )
    }
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('online', refresh)
    window.addEventListener('offline', offline)
    return () => {
      alive.current = false
      // This numeric generation invalidates network reads; it is not a rendered DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++
      controller.current?.abort()
      reading.current = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('online', refresh)
      window.removeEventListener('offline', offline)
    }
  }, [load])
  async function execute(command: KitchenCommand, recover = false, existing = false) {
    if (writing.current) return
    writing.current = true
    generation.current++
    controller.current?.abort()
    reading.current = false
    setFresh(false)
    setLoading(false)
    setConfirm(null)
    setReason('')
    try {
      await state.execute(command, recover, existing)
    } finally {
      writing.current = false
      if (alive.current) await load()
    }
  }
  const mayAct = state.ready && !state.pending && !state.busy && !disabled && fresh && !loading
  const manager = data?.actorRole === 'manager' || data?.actorRole === 'owner'
  function change(
    ticket: KitchenTicket,
    status: KitchenCommand['status'],
    correctionReason: string | null = null
  ) {
    if (!mayAct) return
    const command = kitchenCommandSchema.parse({
      id: browserUuid(),
      branchId,
      deviceId,
      orderId: ticket.orderId,
      expectedRevision: ticket.revision,
      status,
      reason: correctionReason,
    })
    void execute(command)
  }
  const tickets = data ? (terminal ? data.terminalTickets : data.activeTickets) : []
  const activeAttention = data
    ? data.activeTickets.filter((ticket) => urgency(ticket.issuedAt, now) !== 'normal')
    : []
  const activeLate = activeAttention.filter((ticket) => urgency(ticket.issuedAt, now) === 'late')
  return (
    <section className={styles.board} aria-label="Kitchen board">
      <header className={styles.heading}>
        <div>
          <h2>Kitchen at {branchName}</h2>
          <p>Orders paid without prior kitchen dispatch. Oldest active orders appear first.</p>
        </div>
        <button disabled={loading || state.busy || disabled} onClick={() => void load()}>
          {loading ? 'Refreshing…' : 'Refresh tickets'}
        </button>
      </header>
      <PendingPanel
        key={state.pending?.id ?? 'none'}
        state={state}
        disabled={disabled}
        run={(recover) => {
          if (state.pending) void execute(state.pending, recover, true)
        }}
      />
      {loadError && (
        <p className={styles.error} role="alert">
          {loadError}
        </p>
      )}
      {data && (
        <>
          <p className={styles.updated}>
            {fresh ? 'Last confirmed' : 'Last confirmed view — refresh needed'}{' '}
            {time(data.generatedAt)} Dubai time.{' '}
            {disabled
              ? 'Kitchen changes are paused.'
              : 'Refreshes every 10 seconds while this tab is visible.'}
          </p>
          <div className={styles.toolbar}>
            <div className={styles.filters} role="group" aria-label="Kitchen tickets">
              <button
                aria-pressed={!terminal}
                onClick={() => {
                  setTerminal(false)
                  setConfirm(null)
                }}
              >
                Active ({data.activeCount})
              </button>
              <button
                aria-pressed={terminal}
                onClick={() => {
                  setTerminal(true)
                  setConfirm(null)
                }}
              >
                Served &amp; cancelled
              </button>
            </div>
            <div className={styles.counts} aria-label="All active tickets in this branch">
              <span>
                Queued <strong>{data.activeCounts.queued}</strong>
              </span>
              <span>
                Preparing <strong>{data.activeCounts.preparing}</strong>
              </span>
              <span>
                Ready <strong>{data.activeCounts.ready}</strong>
              </span>
              {activeAttention.length > 0 && (
                <span className={activeLate.length > 0 ? styles.lateCount : styles.watchCount}>
                  {activeLate.length > 0 ? 'Late' : 'Watch'}{' '}
                  <strong>{activeLate.length || activeAttention.length}</strong>
                </span>
              )}
            </div>
          </div>
          {!terminal && activeAttention.length > 0 && (
            <p
              className={activeLate.length > 0 ? styles.lateNotice : styles.watchNotice}
              role="status"
            >
              {activeLate.length > 0
                ? `${activeLate.length} active ${activeLate.length === 1 ? 'order is' : 'orders are'} over ${lateAfterMinutes} minutes. Check these first and update the customer through the counter.`
                : `${activeAttention.length} active ${activeAttention.length === 1 ? 'order is' : 'orders are'} over ${watchAfterMinutes} minutes. Keep an eye on preparation time.`}
            </p>
          )}
          {terminal && (
            <p className={styles.help}>
              Recent served and refunded orders.
              {data.terminalTruncated ? ' Only the latest 50 are shown.' : ''} Refunds cancel
              preparation automatically; kitchen buttons do not issue refunds.
            </p>
          )}
          {!terminal && (cursor || data.activeNextCursor) && (
            <div className={styles.pagination}>
              <p>
                Showing {tickets.length} of {data.activeCount} active tickets. Counts include all
                pages.
              </p>
              <button
                disabled={!cursor || loading || state.busy}
                onClick={() => {
                  setConfirm(null)
                  void load(null)
                }}
              >
                First page
              </button>
              <button
                disabled={!data.activeNextCursor || loading || state.busy}
                onClick={() => {
                  setConfirm(null)
                  void load(data.activeNextCursor)
                }}
              >
                Next page
              </button>
            </div>
          )}
        </>
      )}
      {!data && loading && <p role="status">Loading saved kitchen tickets…</p>}
      {data && tickets.length === 0 && (
        <p className={styles.empty}>
          {terminal
            ? 'No recent served or cancelled tickets.'
            : cursor
              ? 'No tickets remain on this page. Return to the first page.'
              : 'No active paid orders in this branch.'}
        </p>
      )}
      <div className={styles.tickets}>
        {tickets.map((ticket) => {
          const index = states.indexOf(ticket.status as (typeof states)[number])
          const next = index >= 0 && index < 3 ? states[index + 1] : null
          const previous = index > 0 ? states[index - 1] : null
          const selected =
            confirm?.ticket.orderId === ticket.orderId &&
            confirm.ticket.revision === ticket.revision
          const ticketUrgency = urgency(ticket.issuedAt, now)
          return (
            <article
              key={ticket.orderId}
              className={`${styles.ticket} ${styles[ticket.status]} ${ticket.status === 'queued' || ticket.status === 'preparing' ? styles[ticketUrgency] : ''}`}
              aria-label={`Order ${ticket.invoiceNumber}`}
            >
              <div className={styles.ticketTop}>
                <h3>{ticket.invoiceNumber}</h3>
                <span className={styles.badge}>{labels[ticket.status]}</span>
              </div>
              <p className={styles.orderMeta}>
                <strong>{serviceLabels[ticket.serviceType]}</strong>
                <span>{time(ticket.issuedAt)} Dubai time</span>
              </p>
              <p
                className={`${styles.elapsed} ${ticketUrgency === 'late' ? styles.elapsedLate : ''}`}
              >
                {ticket.status === 'served' || ticket.status === 'cancelled'
                  ? `${labels[ticket.status]} at ${time(ticket.updatedAt)}`
                  : ticketUrgency === 'late'
                    ? `Late · ${age(ticket.issuedAt, now)}`
                    : ticketUrgency === 'watch'
                      ? `Watch · ${age(ticket.issuedAt, now)}`
                      : age(ticket.issuedAt, now)}
              </p>
              {ticket.orderNote && <p className={styles.notes}>Note: {ticket.orderNote}</p>}
              <ul className={styles.lines}>
                {ticket.lines.map((line) => (
                  <li key={line.lineNumber}>
                    <strong>
                      {new Intl.NumberFormat('en-AE', { maximumFractionDigits: 3 }).format(
                        line.quantityMilli / 1000
                      )}{' '}
                      <span>{line.unit}</span>
                    </strong>
                    <span>{line.name}</span>
                  </li>
                ))}
              </ul>
              {ticket.status === 'cancelled' && (
                <p className={styles.refund}>
                  Refund recorded. Stop preparation and check with the counter if food has already
                  left the kitchen.
                </p>
              )}
              {selected ? (
                <div className={styles.confirm}>
                  <p>
                    <strong>
                      {confirm.status === 'served'
                        ? 'Confirm this order has been handed over.'
                        : `Move this ticket back to ${labels[confirm.status].toLowerCase()}?`}
                    </strong>
                  </p>
                  {confirm.status !== 'served' && (
                    <label>
                      Reason for correction
                      <textarea
                        value={reason}
                        maxLength={240}
                        onChange={(event) => setReason(event.target.value)}
                      />
                    </label>
                  )}
                  <button
                    className={styles.primary}
                    disabled={!mayAct || (confirm.status !== 'served' && !reason.trim())}
                    onClick={() =>
                      change(
                        ticket,
                        confirm.status,
                        confirm.status === 'served' ? null : reason.trim()
                      )
                    }
                  >
                    {confirm.status === 'served' ? 'Confirm served' : 'Save correction'}
                  </button>
                  <button
                    onClick={() => {
                      setConfirm(null)
                      setReason('')
                    }}
                  >
                    Keep current state
                  </button>
                </div>
              ) : (
                <div className={styles.ticketActions}>
                  {next && (
                    <button
                      className={styles.primary}
                      disabled={!mayAct}
                      onClick={() => {
                        if (next === 'served') setConfirm({ ticket, status: next })
                        else change(ticket, next)
                      }}
                    >
                      {actionLabels[next as keyof typeof actionLabels]}
                    </button>
                  )}
                  {manager && previous && (
                    <button
                      disabled={!mayAct}
                      onClick={() => {
                        setReason('')
                        setConfirm({ ticket, status: previous })
                      }}
                    >
                      Correct to {labels[previous].toLowerCase()}
                    </button>
                  )}
                </div>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}
