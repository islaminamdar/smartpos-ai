import { z } from 'zod'

const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase())
const time = z
  .string()
  .datetime()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/)
const count = z.number().int().min(0).max(2147483647)
const revision = count.refine((value) => value > 0)
const stage = z.enum(['queued', 'preparing', 'ready', 'served'])
const stages = stage.options
const name = z
  .string()
  .min(1)
  .max(120)
  .refine(
    (value) =>
      [...value].length <= 60 &&
      value === value.trim() &&
      !/[\u0000-\u001f\u007f]/.test(value) &&
      value.toLowerCase() !== 'general'
  )
const reason = z
  .string()
  .min(1)
  .max(480)
  .refine((value) => [...value].length <= 240)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value))
  .nullable()
const textWithin = (maximum: number, minimum = 1) =>
  z
    .string()
    .min(minimum)
    .max(maximum * 2)
    .refine((value) => [...value].length <= maximum)
const quantity = z.number().int().min(1).max(200_000_000)
const lineFields = {
  productId: uuid,
  name: textWithin(200),
  unit: z.enum(['piece', 'pack', 'kg']),
  quantityMilli: quantity,
}
const whole = (line: { unit: string; quantityMilli: number }) =>
  line.unit === 'kg' || line.quantityMilli % 1000 === 0
const line = z.object(lineFields).strict().refine(whole)
const lineKey = (value: { productId: string; name: string; unit: string }) =>
  JSON.stringify([value.productId, value.name, value.unit])
const lines = z
  .array(line)
  .max(200)
  .refine((value) => new Set(value.map(lineKey)).size === value.length)
const metadata = z
  .object({
    label: textWithin(120).nullable(),
    serviceType: z.enum(['dine_in', 'takeaway', 'delivery']),
    tableId: uuid.nullable(),
    tableName: textWithin(80).nullable(),
    guestCount: z.number().int().min(1).max(99).nullable(),
    note: textWithin(400, 0).nullable(),
  })
  .strict()
  .refine(
    (value) =>
      (value.tableId === null) === (value.tableName === null) &&
      (value.tableId === null || value.serviceType === 'dine_in')
  )
const stationIdentity = (id: string | null, value: string) =>
  id === null ? value === 'General' : name.safeParse(value).success

export const stationWorkSchema = z
  .object({
    id: uuid,
    branchId: uuid,
    family: z.enum(['paid', 'tab']),
    stationId: uuid.nullable(),
    stationName: z.string(),
    generation: revision,
    revision,
    orderId: uuid.nullable(),
    tabId: uuid.nullable(),
    ticketId: uuid.nullable(),
    invoiceId: uuid.nullable(),
    invoiceNumber: textWithin(80).nullable(),
    payment: z.enum(['unpaid', 'paid', 'refunded']),
    state: z.enum(['open', 'cancelled']),
    metadata,
    stages: z.object({ queued: lines, preparing: lines, ready: lines, served: lines }).strict(),
    pendingNoticeCount: count,
    issuedAt: time,
    updatedAt: time,
  })
  .strict()
  .superRefine((work, ctx) => {
    const fail = () => ctx.addIssue({ code: 'custom', message: 'Inconsistent station work.' })
    if (
      !stationIdentity(work.stationId, work.stationName) ||
      compareTime(work.updatedAt, work.issuedAt) < 0
    )
      fail()
    const paid = work.payment !== 'unpaid'
    if (
      [work.orderId, work.invoiceId, work.invoiceNumber].some(
        (value) => (value !== null) !== paid
      ) ||
      (work.payment === 'refunded' && work.state !== 'cancelled')
    )
      fail()
    if (work.family === 'paid') {
      if (
        !paid ||
        work.tabId !== null ||
        work.ticketId !== null ||
        work.generation !== 1 ||
        [
          work.metadata.label,
          work.metadata.tableId,
          work.metadata.tableName,
          work.metadata.guestCount,
          work.metadata.note,
        ].some((value) => value !== null)
      )
        fail()
      if (Object.values(work.stages).filter((bucket) => bucket.length > 0).length > 1) fail()
    } else if (
      work.tabId === null ||
      work.ticketId === null ||
      work.metadata.label === null ||
      work.metadata.note === null
    )
      fail()
    if (work.state === 'cancelled' && Object.values(work.stages).some((bucket) => bucket.length))
      fail()
  })

const common = {
  id: uuid,
  branchId: uuid,
  deviceId: uuid,
  workId: uuid,
  expectedRevision: z.number().int().min(1).max(2147483646),
}
export const stationWorkCommandSchema = z
  .discriminatedUnion('type', [
    z.object({ ...common, type: z.literal('stage'), from: stage, to: stage, reason }).strict(),
    z.object({ ...common, type: z.literal('notice.ack'), noticeId: uuid }).strict(),
  ])
  .superRefine((command, ctx) => {
    if (command.type !== 'stage') return
    const step = stages.indexOf(command.to) - stages.indexOf(command.from)
    if (Math.abs(step) !== 1 || (step < 0 && command.reason === null))
      ctx.addIssue({
        code: 'custom',
        message: 'An adjacent stage and correction reason are required.',
      })
  })
export const stationWorkResultSchema = z
  .object({
    status: z.literal('updated'),
    requestId: uuid,
    branchId: uuid,
    replayed: z.boolean(),
    work: stationWorkSchema,
    acknowledgedNoticeId: uuid.nullable(),
  })
  .strict()
  .refine((value) => value.work.branchId === value.branchId)
export const stationWorkCancellationSchema = z
  .object({
    status: z.literal('cancelled'),
    requestId: uuid,
    branchId: uuid,
    workId: uuid,
    replayed: z.boolean(),
  })
  .strict()
export const stationWorkRecoverySchema = z.union([
  stationWorkResultSchema,
  stationWorkCancellationSchema,
])
const scope = {
  status: z.literal('ready'),
  organizationId: uuid,
  branchId: uuid,
  actorRole: z.enum(['owner', 'manager', 'cashier']),
}
const cursor = z.object({ at: time, id: uuid }).strict()
export const stationWorkListSchema = z
  .object({
    ...scope,
    generatedAt: time,
    items: z.array(stationWorkSchema).max(100),
    matchingCount: count,
    nextCursor: cursor.nullable(),
    attentionCount: count,
    stations: z
      .array(
        z
          .object({
            stationId: uuid.nullable(),
            name: z.string(),
            active: z.boolean(),
            activeCount: count,
            pendingNoticeCount: count,
          })
          .strict()
      )
      .min(1)
      .max(129),
  })
  .strict()
  .superRefine((list, ctx) => {
    const ids = new Set(list.stations.map((station) => station.stationId))
    if (
      ids.size !== list.stations.length ||
      !ids.has(null) ||
      list.stations.some(
        (station) =>
          !stationIdentity(station.stationId, station.name) ||
          (station.stationId === null && !station.active)
      ) ||
      list.items.some((work) => work.branchId !== list.branchId || !ids.has(work.stationId)) ||
      new Set(list.items.map((work) => work.id)).size !== list.items.length ||
      list.matchingCount < list.items.length ||
      list.attentionCount < list.items.filter((work) => work.pendingNoticeCount > 0).length ||
      list.attentionCount > list.stations.reduce((sum, station) => sum + station.activeCount, 0) ||
      (list.nextCursor !== null && (list.items.length !== 100 || list.matchingCount <= 100))
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent station work page.' })
  })

const noticeBase = {
  id: uuid,
  workId: uuid,
  sequence: revision,
  createdAt: time,
  // Existing dispatch and return inputs permit interior newlines/tabs. A historical
  // notice must remain readable; the stricter new-command policy does not rewrite it.
  reason: textWithin(240)
    .refine((value) => !value.includes('\u0000'))
    .nullable(),
  acknowledgedAt: time.nullable(),
}
const dispatchSource = z
  .object({ ticketId: uuid, eventSequence: revision, tabRevision: revision })
  .strict()
const withdrawals = z
  .array(
    z
      .object({ ...lineFields, stage })
      .strict()
      .refine(whole)
  )
  .max(800)
  .refine(
    (value) => new Set(value.map((item) => `${item.stage}:${lineKey(item)}`)).size === value.length
  )
const dispatchDetail = z
  .object({
    metadataBefore: metadata.nullable(),
    metadataAfter: metadata,
    beforeLines: lines,
    afterLines: lines,
    additions: lines,
    withdrawals,
  })
  .strict()
const returnedLine = z
  .object({
    ...lineFields,
    quantityMilli: z.number().int().min(1).max(1_000_000),
    originalLineNumber: z.number().int().min(1).max(200),
    remainingQuantityMilli: z.number().int().min(0).max(1_000_000),
  })
  .strict()
  .refine(
    (value) => whole(value) && (value.unit === 'kg' || value.remainingQuantityMilli % 1000 === 0)
  )
export const stationWorkNoticeSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...noticeBase,
        kind: z.literal('cancel'),
        source: z
          .object({
            invoiceId: uuid,
            invoiceNumber: z.string().min(1).max(80),
            creditNoteId: uuid,
            creditNumber: z.string().min(1).max(80),
            fullyReturned: z.literal(true),
          })
          .strict(),
        detail: z.object({ lines: lines.refine((value) => value.length > 0) }).strict(),
      })
      .strict(),
    z
      .object({
        ...noticeBase,
        kind: z.literal('dispatch'),
        source: dispatchSource,
        detail: dispatchDetail,
      })
      .strict(),
    z
      .object({
        ...noticeBase,
        kind: z.literal('reopen'),
        source: dispatchSource,
        detail: dispatchDetail,
      })
      .strict(),
    z
      .object({
        ...noticeBase,
        kind: z.literal('void'),
        source: dispatchSource,
        detail: dispatchDetail,
      })
      .strict(),
    z
      .object({
        ...noticeBase,
        kind: z.literal('return'),
        source: z
          .object({
            invoiceId: uuid,
            invoiceNumber: z.string().min(1).max(80),
            creditNoteId: uuid,
            creditNumber: z.string().min(1).max(80),
            fullyReturned: z.boolean(),
          })
          .strict(),
        detail: z.object({ lines: z.array(returnedLine).min(1).max(200) }).strict(),
      })
      .strict(),
  ])
  .superRefine((notice, ctx) => {
    if (
      (notice.acknowledgedAt !== null &&
        compareTime(notice.acknowledgedAt, notice.createdAt) < 0) ||
      (notice.kind === 'return' &&
        notice.detail.lines.some(
          (item, index, all) =>
            (index > 0 && item.originalLineNumber <= all[index - 1].originalLineNumber) ||
            (notice.source.fullyReturned && item.remainingQuantityMilli !== 0)
        ))
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent station notice.' })
  })
export const stationWorkDetailSchema = z
  .object({
    ...scope,
    work: stationWorkSchema,
    notices: z.array(stationWorkNoticeSchema).max(50),
    noticeCount: count,
    nextAfterSequence: revision.nullable(),
  })
  .strict()
  .superRefine((detail, ctx) => {
    if (
      detail.work.branchId !== detail.branchId ||
      detail.notices.length > detail.noticeCount ||
      new Set(detail.notices.map((notice) => notice.id)).size !== detail.notices.length ||
      detail.notices.some(
        (notice, index, all) =>
          notice.workId !== detail.work.id ||
          (index > 0 && notice.sequence <= all[index - 1].sequence) ||
          (notice.kind !== 'return' &&
            notice.kind !== 'cancel' &&
            notice.source.ticketId !== detail.work.ticketId) ||
          ((notice.kind === 'return' || notice.kind === 'cancel') &&
            (notice.source.invoiceId !== detail.work.invoiceId ||
              notice.source.invoiceNumber !== detail.work.invoiceNumber))
      ) ||
      (detail.nextAfterSequence !== null &&
        (detail.notices.length !== 50 ||
          detail.noticeCount <= 50 ||
          detail.nextAfterSequence !== detail.notices.at(-1)?.sequence))
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent station notice page.' })
  })
export const stationWorkQuerySchema = z
  .object({
    branchId: uuid,
    deviceId: uuid,
    station: z.union([z.literal('all'), z.literal('general'), uuid]),
    view: z.enum(['active', 'history']),
    cursorAt: time.optional(),
    cursorId: uuid.optional(),
  })
  .strict()
  .refine((query) => !!query.cursorAt === !!query.cursorId)
export const stationWorkDetailQuerySchema = z
  .object({
    branchId: uuid,
    deviceId: uuid,
    workId: uuid,
    noticeView: z.enum(['pending', 'all']),
    afterSequence: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,9})$/)
      .transform(Number)
      .pipe(count),
  })
  .strict()

export type StationWork = z.infer<typeof stationWorkSchema>
export type StationWorkCommand = z.infer<typeof stationWorkCommandSchema>
export type StationWorkList = z.infer<typeof stationWorkListSchema>
export type StationWorkDetail = z.infer<typeof stationWorkDetailSchema>
export type StationWorkNotice = z.infer<typeof stationWorkNoticeSchema>
export type StationWorkRecovery = z.infer<typeof stationWorkRecoverySchema>
export function stationWorkActionable(work: StationWork) {
  return (
    work.pendingNoticeCount > 0 ||
    work.stages.queued.length + work.stages.preparing.length + work.stages.ready.length > 0
  )
}
// PostgreSQL timestamps include microseconds; milliseconds alone lose cursor ordering.
function timeMicros(value: string) {
  const extra = (value.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0').slice(3, 6)
  return BigInt(Date.parse(value)) * BigInt(1000) + BigInt(extra || '0')
}
function compareTime(a: string, b: string) {
  const x = timeMicros(a),
    y = timeMicros(b)
  return x < y ? -1 : x > y ? 1 : 0
}
function compareCursor(a: z.infer<typeof cursor>, b: z.infer<typeof cursor>) {
  return compareTime(a.at, b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
export function stationWorkResultMatches(command: StationWorkCommand, result: StationWorkRecovery) {
  if (result.requestId !== command.id || result.branchId !== command.branchId) return false
  if (result.status === 'cancelled') return result.workId === command.workId
  const work = result.work
  if (work.id !== command.workId || work.revision !== command.expectedRevision + 1) return false
  return command.type === 'notice.ack'
    ? result.acknowledgedNoticeId === command.noticeId
    : result.acknowledgedNoticeId === null &&
        work.state === 'open' &&
        work.pendingNoticeCount === 0 &&
        work.stages[command.from].length === 0 &&
        work.stages[command.to].length > 0
}
export function stationWorkListMatchesQuery(
  query: z.infer<typeof stationWorkQuerySchema>,
  list: StationWorkList
) {
  if (list.branchId !== query.branchId) return false
  const sign = query.view === 'active' ? 1 : -1
  const key = (work: StationWork) => ({
    at: query.view === 'active' ? work.issuedAt : work.updatedAt,
    id: work.id,
  })
  if (
    list.items.some(
      (work, index, all) =>
        stationWorkActionable(work) !== (query.view === 'active') ||
        (query.station !== 'all' &&
          work.stationId !== (query.station === 'general' ? null : query.station)) ||
        (index > 0 && sign * compareCursor(key(work), key(all[index - 1])) <= 0) ||
        (query.cursorAt &&
          query.cursorId &&
          sign * compareCursor(key(work), { at: query.cursorAt, id: query.cursorId }) <= 0)
    )
  )
    return false
  if (
    list.nextCursor &&
    (!list.items.length || compareCursor(list.nextCursor, key(list.items.at(-1)!)) !== 0)
  )
    return false
  if (
    !query.cursorAt &&
    (list.items.length !== Math.min(list.matchingCount, 100) ||
      (list.nextCursor !== null) !== list.matchingCount > 100)
  )
    return false
  return true
}
export function stationWorkDetailMatchesQuery(
  query: z.infer<typeof stationWorkDetailQuerySchema>,
  detail: StationWorkDetail
) {
  if (
    detail.branchId !== query.branchId ||
    detail.work.id !== query.workId ||
    detail.notices.some(
      (notice) =>
        notice.sequence <= query.afterSequence ||
        (query.noticeView === 'pending' && notice.acknowledgedAt !== null)
    )
  )
    return false
  if (query.noticeView === 'pending' && detail.noticeCount !== detail.work.pendingNoticeCount)
    return false
  if (
    query.afterSequence === 0 &&
    (detail.notices.length !== Math.min(detail.noticeCount, 50) ||
      (detail.nextAfterSequence !== null) !== detail.noticeCount > 50)
  )
    return false
  return true
}
