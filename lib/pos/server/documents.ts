import { z } from 'zod'

const uuid = z.string().uuid()
const text = (max: number) => z.string().trim().min(1).max(max)
const fils = z.number().int().min(0).max(100_000_000)
const timestamp = z.string().datetime({ offset: true })
export const receiptCustomerSchema = z.object({ name: text(200), address: text(400), trn: z.string().regex(/^\d{15}$/).nullable() }).strict()

/** Server-owned immutable version. No real customer configuration belongs in a public bundle. */
export const merchantProfileSchema = z.object({
  id: uuid, organizationId: uuid, branchId: uuid,
  legalName: text(200), branchName: text(120), address: text(400), phone: text(30),
  trn: z.string().regex(/^\d{15}$/), taxRegistered: z.literal(true),
  currency: z.literal('AED'), timezone: z.literal('Asia/Dubai'),
  taxInclusive: z.literal(true), calculationVersion: z.literal('line-v2'),
  confirmedBy: uuid, confirmedAt: timestamp,
}).strict()
export type MerchantProfile = z.infer<typeof merchantProfileSchema>

const totalsSchema = z.object({ grossFils: fils, netFils: fils, taxFils: fils }).strict()
const lineSchema = z.object({
  lineNumber: z.number().int().min(1).max(200), productId: uuid, name: text(240),
  unit: z.enum(['piece', 'pack', 'kg']), quantityMilli: z.number().int().min(1).max(1_000_000),
  unitPriceFils: fils, taxRateBps: z.number().int().min(0).max(10_000),
  grossFils: fils, netFils: fils, taxFils: fils,
}).strict()
const paymentSchema = z.object({ method: z.enum(['cash', 'card']), amountFils: fils.refine(value => value > 0) }).strict()
const common = {
  schemaVersion: z.literal(1), id: uuid,
  documentNumber: z.string().regex(/^[A-Z0-9]{2,16}-(INV|CN)-\d{10}$/), issuedAt: timestamp,
  merchant: merchantProfileSchema, orderId: uuid, branchId: uuid, deviceId: uuid, shiftId: uuid, actorId: uuid,
  serviceType: z.enum(['dine_in', 'takeaway', 'delivery']), customer: receiptCustomerSchema.nullable(),
  lines: z.array(lineSchema).min(1).max(200), totals: totalsSchema,
  payments: z.array(paymentSchema).min(1).max(2), paymentSettlement: z.literal('recorded'),
}
const invoice = z.object({ ...common, kind: z.literal('tax_invoice'), cashTenderedFils: fils, changeFils: fils }).strict()
const credit = z.object({
  ...common, kind: z.literal('tax_credit_note'), reason: text(240),
  originalInvoice: z.object({ documentId: uuid, documentNumber: text(40), issuedAt: timestamp, totalFils: fils, taxFils: fils }).strict(),
  adjustedTotals: z.object({ grossFils: z.literal(0), netFils: z.literal(0), taxFils: z.literal(0) }).strict(),
}).strict()

/** Responses are validated before UI use; the database is still the financial authority. */
export const fiscalDocumentSchema = z.discriminatedUnion('kind', [invoice, credit]).superRefine((document, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })
  if (document.merchant.branchId !== document.branchId) fail('Merchant branch does not match document.')
  if (document.lines.some((line, index) => line.lineNumber !== index + 1 || line.netFils + line.taxFils !== line.grossFils
    || line.grossFils !== Math.round(line.unitPriceFils * line.quantityMilli / 1000)
    || line.taxFils !== Math.round(line.grossFils * line.taxRateBps / (10000 + line.taxRateBps))
    || (line.unit !== 'kg' && line.quantityMilli % 1000 !== 0))) fail('Document lines do not reconcile.')
  for (const field of ['grossFils', 'netFils', 'taxFils'] as const) {
    if (document.lines.reduce((sum, line) => sum + line[field], 0) !== document.totals[field]) fail('Document totals do not reconcile.')
  }
  if (!document.totals.grossFils || document.payments.reduce((sum, payment) => sum + payment.amountFils, 0) !== document.totals.grossFils
    || new Set(document.payments.map(payment => payment.method)).size !== document.payments.length) fail('Document payments do not reconcile.')
  if (!document.customer && document.totals.grossFils > 1_000_000) fail('Buyer details are required above the simplified pilot limit.')
  if (document.kind === 'tax_invoice') {
    const cashApplied = document.payments.find(payment => payment.method === 'cash')?.amountFils ?? 0
    if (!document.documentNumber.includes('-INV-') || document.cashTenderedFils < cashApplied || document.changeFils !== document.cashTenderedFils - cashApplied
      || (!cashApplied && document.cashTenderedFils !== 0)) fail('Invoice cash or number does not reconcile.')
  } else if (!document.documentNumber.includes('-CN-') || document.originalInvoice.totalFils !== document.totals.grossFils || document.originalInvoice.taxFils !== document.totals.taxFils) {
    fail('Full credit note does not reverse its original invoice.')
  }
})
export type FiscalDocument = z.infer<typeof fiscalDocumentSchema>
export type ReceiptDocument = Extract<FiscalDocument, { kind: 'tax_invoice' }>
export type CreditDocument = Extract<FiscalDocument, { kind: 'tax_credit_note' }>
