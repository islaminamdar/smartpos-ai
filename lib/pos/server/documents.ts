import { z } from 'zod'
import { offerQuoteSchema } from './offers'
import {
  allocateReturnAmounts,
  originalReturnAmounts,
  returnAmountFields,
} from '../return-allocation'

const uuid = z.string().uuid()
const text = (max: number) => z.string().trim().min(1).max(max)
const fils = z.number().int().min(0).max(100_000_000)
const timestamp = z.string().datetime({ offset: true })
export const receiptCustomerSchema = z
  .object({
    name: text(200),
    address: text(400),
    trn: z
      .string()
      .regex(/^\d{15}$/)
      .nullable(),
  })
  .strict()

/** Server-owned immutable version. No real customer configuration belongs in a public bundle. */
export const merchantProfileSchema = z
  .object({
    id: uuid,
    organizationId: uuid,
    branchId: uuid,
    legalName: text(200),
    branchName: text(120),
    address: text(400),
    phone: text(30),
    trn: z.string().regex(/^\d{15}$/),
    taxRegistered: z.literal(true),
    currency: z.literal('AED'),
    timezone: z.literal('Asia/Dubai'),
    taxInclusive: z.literal(true),
    calculationVersion: z.literal('line-v2'),
    confirmedBy: uuid,
    confirmedAt: timestamp,
  })
  .strict()
export type MerchantProfile = z.infer<typeof merchantProfileSchema>

const totalsSchema = z.object({ grossFils: fils, netFils: fils, taxFils: fils }).strict()
const lineSchema = z
  .object({
    lineNumber: z.number().int().min(1).max(200),
    productId: uuid,
    name: text(240),
    unit: z.enum(['piece', 'pack', 'kg']),
    quantityMilli: z.number().int().min(1).max(1_000_000),
    unitPriceFils: fils,
    taxRateBps: z.number().int().min(0).max(10_000),
    grossFils: fils,
    netFils: fils,
    taxFils: fils,
  })
  .strict()
const paymentSchema = z
  .object({ method: z.enum(['cash', 'card']), amountFils: fils.refine((value) => value > 0) })
  .strict()
const common = {
  schemaVersion: z.literal(1),
  id: uuid,
  documentNumber: z.string().regex(/^[A-Z0-9]{2,16}-(INV|CN)-\d{10}$/),
  issuedAt: timestamp,
  merchant: merchantProfileSchema,
  orderId: uuid,
  branchId: uuid,
  deviceId: uuid,
  shiftId: uuid,
  actorId: uuid,
  serviceType: z.enum(['dine_in', 'takeaway', 'delivery']),
  customer: receiptCustomerSchema.nullable(),
  lines: z.array(lineSchema).min(1).max(200),
  totals: totalsSchema,
  payments: z.array(paymentSchema).min(1).max(2),
  paymentSettlement: z.literal('recorded'),
}
const invoice = z
  .object({ ...common, kind: z.literal('tax_invoice'), cashTenderedFils: fils, changeFils: fils })
  .strict()
const credit = z
  .object({
    ...common,
    kind: z.literal('tax_credit_note'),
    reason: text(240),
    originalInvoice: z
      .object({
        documentId: uuid,
        documentNumber: text(40),
        issuedAt: timestamp,
        totalFils: fils,
        taxFils: fils,
      })
      .strict(),
    adjustedTotals: z
      .object({ grossFils: z.literal(0), netFils: z.literal(0), taxFils: z.literal(0) })
      .strict(),
  })
  .strict()

const discountedLineSchema = lineSchema
  .extend({
    beforeDiscountFils: fils,
    discountFils: fils,
    eligibleQuantityMilli: z.number().int().min(0).max(1_000_000),
    rewardQuantityMilli: z.number().int().min(0).max(1_000_000),
    bundleQuantityMilli: z.number().int().min(0).max(1_000_000),
  })
  .strict()
const discountFields = {
  schemaVersion: z.literal(2),
  lines: z.array(discountedLineSchema).min(1).max(200),
  totals: totalsSchema.extend({ beforeDiscountFils: fils, discountFils: fils }).strict(),
  appliedOffer: offerQuoteSchema,
}
const invoiceV2 = invoice.extend(discountFields).strict()
const creditV2 = credit.extend(discountFields).strict()

/** Validate original and discounted immutable documents without rewriting old invoices. */
export const legacyFiscalDocumentSchema = z
  .union([invoice, credit, invoiceV2, creditV2])
  .superRefine((document, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })
    if (document.merchant.branchId !== document.branchId)
      fail('Merchant branch does not match document.')
    if (
      document.lines.some(
        (line, index) =>
          line.lineNumber !== index + 1 ||
          line.netFils + line.taxFils !== line.grossFils ||
          line.taxFils !==
            Math.round((line.grossFils * line.taxRateBps) / (10000 + line.taxRateBps)) ||
          (line.unit !== 'kg' && line.quantityMilli % 1000 !== 0)
      )
    )
      fail('Document lines do not reconcile.')
    if (document.schemaVersion === 1) {
      if (
        document.lines.some(
          (line) => line.grossFils !== Math.round((line.unitPriceFils * line.quantityMilli) / 1000)
        )
      )
        fail('Original line price does not reconcile.')
    } else {
      const offer = document.appliedOffer
      if (
        offer.appliedDefinition.branchId !== document.branchId ||
        offer.lines.length !== document.lines.length ||
        new Set(document.lines.map((line) => line.productId.toLowerCase())).size !==
          document.lines.length
      )
        fail('Applied offer scope does not reconcile.')
      for (const field of [
        'beforeDiscountFils',
        'discountFils',
        'grossFils',
        'taxFils',
        'netFils',
      ] as const) {
        if (
          document.totals[field] !== offer[field] ||
          document.lines.reduce((sum, line) => sum + line[field], 0) !== document.totals[field]
        )
          fail('Discount totals do not reconcile.')
      }
      for (const line of document.lines) {
        const allocation = offer.lines.find((row) => row.productId === line.productId.toLowerCase())
        if (
          !allocation ||
          line.beforeDiscountFils !==
            Math.round((line.unitPriceFils * line.quantityMilli) / 1000) ||
          line.beforeDiscountFils - line.discountFils !== line.grossFils ||
          line.eligibleQuantityMilli > line.quantityMilli ||
          line.rewardQuantityMilli > line.eligibleQuantityMilli ||
          line.bundleQuantityMilli > line.eligibleQuantityMilli ||
          (line.unit === 'kg' &&
            (line.rewardQuantityMilli !== 0 || line.bundleQuantityMilli !== 0)) ||
          line.rewardQuantityMilli % 1000 !== 0 ||
          line.bundleQuantityMilli % 1000 !== 0
        )
          fail('Discount line does not reconcile.')
        if (allocation)
          for (const field of [
            'beforeDiscountFils',
            'discountFils',
            'grossFils',
            'taxFils',
            'netFils',
            'eligibleQuantityMilli',
            'rewardQuantityMilli',
            'bundleQuantityMilli',
          ] as const)
            if (line[field] !== allocation[field])
              fail('Applied allocation differs from invoice line.')
      }
    }
    for (const field of ['grossFils', 'netFils', 'taxFils'] as const) {
      if (document.lines.reduce((sum, line) => sum + line[field], 0) !== document.totals[field])
        fail('Document totals do not reconcile.')
    }
    if (
      !document.totals.grossFils ||
      document.payments.reduce((sum, payment) => sum + payment.amountFils, 0) !==
        document.totals.grossFils ||
      new Set(document.payments.map((payment) => payment.method)).size !== document.payments.length
    )
      fail('Document payments do not reconcile.')
    if (!document.customer && document.totals.grossFils > 1_000_000)
      fail('Buyer details are required above the simplified pilot limit.')
    if (document.kind === 'tax_invoice') {
      const cashApplied =
        document.payments.find((payment) => payment.method === 'cash')?.amountFils ?? 0
      if (
        !document.documentNumber.includes('-INV-') ||
        document.cashTenderedFils < cashApplied ||
        document.changeFils !== document.cashTenderedFils - cashApplied ||
        (!cashApplied && document.cashTenderedFils !== 0)
      )
        fail('Invoice cash or number does not reconcile.')
    } else if (
      !document.documentNumber.includes('-CN-') ||
      document.originalInvoice.totalFils !== document.totals.grossFils ||
      document.originalInvoice.taxFils !== document.totals.taxFils
    ) {
      fail('Full credit note does not reverse its original invoice.')
    }
  })

export const returnAmountsSchema = totalsSchema
  .extend({ beforeDiscountFils: fils, discountFils: fils })
  .strict()
export const returnLineSchema = lineSchema
  .extend({
    originalLineNumber: z.number().int().min(1).max(200),
    beforeDiscountFils: fils,
    discountFils: fils,
    returnedBeforeQuantityMilli: z.number().int().min(0).max(1_000_000),
    returnedAfterQuantityMilli: z.number().int().min(1).max(1_000_000),
    originalLine: z.union([lineSchema, discountedLineSchema]),
  })
  .strict()
const originalInvoiceReference = z
  .object({
    documentId: uuid,
    documentNumber: z.string().regex(/^[A-Z0-9]{2,16}-INV-\d{10}$/),
    issuedAt: timestamp,
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    totalFils: fils.refine((n) => n > 0),
    taxFils: fils,
    netFils: fils,
    beforeDiscountFils: fils,
    discountFils: fils,
  })
  .strict()
export const partialCreditDocumentSchema = z
  .object({
    ...common,
    schemaVersion: z.literal(3),
    kind: z.literal('tax_credit_note'),
    reason: text(240),
    lines: z.array(returnLineSchema).min(1).max(200),
    totals: returnAmountsSchema,
    payments: z.array(paymentSchema).max(2),
    originalInvoice: originalInvoiceReference,
    originalOffer: offerQuoteSchema.nullable(),
    previousAdjustedTotals: returnAmountsSchema,
    adjustedTotals: returnAmountsSchema,
    returnRevision: z.number().int().min(1).max(2_147_483_647),
    fullyReturned: z.boolean(),
    quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((document, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })
    const original = document.originalInvoice
    if (
      document.merchant.branchId !== document.branchId ||
      !document.documentNumber.includes('-CN-') ||
      document.id === original.documentId ||
      original.netFils + original.taxFils !== original.totalFils ||
      original.beforeDiscountFils - original.discountFils !== original.totalFils ||
      (original.schemaVersion === 1 &&
        (document.originalOffer !== null || original.discountFils !== 0)) ||
      (original.schemaVersion === 2 && document.originalOffer === null)
    )
      fail('Original return identity does not reconcile.')
    const amounts = {
      beforeDiscountFils: original.beforeDiscountFils,
      discountFils: original.discountFils,
      grossFils: original.totalFils,
      netFils: original.netFils,
      taxFils: original.taxFils,
    }
    for (const value of [
      document.totals,
      document.previousAdjustedTotals,
      document.adjustedTotals,
    ]) {
      if (
        value.netFils + value.taxFils !== value.grossFils ||
        value.beforeDiscountFils - value.discountFils !== value.grossFils
      )
        fail('Return amounts do not reconcile.')
    }
    for (const field of returnAmountFields) {
      if (
        document.lines.reduce((sum, line) => sum + line[field], 0) !== document.totals[field] ||
        document.previousAdjustedTotals[field] > amounts[field] ||
        document.previousAdjustedTotals[field] - document.totals[field] !==
          document.adjustedTotals[field]
      )
        fail('Return balance does not reconcile.')
      if (
        document.returnRevision === 1 &&
        document.previousAdjustedTotals[field] !== amounts[field]
      )
        fail('First return must start at the original balance.')
      if (
        document.lines.reduce(
          (sum, line) => sum + originalReturnAmounts(line.originalLine)[field],
          0
        ) > amounts[field]
      )
        fail('Original selected lines exceed the invoice.')
      if (document.fullyReturned && document.adjustedTotals[field] !== 0)
        fail('Completed return has an outstanding balance.')
      if (document.originalOffer && document.originalOffer[field] !== amounts[field])
        fail('Original offer totals differ.')
    }
    if (
      document.originalOffer &&
      document.originalOffer.appliedDefinition.branchId !== document.branchId
    )
      fail('Original offer branch differs.')
    let previousLine = 0
    for (const [index, line] of document.lines.entries()) {
      const saved = line.originalLine
      if (
        line.lineNumber !== index + 1 ||
        line.originalLineNumber <= previousLine ||
        saved.lineNumber !== line.originalLineNumber ||
        line.returnedBeforeQuantityMilli + line.quantityMilli !== line.returnedAfterQuantityMilli ||
        line.returnedAfterQuantityMilli > saved.quantityMilli ||
        (document.returnRevision === 1 && line.returnedBeforeQuantityMilli !== 0) ||
        (document.fullyReturned && line.returnedAfterQuantityMilli !== saved.quantityMilli)
      )
        fail('Return quantity references do not reconcile.')
      previousLine = line.originalLineNumber
      for (const field of ['productId', 'name', 'unit', 'unitPriceFils', 'taxRateBps'] as const)
        if (line[field] !== saved[field]) fail('Return changed an original line.')
      if (
        saved.netFils + saved.taxFils !== saved.grossFils ||
        saved.taxFils !==
          Math.round((saved.grossFils * saved.taxRateBps) / (10_000 + saved.taxRateBps)) ||
        (saved.unit !== 'kg' && saved.quantityMilli % 1000 !== 0)
      )
        fail('Original return line is invalid.')
      const savedAmounts = originalReturnAmounts(saved)
      if (
        savedAmounts.beforeDiscountFils !==
          Math.round((saved.unitPriceFils * saved.quantityMilli) / 1000) ||
        savedAmounts.beforeDiscountFils - savedAmounts.discountFils !== saved.grossFils ||
        (original.schemaVersion === 1 && 'discountFils' in saved) ||
        (original.schemaVersion === 2 && !('discountFils' in saved))
      )
        fail('Original line discount is invalid.')
      if ('discountFils' in saved) {
        const allocation = document.originalOffer?.lines.find(
          (row) => row.productId === saved.productId.toLowerCase()
        )
        if (
          !allocation ||
          saved.eligibleQuantityMilli > saved.quantityMilli ||
          saved.rewardQuantityMilli > saved.eligibleQuantityMilli ||
          saved.bundleQuantityMilli > saved.eligibleQuantityMilli ||
          saved.rewardQuantityMilli % 1000 !== 0 ||
          saved.bundleQuantityMilli % 1000 !== 0 ||
          (saved.unit === 'kg' &&
            (saved.rewardQuantityMilli !== 0 || saved.bundleQuantityMilli !== 0))
        )
          fail('Original offer allocation is invalid.')
        if (allocation)
          for (const field of [
            ...returnAmountFields,
            'eligibleQuantityMilli',
            'rewardQuantityMilli',
            'bundleQuantityMilli',
          ] as const)
            if (saved[field] !== allocation[field]) fail('Original offer allocation changed.')
      }
      try {
        const allocated = allocateReturnAmounts(
          saved,
          line.returnedBeforeQuantityMilli,
          line.quantityMilli
        )
        for (const field of returnAmountFields)
          if (allocated[field] !== line[field]) fail('Original component allocation differs.')
      } catch {
        fail('Return quantity is invalid.')
      }
    }
    if (
      document.payments.reduce((sum, p) => sum + p.amountFils, 0) !== document.totals.grossFils ||
      new Set(document.payments.map((p) => p.method)).size !== document.payments.length ||
      (document.totals.grossFils === 0 && document.payments.length !== 0)
    )
      fail('Returned payments do not reconcile.')
    if (!document.customer && original.totalFils > 1_000_000)
      fail('Original buyer details are required.')
  })

/** Old snapshots retain the old strict rules; v3 credits carry cumulative allocation evidence. */
export const fiscalDocumentSchema = z.union([
  legacyFiscalDocumentSchema,
  partialCreditDocumentSchema,
])
export const originalReturnInvoiceSchema = legacyFiscalDocumentSchema.refine(
  (
    document
  ): document is Extract<z.infer<typeof legacyFiscalDocumentSchema>, { kind: 'tax_invoice' }> =>
    document.kind === 'tax_invoice',
  'A return must reference an original tax invoice.'
)
export type FiscalDocument = z.infer<typeof fiscalDocumentSchema>
export type ReceiptDocument = Extract<FiscalDocument, { kind: 'tax_invoice' }>
export type CreditDocument = Extract<FiscalDocument, { kind: 'tax_credit_note' }>
export type PartialCreditDocument = z.infer<typeof partialCreditDocumentSchema>
