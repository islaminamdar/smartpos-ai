import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PendingOnlineRequest } from '@/lib/pos/online-journal'
import type { ReturnRequest } from '@/lib/pos/server/returns'
const journal = vi.hoisted(() => ({
  current: null as PendingOnlineRequest | null,
  save: vi.fn(),
  ack: vi.fn(),
}))
vi.mock('@/lib/pos/online-journal', () => ({
  readPendingRequest: async (actor: string) =>
    journal.current?.actorId === actor ? structuredClone(journal.current) : null,
  savePendingRequest: async (request: PendingOnlineRequest) => {
    journal.save(request)
    if (journal.current) throw Error('Already pending')
    journal.current = structuredClone(request)
  },
  acknowledgePendingRequest: async (actor: string, id: string) => {
    journal.ack(actor, id)
    if (journal.current?.id !== id || journal.current.actorId !== actor) throw Error('Mismatch')
    journal.current = null
  },
}))
vi.mock('@/components/pos/offline-payments/journal', () => ({
  paymentReviewJournalEvent: 'review-test',
  readPendingPaymentReviews: async () => [],
}))
vi.mock('@/lib/pos/tab-kitchen-journal', () => ({
  tabKitchenJournalEvent: 'tab-test',
  readPendingTabKitchenRequests: async () => [],
}))
vi.mock('@/lib/pos/open-order-journal', () => ({
  openOrderJournalEvent: 'order-test',
  readPendingOpenOrderRequests: async () => [],
  savePendingOpenOrderRequest: vi.fn(),
  acknowledgeOpenOrderRequest: vi.fn(),
}))
vi.mock('@/lib/pos/kitchen-journal', () => ({
  kitchenJournalEvent: 'kitchen-test',
  readPendingKitchenRequests: async () => [],
}))
const callbacks = vi.hoisted(() => ({ refresh: null as null | (() => Promise<void>) }))
vi.mock('@/components/pos/CatalogueManager', () => ({
  default: ({ onChanged }: { onChanged: () => Promise<void> }) => {
    callbacks.refresh = onChanged
    return null
  },
}))
import LiveCounter from '@/components/pos/LiveCounter'
import { boot, invoice, stateFor, previewFor, creditFor } from './fixtures/partial-return-ui'
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const state = stateFor(invoice, [500, 1000, 0])
type Command = ReturnRequest & { id: string; type: 'refund.items'; quoteHash: string }
function api(save: (command: Command) => Response | Promise<Response>) {
  return vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/pos/bootstrap') return response(boot)
    if (url.startsWith('/api/pos/receipts'))
      return response({ receipts: [invoice], nextCursor: null })
    if (url.startsWith('/api/pos/open-orders?'))
      return response({
        status: 'ready',
        organizationId: invoice.merchant.organizationId,
        branchId: invoice.branchId,
        actorRole: 'manager',
        generatedAt: invoice.issuedAt,
        tables: [],
        openTabs: [],
        openCount: 0,
        openNextCursor: null,
        recentTabs: [],
        recentTruncated: false,
      })
    if (url.startsWith('/api/pos/returns?')) return response({ status: 'ready', state })
    if (url === '/api/pos/returns')
      return response({
        status: 'ready',
        preview: previewFor(state, JSON.parse(String(options?.body)).request),
      })
    if (url === '/api/pos/commands') {
      const { command } = JSON.parse(String(options?.body))
      expect(journal.current?.body).toEqual({ command })
      return save(command)
    }
    if (url === '/api/pos/recovery') {
      const { request } = JSON.parse(String(options?.body))
      return save(request)
    }
    throw Error('Unexpected endpoint ' + url)
  })
}
async function submit() {
  await screen.findByRole('button', { name: 'Receipts' })
  fireEvent.click(screen.getByRole('button', { name: 'Receipts' }))
  fireEvent.click(await screen.findByRole('button', { name: /QA-INV-0000000001/ }))
  await screen.findByRole('checkbox', { name: 'Select Pistachio cake, original line 1' })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Pistachio cake, original line 1' }))
  fireEvent.change(screen.getByLabelText('Return Pistachio cake, original line 1, kg'), {
    target: { value: '0.125' },
  })
  fireEvent.change(screen.getByLabelText('Reason for return'), {
    target: { value: 'Wrong weight' },
  })
  const review = screen.getByRole('button', { name: 'Review return' })
  await waitFor(() => expect(review).toBeEnabled())
  fireEvent.click(review)
  await screen.findByRole('heading', { name: 'Review this exact return' })
  fireEvent.click(screen.getByRole('checkbox', { name: /I confirm these exact items/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Issue credit note' }))
}
beforeEach(() => {
  journal.current = null
  journal.save.mockClear()
  journal.ack.mockClear()
  sessionStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('scrollTo', vi.fn())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('persists the exact preview-bound command before dispatch and confirms only matching v3 credit', async () => {
  const fetcher = api((command) =>
    response({
      status: 'applied',
      commandId: command.id,
      replayed: false,
      creditNote: creditFor(state, command),
    })
  )
  vi.stubGlobal('fetch', fetcher)
  await act(async () => {
    render(<LiveCounter />)
  })
  await submit()
  await waitFor(() => expect(journal.ack).toHaveBeenCalledTimes(1))
  const request = journal.save.mock.calls[0][0]
  expect(request.body.command).toMatchObject({
    type: 'refund.items',
    quoteHash: 'a'.repeat(64),
    expectedRevision: 1,
    lines: [{ lineNumber: 1, quantityMilli: 125 }],
    reason: 'Wrong weight',
  })
  expect(screen.getByRole('article', { name: 'Tax credit note' })).toBeVisible()
  expect(journal.current).toBeNull()
})
it('keeps a lost return response and retries the identical request after remount without another preview', async () => {
  let seen: Command | undefined,
    calls = 0
  const fetcher = api((command) => {
    if (!calls++) {
      seen = structuredClone(command)
      return response({ code: 'storage_unavailable' }, 503)
    }
    expect(command).toEqual(seen)
    return response({
      status: 'applied',
      commandId: command.id,
      replayed: true,
      creditNote: creditFor(state, command),
    })
  })
  vi.stubGlobal('fetch', fetcher)
  const view = render(<LiveCounter />)
  await submit()
  await screen.findByRole('region', { name: 'Pending request' })
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Recover saved request' })).toBeEnabled()
  )
  const original = structuredClone(journal.current)
  expect(journal.ack).not.toHaveBeenCalled()
  view.unmount()
  await act(async () => {
    render(<LiveCounter />)
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Recover saved request' }))
  await waitFor(() => expect(journal.ack).toHaveBeenCalledTimes(1))
  expect(journal.save).toHaveBeenCalledTimes(1)
  expect(original?.body).toEqual({ command: seen })
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/pos/returns')).toHaveLength(1)
})
it('rejects an acknowledgement for a different preview and keeps the exact pending request', async () => {
  const fetcher = api((command) =>
    response({
      status: 'applied',
      commandId: command.id,
      replayed: false,
      creditNote: { ...creditFor(state, command), quoteHash: 'b'.repeat(64) },
    })
  )
  vi.stubGlobal('fetch', fetcher)
  render(<LiveCounter />)
  await submit()
  await screen.findByText(/item return did not match its exact saved preview/)
  expect(journal.ack).not.toHaveBeenCalled()
  expect(journal.current?.body).toMatchObject({ command: { quoteHash: 'a'.repeat(64) } })
  expect(screen.queryByRole('article', { name: 'Tax credit note' })).toBeNull()
})

it.each(['actor', 'shift', 'actor away and back'] as const)(
  'acknowledges the original journal without applying a late credit to changed %s context',
  async (transition) => {
    let finish!: (value: Response) => void
    let sent!: Command
    let currentBoot = structuredClone(boot)
    const base = api((command) => {
      sent = command
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) =>
        url === '/api/pos/bootstrap' ? response(currentBoot) : base(url, options)
      )
    )
    await act(async () => {
      render(<LiveCounter />)
    })
    fireEvent.click(screen.getByRole('button', { name: /^Menu$/ }))
    expect(callbacks.refresh).toBeTypeOf('function')
    await submit()
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    currentBoot =
      transition === 'shift'
        ? { ...currentBoot, shifts: [] }
        : { ...currentBoot, userId: '10000000-0000-4000-8000-000000000088', shifts: [] }
    await act(async () => callbacks.refresh!())
    if (transition === 'actor away and back') {
      currentBoot = structuredClone(boot)
      await act(async () => callbacks.refresh!())
    }
    await act(async () =>
      finish(
        response({
          status: 'applied',
          commandId: sent.id,
          replayed: false,
          creditNote: creditFor(state, sent),
        })
      )
    )
    await waitFor(() =>
      expect(journal.ack).toHaveBeenCalledExactlyOnceWith(invoice.actorId, sent.id)
    )
    expect(journal.current).toBeNull()
    expect(screen.queryByRole('article', { name: 'Tax credit note' })).toBeNull()
    expect(screen.queryByText('QA-CN-0000000001 saved on the server.')).toBeNull()
  }
)

// These feature tests isolate empty station journals; station custody has its own race tests.
vi.mock('@/lib/pos/kitchen-station-journal', () => ({
  stationJournalEvent: 'station-config-test',
  readPendingStationRequests: async () => [],
}))
vi.mock('@/lib/pos/kitchen-station-work-journal', () => ({
  stationWorkJournalEvent: 'station-work-test',
  readPendingStationWorkRequests: async () => [],
}))
