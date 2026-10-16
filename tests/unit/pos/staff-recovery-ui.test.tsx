import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import PendingAccessRecovery from '@/components/pos/staff/PendingAccessRecovery'
const mock = vi.hoisted(() => ({ pending: null as unknown, acknowledge: vi.fn() }))
vi.mock('@/lib/pos/online-journal', () => ({
  readPendingRequest: async () => mock.pending,
  acknowledgePendingRequest: mock.acknowledge,
}))
const actor = '30000000-0000-4000-8000-000000000001',
  branch = '10000000-0000-4000-8000-000000000001',
  device = '20000000-0000-4000-8000-000000000001',
  id = '40000000-0000-4000-8000-000000000001'
const command = {
  id,
  branchId: branch,
  deviceId: device,
  shiftId: id,
  type: 'shift.open',
  openingCashFils: 1000,
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
beforeEach(() => {
  mock.acknowledge.mockReset()
  mock.pending = {
    actorId: actor,
    branchId: branch,
    deviceId: device,
    id,
    endpoint: '/api/pos/commands',
    body: { command },
    savedAt: new Date().toISOString(),
  }
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
function serve(result: unknown, status = 200) {
  const calls: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/pos/session') return response({ userId: actor })
      if (url !== '/api/pos/recovery') throw new Error('Unexpected dispatch')
      calls.push(JSON.parse(options!.body as string))
      return response(result, status)
    })
  )
  return calls
}
it('recovers an exact committed action without dispatching the action again', async () => {
  const calls = serve({ status: 'applied', commandId: id, replayed: true })
  render(<PendingAccessRecovery />)
  fireEvent.click(await screen.findByRole('button', { name: 'Check saved request' }))
  await screen.findByText(/The server confirmed the original request was saved/)
  expect(calls).toEqual([{ kind: 'command', request: command }])
  expect(mock.acknowledge).toHaveBeenCalledWith(actor, id)
})
it('keeps an unsaved inactive actor request and asks for restored access', async () => {
  serve({ code: 'staff_inactive' }, 403)
  render(<PendingAccessRecovery />)
  fireEvent.click(await screen.findByRole('button', { name: 'Check saved request' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Ask your manager to restore your access'
  )
  expect(mock.acknowledge).not.toHaveBeenCalled()
})
it('rejects a different request acknowledgement and keeps the journal', async () => {
  serve({ status: 'applied', commandId: '50000000-0000-4000-8000-000000000001' })
  render(<PendingAccessRecovery />)
  fireEvent.click(await screen.findByRole('button', { name: 'Check saved request' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('did not match')
  expect(mock.acknowledge).not.toHaveBeenCalled()
})
it('clears a matching durable cancellation and explains money reconciliation', async () => {
  serve({ status: 'cancelled', requestId: id, kind: 'command', replayed: false })
  render(<PendingAccessRecovery />)
  fireEvent.click(await screen.findByRole('button', { name: 'Check saved request' }))
  await screen.findByText(/Reconcile any money already collected or returned/)
  expect(mock.acknowledge).toHaveBeenCalledWith(actor, id)
})

it.each([false, true])(
  'validates full credit-note actor identity before clearing (foreign=%s)',
  async (foreign) => {
    const fixture = await import('../../fixtures/pos-offer-documents.json')
    const credit = { ...fixture.credit, actorId: foreign ? fixture.credit.actorId : actor }
    const refund = {
      id,
      branchId: credit.branchId,
      deviceId: credit.deviceId,
      shiftId: credit.shiftId,
      type: 'refund.full',
      orderId: credit.orderId,
      reason: 'Synthetic refund review',
    }
    mock.pending = {
      actorId: actor,
      branchId: credit.branchId,
      deviceId: credit.deviceId,
      id,
      endpoint: '/api/pos/commands',
      body: { command: refund },
      savedAt: new Date().toISOString(),
    }
    serve({ status: 'applied', commandId: id, replayed: true, creditNote: credit })
    render(<PendingAccessRecovery />)
    fireEvent.click(await screen.findByRole('button', { name: 'Check saved request' }))
    if (foreign) {
      expect(await screen.findByRole('alert')).toHaveTextContent('another account or counter')
      expect(mock.acknowledge).not.toHaveBeenCalled()
    } else {
      await screen.findByText(/The server confirmed the original request was saved/)
      expect(mock.acknowledge).toHaveBeenCalledWith(actor, id)
    }
  }
)
