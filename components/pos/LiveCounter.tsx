'use client'

import '@/lib/pos/browser-abort-signal'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { formatFils, parseMoney } from '@/lib/pos/money'
import { temporaryMenuIllustration } from '@/lib/pos/menu-illustrations'
import { catalogueLineTotals } from '@/lib/pos/server/contracts'
import {
  liveBootstrapSchema,
  liveOrderSchema,
  liveCommandSchema,
  type LiveBootstrap,
  type LiveCommand,
  type LiveOrder,
} from '@/lib/pos/server/live-contracts'
import { fiscalDocumentSchema, type FiscalDocument } from '@/lib/pos/server/documents'
import {
  acknowledgePendingRequest,
  readPendingRequest,
  savePendingRequest,
  type PendingOnlineRequest,
} from '@/lib/pos/online-journal'
import FiscalReceipt from './FiscalReceipt'
import CustomerReceiptLookup from './customer/CustomerReceiptLookup'
import TapChoices from './TapChoices'
import MerchantIdentity from './branding/MerchantIdentity'
import { matchingMerchantBranding } from '@/lib/pos/branding'
import PartialReturnPanel from './returns/PartialReturnPanel'
import KitchenReturnNotices from './KitchenReturnNotices'
import { returnCreditMatchesCommand } from '@/lib/pos/server/returns'
import OfflinePaymentReviews from './offline-payments/OfflinePaymentReviews'
import {
  readPendingPaymentReviews,
  paymentReviewJournalEvent,
  type PendingPaymentReview,
} from './offline-payments/journal'
import CatalogueManager from './CatalogueManager'
import BranchReports from './reports/BranchReports'
import BranchOperations from './operations/BranchOperations'
import OfferManager from './offers/OfferManager'
import OfferPicker from './offers/OfferPicker'
import StaffManager from './staff/StaffManager'
import StaffAccessHelp from './staff/StaffAccessHelp'
import AccountSettings from './staff/AccountSettings'
import PendingAccessRecovery from './staff/PendingAccessRecovery'
import StockManager from './inventory/StockManager'
import PendingStockRecovery from './inventory/PendingStockRecovery'
import KitchenBoard, { KitchenPendingRecovery } from './kitchen/KitchenBoard'
import TabKitchenBoard, { TabKitchenPendingRecovery } from './tab-kitchen/TabKitchenBoard'
import TabKitchenDispatch from './tab-kitchen/TabKitchenDispatch'
import KitchenStationManager from './kitchen-stations/KitchenStationManager'
import StationWorkBoard from './kitchen-stations/StationWorkBoard'
import PendingKitchenStationRecovery from './kitchen-stations/PendingKitchenStationRecovery'
import { useStationCustody } from './kitchen-stations/useStationCustody'
import {
  readPendingTabKitchenRequests,
  tabKitchenJournalEvent,
} from '@/lib/pos/tab-kitchen-journal'
import OpenOrdersBoard from './open-orders/OpenOrdersBoard'
import OpenOrderSave from './open-orders/OpenOrderSave'
import { OpenOrderPendingRecovery } from './open-orders/OpenOrderPendingRecovery'
import { readPendingOpenOrderRequests, openOrderJournalEvent } from '@/lib/pos/open-order-journal'
import type {
  OpenOrderTab,
  OpenOrderTable,
  OpenOrderCommand,
  OpenOrderUpdateResult,
} from '@/lib/pos/server/open-order-contracts'
import { basketFromOpenOrder, openOrderBasketMatches } from '@/lib/pos/open-order-basket'
import { readPendingKitchenRequests, kitchenJournalEvent } from '@/lib/pos/kitchen-journal'
import { tabKitchenTabSchema } from '@/lib/pos/server/tab-kitchen'
import type { OfferSelection, EligibleOfferQuote } from '@/lib/pos/server/offers'
import { invoiceMatchesSale, settlementMatchesSale } from '@/lib/pos/server/sale-ack'
import { counterUpdateReady } from '@/lib/pos/counter-update-readiness'
import type { CounterPortal } from '@/lib/pos/counter-portal'
import { browserUuid } from '@/lib/pos/browser-uuid'

type Product = LiveBootstrap['catalogue'][number]
type BasketLine = { product: Product; quantityMilli: number; modifiers?: string[] }
const modifierOptions = [
  'No sugar',
  'Less sugar',
  'No onion',
  'No chilli',
  'Mild',
  'Extra spicy',
  'Well done',
  'Separate packing',
]
type View =
  | 'sell'
  | 'receipts'
  | 'shift'
  | 'branch'
  | 'menu'
  | 'offers'
  | 'reports'
  | 'staff'
  | 'account'
  | 'kitchen'
  | 'open-orders'
  | 'payment-review'
  | 'operations'
  | 'stock'
  | 'kitchen-stations'
class ApiError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code)
  }
}
const currency = (value: number) => `AED ${formatFils(value)}`
function favouritesStorageKey(userId: string | undefined, branchId: string) {
  return userId && branchId ? `internext-pos:favourites:${userId}:${branchId}` : null
}

function storedFavourites(key: string | null, productIds: string[]) {
  if (!key || typeof window === 'undefined') return []
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]')
    if (!Array.isArray(raw)) return []
    const available = new Set(productIds)
    return Array.from(new Set(raw.filter((value): value is string => typeof value === 'string')))
      .filter((id) => available.has(id))
      .slice(0, 100)
  } catch {
    return []
  }
}

const humanError = (error: unknown) => {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_credentials')
      return 'The email or password is incorrect. Please check and try again.'
    if (error.status === 401)
      return 'Sign in again to continue. Any pending sale is kept on this device.'
    if (error.status === 429)
      return 'Too many attempts. Please wait a few minutes before trying again.'
    if (error.code === 'POS_KITCHEN_DISPATCH_REQUIRED')
      return 'Send the saved changes to the kitchen before payment. Resolve this saved payment request first and reconcile any money collected.'
    if (error.code === 'POS_RETURN_STALE')
      return 'This invoice changed after the preview. Resolve this saved request before checking remaining items and confirming a new return.'
    if (error.code === 'POS_RETURN_QUANTITY' || error.code === 'POS_RETURN_UNAVAILABLE')
      return 'The original quantities or return history could not be verified. Resolve the saved request; do not return money without a confirmed credit note.'
    if (error.code.includes('PRICE') || error.code.includes('PROFILE'))
      return 'The menu or business details changed. This request needs review before you take another payment.'
    if (error.code.includes('OFFER'))
      return 'This offer could not be confirmed. Resolve the saved request, reconcile any payment, then check offers again.'
    if (error.status === 403) return 'This account or device is not authorised for that action.'
    if (error.status === 503) return 'The counter service is not ready. Please retry shortly.'
    return 'The request could not be confirmed. Review the pending request before taking another payment.'
  }
  if (error instanceof Error && error.name === 'ZodError')
    return 'Check the order quantities, payment amounts and required details before continuing.'
  return error instanceof Error ? error.message : 'The connection failed. Please try again.'
}
async function api(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    })
  } catch {
    throw new Error(
      'No server confirmation received. Check your connection and retry the saved request.'
    )
  }
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok)
    throw new ApiError(
      response.status,
      data && typeof data === 'object' && 'code' in data ? String(data.code) : 'request_failed'
    )
  return data
}

export default function LiveCounter({
  offlinePaymentReviewEnabled = false,
  kitchenStationsEnabled = false,
  portal,
}: {
  offlinePaymentReviewEnabled?: boolean
  kitchenStationsEnabled?: boolean
  portal?: CounterPortal
} = {}) {
  const [boot, setBoot] = useState<LiveBootstrap | null>(null)
  const stationCustody = useStationCustody(boot?.userId)
  const [stationEditorBlocked, setStationEditorBlocked] = useState(false)
  const [stationWorkBlocked, setStationWorkBlocked] = useState(false)
  const stationInteractionHeld = stationEditorBlocked || stationWorkBlocked
  const stationHeld = stationCustody.held || stationInteractionHeld
  const [needsLogin, setNeedsLogin] = useState(false)
  const [updateSignedOut, setUpdateSignedOut] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const actorScope = useRef('')
  const actorGeneration = useRef(0)
  const accessShift = useRef('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [online, setOnline] = useState(true)
  const [pending, setPending] = useState<PendingOnlineRequest | null>(null)
  const [reviewPending, setReviewPending] = useState<PendingPaymentReview[]>([])
  const [reviewReady, setReviewReady] = useState(false)
  const [reviewBusy, setReviewBusy] = useState(false)
  const reviewOperations = useRef(new Set<string>())
  const reviewOperation = (scope: string, active: boolean) => {
    if (active) reviewOperations.current.add(scope)
    else reviewOperations.current.delete(scope)
    setReviewBusy(reviewOperations.current.size > 0)
  }
  const reviewHeld = reviewBusy || reviewPending.length > 0 || !reviewReady
  const [tabKitchenPending, setTabKitchenPending] = useState(false)
  const [tabKitchenJournalReady, setTabKitchenJournalReady] = useState(false)
  const [tabKitchenBusy, setTabKitchenBusy] = useState(false)
  const [kitchenPending, setKitchenPending] = useState(false)
  const [kitchenReturnRevision, setKitchenReturnRevision] = useState(0)
  const [kitchenJournalReady, setKitchenJournalReady] = useState(false)
  const [openOrderPending, setOpenOrderPending] = useState(false)
  const [openOrderJournalReady, setOpenOrderJournalReady] = useState(false)
  const [openOrderBusy, setOpenOrderBusy] = useState(false)
  const [stockBusy, setStockBusy] = useState(false)
  const [kitchenPaymentReadiness, setKitchenPaymentReadiness] = useState<{
    key: string
    ready: boolean
  } | null>(null)
  const [sourceTab, setSourceTab] = useState<OpenOrderTab | null>(null)
  const [initialTableId, setInitialTableId] = useState<string | null>(null)
  const [openOrderMetadataDirty, setOpenOrderMetadataDirty] = useState(false)
  const [replacement, setReplacement] = useState<OpenOrderTab | OpenOrderTable | 'new' | null>(null)
  const currentActor = useRef<string | undefined>(undefined)
  currentActor.current = boot?.userId
  const [branchId, setBranchId] = useState('')
  const [view, setView] = useState<View>('sell')
  const [search, setSearch] = useState('')
  const [barcodeInput, setBarcodeInput] = useState('')
  const barcodeInputRef = useRef<HTMLInputElement>(null)
  const [category, setCategory] = useState('All')
  const [favouriteIds, setFavouriteIds] = useState<string[]>([])
  const [favouritesOnly, setFavouritesOnly] = useState(false)
  const [basket, setBasket] = useState<BasketLine[]>([])
  const [serviceType, setServiceType] = useState<LiveOrder['serviceType']>('takeaway')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'split'>('cash')
  const [cashInput, setCashInput] = useState('')
  const [cardInput, setCardInput] = useState('')
  const [chosenOffer, setChosenOffer] = useState<{
    scope: string
    selection: OfferSelection
    quote: EligibleOfferQuote
  } | null>(null)
  const [buyerName, setBuyerName] = useState('')
  const [buyerAddress, setBuyerAddress] = useState('')
  const [buyerTrn, setBuyerTrn] = useState('')
  const [orderNote, setOrderNote] = useState('')
  const invalidBuyerInput = [buyerName, buyerAddress, buyerTrn].some((value) =>
    value.includes('\u0000')
  )
  const [documents, setDocuments] = useState<FiscalDocument[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [selected, setSelected] = useState<FiscalDocument | null>(null)
  const orderRef = useRef<HTMLElement>(null)
  const branch = boot?.branches.find((item) => item.id === branchId)
  const branding = matchingMerchantBranding(
    branch?.branding,
    branch?.profile
      ? {
          organizationId: branch.organizationId,
          branchId: branch.id,
          profileId: branch.profile.id,
        }
      : null
  )
  const shift = boot?.shifts.find(
    (item) => item.deviceId === boot.device?.id && item.openedBy === boot.userId
  )
  const otherShift = boot?.shifts.find(
    (item) => item.deviceId === boot.device?.id && item.openedBy !== boot.userId
  )
  const manager = branch?.role === 'manager' || branch?.role === 'owner'
  const operationsAccess =
    boot?.branches.some((item) => item.role === 'manager' || item.role === 'owner') ?? false
  const pendingCommand =
    pending?.endpoint === '/api/pos/commands' ? liveCommandSchema.safeParse(pending.body) : null
  const pendingReturn =
    pendingCommand?.success &&
    ['refund.full', 'refund.items'].includes(pendingCommand.data.command.type)
  const products = boot?.catalogue.filter((item) => item.branchId === branchId) ?? []
  const favouritesKey = favouritesStorageKey(boot?.userId, branchId)
  const catalogueProductIds = useMemo(
    () =>
      (boot?.catalogue ?? [])
        .filter((product) => product.branchId === branchId)
        .map((product) => product.id),
    [boot?.catalogue, branchId]
  )
  const activeFavouriteIds = favouriteIds.filter((id) => catalogueProductIds.includes(id))
  const visibleProducts = products.filter(
    (item) =>
      (category === 'All' || item.category === category) &&
      (!favouritesOnly || activeFavouriteIds.includes(item.id)) &&
      item.name.toLowerCase().includes(search.toLowerCase().trim())
  )
  const categories = Array.from(new Set(products.map((item) => item.category)))
  const barcodeProduct = (value: string) =>
    products.find((item) => item.barcode?.toLocaleLowerCase() === value.trim().toLocaleLowerCase())

  useEffect(() => {
    setFavouriteIds(storedFavourites(favouritesKey, catalogueProductIds))
    setFavouritesOnly(false)
  }, [favouritesKey, catalogueProductIds])
  const counterLabels: Record<View, string> = {
    sell: 'Sell',
    kitchen: 'Kitchen',
    'kitchen-stations': 'Kitchen stations',
    'open-orders': 'Orders & tables',
    receipts: 'Receipts',
    shift: 'Shift',
    branch: 'Branch',
    menu: 'Menu',
    stock: 'Stock',
    offers: 'Offers',
    reports: 'Reports',
    staff: 'Staff',
    account: 'Account',
    'payment-review': 'Payment review',
    operations: 'Operations',
  }
  const primaryCounterViews: View[] = ['sell', 'kitchen', 'open-orders', 'receipts']
  const secondaryCounterViews: View[] = [
    'shift',
    ...(operationsAccess ? ['operations' as View] : []),
    ...(manager
      ? [
          'menu' as View,
          'stock' as View,
          ...(kitchenStationsEnabled ? ['kitchen-stations' as View] : []),
          'offers' as View,
          'reports' as View,
          'staff' as View,
          ...(offlinePaymentReviewEnabled ? ['payment-review' as View] : []),
        ]
      : []),
    'branch',
    'account',
  ]
  const beforeDiscount = basket.reduce(
    (sum, line) =>
      sum +
      catalogueLineTotals(line.product.unitPriceFils, line.quantityMilli, line.product.taxRateBps)
        .grossFils,
    0
  )
  const originalTax = basket.reduce(
    (sum, line) =>
      sum +
      catalogueLineTotals(line.product.unitPriceFils, line.quantityMilli, line.product.taxRateBps)
        .taxFils,
    0
  )
  const offerLines = useMemo(
    () =>
      basket.map(({ product, quantityMilli }) => ({
        productId: product.id,
        quantityMilli,
        expectedUnitPriceFils: product.unitPriceFils,
        expectedTaxRateBps: product.taxRateBps,
        expectedRevision: product.revision,
      })),
    [basket]
  )
  const saleLines = useMemo(
    () =>
      basket.map(({ product, quantityMilli, modifiers }) => ({
        productId: product.id,
        quantityMilli,
        expectedUnitPriceFils: product.unitPriceFils,
        expectedTaxRateBps: product.taxRateBps,
        expectedRevision: product.revision,
        ...(modifiers?.length ? { modifiers } : {}),
      })),
    [basket]
  )
  const savedBasketMatches = sourceTab
    ? openOrderBasketMatches(sourceTab, serviceType, offerLines)
    : false
  const requiresOrderSave =
    openOrderMetadataDirty || !!initialTableId || (!!sourceTab && !savedBasketMatches)
  const basketLocked =
    stationHeld ||
    reviewHeld ||
    busy ||
    !!pending ||
    openOrderBusy ||
    openOrderPending ||
    !openOrderJournalReady ||
    tabKitchenBusy ||
    tabKitchenPending ||
    !tabKitchenJournalReady
  const offerScope = JSON.stringify({ branchId, serviceType, lines: offerLines })
  const activeOffer = chosenOffer?.scope === offerScope ? chosenOffer : null
  const total = activeOffer?.quote.grossFils ?? beforeDiscount
  const tax = activeOffer?.quote.taxFils ?? originalTax
  const chooseOffer = useCallback(
    (selection: OfferSelection | null, quote: EligibleOfferQuote | null) => {
      setChosenOffer(selection && quote ? { scope: offerScope, selection, quote } : null)
      setCashInput('')
      setCardInput('')
    },
    [offerScope]
  )
  const kitchenPaymentKey = sourceTab ? `${branchId}:${sourceTab.id}:${sourceTab.revision}` : null
  const kitchenPaymentReady =
    !sourceTab ||
    (kitchenPaymentReadiness?.key === kitchenPaymentKey && kitchenPaymentReadiness.ready)
  const mayWrite = !!(
    boot?.capabilities.onlineSales &&
    branch?.canSell &&
    online &&
    boot.device &&
    !busy &&
    !stationHeld &&
    !reviewHeld &&
    !pending &&
    !tabKitchenBusy &&
    !tabKitchenPending &&
    tabKitchenJournalReady &&
    !openOrderBusy &&
    !openOrderPending &&
    openOrderJournalReady &&
    branch?.profile
  )

  const checkReviewPending = useCallback(async (actorId: string) => {
    const records = await readPendingPaymentReviews(actorId)
    if (currentActor.current === actorId) {
      setReviewPending(records)
      setReviewReady(true)
    }
    return records
  }, [])
  useEffect(() => {
    if (!boot?.userId) return
    setReviewReady(false)
    const actorId = boot.userId
    let alive = true
    const check = () => {
      void readPendingPaymentReviews(actorId)
        .then((records) => {
          if (alive) {
            setReviewPending(records)
            setReviewReady(true)
          }
        })
        .catch(() => {
          if (alive) setReviewReady(false)
        })
    }
    check()
    window.addEventListener(paymentReviewJournalEvent, check)
    window.addEventListener('focus', check)
    let channel: BroadcastChannel | null = null
    try {
      channel = new BroadcastChannel(paymentReviewJournalEvent)
      channel.onmessage = check
    } catch {
      /* Focus read remains available. */
    }
    return () => {
      alive = false
      window.removeEventListener(paymentReviewJournalEvent, check)
      window.removeEventListener('focus', check)
      channel?.close()
    }
  }, [boot?.userId])

  const checkTabKitchenPending = useCallback(async (actorId: string) => {
    const requests = await readPendingTabKitchenRequests(actorId)
    if (currentActor.current === actorId) {
      setTabKitchenPending(requests.length > 0)
      setTabKitchenJournalReady(true)
    }
    return requests
  }, [])
  useEffect(() => {
    if (!boot?.userId) {
      setTabKitchenJournalReady(false)
      return
    }
    const actorId = boot.userId
    let alive = true
    const check = () => {
      void readPendingTabKitchenRequests(actorId)
        .then((requests) => {
          if (!alive) return
          setTabKitchenPending(requests.length > 0)
          setTabKitchenJournalReady(true)
        })
        .catch(() => {
          if (!alive) return
          setTabKitchenJournalReady(false)
        })
    }
    check()
    window.addEventListener(tabKitchenJournalEvent, check)
    window.addEventListener('focus', check)
    let channel: BroadcastChannel | null = null
    try {
      if (typeof BroadcastChannel !== 'undefined')
        channel = new BroadcastChannel(tabKitchenJournalEvent)
    } catch {
      /* Focus and same-tab events still reconcile persistent work. */
    }
    if (channel) channel.onmessage = check
    return () => {
      alive = false
      window.removeEventListener(tabKitchenJournalEvent, check)
      window.removeEventListener('focus', check)
      channel?.close()
    }
  }, [boot?.userId])

  const checkKitchenPending = useCallback(async (actorId: string) => {
    const requests = await readPendingKitchenRequests(actorId)
    if (currentActor.current === actorId) {
      setKitchenPending(requests.length > 0)
      setKitchenJournalReady(true)
    }
    return requests
  }, [])
  useEffect(() => {
    if (!boot?.userId) {
      setKitchenJournalReady(false)
      return
    }
    const actorId = boot.userId
    let alive = true
    const check = () => {
      void readPendingKitchenRequests(actorId)
        .then((requests) => {
          if (!alive) return
          setKitchenPending(requests.length > 0)
          setKitchenJournalReady(true)
        })
        .catch(() => {
          if (!alive) return
          setKitchenJournalReady(false)
        })
    }
    check()
    window.addEventListener(kitchenJournalEvent, check)
    window.addEventListener('focus', check)
    let channel: BroadcastChannel | null = null
    try {
      if (typeof BroadcastChannel !== 'undefined')
        channel = new BroadcastChannel(kitchenJournalEvent)
    } catch {
      /* Focus and same-tab events still reconcile persistent work. */
    }
    if (channel) channel.onmessage = check
    return () => {
      alive = false
      window.removeEventListener(kitchenJournalEvent, check)
      window.removeEventListener('focus', check)
      channel?.close()
    }
  }, [boot?.userId])

  const checkOpenOrderPending = useCallback(async (actorId: string) => {
    const requests = await readPendingOpenOrderRequests(actorId)
    if (currentActor.current === actorId) {
      setOpenOrderPending(requests.length > 0)
      setOpenOrderJournalReady(true)
    }
    return requests
  }, [])
  useEffect(() => {
    if (!boot?.userId) {
      setOpenOrderJournalReady(false)
      return
    }
    const actorId = boot.userId
    let alive = true
    const check = () => {
      void readPendingOpenOrderRequests(actorId)
        .then((requests) => {
          if (!alive) return
          setOpenOrderPending(requests.length > 0)
          setOpenOrderJournalReady(true)
        })
        .catch(() => {
          if (!alive) return
          setOpenOrderJournalReady(false)
        })
    }
    check()
    window.addEventListener(openOrderJournalEvent, check)
    window.addEventListener('focus', check)
    let channel: BroadcastChannel | null = null
    try {
      if (typeof BroadcastChannel !== 'undefined')
        channel = new BroadcastChannel(openOrderJournalEvent)
    } catch {
      /* Focus and same-tab events still reconcile persistent work. */
    }
    if (channel) channel.onmessage = check
    return () => {
      alive = false
      window.removeEventListener(openOrderJournalEvent, check)
      window.removeEventListener('focus', check)
      channel?.close()
    }
  }, [boot?.userId])

  const refresh = useCallback(async () => {
    const endpoint = portal
      ? `/api/pos/bootstrap?portal=${encodeURIComponent(portal.slug)}`
      : '/api/pos/bootstrap'
    const next = liveBootstrapSchema.parse(await api(endpoint))
    const journal = await readPendingRequest(next.userId)
    const scope = `${next.userId}:${next.device?.id ?? ''}:${next.device?.branchId ?? ''}`
    const nextShift =
      next.shifts.find((item) => item.deviceId === next.device?.id && item.openedBy === next.userId)
        ?.id ?? ''
    if (actorScope.current !== scope || accessShift.current !== nextShift) actorGeneration.current++
    accessShift.current = nextShift
    if (actorScope.current !== scope) {
      setDocuments([])
      setNextCursor(null)
      setSelected(null)
      setBasket([])
      setSourceTab(null)
      setInitialTableId(null)
      setOpenOrderMetadataDirty(false)
      setChosenOffer(null)
      setCashInput('')
      setCardInput('')
      setBuyerName('')
      setBuyerAddress('')
      setBuyerTrn('')
      setOrderNote('')
      setSearch('')
      setBarcodeInput('')
      setCategory('All')
      setView('sell')
      setServiceType('takeaway')
      setPaymentMethod('cash')
      setNotice('')
      actorScope.current = scope
    }
    setBoot(next)
    setUpdateSignedOut(false)
    setNeedsLogin(false)
    setPending(journal)
    setBranchId(
      (current) =>
        next.device?.branchId ??
        (next.branches.some((item) => item.id === current) ? current : (next.branches[0]?.id ?? ''))
    )
    return next
  }, [portal])
  const loadDocuments = useCallback(async (id: string, cursor?: string) => {
    const scope = actorScope.current
    const data = await api(
      `/api/pos/receipts?branchId=${encodeURIComponent(id)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    )
    if (scope !== actorScope.current) return
    if (!data || typeof data !== 'object' || !('receipts' in data) || !Array.isArray(data.receipts))
      throw new Error('Could not verify the receipt list.')
    const rows = data.receipts.map((value) => fiscalDocumentSchema.parse(value))
    setDocuments((current) =>
      cursor
        ? [...current, ...rows.filter((row) => !current.some((item) => item.id === row.id))]
        : rows
    )
    setNextCursor(
      'nextCursor' in data && typeof data.nextCursor === 'string' ? data.nextCursor : null
    )
  }, [])
  useEffect(() => {
    refresh()
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) setNeedsLogin(true)
        else setError(humanError(err))
      })
      .finally(() => setLoading(false))
    const connection = () => setOnline(navigator.onLine)
    connection()
    window.addEventListener('online', connection)
    window.addEventListener('offline', connection)
    return () => {
      window.removeEventListener('online', connection)
      window.removeEventListener('offline', connection)
    }
  }, [refresh])
  useEffect(() => {
    if (view === 'receipts' && branchId && !needsLogin)
      loadDocuments(branchId).catch((err) => setError(humanError(err)))
  }, [view, branchId, needsLogin, loadDocuments])
  useEffect(() => {
    if (!pending && !openOrderPending && !basket.length && !sourceTab) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pending, openOrderPending, basket.length, sourceTab])
  const run = async (action: () => Promise<void>) => {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (err) {
      setError(humanError(err))
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true)
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  async function dispatch(request: PendingOnlineRequest) {
    if (
      !boot ||
      request.actorId !== boot.userId ||
      request.deviceId !== boot.device?.id ||
      request.branchId !== boot.device.branchId
    )
      throw new Error('Sign in on the original enrolled counter to recover this request.')
    const context = { scope: actorScope.current, generation: actorGeneration.current }
    const result = await api(request.endpoint, 'POST', request.body)
    await confirmRequest(request, result, context)
  }
  async function recover(request: PendingOnlineRequest) {
    if (!boot || request.actorId !== boot.userId)
      throw new Error('Use the original account and browser to resolve this request.')
    const context = { scope: actorScope.current, generation: actorGeneration.current }
    const kind = request.endpoint === '/api/pos/sync' ? 'sale' : 'command'
    const original =
      kind === 'sale'
        ? liveOrderSchema.parse(request.body).order
        : liveCommandSchema.parse(request.body).command
    const result = await api('/api/pos/recovery', 'POST', { kind, request: original })
    if (
      result &&
      typeof result === 'object' &&
      'status' in result &&
      result.status === 'cancelled'
    ) {
      if (
        !('requestId' in result) ||
        result.requestId !== request.id ||
        !('kind' in result) ||
        result.kind !== kind
      )
        throw new Error('Cancellation did not match the saved request.')
      await acknowledgePendingRequest(request.actorId, request.id)
      if (context.scope !== actorScope.current || context.generation !== actorGeneration.current)
        return
      setPending(null)
      setBasket([])
      setSourceTab(null)
      setInitialTableId(null)
      setOpenOrderMetadataDirty(false)
      setChosenOffer(null)
      setCashInput('')
      setCardInput('')
      setSelected(null)
      setNotice(
        kind === 'command' &&
          'type' in original &&
          ['refund.full', 'refund.items'].includes(original.type)
          ? 'The server confirmed this return was not recorded and has permanently cancelled it. Check any money already returned before starting another return.'
          : 'The server confirmed this request was not recorded and has permanently cancelled it. Reconcile any money already collected before starting another sale.'
      )
      await refresh()
      return
    }
    await confirmRequest(request, result, context)
  }
  async function confirmRequest(
    request: PendingOnlineRequest,
    result: unknown,
    context: { scope: string; generation: number }
  ) {
    if (!result || typeof result !== 'object')
      throw new Error('The server response could not be verified. Retry the saved request.')
    let receipt: FiscalDocument | null = null
    if (request.endpoint === '/api/pos/sync') {
      if (
        !('status' in result) ||
        result.status !== 'synced' ||
        !('orderId' in result) ||
        result.orderId !== request.id ||
        !('receipt' in result)
      )
        throw new Error('Sale confirmation did not match. Keep this request for recovery.')
      receipt = fiscalDocumentSchema.parse(result.receipt)
      if (receipt.kind !== 'tax_invoice' || receipt.orderId !== request.id)
        throw new Error('Invoice confirmation did not match the saved sale.')
      const input = liveOrderSchema.parse(request.body).order
      if (!invoiceMatchesSale(input, receipt) || !settlementMatchesSale(input, result))
        throw new Error('Invoice amounts did not match the saved sale.')
    } else {
      if (
        !('status' in result) ||
        result.status !== 'applied' ||
        !('commandId' in result) ||
        result.commandId !== request.id
      )
        throw new Error('Action confirmation did not match. Keep this request for recovery.')
      if ('creditNote' in result) receipt = fiscalDocumentSchema.parse(result.creditNote)
      const input = liveCommandSchema.parse(request.body).command
      if (
        input.type === 'refund.full' &&
        (!receipt || receipt.kind !== 'tax_credit_note' || receipt.orderId !== input.orderId)
      )
        throw new Error('The credit note did not match the saved refund request.')
      if (
        input.type === 'refund.items' &&
        !returnCreditMatchesCommand(input, receipt, request.actorId)
      )
        throw new Error(
          'The item return did not match its exact saved preview. Keep this request for recovery.'
        )
    }
    if (
      receipt &&
      (receipt.branchId !== request.branchId ||
        receipt.deviceId !== request.deviceId ||
        receipt.actorId !== request.actorId)
    )
      throw new Error(
        'Document identity did not match this counter. Keep the saved request for review.'
      )
    await acknowledgePendingRequest(request.actorId, request.id)
    // The immutable original journal may be acknowledged after a scope change, but
    // its receipt and success state must never replace the current actor's UI.
    if (context.scope !== actorScope.current || context.generation !== actorGeneration.current)
      return
    setPending(null)
    if (request.endpoint === '/api/pos/sync') {
      setBasket([])
      setSourceTab(null)
      setInitialTableId(null)
      setOpenOrderMetadataDirty(false)
      setChosenOffer(null)
      setCashInput('')
      setCardInput('')
      setBuyerName('')
      setBuyerAddress('')
      setBuyerTrn('')
      setOrderNote('')
    }
    setNotice(
      receipt
        ? `${receipt.documentNumber} saved on the server.`
        : 'Counter action saved on the server.'
    )
    if (receipt) {
      setSelected(receipt)
      setView('receipts')
    }
    if ('cashDifferenceFils' in result && typeof result.cashDifferenceFils === 'number')
      setNotice(`Shift closed. Cash difference: ${currency(result.cashDifferenceFils)}.`)
    await refresh()
    if (receipt) await loadDocuments(request.branchId)
  }
  async function queue(endpoint: PendingOnlineRequest['endpoint'], id: string, body: unknown) {
    if (
      !boot ||
      !boot.device ||
      !branch?.profile ||
      !online ||
      !boot.capabilities.onlineSales ||
      !branch.canSell
    )
      throw new Error('An active enrolled counter and an internet connection are required.')
    const validated =
      endpoint === '/api/pos/sync' ? liveOrderSchema.parse(body) : liveCommandSchema.parse(body)
    const request = {
      actorId: boot.userId,
      deviceId: boot.device.id,
      branchId,
      id,
      endpoint,
      body: validated,
      savedAt: new Date().toISOString(),
    }
    try {
      await savePendingRequest(request)
    } catch (err) {
      setPending(await readPendingRequest(boot.userId))
      throw err
    }
    setPending(request)
    await dispatch(request)
  }
  const command = async (value: LiveCommand) =>
    queue('/api/pos/commands', value.id, { command: value })
  const checkout = () =>
    run(async () => {
      if (
        openOrderBusy ||
        !openOrderJournalReady ||
        (boot && (await checkOpenOrderPending(boot.userId)).length)
      )
        throw new Error('Resolve the saved unpaid-order change before taking payment.')
      if (reviewBusy || !reviewReady || (boot && (await checkReviewPending(boot.userId)).length))
        throw new Error('Check the saved manager decision before taking payment.')
      if (
        tabKitchenBusy ||
        !tabKitchenJournalReady ||
        (boot && (await checkTabKitchenPending(boot.userId)).length)
      )
        throw new Error('Resolve the saved kitchen dispatch before taking payment.')
      if (requiresOrderSave)
        throw new Error('Save your unpaid order changes before taking payment.')
      if (!boot?.device || !branch?.profile || !shift || !basket.length || total <= 0)
        throw new Error('Open your shift and add an item first.')
      if (sourceTab) {
        const detail = tabKitchenTabSchema.parse(
          await api(
            `/api/pos/tab-kitchen?branchId=${branchId}&deviceId=${boot.device.id}&tabId=${sourceTab.id}`
          )
        )
        if (
          detail.branchId !== branchId ||
          detail.tabId !== sourceTab.id ||
          detail.tabRevision !== sourceTab.revision
        )
          throw new Error(
            'This saved order changed. Reopen it and review the items before payment.'
          )
        if (detail.dispatchRequired)
          throw new Error('Send the saved changes to the kitchen before taking payment.')
      }
      if (
        basket.some(
          (line) =>
            !Number.isInteger(line.quantityMilli) ||
            line.quantityMilli <= 0 ||
            (line.product.unit !== 'kg' && line.quantityMilli % 1000 !== 0)
        )
      )
        throw new Error('Enter whole pieces or whole grams for every item.')
      const card =
        paymentMethod === 'card' ? total : paymentMethod === 'split' ? parseMoney(cardInput) : 0
      const cashApplied = total - card
      if (
        card < 0 ||
        card > total ||
        (paymentMethod === 'split' && (card === 0 || cashApplied === 0))
      )
        throw new Error('Split payment needs a positive cash and card amount.')
      const cashTenderedFils = cashApplied
        ? parseMoney(cashInput || formatFils(cashApplied).replaceAll(',', ''))
        : 0
      if (cashTenderedFils < cashApplied)
        throw new Error('Cash received is less than the amount due.')
      if (invalidBuyerInput)
        throw new Error(
          'Customer details contain an unsupported hidden character. Remove it or retype the affected field before taking payment.'
        )
      const hasCustomer = !!(buyerName.trim() || buyerAddress.trim() || buyerTrn.trim())
      if (hasCustomer && (!buyerName.trim() || !buyerAddress.trim()))
        throw new Error('Enter the customer name and address, or leave all customer fields blank.')
      if (buyerTrn.trim() && !/^\d{15}$/.test(buyerTrn.trim()))
        throw new Error('Customer TRN must have 15 digits.')
      if (total > 1_000_000 && !hasCustomer)
        throw new Error('Customer name and address are required above AED 10,000.')
      if (orderNote.includes('\u0000'))
        throw new Error(
          'Order note contains an unsupported hidden character. Retype it before payment.'
        )
      if (sourceTab && orderNote.trim())
        throw new Error(
          'Save this kitchen instruction with the unpaid order before taking payment.'
        )
      const order: LiveOrder = {
        id: browserUuid(),
        branchId,
        deviceId: boot.device.id,
        shiftId: shift.id,
        createdAt: new Date().toISOString(),
        serviceType,
        profileId: branch.profile.id,
        ...(orderNote.trim() ? { orderNote: orderNote.trim() } : {}),
        customer: hasCustomer
          ? { name: buyerName.trim(), address: buyerAddress.trim(), trn: buyerTrn.trim() || null }
          : null,
        cashTenderedFils,
        expectedTotalFils: total,
        lines: saleLines,
        ...(activeOffer ? { offerSelection: activeOffer.selection } : {}),
        ...(sourceTab
          ? { sourceTab: { id: sourceTab.id, expectedRevision: sourceTab.revision } }
          : {}),
        payments: [
          ...(cashApplied ? [{ method: 'cash' as const, amountFils: cashApplied }] : []),
          ...(card ? [{ method: 'card' as const, amountFils: card }] : []),
        ],
      }
      await queue('/api/pos/sync', order.id, { order })
    })
  function add(product: Product) {
    if (basketLocked) return
    setBasket((current) => {
      const found = current.find((line) => line.product.id === product.id)
      return found
        ? current.map((line) =>
            line.product.id === product.id
              ? {
                  ...line,
                  quantityMilli: Math.min(
                    1_000_000,
                    line.quantityMilli + (product.unit === 'kg' ? 250 : 1000)
                  ),
                }
              : line
          )
        : [...current, { product, quantityMilli: product.unit === 'kg' ? 250 : 1000 }]
    })
  }
  function scanBarcode() {
    const value = barcodeInput.trim()
    if (!value || basketLocked) return
    const product = barcodeProduct(value)
    if (!product) {
      setError(
        'No available item has that barcode or PLU. Check the barcode in Menu before trying again.'
      )
      return
    }
    add(product)
    setBarcodeInput('')
    setError('')
    setNotice(`${product.name} added from barcode.`)
    window.setTimeout(() => barcodeInputRef.current?.focus(), 0)
  }
  function toggleModifier(productId: string, modifier: string) {
    if (basketLocked || sourceTab || initialTableId) return
    setBasket((current) =>
      current.map((line) => {
        if (line.product.id !== productId) return line
        const currentModifiers = line.modifiers ?? []
        const modifiers = currentModifiers.includes(modifier)
          ? currentModifiers.filter((value) => value !== modifier)
          : [...currentModifiers, modifier]
        return { ...line, ...(modifiers.length ? { modifiers } : { modifiers: undefined }) }
      })
    )
  }
  function toggleFavourite(productId: string) {
    if (!favouritesKey) return
    const next = activeFavouriteIds.includes(productId)
      ? activeFavouriteIds.filter((id) => id !== productId)
      : [...activeFavouriteIds, productId]
    try {
      window.localStorage.setItem(favouritesKey, JSON.stringify(next))
      setFavouriteIds(next)
    } catch {
      setError('This browser could not save favourites. Your order has not changed.')
    }
  }
  function resolvedOpenOrderElsewhere(
    command: OpenOrderCommand,
    result: OpenOrderUpdateResult | { status: 'cancelled' }
  ) {
    if (command.branchId !== branchId || result.status !== 'updated' || !('tab' in result)) return
    if (command.type === 'tab.save' || command.type === 'tab.reopen') {
      setSourceTab(result.tab)
      setBasket(basketFromOpenOrder(result.tab))
      setServiceType(result.tab.serviceType)
      setInitialTableId(null)
      setOpenOrderMetadataDirty(false)
      setChosenOffer(null)
      setCashInput('')
      setCardInput('')
      setNotice('Saved order confirmed. Its basket is ready to review at the counter.')
    } else if (command.type === 'tab.void' && sourceTab?.id === command.tabId) {
      setBasket([])
      setSourceTab(null)
      setInitialTableId(null)
      setOpenOrderMetadataDirty(false)
      setChosenOffer(null)
      setCashInput('')
      setCardInput('')
      setBuyerName('')
      setBuyerAddress('')
      setBuyerTrn('')
      setOrderNote('')
      setNotice('The unpaid order was voided. Its counter basket has been cleared.')
    }
  }
  function replaceBasket(selection: OpenOrderTab | OpenOrderTable | 'new') {
    if (basketLocked) return
    setReplacement(null)
    setChosenOffer(null)
    setCashInput('')
    setCardInput('')
    setBuyerName('')
    setBuyerAddress('')
    setBuyerTrn('')
    setOrderNote('')
    setOpenOrderMetadataDirty(false)
    if (selection !== 'new' && 'status' in selection) {
      if (
        selection.branchId !== branchId ||
        selection.status === 'settled' ||
        (selection.status === 'voided' && !manager)
      )
        return
      setSourceTab(selection)
      setInitialTableId(null)
      setBasket(basketFromOpenOrder(selection))
      setServiceType(selection.serviceType)
    } else {
      setSourceTab(null)
      setInitialTableId(selection === 'new' ? null : selection.id)
      setBasket([])
      setServiceType(selection === 'new' ? 'takeaway' : 'dine_in')
    }
    setView('sell')
  }
  function requestBasket(selection: OpenOrderTab | OpenOrderTable | 'new') {
    if (basketLocked) return
    if (basket.length || sourceTab || initialTableId || openOrderMetadataDirty)
      setReplacement(selection)
    else replaceBasket(selection)
  }
  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    void run(async () => {
      await api('/api/pos/session', 'POST', {
        email: String(values.get('email')).trim(),
        password: String(values.get('password')),
      })
      form.reset()
      await refresh()
      setNeedsLogin(false)
    })
  }
  const updateReady = counterUpdateReady({
    loading,
    online,
    needsLogin,
    authenticated: !!boot,
    hasSessionHistory: actorScope.current !== '',
    guardedSignedOut: updateSignedOut,
    busy:
      busy ||
      locked.current ||
      stockBusy ||
      reviewBusy ||
      openOrderBusy ||
      tabKitchenBusy ||
      stationInteractionHeld,
    knownPending:
      !!pending ||
      reviewPending.length > 0 ||
      tabKitchenPending ||
      kitchenPending ||
      openOrderPending ||
      stationCustody.configuration ||
      stationCustody.work,
    unsavedWork:
      basket.length > 0 ||
      !!sourceTab ||
      !!initialTableId ||
      openOrderMetadataDirty ||
      !!replacement ||
      !!chosenOffer ||
      !!cashInput ||
      !!cardInput ||
      !!buyerName ||
      !!buyerAddress ||
      !!buyerTrn,
    idleCounter: view === 'sell',
    checksReady:
      reviewReady &&
      tabKitchenJournalReady &&
      kitchenJournalReady &&
      openOrderJournalReady &&
      stationCustody.ready,
    shiftOpen: !!shift || !!otherShift,
  })
  if (loading)
    return (
      <main className="lc-app lc-centre" data-counter-update-ready="false">
        <p role="status">Opening your counter…</p>
      </main>
    )
  if (needsLogin)
    return (
      <main className="lc-app lc-centre" data-counter-update-ready={String(updateReady)}>
        <form className="lc-login" onSubmit={login}>
          {portal ? (
            <span className="lc-wordmark">{portal.displayName}</span>
          ) : (
            <Link href="/" className="lc-wordmark">
              Internext <strong>POS</strong>
            </Link>
          )}
          <span className="lc-eyebrow">Staff access</span>
          <h1>Your counter starts here.</h1>
          <p>Sign in with the account assigned to your restaurant.</p>
          <label>
            Email
            <input name="email" type="email" autoComplete="username" maxLength={254} required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={128}
              required
            />
          </label>
          {error && (
            <p role="alert" className="lc-error">
              {error}
            </p>
          )}
          <button className="lc-primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <Link href="/pos">Open the separate training workspace</Link>
          <StaffAccessHelp />
        </form>
      </main>
    )
  if (!boot)
    return (
      <main className="lc-app lc-centre" data-counter-update-ready="false">
        <section className="lc-login">
          <h1>Counter setup</h1>
          <p role="alert">{error || 'The account service is not ready yet.'}</p>
          <PendingAccessRecovery />
          <PendingStockRecovery disabled={busy || !online} />
          <PendingKitchenStationRecovery disabled={busy || !online} />
          <KitchenPendingRecovery disabled={busy || !online} />
          <TabKitchenPendingRecovery disabled={busy || !online} />
          <OpenOrderPendingRecovery disabled={busy || !online} />
          <button
            onClick={() =>
              void run(async () => {
                await refresh()
              })
            }
            disabled={busy}
          >
            Check again
          </button>
          <Link href="/">Back to website</Link>
        </section>
      </main>
    )
  return (
    <div
      className="lc-app"
      data-merchant-theme={branding?.theme}
      data-counter-update-ready={String(updateReady)}
    >
      <header className="lc-top lc-noprint">
        <Link
          href={portal ? `/${portal.slug}` : '/'}
          className={branding ? 'lc-merchant-identity' : 'lc-wordmark'}
        >
          <MerchantIdentity branding={branding} />
        </Link>
        <div>
          <strong>{branch?.name || 'Your restaurant'}</strong>
          <span className={online ? 'lc-online' : 'lc-offline'}>
            {online ? 'Connected' : 'Offline · sales paused'}
          </span>
        </div>
        <button
          disabled={
            busy ||
            stockBusy ||
            stationHeld ||
            !!pending ||
            reviewHeld ||
            tabKitchenBusy ||
            tabKitchenPending ||
            !tabKitchenJournalReady ||
            kitchenPending ||
            !kitchenJournalReady ||
            openOrderPending ||
            !openOrderJournalReady ||
            openOrderBusy
          }
          onClick={() =>
            void run(async () => {
              if (stationInteractionHeld || (await stationCustody.check()))
                throw new Error('Resolve or finish the kitchen station change before signing out.')
              if (await readPendingRequest(boot.userId))
                throw new Error('Recover the pending request before signing out.')
              if (reviewBusy || (await checkReviewPending(boot.userId)).length)
                throw new Error(
                  'Check the saved manager decision before changing account or counter access.'
                )
              if ((await checkTabKitchenPending(boot.userId)).length)
                throw new Error(
                  'Resolve the saved kitchen dispatch before changing account or counter access.'
                )
              if ((await checkKitchenPending(boot.userId)).length)
                throw new Error('Resolve the saved kitchen change before signing out.')
              if ((await checkOpenOrderPending(boot.userId)).length)
                throw new Error('Resolve the saved unpaid-order change before signing out.')
              if (
                (basket.length || openOrderMetadataDirty) &&
                (!sourceTab || !savedBasketMatches || openOrderMetadataDirty)
              )
                throw new Error('Save or clear the current basket before signing out.')
              await api('/api/pos/session', 'DELETE')
              setBoot(null)
              setDocuments([])
              setSelected(null)
              setBasket([])
              setSourceTab(null)
              setInitialTableId(null)
              setOpenOrderMetadataDirty(false)
              setChosenOffer(null)
              setUpdateSignedOut(true)
              setNeedsLogin(true)
            })
          }
        >
          Sign out
        </button>
      </header>
      <div className="lc-status lc-noprint">
        <PendingStockRecovery
          actorId={boot.userId}
          excludeBranchId={view === 'stock' && manager && boot.device ? branchId : undefined}
          excludeDeviceId={view === 'stock' && manager && boot.device ? boot.device.id : undefined}
          disabled={busy || !online || stockBusy}
        />
        {(!boot.capabilities.onlineSales || !branch?.canSell) && (
          <p className="lc-warning">
            Your account is ready. Live counter activation is still pending; no real sale can be
            saved yet.
          </p>
        )}
        {!online && (
          <p className="lc-warning">
            Reconnect before taking another payment. This web counter requires server confirmation.
          </p>
        )}
        {error && (
          <p className="lc-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="lc-success" role="status">
            {notice}
          </p>
        )}
        {pending && (
          <section className="lc-warning" aria-label="Pending request">
            <strong>A request needs confirmation</strong>
            <p>
              {pendingReturn
                ? 'Do not return money without the confirmed credit note. Retry checks the exact saved return and cannot create a second credit for it.'
                : 'Do not take this payment again. Retry checks the same saved request and cannot issue a second invoice for it.'}
            </p>
            <small>Reference: {pending.id}</small>
            <button disabled={busy || !online} onClick={() => void run(() => dispatch(pending))}>
              {busy ? 'Checking…' : 'Recover saved request'}
            </button>
            <details>
              <summary>Resolve a rejected request</summary>
              <p>
                This checks the server first. If already recorded, its confirmation is restored.
                Otherwise the request is permanently cancelled.{' '}
                {pendingReturn
                  ? 'Check any money already returned before starting another return.'
                  : 'Reconcile any payment already collected before starting another sale.'}
              </p>
              <button disabled={busy || !online} onClick={() => void run(() => recover(pending))}>
                Resolve or cancel unsaved request
              </button>
            </details>
          </section>
        )}
        {!stationCustody.ready && (
          <section className="lc-warning" aria-label="Checking saved station work">
            <p>
              Saved kitchen station changes could not yet be checked. Account changes and counter
              registration are paused.
            </p>
            <button
              disabled={busy || stationInteractionHeld}
              onClick={() => void stationCustody.check().catch(() => undefined)}
            >
              Check saved station changes
            </button>
          </section>
        )}
        {(stationCustody.configuration || stationCustody.work) && (
          <PendingKitchenStationRecovery
            actorId={boot.userId}
            excludeConfigurationBranchId={
              kitchenStationsEnabled && view === 'kitchen-stations' && manager && boot.device
                ? branchId
                : undefined
            }
            excludeWorkBranchId={
              kitchenStationsEnabled && view === 'kitchen' && boot.device ? branchId : undefined
            }
            disabled={busy || !online || reviewBusy || openOrderBusy || tabKitchenBusy}
          />
        )}
        {!reviewReady && (
          <p className="lc-warning">
            Checking saved manager decisions. Account changes and payments are paused until they can
            be checked.
          </p>
        )}
        {reviewPending.map(
          (record) =>
            (view !== 'payment-review' || record.branchId !== branchId || !boot.device) && (
              <section key={`${record.actorId}:${record.branchId}`} className="lc-warning">
                <h2>A manager decision needs confirmation</h2>
                <p>
                  Do not repeat the external return or void. Check the original saved decision
                  before changing account or counter access.
                </p>
                <OfflinePaymentReviews
                  actorId={boot.userId}
                  branchId={record.branchId}
                  branchName={
                    boot.branches.find((item) => item.id === record.branchId)?.name ??
                    'Original branch'
                  }
                  allowDecisions={offlinePaymentReviewEnabled}
                  disabled={busy || !online || openOrderBusy || tabKitchenBusy}
                  onBusyChange={(active) => reviewOperation(record.branchId, active)}
                  onPendingChange={() => {
                    void checkReviewPending(boot.userId).catch(() => setReviewReady(false))
                  }}
                />
              </section>
            )
        )}
        {replacement && (
          <section className="lc-warning" aria-label="Replace current basket">
            <h2>Replace the current basket?</h2>
            <p>
              Saved orders remain available in Orders &amp; tables. Unsaved basket changes, customer
              details and payment entries will be cleared.
            </p>
            <button disabled={basketLocked} onClick={() => replaceBasket(replacement)}>
              Replace basket
            </button>
            <button onClick={() => setReplacement(null)}>Keep current basket</button>
          </section>
        )}
        {openOrderPending && view !== 'sell' && view !== 'open-orders' && boot.device && (
          <section className="lc-warning">
            <p>An unpaid-order change needs confirmation.</p>
            <button onClick={() => setView('sell')}>Review saved order request</button>
          </section>
        )}
        {!openOrderJournalReady && (
          <p className="lc-warning">
            Checking saved unpaid-order work. Payment and account changes are paused until it can be
            checked.
          </p>
        )}
        {(openOrderPending || !boot.device) && (
          <OpenOrderPendingRecovery
            key={boot.userId}
            actorId={boot.userId}
            excludeBranchId={boot.device ? branchId : undefined}
            onResolved={resolvedOpenOrderElsewhere}
            disabled={busy || !online}
            onPendingChange={() => {
              void checkOpenOrderPending(boot.userId).catch(() => setOpenOrderJournalReady(false))
            }}
          />
        )}
        {!kitchenJournalReady && (
          <p className="lc-warning">
            Saved kitchen work could not yet be checked. Account changes and counter registration
            are paused; keep this browser’s data.
          </p>
        )}
        {!tabKitchenJournalReady && (
          <p className="lc-warning">
            Kitchen recovery storage is unavailable. Keep this browser’s data; sales and account
            changes are paused.
          </p>
        )}
        {(tabKitchenPending || !boot.device) && (
          <TabKitchenPendingRecovery
            key={boot.userId}
            actorId={boot.userId}
            excludeBranchId={
              (view === 'kitchen' || (view === 'sell' && sourceTab)) && boot.device
                ? branchId
                : undefined
            }
            disabled={busy || !online}
            onPendingChange={() => {
              void checkTabKitchenPending(boot.userId).catch(() => setTabKitchenJournalReady(false))
            }}
          />
        )}
        {kitchenPending && view !== 'kitchen' && boot.device && (
          <section className="lc-warning" aria-label="Saved kitchen change">
            <p>A kitchen change needs confirmation before signing out or changing your password.</p>
            <button onClick={() => setView('kitchen')}>Check saved kitchen work</button>
          </section>
        )}
        {(kitchenPending || !boot.device) && (
          <KitchenPendingRecovery
            key={boot.userId}
            actorId={boot.userId}
            excludeBranchId={view === 'kitchen' && boot.device ? branchId : undefined}
            disabled={busy || !online}
            onPendingChange={() => {
              void checkKitchenPending(boot.userId).catch(() => setKitchenJournalReady(false))
            }}
          />
        )}
      </div>
      {!boot.device ? (
        <>
          {operationsAccess && (
            <nav className="lc-tabs lc-noprint" aria-label="Manager navigation">
              <button
                aria-current={view !== 'operations' ? 'page' : undefined}
                onClick={() => setView('sell')}
              >
                Set up counter
              </button>
              <button
                aria-current={view === 'operations' ? 'page' : undefined}
                onClick={() => setView('operations')}
              >
                Operations
              </button>
            </nav>
          )}
          {view === 'operations' && operationsAccess ? (
            <main className="lc-main">
              <p>
                You can review branch activity without registering this browser. Set up a counter
                when you need to take orders.
              </p>
              <BranchOperations
                actorId={boot.userId}
                branchId={branchId}
                branchName={branch?.name ?? 'Branch'}
                branches={boot.branches}
                disabled
                onNavigate={() => {}}
              />
            </main>
          ) : (
            <main className="lc-enrol lc-noprint">
              <h1>Set up this counter</h1>
              <p>Give this browser a counter name. Each POS device keeps its own shift.</p>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  const data = new FormData(event.currentTarget)
                  void run(async () => {
                    if (stationInteractionHeld || (await stationCustody.check()))
                      throw new Error(
                        'Resolve the saved kitchen station change before registering a counter.'
                      )
                    if (reviewBusy || (await checkReviewPending(boot.userId)).length)
                      throw new Error(
                        'Check the saved manager decision before changing account or counter access.'
                      )
                    if ((await checkTabKitchenPending(boot.userId)).length)
                      throw new Error(
                        'Resolve the saved kitchen dispatch before changing account or counter access.'
                      )
                    if ((await checkKitchenPending(boot.userId)).length)
                      throw new Error(
                        'Resolve the saved kitchen change before registering a replacement counter.'
                      )
                    if ((await checkOpenOrderPending(boot.userId)).length)
                      throw new Error(
                        'Resolve the saved unpaid-order change before registering a replacement counter.'
                      )
                    await api('/api/pos/devices', 'POST', {
                      branchId,
                      name: String(data.get('deviceName')).trim(),
                    })
                    await refresh()
                  })
                }}
              >
                <TapChoices
                  label="Branch"
                  value={branchId}
                  disabled={reviewHeld}
                  onChange={setBranchId}
                  options={boot.branches.map((item) => ({ value: item.id, label: item.name }))}
                />
                <label>
                  Counter name
                  <input
                    name="deviceName"
                    required
                    minLength={2}
                    maxLength={80}
                    placeholder="For example, Front counter"
                  />
                </label>
                <button
                  className="lc-primary"
                  disabled={
                    busy ||
                    !branchId ||
                    stationHeld ||
                    !!pending ||
                    reviewHeld ||
                    tabKitchenBusy ||
                    tabKitchenPending ||
                    !tabKitchenJournalReady ||
                    kitchenPending ||
                    !kitchenJournalReady ||
                    openOrderPending ||
                    !openOrderJournalReady ||
                    openOrderBusy
                  }
                >
                  Register this counter
                </button>
              </form>
            </main>
          )}
        </>
      ) : (
        <>
          <nav className="lc-tabs lc-noprint" aria-label="Counter navigation">
            {primaryCounterViews.map((item) => (
              <button
                key={item}
                aria-current={view === item ? 'page' : undefined}
                disabled={openOrderBusy || reviewBusy || stockBusy || stationInteractionHeld}
                onClick={() => setView(item)}
              >
                {counterLabels[item]}
              </button>
            ))}
            <details className="lc-more-nav">
              <summary aria-label="Open more counter options">More</summary>
              <div>
                {secondaryCounterViews.map((item) => (
                  <button
                    key={item}
                    aria-current={view === item ? 'page' : undefined}
                    disabled={openOrderBusy || reviewBusy || stockBusy || stationInteractionHeld}
                    onClick={() => setView(item)}
                  >
                    {counterLabels[item]}
                  </button>
                ))}
              </div>
            </details>
            <span>{boot.device.name}</span>
          </nav>
          <main className="lc-main">
            {view === 'stock' && manager && branch && (
              <StockManager
                actorId={boot.userId}
                branchId={branchId}
                branchName={branch.name}
                deviceId={boot.device.id}
                disabled={
                  busy ||
                  !!pending ||
                  !online ||
                  reviewHeld ||
                  openOrderBusy ||
                  openOrderPending ||
                  tabKitchenBusy ||
                  tabKitchenPending ||
                  !tabKitchenJournalReady ||
                  kitchenPending ||
                  !kitchenJournalReady ||
                  !openOrderJournalReady
                }
                onBusyChange={setStockBusy}
              />
            )}
            {view === 'operations' && operationsAccess && (
              <BranchOperations
                actorId={boot.userId}
                branchId={branchId}
                branchName={branch?.name ?? 'Branch'}
                branches={boot.branches}
                disabled={
                  busy || openOrderBusy || reviewBusy || tabKitchenBusy || stationInteractionHeld
                }
                onNavigate={(destination) => {
                  if (
                    !busy &&
                    !openOrderBusy &&
                    !reviewBusy &&
                    !tabKitchenBusy &&
                    !stationInteractionHeld
                  )
                    setView(destination)
                }}
              />
            )}
            {view === 'open-orders' && branch && (
              <OpenOrdersBoard
                key={`${boot.userId}:${branchId}`}
                actorId={boot.userId}
                branchId={branchId}
                branchName={branch.name}
                deviceId={boot.device.id}
                disabled={
                  busy ||
                  !!pending ||
                  !online ||
                  reviewHeld ||
                  tabKitchenBusy ||
                  tabKitchenPending ||
                  !tabKitchenJournalReady
                }
                onOpen={requestBasket}
                onStartTable={requestBasket}
                onBusyChange={setOpenOrderBusy}
                onResolved={resolvedOpenOrderElsewhere}
                onPendingChange={() => {
                  void checkOpenOrderPending(boot.userId).catch(() =>
                    setOpenOrderJournalReady(false)
                  )
                }}
              />
            )}
            {view === 'kitchen-stations' && manager && branch && kitchenStationsEnabled && (
              <KitchenStationManager
                actorId={boot.userId}
                branchId={branchId}
                deviceId={boot.device.id}
                role={branch.role}
                disabled={
                  busy || !!pending || !online || reviewHeld || openOrderBusy || tabKitchenBusy
                }
                onBlockedChange={setStationEditorBlocked}
              />
            )}
            {view === 'kitchen' && branch && branding && (
              <div className="lc-kitchen-identity lc-noprint">
                <MerchantIdentity branding={branding} kitchen />
                <span>{branch.name}</span>
              </div>
            )}
            {view === 'kitchen' && branch && kitchenStationsEnabled && (
              <StationWorkBoard
                actorId={boot.userId}
                branchId={branchId}
                deviceId={boot.device.id}
                role={branch.role}
                disabled={
                  busy || !!pending || !online || reviewHeld || openOrderBusy || tabKitchenBusy
                }
                onBlockedChange={setStationWorkBlocked}
              />
            )}
            {view === 'kitchen' && branch && (
              <KitchenReturnNotices
                key={`${boot.userId}:${branchId}:${boot.device.id}`}
                actorId={boot.userId}
                branchId={branchId}
                deviceId={boot.device.id}
                disabled={busy || !!pending || !online || tabKitchenBusy || openOrderBusy}
                onAcknowledged={() => setKitchenReturnRevision((value) => value + 1)}
              />
            )}
            {view === 'kitchen' && branch && (
              <TabKitchenBoard
                key={`tab-kitchen:${boot.userId}:${branchId}:${kitchenReturnRevision}`}
                actorId={boot.userId}
                branchId={branchId}
                branchName={branch.name}
                deviceId={boot.device.id}
                disabled={busy || !!pending || !online || openOrderBusy || openOrderPending}
                onBusyChange={setTabKitchenBusy}
                onPendingChange={() => {
                  void checkTabKitchenPending(boot.userId).catch(() =>
                    setTabKitchenJournalReady(false)
                  )
                }}
              />
            )}
            {view === 'kitchen' && branch && (
              <KitchenBoard
                key={`paid-kitchen:${boot.userId}:${branchId}:${kitchenReturnRevision}`}
                actorId={boot.userId}
                branchId={branchId}
                branchName={branch.name}
                deviceId={boot.device.id}
                disabled={busy || !!pending || !online}
                onPendingChange={() => {
                  void checkKitchenPending(boot.userId).catch(() => setKitchenJournalReady(false))
                }}
              />
            )}
            {view === 'payment-review' && manager && branch && offlinePaymentReviewEnabled && (
              <OfflinePaymentReviews
                actorId={boot.userId}
                branchId={branchId}
                branchName={branch.name}
                disabled={busy || !!pending || !online || openOrderBusy || tabKitchenBusy}
                onBusyChange={(active) => reviewOperation(branchId, active)}
                onPendingChange={() => {
                  void checkReviewPending(boot.userId).catch(() => setReviewReady(false))
                }}
              />
            )}
            {view === 'staff' && manager && (
              <StaffManager
                key={`${boot.userId}:${branchId}`}
                actorId={boot.userId}
                branchId={branchId}
                deviceId={boot.device.id}
                disabled={busy || !!pending || !online}
                onChanged={async () => {
                  await refresh()
                }}
              />
            )}
            {view === 'account' && (
              <AccountSettings
                disabled={
                  busy ||
                  !!pending ||
                  !online ||
                  !!shift ||
                  stationHeld ||
                  reviewHeld ||
                  tabKitchenBusy ||
                  tabKitchenPending ||
                  !tabKitchenJournalReady ||
                  kitchenPending ||
                  !kitchenJournalReady ||
                  openOrderPending ||
                  !openOrderJournalReady ||
                  openOrderBusy
                }
              />
            )}
            {view === 'reports' && manager && branch && (
              <BranchReports
                key={`${boot.userId}:${branchId}`}
                branchId={branchId}
                branchName={branch.name}
              />
            )}
            {view === 'offers' && manager && (
              <OfferManager
                key={`${boot.userId}:${branchId}`}
                branchId={branchId}
                deviceId={boot.device.id}
                disabled={busy || !!pending || !online}
                onChanged={async () => {
                  setChosenOffer(null)
                  setCashInput('')
                  setCardInput('')
                }}
              />
            )}
            {view === 'menu' && manager && (
              <CatalogueManager
                key={`${boot.userId}:${branchId}`}
                branchId={branchId}
                deviceId={boot.device.id}
                disabled={busy || !!pending || !online}
                onChanged={async () => {
                  await refresh()
                  setBasket([])
                  setSourceTab(null)
                  setInitialTableId(null)
                  setOpenOrderMetadataDirty(false)
                  setChosenOffer(null)
                  setCashInput('')
                  setCardInput('')
                }}
              />
            )}
            {
              <div
                className="lc-sell lc-noprint"
                style={view === 'sell' ? undefined : { display: 'none' }}
              >
                <section className="lc-menu">
                  <div className="lc-section-heading">
                    <div>
                      <span className="lc-eyebrow">{products.length} available items</span>
                      <h1>
                        {sourceTab ? sourceTab.label : initialTableId ? 'Table order' : 'New order'}
                      </h1>
                    </div>
                    <button
                      onClick={() =>
                        orderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }
                    >
                      Order · {basket.length}
                    </button>
                  </div>
                  <div className="lc-filters">
                    <label>
                      Search menu
                      <input
                        type="search"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Find a dish or sweet"
                      />
                    </label>
                    <form
                      className="lc-barcode-scan"
                      onSubmit={(event) => {
                        event.preventDefault()
                        scanBarcode()
                      }}
                    >
                      <label>
                        Scan barcode / PLU
                        <input
                          ref={barcodeInputRef}
                          value={barcodeInput}
                          onChange={(event) => setBarcodeInput(event.target.value)}
                          placeholder="Scan, then Enter"
                          inputMode="numeric"
                          autoComplete="off"
                          disabled={basketLocked}
                        />
                      </label>
                      <button type="submit" disabled={basketLocked || !barcodeInput.trim()}>
                        Add
                      </button>
                    </form>
                    <TapChoices
                      label="Category"
                      scrollable={categories.length > 6}
                      value={category}
                      onChange={setCategory}
                      options={['All', ...categories].map((item) => ({ value: item, label: item }))}
                    />
                    <button
                      type="button"
                      className="lc-favourites-filter"
                      aria-pressed={favouritesOnly}
                      disabled={!activeFavouriteIds.length}
                      onClick={() => setFavouritesOnly((current) => !current)}
                    >
                      {favouritesOnly ? 'Showing favourites' : 'Show favourites'} ·{' '}
                      {activeFavouriteIds.length}
                    </button>
                  </div>
                  <div className="lc-products">
                    {visibleProducts.map((product) => {
                      const illustration = temporaryMenuIllustration(product)
                      const favourite = activeFavouriteIds.includes(product.id)
                      return (
                        <article
                          key={product.id}
                          className="lc-product"
                          data-unavailable={product.unitPriceFils <= 0 || undefined}
                        >
                          <button
                            type="button"
                            className="lc-product-select"
                            disabled={basketLocked || product.unitPriceFils <= 0}
                            onClick={() => add(product)}
                          >
                            {product.imageUrl?.startsWith('/pos-assets/') ? (
                              <img src={product.imageUrl} alt="" loading="lazy" />
                            ) : illustration ? (
                              <>
                                <img
                                  src={illustration.src}
                                  alt=""
                                  loading="lazy"
                                  className="lc-illustration"
                                />
                                <small className="lc-illustration-label">
                                  {illustration.label}
                                </small>
                              </>
                            ) : (
                              <span className="lc-photo-empty">Photo pending</span>
                            )}
                            <span id={`product-name-${product.id}`}>{product.name}</span>
                            <strong>
                              {currency(product.unitPriceFils)}
                              {product.unit === 'kg' ? ' / kg' : ''}
                            </strong>
                            {product.unitPriceFils <= 0 && (
                              <small className="lc-product-unavailable">
                                Price pending · unavailable
                              </small>
                            )}
                          </button>
                          <button
                            type="button"
                            className="lc-favourite-toggle"
                            aria-pressed={favourite}
                            aria-label={favourite ? 'Remove favourite' : 'Add favourite'}
                            aria-describedby={`product-name-${product.id}`}
                            title={
                              favourite
                                ? `Remove ${product.name} from favourites`
                                : `Add ${product.name} to favourites`
                            }
                            onClick={() => toggleFavourite(product.id)}
                          >
                            {favourite ? '★' : '☆'}
                          </button>
                        </article>
                      )
                    })}
                  </div>
                  {!visibleProducts.length && (
                    <p>
                      {favouritesOnly
                        ? 'No favourites match these filters.'
                        : 'No available items match your search.'}
                    </p>
                  )}
                </section>
                <aside className="lc-order" ref={orderRef} aria-label="Current order">
                  <h2>{sourceTab ? sourceTab.label : 'Current order'}</h2>
                  <button disabled={basketLocked} onClick={() => requestBasket('new')}>
                    New order / clear counter
                  </button>
                  {sourceTab && (
                    <button
                      disabled={basketLocked || !online}
                      onClick={() =>
                        void run(async () => {
                          const next = await refresh()
                          const current = next.catalogue.filter(
                            (product) => product.branchId === branchId
                          )
                          const unavailable = basket.filter(
                            (line) => !current.some((product) => product.id === line.product.id)
                          )
                          if (unavailable.length)
                            throw new Error(
                              `Remove unavailable items before saving: ${unavailable.map((line) => line.product.name).join(', ')}`
                            )
                          setBasket(
                            basket.map((line) => ({
                              ...line,
                              product: current.find((product) => product.id === line.product.id)!,
                            }))
                          )
                          setChosenOffer(null)
                          setCashInput('')
                          setCardInput('')
                          setNotice(
                            'Current menu loaded. Review quantities and prices, then save any changes before payment.'
                          )
                        })
                      }
                    >
                      Review with current menu prices
                    </button>
                  )}
                  {sourceTab && (
                    <p className="lc-help">
                      Saved unpaid order ·{' '}
                      {sourceTab.status === 'voided'
                        ? 'Voided: review and reopen before payment.'
                        : savedBasketMatches && !openOrderMetadataDirty
                          ? 'Basket matches the saved order.'
                          : 'Changes need saving before payment.'}
                    </p>
                  )}
                  <p>{shift ? 'Shift open' : 'Open your shift before checkout'}</p>
                  <TapChoices<LiveOrder['serviceType']>
                    label="Order type"
                    value={serviceType}
                    disabled={basketLocked}
                    onChange={setServiceType}
                    options={[
                      { value: 'takeaway', label: 'Takeaway' },
                      { value: 'dine_in', label: 'Dine-in' },
                      { value: 'delivery', label: 'Delivery' },
                    ]}
                  />
                  {!basket.length && <p className="lc-empty">Choose an item to start an order.</p>}
                  {basket.map((line) => (
                    <div className="lc-basket-line" key={line.product.id}>
                      <strong>{line.product.name}</strong>
                      <span>
                        {currency(
                          catalogueLineTotals(
                            line.product.unitPriceFils,
                            line.quantityMilli,
                            line.product.taxRateBps
                          ).grossFils
                        )}
                      </span>
                      <label>
                        {line.product.unit === 'kg' ? 'Grams' : 'Quantity'}
                        <input
                          type="number"
                          inputMode="numeric"
                          min="1"
                          max={line.product.unit === 'kg' ? 1000000 : 1000}
                          step="1"
                          value={
                            line.product.unit === 'kg'
                              ? line.quantityMilli
                              : line.quantityMilli / 1000
                          }
                          disabled={basketLocked}
                          onChange={(event) => {
                            const quantity = Number(event.target.value)
                            const scaled = quantity * (line.product.unit === 'kg' ? 1 : 1000)
                            if (
                              !Number.isSafeInteger(quantity) ||
                              quantity < 1 ||
                              scaled > 1_000_000
                            ) {
                              setError('Use whole quantities within the counter limit.')
                              return
                            }
                            setBasket((current) =>
                              current.map((item) =>
                                item.product.id === line.product.id
                                  ? { ...item, quantityMilli: scaled }
                                  : item
                              )
                            )
                          }}
                        />
                      </label>
                      <div className="lc-line-modifiers">
                        <span>Kitchen modifiers</span>
                        <div>
                          {modifierOptions.map((modifier) => (
                            <button
                              type="button"
                              key={modifier}
                              disabled={basketLocked || !!sourceTab || !!initialTableId}
                              aria-pressed={line.modifiers?.includes(modifier) ?? false}
                              onClick={() => toggleModifier(line.product.id, modifier)}
                            >
                              {line.modifiers?.includes(modifier) ? '✓ ' : ''}
                              {modifier}
                            </button>
                          ))}
                        </div>
                        {line.modifiers?.length ? (
                          <small>Kitchen: {line.modifiers.join(' · ')}</small>
                        ) : (
                          <small>Select only what applies to this item.</small>
                        )}
                        {(sourceTab || initialTableId) && (
                          <small>
                            Item modifiers are recorded for direct paid orders. Add an order note to
                            a saved kitchen order.
                          </small>
                        )}
                      </div>
                      <button
                        disabled={basketLocked}
                        aria-label={`Remove ${line.product.name}`}
                        onClick={() =>
                          setBasket((current) =>
                            current.filter((item) => item.product.id !== line.product.id)
                          )
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  {basket.length > 0 && (
                    <OfferPicker
                      key={`${boot.userId}:${branchId}`}
                      branchId={branchId}
                      serviceType={serviceType}
                      lines={offerLines}
                      disabled={basketLocked || !online}
                      onSelection={chooseOffer}
                    />
                  )}
                  <OpenOrderSave
                    key={`${boot.userId}:${branchId}:${sourceTab?.id ?? 'new'}:${sourceTab?.revision ?? 0}:${initialTableId ?? ''}`}
                    actorId={boot.userId}
                    branchId={branchId}
                    deviceId={boot.device.id}
                    sourceTab={sourceTab}
                    initialTableId={initialTableId}
                    serviceType={serviceType}
                    lines={offerLines}
                    disabled={
                      busy ||
                      !!pending ||
                      !online ||
                      reviewHeld ||
                      tabKitchenBusy ||
                      tabKitchenPending ||
                      !tabKitchenJournalReady
                    }
                    onDirtyChange={setOpenOrderMetadataDirty}
                    onBusyChange={setOpenOrderBusy}
                    onPendingChange={() => {
                      void checkOpenOrderPending(boot.userId).catch(() =>
                        setOpenOrderJournalReady(false)
                      )
                    }}
                    onSaved={(tab) => {
                      setSourceTab(tab)
                      setInitialTableId(null)
                      setOpenOrderMetadataDirty(false)
                      setBasket(basketFromOpenOrder(tab))
                      setServiceType(tab.serviceType)
                      setNotice('Unpaid order saved for your branch. Payment has not been taken.')
                    }}
                  />
                  {view === 'sell' && sourceTab && branch && (
                    <TabKitchenDispatch
                      key={`${boot.userId}:${branchId}:${sourceTab.id}`}
                      actorId={boot.userId}
                      branchId={branchId}
                      branchName={branch.name}
                      deviceId={boot.device.id}
                      tab={sourceTab}
                      onPaymentReady={(ready) =>
                        setKitchenPaymentReadiness({ key: kitchenPaymentKey!, ready })
                      }
                      disabled={
                        busy ||
                        !!pending ||
                        !online ||
                        openOrderBusy ||
                        openOrderPending ||
                        !openOrderJournalReady ||
                        requiresOrderSave
                      }
                      onBusyChange={setTabKitchenBusy}
                      onPendingChange={() => {
                        void checkTabKitchenPending(boot.userId).catch(() =>
                          setTabKitchenJournalReady(false)
                        )
                      }}
                    />
                  )}
                  {requiresOrderSave && (
                    <p className="lc-warning">Save this unpaid order before taking payment.</p>
                  )}
                  <dl className="lc-totals">
                    {activeOffer && (
                      <>
                        <div>
                          <dt>Before offer</dt>
                          <dd>{currency(beforeDiscount)}</dd>
                        </div>
                        <div>
                          <dt>{activeOffer.quote.offerName}</dt>
                          <dd>−{currency(activeOffer.quote.discountFils)}</dd>
                        </div>
                      </>
                    )}
                    <div>
                      <dt>VAT included</dt>
                      <dd>{currency(tax)}</dd>
                    </div>
                    <div>
                      <dt>Total</dt>
                      <dd>{currency(total)}</dd>
                    </div>
                  </dl>
                  <TapChoices<typeof paymentMethod>
                    label="Payment"
                    value={paymentMethod}
                    disabled={basketLocked}
                    onChange={setPaymentMethod}
                    options={[
                      { value: 'cash', label: 'Cash' },
                      { value: 'card', label: 'Card recorded' },
                      { value: 'split', label: 'Cash + card' },
                    ]}
                  />
                  {paymentMethod === 'split' && (
                    <label>
                      Card amount (AED)
                      <input
                        inputMode="decimal"
                        value={cardInput}
                        disabled={basketLocked}
                        onChange={(event) => setCardInput(event.target.value)}
                      />
                    </label>
                  )}
                  {paymentMethod !== 'card' && (
                    <label>
                      Cash received (AED)
                      <input
                        inputMode="decimal"
                        placeholder={paymentMethod === 'cash' ? formatFils(total) : 'Cash amount'}
                        value={cashInput}
                        disabled={basketLocked}
                        onChange={(event) => setCashInput(event.target.value)}
                      />
                    </label>
                  )}
                  {paymentMethod !== 'cash' && (
                    <p className="lc-help">
                      Complete the card payment on your terminal first. This button records it; it
                      does not charge a card.
                    </p>
                  )}
                  <label>
                    Kitchen / order note
                    <textarea
                      maxLength={240}
                      value={orderNote}
                      disabled={basketLocked || !!sourceTab}
                      placeholder={
                        sourceTab
                          ? 'Save notes with the unpaid order before payment'
                          : 'Example: No chilli · prepare after 7 pm'
                      }
                      onChange={(event) => setOrderNote(event.target.value)}
                    />
                    <small>
                      {sourceTab
                        ? 'Saved unpaid orders keep their kitchen instructions with the order.'
                        : 'Shown on the kitchen ticket and saved with this invoice.'}
                    </small>
                  </label>
                  <details>
                    <summary>Customer details for the invoice</summary>
                    <label>
                      Name
                      <input
                        maxLength={200}
                        value={buyerName}
                        aria-invalid={buyerName.includes('\u0000') || undefined}
                        aria-describedby={
                          buyerName.includes('\u0000') ? 'live-buyer-input-error' : undefined
                        }
                        disabled={basketLocked}
                        onChange={(event) => setBuyerName(event.target.value)}
                      />
                    </label>
                    <label>
                      Address
                      <input
                        maxLength={400}
                        value={buyerAddress}
                        aria-invalid={buyerAddress.includes('\u0000') || undefined}
                        aria-describedby={
                          buyerAddress.includes('\u0000') ? 'live-buyer-input-error' : undefined
                        }
                        disabled={basketLocked}
                        onChange={(event) => setBuyerAddress(event.target.value)}
                      />
                    </label>
                    <label>
                      TRN, if registered
                      <input
                        inputMode="numeric"
                        maxLength={15}
                        value={buyerTrn}
                        aria-invalid={buyerTrn.includes('\u0000') || undefined}
                        aria-describedby={
                          buyerTrn.includes('\u0000') ? 'live-buyer-input-error' : undefined
                        }
                        disabled={basketLocked}
                        onChange={(event) => setBuyerTrn(event.target.value)}
                      />
                    </label>
                  </details>
                  {invalidBuyerInput && (
                    <p className="lc-error" role="alert" id="live-buyer-input-error">
                      Customer details contain an unsupported hidden character. Remove it or retype
                      the affected field before taking payment.
                    </p>
                  )}
                  <button
                    className="lc-primary"
                    disabled={
                      invalidBuyerInput ||
                      !mayWrite ||
                      !kitchenPaymentReady ||
                      !shift ||
                      total <= 0 ||
                      requiresOrderSave
                    }
                    onClick={checkout}
                  >
                    {busy ? 'Waiting for confirmation…' : `Save sale · ${currency(total)}`}
                  </button>
                  {!shift && <button onClick={() => setView('shift')}>Go to shift</button>}
                  <p className="lc-help">
                    An invoice appears only after the server confirms the sale.
                  </p>
                </aside>
              </div>
            }
            {view === 'receipts' && (
              <section className="lc-documents">
                <div className="lc-noprint">
                  <div className="lc-section-heading">
                    <h1>Receipts</h1>
                    <button
                      disabled={busy || !online}
                      onClick={() => void run(() => loadDocuments(branchId))}
                    >
                      Refresh
                    </button>
                  </div>
                  <p>
                    Saved invoices and credit notes for this branch. Reprinting does not create
                    another sale.
                  </p>
                  <div className="lc-document-list">
                    {documents.map((document) => (
                      <button
                        key={document.id}
                        aria-pressed={selected?.id === document.id}
                        onClick={() => {
                          setSelected(document)
                        }}
                      >
                        <strong>{document.documentNumber}</strong>
                        <span>
                          {document.kind === 'tax_credit_note' ? 'Credit note' : 'Invoice'} ·{' '}
                          {currency(document.totals.grossFils)}
                        </span>
                      </button>
                    ))}
                    {!documents.length && <p>No saved receipts yet.</p>}
                    {nextCursor && (
                      <button
                        disabled={busy || !online}
                        onClick={() => void run(() => loadDocuments(branchId, nextCursor))}
                      >
                        Load older receipts
                      </button>
                    )}
                  </div>
                  <CustomerReceiptLookup
                    documents={documents}
                    onUseCustomer={(customer) => {
                      setBuyerName(customer.name)
                      setBuyerAddress(customer.address)
                      setBuyerTrn(customer.trn ?? '')
                      setNotice(
                        'Customer details copied from the selected invoice. Review them before payment.'
                      )
                      setView('sell')
                    }}
                  />
                </div>
                {selected && (
                  <div className="lc-document-detail">
                    <FiscalReceipt document={selected} branding={branding} />
                    <div className="lc-noprint">
                      <button className="lc-primary" onClick={() => window.print()}>
                        Print / save PDF
                      </button>
                      <p className="lc-help">
                        Choose the printer or Save as PDF in the browser dialog. Printer delivery is
                        not confirmed by this app.
                      </p>
                      {selected.kind === 'tax_credit_note' && (
                        <p className="lc-warning">
                          Return the amounts shown only once for this credit note. Card refunds must
                          be completed on your payment terminal; this app does not process them.
                        </p>
                      )}
                      {selected.kind === 'tax_invoice' && manager && boot.device && (
                        <PartialReturnPanel
                          key={`${boot.userId}:${branchId}:${boot.device.id}:${shift?.id ?? ''}:${selected.id}`}
                          invoice={selected}
                          actorId={boot.userId}
                          deviceId={boot.device.id}
                          shiftId={shift?.id ?? null}
                          online={online}
                          mayWrite={mayWrite && branch?.canRefund === true}
                          pending={!!pending}
                          onCommit={(request, quoteHash) =>
                            run(async () => {
                              await command({
                                id: browserUuid(),
                                type: 'refund.items',
                                ...request,
                                quoteHash,
                              })
                            })
                          }
                        />
                      )}
                    </div>
                  </div>
                )}
              </section>
            )}
            {view === 'shift' && (
              <section className="lc-shift lc-noprint">
                <h1>Your shift</h1>
                <p>
                  {boot.device.name} · {branch?.name}
                </p>
                {otherShift && (
                  <p className="lc-warning">
                    Another staff member has an open shift on this counter. They must sign in and
                    close it first.
                  </p>
                )}
                {shift ? (
                  <>
                    <div className="lc-summary">
                      <div>
                        <span>Opening cash</span>
                        <strong>{currency(shift.openingCashFils)}</strong>
                      </div>
                      <div>
                        <span>Expected cash now</span>
                        <strong>
                          {'expectedCashFils' in shift && typeof shift.expectedCashFils === 'number'
                            ? currency(shift.expectedCashFils)
                            : 'Refresh to view'}
                        </strong>
                      </div>
                    </div>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await refresh()
                        })
                      }
                    >
                      Refresh shift totals
                    </button>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault()
                        const data = new FormData(event.currentTarget)
                        void run(async () => {
                          if (!boot.device) return
                          if (basket.length)
                            throw new Error(
                              'Finish or remove the current order before closing your shift.'
                            )
                          await command({
                            id: browserUuid(),
                            type: 'shift.close',
                            branchId,
                            deviceId: boot.device.id,
                            shiftId: shift.id,
                            countedCashFils: parseMoney(String(data.get('counted'))),
                          })
                        })
                      }}
                    >
                      <h2>Close shift</h2>
                      <label>
                        Cash counted (AED)
                        <input name="counted" inputMode="decimal" required />
                      </label>
                      <button className="lc-primary" disabled={!mayWrite}>
                        Reconcile &amp; close shift
                      </button>
                    </form>
                    {manager && (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault()
                          const form = event.currentTarget
                          const data = new FormData(form)
                          void run(async () => {
                            if (!boot.device) return
                            const amount = parseMoney(String(data.get('amount')))
                            if (amount <= 0) throw new Error('Enter an amount above zero.')
                            await command({
                              id: browserUuid(),
                              type: 'cash.move',
                              branchId,
                              deviceId: boot.device.id,
                              shiftId: shift.id,
                              amountFils: amount * (data.get('direction') === 'out' ? -1 : 1),
                              reason: String(data.get('reason')).trim(),
                            })
                            form.reset()
                          })
                        }}
                      >
                        <h2>Cash movement</h2>
                        <TapChoices
                          label="Direction"
                          name="direction"
                          defaultValue="in"
                          disabled={!mayWrite}
                          options={[
                            { value: 'in', label: 'Cash in' },
                            { value: 'out', label: 'Cash out' },
                          ]}
                        />
                        <label>
                          Amount (AED)
                          <input name="amount" inputMode="decimal" required />
                        </label>
                        <label>
                          Reason
                          <input name="reason" required maxLength={240} />
                        </label>
                        <button disabled={!mayWrite}>Record cash movement</button>
                      </form>
                    )}
                  </>
                ) : (
                  !otherShift && (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault()
                        const data = new FormData(event.currentTarget)
                        void run(async () => {
                          if (!boot.device) return
                          await command({
                            id: browserUuid(),
                            type: 'shift.open',
                            branchId,
                            deviceId: boot.device.id,
                            shiftId: browserUuid(),
                            openingCashFils: parseMoney(String(data.get('opening'))),
                          })
                        })
                      }}
                    >
                      <h2>Open shift</h2>
                      <label>
                        Cash in the drawer (AED)
                        <input name="opening" inputMode="decimal" defaultValue="0.00" required />
                      </label>
                      <button className="lc-primary" disabled={!mayWrite}>
                        Open shift
                      </button>
                    </form>
                  )
                )}
              </section>
            )}
            {view === 'branch' && (
              <section className="lc-branch lc-noprint">
                <h1>Branch details</h1>
                {branch?.profile ? (
                  <>
                    <h2>{branch.profile.legalName}</h2>
                    <p>
                      {branch.profile.address}
                      <br />
                      {branch.profile.phone}
                    </p>
                    <p>
                      <strong>VAT TRN:</strong> {branch.profile.trn}
                      <br />
                      <strong>Prices:</strong> VAT inclusive
                      <br />
                      <strong>Currency:</strong> AED
                    </p>
                  </>
                ) : (
                  <p className="lc-warning">
                    Business details must be confirmed before live billing.
                  </p>
                )}
                <hr />
                <h2>Counter access</h2>
                <p>
                  {boot.device.name}
                  <br />
                  {branch?.role} access
                </p>
                <h2>Subscription</h2>
                <p>
                  New plans are US$100 per branch per month. Existing manual arrangements remain
                  unchanged until separately agreed. This screen is not proof of payment.
                </p>
                <Link href="/billing">View subscription setup</Link>
                <h2>Current live pilot</h2>
                <p>
                  Online sales, recorded cash/card payments, weighted items, invoice reprints, shift
                  closing, offers, item and weight returns, shared tables and kitchen dispatch
                  before or after payment. Offline live sales are still being prepared.
                </p>
                <Link href="/pos">Open separate training workspace</Link>
              </section>
            )}
          </main>
        </>
      )}
    </div>
  )
}
