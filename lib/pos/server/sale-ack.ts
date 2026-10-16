import type { LiveOrder } from './live-contracts'
import type { FiscalDocument, ReceiptDocument } from './documents'
import { z } from 'zod'

const settledTabSchema = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().min(1).max(2_147_483_647),
  })
  .strict()
/** A receipt alone does not prove that the linked unpaid order was settled. */
export function settlementMatchesSale(order: LiveOrder, result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  if (!order.sourceTab) return !('settledTab' in result)
  if (!('settledTab' in result)) return false
  const link = settledTabSchema.safeParse(result.settledTab)
  return (
    link.success &&
    link.data.id.toLowerCase() === order.sourceTab.id.toLowerCase() &&
    link.data.revision === order.sourceTab.expectedRevision + 1
  )
}

/** Never clear an immutable pending request on a well-formed but unrelated invoice. */
export function invoiceMatchesSale(
  order: LiveOrder,
  document: FiscalDocument
): document is ReceiptDocument {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  if (
    document.kind !== 'tax_invoice' ||
    !same(document.orderId, order.id) ||
    !same(document.branchId, order.branchId) ||
    !same(document.deviceId, order.deviceId) ||
    !same(document.shiftId, order.shiftId) ||
    !same(document.merchant.id, order.profileId) ||
    document.serviceType !== order.serviceType ||
    document.totals.grossFils !== order.expectedTotalFils ||
    document.cashTenderedFils !== order.cashTenderedFils
  )
    return false
  const expectedLines = order.lines
    .map((line) =>
      JSON.stringify([
        line.productId.toLowerCase(),
        line.quantityMilli,
        line.expectedUnitPriceFils,
        line.expectedTaxRateBps,
      ])
    )
    .sort()
  const actualLines = document.lines
    .map((line) =>
      JSON.stringify([
        line.productId.toLowerCase(),
        line.quantityMilli,
        line.unitPriceFils,
        line.taxRateBps,
      ])
    )
    .sort()
  if (JSON.stringify(expectedLines) !== JSON.stringify(actualLines)) return false
  const payments = (rows: { method: string; amountFils: number }[]) =>
    JSON.stringify(
      rows
        .map((row) => [row.method, row.amountFils])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    )
  if (
    payments(order.payments) !== payments(document.payments) ||
    JSON.stringify(
      order.customer ? [order.customer.name, order.customer.address, order.customer.trn] : null
    ) !==
      JSON.stringify(
        document.customer
          ? [document.customer.name, document.customer.address, document.customer.trn]
          : null
      )
  )
    return false
  if (!order.offerSelection) return document.schemaVersion === 1
  return (
    document.schemaVersion === 2 &&
    same(document.appliedOffer.offerId, order.offerSelection.offerId) &&
    document.appliedOffer.offerRevision === order.offerSelection.expectedRevision &&
    document.totals.discountFils === order.offerSelection.expectedDiscountFils
  )
}
