import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PartialReturnPanel from '@/components/pos/returns/PartialReturnPanel'
import FiscalReceipt from '@/components/pos/FiscalReceipt'
import {
  returnStateSchema,
  returnRequestSchema,
  type ReturnRequest,
  type ReturnState,
} from '@/lib/pos/server/returns'
import sqlReturns from '../../fixtures/pos-partial-return-documents.json'
import {
  invoice,
  offeredInvoice,
  stateFor,
  previewFor,
  creditFor,
  id,
} from './fixtures/partial-return-ui'
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const props = () => ({
  invoice,
  actorId: invoice.actorId,
  deviceId: invoice.deviceId,
  shiftId: invoice.shiftId,
  online: true,
  mayWrite: true,
  pending: false,
  onCommit: vi.fn(async () => {}),
})
let state: ReturnState, fetcher: ReturnType<typeof vi.fn<typeof fetch>>
beforeEach(() => {
  state = stateFor(invoice, [500, 1000, 0])
  fetcher = vi.fn<typeof fetch>(async (_path, options) =>
    options?.method === 'POST'
      ? response({
          status: 'ready',
          preview: previewFor(state, JSON.parse(String(options.body)).request),
        })
      : response({ status: 'ready', state })
  )
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
async function selectCake() {
  await screen.findByRole('checkbox', { name: 'Select Pistachio cake, original line 1' })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Pistachio cake, original line 1' }))
  fireEvent.change(screen.getByLabelText('Return Pistachio cake, original line 1, kg'), {
    target: { value: '0.125' },
  })
  fireEvent.change(screen.getByLabelText('Reason for return'), {
    target: { value: 'Wrong item received' },
  })
}
async function reviewCake() {
  await selectCake()
  fireEvent.click(screen.getByRole('button', { name: 'Review return' }))
  await screen.findByRole('heading', { name: 'Review this exact return' })
}
describe('partial item return UI', () => {
  it('uses authoritative remaining quantities and server preview; commits only exact fields after fresh consent', async () => {
    const p = props()
    render(<PartialReturnPanel {...p} />)
    await reviewCake()
    expect(screen.getByText('1 kg')).toBeVisible()
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      credentials: 'same-origin',
      cache: 'no-store',
    })
    const request = JSON.parse(String(fetcher.mock.calls[1][1]?.body)).request
    expect(request).toEqual({
      branchId: invoice.branchId,
      deviceId: invoice.deviceId,
      shiftId: invoice.shiftId,
      orderId: invoice.orderId,
      invoiceId: invoice.id,
      expectedRevision: 1,
      lines: [{ lineNumber: 1, quantityMilli: 125 }],
      reason: 'Wrong item received',
      refundMethod: 'cash',
    })
    expect(screen.getByRole('button', { name: 'Issue credit note' })).toBeDisabled()
    expect(screen.getByText('Cash refund')).toBeVisible()
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm these exact items/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Issue credit note' }))
    await waitFor(() => expect(p.onCommit).toHaveBeenCalledExactlyOnceWith(request, 'a'.repeat(64)))
  })
  it('retains original line identity for duplicate products and selects only remaining quantities', async () => {
    render(<PartialReturnPanel {...props()} />)
    await screen.findByText('Select all remaining items')
    fireEvent.click(screen.getByRole('button', { name: 'Select all remaining items' }))
    expect(screen.getByLabelText('Return Masala tea, original line 2, piece')).toHaveValue('2')
    expect(screen.getByLabelText('Return Masala tea, original line 3, piece')).toHaveValue('1')
    fireEvent.change(screen.getByLabelText('Reason for return'), {
      target: { value: 'Return remaining' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review return' }))
    await screen.findByText('Review this exact return')
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).request.lines).toEqual([
      { lineNumber: 1, quantityMilli: 1000 },
      { lineNumber: 2, quantityMilli: 2000 },
      { lineNumber: 3, quantityMilli: 1000 },
    ])
  })
  it.each(['0', '1.001', '0.0001', '1e-3', '-1'])(
    'blocks invalid/excess weight %s before preview',
    async (value) => {
      render(<PartialReturnPanel {...props()} />)
      await selectCake()
      fireEvent.change(screen.getByLabelText('Return Pistachio cake, original line 1, kg'), {
        target: { value },
      })
      expect(screen.getByRole('button', { name: 'Review return' })).toBeDisabled()
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )
  it('requires whole piece quantities and resets the exact preview on reason or quantity changes', async () => {
    render(<PartialReturnPanel {...props()} />)
    await reviewCake()
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm these exact items/ }))
    fireEvent.change(screen.getByLabelText('Reason for return'), {
      target: { value: 'New reason' },
    })
    expect(screen.queryByRole('button', { name: 'Issue credit note' })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Masala tea, original line 2' }))
    fireEvent.change(screen.getByLabelText('Return Masala tea, original line 2, piece'), {
      target: { value: '0.5' },
    })
    expect(screen.getByRole('button', { name: 'Review return' })).toBeDisabled()
  })
  it('rejects altered preview allocations or identity without rendering money or enabling submission', async () => {
    fetcher.mockImplementation(async (_path, options) => {
      if (options?.method !== 'POST') return response({ status: 'ready', state })
      const preview = previewFor(state, JSON.parse(String(options.body)).request)
      return response({ status: 'ready', preview: { ...preview, invoiceId: id(99) } })
    })
    const p = props()
    render(<PartialReturnPanel {...p} />)
    await selectCake()
    fireEvent.click(screen.getByRole('button', { name: 'Review return' }))
    await screen.findByRole('alert')
    expect(screen.queryByText('Review this exact return')).toBeNull()
    expect(p.onCommit).not.toHaveBeenCalled()
  })
  it('requires new authoritative read after stale preview and preserves the invoice', async () => {
    fetcher.mockImplementation(async (_path, options) =>
      options?.method === 'POST'
        ? response({ code: 'POS_RETURN_STALE' }, 409)
        : response({ status: 'ready', state })
    )
    render(<PartialReturnPanel {...props()} />)
    await selectCake()
    fireEvent.click(screen.getByRole('button', { name: 'Review return' }))
    await screen.findByText(/Another credit changed this invoice/)
    expect(screen.queryByRole('button', { name: 'Review return' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check remaining items' }))
    await screen.findByLabelText('Reason for return')
    expect(screen.queryByRole('button', { name: 'Issue credit note' })).toBeNull()
  })
  it('records zero-value discounted quantities without inventing a payment', async () => {
    state = stateFor(offeredInvoice)
    const free = offeredInvoice.lines.find((line) => line.grossFils === 0)!
    const p = { ...props(), invoice: offeredInvoice }
    render(<PartialReturnPanel {...p} />)
    const choose = await screen.findByRole('checkbox', {
      name: `Select ${free.name}, original line ${free.lineNumber}`,
    })
    fireEvent.click(choose)
    fireEvent.change(screen.getByLabelText('Reason for return'), {
      target: { value: 'Free item returned' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review return' }))
    await screen.findByText(/No refund is due/)
    expect(screen.queryByText('Cash to return')).toBeNull()
    expect(screen.queryByText('Card refund to arrange on terminal')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm these exact items/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Issue credit note' }))
    await waitFor(() => expect(p.onCommit).toHaveBeenCalledTimes(1))
  })
  it('drops late preview callbacks after actor changes and after page pause', async () => {
    let resolve!: (value: Response) => void
    fetcher.mockImplementation(async (_path, options) =>
      options?.method === 'POST'
        ? new Promise((done) => {
            resolve = done
          })
        : response({ status: 'ready', state })
    )
    const p = props(),
      view = render(<PartialReturnPanel {...p} />)
    await selectCake()
    fireEvent.click(screen.getByRole('button', { name: 'Review return' }))
    const request = JSON.parse(String(fetcher.mock.calls[1][1]?.body)).request
    view.rerender(<PartialReturnPanel {...p} actorId={id(88)} />)
    await act(async () =>
      resolve(response({ status: 'ready', preview: previewFor(state, request) }))
    )
    expect(screen.queryByText('Review this exact return')).toBeNull()
    expect(p.onCommit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Check remaining items' }))
    await selectCake()
    fireEvent.click(screen.getByRole('button', { name: 'Review return' }))
    fireEvent(window, new Event('pagehide'))
    await act(async () =>
      resolve(response({ status: 'ready', preview: previewFor(state, request) }))
    )
    expect(screen.queryByText('Review this exact return')).toBeNull()
  })
  it('invalidates a pending preview when financial actions are paused', async () => {
    let resolve!: (value: Response) => void
    fetcher.mockImplementation(async (_path, options) =>
      options?.method === 'POST'
        ? new Promise((done) => {
            resolve = done
          })
        : response({ status: 'ready', state })
    )
    const p = props(),
      view = render(<PartialReturnPanel {...p} />)
    await selectCake()
    fireEvent.click(screen.getByRole('button', { name: 'Review return' }))
    const request = JSON.parse(String(fetcher.mock.calls[1][1]?.body)).request
    view.rerender(<PartialReturnPanel {...p} mayWrite={false} />)
    await act(async () =>
      resolve(response({ status: 'ready', preview: previewFor(state, request) }))
    )
    view.rerender(<PartialReturnPanel {...p} />)
    expect(screen.queryByText('Review this exact return')).toBeNull()
  })
  it('does not start preview or commit while a saved request exists', async () => {
    const p = { ...props(), pending: true }
    render(<PartialReturnPanel {...p} />)
    await screen.findByText(/Resolve the exact saved request/)
    const review = await screen.findByRole('button', { name: 'Review return' })
    expect(review).toBeDisabled()
    fireEvent.click(review)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(p.onCommit).not.toHaveBeenCalled()
  })
  it('prints original allocations and preceding/remaining invoice balances for repeated credits', () => {
    const request: ReturnRequest = {
      branchId: invoice.branchId,
      deviceId: invoice.deviceId,
      shiftId: invoice.shiftId,
      orderId: invoice.orderId,
      invoiceId: invoice.id,
      expectedRevision: 1,
      lines: [{ lineNumber: 1, quantityMilli: 125 }],
      reason: 'Returned cake',
    }
    const bill = creditFor(state, request)
    render(<FiscalReceipt document={bill} />)
    const adjustment = screen.getByRole('region', { name: 'Invoice adjustment history' })
    expect(within(adjustment).getByText('Before this credit, excluding VAT')).toBeVisible()
    expect(within(adjustment).getByText('Remaining VAT')).toBeVisible()
    expect(screen.getByText(/Original line 1/)).toBeVisible()
    expect(screen.getByText('Card refund to arrange')).toBeVisible()
    expect(screen.queryByText('Card recorded refund recorded')).toBeNull()
    expect(screen.queryByText('Invoice total after full credit: AED 0.00')).toBeNull()
  })
})

describe('actual PostgreSQL return output through the interactive UI', () => {
  it.each(sqlReturns.vectors)('$label', async (vector) => {
    const original = returnStateSchema.parse(vector.state)
    const request = returnRequestSchema.parse(vector.request)
    const commit = vi.fn(async () => {})
    fetcher.mockImplementation(async (_path, options) =>
      options?.method === 'POST'
        ? response({
            status: 'ready',
            preview: {
              ...vector.preview,
              payments: vector.preview.totals.grossFils
                ? [{ method: 'cash', amountFils: vector.preview.totals.grossFils }]
                : [],
            },
          })
        : response({ status: 'ready', state: original })
    )
    render(
      <PartialReturnPanel
        invoice={original.invoice}
        actorId={vector.result.creditNote.actorId}
        deviceId={request.deviceId}
        shiftId={request.shiftId}
        online
        mayWrite
        pending={false}
        onCommit={commit}
      />
    )
    for (const selected of request.lines) {
      const line = original.invoice.lines.find((line) => line.lineNumber === selected.lineNumber)!
      const checkbox = await screen.findByRole('checkbox', {
        name: `Select ${line.name}, original line ${line.lineNumber}`,
      })
      fireEvent.click(checkbox)
      fireEvent.change(
        screen.getByLabelText(
          `Return ${line.name}, original line ${line.lineNumber}, ${line.unit}`
        ),
        { target: { value: String(selected.quantityMilli / 1000) } }
      )
    }
    fireEvent.change(screen.getByLabelText('Reason for return'), {
      target: { value: request.reason },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review return' }))
    await screen.findByRole('heading', { name: 'Review this exact return' })
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({ request: { ...request, refundMethod: 'cash' } })
    expect(commit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm these exact items/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Issue credit note' }))
    await waitFor(() =>
      expect(commit).toHaveBeenCalledExactlyOnceWith({ ...request, refundMethod: 'cash' }, vector.preview.quoteHash)
    )
  })
})
