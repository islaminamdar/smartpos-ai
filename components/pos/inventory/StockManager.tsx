'use client'

import { browserUuid } from '@/lib/pos/browser-uuid'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  inventoryCommandSchema,
  inventoryResultSchema,
  inventoryListSchema,
  inventoryHistorySchema,
  inventoryRecoverySchema,
  inventoryResultMatches,
  parseStockQuantity,
  formatStockQuantity,
  type StockItem,
  type InventoryCommand,
  type InventoryResult,
  type InventoryList,
  type InventoryHistory,
} from '@/lib/pos/inventory'
import styles from './inventory.module.css'
import { readStockRequest, saveStockRequest, clearStockRequest, stockJournalEvent } from './journal'

type Props = {
  actorId: string
  branchId: string
  branchName: string
  deviceId: string
  disabled: boolean
  onBusyChange?: (busy: boolean) => void
}
type MovementType = 'stock.receive' | 'stock.waste' | 'stock.count' | 'stock.adjust'
type InventoryFilter = 'all' | 'low' | 'uncounted' | 'inactive'
const names: Record<MovementType, string> = {
  'stock.receive': 'Receive',
  'stock.waste': 'Waste',
  'stock.count': 'Physical count',
  'stock.adjust': 'Adjustment',
}
const pastNames: Record<MovementType, string> = {
  'stock.receive': 'Received',
  'stock.waste': 'Waste recorded',
  'stock.count': 'Physical count',
  'stock.adjust': 'Adjustment',
}
const unitName = (unit: StockItem['unit']) =>
  unit === 'piece' ? 'pieces' : unit === 'litre' ? 'litres' : 'kg'
const quantity = (value: number | null, unit: StockItem['unit']) =>
  value === null ? 'Not counted' : `${formatStockQuantity(value, unit)} ${unitName(unit)}`
const time = (value: string) =>
  new Date(value).toLocaleString('en-AE', {
    timeZone: 'Asia/Dubai',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
class StockError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code)
  }
}
async function call(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  actorId?: string
): Promise<unknown> {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body
      ? { 'Content-Type': 'application/json', ...(actorId ? { 'X-POS-Actor': actorId } : {}) }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
      : AbortSignal.timeout(20000),
  })
  const raw: unknown = await response.json()
  if (!response.ok)
    throw new StockError(
      response.status,
      raw && typeof raw === 'object' && 'code' in raw ? String(raw.code) : 'unavailable'
    )
  return raw
}
function matches(command: InventoryCommand, result: InventoryResult, actorId: string) {
  return (
    inventoryResultMatches(result, command) &&
    (result.status !== 'applied' || !result.movement || result.movement.actorId === actorId)
  )
}

export default function StockManager(props: Props) {
  return <Manager key={`${props.actorId}:${props.branchId}:${props.deviceId}`} {...props} />
}
function Manager({ actorId, branchId, branchName, deviceId, disabled, onBusyChange }: Props) {
  const [list, setList] = useState<InventoryList | null>(null)
  const [items, setItems] = useState<StockItem[]>([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<InventoryFilter>('all')
  const [listBusy, setListBusy] = useState(false)
  const [listFresh, setListFresh] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [history, setHistory] = useState<InventoryHistory | null>(null)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyFresh, setHistoryFresh] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(false)
  const [movementType, setMovementType] = useState<MovementType>('stock.count')
  const [pending, setPending] = useState<InventoryCommand | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [cancelConsent, setCancelConsent] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [historyError, setHistoryError] = useState('')
  const mounted = useRef(false)
  const journalId = useRef<string | null>(null)
  const lock = useRef(false)
  const listGeneration = useRef(0),
    historyGeneration = useRef(0)
  const listAbort = useRef<AbortController | null>(null),
    historyAbort = useRef<AbortController | null>(null)
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  const historyRef = useRef(history)
  historyRef.current = history
  const callbacks = useRef(onBusyChange)
  callbacks.current = onBusyChange
  const detail = useRef<HTMLElement>(null)
  const item = history?.item.id === selectedId ? history.item : null

  const loadList = useCallback(
    async (afterId?: string) => {
      listAbort.current?.abort()
      const controller = new AbortController()
      listAbort.current = controller
      const generation = ++listGeneration.current
      setListBusy(true)
      setListFresh(false)
      try {
        const query = new URLSearchParams({ branchId, search: search.trim(), filter })
        if (afterId) query.set('afterId', afterId)
        const result = inventoryListSchema.parse(
          await call(`/api/pos/inventory?${query}`, undefined, controller.signal)
        )
        if (!mounted.current || generation !== listGeneration.current) return
        if (
          result.branchId !== branchId ||
          result.items.some((value) => value.branchId !== branchId)
        )
          throw new Error('scope')
        setList(result)
        setItems((previous) =>
          afterId
            ? [
                ...previous,
                ...result.items.filter(
                  (value) => !previous.some((existing) => existing.id === value.id)
                ),
              ]
            : result.items
        )
        setListFresh(true)
      } catch (cause) {
        if (!mounted.current || generation !== listGeneration.current) return
        if (cause instanceof StockError && (cause.status === 401 || cause.status === 403)) {
          setList(null)
          setItems([])
        }
        setError(
          'Stock could not be loaded. Refresh before making changes; unavailable figures are not zero.'
        )
      } finally {
        if (mounted.current && generation === listGeneration.current) setListBusy(false)
      }
    },
    [branchId, search, filter]
  )

  const loadHistory = useCallback(
    async (itemId: string, beforeRevision?: number) => {
      historyAbort.current?.abort()
      const controller = new AbortController()
      historyAbort.current = controller
      const generation = ++historyGeneration.current
      setHistoryBusy(true)
      setHistoryFresh(false)
      setHistoryError('')
      try {
        const query = new URLSearchParams({ branchId, itemId })
        if (beforeRevision !== undefined) query.set('beforeRevision', String(beforeRevision))
        const result = inventoryHistorySchema.parse(
          await call(`/api/pos/inventory/history?${query}`, undefined, controller.signal)
        )
        if (
          !mounted.current ||
          generation !== historyGeneration.current ||
          selectedRef.current !== itemId
        )
          return
        if (
          result.branchId !== branchId ||
          result.item.branchId !== branchId ||
          result.item.id !== itemId ||
          result.entries.some((entry) => entry.itemId !== itemId)
        )
          throw new Error('scope')
        if (
          beforeRevision !== undefined &&
          historyRef.current?.item.revision !== result.item.revision
        )
          throw new Error('history_changed')
        setHistory((previous) =>
          beforeRevision !== undefined && previous?.item.id === itemId
            ? {
                ...result,
                entries: [
                  ...previous.entries,
                  ...result.entries.filter(
                    (entry) => !previous.entries.some((existing) => existing.id === entry.id)
                  ),
                ],
              }
            : result
        )
        setHistoryFresh(true)
      } catch (cause) {
        if (
          !mounted.current ||
          generation !== historyGeneration.current ||
          selectedRef.current !== itemId
        )
          return
        if (cause instanceof StockError && (cause.status === 401 || cause.status === 403))
          setHistory(null)
        setHistoryError(
          'This item could not be verified. Refresh its history before recording a movement.'
        )
      } finally {
        if (mounted.current && generation === historyGeneration.current) setHistoryBusy(false)
      }
    },
    [branchId]
  )

  useEffect(() => {
    mounted.current = true
    const read = () => {
      try {
        const saved = readStockRequest(actorId, branchId, deviceId)
        if (journalId.current !== (saved?.id ?? null)) {
          setNotFound(false)
          setCancelConsent(false)
          journalId.current = saved?.id ?? null
        }
        setPending(saved)
        setReady(true)
      } catch {
        setReady(false)
        setError(
          'The saved stock request could not be read. Stock editing is paused. Contact your administrator before clearing browser data.'
        )
      }
    }
    read()
    window.addEventListener('storage', read)
    window.addEventListener(stockJournalEvent, read)
    return () => {
      mounted.current = false
      listAbort.current?.abort()
      historyAbort.current?.abort()
      callbacks.current?.(false)
      window.removeEventListener('storage', read)
      window.removeEventListener(stockJournalEvent, read)
    }
  }, [actorId, branchId, deviceId])
  const invalidateList = useCallback(() => {
    listGeneration.current++
    listAbort.current?.abort()
  }, [])
  useEffect(() => {
    setListFresh(false)
    const timer = setTimeout(() => {
      void loadList()
    }, 200)
    return () => {
      clearTimeout(timer)
      invalidateList()
    }
  }, [loadList, invalidateList])
  useEffect(() => {
    if (!pending) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pending])

  function select(value: StockItem) {
    if (lock.current || pending) return
    selectedRef.current = value.id
    setSelectedId(value.id)
    setHistory(null)
    setAdding(false)
    setEditing(false)
    setError('')
    setNotice('')
    setMovementType(value.onHandMilli === null ? 'stock.count' : 'stock.receive')
    void loadHistory(value.id)
    detail.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  async function execute(command: InventoryCommand, mode: 'write' | 'lookup' | 'cancel' = 'write') {
    if (lock.current || disabled || !ready) return
    if (mode === 'cancel' && (!notFound || !cancelConsent)) return
    lock.current = true
    setBusy(true)
    callbacks.current?.(true)
    setError('')
    setNotice('')
    let persisted = false,
      confirmed = false
    try {
      if (mode === 'write') await saveStockRequest(actorId, command)
      else if (
        JSON.stringify(readStockRequest(actorId, command.branchId, command.deviceId)) !==
        JSON.stringify(command)
      )
        throw new Error('stock_journal_mismatch')
      persisted = true
      if (mounted.current) {
        setPending(command)
        setNotFound(false)
        setCancelConsent(false)
      }
      const raw =
        mode === 'write'
          ? await call('/api/pos/inventory', command, undefined, actorId)
          : await call('/api/pos/inventory/recovery', { mode, command }, undefined, actorId)
      if (mode !== 'write') {
        const recovery = inventoryRecoverySchema.parse(raw)
        if (recovery.requestId !== command.id) throw new Error('ack_mismatch')
        if (recovery.status === 'not_found') {
          if (mounted.current) {
            setNotFound(true)
            setNotice(
              'No saved result was found yet. Retry this exact request, or cancel it before making another stock change.'
            )
          }
          return
        }
        if (recovery.status === 'cancelled') {
          confirmed = true
          await clearStockRequest(actorId, command)
          if (mounted.current) {
            setPending(null)
            setNotice(
              'The server confirmed this stock request was cancelled. A delayed copy cannot apply it.'
            )
            setSelectedId(null)
            selectedRef.current = null
            setHistory(null)
            setAdding(false)
            await loadList()
          }
          return
        }
      }
      const result = inventoryResultSchema.parse(raw)
      if (!matches(command, result, actorId)) throw new Error('ack_mismatch')
      confirmed = true
      await clearStockRequest(actorId, command)
      if (!mounted.current) return
      setPending(null)
      setAdding(false)
      setEditing(false)
      if (result.status === 'cancelled') {
        setNotice(
          'The server confirmed this stock request was cancelled. Refresh before making a new stock change.'
        )
        setSelectedId(null)
        selectedRef.current = null
        setHistory(null)
        await loadList()
        return
      }
      selectedRef.current = result.item.id
      setSelectedId(result.item.id)
      setHistory(null)
      setNotice(
        command.type === 'item.save'
          ? `${result.item.name} saved. Review the current recorded stock below.`
          : `${pastNames[command.type]} confirmed for ${result.item.name}. Current stock is refreshed separately.`
      )
      await Promise.all([loadList(), loadHistory(result.item.id)])
    } catch (cause) {
      if (!mounted.current) return
      if (!persisted) {
        setReady(false)
        setError(
          'This browser could not save the recovery record. Nothing was sent. Restore browser storage before changing stock.'
        )
      } else if (confirmed)
        setError(
          'The server confirmed the request, but local recovery or refresh failed. Check the saved request before another change.'
        )
      else if (cause instanceof StockError && cause.status === 401)
        setError(
          'Sign in to the original account again, then check the saved stock request. Do not repeat it as a new movement.'
        )
      else if (cause instanceof StockError && cause.status === 403)
        setError(
          'Restore the original account and enrolled counter access, then check this saved request. It has been kept safely.'
        )
      else if (cause instanceof StockError && cause.code.includes('conflict'))
        setError(
          'The item changed or this request conflicts with current stock. Check the saved request, then cancel it if it was not applied before reviewing current stock.'
        )
      else
        setError(
          'This stock change could not be confirmed. Check the saved request before recording another movement. It keeps the same request number to prevent duplicates.'
        )
    } finally {
      lock.current = false
      if (mounted.current) {
        setBusy(false)
        callbacks.current?.(false)
      }
    }
  }

  const blocked = disabled || busy || !!pending || !ready
  function showStock(filterValue: InventoryFilter) {
    setSearch('')
    setFilter(filterValue)
  }
  function saveItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (blocked || lock.current || (!adding && (!item || !historyFresh)) || !listFresh) return
    try {
      const data = new FormData(event.currentTarget)
      const unit = item && !adding ? item.unit : (String(data.get('unit')) as StockItem['unit'])
      const command = inventoryCommandSchema.parse({
        id: browserUuid(),
        type: 'item.save',
        branchId,
        deviceId,
        expectedRevision: adding ? 0 : item!.revision,
        reason: String(data.get('reason') || '').trim(),
        item: {
          id: adding ? browserUuid() : item!.id,
          name: String(data.get('name') || '').trim(),
          sku:
            String(data.get('sku') || '')
              .trim()
              .toUpperCase() || null,
          unit,
          reorderLevelMilli: parseStockQuantity(String(data.get('threshold') || ''), unit),
          active: data.get('active') === 'on',
        },
      })
      void execute(command)
    } catch {
      setError(
        'Enter an item name, a valid stock code, a non-negative reorder level and a reason. Pieces must be whole numbers; kg and litres allow up to three decimals.'
      )
    }
  }
  function saveMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (blocked || lock.current || !item || !historyFresh || !item.active) return
    try {
      const data = new FormData(event.currentTarget)
      const command = inventoryCommandSchema.parse({
        id: browserUuid(),
        type: movementType,
        branchId,
        deviceId,
        itemId: item.id,
        expectedRevision: item.revision,
        quantityMilli: parseStockQuantity(
          String(data.get('quantity') || ''),
          item.unit,
          movementType === 'stock.adjust'
        ),
        reason: String(data.get('reason') || '').trim(),
        reference: String(data.get('reference') || '').trim() || null,
      })
      if (item.onHandMilli === null && movementType !== 'stock.count')
        throw new Error('count_required')
      void execute(command)
    } catch {
      setError(
        'Check the quantity and reason. Receive and waste need a positive amount; adjustments need a non-zero change. Pieces must be whole numbers; kg and litres allow up to three decimals.'
      )
    }
  }

  return (
    <section className={styles.stock} aria-label="Branch stock">
      <header className={styles.header}>
        <div>
          <h2>Stock</h2>
          <p>{branchName}</p>
        </div>
        <div className={styles.actions}>
          <button
            disabled={busy || listBusy}
            onClick={() => {
              setError('')
              void loadList()
              if (selectedId) void loadHistory(selectedId)
            }}
          >
            Refresh stock
          </button>
          <button
            className={styles.primary}
            disabled={blocked || !listFresh}
            onClick={() => {
              if (lock.current) return
              setAdding(true)
              setEditing(false)
              setSelectedId(null)
              selectedRef.current = null
              setHistory(null)
              historyGeneration.current++
              historyAbort.current?.abort()
              setError('')
              setNotice('')
              detail.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
          >
            Add stock item
          </button>
        </div>
      </header>
      <div className={styles.scopeNote}>
        <strong>Recorded stock for this branch</strong>
        <p>
          Only recorded movements affect these figures. Sales do not deduct stock automatically.
          Recipe deductions are not available yet. Stock changes do not change menu availability.
        </p>
      </div>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {pending && (
        <section className={styles.warning} aria-label="Saved stock request">
          <strong>A stock change needs confirmation</strong>
          <p>
            {pending.type === 'item.save' ? 'Item details' : names[pending.type]} · Request{' '}
            {pending.id.slice(0, 8)}
          </p>
          <p>
            Keep this browser tab available. Check the saved request before making another stock
            change.
          </p>
          <div className={styles.actions}>
            <button disabled={busy || disabled} onClick={() => void execute(pending, 'lookup')}>
              {busy ? 'Checking…' : 'Check saved request'}
            </button>
            {notFound && (
              <button disabled={busy || disabled} onClick={() => void execute(pending)}>
                Retry exact request
              </button>
            )}
          </div>
          {notFound && (
            <>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={cancelConsent}
                  disabled={busy || disabled}
                  onChange={(event) => setCancelConsent(event.target.checked)}
                />
                Cancel this request only if it has not already been saved.
              </label>
              <button
                disabled={!cancelConsent || busy || disabled}
                onClick={() => void execute(pending, 'cancel')}
              >
                Cancel unsaved request
              </button>
              <p className={styles.help}>
                If it was already saved, the original result will be recovered instead.
              </p>
            </>
          )}
        </section>
      )}
      {list && (
        <section className={styles.overview} aria-label="Stock overview">
          <button
            type="button"
            className={styles.overviewCard}
            aria-pressed={filter === 'all'}
            disabled={busy || listBusy}
            onClick={() => showStock('all')}
          >
            <span>All stock items</span>
            <strong>{list.counts.totalItems}</strong>
            <small>{list.counts.activeItems} active</small>
          </button>
          <button
            type="button"
            className={styles.overviewCard}
            aria-pressed={filter === 'low'}
            disabled={busy || listBusy}
            onClick={() => showStock('low')}
          >
            <span>Low stock</span>
            <strong>{list.counts.lowStockItems}</strong>
            <small>At or below reorder level</small>
          </button>
          <button
            type="button"
            className={styles.overviewCard}
            aria-pressed={filter === 'uncounted'}
            disabled={busy || listBusy}
            onClick={() => showStock('uncounted')}
          >
            <span>Needs a count</span>
            <strong>{list.counts.uncountedItems}</strong>
            <small>Quantity has not been verified</small>
          </button>
          <button
            type="button"
            className={styles.overviewCard}
            aria-pressed={filter === 'inactive'}
            disabled={busy || listBusy}
            onClick={() => showStock('inactive')}
          >
            <span>Paused stock</span>
            <strong>{list.counts.inactiveItems}</strong>
            <small>Not available for movements</small>
          </button>
          <p className={styles.overviewHelp}>
            Select a card to filter the list. Figures are from recorded stock movements only
            {!listFresh ? ' · Refresh needed' : ''}.
          </p>
        </section>
      )}
      <div className={styles.layout}>
        <div>
          <div className={styles.toolbar}>
            <label>
              Find stock
              <input
                type="search"
                value={search}
                disabled={busy}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Item name or stock code"
              />
            </label>
            <label>
              Show stock
              <select
                value={filter}
                disabled={busy}
                onChange={(event) => setFilter(event.target.value as InventoryFilter)}
              >
                <option value="all">All stock</option>
                <option value="low">Low stock</option>
                <option value="uncounted">Not counted</option>
                <option value="inactive">Paused items</option>
              </select>
            </label>
          </div>
          {listBusy && <p role="status">Loading stock…</p>}
          {list && !listBusy && !items.length && (
            <div className={styles.empty}>
              <strong>
                {list.counts.totalItems === 0 ? 'No stock items yet' : 'No matching stock items'}
              </strong>
              <p>
                {list.counts.totalItems === 0
                  ? 'Add ingredients or supplies, then enter a physical count to establish their recorded quantity.'
                  : 'Try a different search or view.'}
              </p>
            </div>
          )}
          <div className={styles.list}>
            {items.map((value) => (
              <button
                key={value.id}
                className={styles.item}
                disabled={busy || !!pending || !listFresh}
                aria-pressed={selectedId === value.id}
                onClick={() => select(value)}
              >
                <span>
                  <strong>{value.name}</strong>
                  <small>
                    {value.sku || 'No stock code'} ·{' '}
                    {value.active ? unitName(value.unit) : 'Paused'}
                  </small>
                </span>
                <span className={styles.quantity}>
                  <strong>{quantity(value.onHandMilli, value.unit)}</strong>
                  {value.active &&
                    value.onHandMilli !== null &&
                    value.onHandMilli <= value.reorderLevelMilli && (
                      <span className={styles.low}>Low stock</span>
                    )}
                </span>
              </button>
            ))}
          </div>
          {list?.nextCursor && (
            <button
              disabled={busy || listBusy || !listFresh}
              onClick={() => void loadList(list.nextCursor!)}
            >
              Load more stock items
            </button>
          )}
          {list && (
            <p className={styles.help}>
              Showing {items.length} of {list.matchingItems} matching items. Updated{' '}
              {time(list.asOf)} Dubai time.
            </p>
          )}
        </div>
        <aside
          ref={detail}
          className={`${styles.detail} ${!adding && !selectedId ? styles.detailEmpty : ''}`}
          aria-label="Stock item details"
        >
          {!adding && !selectedId && (
            <>
              <h3>Select a stock item</h3>
              <p>Review its recorded balance, add a movement or check the history.</p>
            </>
          )}
          {historyBusy && !item && <p role="status">Loading item history…</p>}
          {historyError && (
            <p role="alert" className={styles.error}>
              {historyError}
            </p>
          )}
          {item && (
            <div className={styles.itemHeading}>
              <div>
                <h3>{item.name}</h3>
                <p className={styles.help}>
                  {item.sku || 'No stock code'} · {item.active ? 'Active' : 'Paused'}
                </p>
                <p className={styles.balance}>{quantity(item.onHandMilli, item.unit)}</p>
                <p className={styles.help}>
                  Reorder at {quantity(item.reorderLevelMilli, item.unit)} or below.
                  {!historyFresh ? ' Refresh needed.' : ''}
                </p>
              </div>
              <button
                disabled={blocked || !historyFresh}
                onClick={() => setEditing((value) => !value)}
              >
                {editing ? 'Back to movements' : 'Edit item details'}
              </button>
            </div>
          )}
          {(adding || (editing && item)) && (
            <form
              key={adding ? 'new-item' : `${item!.id}:${item!.revision}:details`}
              onSubmit={saveItem}
            >
              <h3>{adding ? 'New stock item' : 'Item details'}</h3>
              {adding && (
                <p className={styles.help}>
                  The quantity starts as not counted. Enter a physical count after saving, including
                  zero if none is on hand.
                </p>
              )}
              <fieldset disabled={blocked || !listFresh || (!adding && !historyFresh)}>
                <label>
                  Stock item name
                  <input
                    name="name"
                    required
                    maxLength={160}
                    defaultValue={adding ? '' : item!.name}
                  />
                </label>
                <label>
                  Stock code (optional)
                  <input
                    name="sku"
                    maxLength={64}
                    defaultValue={adding ? '' : (item!.sku ?? '')}
                    placeholder="For example, FLOUR-01"
                  />
                </label>
                {adding ? (
                  <label>
                    Stock unit
                    <select name="unit" defaultValue="kg">
                      <option value="kg">Kilograms</option>
                      <option value="litre">Litres</option>
                      <option value="piece">Pieces</option>
                    </select>
                  </label>
                ) : (
                  <p className={styles.help}>
                    Unit: {unitName(item!.unit)}. The unit of a saved item cannot be changed.
                  </p>
                )}
                <label>
                  Reorder level
                  <input
                    name="threshold"
                    inputMode="decimal"
                    required
                    defaultValue={
                      adding ? '0' : formatStockQuantity(item!.reorderLevelMilli, item!.unit)
                    }
                  />
                </label>
                <label className={styles.check}>
                  <input
                    name="active"
                    type="checkbox"
                    defaultChecked={adding ? true : item!.active}
                  />
                  Active stock item
                </label>
                <label>
                  Reason for item change
                  <input
                    name="reason"
                    required
                    maxLength={240}
                    placeholder="For example, add ingredient for stock counts"
                  />
                </label>
                <button className={`${styles.primary} ${styles.submit}`}>
                  {busy ? 'Saving…' : 'Save stock item'}
                </button>
              </fieldset>
            </form>
          )}
          {item && !editing && (
            <>
              {!item.active && (
                <p className={styles.warning}>
                  This item is paused. Activate it in item details before recording a movement.
                </p>
              )}
              {item.onHandMilli === null && (
                <p className={styles.warning}>
                  No physical count has been recorded. Count what is on hand first; enter 0 only if
                  you have checked that none remains.
                </p>
              )}
              <div className={styles.switcher} aria-label="Stock movement type">
                {(Object.keys(names) as MovementType[]).map((type) => (
                  <button
                    key={type}
                    aria-pressed={movementType === type}
                    disabled={
                      blocked ||
                      !historyFresh ||
                      !item.active ||
                      (item.onHandMilli === null && type !== 'stock.count')
                    }
                    onClick={() => {
                      setMovementType(type)
                      setError('')
                    }}
                  >
                    {names[type]}
                  </button>
                ))}
              </div>
              <form key={`${item.id}:${item.revision}:${movementType}`} onSubmit={saveMovement}>
                <fieldset disabled={blocked || !historyFresh || !item.active}>
                  <label>
                    {movementType === 'stock.count'
                      ? 'Quantity physically counted'
                      : movementType === 'stock.adjust'
                        ? 'Quantity to add or subtract'
                        : movementType === 'stock.waste'
                          ? 'Quantity wasted'
                          : 'Quantity received'}{' '}
                    ({unitName(item.unit)})
                    <input
                      name="quantity"
                      required
                      inputMode={movementType === 'stock.adjust' ? 'text' : 'decimal'}
                      placeholder={
                        movementType === 'stock.adjust'
                          ? 'For example, 2 or -0.5'
                          : 'Enter quantity'
                      }
                    />
                  </label>
                  <p className={styles.help}>
                    {movementType === 'stock.count'
                      ? 'This replaces the recorded balance with what you counted. The history keeps the previous balance and the difference.'
                      : movementType === 'stock.adjust'
                        ? 'Use a positive quantity to add stock or a minus sign to subtract it. Explain the correction below.'
                        : movementType === 'stock.waste'
                          ? 'Enter a positive amount to remove from recorded stock.'
                          : 'Enter the amount received, not the total now on hand.'}{' '}
                    {item.unit === 'piece' ? 'Use whole pieces.' : 'Up to three decimal places.'}
                  </p>
                  <label>
                    Reason for movement
                    <input
                      name="reason"
                      required
                      maxLength={240}
                      placeholder={
                        movementType === 'stock.count'
                          ? 'For example, opening physical count'
                          : 'Explain this stock movement'
                      }
                    />
                  </label>
                  <label>
                    Reference (optional)
                    <input
                      name="reference"
                      maxLength={120}
                      placeholder="Delivery note or internal reference"
                    />
                  </label>
                  <button className={`${styles.primary} ${styles.submit}`}>
                    {busy ? 'Saving…' : `Record ${names[movementType].toLowerCase()}`}
                  </button>
                </fieldset>
              </form>
            </>
          )}
          {history && (
            <section className={styles.history} aria-label="Stock movement history">
              <div className={styles.historyHeading}>
                <h4>Movement history</h4>
                <span>{history.item.movementCount} recorded</span>
              </div>
              {history.entries.length === 0 && (
                <p className={styles.help}>No stock movements recorded.</p>
              )}
              <ol>
                {history.entries.map((entry) => (
                  <li key={entry.id}>
                    <div className={styles.historyHeading}>
                      <strong>{pastNames[entry.type]}</strong>
                      <time dateTime={entry.recordedAt}>{time(entry.recordedAt)} Dubai</time>
                    </div>
                    <p>
                      {quantity(entry.beforeMilli, history.item.unit)} →{' '}
                      <strong>{quantity(entry.afterMilli, history.item.unit)}</strong>
                    </p>
                    <p>{entry.reason}</p>
                    {entry.reference && <p>Reference: {entry.reference}</p>}
                    <p className={styles.help}>
                      {entry.actorName} · {entry.deviceName}
                    </p>
                  </li>
                ))}
              </ol>
              {history.nextBeforeRevision !== null && (
                <button
                  disabled={busy || historyBusy || !historyFresh}
                  onClick={() => void loadHistory(history.item.id, history.nextBeforeRevision!)}
                >
                  Load older movements
                </button>
              )}
              <button
                disabled={busy || historyBusy}
                onClick={() => void loadHistory(history.item.id)}
              >
                {historyBusy ? 'Refreshing…' : 'Refresh item history'}
              </button>
            </section>
          )}
        </aside>
      </div>
    </section>
  )
}
