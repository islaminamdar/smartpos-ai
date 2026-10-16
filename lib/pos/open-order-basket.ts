import type { LiveBootstrap, LiveOrder } from './server/live-contracts'
import type { OpenOrderTab } from './server/open-order-contracts'

/** Keep the saved prices/revisions until staff explicitly review the current menu. */
export function basketFromOpenOrder(tab: OpenOrderTab) {
  return tab.lines.map((line) => ({
    quantityMilli: line.quantityMilli,
    product: {
      id: line.productId,
      branchId: tab.branchId,
      name: line.name,
      category: line.category,
      imageUrl: line.imageUrl,
      unit: line.unit,
      unitPriceFils: line.unitPriceFils,
      taxRateBps: line.taxRateBps,
      revision: line.revision,
    } satisfies LiveBootstrap['catalogue'][number],
  }))
}
export function openOrderBasketMatches(
  tab: OpenOrderTab,
  serviceType: LiveOrder['serviceType'],
  lines: LiveOrder['lines']
) {
  return (
    tab.status === 'open' &&
    tab.serviceType === serviceType &&
    tab.lines.length === lines.length &&
    new Set(lines.map((line) => line.productId)).size === lines.length &&
    lines.every((line) =>
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
