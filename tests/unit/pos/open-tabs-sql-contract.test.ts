import { expect, it } from 'vitest'
import fixture from '../../fixtures/pos-open-tabs-output.json'
import {
  openOrderListSchema,
  openOrderDetailSchema,
  openOrderUpdateResultSchema,
  openOrderCancellationSchema,
  openOrderCommandSchema,
  openOrderAckMatches,
} from '@/lib/pos/server/open-order-contracts'
import { liveOrderSchema } from '@/lib/pos/server/live-contracts'
import { fiscalDocumentSchema } from '@/lib/pos/server/documents'
import { invoiceMatchesSale, settlementMatchesSale } from '@/lib/pos/server/sale-ack'

it('accepts actual isolated PostgreSQL tables, shared orders and immutable command responses', () => {
  expect(openOrderListSchema.parse(fixture.list).openCount).toBeGreaterThan(0)
  expect(openOrderDetailSchema.parse(fixture.detail).tab.status).toBe('open')
  expect(openOrderCancellationSchema.parse(fixture.cancelled).status).toBe('cancelled')
  for (const [request, response] of [
    [fixture.tableCommand, fixture.tableUpdated],
    [fixture.draftCommand, fixture.tabUpdated],
  ]) {
    const command = openOrderCommandSchema.parse(request)
    const result = openOrderUpdateResultSchema.parse(response)
    expect(openOrderAckMatches(command, result)).toBe(true)
    expect(openOrderAckMatches({ ...command, id: crypto.randomUUID() }, result)).toBe(false)
  }
})

it('accepts actual v1 and offered v2 settlement receipts without losing the source order proof', () => {
  for (const [request, response] of [
    [fixture.linkedOrder, fixture.settled],
    [fixture.offeredOrder, fixture.offeredSettlement],
  ]) {
    const order = liveOrderSchema.parse({ order: request }).order
    const result = response as typeof fixture.settled
    const receipt = fiscalDocumentSchema.parse(result.receipt)
    expect(invoiceMatchesSale(order, receipt)).toBe(true)
    expect(settlementMatchesSale(order, result)).toBe(true)
    expect(settlementMatchesSale(order, { ...result, settledTab: undefined })).toBe(false)
    expect(
      settlementMatchesSale(order, {
        ...result,
        settledTab: { ...result.settledTab, revision: result.settledTab.revision + 1 },
      })
    ).toBe(false)
  }
})
