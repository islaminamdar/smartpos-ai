import { z } from 'zod'
import {
  originalReturnInvoiceSchema,
  partialCreditDocumentSchema,
  returnAmountsSchema,
  returnLineSchema,
} from './documents'
import {
  allocateReturnAmounts,
  allocateReturnLine,
  allocateReturnPayments,
  originalReturnAmounts,
  returnAmountFields,
  subtractReturnAmounts,
  sumReturnAmounts,
} from '../return-allocation'

const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase(), 'Use the original canonical reference.')
const revision = z.number().int().min(0).max(2_147_483_646)
const quantity = z.number().int().min(0).max(1_000_000)
export const returnSelectionSchema = z
  .object({
    lineNumber: z.number().int().min(1).max(200),
    quantityMilli: quantity.refine((n) => n > 0),
  })
  .strict()
export const returnRequestShape = {
  branchId: uuid,
  deviceId: uuid,
  shiftId: uuid,
  orderId: uuid,
  invoiceId: uuid,
  expectedRevision: revision,
  lines: z
    .array(returnSelectionSchema)
    .min(1)
    .max(200)
    .refine(
      (lines) => lines.every((line, i) => i === 0 || line.lineNumber > lines[i - 1].lineNumber),
      'Select each original line once, in order.'
    ),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .refine((value) => !value.includes('\u0000'), 'Remove the unsupported hidden character.'),
  // This is the way money is actually returned, not the original sale tender.
  // A bank transfer is recorded as completed outside the cash drawer.
  refundMethod: z.enum(['cash', 'bank_transfer']).optional(),
}
export const returnRequestSchema = z.object(returnRequestShape).strict()
const payments = z
  .array(
    z
      .object({
        method: z.enum(['cash', 'card', 'bank_transfer']),
        amountFils: z.number().int().min(1).max(100_000_000),
      })
      .strict()
  )
  .max(2)
export const returnStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    invoice: originalReturnInvoiceSchema,
    revision,
    returned: z
      .array(
        z.object({ lineNumber: z.number().int().min(1).max(200), quantityMilli: quantity }).strict()
      )
      .min(1)
      .max(200),
    refundedPayments: payments,
    adjustedTotals: returnAmountsSchema,
    fullyReturned: z.boolean(),
  })
  .strict()
  .superRefine((state, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })
    const invoice = state.invoice
    if (
      state.returned.length !== invoice.lines.length ||
      state.returned.some((line, i) => line.lineNumber !== invoice.lines[i]?.lineNumber)
    ) {
      fail('Returned line coverage differs from the invoice.')
      return
    }
    try {
      const returned = sumReturnAmounts(
        invoice.lines.map((line, i) =>
          allocateReturnAmounts(line, 0, state.returned[i].quantityMilli)
        )
      )
      const remaining = subtractReturnAmounts(originalReturnAmounts(invoice.totals), returned)
      for (const field of returnAmountFields)
        if (remaining[field] !== state.adjustedTotals[field])
          fail('Returned balance does not reconcile.')
      if (
        state.refundedPayments.reduce((sum, payment) => sum + payment.amountFils, 0) !==
        returned.grossFils
      )
        fail('Recorded returned money does not reconcile.')
      if (
        state.fullyReturned !==
        invoice.lines.every((line, i) => line.quantityMilli === state.returned[i].quantityMilli)
      )
        fail('Remaining quantity status differs.')
      if ((state.revision === 0) !== state.returned.every((line) => line.quantityMilli === 0))
        fail('Return revision does not match quantities.')
    } catch {
      fail('Saved return quantities are invalid.')
    }
  })
export const returnPreviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    branchId: uuid,
    deviceId: uuid,
    shiftId: uuid,
    orderId: uuid,
    invoiceId: uuid,
    expectedRevision: revision,
    reason: returnRequestShape.reason,
    lines: z.array(returnLineSchema).min(1).max(200),
    previousAdjustedTotals: returnAmountsSchema,
    totals: returnAmountsSchema,
    adjustedTotals: returnAmountsSchema,
    payments,
    fullyReturned: z.boolean(),
    quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((preview, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })
    for (const [i, line] of preview.lines.entries()) {
      if (
        line.lineNumber !== i + 1 ||
        line.originalLineNumber !== line.originalLine.lineNumber ||
        (i > 0 && line.originalLineNumber <= preview.lines[i - 1].originalLineNumber) ||
        line.returnedAfterQuantityMilli !== line.returnedBeforeQuantityMilli + line.quantityMilli
      )
        fail('Preview line identities differ.')
      for (const field of ['productId', 'name', 'unit', 'unitPriceFils', 'taxRateBps'] as const)
        if (line[field] !== line.originalLine[field]) fail('Preview changed an original line.')
      try {
        const expected = allocateReturnAmounts(
          line.originalLine,
          line.returnedBeforeQuantityMilli,
          line.quantityMilli
        )
        for (const field of returnAmountFields)
          if (line[field] !== expected[field]) fail('Preview allocation differs.')
      } catch {
        fail('Preview quantity is invalid.')
      }
    }
    const total = sumReturnAmounts(preview.lines)
    for (const field of returnAmountFields)
      if (
        total[field] !== preview.totals[field] ||
        preview.previousAdjustedTotals[field] - preview.totals[field] !==
          preview.adjustedTotals[field]
      )
        fail('Preview balance differs.')
    for (const value of [preview.previousAdjustedTotals, preview.totals, preview.adjustedTotals])
      if (
        value.netFils + value.taxFils !== value.grossFils ||
        value.beforeDiscountFils - value.discountFils !== value.grossFils
      )
        fail('Preview amounts differ.')
    if (
      preview.payments.reduce((sum, p) => sum + p.amountFils, 0) !== preview.totals.grossFils ||
      new Set(preview.payments.map((p) => p.method)).size !== preview.payments.length
    )
      fail('Preview tender differs.')
    if (
      preview.fullyReturned &&
      returnAmountFields.some((field) => preview.adjustedTotals[field] !== 0)
    )
      fail('Completed preview has an outstanding balance.')
  })
export type ReturnSelection = z.infer<typeof returnSelectionSchema>
export type ReturnRequest = z.infer<typeof returnRequestSchema>
export type ReturnState = z.infer<typeof returnStateSchema>
export type ReturnPreview = z.infer<typeof returnPreviewSchema>
export type ReturnLine = z.infer<typeof returnLineSchema>

function samePayments(
  a: { method: string; amountFils: number }[],
  b: { method: string; amountFils: number }[]
) {
  return (
    a.length === b.length &&
    new Set(b.map((p) => p.method)).size === b.length &&
    a.every((p) => b.find((other) => other.method === p.method)?.amountFils === p.amountFils)
  )
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + stable(v))
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}
export function returnPreviewMatchesRequest(request: ReturnRequest, preview: ReturnPreview) {
  return (
    (
      [
        'branchId',
        'deviceId',
        'shiftId',
        'orderId',
        'invoiceId',
        'expectedRevision',
        'reason',
      ] as const
    ).every((key) => request[key] === preview[key]) &&
    request.lines.length === preview.lines.length &&
    request.lines.every(
      (line, i) =>
        line.lineNumber === preview.lines[i].originalLineNumber &&
        line.quantityMilli === preview.lines[i].quantityMilli
    )
  )
}
/** Server still authorizes/recalculates at commit. This rejects stale or malformed
 * display data before an operator can consent to it. It never authors money. */
export function validateReturnPreview(
  rawState: unknown,
  rawRequest: unknown,
  rawPreview: unknown
): ReturnPreview {
  const state = returnStateSchema.parse(rawState),
    request = returnRequestSchema.parse(rawRequest),
    preview = returnPreviewSchema.parse(rawPreview)
  if (
    !returnPreviewMatchesRequest(request, preview) ||
    state.revision !== request.expectedRevision ||
    state.invoice.branchId !== request.branchId ||
    state.invoice.orderId !== request.orderId ||
    state.invoice.id !== request.invoiceId
  )
    throw new Error('The return preview is no longer current.')
  const selected = request.lines.map((selection, i) => {
    const original = state.invoice.lines[selection.lineNumber - 1]
    if (!original || original.lineNumber !== selection.lineNumber)
      throw new Error('Unknown original invoice line.')
    return allocateReturnLine(
      original,
      state.returned[selection.lineNumber - 1].quantityMilli,
      selection.quantityMilli,
      i + 1
    )
  })
  const totals = sumReturnAmounts(selected)
  const expectedRemaining = subtractReturnAmounts(state.adjustedTotals, totals)
  const expectedPayments = request.refundMethod
    ? totals.grossFils
      ? [{ method: request.refundMethod, amountFils: totals.grossFils }]
      : []
    : allocateReturnPayments(
        state.invoice.payments,
        state.invoice.totals.grossFils - state.adjustedTotals.grossFils,
        totals.grossFils,
        state.invoice.totals.grossFils
      )
  const fullyReturned = state.invoice.lines.every(
    (line, i) =>
      state.returned[i].quantityMilli +
        (request.lines.find((row) => row.lineNumber === line.lineNumber)?.quantityMilli ?? 0) ===
      line.quantityMilli
  )
  if (
    stable(selected) !== stable(preview.lines) ||
    stable(totals) !== stable(preview.totals) ||
    stable(state.adjustedTotals) !== stable(preview.previousAdjustedTotals) ||
    stable(expectedRemaining) !== stable(preview.adjustedTotals) ||
    !samePayments(expectedPayments, preview.payments) ||
    fullyReturned !== preview.fullyReturned
  )
    throw new Error('The saved invoice and return preview do not match.')
  return preview
}
/** Acknowledgements are checked against the persisted exact financial request,
 * including after the original account/shift has lost authority. */
export function returnCreditMatchesCommand(
  command: unknown,
  credit: unknown,
  actorId?: string
): boolean {
  const commandSchema = z
    .object({
      id: uuid,
      type: z.literal('refund.items'),
      ...returnRequestShape,
      quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
  const parsed = commandSchema.safeParse(command),
    document = partialCreditDocumentSchema.safeParse(credit)
  if (!parsed.success || !document.success) return false
  const request = parsed.data,
    bill = document.data
  return (
    (!actorId || bill.actorId === actorId) &&
    bill.branchId === request.branchId &&
    bill.deviceId === request.deviceId &&
    bill.shiftId === request.shiftId &&
    bill.orderId === request.orderId &&
    bill.originalInvoice.documentId === request.invoiceId &&
    bill.returnRevision === request.expectedRevision + 1 &&
    bill.reason === request.reason &&
    (!request.refundMethod ||
      (bill.payments.length === (bill.totals.grossFils ? 1 : 0) &&
        (!bill.payments.length || bill.payments[0].method === request.refundMethod))) &&
    bill.quoteHash === request.quoteHash &&
    bill.lines.length === request.lines.length &&
    request.lines.every(
      (line, i) =>
        line.lineNumber === bill.lines[i].originalLineNumber &&
        line.quantityMilli === bill.lines[i].quantityMilli
    )
  )
}
