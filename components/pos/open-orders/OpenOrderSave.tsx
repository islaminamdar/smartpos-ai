'use client'
import { useEffect, useRef, useState } from 'react'
import {
  openOrderCommandSchema,
  type OpenOrderCommand,
  type OpenOrderTab,
} from '@/lib/pos/server/open-order-contracts'
import { useOpenOrderCommands, OpenOrderPendingPanel, type OpenOrderScope } from './transport'
import { useOpenOrderList } from './useOpenOrderList'
import styles from './open-orders.module.css'
import TapChoices from '@/components/pos/TapChoices'
type SaveCommand = Extract<OpenOrderCommand, { type: 'tab.save' }>
type Props = OpenOrderScope & {
  deviceId: string
  sourceTab: OpenOrderTab | null
  initialTableId?: string | null
  serviceType: SaveCommand['serviceType']
  lines: SaveCommand['lines']
  onSaved: (tab: OpenOrderTab) => void | Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}
export default function OpenOrderSave(props: Props) {
  return (
    <Save
      key={`${props.actorId}:${props.branchId}:${props.deviceId}:${props.sourceTab?.id ?? 'new'}:${props.sourceTab?.revision ?? 0}:${props.initialTableId ?? ''}`}
      {...props}
    />
  )
}
function Save(props: Props) {
  const state = useOpenOrderCommands({
      ...props,
      onResolved: async (command, result) => {
        if (
          result.status === 'updated' &&
          'tab' in result &&
          (command.type === 'tab.save' || command.type === 'tab.reopen')
        ) {
          // Adopt the canonical source before releasing the durable pending-payment guard.
          await props.onSaved(result.tab)
        }
        await props.onResolved?.(command, result)
      },
    }),
    list = useOpenOrderList(props.branchId, props.deviceId)
  const [label, setLabel] = useState(props.sourceTab?.label ?? ''),
    [note, setNote] = useState(props.sourceTab?.note ?? '')
  const [tableId, setTableId] = useState(props.sourceTab?.tableId ?? props.initialTableId ?? ''),
    [guestCount, setGuestCount] = useState(
      props.sourceTab?.guestCount ? String(props.sourceTab.guestCount) : ''
    )
  const [reason, setReason] = useState(''),
    [error, setError] = useState('')
  const alive = useRef(false),
    locked = useRef(false),
    dirtyCallback = useRef(props.onDirtyChange)
  dirtyCallback.current = props.onDirtyChange
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const effectiveTable = props.serviceType === 'dine_in' ? tableId : ''
  const dirty =
    label !== (props.sourceTab?.label ?? '') ||
    note !== (props.sourceTab?.note ?? '') ||
    effectiveTable !== (props.sourceTab?.tableId ?? props.initialTableId ?? '') ||
    guestCount !== (props.sourceTab?.guestCount ? String(props.sourceTab.guestCount) : '') ||
    !!reason.trim()
  useEffect(() => {
    dirtyCallback.current?.(dirty)
  }, [dirty])
  const manager = list.data?.actorRole === 'owner' || list.data?.actorRole === 'manager'
  const reopening = props.sourceTab?.status === 'voided'
  const permittedTable =
    !effectiveTable ||
    list.data?.tables.some(
      (table) =>
        table.id === effectiveTable &&
        table.active &&
        (!table.occupiedTabId || table.occupiedTabId === props.sourceTab?.id)
    )
  const validGuests =
    guestCount === '' ||
    (Number.isInteger(Number(guestCount)) && Number(guestCount) >= 1 && Number(guestCount) <= 99)
  const maySave =
    state.ready &&
    !state.pending &&
    !state.busy &&
    !props.disabled &&
    list.fresh &&
    !list.loading &&
    permittedTable &&
    validGuests &&
    !!label.trim() &&
    props.sourceTab?.status !== 'settled' &&
    (!reopening || (manager && !!reason.trim()))
  async function execute(command: OpenOrderCommand, recover = false, existing = false) {
    if (locked.current) return
    locked.current = true
    list.hold()
    setError('')
    try {
      await state.execute(command, recover, existing)
    } catch {
      if (alive.current)
        setError(
          'The saved result could not be opened at this counter. Open the saved order from Open orders before taking payment.'
        )
    } finally {
      locked.current = false
      if (alive.current) await list.resume()
    }
  }
  function submit() {
    if (!maySave) return
    const parsed = openOrderCommandSchema.safeParse({
      id: crypto.randomUUID(),
      branchId: props.branchId,
      deviceId: props.deviceId,
      type: reopening ? 'tab.reopen' : 'tab.save',
      tabId: props.sourceTab?.id ?? crypto.randomUUID(),
      expectedRevision: props.sourceTab?.revision ?? 0,
      label: label.trim(),
      note: note.trim(),
      tableId: effectiveTable || null,
      guestCount: guestCount ? Number(guestCount) : null,
      serviceType: props.serviceType,
      lines: props.lines,
      ...(reopening ? { reason: reason.trim() } : {}),
    })
    if (!parsed.success) {
      setError(
        'Review the order label, table, guest count and menu items before saving. No request was sent.'
      )
      return
    }
    void execute(parsed.data)
  }
  return (
    <section className={styles.save} aria-label="Save unpaid order">
      <OpenOrderPendingPanel
        key={state.pending?.id ?? 'none'}
        state={state}
        disabled={props.disabled}
        run={(recover) => {
          if (state.pending) void execute(state.pending, recover, true)
        }}
      />
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <details open={!!props.sourceTab || !!props.initialTableId}>
        <summary className={styles.saveSummary}>
          {props.sourceTab
            ? reopening
              ? 'Review and reopen unpaid order'
              : 'Saved order details'
            : 'Save this order for later'}
        </summary>
        <p className={styles.help}>
          Saving takes no payment. After saving, use Kitchen preparation to send this order before
          payment. Offers are applied at payment.
        </p>
        {list.error && (
          <p className={styles.error} role="alert">
            {list.error}
          </p>
        )}
        <button
          type="button"
          disabled={list.loading || state.busy || props.disabled}
          onClick={() => void list.load()}
        >
          {list.loading ? 'Refreshing tables…' : 'Refresh table availability'}
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <label>
            Order label
            <input
              value={label}
              maxLength={120}
              required
              disabled={props.disabled || state.busy || !!state.pending}
              placeholder="For example, Table 4 lunch or Ahmed takeaway"
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          {props.serviceType === 'dine_in' && (
            <TapChoices
              label="Table"
              value={tableId}
              disabled={props.disabled || state.busy || !!state.pending || !list.fresh}
              onChange={setTableId}
              options={[
                { value: '', label: 'No table assigned' },
                ...(list.data?.tables
                  .filter(
                    (table) =>
                      table.active &&
                      (!table.occupiedTabId || table.occupiedTabId === props.sourceTab?.id)
                  )
                  .map((table) => ({
                    value: table.id,
                    label: `${table.name}${table.area ? ` — ${table.area}` : ''}`,
                  })) ?? []),
              ]}
            />
          )}
          {!permittedTable && (
            <p className={styles.error}>
              This table is no longer available. Choose another table or remove its assignment
              before saving.
            </p>
          )}
          <label>
            Guests (optional)
            <input
              type="number"
              min={1}
              max={99}
              value={guestCount}
              disabled={props.disabled || state.busy || !!state.pending}
              onChange={(event) => setGuestCount(event.target.value)}
            />
          </label>
          <label>
            Order note
            <textarea
              value={note}
              maxLength={400}
              disabled={props.disabled || state.busy || !!state.pending}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          {reopening && (
            <>
              <p className={styles.help}>
                Review all items and current prices before reopening this voided order. Only a
                manager can reopen it.
              </p>
              <label>
                Reason for reopening
                <textarea
                  value={reason}
                  required
                  maxLength={240}
                  disabled={props.disabled || state.busy || !!state.pending}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
            </>
          )}
          <button className={styles.primary} disabled={!maySave}>
            {state.busy
              ? 'Saving…'
              : reopening
                ? 'Reopen unpaid order'
                : props.sourceTab
                  ? 'Save order changes'
                  : 'Save unpaid order'}
          </button>
        </form>
      </details>
    </section>
  )
}
