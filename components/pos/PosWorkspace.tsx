'use client'

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import Link from 'next/link'
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChefHat,
  ChevronDown,
  CircleHelp,
  CreditCard,
  Download,
  LayoutGrid,
  ListOrdered,
  Menu,
  Minus,
  Package,
  Plus,
  Printer,
  Search,
  Settings,
  ShoppingBag,
  SlidersHorizontal,
  Star,
  Store,
  Trash2,
  Wallet,
  Wifi,
  WifiOff,
  X,
  BarChart3,
  Scale,
  RefreshCw,
  LockKeyhole,
} from 'lucide-react'
import catalogue from '@/data/pos/mithaiwala-catalogue.json'
import { calculateTotals, formatFils, lineTotalFils, parseMoney } from '@/lib/pos/money'
import {
  createLocalPosStore,
  createId,
  expectedCashFils,
  remainingRefundFils,
  inspectTrainingBackup,
  type TrainingBackupInspection,
} from '@/lib/pos/local-store'
import {
  TRAINING_TAX,
  type CartLine,
  type HeldOrder,
  type PosSnapshot,
  type Sale,
  type ServiceType,
} from '@/lib/pos/types'

type Tab = 'sell' | 'orders' | 'kitchen' | 'menu' | 'reports' | 'shift' | 'branches' | 'settings'
type Product = (typeof catalogue.items)[number]
type Override = { priceFils?: number; unit?: 'each' | 'kg'; available?: boolean }
type KitchenTicket = {
  id: string
  label: string
  createdAt: string
  lines: CartLine[]
  status: 'new' | 'preparing' | 'ready'
  serviceType: ServiceType
}
type StoreApi = Awaited<ReturnType<typeof createLocalPosStore>>
const company = 'Abdul Gafoor Suleman Usman Mithaiwala Restaurant LLC'
const branchName = 'Bur Dubai'
const previewFils = (value: string) => {
  try {
    return parseMoney(value)
  } catch {
    return 0
  }
}
const currency = (fils: number) => `AED ${formatFils(fils)}`
const time = (date: string) =>
  new Date(date).toLocaleTimeString('en-AE', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Dubai',
  })
const serviceLabel = (service: ServiceType) =>
  ({ dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' })[service]
const navigation: { id: Tab; label: string; icon: typeof Store }[] = [
  { id: 'sell', label: 'Sell', icon: LayoutGrid },
  { id: 'orders', label: 'Orders', icon: ListOrdered },
  { id: 'kitchen', label: 'Kitchen', icon: ChefHat },
  { id: 'menu', label: 'Menu', icon: Package },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
  { id: 'shift', label: 'Shift', icon: Wallet },
  { id: 'branches', label: 'Branches', icon: Store },
  { id: 'settings', label: 'Settings', icon: Settings },
]
const quickIds = ['I401383106A', 'I989657937A', 'I947098037A', 'I351571363A', 'I109168448A']
const PosErrorContext = createContext('')

function useOverlayFocus(active: boolean, ref: { current: HTMLElement | null }, close: () => void) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    const panel = ref.current
    if (!active || !panel) return
    const previous = document.activeElement as HTMLElement | null
    const controls = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'
        )
      ).filter((el) => el.getClientRects().length && !el.closest('[inert]'))
    ;(controls()[0] || panel).focus()
    const keydown = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = controls()
      const first = items[0],
        last = items[items.length - 1]
      if (!first) {
        event.preventDefault()
        panel.focus()
        return
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || !panel.contains(document.activeElement))
      ) {
        event.preventDefault()
        last.focus()
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !panel.contains(document.activeElement))
      ) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      if (previous?.isConnected) previous.focus()
    }
  }, [active, ref])
}

function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const error = useContext(PosErrorContext)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className={`pos-modal ${wide ? 'wide' : ''}`}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      aria-labelledby="dialog-title"
    >
      <header>
        <h2 id="dialog-title">{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Close dialog">
          <X size={21} />
        </button>
      </header>
      {error && (
        <p className="modal-error" role="alert">
          {error}
        </p>
      )}
      {children}
    </dialog>
  )
}
function Empty({
  icon: Icon = ShoppingBag,
  title,
  children,
}: {
  icon?: typeof Store
  title: string
  children: ReactNode
}) {
  return (
    <div className="pos-empty">
      <Icon size={36} strokeWidth={1.4} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  )
}
function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function PosWorkspace() {
  const storeRef = useRef<StoreApi | null>(null)
  const [snapshot, setSnapshot] = useState<PosSnapshot | null>(null)
  const [fatal, setFatal] = useState('')
  const [tab, setTab] = useState<Tab>('sell')
  const [online, setOnline] = useState(true)
  const [offlineReady, setOfflineReady] = useState(false)
  const [offlineError, setOfflineError] = useState('')
  const [offlineAttempt, setOfflineAttempt] = useState(0)
  const [updateWaiting, setUpdateWaiting] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [navOpen, setNavOpen] = useState(false)
  const [basketOpen, setBasketOpen] = useState(false)
  const [compact, setCompact] = useState(false)
  const [phone, setPhone] = useState(false)
  const sidebarRef = useRef<HTMLElement>(null)
  const ticketRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const update = () => {
      setCompact(window.matchMedia('(max-width: 900px)').matches)
      setPhone(window.matchMedia('(max-width: 600px)').matches)
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  const ticketOverlay = compact && basketOpen && tab === 'sell'
  const navOverlay = phone && navOpen
  const backgroundInert = ticketOverlay || navOverlay
  useOverlayFocus(ticketOverlay, ticketRef, () => setBasketOpen(false))
  useOverlayFocus(navOverlay, sidebarRef, () => setNavOpen(false))
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All items')
  const [cart, setCart] = useState<CartLine[]>([])
  const [service, setService] = useState<ServiceType>('takeaway')
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const [holdId, setHoldId] = useState<string | undefined>()
  const [discount, setDiscount] = useState('0')
  const [discountReason, setDiscountReason] = useState('')
  const [modal, setModal] = useState<
    | 'payment'
    | 'openShift'
    | 'discount'
    | 'weight'
    | 'cash'
    | 'closeShift'
    | 'help'
    | 'restore'
    | null
  >(null)
  const [restoreText, setRestoreText] = useState('')
  const [restoreInfo, setRestoreInfo] = useState<TrainingBackupInspection | null>(null)
  const [restoreAcknowledged, setRestoreAcknowledged] = useState(false)
  const [cashier, setCashier] = useState('Manager')
  const [float, setFloat] = useState('0')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'mixed'>('cash')
  const [cashPaid, setCashPaid] = useState('')
  const [cardPaid, setCardPaid] = useState('')
  const [cardConfirmed, setCardConfirmed] = useState(false)
  const [receipt, setReceipt] = useState<Sale | null>(null)
  const [refundTarget, setRefundTarget] = useState<Sale | null>(null)
  const [refundAmount, setRefundAmount] = useState('')
  const [refundReason, setRefundReason] = useState('')
  const [refundMethod, setRefundMethod] = useState<'cash' | 'card'>('cash')
  const [weightName, setWeightName] = useState('')
  const [weightRate, setWeightRate] = useState('')
  const [grams, setGrams] = useState('250')
  const [cashDirection, setCashDirection] = useState<'in' | 'out'>('out')
  const [cashAmount, setCashAmount] = useState('')
  const [cashReason, setCashReason] = useState('')
  const [counted, setCounted] = useState('')
  const [closeNote, setCloseNote] = useState('')
  const [editProduct, setEditProduct] = useState<Product | null>(null)
  const [editPrice, setEditPrice] = useState('')
  const [editUnit, setEditUnit] = useState<'each' | 'kg'>('each')
  const [editAvailable, setEditAvailable] = useState(true)
  const [serverState, setServerState] = useState('Not connected')
  const saleKey = useRef(createId())
  const operationKey = useRef(createId())

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    let opened: StoreApi | null = null
    async function init() {
      try {
        let deviceId = localStorage.getItem('internext-pos-device')
        if (!deviceId) {
          deviceId = createId()
          localStorage.setItem('internext-pos-device', deviceId)
        }
        const store = await createLocalPosStore({
          organisationId: 'mithaiwala-training',
          branchId: 'bur-dubai-training',
          deviceId,
          mode: 'training',
        })
        opened = store
        if (cancelled) {
          store.close()
          return
        }
        storeRef.current = store
        const first = await store.snapshot()
        if (cancelled) return
        setSnapshot(first)
        const draft = first.preferences.draft as
          | {
              idempotencyKey?: string
              cart?: CartLine[]
              service?: ServiceType
              label?: string
              note?: string
              holdId?: string
              discount?: string
              discountReason?: string
            }
          | undefined
        if (draft?.cart && !first.sales.some((s) => s.idempotencyKey === draft.idempotencyKey)) {
          saleKey.current = draft.idempotencyKey || createId()
          setCart(draft.cart)
          setService(draft.service || 'takeaway')
          setLabel(draft.label || '')
          setNote(draft.note || '')
          setHoldId(draft.holdId)
          setDiscount(draft.discount || '0')
          setDiscountReason(draft.discountReason || '')
        }
        unsubscribe = store.subscribe(() => {
          store
            .snapshot()
            .then((s) => {
              if (!cancelled) setSnapshot(s)
            })
            .catch((e) => {
              if (!cancelled) setError(e.message)
            })
        })
      } catch (e) {
        if (!cancelled)
          setFatal(e instanceof Error ? e.message : 'Device storage could not be opened.')
      }
    }
    void init()
    return () => {
      cancelled = true
      unsubscribe?.()
      opened?.close()
      storeRef.current = null
    }
  }, [])
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return
    let cancelled = false
    const cleanups: (() => void)[] = []
    setOfflineError('')
    const listener = (event: MessageEvent) => {
      if (event.data?.type === 'POS_OFFLINE_READY') {
        setOfflineReady(true)
        setOfflineError('')
      }
      if (event.data?.type === 'POS_OFFLINE_UPDATE_DOWNLOADED') setUpdateWaiting(true)
      if (event.data?.type === 'POS_OFFLINE_FAILED')
        setOfflineError(
          'The offline download did not finish. Stay online and use Prepare offline app to retry.'
        )
    }
    navigator.serviceWorker.addEventListener('message', listener)
    navigator.serviceWorker
      .register('/pos-sw.js', { scope: '/pos' })
      .then(async (registration) => {
        if (cancelled) return
        registration.active?.postMessage({ type: 'CHECK_POS_CACHE' })
        setUpdateWaiting(!!registration.waiting)
        const observe = () => {
          const worker = registration.installing
          if (!worker) return
          const changed = () => {
            if (cancelled) return
            if (worker.state === 'redundant')
              setOfflineError(
                'The offline download did not finish. Stay online and use Prepare offline app to retry.'
              )
            if (worker.state === 'activated') worker.postMessage({ type: 'CHECK_POS_CACHE' })
            if (worker.state === 'installed' && registration.active) setUpdateWaiting(true)
          }
          worker.addEventListener('statechange', changed)
          cleanups.push(() => worker.removeEventListener('statechange', changed))
          changed()
        }
        registration.addEventListener('updatefound', observe)
        cleanups.push(() => registration.removeEventListener('updatefound', observe))
        observe()
        if (offlineAttempt) await registration.update()
      })
      .catch(() =>
        setOfflineError('Offline app download failed. Stay online and retry in Settings.')
      )
    return () => {
      cancelled = true
      navigator.serviceWorker.removeEventListener('message', listener)
      cleanups.forEach((cleanup) => cleanup())
    }
  }, [offlineAttempt])
  const loaded = !!snapshot
  useEffect(() => {
    if (!loaded || !storeRef.current) return
    const idempotencyKey = saleKey.current
    const timer = setTimeout(() => {
      storeRef.current
        ?.setPreference('draft', {
          cart,
          service,
          label,
          note,
          holdId,
          discount,
          discountReason,
          idempotencyKey,
        })
        .catch((e) => setError(e.message))
    }, 180)
    return () => clearTimeout(timer)
  }, [loaded, cart, service, label, note, holdId, discount, discountReason])
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(''), 5000)
    return () => clearTimeout(timer)
  }, [message])
  useEffect(() => {
    setError('')
    operationKey.current = createId()
  }, [modal, refundTarget, editProduct])

  const run = useCallback(async (work: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await work()
      if (storeRef.current) setSnapshot(await storeRef.current.snapshot())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The change was not saved. Please try again.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [])
  const store = () => {
    if (!storeRef.current) throw new Error('Device storage is not ready.')
    return storeRef.current
  }
  const overrides = (snapshot?.preferences.catalogueOverrides || {}) as Record<string, Override>
  const favourites = (snapshot?.preferences.favourites || quickIds) as string[]
  const kitchen = (snapshot?.preferences.kitchen || []) as KitchenTicket[]
  const activeShift = snapshot?.shifts.find((s) => s.status === 'open')
  const discountFils = previewFils(discount)
  const subtotal = calculateTotals(cart, 0, TRAINING_TAX).subtotalFils
  const totals = calculateTotals(cart, Math.min(discountFils, subtotal), TRAINING_TAX)
  const products = useMemo(
    () =>
      catalogue.items
        .filter(
          (item) =>
            (category === 'All items' ||
              (category === 'Favourites'
                ? favourites.includes(item.id)
                : item.category === category)) &&
            `${item.name} ${item.nameAr} ${item.id}`.toLowerCase().includes(search.toLowerCase())
        )
        .sort((a, b) => Number(quickIds.includes(b.id)) - Number(quickIds.includes(a.id))),
    [search, category, favourites]
  )
  const categories = [
    'All items',
    'Favourites',
    ...Array.from(new Set(catalogue.items.map((i) => i.category))),
  ]
  const totalSales = snapshot?.sales.reduce((n, s) => n + s.totals.totalFils, 0) || 0
  const totalRefunds = snapshot?.refunds.reduce((n, r) => n + r.amountFils, 0) || 0
  const change =
    paymentMethod === 'cash' && /^\d+(\.\d{1,2})?$/.test(cashPaid)
      ? Math.max(0, previewFils(cashPaid) - totals.totalFils)
      : paymentMethod === 'mixed' &&
          /^\d+(\.\d{1,2})?$/.test(cashPaid) &&
          /^\d+(\.\d{1,2})?$/.test(cardPaid)
        ? Math.max(0, previewFils(cashPaid) + previewFils(cardPaid) - totals.totalFils)
        : 0

  function resetCart() {
    setCart([])
    setLabel('')
    setNote('')
    setDiscount('0')
    setDiscountReason('')
    setHoldId(undefined)
    saleKey.current = createId()
    setBasketOpen(false)
  }
  function addItem(item: Product) {
    const override = overrides[item.id]
    if (override?.available === false) return
    if ((override?.priceFils ?? item.priceFils) <= 0) {
      setEditProduct(item)
      setEditPrice('')
      setEditUnit(override?.unit || 'each')
      setEditAvailable(true)
      setMessage('Set an explicit price and sale unit before adding this item')
      return
    }
    if (override?.unit === 'kg') {
      setWeightName(item.name)
      setWeightRate(formatFils(override.priceFils ?? item.priceFils).replaceAll(',', ''))
      setGrams('250')
      setModal('weight')
      return
    }
    setCart((lines) => {
      const existing = lines.find((l) => l.itemId === item.id && l.unit === 'each' && !l.note)
      return existing
        ? lines.map((l) => (l.id === existing.id ? { ...l, quantity: l.quantity + 1 } : l))
        : [
            ...lines,
            {
              id: createId(),
              itemId: item.id,
              name: item.name,
              unit: 'each',
              quantity: 1,
              unitPriceFils: override?.priceFils ?? item.priceFils,
            },
          ]
    })
    setMessage(`${item.name} added`)
  }
  function changeQuantity(id: string, delta: number) {
    setCart((lines) =>
      lines
        .map((l) =>
          l.id === id ? { ...l, quantity: l.quantity + delta * (l.unit === 'kg' ? 50 : 1) } : l
        )
        .filter((l) => l.quantity > 0)
    )
  }
  async function hold(sendToKitchen = false) {
    if (!cart.length) throw new Error('Add an item first.')
    const checkedDiscount = parseMoney(discount)
    if (checkedDiscount > subtotal) throw new Error('Discount is larger than the basket.')
    if (holdId && kitchen.some((k) => k.id === holdId))
      throw new Error(
        'This order already has a kitchen ticket. Complete its payment, or reconcile the kitchen ticket before changing it.'
      )
    await store().holdOrder({
      id: holdId,
      idempotencyKey: saleKey.current,
      sendToKitchen,
      label: label.trim() || `${serviceLabel(service)} order`,
      serviceType: service,
      lines: cart,
      discountFils: checkedDiscount,
      discountReason,
      note,
    })
    resetCart()
    setMessage(
      sendToKitchen
        ? 'Order held and kitchen ticket saved on this device'
        : 'Order held on this device'
    )
  }
  function resume(order: HeldOrder) {
    if (cart.length) {
      setError('Hold or clear the current basket before opening another order.')
      return
    }
    setCart(order.lines)
    setService(order.serviceType)
    setLabel(order.label)
    setNote(order.note || '')
    setDiscount((order.discountFils / 100).toString())
    setDiscountReason(order.discountReason || '')
    setHoldId(order.id)
    setTab('sell')
    setBasketOpen(true)
    saleKey.current = createId()
  }
  function openPayment() {
    if (!activeShift) {
      setModal('openShift')
      return
    }
    if (!cart.length) return
    setPaymentMethod('cash')
    setCashPaid((totals.totalFils / 100).toFixed(2))
    setCardPaid('')
    setCardConfirmed(false)
    setModal('payment')
  }
  async function completePayment() {
    const checkedDiscount = parseMoney(discount)
    if ((paymentMethod === 'card' || paymentMethod === 'mixed') && !cardConfirmed)
      throw new Error('Confirm the external card payment before recording it.')
    if (service === 'dine_in' && !label.trim())
      throw new Error('Add a table or order name to this dine-in order.')
    if (checkedDiscount > subtotal)
      throw new Error('Discount is larger than the basket. Adjust it before checkout.')
    const tenders =
      paymentMethod === 'cash'
        ? [{ method: 'cash' as const, amountFils: parseMoney(cashPaid) }]
        : paymentMethod === 'card'
          ? [{ method: 'card' as const, amountFils: totals.totalFils }]
          : [
              { method: 'cash' as const, amountFils: parseMoney(cashPaid) },
              { method: 'card' as const, amountFils: parseMoney(cardPaid) },
            ]
    const sale = await store().completeSale({
      idempotencyKey: saleKey.current,
      lines: cart,
      discountFils: checkedDiscount,
      discountReason,
      tax: TRAINING_TAX,
      tenders,
      serviceType: service,
      label,
      note,
      holdId,
    })
    resetCart()
    setModal(null)
    setReceipt(sale)
    setMessage('Training sale saved on this device')
  }
  async function exportSales() {
    const rows = [
      [
        'Receipt',
        'Date',
        'Order type',
        'Total AED',
        'Tax AED',
        'Cash AED',
        'Recorded card AED',
        'Change AED',
      ],
      ...(snapshot?.sales || []).map((s) => [
        s.receiptNumber,
        s.createdAt,
        serviceLabel(s.serviceType),
        (s.totals.totalFils / 100).toFixed(2),
        (s.totals.taxFils / 100).toFixed(2),
        (s.payment.cashRetainedFils / 100).toFixed(2),
        (s.payment.cardRecordedFils / 100).toFixed(2),
        (s.payment.changeFils / 100).toFixed(2),
      ]),
    ]
    download(
      `internext-training-sales-${new Date().toISOString().slice(0, 10)}.csv`,
      rows
        .map((row) => row.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(','))
        .join('\r\n'),
      'text/csv;charset=utf-8'
    )
  }
  function moveTab(next: Tab) {
    setTab(next)
    setNavOpen(false)
    setSearch('')
    setCategory('All items')
    setBasketOpen(false)
  }

  if (fatal)
    return (
      <main className="pos-start-error">
        <h1>Device storage is unavailable</h1>
        <p>{fatal}</p>
        <p>
          Allow browser storage and reopen the app. Orders cannot be saved safely until this is
          resolved.
        </p>
        <button onClick={() => location.reload()}>Try again</button>
      </main>
    )
  if (!snapshot)
    return (
      <main className="pos-loading">
        <span className="brand-mark">in</span>
        <h1>Opening your counter</h1>
        <p>Checking this device’s saved orders…</p>
      </main>
    )

  return (
    <PosErrorContext.Provider value={error}>
      <main className="pos-app">
        <aside
          ref={(node) => {
            sidebarRef.current = node
            if (node) node.inert = (phone && !navOpen) || ticketOverlay
          }}
          tabIndex={-1}
          className={`pos-sidebar ${navOpen ? 'is-open' : ''}`}
          aria-label="Main navigation"
          role={navOverlay ? 'dialog' : undefined}
          aria-modal={navOverlay || undefined}
        >
          <Link href="/" prefetch={false} className="pos-brand" aria-label="Internext POS home">
            <span className="brand-mark">in</span>
            <span>
              internext<strong>POS</strong>
            </span>
          </Link>
          <button
            className="nav-close icon-button"
            onClick={() => setNavOpen(false)}
            aria-label="Close navigation"
          >
            <X />
          </button>
          <nav>
            {navigation.map(({ id, label: name, icon: Icon }) => (
              <button
                key={id}
                onClick={() => moveTab(id)}
                className={tab === id ? 'active' : ''}
                aria-current={tab === id ? 'page' : undefined}
              >
                <Icon size={21} />
                <span>{name}</span>
                {id === 'orders' && snapshot.holds.length > 0 && <b>{snapshot.holds.length}</b>}
              </button>
            ))}
          </nav>
          <button className="sidebar-help" onClick={() => setModal('help')}>
            <CircleHelp size={20} />
            <span>Quick guide</span>
          </button>
          <div className="sidebar-plan">
            <span>One branch. Every feature.</span>
            <strong>
              AED 100<span> / month</span>
            </strong>
            <small>Subscription not yet activated</small>
          </div>
        </aside>
        {navOpen && (
          <button
            className="nav-scrim"
            onClick={() => setNavOpen(false)}
            aria-label="Close navigation"
          />
        )}
        <div className="pos-body">
          <header
            className="pos-topbar"
            ref={(node) => {
              if (node) node.inert = backgroundInert
            }}
          >
            <button
              className="mobile-nav icon-button"
              aria-label="Open navigation"
              onClick={() => setNavOpen(true)}
            >
              <Menu />
            </button>
            <div className="restaurant-identity">
              <img
                src="/pos-assets/brand/mithaiwala.webp"
                alt="Suleman Usman Mithaiwala"
                width="42"
                height="42"
              />
              <div>
                <strong>Suleman Usman Mithaiwala</strong>
                <button onClick={() => moveTab('branches')}>
                  {branchName} <ChevronDown size={14} />
                </button>
              </div>
            </div>
            <div className="topbar-right">
              <span className={`connection ${online ? '' : 'offline'}`}>
                {online ? <Wifi size={16} /> : <WifiOff size={16} />}
                <span>{online ? 'Online' : 'Offline'}</span>
              </span>
              <button
                className="shift-pill"
                onClick={() => (activeShift ? moveTab('shift') : setModal('openShift'))}
              >
                <span className={activeShift ? 'status-dot' : 'status-dot closed'} />
                <span>{activeShift ? 'Shift open' : 'Open shift'}</span>
              </button>
              <button
                className="avatar"
                onClick={() => moveTab('shift')}
                aria-label="View cashier shift"
              >
                {(activeShift?.cashierName || 'Manager').slice(0, 1)}
              </button>
            </div>
          </header>
          <div
            className="training-strip"
            ref={(node) => {
              if (node) node.inert = backgroundInert
            }}
          >
            <span>
              <span className="training-dot" /> Training workspace
            </span>
            <p>Saved on this device. Archived menu prices need review before live sales.</p>
            <button onClick={() => moveTab('settings')}>
              Setup status <ArrowRight size={14} />
            </button>
          </div>
          {error && (
            <div className="pos-alert" role="alert">
              <span>{error}</span>
              <button onClick={() => setError('')} aria-label="Dismiss error">
                <X size={18} />
              </button>
            </div>
          )}
          <div className={`pos-workspace ${tab === 'sell' ? 'selling' : ''}`}>
            <section
              className="pos-main-panel"
              ref={(node) => {
                if (node) node.inert = backgroundInert
              }}
            >
              <header className="workspace-title">
                <div>
                  <h1>
                    {
                      {
                        sell: 'New order',
                        orders: 'Orders',
                        kitchen: 'Kitchen',
                        menu: 'Your menu',
                        reports: 'Sales overview',
                        shift: 'Cash & shifts',
                        branches: 'Your branches',
                        settings: 'Workspace settings',
                      }[tab]
                    }
                  </h1>
                  <p>
                    {
                      {
                        sell: 'A familiar menu. A faster counter.',
                        orders: 'Held orders and completed sales on this device.',
                        kitchen: 'Preparation tickets on this device.',
                        menu: 'Review prices, sale units and availability.',
                        reports: 'Training sales from this device only.',
                        shift: 'Start clearly. Close with everything accounted for.',
                        branches: 'One subscription for each branch. Every feature included.',
                        settings: 'Keep your counter ready for service.',
                      }[tab]
                    }
                  </p>
                </div>
                {tab === 'sell' ? (
                  <button
                    className="secondary compact"
                    onClick={() => {
                      setWeightName('')
                      setWeightRate('')
                      setGrams('250')
                      setModal('weight')
                    }}
                  >
                    <Scale size={17} /> <span>Weight sale</span>
                  </button>
                ) : tab === 'reports' ? (
                  <button className="secondary" onClick={() => void run(exportSales)}>
                    <Download size={17} /> Export sales
                  </button>
                ) : null}
              </header>

              {(tab === 'sell' || tab === 'menu') && (
                <>
                  <div className="menu-search">
                    <Search size={20} />
                    <input
                      aria-label="Search menu"
                      placeholder="Search dishes, sweets or item code…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {search && (
                      <button
                        className="icon-button"
                        onClick={() => setSearch('')}
                        aria-label="Clear search"
                      >
                        <X size={18} />
                      </button>
                    )}
                    <span>{products.length} items</span>
                  </div>
                  <div className="category-scroll" aria-label="Menu categories">
                    {categories.map((cat) => (
                      <button
                        key={cat}
                        className={category === cat ? 'active' : ''}
                        aria-pressed={category === cat}
                        onClick={() => setCategory(cat)}
                      >
                        {cat === 'Favourites' && <Star size={14} />}
                        {cat}
                      </button>
                    ))}
                  </div>
                  <div className="catalogue-heading">
                    <h2>{category}</h2>
                    <span>
                      {tab === 'sell'
                        ? 'Tap an item to add it'
                        : 'Changes apply to this training device'}
                    </span>
                  </div>
                  {products.length === 0 ? (
                    <Empty title="No matching items">Try another dish name or category.</Empty>
                  ) : (
                    <div className="product-grid">
                      {products.map((item) => {
                        const override = overrides[item.id]
                        const available = override?.available !== false
                        const price = override?.priceFils ?? item.priceFils
                        return (
                          <article
                            className={`product-card ${available ? '' : 'unavailable'}`}
                            key={item.id}
                          >
                            <button
                              className="product-add"
                              disabled={tab === 'sell' && !available}
                              onClick={() =>
                                tab === 'sell'
                                  ? addItem(item)
                                  : (setEditProduct(item),
                                    setEditPrice(
                                      ((override?.priceFils ?? item.priceFils) / 100).toFixed(2)
                                    ),
                                    setEditUnit(override?.unit || 'each'),
                                    setEditAvailable(available))
                              }
                              aria-label={`${tab === 'sell' ? (price > 0 ? 'Add' : 'Set price for') : 'Edit'} ${item.name}`}
                            >
                              <div className="product-image">
                                {item.image ? (
                                  <img
                                    src={item.image}
                                    alt={item.name}
                                    loading="lazy"
                                    width="240"
                                    height="180"
                                  />
                                ) : (
                                  <div className="image-placeholder">
                                    <ShoppingBag size={29} />
                                    <span>Photo to add</span>
                                  </div>
                                )}
                                {!available && <span className="sold-out">Sold out</span>}
                                <span className="add-corner">
                                  {tab === 'sell' ? (
                                    <Plus size={18} />
                                  ) : (
                                    <SlidersHorizontal size={16} />
                                  )}
                                </span>
                              </div>
                              <div className="product-copy">
                                <h3>{item.name}</h3>
                                <div>
                                  <strong>
                                    {price > 0 ? currency(price) : 'Price needs review'}
                                    {price > 0 && override?.unit === 'kg' ? ' / kg' : ''}
                                  </strong>
                                </div>
                              </div>
                            </button>
                            <button
                              className={`favourite ${favourites.includes(item.id) ? 'selected' : ''}`}
                              aria-label={`${favourites.includes(item.id) ? 'Remove' : 'Add'} ${item.name} ${favourites.includes(item.id) ? 'from' : 'to'} favourites`}
                              onClick={() =>
                                void run(async () => {
                                  await store().setPreference(
                                    'favourites',
                                    favourites.includes(item.id)
                                      ? favourites.filter((id) => id !== item.id)
                                      : [...favourites, item.id]
                                  )
                                })
                              }
                            >
                              <Star
                                size={15}
                                fill={favourites.includes(item.id) ? 'currentColor' : 'none'}
                              />
                            </button>
                          </article>
                        )
                      })}
                    </div>
                  )}
                </>
              )}

              {tab === 'orders' && (
                <>
                  <h2 className="section-title">
                    Held orders <span>{snapshot.holds.length}</span>
                  </h2>
                  {!snapshot.holds.length ? (
                    <Empty title="No orders on hold">
                      Hold a basket or send an unpaid order to the kitchen. It will appear here.
                    </Empty>
                  ) : (
                    <div className="order-cards">
                      {snapshot.holds.map((h) => (
                        <article className="order-card" key={h.id}>
                          <div className="order-card-top">
                            <span className="tag">{serviceLabel(h.serviceType)}</span>
                            <small>{time(h.createdAt)}</small>
                          </div>
                          <h3>{h.label}</h3>
                          <p>
                            {h.lines.reduce((n, l) => n + (l.unit === 'each' ? l.quantity : 1), 0)}{' '}
                            items ·{' '}
                            {currency(
                              calculateTotals(h.lines, h.discountFils, TRAINING_TAX).totalFils
                            )}
                          </p>
                          <button className="primary" onClick={() => resume(h)}>
                            Open order <ArrowRight size={17} />
                          </button>
                          <button
                            className="text-button danger"
                            onClick={() =>
                              void run(async () => {
                                const ticket = kitchen.find((k) => k.id === h.id)
                                if (
                                  !window.confirm(
                                    ticket
                                      ? 'Confirm that kitchen preparation has been stopped or reconciled, then cancel this training order? No other device will receive this cancellation.'
                                      : 'Cancel this held training order?'
                                  )
                                )
                                  return
                                if (ticket) {
                                  await store().setPreference('cancelledKitchenTickets', [
                                    ...((snapshot.preferences.cancelledKitchenTickets ||
                                      []) as unknown[]),
                                    { ...ticket, cancelledAt: new Date().toISOString() },
                                  ])
                                  await store().setPreference(
                                    'kitchen',
                                    kitchen.filter((k) => k.id !== h.id)
                                  )
                                }
                                await store().deleteHold(h.id)
                                if (holdId === h.id) resetCart()
                                setMessage('Held training order cancelled')
                              })
                            }
                          >
                            Cancel held order
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                  <h2 className="section-title">
                    Completed sales <span>{snapshot.sales.length}</span>
                  </h2>
                  {!snapshot.sales.length ? (
                    <Empty title="Your first sale starts here">
                      Open a shift, add items and complete a training checkout.
                    </Empty>
                  ) : (
                    <div className="table-scroll">
                      <table className="pos-table">
                        <thead>
                          <tr>
                            <th>Receipt</th>
                            <th>Order</th>
                            <th>Time</th>
                            <th>Total</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...snapshot.sales].reverse().map((s) => (
                            <tr key={s.id}>
                              <td>
                                <strong>{s.receiptNumber}</strong>
                                <small>Saved on device</small>
                              </td>
                              <td>{s.label || serviceLabel(s.serviceType)}</td>
                              <td>{time(s.createdAt)}</td>
                              <td>
                                {currency(s.totals.totalFils)}
                                {snapshot.refunds.some((r) => r.saleId === s.id) && (
                                  <small>Refund recorded</small>
                                )}
                              </td>
                              <td>
                                <button className="text-button" onClick={() => setReceipt(s)}>
                                  Receipt
                                </button>
                                <button
                                  className="text-button"
                                  disabled={remainingRefundFils(snapshot, s.id) <= 0}
                                  onClick={() => {
                                    setRefundTarget(s)
                                    setRefundAmount(
                                      (remainingRefundFils(snapshot, s.id) / 100).toFixed(2)
                                    )
                                    setRefundReason('')
                                    setRefundMethod(
                                      s.payment.cashRetainedFils > 0 ? 'cash' : 'card'
                                    )
                                  }}
                                >
                                  Refund
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

              {tab === 'kitchen' && (
                <>
                  <div className="info-note">
                    <ChefHat size={18} />
                    <span>
                      This board is local to this device. Other kitchen devices and physical
                      printers are not connected yet.
                    </span>
                  </div>
                  {!kitchen.length ? (
                    <Empty icon={ChefHat} title="The kitchen is clear">
                      Use “Send to kitchen” from a basket to create a preparation ticket.
                    </Empty>
                  ) : (
                    <div className="kitchen-columns">
                      {(['new', 'preparing', 'ready'] as const).map((status) => (
                        <section key={status} className={`kitchen-column ${status}`}>
                          <h2>
                            {{ new: 'New', preparing: 'Preparing', ready: 'Ready' }[status]}
                            <span>{kitchen.filter((k) => k.status === status).length}</span>
                          </h2>
                          {kitchen
                            .filter((k) => k.status === status)
                            .map((k) => (
                              <article className="kitchen-ticket" key={k.id}>
                                <div>
                                  <strong>{k.label}</strong>
                                  <small>
                                    {time(k.createdAt)} · {serviceLabel(k.serviceType)}
                                  </small>
                                </div>
                                <ul>
                                  {k.lines.map((l) => (
                                    <li key={l.id}>
                                      <b>{l.unit === 'kg' ? `${l.quantity}g` : l.quantity} ×</b>
                                      <span>
                                        {l.name}
                                        {l.note && <small>{l.note}</small>}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                                {status !== 'ready' && (
                                  <button
                                    className="primary"
                                    onClick={() =>
                                      void run(async () => {
                                        await store().setPreference(
                                          'kitchen',
                                          kitchen.map((t) =>
                                            t.id === k.id
                                              ? {
                                                  ...t,
                                                  status: status === 'new' ? 'preparing' : 'ready',
                                                }
                                              : t
                                          )
                                        )
                                        setMessage('Kitchen status saved')
                                      })
                                    }
                                  >
                                    {status === 'new' ? 'Start preparing' : 'Mark ready'}{' '}
                                    <Check size={17} />
                                  </button>
                                )}
                                {status === 'ready' && (
                                  <span className="ready-label">
                                    <CheckCircle2 size={17} /> Ready for handover
                                  </span>
                                )}
                              </article>
                            ))}
                        </section>
                      ))}
                    </div>
                  )}
                </>
              )}

              {tab === 'reports' && (
                <>
                  <div className="metric-grid">
                    <Metric
                      label="Sales after refunds"
                      value={currency(totalSales - totalRefunds)}
                      hint="Training · this device"
                    />
                    <Metric
                      label="Completed orders"
                      value={String(snapshot.sales.length)}
                      hint={`${snapshot.holds.length} currently held`}
                    />
                    <Metric
                      label="Average sale"
                      value={currency(
                        snapshot.sales.length ? Math.round(totalSales / snapshot.sales.length) : 0
                      )}
                      hint="Before recorded refunds"
                    />
                    <Metric
                      label="Refunds"
                      value={currency(totalRefunds)}
                      hint={`${snapshot.refunds.length} recorded refunds`}
                    />
                  </div>
                  <div className="report-panels">
                    <section className="content-panel">
                      <h2>Sales by order type</h2>
                      {(['dine_in', 'takeaway', 'delivery'] as const).map((s) => {
                        const value = snapshot.sales
                          .filter((o) => o.serviceType === s)
                          .reduce((a, o) => a + o.totals.totalFils, 0)
                        return (
                          <div className="report-bar" key={s}>
                            <div>
                              <span>{serviceLabel(s)}</span>
                              <strong>{currency(value)}</strong>
                            </div>
                            <progress max={Math.max(1, totalSales)} value={value} />
                          </div>
                        )
                      })}
                    </section>
                    <section className="content-panel">
                      <h2>Payment breakdown</h2>
                      <div className="summary-line">
                        <span>Cash retained</span>
                        <strong>
                          {currency(
                            snapshot.sales.reduce((n, s) => n + s.payment.cashRetainedFils, 0)
                          )}
                        </strong>
                      </div>
                      <div className="summary-line">
                        <span>Card payments recorded</span>
                        <strong>
                          {currency(
                            snapshot.sales.reduce((n, s) => n + s.payment.cardRecordedFils, 0)
                          )}
                        </strong>
                      </div>
                      <div className="summary-line">
                        <span>Discounts</span>
                        <strong>
                          {currency(snapshot.sales.reduce((n, s) => n + s.totals.discountFils, 0))}
                        </strong>
                      </div>
                      <div className="summary-line">
                        <span>Included tax before refunds, training setting</span>
                        <strong>
                          {currency(snapshot.sales.reduce((n, s) => n + s.totals.taxFils, 0))}
                        </strong>
                      </div>
                      <p className="muted">
                        Tender figures are before refunds. Recorded card payments are not verified
                        bank settlements.
                      </p>
                    </section>
                  </div>
                  <section className="content-panel">
                    <h2>Item sales</h2>
                    {!snapshot.sales.length ? (
                      <p className="muted">Complete a training sale to see your item breakdown.</p>
                    ) : (
                      <div className="table-scroll">
                        <table className="pos-table">
                          <thead>
                            <tr>
                              <th>Item</th>
                              <th>Quantity</th>
                              <th>Sales before discounts</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.values(
                              snapshot.sales
                                .flatMap((s) => s.lines)
                                .reduce<
                                  Record<
                                    string,
                                    { name: string; unit: string; quantity: number; amount: number }
                                  >
                                >((acc, l) => {
                                  const key = l.itemId + l.unit
                                  acc[key] ??= {
                                    name: l.name,
                                    unit: l.unit,
                                    quantity: 0,
                                    amount: 0,
                                  }
                                  acc[key].quantity += l.quantity
                                  acc[key].amount += lineTotalFils(l)
                                  return acc
                                }, {})
                            )
                              .sort((a, b) => b.amount - a.amount)
                              .map((l) => (
                                <tr key={l.name + l.unit}>
                                  <td>{l.name}</td>
                                  <td>
                                    {l.quantity}
                                    {l.unit === 'kg' ? ' g' : ''}
                                  </td>
                                  <td>{currency(l.amount)}</td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                </>
              )}

              {tab === 'shift' && (
                <>
                  <div className="metric-grid">
                    <Metric
                      label="Shift status"
                      value={activeShift ? 'Open' : 'Closed'}
                      hint={
                        activeShift
                          ? `Opened ${time(activeShift.openedAt)}`
                          : 'Open a shift before checkout'
                      }
                    />
                    <Metric
                      label="Opening float"
                      value={currency(activeShift?.openingCashFils || 0)}
                      hint={activeShift?.cashierName || 'No active cashier'}
                    />
                    <Metric
                      label="Expected cash"
                      value={currency(activeShift ? expectedCashFils(snapshot, activeShift.id) : 0)}
                      hint="Float + net cash movements"
                    />
                  </div>
                  <div className="action-row">
                    {activeShift ? (
                      <>
                        <button
                          className="secondary"
                          onClick={() => {
                            setCashAmount('')
                            setCashReason('')
                            setModal('cash')
                          }}
                        >
                          <Wallet size={18} /> Cash in / out
                        </button>
                        <button
                          className="primary"
                          onClick={() => {
                            setCounted('')
                            setCloseNote('')
                            setModal('closeShift')
                          }}
                        >
                          Close shift <ArrowRight size={18} />
                        </button>
                      </>
                    ) : (
                      <button className="primary" onClick={() => setModal('openShift')}>
                        <Plus size={18} /> Open shift
                      </button>
                    )}
                  </div>
                  <section className="content-panel">
                    <h2>Shift history</h2>
                    {snapshot.shifts.length === 0 ? (
                      <p className="muted">
                        No shifts yet. Start with the actual amount of training cash in your drawer.
                      </p>
                    ) : (
                      <div className="table-scroll">
                        <table className="pos-table">
                          <thead>
                            <tr>
                              <th>Cashier</th>
                              <th>Opened</th>
                              <th>Status</th>
                              <th>Counted cash</th>
                              <th>Difference</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[...snapshot.shifts].reverse().map((s) => (
                              <tr key={s.id}>
                                <td>{s.cashierName}</td>
                                <td>
                                  {new Date(s.openedAt).toLocaleDateString('en-GB')}{' '}
                                  {time(s.openedAt)}
                                </td>
                                <td>
                                  <span className="tag">{s.status}</span>
                                </td>
                                <td>
                                  {s.countedCashFils == null ? '—' : currency(s.countedCashFils)}
                                </td>
                                <td>
                                  {s.differenceFils == null ? '—' : currency(s.differenceFils)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                  <section className="content-panel">
                    <h2>Cash movements</h2>
                    {snapshot.cashMovements.length === 0 ? (
                      <p className="muted">Cash added or removed outside sales will appear here.</p>
                    ) : (
                      snapshot.cashMovements.map((m) => (
                        <div className="summary-line" key={m.id}>
                          <span>
                            {m.reason}
                            <small>
                              {time(m.createdAt)} · Cash {m.direction}
                            </small>
                          </span>
                          <strong>
                            {m.direction === 'out' ? '−' : '+'}
                            {currency(m.amountFils)}
                          </strong>
                        </div>
                      ))
                    )}
                  </section>
                </>
              )}

              {tab === 'branches' && (
                <>
                  <div className="branch-overview">
                    <div className="branch-emblem">
                      <img
                        src="/pos-assets/brand/mithaiwala.webp"
                        alt="Mithaiwala logo"
                        width="64"
                        height="64"
                      />
                    </div>
                    <div>
                      <h2>{company}</h2>
                      <p>First customer · restaurant and sweets</p>
                    </div>
                  </div>
                  <article className="branch-card">
                    <div className="branch-card-heading">
                      <Store size={24} />
                      <div>
                        <h2>Bur Dubai</h2>
                        <p>First branch workspace</p>
                      </div>
                      <span className="tag">Training</span>
                    </div>
                    <div className="branch-details">
                      <div>
                        <span>Plan</span>
                        <strong>All features</strong>
                      </div>
                      <div>
                        <span>Subscription</span>
                        <strong>AED 100 / month</strong>
                      </div>
                      <div>
                        <span>Staff & devices</span>
                        <strong>Multiple included</strong>
                      </div>
                      <div>
                        <span>Collection</span>
                        <strong>Manual</strong>
                      </div>
                    </div>
                    <p className="muted">
                      No payment or active subscription has been recorded. Tenant enrollment and
                      staff access will be completed before live use.
                    </p>
                    <button className="primary" onClick={() => moveTab('sell')}>
                      Open counter <ArrowRight size={17} />
                    </button>
                  </article>
                  <div className="next-branch">
                    <Plus size={26} />
                    <div>
                      <h3>Ready for the next branch</h3>
                      <p>
                        Each additional branch is AED 100/month with all features. Activate it after
                        the Bur Dubai pilot is accepted.
                      </p>
                    </div>
                  </div>
                </>
              )}

              {tab === 'settings' && (
                <div className="settings-grid">
                  <section className="content-panel">
                    <h2>Offline & device storage</h2>
                    <div className="summary-line">
                      <span>App available offline</span>
                      <strong>
                        {offlineReady
                          ? 'Downloaded'
                          : process.env.NODE_ENV === 'production'
                            ? 'Preparing…'
                            : 'Production preview required'}
                      </strong>
                    </div>
                    <div className="summary-line">
                      <span>Orders saved locally</span>
                      <strong>{snapshot.sales.length}</strong>
                    </div>
                    <div className="summary-line">
                      <span>Local audit events</span>
                      <strong>{snapshot.outbox.length}</strong>
                    </div>
                    <div className="summary-line">
                      <span>Cloud connection</span>
                      <strong>{serverState}</strong>
                    </div>
                    <p className="muted">
                      Training records stay on this device and are never uploaded as live sales.
                      Clearing browser data removes local records. Export a backup before changing
                      devices.
                    </p>
                    {offlineError && <p role="alert">{offlineError}</p>}
                    {updateWaiting && (
                      <p className="muted">
                        An app update is ready. Finish the current order, close all POS tabs, then
                        reopen to use it.
                      </p>
                    )}
                    <div className="action-row">
                      <button
                        className="secondary"
                        onClick={() =>
                          void run(async () => {
                            download(
                              `internext-training-backup-${new Date().toISOString().slice(0, 10)}.json`,
                              await store().exportBackup(),
                              'application/json'
                            )
                            setMessage('Training backup downloaded')
                          })
                        }
                      >
                        <Download size={17} /> Export backup
                      </button>
                      <button
                        className="secondary"
                        onClick={() =>
                          void run(async () => {
                            const r = await fetch('/api/pos/bootstrap', { cache: 'no-store' })
                            const data = await r.json()
                            setServerState(
                              r.ok
                                ? 'Server reachable; training remains separate'
                                : data.status === 'setup_required'
                                  ? 'Server setup required'
                                  : data.status === 'authentication_required'
                                    ? 'Staff sign-in required'
                                    : data.message || 'Setup required'
                            )
                            setMessage('Connection status updated')
                          })
                        }
                      >
                        <RefreshCw size={16} /> Check connection
                      </button>
                    </div>
                    <button
                      className="secondary"
                      disabled={process.env.NODE_ENV !== 'production'}
                      onClick={() => setOfflineAttempt((value) => value + 1)}
                    >
                      <Download size={16} /> Prepare offline app
                    </button>
                    <button
                      className="text-button"
                      onClick={() => {
                        setRestoreInfo(null)
                        setRestoreText('')
                        setRestoreAcknowledged(false)
                        setModal('restore')
                      }}
                    >
                      Recover from a training backup
                    </button>
                    <p className="device-id">Device {snapshot.scope.deviceId.slice(0, 8)}</p>
                  </section>
                  <section className="content-panel">
                    <h2>Menu & tax review</h2>
                    <p>
                      133 items imported from the restaurant’s archived Noon catalogue dated 20
                      August 2026. 125 source images included.
                    </p>
                    <p className="muted">
                      Counter prices, units, availability and tax registration must be confirmed
                      before activation. Training receipts use a provisional 5% inclusive tax
                      calculation and are not tax invoices.
                    </p>
                    <button className="secondary" onClick={() => moveTab('menu')}>
                      Review menu <ArrowRight size={17} />
                    </button>
                  </section>
                  <section className="content-panel">
                    <h2>Printing & Android</h2>
                    <p>
                      Receipt preview and browser printing are available for testing. Printer
                      delivery is not confirmed by the app.
                    </p>
                    <p className="muted">
                      The Android package and native printer adapters follow web acceptance.
                      Hardware selection can happen after the workflow is reviewed.
                    </p>
                  </section>
                  <section className="content-panel">
                    <h2>Staff & subscription</h2>
                    <p>
                      AED 100 per branch per month. All features, multiple staff and devices.
                      Subscription collection starts manually.
                    </p>
                    <p className="muted">
                      This training workspace has no live staff permissions. Live accounts, branch
                      enrollment and payment records require server setup. Other devices do not
                      share this browser’s data.
                    </p>
                    <span className="setup-status">
                      <LockKeyhole size={16} /> Live activation pending
                    </span>
                  </section>
                </div>
              )}
            </section>

            {tab === 'sell' && (
              <>
                <aside
                  ref={(node) => {
                    ticketRef.current = node
                    if (node) node.inert = (compact && !basketOpen) || navOverlay
                  }}
                  tabIndex={-1}
                  role={ticketOverlay ? 'dialog' : undefined}
                  aria-modal={ticketOverlay || undefined}
                  className={`pos-ticket ${basketOpen ? 'is-open' : ''}`}
                  aria-label="Current order"
                >
                  <header className="ticket-heading">
                    <div>
                      <h2>
                        Current order <span>{cart.length}</span>
                      </h2>
                      <p>
                        {holdId ? 'Resumed order' : 'New ticket'} · {branchName}
                      </p>
                    </div>
                    <button
                      className="ticket-mobile-close icon-button"
                      onClick={() => setBasketOpen(false)}
                      aria-label="Close basket"
                    >
                      <X />
                    </button>
                    <button
                      className="ticket-desktop-clear icon-button"
                      disabled={!cart.length}
                      onClick={() => {
                        if (window.confirm('Clear this unsaved basket?')) resetCart()
                      }}
                      aria-label="Clear basket"
                    >
                      <Trash2 size={18} />
                    </button>
                  </header>
                  {ticketOverlay && error && !modal && (
                    <p className="pos-alert" role="alert">
                      {error}
                    </p>
                  )}
                  <div className="service-selector">
                    {(['dine_in', 'takeaway', 'delivery'] as const).map((s) => (
                      <button
                        key={s}
                        aria-pressed={service === s}
                        className={service === s ? 'active' : ''}
                        onClick={() => setService(s)}
                      >
                        {serviceLabel(s)}
                      </button>
                    ))}
                  </div>
                  <label className="order-label">
                    <input
                      aria-label="Table or order name"
                      placeholder={
                        service === 'dine_in'
                          ? 'Table number or name (required)'
                          : 'Order name or reference (optional)'
                      }
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                    />
                  </label>
                  <div className="ticket-lines">
                    {!cart.length ? (
                      <Empty title="Let’s take an order">Tap a menu item to add it here.</Empty>
                    ) : (
                      cart.map((l) => (
                        <div className="ticket-line" key={l.id}>
                          <div className="ticket-line-name">
                            <strong>{l.name}</strong>
                            <button
                              className="remove-line"
                              aria-label={`Remove ${l.name}`}
                              onClick={() => setCart((lines) => lines.filter((x) => x.id !== l.id))}
                            >
                              <X size={15} />
                            </button>
                          </div>
                          <div className="ticket-line-bottom">
                            <div className="stepper">
                              <button
                                onClick={() => changeQuantity(l.id, -1)}
                                aria-label={`Decrease ${l.name}`}
                              >
                                <Minus size={14} />
                              </button>
                              <span>
                                {l.quantity}
                                {l.unit === 'kg' ? 'g' : ''}
                              </span>
                              <button
                                onClick={() => changeQuantity(l.id, 1)}
                                aria-label={`Increase ${l.name}`}
                              >
                                <Plus size={14} />
                              </button>
                            </div>
                            <strong>{currency(lineTotalFils(l))}</strong>
                          </div>
                          <input
                            className="line-note"
                            aria-label={`Preparation note for ${l.name}`}
                            placeholder="Add preparation note"
                            value={l.note || ''}
                            onChange={(e) =>
                              setCart((lines) =>
                                lines.map((x) =>
                                  x.id === l.id ? { ...x, note: e.target.value } : x
                                )
                              )
                            }
                          />
                        </div>
                      ))
                    )}
                  </div>
                  <div className="ticket-footer">
                    <textarea
                      aria-label="Order note"
                      placeholder="Order note, delivery reference…"
                      rows={1}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                    <div className="summary-line">
                      <span>Subtotal</span>
                      <strong>{currency(totals.subtotalFils)}</strong>
                    </div>
                    <div className="summary-line">
                      <button className="discount-button" onClick={() => setModal('discount')}>
                        Discount <Plus size={13} />
                      </button>
                      <span>{totals.discountFils ? `−${currency(totals.discountFils)}` : '—'}</span>
                    </div>
                    <div className="summary-line muted">
                      <span>Tax included · training 5%</span>
                      <span>{currency(totals.taxFils)}</span>
                    </div>
                    <div className="ticket-total">
                      <span>Total</span>
                      <strong>{currency(totals.totalFils)}</strong>
                    </div>
                    <div className="ticket-actions">
                      <button
                        className="secondary"
                        disabled={busy || !cart.length}
                        onClick={() => void run(() => hold())}
                      >
                        Hold order
                      </button>
                      <button
                        className="secondary"
                        disabled={busy || !cart.length}
                        onClick={() => void run(() => hold(true))}
                      >
                        <ChefHat size={16} /> Kitchen
                      </button>
                    </div>
                    <button
                      className="pay-button"
                      disabled={busy || !cart.length}
                      onClick={openPayment}
                    >
                      <span>{activeShift ? 'Charge' : 'Open shift to charge'}</span>
                      <span>
                        {currency(totals.totalFils)} <ArrowRight size={19} />
                      </span>
                    </button>
                    <p className="ticket-caption">
                      <LockKeyhole size={12} /> Training checkout · no money is charged
                    </p>
                  </div>
                </aside>
                <button
                  className="mobile-basket"
                  ref={(node) => {
                    if (node) node.inert = backgroundInert
                  }}
                  onClick={() => setBasketOpen(true)}
                >
                  <span>
                    <ShoppingBag size={19} />
                    {cart.length} {cart.length === 1 ? 'item' : 'items'} · Review order
                  </span>
                  <strong>
                    {currency(totals.totalFils)} <ArrowRight size={17} />
                  </strong>
                </button>
              </>
            )}
          </div>
          <footer
            className="pos-statusbar"
            ref={(node) => {
              if (node) node.inert = backgroundInert
            }}
          >
            <span>
              <span className="status-dot" />{' '}
              {offlineReady ? 'App downloaded for offline use' : 'Local order storage ready'}
            </span>
            <span>Training only · {snapshot.sales.length} sales saved on this device</span>
          </footer>
        </div>
        {message && (
          <div className="pos-toast" role="status">
            <CheckCircle2 size={19} />
            {message}
          </div>
        )}

        {modal === 'openShift' && (
          <Modal title="Open a shift" onClose={() => setModal(null)}>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  await store().openShift({
                    cashierName: cashier.trim(),
                    openingCashFils: parseMoney(float),
                  })
                  setModal(null)
                  setMessage('Shift opened on this device')
                })
              }}
            >
              <p className="muted">
                Start a training shift at Bur Dubai. Enter the cash in the drawer before sales.
              </p>
              <label>
                Cashier name
                <input
                  required
                  value={cashier}
                  onChange={(e) => setCashier(e.target.value)}
                  maxLength={80}
                />
              </label>
              <label>
                Opening cash (AED)
                <input
                  required
                  inputMode="decimal"
                  value={float}
                  onChange={(e) => setFloat(e.target.value)}
                />
              </label>
              <button className="primary full" disabled={busy}>
                Open shift <ArrowRight size={18} />
              </button>
            </form>
          </Modal>
        )}
        {modal === 'payment' && (
          <Modal title="Complete training sale" onClose={() => setModal(null)}>
            <div className="payment-total">
              <span>Total to record</span>
              <strong>{currency(totals.totalFils)}</strong>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void run(completePayment)
              }}
            >
              <div className="payment-methods">
                {(['cash', 'card', 'mixed'] as const).map((m) => (
                  <button
                    type="button"
                    key={m}
                    className={paymentMethod === m ? 'active' : ''}
                    onClick={() => {
                      setPaymentMethod(m)
                      setCardConfirmed(false)
                      if (m === 'mixed') {
                        setCashPaid('')
                        setCardPaid('')
                      }
                    }}
                  >
                    {m === 'cash' ? <Wallet /> : <CreditCard />}
                    {m === 'mixed' ? 'Split payment' : m === 'card' ? 'Card recorded' : 'Cash'}
                  </button>
                ))}
              </div>
              {paymentMethod !== 'card' && (
                <label>
                  Cash received (AED)
                  <input
                    required
                    inputMode="decimal"
                    value={cashPaid}
                    onChange={(e) => setCashPaid(e.target.value)}
                  />
                </label>
              )}
              {paymentMethod === 'mixed' && (
                <label>
                  Card amount (AED)
                  <input
                    required
                    inputMode="decimal"
                    value={cardPaid}
                    onChange={(e) => setCardPaid(e.target.value)}
                  />
                </label>
              )}
              {paymentMethod !== 'cash' && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={cardConfirmed}
                    onChange={(e) => setCardConfirmed(e.target.checked)}
                  />
                  <span>
                    I have checked the external terminal result. This app records the payment; it
                    does not charge a card.
                  </span>
                </label>
              )}
              {paymentMethod !== 'card' && (
                <div className="change-due">
                  <span>Cash change</span>
                  <strong>{currency(change)}</strong>
                </div>
              )}
              <button disabled={busy} className="primary full">
                <CheckCircle2 size={18} /> {busy ? 'Saving…' : 'Save training sale'}
              </button>
              <p className="muted small">
                The sale and its local audit event are saved together before success is shown.
              </p>
            </form>
          </Modal>
        )}
        {modal === 'discount' && (
          <Modal title="Order discount" onClose={() => setModal(null)}>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                try {
                  const amount = parseMoney(discount)
                  if (amount > subtotal) throw new Error('Discount cannot exceed the subtotal.')
                  if (amount > 0 && !discountReason.trim())
                    throw new Error('Add a reason for this discount.')
                  setModal(null)
                } catch (e) {
                  setError((e as Error).message)
                }
              }}
            >
              <p className="muted">
                Training adjustment. Live discounts will follow staff approval permissions.
              </p>
              <label>
                Discount (AED)
                <input
                  inputMode="decimal"
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                />
              </label>
              <label>
                Reason
                <input
                  value={discountReason}
                  onChange={(e) => setDiscountReason(e.target.value)}
                  placeholder="e.g. approved service recovery"
                />
              </label>
              <button className="primary full">Apply discount</button>
            </form>
          </Modal>
        )}
        {modal === 'weight' && (
          <Modal title="Sell by weight" onClose={() => setModal(null)}>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  const quantity = Number(grams)
                  if (!Number.isSafeInteger(quantity) || quantity <= 0)
                    throw new Error('Enter a positive whole number of grams.')
                  const rate = parseMoney(weightRate)
                  if (!weightName.trim() || rate <= 0)
                    throw new Error('Enter an item name and a positive price per kg.')
                  const item = catalogue.items.find((i) => i.name === weightName)
                  setCart((lines) => [
                    ...lines,
                    {
                      id: createId(),
                      itemId: item?.id || 'custom-weight',
                      name: weightName.trim(),
                      unit: 'kg',
                      quantity,
                      unitPriceFils: rate,
                    },
                  ])
                  setModal(null)
                  setMessage('Weighted item added')
                })
              }}
            >
              <p className="muted">
                Enter an explicitly confirmed rate per kg. Archived menu prices are not assumed to
                be kg prices.
              </p>
              <label>
                Item name
                <input
                  list="weight-items"
                  required
                  value={weightName}
                  onChange={(e) => setWeightName(e.target.value)}
                />
                <datalist id="weight-items">
                  {catalogue.items.map((i) => (
                    <option value={i.name} key={i.id} />
                  ))}
                </datalist>
              </label>
              <label>
                Price per kg (AED)
                <input
                  required
                  inputMode="decimal"
                  value={weightRate}
                  onChange={(e) => setWeightRate(e.target.value)}
                />
              </label>
              <label>
                Weight in grams
                <input
                  required
                  inputMode="numeric"
                  value={grams}
                  onChange={(e) => setGrams(e.target.value)}
                />
              </label>
              <div className="weight-presets">
                {[100, 250, 500, 1000].map((g) => (
                  <button type="button" key={g} onClick={() => setGrams(String(g))}>
                    {g === 1000 ? '1 kg' : `${g} g`}
                  </button>
                ))}
              </div>
              <button className="primary full">
                Add to order <Plus size={18} />
              </button>
            </form>
          </Modal>
        )}
        {modal === 'cash' && (
          <Modal title="Record cash movement" onClose={() => setModal(null)}>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  await store().cashMovement({
                    idempotencyKey: operationKey.current,
                    direction: cashDirection,
                    amountFils: parseMoney(cashAmount),
                    reason: cashReason,
                  })
                  setModal(null)
                  setMessage('Cash movement saved')
                })
              }}
            >
              <label>
                Movement
                <select
                  value={cashDirection}
                  onChange={(e) => setCashDirection(e.target.value as 'in' | 'out')}
                >
                  <option value="out">Cash out</option>
                  <option value="in">Cash in</option>
                </select>
              </label>
              <label>
                Amount (AED)
                <input
                  required
                  inputMode="decimal"
                  value={cashAmount}
                  onChange={(e) => setCashAmount(e.target.value)}
                />
              </label>
              <label>
                Reason
                <input
                  required
                  value={cashReason}
                  onChange={(e) => setCashReason(e.target.value)}
                />
              </label>
              <button className="primary full" disabled={busy}>
                Save movement
              </button>
            </form>
          </Modal>
        )}
        {modal === 'closeShift' && (
          <Modal title="Close your shift" onClose={() => setModal(null)}>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  if (cart.length) throw new Error('Complete or clear the current basket first.')
                  await store().closeShift({
                    countedCashFils: parseMoney(counted),
                    note: closeNote,
                  })
                  setModal(null)
                  setMessage('Shift closed and cash difference recorded')
                })
              }}
            >
              <p className="muted">
                Complete or cancel all held orders before closing. Count the physical cash, then
                enter it below.
              </p>
              <label>
                Counted cash (AED)
                <input
                  required
                  inputMode="decimal"
                  value={counted}
                  onChange={(e) => setCounted(e.target.value)}
                />
              </label>
              <label>
                Closing note
                <textarea
                  value={closeNote}
                  onChange={(e) => setCloseNote(e.target.value)}
                  placeholder="Explain any cash difference"
                />
              </label>
              <button className="primary full" disabled={busy}>
                Close shift
              </button>
            </form>
          </Modal>
        )}
        {modal === 'help' && (
          <Modal title="Your first training shift" onClose={() => setModal(null)}>
            <ol className="guide-list">
              <li>
                <strong>Open a shift</strong>
                <p>Enter your name and opening cash.</p>
              </li>
              <li>
                <strong>Build an order</strong>
                <p>Choose takeaway, dine-in or delivery. Tap dishes or add a weight sale.</p>
              </li>
              <li>
                <strong>Send or hold</strong>
                <p>
                  Kitchen saves a local preparation ticket. Held orders can be resumed from Orders.
                </p>
              </li>
              <li>
                <strong>Record payment</strong>
                <p>Use cash, recorded card, or split payment. No actual payment is processed.</p>
              </li>
              <li>
                <strong>Close and back up</strong>
                <p>Count cash, resolve open orders, close the shift and export your records.</p>
              </li>
            </ol>
          </Modal>
        )}
        {modal === 'restore' && (
          <Modal title="Recover a training device" onClose={() => setModal(null)}>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  if (!restoreInfo || !restoreAcknowledged)
                    throw new Error(
                      'Choose a valid backup and confirm the original installation is retired.'
                    )
                  const candidate = await createLocalPosStore(restoreInfo.scope)
                  try {
                    await candidate.restoreBackup(restoreText)
                    localStorage.setItem('internext-pos-device', restoreInfo.scope.deviceId)
                  } finally {
                    candidate.close()
                  }
                  location.reload()
                })
              }}
            >
              <p className="muted">
                Recover the original device identity and receipts. Existing records cannot be
                overwritten or merged. The original installation must stop selling before this
                identity is used here.
              </p>
              <label>
                Training backup file
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    setRestoreInfo(null)
                    setRestoreText('')
                    setRestoreAcknowledged(false)
                    if (!file) return
                    void run(async () => {
                      if (file.size > 50_000_000)
                        throw new Error('Backup exceeds the 50 MB recovery limit.')
                      const text = await file.text()
                      const info = inspectTrainingBackup(text)
                      if (
                        info.scope.organisationId !== snapshot.scope.organisationId ||
                        info.scope.branchId !== snapshot.scope.branchId
                      )
                        throw new Error('This backup belongs to another restaurant or branch.')
                      setRestoreText(text)
                      setRestoreInfo(info)
                    })
                  }}
                />
              </label>
              {restoreInfo && (
                <div className="info-note">
                  <span>
                    {restoreInfo.sales} sales · {restoreInfo.refunds} refunds · {restoreInfo.shifts}{' '}
                    shifts
                    <br />
                    Device {restoreInfo.scope.deviceId.slice(0, 8)} ·{' '}
                    {restoreInfo.openShift ? 'Open shift preserved' : 'No open shift'}
                  </span>
                </div>
              )}
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={restoreAcknowledged}
                  onChange={(e) => setRestoreAcknowledged(e.target.checked)}
                />
                <span>
                  The original device installation is retired. This replaces that identity; it must
                  not run alongside it.
                </span>
              </label>
              <button
                className="primary full"
                disabled={busy || !restoreInfo || !restoreAcknowledged}
              >
                Restore and reopen
              </button>
            </form>
          </Modal>
        )}
        {editProduct && (
          <Modal title={`Edit ${editProduct.name}`} onClose={() => setEditProduct(null)}>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  if (parseMoney(editPrice) <= 0)
                    throw new Error(
                      'Enter a positive price. Missing source prices cannot be treated as free items.'
                    )
                  await store().setPreference('catalogueOverrides', {
                    ...overrides,
                    [editProduct.id]: {
                      priceFils: parseMoney(editPrice),
                      unit: editUnit,
                      available: editAvailable,
                    },
                  })
                  setEditProduct(null)
                  setMessage('Training menu updated on this device')
                })
              }}
            >
              <p className="muted">Changes do not update Noon or any live restaurant menu.</p>
              <label>
                Sale unit
                <select
                  value={editUnit}
                  onChange={(e) => setEditUnit(e.target.value as 'each' | 'kg')}
                >
                  <option value="each">Each / menu portion</option>
                  <option value="kg">Kilogram — manually entered weight</option>
                </select>
              </label>
              <label>
                {editUnit === 'kg' ? 'Price per kg' : 'Price per menu portion'} (AED)
                <input
                  required
                  inputMode="decimal"
                  value={editPrice}
                  onChange={(e) => setEditPrice(e.target.value)}
                />
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={editAvailable}
                  onChange={(e) => setEditAvailable(e.target.checked)}
                />
                <span>Available to order</span>
              </label>
              <button className="primary full" disabled={busy}>
                Save item
              </button>
            </form>
          </Modal>
        )}
        {refundTarget && (
          <Modal title="Record training refund" onClose={() => setRefundTarget(null)}>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  await store().refundSale({
                    idempotencyKey: operationKey.current,
                    saleId: refundTarget.id,
                    amountFils: parseMoney(refundAmount),
                    method: refundMethod,
                    reason: refundReason,
                  })
                  setRefundTarget(null)
                  setMessage('Training refund recorded; no money was transferred')
                })
              }}
            >
              <p className="muted">
                {refundTarget.receiptNumber} · Remaining refundable:{' '}
                {currency(remainingRefundFils(snapshot, refundTarget.id))}. Refunds remain linked to
                the original sale.
              </p>
              <label>
                Refund amount (AED)
                <input
                  required
                  inputMode="decimal"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                />
              </label>
              <label>
                Method
                <select
                  value={refundMethod}
                  onChange={(e) => setRefundMethod(e.target.value as 'cash' | 'card')}
                >
                  <option value="cash">Cash</option>
                  <option value="card">External card refund recorded</option>
                </select>
              </label>
              <label>
                Reason
                <input
                  required
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                />
              </label>
              <button className="primary full" disabled={busy}>
                Record refund
              </button>
            </form>
          </Modal>
        )}
        {receipt && (
          <Modal title="Training receipt" onClose={() => setReceipt(null)}>
            <div className="receipt-preview" id="pos-receipt">
              <img src="/pos-assets/brand/mithaiwala.webp" alt="" width="60" height="60" />
              <h3>{company}</h3>
              <p>Bur Dubai</p>
              <strong className="receipt-warning">TRAINING — NOT A TAX INVOICE</strong>
              <p>
                {receipt.receiptNumber}
                <br />
                {new Date(receipt.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })}
                <br />
                {serviceLabel(receipt.serviceType)} {receipt.label ? `· ${receipt.label}` : ''}
              </p>
              <hr />
              {receipt.lines.map((l) => (
                <div className="receipt-line" key={l.id}>
                  <span>
                    {l.quantity}
                    {l.unit === 'kg' ? 'g' : ''} × {l.name}
                    {l.note && <small>{l.note}</small>}
                  </span>
                  <span>{formatFils(lineTotalFils(l))}</span>
                </div>
              ))}
              <hr />
              <div className="receipt-line">
                <span>Discount</span>
                <span>{formatFils(receipt.totals.discountFils)}</span>
              </div>
              <div className="receipt-line">
                <span>Included tax (provisional)</span>
                <span>{formatFils(receipt.totals.taxFils)}</span>
              </div>
              <div className="receipt-line">
                <strong>Total AED</strong>
                <strong>{formatFils(receipt.totals.totalFils)}</strong>
              </div>
              {receipt.payment.tenders.map((t) => (
                <div className="receipt-line" key={t.method}>
                  <span>{t.method === 'card' ? 'Card recorded' : 'Cash received'}</span>
                  <span>{formatFils(t.amountFils)}</span>
                </div>
              ))}
              <div className="receipt-line">
                <span>Cash change</span>
                <span>{formatFils(receipt.payment.changeFils)}</span>
              </div>
              <hr />
              <p>
                Saved on this device · Training only
                <br />
                Powered by Internext POS
              </p>
            </div>
            <button
              className="primary full"
              onClick={() => {
                window.print()
                setMessage('Print dialog opened. Check the printer for actual output.')
              }}
            >
              <Printer size={18} /> Print training receipt
            </button>
          </Modal>
        )}
      </main>
    </PosErrorContext.Provider>
  )
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </article>
  )
}
