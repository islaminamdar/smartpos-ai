'use client'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { offerSchema, type Offer } from '@/lib/pos/offers'
import { formatFils, parseMoney } from '@/lib/pos/money'
import { catalogueProductSchema, type CatalogueProduct } from '@/lib/pos/server/catalogue'
import { offerListSchema, offerUpdateSchema, offerResultSchema } from '@/lib/pos/server/offers'
import styles from './offers.module.css'
type Command = z.infer<typeof offerUpdateSchema>
type OfferRow = { offer: Offer; redemptionsUsed: number }
const productList = z.object({
  status: z.literal('ready'),
  products: z.array(catalogueProductSchema),
})
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
class RequestError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super('request_failed')
  }
}
async function call(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const code =
      body && typeof body === 'object' && 'code' in body && typeof body.code === 'string'
        ? body.code
        : ''
    throw new RequestError(response.status, code)
  }
  return response.json() as Promise<unknown>
}
export default function OfferManager(props: {
  branchId: string
  deviceId: string
  disabled: boolean
  onChanged?: () => Promise<void>
}) {
  return <Manager key={`${props.branchId}:${props.deviceId}`} {...props} />
}
function Manager({
  branchId,
  deviceId,
  disabled,
  onChanged,
}: {
  branchId: string
  deviceId: string
  disabled: boolean
  onChanged?: () => Promise<void>
}) {
  const [rows, setRows] = useState<OfferRow[]>([]),
    [products, setProducts] = useState<CatalogueProduct[]>([])
  const [editing, setEditing] = useState<Offer | null>(null),
    [adding, setAdding] = useState(false)
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [loaded, setLoaded] = useState(false)
  const [pending, setPending] = useState<Command | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const mounted = useRef(false),
    lock = useRef(false)
  const key = `pos-offer-request:${branchId}:${deviceId}`
  async function load() {
    const [offers, menu] = await Promise.all([
      call(`/api/pos/offers?branchId=${encodeURIComponent(branchId)}`),
      call(`/api/pos/catalogue?branchId=${encodeURIComponent(branchId)}`),
    ])
    const validated = offerListSchema.parse(offers),
      catalogue = productList.parse(menu)
    if (
      validated.offers.some((row) => row.offer.branchId !== branchId) ||
      catalogue.products.some((product) => product.branchId !== branchId)
    )
      throw new Error('scope_mismatch')
    if (mounted.current) {
      setRows(validated.offers)
      setProducts(catalogue.products)
      setLoaded(true)
    }
  }
  useEffect(() => {
    mounted.current = true
    try {
      const raw = sessionStorage.getItem(key)
      if (raw) {
        const saved = offerUpdateSchema.parse(JSON.parse(raw))
        if (saved.branchId !== branchId || saved.deviceId !== deviceId) throw new Error('scope')
        setPending(saved)
      }
      setReady(true)
    } catch {
      setError(
        'The saved offer request could not be read. Editing is paused. Ask your administrator for help before clearing browser data.'
      )
    }
    void load()
      .catch(() => {
        if (mounted.current) setError('Offers could not be loaded. Refresh this page to try again.')
      })
      .finally(() => {
        if (mounted.current) setLoading(false)
      })
    return () => {
      mounted.current = false
    }
    // This keyed component owns one immutable branch/device scope for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!pending) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pending])
  async function execute(command: Command) {
    if (lock.current || disabled) return
    lock.current = true
    setBusy(true)
    setError('')
    setNotice('')
    let written = false,
      confirmed = false
    try {
      sessionStorage.setItem(key, JSON.stringify(command))
      written = true
      setPending(command)
      const result = offerResultSchema.parse(await call('/api/pos/offers', command))
      if (
        result.requestId !== command.id ||
        result.offer.id !== command.offer.id ||
        result.offer.branchId !== branchId ||
        result.offer.revision !== command.expectedRevision + 1
      )
        throw new Error('confirmation_mismatch')
      confirmed = true
      sessionStorage.removeItem(key)
      if (!mounted.current) return
      setPending(null)
      setEditing(result.offer)
      setAdding(false)
      setNotice(`${result.offer.name} saved. Existing receipts keep their original offer details.`)
      await load()
      await onChanged?.()
    } catch (cause) {
      if (!mounted.current) return
      if (!written) {
        setReady(false)
        setError(
          'Browser storage is unavailable. No change was sent. Restore storage before editing offers.'
        )
      } else if (confirmed)
        setError(
          'The offer was saved, but the screen could not refresh. Reload to see the latest offers.'
        )
      else if (
        cause instanceof RequestError &&
        ((cause.status === 409 && cause.code === 'offer_conflict') ||
          (cause.status === 422 && ['invalid_offer_update', 'offer_limit'].includes(cause.code)))
      ) {
        // These exact transactional rejections cannot later commit this request.
        // Unknown conflicts, authentication failures and transport errors remain pending.
        try {
          sessionStorage.removeItem(key)
          setPending(null)
          setEditing(null)
          setAdding(false)
          setLoaded(false)
          await load()
          if (mounted.current)
            setError(
              cause.code === 'offer_conflict'
                ? 'Another manager changed this offer. Select its latest version and review your changes again.'
                : cause.code === 'offer_limit'
                  ? 'This branch has reached its limit of 200 offers. Edit an existing offer instead.'
                  : 'The offer was not saved. Review the offer details and try again.'
            )
        } catch {
          setReady(false)
          setError(
            'The rejected change could not be cleared or the latest offers could not be loaded. Editing is paused. Restore browser storage and reload this page.'
          )
        }
      } else if (cause instanceof RequestError && cause.status === 401)
        setError(
          'Sign in again on this counter, then retry the saved change. Its request number is preserved.'
        )
      else if (cause instanceof RequestError && cause.status === 403)
        setError('An authorised manager on the original counter must retry this saved change.')
      else
        setError(
          'The change could not be confirmed. Keep this tab and retry the saved change. Editing stays paused so an uncertain request cannot be replaced.'
        )
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const paused = disabled || busy || !!pending || !ready || loading || !loaded
  return (
    <section className={styles.manager} aria-label="Manage offers">
      <div className={styles.heading}>
        <div>
          <h2>Branch offers</h2>
          <p>Create savings for your menu. Only one offer can be used per order.</p>
        </div>
        <button
          type="button"
          disabled={paused}
          onClick={() => {
            setEditing(null)
            setAdding(true)
            setError('')
            setNotice('')
          }}
        >
          Create offer
        </button>
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
        <div className={styles.pending}>
          <strong>Saved change awaiting confirmation</strong>
          <p>
            {pending.offer.name}. Keep this tab available; retry sends the same change with the same
            request number.
          </p>
          <button
            type="button"
            disabled={busy || disabled || !ready}
            onClick={() => void execute(pending)}
          >
            {busy ? 'Checking saved change…' : 'Retry saved change'}
          </button>
        </div>
      )}
      {loading ? (
        <p role="status">Loading branch offers and menu…</p>
      ) : !loaded ? null : (
        <div className={styles.grid}>
          <aside className={styles.list} aria-label="Saved offers">
            <label>
              Find an offer
              <input value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            {!rows.length && (
              <p>No offers yet. Create an offer to choose its saving and availability.</p>
            )}
            {rows
              .filter((row) => row.offer.name.toLowerCase().includes(search.toLowerCase().trim()))
              .map((row) => (
                <button
                  type="button"
                  key={row.offer.id}
                  aria-pressed={editing?.id === row.offer.id}
                  disabled={paused}
                  onClick={() => {
                    setEditing(row.offer)
                    setAdding(false)
                    setError('')
                    setNotice('')
                  }}
                >
                  <strong>{row.offer.name}</strong>
                  <small>
                    {row.offer.active ? 'Enabled' : 'Paused'} · {row.redemptionsUsed} uses
                    {row.offer.totalRedemptionsLimit !== null
                      ? ` of ${row.offer.totalRedemptionsLimit}`
                      : ''}
                  </small>
                </button>
              ))}
          </aside>
          {editing || adding ? (
            <OfferEditor
              key={editing ? `${editing.id}:${editing.revision}` : 'new'}
              offer={editing}
              products={products}
              disabled={paused}
              onSave={(offer, reason) =>
                void execute(
                  offerUpdateSchema.parse({
                    id: crypto.randomUUID(),
                    branchId,
                    deviceId,
                    expectedRevision: editing?.revision ?? 0,
                    reason,
                    offer,
                  })
                )
              }
            />
          ) : (
            <p>
              Select an offer to review its rules, or create a new one. Enabled offers still need a
              matching basket, time and staff permission.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
const localDate = (instant: string | null) =>
  instant ? new Date(Date.parse(instant) + 4 * 3600000).toISOString().slice(0, 16) : ''
const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
function minutes(text: string, end = false) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text) && !(end && text === '24:00'))
    throw new Error('Enter times as HH:MM, using 24:00 only for an end time.')
  const [h, m] = text.split(':').map(Number)
  return h * 60 + m
}
function OfferEditor({
  offer,
  products,
  disabled,
  onSave,
}: {
  offer: Offer | null
  products: CatalogueProduct[]
  disabled: boolean
  onSave: (offer: Omit<Offer, 'branchId' | 'revision'>, reason: string) => void
}) {
  const [kind, setKind] = useState<Offer['benefit']['kind']>(offer?.benefit.kind ?? 'percentage')
  const initialEligibility =
    offer && offer.benefit.kind !== 'bundle' ? offer.benefit.eligibility : { scope: 'all' as const }
  const [scope, setScope] = useState(initialEligibility.scope),
    [ids, setIds] = useState<string[]>(
      initialEligibility.scope === 'products' ? initialEligibility.productIds : []
    ),
    [categories, setCategories] = useState<string[]>(
      initialEligibility.scope === 'categories' ? initialEligibility.categories : []
    )
  const [windows, setWindows] = useState(
    offer?.schedule.windows.map((window) => ({
      ...window,
      start: hhmm(window.startMinute),
      end: hhmm(window.endMinute),
    })) ?? []
  )
  const [components, setComponents] = useState(
    offer?.benefit.kind === 'bundle'
      ? offer.benefit.components
      : [
          { productId: '', units: 1 },
          { productId: '', units: 1 },
        ]
  )
  const [error, setError] = useState(''),
    [productSearch, setProductSearch] = useState('')
  const toggle = (values: string[], value: string) =>
    values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
  const rule = offer?.benefit
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled) return
    setError('')
    try {
      const form = new FormData(event.currentTarget),
        text = (name: string) => String(form.get(name) ?? ''),
        optionalMoney = (name: string) => (text(name).trim() ? parseMoney(text(name)) : null)
      const eligibility =
        scope === 'all'
          ? { scope }
          : { scope, ...(scope === 'products' ? { productIds: ids } : { categories }) }
      const benefit =
        kind === 'percentage'
          ? {
              kind,
              basisPoints: parseMoney(text('percentage')),
              maximumDiscountFils: optionalMoney('maximum'),
              eligibility,
            }
          : kind === 'fixed'
            ? { kind, amountFils: parseMoney(text('amount')), eligibility }
            : kind === 'buy_x_get_y'
              ? {
                  kind,
                  buyUnits: Number(text('buyUnits')),
                  freeUnits: Number(text('freeUnits')),
                  eligibility,
                }
              : { kind, priceFils: parseMoney(text('bundlePrice')), components }
      const starts = text('starts'),
        ends = text('ends')
      const parsed = offerSchema.parse({
        id: offer?.id ?? crypto.randomUUID(),
        branchId: offer?.branchId ?? '00000000-0000-4000-8000-000000000001',
        revision: 1,
        name: text('name'),
        active: form.get('active') === 'on',
        benefit,
        schedule: {
          timezone: 'Asia/Dubai',
          startsAt: starts ? new Date(starts + ':00+04:00').toISOString() : null,
          endsAt: ends ? new Date(ends + ':00+04:00').toISOString() : null,
          windows: windows.map((window) => ({
            weekdays: window.weekdays,
            startMinute: minutes(window.start),
            endMinute: minutes(window.end, true),
          })),
        },
        minimumSpendFils: parseMoney(text('minimum') || '0'),
        serviceTypes: form.getAll('serviceTypes'),
        managerOnly: form.get('managerOnly') === 'on',
        coupon: text('coupon').trim().toUpperCase() || null,
        totalRedemptionsLimit: text('limit').trim() ? Number(text('limit')) : null,
        perCustomerLimit: null,
      })
      const reason = text('reason').trim()
      if (!reason || reason.length > 240) throw new Error('Enter a reason for this change.')
      if (
        parsed.benefit.kind === 'bundle' &&
        parsed.benefit.components.some(
          (component) =>
            products.find((product) => product.id === component.productId)?.unit === 'kg'
        )
      )
        throw new Error('Bundles use piece or pack items only.')
      const { branchId: _branch, revision: _revision, ...draft } = parsed
      void _branch
      void _revision
      onSave(draft, reason)
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name === 'Error'
          ? cause.message
          : 'Check the offer values, selected items, service types and schedule. Every window needs a day and distinct start/end times.'
      )
    }
  }
  const wholeProducts = products.filter((product) => product.unit !== 'kg')
  return (
    <form className={styles.form} onSubmit={submit} aria-label="Offer details">
      <fieldset disabled={disabled}>
        <legend>{offer ? 'Edit offer' : 'New offer'}</legend>
        <div className={styles.fields}>
          <label className={styles.wide}>
            Offer name
            <input name="name" required maxLength={120} defaultValue={offer?.name ?? ''} />
          </label>
          <label>
            Saving type
            <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
              <option value="percentage">Percentage off</option>
              <option value="fixed">Fixed AED saving</option>
              <option value="buy_x_get_y">Buy X, get Y free</option>
              <option value="bundle">Fixed-price bundle</option>
            </select>
          </label>
          <label className={styles.check}>
            <input name="active" type="checkbox" defaultChecked={offer?.active ?? false} />
            Enable offer
          </label>
          {kind === 'percentage' && (
            <>
              <label>
                Percentage off (%)
                <input
                  name="percentage"
                  type="number"
                  min="0.01"
                  max="100"
                  step="0.01"
                  required
                  defaultValue={rule?.kind === 'percentage' ? rule.basisPoints / 100 : 10}
                />
              </label>
              <label>
                Maximum saving (AED, optional)
                <input
                  name="maximum"
                  inputMode="decimal"
                  defaultValue={
                    rule?.kind === 'percentage' && rule.maximumDiscountFils !== null
                      ? (rule.maximumDiscountFils / 100).toFixed(2)
                      : ''
                  }
                />
              </label>
            </>
          )}
          {kind === 'fixed' && (
            <label>
              Saving (AED)
              <input
                name="amount"
                inputMode="decimal"
                required
                defaultValue={rule?.kind === 'fixed' ? (rule.amountFils / 100).toFixed(2) : ''}
              />
            </label>
          )}
          {kind === 'buy_x_get_y' && (
            <>
              <label>
                Buy units
                <input
                  name="buyUnits"
                  type="number"
                  min="1"
                  max="1000"
                  required
                  defaultValue={rule?.kind === 'buy_x_get_y' ? rule.buyUnits : 2}
                />
              </label>
              <label>
                Free units
                <input
                  name="freeUnits"
                  type="number"
                  min="1"
                  max="1000"
                  required
                  defaultValue={rule?.kind === 'buy_x_get_y' ? rule.freeUnits : 1}
                />
              </label>
              <p className={styles.wide}>
                Include the free items in the basket. The cheapest eligible whole units become free.
                Kilogram items cannot use this offer.
              </p>
            </>
          )}
          {kind === 'bundle' && (
            <label>
              Price per complete bundle (AED)
              <input
                name="bundlePrice"
                inputMode="decimal"
                required
                defaultValue={rule?.kind === 'bundle' ? (rule.priceFils / 100).toFixed(2) : ''}
              />
            </label>
          )}
          {kind !== 'bundle' && (
            <label>
              Eligible items
              <select
                value={scope}
                onChange={(event) => setScope(event.target.value as typeof scope)}
              >
                <option value="all">All items</option>
                <option value="products">Selected products</option>
                <option value="categories">Selected categories</option>
              </select>
            </label>
          )}
        </div>
        {kind !== 'bundle' && scope === 'products' && (
          <>
            <label>
              Find eligible products
              <input
                value={productSearch}
                onChange={(event) => setProductSearch(event.target.value)}
              />
            </label>
            <div className={styles.productList}>
              {products
                .filter((product) =>
                  product.name.toLowerCase().includes(productSearch.toLowerCase())
                )
                .map((product) => (
                  <label className={styles.check} key={product.id}>
                    <input
                      type="checkbox"
                      checked={ids.includes(product.id)}
                      onChange={() => setIds(toggle(ids, product.id))}
                    />
                    {product.name} · {product.unit}
                    {!product.active ? ' (unavailable)' : ''}
                  </label>
                ))}
            </div>
            <p className={styles.help}>
              {ids.length} selected. Unavailable items cannot be sold until enabled in the menu.
            </p>
          </>
        )}
        {kind !== 'bundle' && scope === 'categories' && (
          <div className={styles.productList}>
            {Array.from(new Set([...products.map((product) => product.category), ...categories]))
              .sort()
              .map((category) => (
                <label className={styles.check} key={category}>
                  <input
                    type="checkbox"
                    checked={categories.includes(category)}
                    onChange={() => setCategories(toggle(categories, category))}
                  />
                  {category}
                </label>
              ))}
          </div>
        )}
        {kind === 'bundle' && (
          <>
            <p>
              Choose at least two different products. Complete sets receive this price; extras keep
              their normal price.
            </p>
            {components.map((component, index) => (
              <div className={styles.component} key={index}>
                <label>
                  Bundle item {index + 1}
                  <select
                    required
                    value={component.productId}
                    onChange={(event) =>
                      setComponents(
                        components.map((row, i) =>
                          i === index ? { ...row, productId: event.target.value } : row
                        )
                      )
                    }
                  >
                    <option value="">Choose a piece or pack</option>
                    {wholeProducts.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                        {!product.active ? ' (unavailable)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Units
                  <input
                    type="number"
                    min="1"
                    max="1000"
                    required
                    value={component.units}
                    onChange={(event) =>
                      setComponents(
                        components.map((row, i) =>
                          i === index ? { ...row, units: Number(event.target.value) } : row
                        )
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  disabled={components.length <= 2}
                  onClick={() => setComponents(components.filter((_, i) => i !== index))}
                >
                  Remove item {index + 1}
                </button>
              </div>
            ))}
            <button
              type="button"
              disabled={components.length >= 20}
              onClick={() => setComponents([...components, { productId: '', units: 1 }])}
            >
              Add bundle item
            </button>
          </>
        )}
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Availability and limits</legend>
        <div className={styles.fields}>
          <label>
            Minimum basket spend (AED)
            <input
              name="minimum"
              inputMode="decimal"
              defaultValue={((offer?.minimumSpendFils ?? 0) / 100).toFixed(2)}
            />
          </label>
          <label>
            Coupon code (optional)
            <input
              name="coupon"
              maxLength={32}
              defaultValue={offer?.coupon ?? ''}
              autoCapitalize="characters"
              autoComplete="off"
            />
          </label>
          <label>
            Total uses allowed (optional)
            <input
              name="limit"
              type="number"
              min="1"
              max="1000000000"
              defaultValue={offer?.totalRedemptionsLimit ?? ''}
            />
          </label>
          <label className={styles.check}>
            <input
              name="managerOnly"
              type="checkbox"
              defaultChecked={offer?.managerOnly ?? false}
            />
            Managers and owners only
          </label>
        </div>
        <p className={styles.help}>
          Minimum spend uses the basket before discount. Usage is shared across counters and is not
          restored after refunds. Per-customer limits are not available yet.
        </p>
        <div className={styles.checks}>
          {(['dine_in', 'takeaway', 'delivery'] as const).map((type) => (
            <label key={type} className={styles.check}>
              <input
                type="checkbox"
                name="serviceTypes"
                value={type}
                defaultChecked={offer?.serviceTypes.includes(type) ?? true}
              />
              {type === 'dine_in' ? 'Dine in' : type === 'takeaway' ? 'Takeaway' : 'Delivery'}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Schedule · Dubai time (UTC+4)</legend>
        <div className={styles.fields}>
          <label>
            Starts at (optional)
            <input
              type="datetime-local"
              name="starts"
              defaultValue={localDate(offer?.schedule.startsAt ?? null)}
            />
          </label>
          <label>
            Ends at (optional)
            <input
              type="datetime-local"
              name="ends"
              defaultValue={localDate(offer?.schedule.endsAt ?? null)}
            />
          </label>
        </div>
        <p className={styles.help}>
          Starts are inclusive; the offer stops at the end time. Without weekly windows, all hours
          within these dates are allowed.
        </p>
        {windows.map((window, index) => (
          <div className={styles.window} key={index}>
            <strong>Weekly window {index + 1}</strong>
            <div className={styles.checks}>
              {weekdays.map((day, i) => (
                <label key={day} className={styles.check}>
                  <input
                    type="checkbox"
                    checked={window.weekdays.includes(i + 1)}
                    onChange={() =>
                      setWindows(
                        windows.map((row, j) =>
                          j === index
                            ? {
                                ...row,
                                weekdays: row.weekdays.includes(i + 1)
                                  ? row.weekdays.filter((value) => value !== i + 1)
                                  : [...row.weekdays, i + 1],
                              }
                            : row
                        )
                      )
                    }
                  />
                  {day}
                </label>
              ))}
            </div>
            <div className={styles.fields}>
              <label>
                Window {index + 1} starts (HH:MM)
                <input
                  required
                  value={window.start}
                  placeholder="16:00"
                  onChange={(event) =>
                    setWindows(
                      windows.map((row, j) =>
                        j === index ? { ...row, start: event.target.value } : row
                      )
                    )
                  }
                />
              </label>
              <label>
                Window {index + 1} ends (HH:MM)
                <input
                  required
                  value={window.end}
                  placeholder="19:00"
                  onChange={(event) =>
                    setWindows(
                      windows.map((row, j) =>
                        j === index ? { ...row, end: event.target.value } : row
                      )
                    )
                  }
                />
              </label>
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => setWindows(windows.filter((_, j) => j !== index))}
              >
                Remove window {index + 1}
              </button>
            </div>
          </div>
        ))}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            disabled={windows.length >= 14}
            onClick={() =>
              setWindows([
                ...windows,
                {
                  weekdays: [1, 2, 3, 4, 5, 6, 7],
                  startMinute: 960,
                  endMinute: 1140,
                  start: '16:00',
                  end: '19:00',
                },
              ])
            }
          >
            Add weekly happy hour
          </button>
        </div>
        <p className={styles.help}>
          For overnight hours, set the end earlier than the start. The window belongs to its
          starting day. Use 00:00–24:00 for a full day.
        </p>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Save change</legend>
        <label>
          Reason for this change
          <textarea name="reason" required maxLength={240} rows={2} />
        </label>
        <p className={styles.help}>
          Savings are checked again at checkout. A completely free basket needs a separate
          complimentary process.
        </p>
        {offer && (
          <p className={styles.help}>
            Current version {offer.revision} · previous minimum {formatFils(offer.minimumSpendFils)}
          </p>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <button type="submit">Save offer</button>
      </fieldset>
    </form>
  )
}
