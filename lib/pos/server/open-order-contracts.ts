import { z } from 'zod'
import { syncOrderSchema, catalogueLineTotals } from './contracts'

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const timestamp = z.string().datetime({ offset: true })
const revision = z.number().int().min(1).max(2_147_483_647)
const expectedRevision = z.number().int().min(0).max(2_147_483_646)
const fils = z.number().int().min(0).max(100_000_000)
const serviceType = z.enum(['dine_in', 'takeaway', 'delivery'])
const reason = z.string().trim().min(1).max(240)
const metadata = {
  label: z.string().trim().min(1).max(120),
  serviceType,
  tableId: uuid.nullable(),
  guestCount: z.number().int().min(1).max(99).nullable(),
  note: z.string().trim().max(400),
}
export const openOrderLineRequestSchema = syncOrderSchema.shape.order.shape.lines.element
  .extend({ productId: uuid, expectedRevision: revision })
  .strict()
const common = { id: uuid, branchId: uuid, deviceId: uuid }
const editable = {
  tabId: uuid,
  expectedRevision,
  ...metadata,
  lines: z.array(openOrderLineRequestSchema).max(200),
}
const tableInput = z
  .object({
    id: uuid,
    name: z.string().trim().min(1).max(80),
    area: z.string().trim().max(80),
    seats: z.number().int().min(1).max(99),
    active: z.boolean(),
  })
  .strict()
export const openOrderCommandSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        ...common,
        type: z.literal('table.save'),
        expectedRevision,
        table: tableInput,
        reason,
      })
      .strict(),
    z.object({ ...common, type: z.literal('tab.save'), ...editable }).strict(),
    z
      .object({
        ...common,
        type: z.literal('tab.reopen'),
        ...editable,
        expectedRevision: expectedRevision.min(1),
        reason,
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal('tab.void'),
        tabId: uuid,
        expectedRevision: expectedRevision.min(1),
        reason,
      })
      .strict(),
  ])
  .superRefine((command, ctx) => {
    if (command.type !== 'tab.save' && command.type !== 'tab.reopen') return
    if (command.tableId && command.serviceType !== 'dine_in')
      ctx.addIssue({ code: 'custom', message: 'Only dine-in orders can use a table.' })
    if (new Set(command.lines.map((line) => line.productId)).size !== command.lines.length)
      ctx.addIssue({ code: 'custom', message: 'Each menu item must appear once.' })
  })
export const openOrderTableSchema = tableInput
  .extend({
    branchId: uuid,
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
    occupiedTabId: uuid.nullable(),
  })
  .strict()
  .refine((table) => table.active || table.occupiedTabId === null, {
    message: 'Inactive tables cannot be occupied.',
  })
const lineSnapshot = z
  .object({
    productId: uuid,
    name: z.string().min(1).max(200),
    category: z.string().min(1).max(120),
    imageUrl: z.string().nullable(),
    unit: z.enum(['piece', 'pack', 'kg']),
    quantityMilli: z.number().int().min(1).max(1_000_000),
    unitPriceFils: fils.min(1),
    taxRateBps: z.number().int().min(0).max(10000),
    revision,
  })
  .strict()
export const openOrderTabSchema = z
  .object({
    id: uuid,
    branchId: uuid,
    revision,
    status: z.enum(['open', 'voided', 'settled']),
    ...metadata,
    lines: z.array(lineSnapshot).max(200),
    subtotalFils: fils,
    taxFils: fils,
    createdBy: uuid,
    updatedBy: uuid,
    createdAt: timestamp,
    updatedAt: timestamp,
    settledOrderId: uuid.nullable(),
  })
  .strict()
  .superRefine((tab, ctx) => {
    if (
      (tab.status === 'settled') !== (tab.settledOrderId !== null) ||
      (tab.tableId && tab.serviceType !== 'dine_in')
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent saved order state.' })
    if (
      new Set(tab.lines.map((line) => line.productId)).size !== tab.lines.length ||
      tab.lines.some((line) => line.unit !== 'kg' && line.quantityMilli % 1000 !== 0)
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent saved order lines.' })
    const totals = tab.lines.map((line) =>
      catalogueLineTotals(line.unitPriceFils, line.quantityMilli, line.taxRateBps)
    )
    if (
      totals.reduce((sum, line) => sum + line.grossFils, 0) !== tab.subtotalFils ||
      totals.reduce((sum, line) => sum + line.taxFils, 0) !== tab.taxFils
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent saved order estimate.' })
  })
const ready = {
  status: z.literal('ready'),
  organizationId: uuid,
  branchId: uuid,
  actorRole: z.enum(['owner', 'manager', 'cashier']),
}
export const openOrderCursorSchema = z.object({ createdAt: timestamp, id: uuid }).strict()
export const openOrderListSchema = z
  .object({
    ...ready,
    generatedAt: timestamp,
    tables: z.array(openOrderTableSchema).max(200),
    openTabs: z.array(openOrderTabSchema).max(100),
    openCount: z.number().int().min(0).max(1000),
    openNextCursor: openOrderCursorSchema.nullable(),
    recentTabs: z.array(openOrderTabSchema).max(50),
    recentTruncated: z.boolean(),
  })
  .strict()
  .superRefine((list, ctx) => {
    const tabs = [...list.openTabs, ...list.recentTabs]
    const occupied = list.tables.filter((table) => table.occupiedTabId)
    if (
      tabs.some((tab) => tab.branchId !== list.branchId) ||
      list.tables.some((table) => table.branchId !== list.branchId) ||
      new Set(tabs.map((tab) => tab.id)).size !== tabs.length ||
      new Set(list.tables.map((table) => table.id)).size !== list.tables.length ||
      new Set(occupied.map((table) => table.occupiedTabId)).size !== occupied.length
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent saved order scope.' })
    if (
      list.openTabs.some((tab) => tab.status !== 'open') ||
      list.recentTabs.some((tab) => tab.status === 'open') ||
      list.openCount < list.openTabs.length ||
      list.openCount < occupied.length
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent saved order counts or states.' })
    for (const tab of list.openTabs) {
      if (
        tab.tableId &&
        !list.tables.some((table) => table.id === tab.tableId && table.occupiedTabId === tab.id)
      )
        ctx.addIssue({ code: 'custom', message: 'Saved order table occupancy does not match.' })
      if (!tab.tableId && occupied.some((table) => table.occupiedTabId === tab.id))
        ctx.addIssue({ code: 'custom', message: 'Unexpected table occupancy.' })
    }
    if (list.openNextCursor) {
      const last = list.openTabs.at(-1)
      if (
        !last ||
        last.id !== list.openNextCursor.id ||
        Date.parse(last.createdAt) !== Date.parse(list.openNextCursor.createdAt)
      )
        ctx.addIssue({ code: 'custom', message: 'Saved order cursor does not match.' })
    }
  })
export const openOrderDetailSchema = z
  .object({ ...ready, tab: openOrderTabSchema })
  .strict()
  .refine((result) => result.branchId === result.tab.branchId, {
    message: 'Saved order branch mismatch.',
  })
const ack = { status: z.literal('updated'), requestId: uuid, replayed: z.boolean() }
export const openOrderUpdateResultSchema = z.union([
  z.object({ ...ack, tab: openOrderTabSchema }).strict(),
  z.object({ ...ack, table: openOrderTableSchema }).strict(),
])
export const openOrderCancellationSchema = z
  .object({
    status: z.literal('cancelled'),
    requestId: uuid,
    replayed: z.boolean(),
  })
  .strict()
export const openOrderQuerySchema = z
  .object({
    branchId: uuid,
    deviceId: uuid,
    tabId: uuid.optional(),
    afterCreatedAt: timestamp.optional(),
    afterId: uuid.optional(),
  })
  .strict()
  .refine((q) => !!q.afterCreatedAt === !!q.afterId && !(q.tabId && q.afterId), {
    message: 'Use a complete cursor or a single saved order.',
  })
export type OpenOrderCommand = z.infer<typeof openOrderCommandSchema>
export type OpenOrderTab = z.infer<typeof openOrderTabSchema>
export type OpenOrderTable = z.infer<typeof openOrderTableSchema>
export type OpenOrderList = z.infer<typeof openOrderListSchema>
export type OpenOrderUpdateResult = z.infer<typeof openOrderUpdateResultSchema>
export function openOrderAckMatches(command: OpenOrderCommand, result: OpenOrderUpdateResult) {
  if (result.requestId !== command.id) return false
  if (command.type === 'table.save') {
    if (!('table' in result)) return false
    const table = result.table
    return (
      table.branchId === command.branchId &&
      table.id === command.table.id &&
      table.revision === command.expectedRevision + 1 &&
      (['name', 'area', 'seats', 'active'] as const).every(
        (key) => table[key] === command.table[key]
      )
    )
  }
  if (!('tab' in result)) return false
  const tab = result.tab
  if (
    tab.branchId !== command.branchId ||
    tab.id !== command.tabId ||
    tab.revision !== command.expectedRevision + 1
  )
    return false
  if (command.type === 'tab.void') return tab.status === 'voided'
  return (
    tab.status === 'open' &&
    (['label', 'serviceType', 'tableId', 'guestCount', 'note'] as const).every(
      (key) => tab[key] === command[key]
    ) &&
    tab.lines.length === command.lines.length &&
    command.lines.every((line) =>
      tab.lines.some(
        (saved) =>
          saved.productId === line.productId &&
          saved.quantityMilli === line.quantityMilli &&
          saved.unitPriceFils === line.expectedUnitPriceFils &&
          saved.taxRateBps === line.expectedTaxRateBps &&
          saved.revision === line.expectedRevision
      )
    )
  )
}
