import { z } from 'zod'
const integer = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
const positive = integer.nonnegative()
export const reportDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(value + 'T00:00:00Z')
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value &&
      value >= '2000-01-01' &&
      value <= '2100-12-31'
    )
  }, 'Enter a valid calendar date.')
export const reportQuerySchema = z
  .object({
    branchId: z.string().uuid(),
    start: reportDate,
    end: reportDate,
    format: z.enum(['json', 'csv']).default('json'),
  })
  .strict()
  .refine((query) => {
    const days = (Date.parse(query.end) - Date.parse(query.start)) / 86400000
    return days >= 0 && days <= 92
  }, 'Choose an inclusive range of up to 93 days.')
const amounts = {
  salesGrossFils: positive,
  refundGrossFils: positive,
  netGrossFils: integer,
  netExVatFils: integer,
  vatFils: integer,
}
const counts = { invoiceCount: positive, creditNoteCount: positive }
export const branchReportSchema = z
  .object({
    status: z.literal('ready'),
    branchId: z.string().uuid(),
    branchName: z.string().min(1).max(120),
    currency: z.literal('AED'),
    timezone: z.literal('Asia/Dubai'),
    startDate: reportDate,
    endDate: reportDate,
    generatedAt: z.string().datetime({ offset: true }),
    basis: z.literal('issued_fiscal_documents'),
    documentCount: positive.max(50000),
    legacyOrdersExcluded: positive,
    summary: z.object({ ...amounts, ...counts }),
    days: z
      .array(z.object({ date: reportDate, ...amounts, ...counts }))
      .min(1)
      .max(93),
    payments: z
      .array(
        z.object({
          method: z.enum(['cash', 'card', 'bank_transfer']),
          salesFils: positive,
          refundsFils: positive,
          netFils: integer,
        })
      )
      .min(2)
      .max(3),
    vatRates: z
      .array(z.object({ taxRateBps: z.number().int().min(0).max(10000), ...amounts }))
      .max(10001),
    products: z
      .array(
        z.object({
          productId: z.string().uuid(),
          name: z.string().min(1).max(240),
          unit: z.enum(['piece', 'pack', 'kg']),
          soldQuantityMilli: positive,
          refundedQuantityMilli: positive,
          netQuantityMilli: integer,
          ...amounts,
        })
      )
      .max(5000),
    categoryAnalytics: z.object({
      documentCount: positive.max(50000),
      excludedDocumentCount: positive.max(50000),
      ...amounts,
    }),
    categories: z
      .array(
        z.object({
          category: z.string().trim().min(1).max(120),
          soldQuantityMilli: positive,
          refundedQuantityMilli: positive,
          netQuantityMilli: integer,
          ...amounts,
        })
      )
      .max(5000),
  })
  .superRefine((report, ctx) => {
    const fail = () =>
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Report totals or scope do not reconcile.',
      })
    const metrics = [
      'salesGrossFils',
      'refundGrossFils',
      'netGrossFils',
      'netExVatFils',
      'vatFils',
    ] as const
    if (
      report.summary.invoiceCount + report.summary.creditNoteCount !== report.documentCount ||
      new Set(report.payments.map((p) => p.method)).size !== report.payments.length
    )
      fail()
    const expectedDays = (Date.parse(report.endDate) - Date.parse(report.startDate)) / 86400000 + 1
    if (
      report.days.length !== expectedDays ||
      report.days.some(
        (day, index) =>
          day.date !==
          new Date(Date.parse(report.startDate) + index * 86400000).toISOString().slice(0, 10)
      )
    )
      fail()
    for (const rows of [report.days, report.vatRates, report.products])
      for (const key of metrics)
        if (rows.reduce((sum, row) => sum + row[key], 0) !== report.summary[key]) fail()
    for (const row of [report.summary, ...report.days, ...report.vatRates, ...report.products])
      if (
        row.salesGrossFils - row.refundGrossFils !== row.netGrossFils ||
        row.netExVatFils + row.vatFils !== row.netGrossFils
      )
        fail()
    for (const key of ['invoiceCount', 'creditNoteCount'] as const)
      if (report.days.reduce((sum, row) => sum + row[key], 0) !== report.summary[key]) fail()
    if (
      report.payments.reduce((sum, p) => sum + p.salesFils, 0) !== report.summary.salesGrossFils ||
      report.payments.reduce((sum, p) => sum + p.refundsFils, 0) !==
        report.summary.refundGrossFils ||
      report.payments.some((p) => p.salesFils - p.refundsFils !== p.netFils)
    )
      fail()
    if (
      report.products.some(
        (p) => p.soldQuantityMilli - p.refundedQuantityMilli !== p.netQuantityMilli
      )
    )
      fail()
    const category = report.categoryAnalytics
    if (category.documentCount + category.excludedDocumentCount !== report.documentCount) fail()
    for (const key of metrics)
      if (report.categories.reduce((sum, row) => sum + row[key], 0) !== category[key]) fail()
    if (
      report.categories.some(
        (row) => row.soldQuantityMilli - row.refundedQuantityMilli !== row.netQuantityMilli
      ) ||
      category.salesGrossFils - category.refundGrossFils !== category.netGrossFils ||
      category.netExVatFils + category.vatFils !== category.netGrossFils
    )
      fail()
  })
export type BranchReport = z.infer<typeof branchReportSchema>
export function dubaiToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dubai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}
