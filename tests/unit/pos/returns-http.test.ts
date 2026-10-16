import { beforeEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import fixtures from '../../fixtures/pos-offer-documents.json'
import { fiscalDocumentSchema, originalReturnInvoiceSchema } from '@/lib/pos/server/documents'
import {
  originalReturnAmounts,
  allocateReturnLine,
  subtractReturnAmounts,
} from '@/lib/pos/return-allocation'
import { returnStateSchema, returnPreviewSchema } from '@/lib/pos/server/returns'
const m = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), device: vi.fn(), recovery: vi.fn() }))
vi.mock('@/lib/pos/server/client', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/client')>()),
  authenticatedPosClient: m.auth,
}))
vi.mock('@/lib/pos/server/live-access', async (original) => ({
  ...(await original<typeof import('@/lib/pos/server/live-access')>()),
  requireDevice: m.device,
  recoveryBinding: m.recovery,
}))
import { GET, POST } from '@/app/api/pos/returns/route'
import { POST as COMMAND } from '@/app/api/pos/commands/route'
import { POST as RECOVER } from '@/app/api/pos/recovery/route'
import { liveCommandSchema } from '@/lib/pos/server/live-contracts'
import { publicReleaseAccess } from '@/lib/pos/public-release'
const invoice = originalReturnInvoiceSchema.parse(fixtures.receipts[0]),
  id = '00000000-0000-4000-8000-000000000099',
  hash = 'a'.repeat(64)
const amounts = originalReturnAmounts(invoice.totals),
  zero = subtractReturnAmounts(amounts, amounts)
const input = {
  branchId: invoice.branchId,
  deviceId: invoice.deviceId,
  shiftId: invoice.shiftId,
  orderId: invoice.orderId,
  invoiceId: invoice.id,
  expectedRevision: 0,
  lines: invoice.lines.map((l) => ({ lineNumber: l.lineNumber, quantityMilli: l.quantityMilli })),
  reason: 'Synthetic return',
}
const state = returnStateSchema.parse({
  schemaVersion: 1,
  invoice,
  revision: 0,
  returned: invoice.lines.map((l) => ({ lineNumber: l.lineNumber, quantityMilli: 0 })),
  refundedPayments: [],
  adjustedTotals: amounts,
  fullyReturned: false,
})
const preview = returnPreviewSchema.parse({
  ...input,
  schemaVersion: 1,
  lines: invoice.lines.map((l, i) => allocateReturnLine(l, 0, l.quantityMilli, i + 1)),
  previousAdjustedTotals: amounts,
  totals: amounts,
  adjustedTotals: zero,
  payments: invoice.payments,
  fullyReturned: true,
  quoteHash: hash,
})
const { cashTenderedFils: _cash, changeFils: _change, ...original } = invoice
const credit = fiscalDocumentSchema.parse({
  ...Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'appliedOffer')),
  schemaVersion: 3,
  id,
  kind: 'tax_credit_note',
  documentNumber: 'TEST-CN-0000000001',
  reason: input.reason,
  lines: preview.lines,
  totals: amounts,
  payments: invoice.payments,
  originalInvoice: {
    documentId: invoice.id,
    documentNumber: invoice.documentNumber,
    issuedAt: invoice.issuedAt,
    schemaVersion: invoice.schemaVersion,
    totalFils: invoice.totals.grossFils,
    taxFils: invoice.totals.taxFils,
    netFils: invoice.totals.netFils,
    beforeDiscountFils: amounts.beforeDiscountFils,
    discountFils: amounts.discountFils,
  },
  originalOffer: invoice.schemaVersion === 2 ? invoice.appliedOffer : null,
  previousAdjustedTotals: amounts,
  adjustedTotals: zero,
  returnRevision: 1,
  fullyReturned: true,
  quoteHash: hash,
})
const command = { id, type: 'refund.items', ...input, quoteHash: hash },
  ack = { status: 'applied', commandId: id, replayed: false, creditNote: credit }
const req = (body: unknown, origin = 'http://localhost') =>
  new NextRequest('http://localhost/api/pos/returns', {
    method: 'POST',
    headers: { origin },
    body: JSON.stringify(body),
  })
const read = (suffix = '') =>
  new Request(
    `http://localhost/api/pos/returns?branchId=${input.branchId}&deviceId=${input.deviceId}&orderId=${input.orderId}${suffix}`
  )
beforeEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('POS_ONLINE_PILOT', 'true')
  vi.stubEnv('POS_LIVE_SALES_ENABLED', 'true')
  m.auth.mockResolvedValue({ client: { rpc: m.rpc }, user: { id: invoice.actorId } })
  m.device.mockResolvedValue('binding')
  m.recovery.mockResolvedValue('historical-binding')
})
it('reads authoritative state and previews exact request under bound device', async () => {
  m.rpc
    .mockResolvedValueOnce({ data: state, error: null })
    .mockResolvedValueOnce({ data: preview, error: null })
  expect((await GET(read())).status).toBe(200)
  expect((await POST(req({ request: input }))).status).toBe(200)
  expect(m.rpc).toHaveBeenLastCalledWith('pos_preview_return', {
    p_request: input,
    p_binding: 'binding',
  })
})
it('rejects duplicate query, unknown command fields, unordered/duplicate selections and wrong scope responses', async () => {
  expect((await GET(read('&branchId=' + input.branchId))).status).toBe(422)
  expect(liveCommandSchema.safeParse({ command: { ...command, amountFils: 1 } }).success).toBe(
    false
  )
  expect(
    liveCommandSchema.safeParse({
      command: { ...command, lines: [input.lines[0], input.lines[0]] },
    }).success
  ).toBe(false)
  m.rpc.mockResolvedValue({ data: { ...preview, deviceId: id }, error: null })
  expect((await POST(req({ request: input }))).status).toBe(503)
})
it('bounds request, gates new writes and rejects foreign origin', async () => {
  expect((await POST(req({ request: input }, 'https://other.invalid'))).status).toBe(403)
  expect((await POST(req({ padding: 'x'.repeat(32769) }))).status).toBe(413)
  vi.stubEnv('POS_LIVE_SALES_ENABLED', 'false')
  expect((await POST(req({ request: input }))).status).toBe(503)
  m.rpc.mockResolvedValue({ data: state, error: null })
  expect((await GET(read())).status).toBe(200)
})
it('checks exact item-return acknowledgement including saved hash, quantity and actor', async () => {
  m.rpc.mockResolvedValue({ data: ack, error: null })
  expect((await COMMAND(req({ command }))).status).toBe(200)
  for (const change of [
    { quoteHash: 'b'.repeat(64) },
    { actorId: id },
    { shiftId: id },
    { reason: 'Changed' },
  ]) {
    m.rpc.mockResolvedValue({ data: { ...ack, creditNote: { ...credit, ...change } }, error: null })
    expect((await COMMAND(req({ command }))).status).toBe(503)
  }
})
it('historical recovery survives paused writes and current membership loss but never accepts changed result', async () => {
  vi.stubEnv('POS_LIVE_SALES_ENABLED', 'false')
  m.rpc
    .mockResolvedValueOnce({ error: { message: 'POS_ACCESS_DENIED' }, data: null })
    .mockResolvedValueOnce({ data: { ...ack, replayed: true }, error: null })
  expect((await RECOVER(req({ kind: 'command', request: command }))).status).toBe(200)
  expect(m.rpc).toHaveBeenLastCalledWith('pos_lookup_own_committed_request', {
    p_kind: 'command',
    p_request: command,
    p_binding: 'historical-binding',
  })
  m.rpc.mockResolvedValue({
    data: { ...ack, creditNote: { ...credit, quoteHash: 'b'.repeat(64) } },
    error: null,
  })
  expect((await RECOVER(req({ kind: 'command', request: command }))).status).toBe(503)
})
it('returns stale conflicts and keeps exact route exposure', async () => {
  m.rpc.mockResolvedValue({ error: { message: 'POS_RETURN_STALE' }, data: null })
  expect((await COMMAND(req({ command }))).status).toBe(409)
  for (const path of ['/api/pos/returns', '/api/pos/kitchen-returns']) {
    expect(publicReleaseAccess(path, 'GET', true)).toBe('allow')
    expect(publicReleaseAccess(path, 'POST', true)).toBe('allow')
    expect(publicReleaseAccess(path, 'DELETE', true)).not.toBe('allow')
    expect(publicReleaseAccess(path + '/extra', 'GET', true)).not.toBe('allow')
    expect(publicReleaseAccess(path, 'GET', false)).not.toBe('allow')
  }
})

it('maps malformed JSON and SQL validation/profile failures without inventing success', async () => {
  expect(
    (
      await POST(
        new Request('http://localhost/api/pos/returns', {
          method: 'POST',
          headers: { origin: 'http://localhost' },
          body: '{',
        })
      )
    ).status
  ).toBe(400)
  m.rpc.mockResolvedValue({ data: null, error: { message: 'POS_INVALID_COMMAND' } })
  expect((await POST(req({ request: input }))).status).toBe(422)
  m.rpc.mockResolvedValue({ data: null, error: { message: 'POS_PROFILE_REQUIRED' } })
  expect((await POST(req({ request: input }))).status).toBe(503)
})

it('rejects noncanonical new partial-return command IDs without changing historical full commands', () => {
  const upperId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
  expect(liveCommandSchema.safeParse({ command: { ...command, id: upperId } }).success).toBe(false)
  expect(
    liveCommandSchema.safeParse({
      command: {
        id: upperId,
        type: 'refund.full',
        branchId: input.branchId,
        deviceId: input.deviceId,
        shiftId: input.shiftId,
        orderId: input.orderId,
        reason: 'Historical full return',
      },
    }).success
  ).toBe(true)
})
