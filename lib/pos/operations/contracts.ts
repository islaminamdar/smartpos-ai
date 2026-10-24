import { z } from 'zod'
import { dubaiToday, reportDate } from '@/lib/pos/reports/contracts'

const integer = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
const money = integer.nonnegative()
const count = z.number().int().min(0).max(50000)
const timestamp = z.string().datetime({ offset: true }).refine(value =>
  (value.match(/\.(\d+)/)?.[1].length ?? 0) <= 6, 'Use PostgreSQL timestamp precision.')
// Date.parse truncates microseconds. Preserve the remainder for exclusive snapshot boundaries.
const preciseTime = (value: string) => BigInt(Date.parse(value)) * BigInt(1000) +
  BigInt((value.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0').slice(3))
const uuid = z.string().uuid()
export const operationsQuerySchema = z.object({ branchId: uuid }).strict()
const identity = {
  id: uuid,
  deviceId: uuid,
  deviceName: z.string().min(1).max(80),
  openedBy: uuid,
  staffName: z.string().min(1).max(120).nullable(),
  openedAt: timestamp,
}
const page = { totalCount: count, limit: z.literal(20), truncated: z.boolean() }
const stages = z.object({ queued: count, preparing: count, ready: count }).strict()
const summary = z.object({
  invoiceCount: count,
  creditNoteCount: count,
  salesGrossFils: money,
  refundGrossFils: money,
  netGrossFils: integer,
  netExVatFils: integer,
  vatFils: integer,
}).strict()

/** A single server snapshot. Device-local records and payment-provider settlements are unknown. */
const operationsSnapshotShape = z.object({
  schemaVersion: z.literal(1),
  status: z.literal('ready'),
  branchId: uuid,
  branchName: z.string().min(1).max(120),
  currency: z.literal('AED'),
  timezone: z.literal('Asia/Dubai'),
  businessDate: reportDate,
  generatedAt: timestamp,
  basis: z.literal('server_recorded'),
  offlineDeviceCoverage: z.literal('unknown'),
  sales: z.object({
    documentCount: count,
    legacyOrdersExcluded: count,
    summary,
    payments: z.array(z.object({
      method: z.enum(['cash', 'card', 'bank_transfer']), salesFils: money, refundsFils: money, netFils: integer,
    }).strict()).min(2).max(3),
  }).strict(),
  openShifts: z.object({
    ...page,
    items: z.array(z.object({ ...identity, openingCashFils: money }).strict()).max(20),
  }).strict(),
  closedShifts: z.object({
    ...page,
    windowStart: timestamp,
    windowEnd: timestamp,
    discrepancyCount: count,
    incompleteCount: count,
    netDifferenceFils: integer.nullable(),
    items: z.array(z.object({
      ...identity,
      closedAt: timestamp,
      countedCashFils: money.nullable(),
      expectedCashFils: integer.nullable(),
      cashDifferenceFils: integer.nullable(),
    }).strict()).max(20),
  }).strict(),
  unpaidOrders: z.object({
    ...page,
    totalFils: money,
    oldestCreatedAt: timestamp.nullable(),
    items: z.array(z.object({
      id: uuid,
      label: z.string().min(1).max(120),
      serviceType: z.enum(['dine_in', 'takeaway', 'delivery']),
      tableName: z.string().min(1).max(80).nullable(),
      createdAt: timestamp,
      updatedAt: timestamp,
      totalFils: money,
    }).strict()).max(20),
  }).strict(),
  kitchen: z.object({
    paidTickets: stages,
    tabTickets: z.object({ activeCount: count, withUnacknowledgedChanges: count }).strict(),
    tabBatches: stages,
  }).strict(),
  offlineCustody: z.object({
    unsealedAuthorities: count,
    unresolvedUploadExceptions: count,
    pendingPaymentFreezes: count,
    conflictRecords: count,
    unsupportedEvidenceRecords: count,
    blockedDeviceEpochs: count,
  }).strict(),
}).strict()

export const branchOperationsSchema = operationsSnapshotShape.superRefine((value, ctx) => {
  // Zod can run refinements after non-fatal scalar errors. Never feed a fractional
  // amount or invalid timestamp to BigInt while reporting an invalid response.
  if (!operationsSnapshotShape.safeParse(value).success) return
  const fail = () => ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Operations snapshot does not reconcile.' })
  const exactSum = (values: number[]) => values.reduce((sum, amount) => sum + BigInt(amount), BigInt(0))
  const { sales, openShifts, closedShifts, unpaidOrders, kitchen } = value
  const s = sales.summary
  if (dubaiToday(new Date(value.generatedAt)) !== value.businessDate ||
    s.invoiceCount + s.creditNoteCount !== sales.documentCount ||
    BigInt(s.salesGrossFils) - BigInt(s.refundGrossFils) !== BigInt(s.netGrossFils) ||
    BigInt(s.netExVatFils) + BigInt(s.vatFils) !== BigInt(s.netGrossFils) ||
    new Set(sales.payments.map(p => p.method)).size !== sales.payments.length ||
    exactSum(sales.payments.map(p => p.salesFils)) !== BigInt(s.salesGrossFils) ||
    exactSum(sales.payments.map(p => p.refundsFils)) !== BigInt(s.refundGrossFils) ||
    sales.payments.some(p => BigInt(p.salesFils) - BigInt(p.refundsFils) !== BigInt(p.netFils))) fail()
  for (const section of [openShifts, closedShifts, unpaidOrders]) {
    if (section.items.length !== Math.min(section.totalCount, section.limit) ||
      section.truncated !== (section.totalCount > section.limit) ||
      new Set(section.items.map(item => item.id)).size !== section.items.length) fail()
  }
  if (new Set(openShifts.items.map(item => item.deviceId)).size !== openShifts.items.length ||
    openShifts.items.some(item => closedShifts.items.some(closed => closed.id === item.id))) fail()
  const expectedStart = Date.parse(value.businessDate + 'T00:00:00+04:00') - 29 * 86400000
  if (Date.parse(closedShifts.windowStart) !== expectedStart ||
    preciseTime(closedShifts.windowEnd) !== preciseTime(value.generatedAt) ||
    closedShifts.discrepancyCount + closedShifts.incompleteCount > closedShifts.totalCount ||
    (closedShifts.netDifferenceFils === null) !== (closedShifts.incompleteCount > 0)) fail()
  const incomplete = closedShifts.items.filter(row =>
    row.countedCashFils === null || row.expectedCashFils === null || row.cashDifferenceFils === null)
  const complete = closedShifts.items.filter(row => !incomplete.includes(row))
  const discrepancies = complete.filter(row => row.cashDifferenceFils !== 0).length
  if (closedShifts.items.some(row => preciseTime(row.closedAt) < BigInt(expectedStart) * BigInt(1000) ||
    preciseTime(row.closedAt) >= preciseTime(closedShifts.windowEnd)) ||
    complete.some(row => BigInt(row.countedCashFils!) - BigInt(row.expectedCashFils!) !== BigInt(row.cashDifferenceFils!)) ||
    incomplete.length > closedShifts.incompleteCount || discrepancies > closedShifts.discrepancyCount) fail()
  if (!closedShifts.truncated && (incomplete.length !== closedShifts.incompleteCount ||
    discrepancies !== closedShifts.discrepancyCount ||
    (closedShifts.netDifferenceFils !== null &&
      exactSum(complete.map(row => row.cashDifferenceFils!)) !== BigInt(closedShifts.netDifferenceFils)))) fail()
  if ((unpaidOrders.oldestCreatedAt === null) !== (unpaidOrders.totalCount === 0) ||
    (unpaidOrders.items.length > 0 && preciseTime(unpaidOrders.oldestCreatedAt!) !== preciseTime(unpaidOrders.items[0].createdAt)) ||
    exactSum(unpaidOrders.items.map(row => row.totalFils)) > BigInt(unpaidOrders.totalFils) ||
    (!unpaidOrders.truncated && exactSum(unpaidOrders.items.map(row => row.totalFils)) !== BigInt(unpaidOrders.totalFils)) ||
    kitchen.tabTickets.withUnacknowledgedChanges > kitchen.tabTickets.activeCount) fail()
  // Truncation may hide older/newer rows, but the displayed order is still deterministic by time.
  for (let i = 1; i < openShifts.items.length; i++)
    if (preciseTime(openShifts.items[i - 1].openedAt) > preciseTime(openShifts.items[i].openedAt)) fail()
  for (let i = 1; i < closedShifts.items.length; i++)
    if (preciseTime(closedShifts.items[i - 1].closedAt) < preciseTime(closedShifts.items[i].closedAt)) fail()
  for (let i = 1; i < unpaidOrders.items.length; i++)
    if (preciseTime(unpaidOrders.items[i - 1].createdAt) > preciseTime(unpaidOrders.items[i].createdAt)) fail()
})

export type BranchOperations = z.infer<typeof branchOperationsSchema>
