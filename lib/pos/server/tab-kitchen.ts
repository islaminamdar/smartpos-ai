import { z } from 'zod'

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const timestamp = z.string().datetime({ offset: true })
const revision = z.number().int().min(1).max(2_147_483_647)
const expected = revision.max(2_147_483_646)
const count = z.number().int().min(0).max(2_147_483_647)
const reason = z.string().trim().min(1).max(240).nullable()
export const tabKitchenStageSchema = z.enum(['queued', 'preparing', 'ready', 'served'])
const lineShape = {
  productId: uuid,
  name: z.string().min(1).max(200),
  unit: z.enum(['piece', 'pack', 'kg']),
  quantityMilli: z.number().int().min(1).max(1_000_000),
}
export const tabKitchenLineSchema = z
  .object(lineShape)
  .strict()
  .refine(
    (line) => line.unit === 'kg' || line.quantityMilli % 1000 === 0,
    'Whole pieces and packs are required.'
  )
const lines = z
  .array(tabKitchenLineSchema)
  .max(200)
  .refine(
    (value) => new Set(value.map((line) => line.productId)).size === value.length,
    'Each product must appear once.'
  )
export const tabKitchenMetadataSchema = z
  .object({
    label: z.string().min(1).max(120),
    serviceType: z.enum(['dine_in', 'takeaway', 'delivery']),
    tableId: uuid.nullable(),
    tableName: z.string().min(1).max(80).nullable(),
    guestCount: z.number().int().min(1).max(99).nullable(),
    note: z.string().max(400),
  })
  .strict()
  .refine(
    (m) =>
      (m.tableId === null) === (m.tableName === null) &&
      (m.tableId === null || m.serviceType === 'dine_in'),
    'Inconsistent kitchen table.'
  )
const content = z.object({ metadata: tabKitchenMetadataSchema, lines }).strict()
export const tabKitchenTicketSchema = z
  .object({
    id: uuid,
    tabId: uuid,
    branchId: uuid,
    revision,
    generation: revision,
    dispatchedTabRevision: revision,
    state: z.enum(['open', 'cancelled']),
    payment: z.enum(['unpaid', 'paid', 'refunded']),
    paidOrderId: uuid.nullable(),
    invoiceId: uuid.nullable(),
    invoiceNumber: z.string().min(1).max(80).nullable(),
    paidAt: timestamp.nullable(),
    refundedAt: timestamp.nullable(),
    metadata: tabKitchenMetadataSchema,
    lines,
    stages: z.object({ queued: lines, preparing: lines, ready: lines, served: lines }).strict(),
    eventSequence: revision,
    acknowledgedSequence: count,
    pendingChangeCount: count,
    issuedAt: timestamp,
    updatedAt: timestamp,
  })
  .strict()
  .superRefine((ticket, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    const hasPayment = ticket.payment !== 'unpaid'
    if (
      [ticket.paidOrderId, ticket.invoiceId, ticket.invoiceNumber, ticket.paidAt].some(
        (value) => (value !== null) !== hasPayment
      ) ||
      (ticket.refundedAt !== null) !== (ticket.payment === 'refunded') ||
      (ticket.payment === 'refunded' && ticket.state !== 'cancelled')
    )
      fail('Inconsistent kitchen payment link.')
    if (ticket.pendingChangeCount !== ticket.eventSequence - ticket.acknowledgedSequence)
      fail('Inconsistent kitchen notice counts.')
    if ((ticket.state === 'cancelled') !== (ticket.lines.length === 0))
      fail('Inconsistent kitchen cancellation.')
    const totals = new Map<string, number>()
    for (const bucket of Object.values(ticket.stages))
      for (const line of bucket) {
        const target = ticket.lines.find((item) => item.productId === line.productId)
        if (!target || target.name !== line.name || target.unit !== line.unit)
          fail('Preparation does not match the dispatched content.')
        totals.set(line.productId, (totals.get(line.productId) ?? 0) + line.quantityMilli)
      }
    if (ticket.lines.some((line) => totals.get(line.productId) !== line.quantityMilli))
      fail('Preparation quantities do not reconcile.')
  })
export const tabKitchenEventSchema = z
  .object({
    sequence: revision,
    generation: revision,
    kind: z.enum(['dispatch', 'reopen', 'void', 'refund']),
    tabRevision: revision,
    reason,
    createdAt: timestamp,
    before: content.nullable(),
    after: content,
    additions: lines,
    withdrawals: z
      .array(
        z
          .object({ ...lineShape, stage: tabKitchenStageSchema })
          .strict()
          .refine((line) => line.unit === 'kg' || line.quantityMilli % 1000 === 0)
      )
      .max(800),
  })
  .strict()
const common = { id: uuid, branchId: uuid, deviceId: uuid }
export const tabKitchenCommandSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        ...common,
        type: z.literal('dispatch'),
        tabId: uuid,
        expectedTabRevision: expected,
        expectedTicketRevision: z.number().int().min(0).max(2_147_483_646),
        reason,
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal('stage'),
        ticketId: uuid,
        expectedRevision: expected,
        from: tabKitchenStageSchema,
        to: tabKitchenStageSchema,
        reason,
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal('acknowledge'),
        ticketId: uuid,
        expectedRevision: expected,
        throughSequence: revision,
      })
      .strict(),
  ])
  .superRefine((command, ctx) => {
    if (command.type === 'stage') {
      const stages = ['queued', 'preparing', 'ready', 'served']
      if (Math.abs(stages.indexOf(command.from) - stages.indexOf(command.to)) !== 1)
        ctx.addIssue({ code: 'custom', message: 'Only adjacent preparation stages are allowed.' })
      if (stages.indexOf(command.from) > stages.indexOf(command.to) && !command.reason)
        ctx.addIssue({ code: 'custom', message: 'A correction reason is required.' })
    }
  })
export const tabKitchenUpdateResultSchema = z
  .object({
    status: z.literal('updated'),
    requestId: uuid,
    replayed: z.boolean(),
    ticket: tabKitchenTicketSchema,
  })
  .strict()
export const tabKitchenCancellationSchema = z
  .object({
    status: z.literal('cancelled'),
    requestId: uuid,
    replayed: z.boolean(),
  })
  .strict()
const scope = {
  status: z.literal('ready'),
  organizationId: uuid,
  branchId: uuid,
  actorRole: z.enum(['owner', 'manager', 'cashier']),
}
export const tabKitchenCursorSchema = z.object({ issuedAt: timestamp, id: uuid }).strict()
export function tabKitchenActionable(ticket: TabKitchenTicket) {
  return (
    ticket.pendingChangeCount > 0 ||
    ticket.stages.queued.length + ticket.stages.preparing.length + ticket.stages.ready.length > 0
  )
}
export const tabKitchenListSchema = z
  .object({
    ...scope,
    generatedAt: timestamp,
    activeTickets: z.array(tabKitchenTicketSchema).max(100),
    terminalTickets: z.array(tabKitchenTicketSchema).max(50),
    activeCount: count,
    pendingCount: count,
    activeNextCursor: tabKitchenCursorSchema.nullable(),
    terminalTruncated: z.boolean(),
  })
  .strict()
  .superRefine((list, ctx) => {
    const all = [...list.activeTickets, ...list.terminalTickets]
    if (
      all.some((ticket) => ticket.branchId !== list.branchId) ||
      new Set(all.map((ticket) => ticket.id)).size !== all.length ||
      new Set(all.map((ticket) => ticket.tabId)).size !== all.length
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent kitchen scope.' })
    if (
      list.activeTickets.some((ticket) => !tabKitchenActionable(ticket)) ||
      list.terminalTickets.some(tabKitchenActionable) ||
      list.activeCount < list.activeTickets.length ||
      list.pendingCount > list.activeCount ||
      list.pendingCount <
        list.activeTickets.filter((ticket) => ticket.pendingChangeCount > 0).length
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent kitchen counts or pages.' })
    if (list.activeNextCursor) {
      const last = list.activeTickets.at(-1)
      if (
        !last ||
        last.id !== list.activeNextCursor.id ||
        Date.parse(last.issuedAt) !== Date.parse(list.activeNextCursor.issuedAt)
      )
        ctx.addIssue({ code: 'custom', message: 'Kitchen cursor does not match its page.' })
    }
  })
export const tabKitchenDetailSchema = z
  .object({
    ...scope,
    ticket: tabKitchenTicketSchema,
    events: z.array(tabKitchenEventSchema).max(20),
    eventsNextAfter: revision.nullable(),
  })
  .strict()
  .superRefine((detail, ctx) => {
    if (
      detail.ticket.branchId !== detail.branchId ||
      detail.events.some(
        (event, index) =>
          event.sequence > detail.ticket.eventSequence ||
          event.generation > detail.ticket.generation ||
          (index > 0 && event.sequence !== detail.events[index - 1].sequence + 1)
      ) ||
      (detail.eventsNextAfter !== null &&
        (detail.events.at(-1)?.sequence !== detail.eventsNextAfter ||
          detail.eventsNextAfter >= detail.ticket.eventSequence))
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent kitchen event history.' })
  })
export const tabKitchenTabSchema = z
  .object({
    ...scope,
    tabId: uuid,
    tabRevision: revision,
    ticket: tabKitchenTicketSchema.nullable(),
    dispatchRequired: z.boolean(),
  })
  .strict()
  .superRefine((detail, ctx) => {
    if (
      (detail.ticket &&
        (detail.ticket.branchId !== detail.branchId || detail.ticket.tabId !== detail.tabId)) ||
      (!detail.ticket && detail.dispatchRequired)
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent saved-order kitchen status.' })
  })
export const tabKitchenQuerySchema = z
  .object({
    branchId: uuid,
    deviceId: uuid,
    ticketId: uuid.optional(),
    tabId: uuid.optional(),
    afterSequence: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,9})$/)
      .transform(Number)
      .pipe(count)
      .optional(),
    afterIssuedAt: timestamp.optional(),
    afterId: uuid.optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (
      !!q.afterIssuedAt !== !!q.afterId ||
      (q.ticketId && q.tabId) ||
      ((q.ticketId || q.tabId) && (q.afterIssuedAt || q.afterId)) ||
      (q.afterSequence !== undefined && !q.ticketId)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid kitchen query mode.' })
  })
export type TabKitchenTicket = z.infer<typeof tabKitchenTicketSchema>
export type TabKitchenCommand = z.infer<typeof tabKitchenCommandSchema>
export type TabKitchenList = z.infer<typeof tabKitchenListSchema>
export type TabKitchenDetail = z.infer<typeof tabKitchenDetailSchema>
export type TabKitchenTab = z.infer<typeof tabKitchenTabSchema>
export type TabKitchenEvent = z.infer<typeof tabKitchenEventSchema>
export type TabKitchenLine = z.infer<typeof tabKitchenLineSchema>
export type TabKitchenUpdateResult = z.infer<typeof tabKitchenUpdateResultSchema>
export function tabKitchenAckMatches(command: TabKitchenCommand, result: TabKitchenUpdateResult) {
  const t = result.ticket
  if (result.requestId !== command.id || t.branchId !== command.branchId) return false
  if (command.type === 'dispatch')
    return (
      t.tabId === command.tabId &&
      t.revision === command.expectedTicketRevision + 1 &&
      t.dispatchedTabRevision === command.expectedTabRevision &&
      t.state === 'open' &&
      t.payment === 'unpaid'
    )
  if (t.id !== command.ticketId || t.revision !== command.expectedRevision + 1) return false
  if (command.type === 'acknowledge') return t.acknowledgedSequence === command.throughSequence
  return (
    t.state === 'open' &&
    t.pendingChangeCount === 0 &&
    t.stages[command.from].length === 0 &&
    t.stages[command.to].length > 0
  )
}
