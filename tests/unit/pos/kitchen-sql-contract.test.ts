import { expect, it } from 'vitest'
import fixture from '../../fixtures/pos-kitchen-output.json'
import {
  kitchenListSchema,
  kitchenUpdateResultSchema,
  kitchenCancellationSchema,
  kitchenTicketSchema,
} from '@/lib/pos/server/kitchen'

it('accepts actual isolated PostgreSQL kitchen RPC responses at the strict HTTP boundary', () => {
  expect(kitchenListSchema.parse(fixture.list).activeCount).toBe(1)
  expect(kitchenUpdateResultSchema.parse(fixture.updated).ticket.status).toBe('preparing')
  expect(kitchenCancellationSchema.parse(fixture.cancelled).status).toBe('cancelled')
  expect(kitchenTicketSchema.parse(fixture.refunded).status).toBe('cancelled')
})
