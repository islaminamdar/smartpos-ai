import { z } from 'zod'

export const MAX_STOCK_MILLI = 1_000_000_000_000
export const inventoryUnitSchema = z.enum(['kg', 'litre', 'piece'])
export type StockUnit = z.infer<typeof inventoryUnitSchema>
const id = z.string().uuid()
const quantity = z.number().int().min(0).max(MAX_STOCK_MILLI)
const signedQuantity = z.number().int().min(-MAX_STOCK_MILLI).max(MAX_STOCK_MILLI)
const revision = z.number().int().min(1).max(2_147_483_646)
const time = z.string().datetime({ offset: true })
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s === s.trim() && !s.includes('\u0000'))
// Stored SQL text counts Unicode codepoints and btrim removes ASCII spaces.
// Preserve immutable snapshots exactly; browser input normalization is separate.
const storedText = (max: number, asciiTrimmed = true) =>
  z
    .string()
    .min(1)
    .max(max * 2)
    .refine(
      (s) =>
        Array.from(s).length <= max &&
        !s.includes('\u0000') &&
        (!asciiTrimmed || s === s.replace(/^ +| +$/g, ''))
    )
const editableItem = z
  .object({
    id,
    name: text(160),
    sku: z
      .string()
      .regex(/^[A-Z0-9._-]{1,64}$/)
      .nullable(),
    unit: inventoryUnitSchema,
    reorderLevelMilli: quantity,
    active: z.boolean(),
  })
  .strict()
export const inventoryItemSchema = editableItem
  .extend({
    name: storedText(160),
    branchId: id,
    revision,
    onHandMilli: quantity.nullable(),
    createdAt: time,
    updatedAt: time,
    movementCount: z.number().int().min(0).max(2_147_483_645),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (
      item.unit === 'piece' &&
      (item.reorderLevelMilli % 1000 !== 0 ||
        (item.onHandMilli !== null && item.onHandMilli % 1000 !== 0))
    )
      ctx.addIssue({ code: 'custom', message: 'Pieces must be whole quantities.' })
    if (
      (item.onHandMilli === null) !== (item.movementCount === 0) ||
      item.movementCount >= item.revision
    )
      ctx.addIssue({ code: 'custom', message: 'Stock initialization or revision mismatch.' })
  })
export type StockItem = z.infer<typeof inventoryItemSchema>
const base = {
  id,
  branchId: id,
  deviceId: id,
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  reason: text(240),
}
const movementTypes = ['stock.receive', 'stock.waste', 'stock.count', 'stock.adjust'] as const
export const inventoryMovementTypeSchema = z.enum(movementTypes)
export const inventoryCommandSchema = z
  .union([
    z.object({ ...base, type: z.literal('item.save'), item: editableItem }).strict(),
    z
      .object({
        ...base,
        type: inventoryMovementTypeSchema,
        itemId: id,
        quantityMilli: signedQuantity,
        reference: text(120).nullable(),
      })
      .strict(),
  ])
  .superRefine((command, ctx) => {
    if (command.type === 'item.save') {
      if (command.item.unit === 'piece' && command.item.reorderLevelMilli % 1000 !== 0)
        ctx.addIssue({ code: 'custom', message: 'Pieces must be whole quantities.' })
    } else if (
      command.expectedRevision < 1 ||
      (command.type === 'stock.count'
        ? command.quantityMilli < 0
        : command.type === 'stock.adjust'
          ? command.quantityMilli === 0
          : command.quantityMilli <= 0)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid stock quantity or revision.' })
  })
export type InventoryCommand = z.infer<typeof inventoryCommandSchema>
export const inventoryMovementSchema = z
  .object({
    id,
    itemId: id,
    type: inventoryMovementTypeSchema,
    quantityMilli: signedQuantity,
    beforeMilli: quantity.nullable(),
    deltaMilli: signedQuantity.nullable(),
    afterMilli: quantity,
    reason: storedText(240),
    reference: storedText(120).nullable(),
    actorId: id,
    deviceId: id,
    actorName: storedText(160, false),
    deviceName: storedText(120, false),
    recordedAt: time,
    revision,
  })
  .strict()
  .superRefine((m, ctx) => {
    const delta = m.beforeMilli === null ? null : m.afterMilli - m.beforeMilli
    const expected =
      m.type === 'stock.count'
        ? m.quantityMilli
        : m.beforeMilli === null
          ? null
          : m.beforeMilli + (m.type === 'stock.waste' ? -m.quantityMilli : m.quantityMilli)
    if (
      m.deltaMilli !== delta ||
      m.afterMilli !== expected ||
      (m.type === 'stock.count'
        ? m.quantityMilli < 0
        : m.type === 'stock.adjust'
          ? m.quantityMilli === 0
          : m.quantityMilli <= 0)
    )
      ctx.addIssue({ code: 'custom', message: 'Stock movement arithmetic mismatch.' })
  })
export type StockMovement = z.infer<typeof inventoryMovementSchema>
const applied = z
  .object({
    status: z.literal('applied'),
    requestId: id,
    replayed: z.boolean(),
    item: inventoryItemSchema,
    movement: inventoryMovementSchema.nullable(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      r.movement &&
      (r.movement.id !== r.requestId ||
        r.movement.itemId !== r.item.id ||
        r.movement.revision !== r.item.revision ||
        r.movement.afterMilli !== r.item.onHandMilli ||
        (r.item.unit === 'piece' &&
          [
            r.movement.quantityMilli,
            r.movement.beforeMilli,
            r.movement.deltaMilli,
            r.movement.afterMilli,
          ].some((n) => n !== null && n % 1000 !== 0)))
    )
      ctx.addIssue({ code: 'custom', message: 'Movement confirmation mismatch.' })
  })
const cancelled = z
  .object({ status: z.literal('cancelled'), requestId: id, replayed: z.boolean() })
  .strict()
export const inventoryResultSchema = z.union([applied, cancelled])
export const inventoryRecoverySchema = z.union([
  applied,
  cancelled,
  z.object({ status: z.literal('not_found'), requestId: id }).strict(),
])
export type InventoryResult = z.infer<typeof inventoryResultSchema>
export type InventoryRecovery = z.infer<typeof inventoryRecoverySchema>
export const inventoryFilterSchema = z.enum(['all', 'low', 'uncounted', 'inactive'])
export const inventoryQuerySchema = z
  .object({
    search: z
      .string()
      .trim()
      .max(160)
      .refine((s) => !s.includes('\u0000')),
    filter: inventoryFilterSchema,
    afterId: id.nullable(),
  })
  .strict()
export const inventoryListSchema = z
  .object({
    status: z.literal('ready'),
    branchId: id,
    asOf: time,
    counts: z
      .object({
        totalItems: z.number().int().min(0).max(1000),
        activeItems: z.number().int().min(0).max(1000),
        inactiveItems: z.number().int().min(0).max(1000),
        lowStockItems: z.number().int().min(0).max(1000),
        uncountedItems: z.number().int().min(0).max(1000),
      })
      .strict(),
    matchingItems: z.number().int().min(0).max(1000),
    items: z.array(inventoryItemSchema).max(50),
    nextCursor: id.nullable(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const c = r.counts
    if (
      c.totalItems !== c.activeItems + c.inactiveItems ||
      c.lowStockItems + c.uncountedItems > c.activeItems ||
      r.matchingItems > c.totalItems ||
      r.items.length > r.matchingItems ||
      r.items.some(
        (item, index) =>
          item.branchId !== r.branchId || (index > 0 && r.items[index - 1].id >= item.id)
      ) ||
      (r.nextCursor !== null && (r.items.length !== 50 || r.nextCursor !== r.items.at(-1)?.id))
    )
      ctx.addIssue({ code: 'custom', message: 'Inventory snapshot mismatch.' })
  })
export type InventoryList = z.infer<typeof inventoryListSchema>
export const inventoryHistorySchema = z
  .object({
    status: z.literal('ready'),
    branchId: id,
    asOf: time,
    item: inventoryItemSchema,
    entries: z.array(inventoryMovementSchema).max(50),
    nextBeforeRevision: revision.nullable(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      r.item.branchId !== r.branchId ||
      r.entries.length > r.item.movementCount ||
      r.entries.some(
        (m, i) =>
          m.itemId !== r.item.id ||
          m.revision > r.item.revision ||
          (i > 0 && r.entries[i - 1].revision <= m.revision) ||
          (r.item.unit === 'piece' &&
            [m.quantityMilli, m.beforeMilli, m.deltaMilli, m.afterMilli].some(
              (n) => n !== null && n % 1000 !== 0
            ))
      ) ||
      (r.nextBeforeRevision !== null &&
        (r.entries.length !== 50 || r.nextBeforeRevision !== r.entries.at(-1)?.revision))
    )
      ctx.addIssue({ code: 'custom', message: 'Inventory history mismatch.' })
  })
export type InventoryHistory = z.infer<typeof inventoryHistorySchema>

/** Convert decimal text without floating-point multiplication or silent rounding. */
export function parseStockQuantity(input: string, unit: StockUnit, signed = false): number {
  const value = input.trim()
  if (!(signed ? /^-?\d{1,10}(?:\.\d{1,3})?$/ : /^\d{1,10}(?:\.\d{1,3})?$/).test(value))
    throw new Error('invalid_stock_quantity')
  const negative = value.startsWith('-'),
    [whole, fraction = ''] = value.replace('-', '').split('.')
  const milli = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'))
  if (milli > MAX_STOCK_MILLI || (unit === 'piece' && milli % 1000))
    throw new Error('invalid_stock_quantity')
  return negative && milli !== 0 ? -milli : milli
}
export function formatStockQuantity(milli: number, unit: StockUnit): string {
  if (
    !Number.isSafeInteger(milli) ||
    Math.abs(milli) > MAX_STOCK_MILLI ||
    (unit === 'piece' && milli % 1000)
  )
    throw new Error('invalid_stock_quantity')
  const abs = Math.abs(milli),
    fraction = String(abs % 1000)
      .padStart(3, '0')
      .replace(/0+$/, '')
  return `${milli < 0 ? '-' : ''}${Math.floor(abs / 1000)}${fraction ? '.' + fraction : ''}`
}

/** A saved result describes the original command, not necessarily the latest stock. */
export function inventoryResultMatches(
  result: InventoryRecovery,
  command: InventoryCommand
): boolean {
  if (result.requestId !== command.id) return false
  if (result.status !== 'applied') return true
  const itemId = command.type === 'item.save' ? command.item.id : command.itemId
  if (
    result.item.id !== itemId ||
    result.item.branchId !== command.branchId ||
    result.item.revision !== command.expectedRevision + 1
  )
    return false
  if (command.type === 'item.save')
    return (
      result.movement === null &&
      (Object.keys(command.item) as (keyof typeof command.item)[]).every(
        (key) => result.item[key] === command.item[key]
      )
    )
  const m = result.movement
  return (
    !!m &&
    m.type === command.type &&
    m.quantityMilli === command.quantityMilli &&
    m.reason === command.reason &&
    m.reference === command.reference &&
    m.deviceId === command.deviceId
  )
}
