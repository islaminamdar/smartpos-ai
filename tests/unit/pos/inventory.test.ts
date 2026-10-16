import { expect, it, describe } from 'vitest'
import {
  formatStockQuantity,
  parseStockQuantity,
  inventoryCommandSchema,
  inventoryItemSchema,
  inventoryListSchema,
  inventoryHistorySchema,
  inventoryMovementSchema,
  inventoryQuerySchema,
  inventoryResultMatches,
  inventoryResultSchema,
} from '@/lib/pos/inventory'
const id = '10000000-0000-4000-8000-000000000001',
  other = '20000000-0000-4000-8000-000000000002',
  now = '2026-10-16T14:00:00.123456+00:00'
export const stockItem = {
  id,
  branchId: id,
  name: 'Sugar',
  sku: 'SUGAR',
  unit: 'kg' as const,
  reorderLevelMilli: 5000,
  active: true,
  revision: 1,
  onHandMilli: null,
  createdAt: now,
  updatedAt: now,
  movementCount: 0,
}
const command = {
  id,
  type: 'stock.count' as const,
  branchId: id,
  deviceId: id,
  itemId: id,
  expectedRevision: 1,
  quantityMilli: 10000,
  reason: 'Opening count',
  reference: null,
}
const movement = {
  id,
  itemId: id,
  type: 'stock.count',
  quantityMilli: 10000,
  beforeMilli: null,
  deltaMilli: null,
  afterMilli: 10000,
  reason: 'Opening count',
  reference: null,
  actorId: id,
  deviceId: id,
  actorName: 'Manager',
  deviceName: 'Counter 1',
  recordedAt: now,
  revision: 2,
}
const result = {
  status: 'applied',
  requestId: id,
  replayed: false,
  item: { ...stockItem, revision: 2, onHandMilli: 10000, movementCount: 1 },
  movement,
}
describe('stock precision and truthful balances', () => {
  it.each([
    ['0', 'kg', 0],
    ['0.001', 'kg', 1],
    ['12.345', 'litre', 12345],
    ['2.000', 'piece', 2000],
    ['1000000000', 'kg', 1000000000000],
  ] as const)('parses %s %s exactly', (s, unit, milli) => {
    expect(parseStockQuantity(s, unit)).toBe(milli)
    expect(parseStockQuantity(formatStockQuantity(milli, unit), unit)).toBe(milli)
  })
  it('keeps signed adjustments exact, never silently rounds or accepts exponent notation', () => {
    expect(parseStockQuantity('-0.001', 'kg', true)).toBe(-1)
    expect(formatStockQuantity(-12345, 'litre')).toBe('-12.345')
    for (const s of ['1e3', '1.0001', 'NaN', '1,000', '-1', '1.', '1000000000.001', ''])
      expect(() => parseStockQuantity(s, 'kg')).toThrow()
    expect(() => parseStockQuantity('1.5', 'piece')).toThrow()
    expect(() => formatStockQuantity(1500, 'piece')).toThrow()
  })
  it('distinguishes uncounted from measured zero and rejects contradictory stock projections', () => {
    expect(inventoryItemSchema.safeParse(stockItem).success).toBe(true)
    expect(inventoryItemSchema.safeParse({ ...stockItem, onHandMilli: 0 }).success).toBe(false)
    expect(
      inventoryItemSchema.safeParse({ ...stockItem, onHandMilli: 0, movementCount: 1, revision: 2 })
        .success
    ).toBe(true)
    for (const patch of [
      { onHandMilli: -1 },
      { onHandMilli: 0.1 },
      { revision: 1, movementCount: 1, onHandMilli: 0 },
      { unit: 'piece', reorderLevelMilli: 1 },
      { movementCount: 1, onHandMilli: null },
      { onHandMilli: 1000000000001 },
    ])
      expect(inventoryItemSchema.safeParse({ ...stockItem, ...patch }).success).toBe(false)
  })
  it('records opening count without inventing a received delta and validates every movement arithmetic', () => {
    expect(inventoryMovementSchema.safeParse(movement).success).toBe(true)
    expect(inventoryMovementSchema.safeParse({ ...movement, deltaMilli: 10000 }).success).toBe(
      false
    )
    for (const type of ['stock.receive', 'stock.waste', 'stock.adjust'])
      expect(inventoryMovementSchema.safeParse({ ...movement, type }).success).toBe(false)
    expect(
      inventoryMovementSchema.safeParse({
        ...movement,
        type: 'stock.waste',
        quantityMilli: 3000,
        beforeMilli: 10000,
        deltaMilli: -3000,
        afterMilli: 7000,
      }).success
    ).toBe(true)
    expect(
      inventoryMovementSchema.safeParse({
        ...movement,
        type: 'stock.waste',
        quantityMilli: 3000,
        beforeMilli: 10000,
        deltaMilli: 3000,
        afterMilli: 13000,
      }).success
    ).toBe(false)
  })
  it('rejects actual NUL while allowing literal backslash-u text', () => {
    const nul = String.fromCharCode(0),
      literal = String.fromCharCode(92) + 'u0000'
    expect(inventoryCommandSchema.safeParse({ ...command, reason: 'A' + nul + 'B' }).success).toBe(
      false
    )
    expect(
      inventoryCommandSchema.safeParse({ ...command, reason: 'A' + literal + 'B' }).success
    ).toBe(true)
    expect(
      inventoryQuerySchema.safeParse({ search: nul, filter: 'all', afterId: null }).success
    ).toBe(false)
    expect(
      inventoryQuerySchema.safeParse({ search: literal, filter: 'all', afterId: null }).success
    ).toBe(true)
  })
  it('rejects zero/negative receives, fractional storage quantities, wrong reference and injected authority', () => {
    for (const patch of [
      { type: 'stock.receive', quantityMilli: 0 },
      { type: 'stock.waste', quantityMilli: -1 },
      { type: 'stock.adjust', quantityMilli: 0 },
      { expectedRevision: 0 },
      { quantityMilli: 1.1 },
      { quantityMilli: 1000000000001 },
      { reference: '' },
      { actorId: id },
    ])
      expect(inventoryCommandSchema.safeParse({ ...command, ...patch }).success).toBe(false)
    expect(
      inventoryCommandSchema.safeParse({ ...command, type: 'stock.adjust', quantityMilli: -1 })
        .success
    ).toBe(true)
    expect(inventoryCommandSchema.safeParse({ ...command, quantityMilli: 0 }).success).toBe(true)
  })
  it('binds saved confirmations to exact original command and arithmetic, including cancellation', () => {
    const parsed = inventoryResultSchema.parse(result)
    expect(inventoryResultMatches(parsed, command)).toBe(true)
    expect(inventoryResultMatches(parsed, { ...command, id: other })).toBe(false)
    expect(inventoryResultMatches(parsed, { ...command, quantityMilli: 9000 })).toBe(false)
    expect(inventoryResultMatches(parsed, { ...command, reason: 'Other' })).toBe(false)
    expect(inventoryResultMatches(parsed, { ...command, deviceId: other })).toBe(false)
    expect(
      inventoryResultSchema.safeParse({ ...result, movement: { ...movement, revision: 3 } }).success
    ).toBe(false)
    expect(
      inventoryResultSchema.safeParse({ ...result, movement: { ...movement, afterMilli: 5 } })
        .success
    ).toBe(false)
    expect(
      inventoryResultMatches({ status: 'cancelled', requestId: id, replayed: true }, command)
    ).toBe(true)
  })
  it('rejects cross-branch, duplicate, unsorted and contradictory list/history snapshots', () => {
    const list = {
      status: 'ready',
      branchId: id,
      asOf: now,
      counts: {
        totalItems: 1,
        activeItems: 1,
        inactiveItems: 0,
        lowStockItems: 0,
        uncountedItems: 1,
      },
      matchingItems: 1,
      items: [stockItem],
      nextCursor: null,
    }
    expect(inventoryListSchema.safeParse(list).success).toBe(true)
    for (const patch of [
      { items: [{ ...stockItem, branchId: other }] },
      { items: [stockItem, stockItem], matchingItems: 2 },
      { nextCursor: id },
      { counts: { ...list.counts, lowStockItems: 1 } },
      { matchingItems: 0 },
    ])
      expect(inventoryListSchema.safeParse({ ...list, ...patch }).success).toBe(false)
    const h = {
      status: 'ready',
      branchId: id,
      asOf: now,
      item: result.item,
      entries: [movement],
      nextBeforeRevision: null,
    }
    expect(inventoryHistorySchema.safeParse(h).success).toBe(true)
    expect(inventoryHistorySchema.safeParse({ ...h, entries: [movement, movement] }).success).toBe(
      false
    )
    expect(
      inventoryHistorySchema.safeParse({ ...h, entries: [{ ...movement, itemId: other }] }).success
    ).toBe(false)
  })
})

it('preserves SQL-valid Unicode snapshots while keeping browser command input canonical', () => {
  const name = '\t' + '😀'.repeat(159),
    reason = '\t' + '😀'.repeat(239),
    reference = '\t' + '😀'.repeat(119)
  const item = { ...stockItem, name },
    entry = {
      ...movement,
      reason,
      reference,
      actorName: '\t' + '😀'.repeat(119),
      deviceName: '\t' + '😀'.repeat(79),
    }
  expect(inventoryItemSchema.parse(item).name).toBe(name)
  expect(inventoryMovementSchema.parse(entry)).toEqual(entry)
  expect(inventoryItemSchema.safeParse({ ...item, name: name + 'x' }).success).toBe(false)
  expect(inventoryItemSchema.safeParse({ ...item, name: ' ' + name }).success).toBe(false)
  expect(inventoryMovementSchema.safeParse({ ...entry, reason: reason + 'x' }).success).toBe(false)
  expect(inventoryCommandSchema.safeParse({ ...command, reason }).success).toBe(false)
  expect(
    inventoryMovementSchema.safeParse({ ...entry, actorName: 'A' + String.fromCharCode(0) }).success
  ).toBe(false)
})
