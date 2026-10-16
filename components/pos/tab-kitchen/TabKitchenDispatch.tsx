'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  tabKitchenCommandSchema,
  tabKitchenTabSchema,
  type TabKitchenTab,
  type TabKitchenCommand,
} from '@/lib/pos/server/tab-kitchen'
import {
  openOrderListSchema,
  type OpenOrderTab,
  type OpenOrderTable,
} from '@/lib/pos/server/open-order-contracts'
import {
  tabKitchenCall,
  useTabKitchenCommands,
  TabKitchenPendingPanel,
  type TabKitchenScope,
} from './transport'
import {
  ChangeList,
  KitchenLines,
  Metadata,
  changesBetween,
  type KitchenMetadata,
  stages,
  stageLabels,
  quantity,
} from './presentation'
import styles from './tab-kitchen.module.css'
type Props = TabKitchenScope & {
  branchName: string
  deviceId: string
  tab: OpenOrderTab
  onPaymentReady?: (ready: boolean) => void
}
export default function TabKitchenDispatch(props: Props) {
  return (
    <Dispatch
      key={`${props.actorId}:${props.branchId}:${props.deviceId}:${props.tab.id}`}
      {...props}
    />
  )
}
function Dispatch(props: Props) {
  const state = useTabKitchenCommands(props)
  const [data, setData] = useState<TabKitchenTab | null>(null),
    [tables, setTables] = useState<OpenOrderTable[]>([])
  const [fresh, setFresh] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false),
    [reason, setReason] = useState('')
  const alive = useRef(false),
    reading = useRef(false),
    writing = useRef(false),
    epoch = useRef(0),
    latestData = useRef<TabKitchenTab | null>(null),
    controller = useRef<AbortController | null>(null),
    paymentCallback = useRef(props.onPaymentReady)
  paymentCallback.current = props.onPaymentReady
  const load = useCallback(async () => {
    if (reading.current || writing.current) return
    reading.current = true
    setLoading(true)
    const generation = ++epoch.current,
      abort = new AbortController()
    controller.current = abort
    const query = new URLSearchParams({
      branchId: props.branchId,
      deviceId: props.deviceId,
      tabId: props.tab.id,
    })
    try {
      const [raw, tableRaw] = await Promise.all([
        tabKitchenCall(`/api/pos/tab-kitchen?${query}`, undefined, abort.signal),
        tabKitchenCall(
          `/api/pos/open-orders?${new URLSearchParams({ branchId: props.branchId, deviceId: props.deviceId })}`,
          undefined,
          abort.signal
        ),
      ])
      const result = tabKitchenTabSchema.parse(raw),
        tableResult = openOrderListSchema.parse(tableRaw)
      if (
        result.branchId !== props.branchId ||
        result.tabId !== props.tab.id ||
        tableResult.branchId !== props.branchId
      )
        throw new Error('scope')
      if (alive.current && generation === epoch.current) {
        if (
          latestData.current?.ticket?.revision !== result.ticket?.revision ||
          latestData.current?.tabRevision !== result.tabRevision
        ) {
          setConfirm(false)
          setReason('')
        }
        latestData.current = result
        setData(result)
        setTables(tableResult.tables)
        setFresh(true)
        setError('')
      }
    } catch {
      if (alive.current && generation === epoch.current) {
        setFresh(false)
        setError(
          'Kitchen dispatch could not be checked. Keep the saved order and refresh before sending changes or taking payment.'
        )
      }
    } finally {
      if (generation === epoch.current) {
        reading.current = false
        if (alive.current) setLoading(false)
      }
    }
  }, [props.branchId, props.deviceId, props.tab.id])
  useEffect(() => {
    alive.current = true
    void load()
    const refresh = () => {
      if (document.visibilityState === 'visible') void load()
    }
    const offline = () => {
      setFresh(false)
      setError('Connection lost. Refresh kitchen dispatch before continuing.')
    }
    const timer = window.setInterval(refresh, 10000)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('online', refresh)
    window.addEventListener('offline', offline)
    return () => {
      alive.current = false
      // Invalidate asynchronous reads; this ref is a numeric generation, not a DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epoch.current++
      controller.current?.abort()
      reading.current = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('online', refresh)
      window.removeEventListener('offline', offline)
      paymentCallback.current?.(false)
    }
  }, [load])
  useEffect(() => {
    setFresh(false)
    setConfirm(false)
    setReason('')
    void load()
  }, [props.tab.revision, load])
  const matches = !!data && data.tabRevision === props.tab.revision
  useEffect(() => {
    paymentCallback.current?.(
      !!data &&
        fresh &&
        !loading &&
        matches &&
        !state.pending &&
        !state.busy &&
        !data.dispatchRequired
    )
  }, [data, fresh, loading, matches, state.pending, state.busy])
  const ticket = data?.ticket ?? null
  const metadata: KitchenMetadata = {
    label: props.tab.label,
    serviceType: props.tab.serviceType,
    tableId: props.tab.tableId,
    tableName: props.tab.tableId
      ? (tables.find((table) => table.id === props.tab.tableId)?.name ?? null)
      : null,
    guestCount: props.tab.guestCount,
    note: props.tab.note,
  }
  const lines = props.tab.lines.map((line) => ({
    productId: line.productId,
    name: line.name,
    unit: line.unit,
    quantityMilli: line.quantityMilli,
  }))
  const changes = changesBetween(
    ticket ? { metadata: ticket.metadata, lines: ticket.lines } : null,
    { metadata, lines }
  )
  const reopen = ticket?.state === 'cancelled'
  const affectedPrepared =
    ticket?.lines.some((old) => {
      const current = lines.find((line) => line.productId === old.productId)
      const reduction =
        !current || current.unit !== old.unit
          ? old.quantityMilli
          : Math.max(0, old.quantityMilli - current.quantityMilli)
      const queued =
        ticket.stages.queued.find((line) => line.productId === old.productId)?.quantityMilli ?? 0
      return reduction > queued
    }) ?? false
  const manager = data?.actorRole === 'manager' || data?.actorRole === 'owner',
    needsReason = reopen || affectedPrepared
  const canSend =
    state.ready &&
    !state.pending &&
    !state.busy &&
    !props.disabled &&
    fresh &&
    matches &&
    !loading &&
    props.tab.status === 'open' &&
    lines.length > 0 &&
    (!ticket || data?.dispatchRequired) &&
    (!needsReason || manager)
  async function execute(command: TabKitchenCommand, recover = false, existing = false) {
    if (writing.current) return
    writing.current = true
    epoch.current++
    controller.current?.abort()
    reading.current = false
    setLoading(false)
    setFresh(false)
    setConfirm(false)
    try {
      await state.execute(command, recover, existing)
    } finally {
      writing.current = false
      if (alive.current) await load()
    }
  }
  return (
    <section className={styles.save} aria-label="Send saved order to kitchen">
      <h3>Kitchen preparation</h3>
      <TabKitchenPendingPanel
        key={state.pending?.id ?? 'none'}
        state={state}
        disabled={props.disabled}
        run={(recover) => {
          if (state.pending) void execute(state.pending, recover, true)
        }}
      />
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {data && !matches && (
        <p role="alert" className={styles.error}>
          This saved order changed at another counter. Reopen its latest revision before sending or
          taking payment.
        </p>
      )}
      {data && matches && (
        <p className={styles.scope}>
          {!ticket
            ? 'Not sent to the kitchen. Send this saved order now to begin preparation before payment.'
            : data.dispatchRequired
              ? 'Saved changes have not reached the kitchen. Send them before taking payment.'
              : `Kitchen has this order’s preparation details. Last dispatched order revision ${ticket.dispatchedTabRevision}.`}
        </p>
      )}
      {ticket && ticket.pendingChangeCount > 0 && (
        <p className={styles.help}>
          {ticket.pendingChangeCount} notices still need kitchen acknowledgement.
        </p>
      )}
      {needsReason && (
        <p className={styles.error}>
          {reopen
            ? 'This order was cancelled in the kitchen. A manager must confirm a new preparation round.'
            : 'This change withdraws quantities already preparing, ready or served. A manager and reason are required.'}
        </p>
      )}
      <div className={styles.actions}>
        <button disabled={loading || state.busy || props.disabled} onClick={() => void load()}>
          Refresh kitchen dispatch
        </button>
        <button
          className={styles.primary}
          disabled={!canSend}
          onClick={() => {
            setConfirm(true)
            setReason('')
          }}
        >
          {ticket ? 'Review kitchen changes' : 'Send to kitchen'}
        </button>
      </div>
      {!ticket && (
        <p className={styles.help}>
          Payment without dispatch creates a paid kitchen ticket instead. Sending here does not
          print a physical ticket or take payment.
        </p>
      )}
      {confirm && (
        <div className={styles.confirm} aria-label="Confirm kitchen dispatch">
          <h4>
            {reopen
              ? 'Start a new preparation round?'
              : ticket
                ? 'Send these saved changes?'
                : 'Send this saved order?'}
          </h4>
          <p>
            {props.branchName} · {props.tab.label} · Saved revision {props.tab.revision}
          </p>
          <ChangeList changes={changes} />
          {ticket && !changes.length && (
            <p>
              No item quantities or notes changed. Price-only changes do not repeat preparation.
            </p>
          )}
          {reopen && (
            <p>
              All current quantities will queue as new preparation. Earlier served work stays in
              dispatch history.
            </p>
          )}
          <h4>Current saved order</h4>
          <Metadata value={metadata} />
          <KitchenLines lines={lines} />
          {ticket && !reopen && (
            <>
              <h4>Already at the kitchen</h4>
              <ul className={styles.changes}>
                {stages.flatMap((stage) =>
                  ticket.stages[stage].map((line) => (
                    <li key={`${stage}:${line.productId}`}>
                      {stageLabels[stage]}: {quantity(line)} {line.name}
                    </li>
                  ))
                )}
              </ul>
              <p>
                Only additions queue new preparation. Removed quantities will be shown in a kitchen
                notice.
              </p>
            </>
          )}
          {needsReason && (
            <label>
              Reason for kitchen change
              <textarea
                maxLength={240}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          )}
          <div className={styles.actions}>
            <button
              className={styles.primary}
              disabled={!canSend || (needsReason && !reason.trim())}
              onClick={() => {
                if (!data) return
                void execute(
                  tabKitchenCommandSchema.parse({
                    id: crypto.randomUUID(),
                    branchId: props.branchId,
                    deviceId: props.deviceId,
                    type: 'dispatch',
                    tabId: props.tab.id,
                    expectedTabRevision: props.tab.revision,
                    expectedTicketRevision: ticket?.revision ?? 0,
                    reason: needsReason ? reason.trim() : null,
                  })
                )
              }}
            >
              Confirm send to kitchen
            </button>
            <button disabled={state.busy} onClick={() => setConfirm(false)}>
              Keep unsent
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
