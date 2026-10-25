import { z } from 'zod'

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const timestamp = z.string().datetime({ offset: true })
const revision = z.number().int().min(1).max(2_147_483_647)
const count = z.number().int().min(0).max(2_147_483_647)
export const kitchenStatusSchema = z.enum(['queued', 'preparing', 'ready', 'served', 'cancelled'])
export const kitchenCursorSchema = z.object({ issuedAt: timestamp, orderId: uuid }).strict()
export const kitchenCommandSchema = z
  .object({
    id: uuid,
    branchId: uuid,
    deviceId: uuid,
    orderId: uuid,
    expectedRevision: z.number().int().min(1).max(2_147_483_646),
    status: z.enum(['queued', 'preparing', 'ready', 'served']),
    reason: z.string().trim().min(1).max(240).nullable(),
  })
  .strict()
export const kitchenTicketSchema = z
  .object({
    orderId: uuid,
    branchId: uuid,
    invoiceId: uuid,
    invoiceNumber: z.string().min(1).max(80),
    issuedAt: timestamp,
    serviceType: z.enum(['dine_in', 'takeaway', 'delivery']),
    // Optional keeps historic cached ticket views readable during the rollout;
    // the server always supplies null or the saved note after migration.
    orderNote: z.string().trim().min(1).max(240).nullable().optional(),
    lines: z
      .array(
        z
          .object({
            lineNumber: z.number().int().min(1).max(200),
            productId: uuid,
            name: z.string().min(1).max(200),
            unit: z.enum(['piece', 'pack', 'kg']),
            quantityMilli: z.number().int().min(1).max(1_000_000),
          })
          .strict()
      )
      .min(1)
      .max(200),
    status: kitchenStatusSchema,
    revision,
    updatedAt: timestamp,
    refundedAt: timestamp.nullable(),
  })
  .strict()
  .superRefine((ticket, ctx) => {
    if ((ticket.status === 'cancelled') !== (ticket.refundedAt !== null))
      ctx.addIssue({ code: 'custom', message: 'Refund status does not match the ticket.' })
    if (
      ticket.lines.some(
        (line, i) =>
          line.lineNumber !== i + 1 || (line.unit !== 'kg' && line.quantityMilli % 1000 !== 0)
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid kitchen line sequence or quantity.' })
  })
export const kitchenUpdateResultSchema = z
  .object({
    status: z.literal('updated'),
    requestId: uuid,
    replayed: z.boolean(),
    ticket: kitchenTicketSchema,
  })
  .strict()
export const kitchenCancellationSchema = z
  .object({
    status: z.literal('cancelled'),
    requestId: uuid,
    replayed: z.boolean(),
  })
  .strict()
export const kitchenListSchema = z
  .object({
    status: z.literal('ready'),
    organizationId: uuid,
    branchId: uuid,
    actorRole: z.enum(['owner', 'manager', 'cashier']),
    generatedAt: timestamp,
    activeTickets: z.array(kitchenTicketSchema).max(100),
    terminalTickets: z.array(kitchenTicketSchema).max(50),
    activeCount: count,
    activeCounts: z.object({ queued: count, preparing: count, ready: count }).strict(),
    activeNextCursor: kitchenCursorSchema.nullable(),
    terminalTruncated: z.boolean(),
  })
  .strict()
  .superRefine((list, ctx) => {
    const all = [...list.activeTickets, ...list.terminalTickets]
    if (
      all.some((ticket) => ticket.branchId !== list.branchId) ||
      new Set(all.map((ticket) => ticket.orderId)).size !== all.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Kitchen response contains inconsistent ticket scope.',
      })
    if (
      list.activeTickets.some((ticket) => ['served', 'cancelled'].includes(ticket.status)) ||
      list.terminalTickets.some((ticket) => !['served', 'cancelled'].includes(ticket.status))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Kitchen response contains inconsistent ticket stages.',
      })
    if (
      list.activeCount < list.activeTickets.length ||
      list.activeCount !==
        list.activeCounts.queued + list.activeCounts.preparing + list.activeCounts.ready
    )
      ctx.addIssue({ code: 'custom', message: 'Kitchen counts do not match.' })
    if (list.activeNextCursor) {
      const last = list.activeTickets.at(-1)
      if (
        !last ||
        last.orderId !== list.activeNextCursor.orderId ||
        Date.parse(last.issuedAt) !== Date.parse(list.activeNextCursor.issuedAt)
      )
        ctx.addIssue({ code: 'custom', message: 'Kitchen cursor does not match its page.' })
    }
  })
export const kitchenQuerySchema = z
  .object({
    branchId: uuid,
    deviceId: uuid,
    afterIssuedAt: timestamp.optional(),
    afterOrderId: uuid.optional(),
  })
  .strict()
  .refine((query) => !!query.afterIssuedAt === !!query.afterOrderId, {
    message: 'Both cursor fields are required.',
  })

export type KitchenTicket = z.infer<typeof kitchenTicketSchema>
export type KitchenCommand = z.infer<typeof kitchenCommandSchema>
export type KitchenList = z.infer<typeof kitchenListSchema>
export type KitchenUpdateResult = z.infer<typeof kitchenUpdateResultSchema>
export function kitchenAckMatches(command: KitchenCommand, result: KitchenUpdateResult) {
  return (
    result.requestId === command.id &&
    result.ticket.orderId === command.orderId &&
    result.ticket.branchId === command.branchId &&
    result.ticket.status === command.status &&
    result.ticket.revision === command.expectedRevision + 1
  )
}
