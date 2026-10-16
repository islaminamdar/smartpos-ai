import { expect, it } from 'vitest'
import { fiscalDocumentSchema } from '@/lib/pos/server/documents'
import { liveOrderSchema } from '@/lib/pos/server/live-contracts'
import { invoiceMatchesSale, settlementMatchesSale } from '@/lib/pos/server/sale-ack'
import fixture from '../../fixtures/pos-tab-kitchen-output.json'
import {
  tabKitchenListSchema,
  tabKitchenDetailSchema,
  tabKitchenTabSchema,
  tabKitchenUpdateResultSchema,
  tabKitchenTicketSchema,
  tabKitchenCancellationSchema,
  tabKitchenCommandSchema,
  tabKitchenAckMatches,
} from '@/lib/pos/server/tab-kitchen'

it('accepts actual isolated SQL dispatch, stage quantities and stable payment/refund projections', () => {
  const first = tabKitchenUpdateResultSchema.parse(fixture.first)
  const command = tabKitchenCommandSchema.parse(fixture.firstCommand)
  expect(tabKitchenAckMatches(command, first)).toBe(true)
  expect(tabKitchenTabSchema.parse(fixture.initialTab).dispatchRequired).toBe(false)
  const added = tabKitchenUpdateResultSchema.parse(fixture.addition)
  expect(added.ticket.stages.served[0].quantityMilli).toBe(8000)
  expect(added.ticket.stages.queued[0].quantityMilli).toBe(2000)
  const paid = tabKitchenTicketSchema.parse(fixture.paid)
  expect(paid.id).toBe(added.ticket.id)
  expect(paid.stages).toEqual(added.ticket.stages)
  expect(tabKitchenListSchema.parse(fixture.refundedList).activeCount).toBeGreaterThan(0)
  expect(tabKitchenCancellationSchema.parse(fixture.cancelled).status).toBe('cancelled')
})

it('accepts immutable old/new notices, bounded withdrawals and contiguous event pagination', () => {
  for (const value of [
    fixture.additionDetail,
    fixture.refundedDetail,
    fixture.reopened,
    fixture.largeWithdrawal,
    fixture.eventPage,
    fixture.eventPage2,
  ])
    expect(tabKitchenDetailSchema.safeParse(value).success).toBe(true)
  const large = tabKitchenDetailSchema.parse(fixture.largeWithdrawal)
  expect(large.events[0].withdrawals).toHaveLength(1)
  expect(large.events[0].withdrawals[0].quantityMilli).toBe(801000)
  const page = tabKitchenDetailSchema.parse(fixture.eventPage)
  const page2 = tabKitchenDetailSchema.parse(fixture.eventPage2)
  expect(page.events).toHaveLength(20)
  expect(page.eventsNextAfter).toBe(page2.events[0].sequence - 1)
})

it('accepts an actual dispatched v2 offered invoice and its later kitchen refund without altering the ACK', () => {
  const order = liveOrderSchema.parse({ order: fixture.offeredOrder }).order
  const receipt = fiscalDocumentSchema.parse(fixture.offeredAck.receipt)
  expect(invoiceMatchesSale(order, receipt)).toBe(true)
  expect(settlementMatchesSale(order, fixture.offeredAck)).toBe(true)
  expect(tabKitchenDetailSchema.parse(fixture.offeredRefund).ticket.payment).toBe('refunded')
  expect(JSON.stringify(receipt)).not.toContain('SYNTHETICONLY')
})
