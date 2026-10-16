'use client'
import { useEffect, useRef, useState } from 'react'
import {
  openOrderCommandSchema,
  openOrderDetailSchema,
  type OpenOrderCommand,
  type OpenOrderTab,
  type OpenOrderTable,
} from '@/lib/pos/server/open-order-contracts'
import { formatFils } from '@/lib/pos/money'
import {
  openOrderCall,
  useOpenOrderCommands,
  OpenOrderPendingPanel,
  type OpenOrderScope,
} from './transport'
import { useOpenOrderList } from './useOpenOrderList'
import styles from './open-orders.module.css'
export { OpenOrderPendingRecovery } from './transport'
export { default as OpenOrderSave } from './OpenOrderSave'

type Props = OpenOrderScope & {
  branchName: string
  deviceId: string
  onOpen: (tab: OpenOrderTab) => void | Promise<void>
  onStartTable: (table: OpenOrderTable) => void | Promise<void>
}
const serviceLabels = { dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' }
const time = (value: string) =>
  new Date(value).toLocaleString('en-AE', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Dubai',
  })
export default function OpenOrdersBoard(props: Props) {
  return <Board key={`${props.actorId}:${props.branchId}:${props.deviceId}`} {...props} />
}
function Board(props: Props) {
  const state = useOpenOrderCommands(props),
    list = useOpenOrderList(props.branchId, props.deviceId)
  const [view, setView] = useState<'orders' | 'tables' | 'recent'>('orders'),
    [opening, setOpening] = useState(false),
    [error, setError] = useState('')
  const [editor, setEditor] = useState<OpenOrderTable | 'new' | null>(null),
    [voiding, setVoiding] = useState<OpenOrderTab | null>(null),
    [reason, setReason] = useState('')
  const alive = useRef(false),
    locked = useRef(false),
    detailController = useRef<AbortController | null>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      detailController.current?.abort()
    }
  }, [])
  const manager = list.data?.actorRole === 'owner' || list.data?.actorRole === 'manager'
  const mayAct =
    state.ready &&
    !state.pending &&
    !state.busy &&
    !props.disabled &&
    list.fresh &&
    !list.loading &&
    !opening
  async function execute(command: OpenOrderCommand, recovery = false, existing = false) {
    if (locked.current) return
    locked.current = true
    list.hold()
    setError('')
    try {
      await state.execute(command, recovery, existing)
      if (alive.current) {
        setEditor(null)
        setVoiding(null)
        setReason('')
      }
    } finally {
      locked.current = false
      if (alive.current) await list.resume()
    }
  }
  async function open(tabId: string) {
    if (!mayAct || locked.current) return
    locked.current = true
    setOpening(true)
    setError('')
    detailController.current = new AbortController()
    try {
      const query = new URLSearchParams({
        branchId: props.branchId,
        deviceId: props.deviceId,
        tabId,
      })
      const result = openOrderDetailSchema.parse(
        await openOrderCall(
          `/api/pos/open-orders?${query}`,
          undefined,
          detailController.current.signal
        )
      )
      if (
        result.branchId !== props.branchId ||
        result.tab.id !== tabId ||
        result.tab.status === 'settled' ||
        (result.tab.status === 'voided' && result.actorRole === 'cashier')
      )
        throw new Error('scope_or_state')
      if (alive.current) await props.onOpen(result.tab)
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error &&
            cause.name !== 'ZodError' &&
            cause.message !== 'scope_or_state' &&
            !('code' in cause)
            ? cause.message
            : 'This order could not be opened. It may have changed or been paid. Refresh the list before trying again.'
        )
    } finally {
      locked.current = false
      if (alive.current) {
        setOpening(false)
        await list.load()
      }
    }
  }
  async function start(table: OpenOrderTable) {
    if (!mayAct || locked.current || table.occupiedTabId || !table.active) return
    locked.current = true
    setOpening(true)
    setError('')
    try {
      await props.onStartTable(table)
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : 'The table could not be selected.')
    } finally {
      locked.current = false
      if (alive.current) setOpening(false)
    }
  }
  const data = list.data,
    tabs = data ? (view === 'recent' ? data.recentTabs : data.openTabs) : []
  return (
    <section className={styles.board} aria-label="Shared unpaid orders">
      <header className={styles.heading}>
        <div>
          <h2>Open orders at {props.branchName}</h2>
          <p>Save an order here and continue it from another counter.</p>
        </div>
        <button
          disabled={list.loading || state.busy || opening || props.disabled}
          onClick={() => void list.load()}
        >
          {list.loading ? 'Refreshing…' : 'Refresh orders'}
        </button>
      </header>
      <p className={styles.scope}>
        Unpaid orders are saved for your team. Open an order at the counter and use Kitchen
        preparation to send it before payment.
      </p>
      <OpenOrderPendingPanel
        key={state.pending?.id ?? 'none'}
        state={state}
        disabled={props.disabled}
        run={(recover) => {
          if (state.pending) void execute(state.pending, recover, true)
        }}
      />
      {(error || list.error) && (
        <p className={styles.error} role="alert">
          {error || list.error}
        </p>
      )}
      {!data && list.loading && <p role="status">Loading saved orders and tables…</p>}
      {data && (
        <>
          <p className={styles.updated}>
            {list.fresh ? 'Last confirmed' : 'Last confirmed view — refresh needed'}{' '}
            {time(data.generatedAt)} Dubai time. Refreshes every 10 seconds while visible.
          </p>
          <nav className={styles.toolbar} aria-label="Open order views">
            <button
              aria-pressed={view === 'orders'}
              onClick={() => {
                setView('orders')
                setEditor(null)
              }}
            >
              Orders ({data.openCount})
            </button>
            <button
              aria-pressed={view === 'tables'}
              onClick={() => {
                setView('tables')
                setVoiding(null)
              }}
            >
              Tables ({data.tables.length})
            </button>
            <button
              aria-pressed={view === 'recent'}
              onClick={() => {
                setView('recent')
                setEditor(null)
              }}
            >
              Recent history
            </button>
          </nav>
          {view === 'tables' ? (
            <>
              <div className={styles.actions}>
                <p className={styles.help}>
                  One open order per table. Availability includes orders on every page.
                </p>
                {manager && (
                  <button disabled={!mayAct} onClick={() => setEditor('new')}>
                    Add table
                  </button>
                )}
              </div>
              {editor && manager && (
                <TableEditor
                  key={editor === 'new' ? 'new' : `${editor.id}:${editor.revision}`}
                  table={editor === 'new' ? null : editor}
                  disabled={!mayAct}
                  onCancel={() => setEditor(null)}
                  onSave={(table, expectedRevision, changeReason) =>
                    void execute(
                      openOrderCommandSchema.parse({
                        id: crypto.randomUUID(),
                        branchId: props.branchId,
                        deviceId: props.deviceId,
                        type: 'table.save',
                        table,
                        expectedRevision,
                        reason: changeReason,
                      })
                    )
                  }
                />
              )}
              {data.tables.length === 0 && (
                <p className={styles.empty}>
                  {manager
                    ? 'No tables are configured. Add your first table to start dine-in orders.'
                    : 'No tables are configured. Ask your manager to add them.'}
                </p>
              )}
              <div className={styles.tables}>
                {data.tables.map((table) => (
                  <article
                    key={table.id}
                    className={`${styles.table} ${!table.active ? styles.inactive : table.occupiedTabId ? styles.occupied : ''}`}
                    aria-label={`Table ${table.name}`}
                  >
                    <h3>{table.name}</h3>
                    <p>
                      {table.area || 'No area assigned'} · {table.seats}{' '}
                      {table.seats === 1 ? 'seat' : 'seats'}
                    </p>
                    <p>
                      <strong>
                        {!table.active
                          ? 'Inactive'
                          : table.occupiedTabId
                            ? 'Order open'
                            : 'Available'}
                      </strong>
                    </p>
                    {table.active && (
                      <button
                        className={styles.primary}
                        disabled={!mayAct}
                        onClick={() =>
                          table.occupiedTabId ? void open(table.occupiedTabId) : void start(table)
                        }
                      >
                        {table.occupiedTabId ? 'Open order' : 'Start order'}
                      </button>
                    )}
                    {manager && (
                      <button disabled={!mayAct} onClick={() => setEditor(table)}>
                        Edit table
                      </button>
                    )}
                  </article>
                ))}
              </div>
            </>
          ) : (
            <>
              {view === 'recent' && (
                <p className={styles.help}>
                  Recent paid and voided orders.
                  {data.recentTruncated ? ' Only the latest 50 are shown.' : ''} Paid invoices
                  remain available in Receipts.
                </p>
              )}
              {view === 'orders' && (list.cursor || data.openNextCursor) && (
                <div className={styles.pagination}>
                  <p>
                    Showing {data.openTabs.length} of {data.openCount} open orders. Table
                    availability includes every page.
                  </p>
                  <button
                    disabled={!list.cursor || list.loading || state.busy || opening}
                    onClick={() => {
                      setVoiding(null)
                      void list.load(null)
                    }}
                  >
                    First page
                  </button>
                  <button
                    disabled={!data.openNextCursor || list.loading || state.busy || opening}
                    onClick={() => {
                      setVoiding(null)
                      void list.load(data.openNextCursor)
                    }}
                  >
                    Next page
                  </button>
                </div>
              )}
              {tabs.length === 0 && (
                <p className={styles.empty}>
                  {view === 'recent'
                    ? 'No recent paid or voided orders.'
                    : data.openCount
                      ? 'No orders on this page. Return to the first page.'
                      : 'No unpaid orders in this branch. Save an order from Sell to share it here.'}
                </p>
              )}
              <div className={styles.orders}>
                {tabs.map((tab) => (
                  <article
                    key={tab.id}
                    className={styles.order}
                    aria-label={`Saved order ${tab.label}`}
                  >
                    <div className={styles.orderTop}>
                      <div>
                        <h3>{tab.label}</h3>
                        <p className={styles.reference}>Order {tab.id.slice(0, 8)}</p>
                      </div>
                      <span className={styles.badge}>
                        {tab.status === 'open'
                          ? 'Unpaid'
                          : tab.status === 'voided'
                            ? 'Voided'
                            : 'Paid'}
                      </span>
                    </div>
                    <p className={styles.meta}>
                      <strong>{serviceLabels[tab.serviceType]}</strong>
                      {tab.tableId && (
                        <span>
                          {data.tables.find((table) => table.id === tab.tableId)?.name ??
                            'Previously assigned table'}
                        </span>
                      )}
                      {tab.guestCount && (
                        <span>
                          {tab.guestCount} {tab.guestCount === 1 ? 'guest' : 'guests'}
                        </span>
                      )}
                    </p>
                    <p className={styles.money}>
                      AED {formatFils(tab.subtotalFils)}
                      <small>
                        {tab.status === 'settled'
                          ? 'Saved order estimate; see the invoice for payment totals'
                          : 'Saved estimate before payment offers; VAT included'}
                      </small>
                    </p>
                    <p className={styles.updated}>Saved {time(tab.updatedAt)} Dubai time</p>
                    <OrderLines tab={tab} />
                    {tab.note && <p className={styles.notes}>{tab.note}</p>}
                    {voiding?.id === tab.id && voiding.revision === tab.revision ? (
                      <div className={styles.confirm}>
                        <p>
                          <strong>Void this unpaid order?</strong> It will leave the open list and
                          release its table. No payment is refunded.
                        </p>
                        <label>
                          Reason for voiding
                          <textarea
                            maxLength={240}
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                          />
                        </label>
                        <div className={styles.actions}>
                          <button
                            className={styles.danger}
                            disabled={!mayAct || !reason.trim()}
                            onClick={() =>
                              void execute(
                                openOrderCommandSchema.parse({
                                  id: crypto.randomUUID(),
                                  branchId: props.branchId,
                                  deviceId: props.deviceId,
                                  type: 'tab.void',
                                  tabId: tab.id,
                                  expectedRevision: tab.revision,
                                  reason: reason.trim(),
                                })
                              )
                            }
                          >
                            Confirm void
                          </button>
                          <button onClick={() => setVoiding(null)}>Keep order</button>
                        </div>
                      </div>
                    ) : (
                      <div className={styles.actions}>
                        {tab.status === 'open' && (
                          <button
                            className={styles.primary}
                            disabled={!mayAct}
                            onClick={() => void open(tab.id)}
                          >
                            Open at counter
                          </button>
                        )}
                        {manager && tab.status === 'open' && (
                          <button
                            disabled={!mayAct}
                            onClick={() => {
                              setReason('')
                              setVoiding(tab)
                            }}
                          >
                            Void order
                          </button>
                        )}
                        {manager && tab.status === 'voided' && (
                          <button disabled={!mayAct} onClick={() => void open(tab.id)}>
                            Review and reopen
                          </button>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
function OrderLines({ tab }: { tab: OpenOrderTab }) {
  const lines = (items: OpenOrderTab['lines']) => (
    <ul className={styles.lines}>
      {items.map((line) => (
        <li key={line.productId}>
          <strong>
            {new Intl.NumberFormat('en-AE', { maximumFractionDigits: 3 }).format(
              line.quantityMilli / 1000
            )}{' '}
            <small>{line.unit}</small>
          </strong>
          <span>{line.name}</span>
        </li>
      ))}
    </ul>
  )
  return (
    <>
      {lines(tab.lines.slice(0, 3))}
      {tab.lines.length > 3 && (
        <details>
          <summary>Show {tab.lines.length - 3} more items</summary>
          {lines(tab.lines.slice(3))}
        </details>
      )}
      {!tab.lines.length && <p className={styles.help}>No items added yet.</p>}
    </>
  )
}
function TableEditor({
  table,
  disabled,
  onCancel,
  onSave,
}: {
  table: OpenOrderTable | null
  disabled: boolean
  onCancel: () => void
  onSave: (
    table: { id: string; name: string; area: string; seats: number; active: boolean },
    revision: number,
    reason: string
  ) => void
}) {
  const [name, setName] = useState(table?.name ?? ''),
    [area, setArea] = useState(table?.area ?? ''),
    [seats, setSeats] = useState(String(table?.seats ?? 2)),
    [active, setActive] = useState(table?.active ?? true),
    [reason, setReason] = useState('')
  return (
    <form
      className={styles.editor}
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled)
          onSave(
            {
              id: table?.id ?? crypto.randomUUID(),
              name: name.trim(),
              area: area.trim(),
              seats: Number(seats),
              active,
            },
            table?.revision ?? 0,
            reason.trim()
          )
      }}
    >
      <h3>{table ? `Edit ${table.name}` : 'Add table'}</h3>
      <label>
        Table name
        <input
          value={name}
          maxLength={80}
          required
          disabled={disabled}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        Area
        <input
          value={area}
          maxLength={80}
          disabled={disabled}
          onChange={(event) => setArea(event.target.value)}
          placeholder="For example, Main hall"
        />
      </label>
      <label>
        Seats
        <input
          type="number"
          min={1}
          max={99}
          required
          value={seats}
          disabled={disabled}
          onChange={(event) => setSeats(event.target.value)}
        />
      </label>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={active}
          disabled={disabled || !!table?.occupiedTabId}
          onChange={(event) => setActive(event.target.checked)}
        />
        Active table
      </label>
      {table?.occupiedTabId && (
        <p className={styles.help}>
          This table has an open order. Settle, void or move the order before deactivating the
          table.
        </p>
      )}
      <label>
        Reason for table change
        <textarea
          value={reason}
          required
          maxLength={240}
          disabled={disabled}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <div className={styles.actions}>
        <button
          className={styles.primary}
          disabled={
            disabled ||
            !name.trim() ||
            !reason.trim() ||
            !Number.isInteger(Number(seats)) ||
            Number(seats) < 1 ||
            Number(seats) > 99
          }
        >
          Save table
        </button>
        <button type="button" disabled={disabled} onClick={onCancel}>
          Close table setup
        </button>
      </div>
    </form>
  )
}
