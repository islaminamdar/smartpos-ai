'use client'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { formatFils, parseMoney } from '@/lib/pos/money'
import MenuPhotoEditor from './MenuPhotoEditor'
import {
  catalogueProductSchema,
  catalogueUpdateSchema,
  catalogueResultSchema,
  type CatalogueProduct,
  type CatalogueUpdate,
} from '@/lib/pos/server/catalogue'

const listSchema = z.object({
  status: z.literal('ready'),
  products: z.array(catalogueProductSchema),
})
class CatalogueError extends Error {
  constructor(
    public code: string,
    public status: number
  ) {
    super(code)
  }
}
async function call(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  })
  const result: unknown = await response.json()
  if (!response.ok)
    throw new CatalogueError(
      result && typeof result === 'object' && 'code' in result
        ? String(result.code)
        : 'unavailable',
      response.status
    )
  return result
}
type CatalogueManagerProps = {
  branchId: string
  deviceId: string
  disabled: boolean
  onChanged: () => Promise<void>
}

export default function CatalogueManager(props: CatalogueManagerProps) {
  // A scope change must discard local drafts and ignore the old editor's uploads.
  return <ScopedCatalogueManager key={`${props.branchId}:${props.deviceId}`} {...props} />
}

function ScopedCatalogueManager({
  branchId,
  deviceId,
  disabled,
  onChanged,
}: CatalogueManagerProps) {
  const [items, setItems] = useState<CatalogueProduct[]>([])
  const [selected, setSelected] = useState<CatalogueProduct | null>(null)
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [journalReady, setJournalReady] = useState(false)
  const journalKey = `pos-menu-request:${branchId}:${deviceId}`
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [pending, setPending] = useState<CatalogueUpdate | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [draftImage, setDraftImage] = useState<string | null>(null)
  const [editorVersion, setEditorVersion] = useState(0)
  const [photoBusy, setPhotoBusy] = useState(false)
  const photoBusyRef = useRef(false)
  const [photoFilePending, setPhotoFilePending] = useState(false)
  const photoFilePendingRef = useRef(false)
  const photoBusyChanged = useCallback((value: boolean) => {
    photoBusyRef.current = value
    setPhotoBusy(value)
  }, [])
  const photoFileChanged = useCallback((value: boolean) => {
    photoFilePendingRef.current = value
    setPhotoFilePending(value)
  }, [])
  const editor = useRef<HTMLElement>(null)
  const load = useCallback(async () => {
    const data = listSchema.parse(
      await call(`/api/pos/catalogue?branchId=${encodeURIComponent(branchId)}`)
    )
    setItems(data.products.sort((a, b) => a.name.localeCompare(b.name)))
    return data.products
  }, [branchId])
  useEffect(() => {
    setLoading(true)
    load()
      .catch(() => setError('Could not load the menu. Check your connection and refresh.'))
      .finally(() => setLoading(false))
  }, [load])
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(journalKey)
      if (saved) {
        const command = catalogueUpdateSchema.parse(JSON.parse(saved))
        if (command.branchId !== branchId || command.deviceId !== deviceId)
          throw new Error('journal_scope_mismatch')
        setPending(command)
      }
      setJournalReady(true)
    } catch {
      setError(
        'The saved menu request could not be read. Menu editing is paused; contact your administrator before clearing browser data.'
      )
    }
  }, [branchId, deviceId, journalKey])
  useEffect(() => {
    if (!pending && !photoBusy) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pending, photoBusy])
  async function execute(command: CatalogueUpdate) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    setNotice('')
    let confirmed = false
    let journalWritten = false
    try {
      // Persist the immutable request before sending. Reloads in this tab retry the same ID.
      sessionStorage.setItem(journalKey, JSON.stringify(command))
      journalWritten = true
      setPending(command)
      const result = catalogueResultSchema.parse(await call('/api/pos/catalogue', command))
      if (
        result.requestId !== command.id ||
        result.product.id !== command.product.id ||
        result.product.branchId !== branchId
      )
        throw new Error('confirmation_mismatch')
      confirmed = true
      sessionStorage.removeItem(journalKey)
      setPending(null)
      setSelected(result.product)
      setDraftImage(result.product.imageUrl)
      photoFileChanged(false)
      setAdding(false)
      setNotice(`${result.product.name} saved. Existing bills keep their original details.`)
      await load()
      await onChanged()
    } catch (err) {
      if (!journalWritten) {
        setJournalReady(false)
        setError(
          'This browser could not save the recovery record. No change was sent. Restore browser storage before editing the menu.'
        )
      } else if (confirmed) {
        setError(
          'The item was saved, but refreshing the screen failed. Reload this page to see the latest menu.'
        )
      } else if (err instanceof CatalogueError && err.code === 'catalogue_conflict') {
        sessionStorage.removeItem(journalKey)
        setPending(null)
        setSelected(null)
        setAdding(false)
        setError(
          'Another manager changed this item. Reload the latest version and review your changes before saving again.'
        )
        await load().catch(() => {})
      } else if (err instanceof CatalogueError && err.status === 422) {
        sessionStorage.removeItem(journalKey)
        setPending(null)
        setError('Check the item details. Available items need a positive price.')
      } else if (err instanceof CatalogueError && err.status === 403) {
        setError(
          'This change requires an authorised manager on the original enrolled counter. Restore access before retrying.'
        )
      } else if (err instanceof CatalogueError && err.status === 401) {
        setError(
          'Your session expired. Sign in again, then check the latest menu before changing this item.'
        )
      } else
        setError(
          'The change could not be confirmed. Retry the saved change; it uses the same request number to prevent duplicates. Keep this browser tab available until confirmed.'
        )
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (
      disabled ||
      busy ||
      pending ||
      !journalReady ||
      photoBusyRef.current ||
      photoFilePendingRef.current
    )
      return
    try {
      const values = new FormData(event.currentTarget)
      const command = catalogueUpdateSchema.parse({
        id: crypto.randomUUID(),
        branchId,
        deviceId,
        expectedRevision: selected?.revision ?? 0,
        reason: String(values.get('reason') || ''),
        product: {
          id: selected?.id ?? crypto.randomUUID(),
          name: String(values.get('name') || ''),
          category: String(values.get('category') || ''),
          imageUrl: draftImage,
          unit: String(values.get('unit') || 'piece'),
          unitPriceFils: parseMoney(String(values.get('price') || '')),
          taxRateBps: 500,
          active: values.get('active') === 'on',
        },
      })
      void execute(command)
    } catch {
      setError(
        'Enter a name, category, valid AED price and reason. An available item must cost more than zero.'
      )
    }
  }
  const visible = items.filter(
    (p) =>
      (filter === 'all' || (filter === 'available' ? p.active : !p.active)) &&
      `${p.name} ${p.category}`.toLowerCase().includes(search.toLowerCase().trim())
  )
  return (
    <section className="lc-catalogue lc-noprint">
      <div className="lc-section-heading">
        <div>
          <span className="lc-eyebrow">Manager tools</span>
          <h1>Your menu</h1>
        </div>
        <button
          className="lc-primary"
          disabled={disabled || busy || photoBusy || !!pending || !journalReady}
          onClick={() => {
            if (photoBusyRef.current) return
            setSelected(null)
            setDraftImage(null)
            photoFileChanged(false)
            setEditorVersion((value) => value + 1)
            setAdding(true)
            setNotice('')
            setError('')
            editor.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }}
        >
          Add item
        </button>
      </div>
      <p>
        Manage counter prices, availability and sale units. Prices include 5% VAT. Changes are
        recorded with your account and reason.
      </p>
      {error && (
        <p role="alert" className="lc-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="lc-success">
          {notice}
        </p>
      )}
      {pending && (
        <div className="lc-warning">
          <strong>A menu change needs confirmation</strong>
          <p>Keep this screen open and retry the saved change before making another edit.</p>
          <button
            disabled={busy || disabled || !journalReady}
            onClick={() => void execute(pending)}
          >
            {busy ? 'Saving…' : 'Retry saved change'}
          </button>
        </div>
      )}
      <div className="lc-catalogue-layout">
        <div>
          <div className="lc-filters">
            <label>
              Find an item
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name or category"
              />
            </label>
            <label>
              Show
              <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="all">All items</option>
                <option value="available">Available</option>
                <option value="unavailable">Unavailable / needs pricing</option>
              </select>
            </label>
          </div>
          <p className="lc-help">
            {items.filter((p) => p.active).length} available ·{' '}
            {items.filter((p) => !p.active).length} unavailable
          </p>
          {loading ? (
            <p role="status">Loading menu…</p>
          ) : (
            <div className="lc-catalogue-list">
              {visible.map((p) => (
                <button
                  key={p.id}
                  disabled={busy || photoBusy || !!pending}
                  aria-pressed={selected?.id === p.id}
                  onClick={() => {
                    if (photoBusyRef.current) return
                    setSelected(p)
                    setDraftImage(p.imageUrl)
                    photoFileChanged(false)
                    setEditorVersion((value) => value + 1)
                    setAdding(false)
                    setError('')
                    setNotice('')
                    editor.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }}
                >
                  <span>
                    <strong>{p.name}</strong>
                    <small>
                      {p.category} ·{' '}
                      {p.unit === 'kg'
                        ? 'per kilogram'
                        : p.unit === 'pack'
                          ? 'per pack'
                          : 'per piece'}{' '}
                      · {p.active ? 'Available' : 'Unavailable'}
                    </small>
                  </span>
                  <strong>AED {formatFils(p.unitPriceFils)}</strong>
                </button>
              ))}
              {!visible.length && <p>No items match this view.</p>}
            </div>
          )}
          <button
            disabled={busy || photoBusy || disabled || !!pending}
            onClick={() => {
              setLoading(true)
              load()
                .then(() => setError(''))
                .catch(() => setError('Menu refresh failed.'))
                .finally(() => setLoading(false))
            }}
          >
            Refresh menu
          </button>
        </div>
        <aside
          ref={editor}
          className={`lc-menu-editor${selected || adding ? '' : 'lc-menu-editor-empty'}`}
          aria-label="Edit menu item"
        >
          {selected || adding ? (
            <form
              key={`${selected ? `${selected.id}:${selected.revision}` : 'new'}:${editorVersion}`}
              onSubmit={submit}
            >
              <h2>{selected ? 'Edit item' : 'New item'}</h2>
              <MenuPhotoEditor
                key={selected ? `${selected.id}:${selected.revision}` : 'new'}
                branchId={branchId}
                deviceId={deviceId}
                itemName={selected?.name ?? 'new item'}
                savedImageUrl={selected?.imageUrl ?? null}
                imageUrl={draftImage}
                disabled={disabled || busy || !!pending || !journalReady}
                onChange={setDraftImage}
                onBusyChange={photoBusyChanged}
                onFilePending={photoFileChanged}
              />
              <fieldset disabled={disabled || busy || photoBusy || !!pending || !journalReady}>
                <label>
                  Item name
                  <input name="name" required maxLength={200} defaultValue={selected?.name ?? ''} />
                </label>
                <label>
                  Category
                  <input
                    name="category"
                    required
                    maxLength={120}
                    defaultValue={selected?.category ?? ''}
                    list="menu-categories"
                  />
                  <datalist id="menu-categories">
                    {Array.from(new Set(items.map((p) => p.category))).map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </label>
                <label>
                  Sell by
                  <select name="unit" defaultValue={selected?.unit ?? 'piece'}>
                    <option value="piece">Piece</option>
                    <option value="pack">Fixed pack</option>
                    <option value="kg">Weight — price per kilogram</option>
                  </select>
                </label>
                <p className="lc-help">
                  For weight sales, enter the full kilogram price. Cashiers enter grams. A named 250
                  g pack can remain a fixed pack.
                </p>
                <label>
                  Price including VAT (AED)
                  <input
                    name="price"
                    inputMode="decimal"
                    required
                    defaultValue={
                      selected ? formatFils(selected.unitPriceFils).replaceAll(',', '') : ''
                    }
                  />
                </label>
                <label className="lc-check">
                  <input name="active" type="checkbox" defaultChecked={selected?.active ?? false} />
                  Available for sale
                </label>
                <label>
                  Reason for this change
                  <input
                    name="reason"
                    required
                    maxLength={240}
                    placeholder="For example, approved counter price"
                  />
                </label>
                <button className="lc-primary" disabled={photoFilePending}>
                  {busy ? 'Saving…' : 'Save menu item'}
                </button>
              </fieldset>
            </form>
          ) : (
            <div className="lc-empty">
              <h2>Select an item</h2>
              <p>Edit its price and availability, or add a new item.</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  )
}
