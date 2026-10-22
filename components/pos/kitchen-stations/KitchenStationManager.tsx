'use client'

import { browserUuid } from '@/lib/pos/browser-uuid'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { catalogueProductSchema, type CatalogueProduct } from '@/lib/pos/server/catalogue'
import {
  stationCommandSchema,
  stationListSchema,
  stationListMatchesQuery,
  stationRecoverySchema,
  stationResultMatches,
  type StationCommand,
} from '@/lib/pos/server/kitchen-stations'
import {
  acknowledgeStationRequest,
  readPendingStationRequests,
  savePendingStationRequest,
  stationJournalEvent,
  type PendingStationRequest,
} from '@/lib/pos/kitchen-station-journal'
import styles from './kitchen-stations.module.css'

type Snapshot = z.infer<typeof stationListSchema>
type Props = {
  actorId: string
  branchId: string
  deviceId: string
  role: 'owner' | 'manager' | 'cashier'
  disabled: boolean
  recoveryOnly?: boolean
  onBlockedChange?: (blocked: boolean) => void
  onChanged?: () => void
}
const catalogueSchema = z
  .object({ status: z.literal('ready'), products: z.array(catalogueProductSchema).max(101000) })
  .strict()
async function call(url: string, actorId: string, command?: StationCommand) {
  const response = await fetch(url, {
    method: command ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'x-pos-actor': actorId, ...(command ? { 'Content-Type': 'application/json' } : {}) },
    body: command ? JSON.stringify(command) : undefined,
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) throw new Error('request_unconfirmed')
  return response.json() as Promise<unknown>
}
export function KitchenStationPendingRecovery(
  props: Omit<Props, 'role' | 'deviceId'> & { role?: Props['role']; deviceId?: string }
) {
  return (
    <KitchenStationManager
      {...props}
      role={props.role ?? 'cashier'}
      deviceId={props.deviceId ?? ''}
      recoveryOnly
    />
  )
}
export default function KitchenStationManager(props: Props) {
  return (
    <Manager
      key={`${props.actorId}:${props.branchId}:${props.deviceId}:${!!props.recoveryOnly}`}
      {...props}
    />
  )
}
function Manager({
  actorId,
  branchId,
  deviceId,
  role,
  disabled,
  onBlockedChange,
  onChanged,
  recoveryOnly = false,
}: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [products, setProducts] = useState<CatalogueProduct[]>([])
  const [pending, setPending] = useState<PendingStationRequest[]>([])
  const [storageReady, setStorageReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [productId, setProductId] = useState('')
  const [stationId, setStationId] = useState('')
  const [search, setSearch] = useState('')
  const alive = useRef(false),
    locked = useRef(false),
    sequence = useRef(0),
    journalSequence = useRef(0)
  const access = useRef({ disabled, role })
  access.current = { disabled, role }
  const callbacks = useRef({ onBlockedChange, onChanged })
  callbacks.current = { onBlockedChange, onChanged }
  const manager =
    (role === 'owner' || role === 'manager') &&
    (!snapshot || snapshot.actorRole === 'owner' || snapshot.actorRole === 'manager')
  const original = snapshot?.stations.find((station) => station.id === editing)
  const originalRoute =
    snapshot?.routes.find((route) => route.productId === productId)?.stationId ?? ''
  const dirty = name !== (original?.name ?? '') || (!!productId && stationId !== originalRoute)
  const blocked = dirty || busy || pending.length > 0 || !storageReady
  function invalidateReads() {
    // This is an operation generation, not a DOM ref: cleanup must invalidate
    // whichever operation is current when the immutable scope is unmounted.
    sequence.current++
  }
  useEffect(() => {
    callbacks.current.onBlockedChange?.(blocked)
    if (!blocked) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [blocked])
  async function readJournal() {
    const readVersion = ++journalSequence.current
    try {
      const records = await readPendingStationRequests(actorId)
      if (alive.current && readVersion === journalSequence.current) {
        setPending(
          recoveryOnly ? records.filter((row) => row.command.branchId === branchId) : records
        )
        setStorageReady(true)
      }
      return records
    } catch (error) {
      if (alive.current && readVersion === journalSequence.current) setStorageReady(false)
      throw error
    }
  }
  async function load() {
    if (
      recoveryOnly ||
      locked.current ||
      access.current.disabled ||
      !['owner', 'manager'].includes(access.current.role)
    )
      return
    const version = ++sequence.current
    setBusy(true)
    setError('')
    setSnapshot(null)
    try {
      await readJournal()
      if (!alive.current || version !== sequence.current || access.current.disabled) return
      let first: Snapshot | null = null,
        cursor: string | undefined
      const routes: Snapshot['routes'] = []
      do {
        const query = { branchId, deviceId, ...(cursor ? { afterProductId: cursor } : {}) }
        const page = stationListSchema.parse(
          await call(`/api/pos/kitchen-stations?${new URLSearchParams(query)}`, actorId)
        )
        if (!stationListMatchesQuery(query, page)) throw new Error('scope')
        if (
          first &&
          (page.actorRole !== first.actorRole ||
            page.revision !== first.revision ||
            page.organizationId !== first.organizationId ||
            page.routeCount !== first.routeCount ||
            JSON.stringify(page.stations) !== JSON.stringify(first.stations))
        )
          throw new Error('changed_snapshot')
        first ??= page
        routes.push(...page.routes)
        if (routes.length > 101000 || routes.length > first.routeCount)
          throw new Error('route_limit')
        cursor = page.nextProductId ?? undefined
        if (!alive.current || version !== sequence.current || access.current.disabled) return
      } while (cursor)
      if (!first || routes.length !== first.routeCount) throw new Error('incomplete_snapshot')
      if (first.actorRole === 'cashier') {
        if (alive.current && version === sequence.current) {
          setSnapshot({ ...first, routes, nextProductId: null })
          setProducts([])
        }
        return
      }
      const menu = catalogueSchema.parse(
        await call(`/api/pos/catalogue?branchId=${branchId}`, actorId)
      )
      const menuIds = new Set(menu.products.map((product) => product.id))
      if (
        menu.products.some((product) => product.branchId !== branchId) ||
        menuIds.size !== menu.products.length ||
        routes.some((route) => !menuIds.has(route.productId))
      )
        throw new Error('menu_scope')
      if (alive.current && version === sequence.current && !access.current.disabled) {
        setSnapshot({ ...first, routes, nextProductId: null })
        setProducts(menu.products)
      }
    } catch {
      if (alive.current && version === sequence.current)
        setError(
          'Stations could not be verified. Refresh to load one complete, current version. Saved requests are kept.'
        )
    } finally {
      if (alive.current && version === sequence.current) setBusy(false)
    }
  }
  useEffect(() => {
    alive.current = true
    void readJournal().catch(() => {
      if (alive.current) {
        setStorageReady(false)
        setError(
          'Saved station changes could not be read. Keep browser data intact and restore storage before editing.'
        )
      }
    })
    const refreshJournal = () => {
      void readJournal().catch(() => {
        if (alive.current) setStorageReady(false)
      })
    }
    window.addEventListener(stationJournalEvent, refreshJournal)
    window.addEventListener('focus', refreshJournal)
    let channel: BroadcastChannel | undefined
    try {
      channel = new BroadcastChannel(stationJournalEvent)
      channel.onmessage = refreshJournal
    } catch {
      /* Focus and local notifications remain available. */
    }
    return () => {
      alive.current = false
      invalidateReads()
      window.removeEventListener(stationJournalEvent, refreshJournal)
      window.removeEventListener('focus', refreshJournal)
      channel?.close()
      callbacks.current.onBlockedChange?.(false)
    }
    // Scope is immutable for this keyed component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (disabled || !manager || recoveryOnly) {
      sequence.current++
      if (!locked.current) setBusy(false)
      setSnapshot(null)
      setProducts([])
      setName('')
      setEditing(null)
      setProductId('')
      setStationId('')
      return
    }
    void load()
    // Access transitions invalidate reads; scope changes remount this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, role, recoveryOnly])
  async function execute(input: StationCommand | null, saved?: PendingStationRequest) {
    if (
      locked.current ||
      access.current.disabled ||
      (saved && saved.command.branchId !== branchId) ||
      (!saved && (!manager || !snapshot || !storageReady || pending.length > 0))
    )
      return
    locked.current = true
    setBusy(true)
    setError('')
    setNotice('')
    const operation = ++sequence.current
    let durable = !!saved,
      confirmed = false
    try {
      const command = stationCommandSchema.parse(saved?.command ?? input)
      if (!saved) {
        await savePendingStationRequest({ actorId, command })
        durable = true
        await readJournal()
      }
      if (!alive.current || access.current.disabled || sequence.current !== operation) return
      const result = stationRecoverySchema.parse(
        await call(
          saved ? '/api/pos/kitchen-stations/recovery' : '/api/pos/kitchen-stations',
          actorId,
          command
        )
      )
      if (!stationResultMatches(command, result) || (!saved && result.status !== 'applied'))
        throw new Error('ack_mismatch')
      // A late response must not clear an old account's saved request after the view changed.
      if (!alive.current || access.current.disabled || sequence.current !== operation) return
      await acknowledgeStationRequest(actorId, command, result)
      if (!alive.current || access.current.disabled || sequence.current !== operation) return
      await readJournal()
      if (!alive.current || access.current.disabled || sequence.current !== operation) return
      confirmed = true
      setName('')
      setEditing(null)
      setProductId('')
      setStationId('')
      setNotice(
        result.status === 'cancelled'
          ? 'The saved change was cancelled. Review the latest configuration before trying again.'
          : 'Station configuration saved. Work already in preparation keeps its original station.'
      )
      callbacks.current.onChanged?.()
    } catch {
      if (alive.current && sequence.current === operation) {
        if (!durable) setStorageReady(false)
        setError(
          durable
            ? 'This change is not confirmed. Check the saved request before making another change. Checking recovers its result or cancels it if it was never applied.'
            : 'The change was not sent. Check the details and browser storage before trying again.'
        )
      }
    } finally {
      locked.current = false
      if (alive.current && sequence.current === operation) {
        setBusy(false)
        if (durable) await readJournal().catch(() => setStorageReady(false))
        if (!access.current.disabled && !saved && !durable) setSnapshot(null)
        if (confirmed) void load()
      } else if (alive.current) {
        setBusy(false)
        if (!access.current.disabled) void load()
      }
    }
  }
  const paused = disabled || busy || !!pending.length || !storageReady || !snapshot || !manager
  const saveStation = (event: FormEvent) => {
    event.preventDefault()
    if (paused || !snapshot || (productId && stationId !== originalRoute)) return
    const parsed = stationCommandSchema.safeParse({
      id: browserUuid(),
      branchId,
      deviceId,
      expectedRevision: snapshot.revision,
      type: 'station.save',
      station: { id: editing ?? browserUuid(), name, active: original?.active ?? true },
    })
    if (!parsed.success) {
      setError(
        'Use 1–60 characters without surrounding spaces or control characters. General is reserved.'
      )
      return
    }
    void execute(parsed.data)
  }
  const reset = () => {
    setName('')
    setEditing(null)
    setProductId('')
    setStationId('')
    setError('')
  }
  if ((!manager || recoveryOnly) && storageReady && pending.length === 0) return null
  return (
    <section className={styles.manager} aria-label="Kitchen station configuration">
      <header className={styles.heading}>
        <div>
          <h2>Kitchen stations</h2>
          <p>Set up where each menu item will be prepared.</p>
        </div>
        <span className={styles.candidate}>Station setup</span>
      </header>
      <p className={styles.policy}>
        Assignments apply to newly sent work; existing preparation stays with its original station.
        Items without an assignment use General.
      </p>
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
      {pending.map((record) => (
        <div key={record.command.id} className={styles.recovery}>
          <h3>Check a saved station change</h3>
          <p>
            {record.command.type === 'station.save'
              ? `Station: ${record.command.station.name}`
              : 'Product assignment change'}
            {record.command.branchId !== branchId ? ' — saved for another branch' : ''}
          </p>
          <p>
            Checking retrieves the original result, or cancels the change if it was never applied.
            It does not submit a new change.
          </p>
          {record.command.branchId !== branchId && (
            <p>
              Return to the original branch and its authorised counter to check this request. The
              saved device and branch will not be changed.
            </p>
          )}
          <button
            type="button"
            disabled={busy || disabled || !storageReady || record.command.branchId !== branchId}
            onClick={() => void execute(null, record)}
          >
            Check saved request
          </button>
        </div>
      ))}
      {!manager || recoveryOnly ? (
        <p>
          Only a manager or owner can edit station configuration. Saved requests can still be
          checked.
        </p>
      ) : (
        <>
          <div className={styles.toolbar}>
            <button type="button" disabled={disabled || busy || dirty} onClick={() => void load()}>
              Refresh configuration
            </button>
            {dirty && (
              <button
                type="button"
                className={styles.secondary}
                disabled={busy || disabled}
                onClick={reset}
              >
                Discard unsaved edits
              </button>
            )}
            <span>
              {snapshot
                ? `${snapshot.stations.filter((station) => station.active).length} active ${snapshot.stations.filter((station) => station.active).length === 1 ? 'station' : 'stations'} · ${snapshot.routeCount} assigned ${snapshot.routeCount === 1 ? 'product' : 'products'}`
                : busy
                  ? 'Loading complete configuration…'
                  : 'Configuration unavailable'}
            </span>
          </div>
          <div className={styles.columns}>
            <section>
              <h3>Stations</h3>
              <p className={styles.help}>
                Rename a station, or clear its product assignments before archiving it.
              </p>
              <ul className={styles.stationList}>
                <li>
                  <strong>General</strong>
                  <span>Unassigned products</span>
                </li>
                {snapshot?.stations.map((station) => (
                  <li key={station.id}>
                    <div>
                      <strong>{station.name}</strong>
                      <span>
                        {station.active
                          ? `${snapshot.routes.filter((route) => route.stationId === station.id).length} products`
                          : 'Archived'}
                      </span>
                    </div>
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={styles.secondary}
                        disabled={paused || dirty}
                        onClick={() => {
                          setEditing(station.id)
                          setName(station.name)
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className={styles.secondary}
                        disabled={
                          paused ||
                          dirty ||
                          (station.active &&
                            snapshot.routes.some((route) => route.stationId === station.id))
                        }
                        onClick={() =>
                          void execute({
                            id: browserUuid(),
                            branchId,
                            deviceId,
                            expectedRevision: snapshot.revision,
                            type: 'station.save',
                            station: {
                              id: station.id,
                              name: station.name,
                              active: !station.active,
                            },
                          })
                        }
                      >
                        {station.active ? 'Archive' : 'Reactivate'}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <form onSubmit={saveStation} className={styles.form}>
                <label>
                  {editing ? 'Station name' : 'New station name'}
                  <input
                    value={name}
                    disabled={paused || (!!productId && stationId !== originalRoute)}
                    onChange={(event) => setName(event.target.value)}
                    autoComplete="off"
                  />
                </label>
                <button
                  disabled={
                    paused ||
                    !name ||
                    name === original?.name ||
                    (!editing && (snapshot?.stations.length ?? 0) >= 128)
                  }
                >
                  {editing ? 'Save station name' : 'Add station'}
                </button>
              </form>
            </section>
            <section>
              <h3>Product assignments</h3>
              <label>
                Find a menu item
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  disabled={paused}
                />
              </label>
              <label>
                Menu item
                <select
                  aria-label="Menu item"
                  value={productId}
                  disabled={
                    paused ||
                    name !== (original?.name ?? '') ||
                    (!!productId && stationId !== originalRoute)
                  }
                  onChange={(event) => {
                    setProductId(event.target.value)
                    setStationId(
                      snapshot?.routes.find((route) => route.productId === event.target.value)
                        ?.stationId ?? ''
                    )
                  }}
                >
                  <option value="">Choose a menu item</option>
                  {products
                    .filter(
                      (product) =>
                        product.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()) ||
                        product.id === productId
                    )
                    .map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                        {product.active ? '' : ' (unavailable)'}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Prepare at
                <select
                  aria-label="Prepare at"
                  value={stationId}
                  disabled={paused || !productId || name !== (original?.name ?? '')}
                  onChange={(event) => setStationId(event.target.value)}
                >
                  <option value="">General</option>
                  {snapshot?.stations
                    .filter((station) => station.active)
                    .map((station) => (
                      <option key={station.id} value={station.id}>
                        {station.name}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                disabled={
                  paused ||
                  !productId ||
                  stationId === originalRoute ||
                  name !== (original?.name ?? '')
                }
                onClick={() =>
                  snapshot &&
                  void execute({
                    id: browserUuid(),
                    branchId,
                    deviceId,
                    expectedRevision: snapshot.revision,
                    type: 'route.set',
                    productId,
                    stationId: stationId || null,
                  })
                }
              >
                Save product assignment
              </button>
              <p className={styles.help}>
                General keeps unassigned items visible. Changing an assignment will not move work
                already sent to the kitchen.
              </p>
            </section>
          </div>
        </>
      )}
    </section>
  )
}
