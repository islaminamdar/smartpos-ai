/** Allocate saved totals, never current prices. Allocate quantity to original
 * before-discount value, then discount, then VAT. This preserves whole-unit
 * prices and makes every component monotone and conserved. */
export type ReturnAmounts = {
  beforeDiscountFils: number
  discountFils: number
  grossFils: number
  netFils: number
  taxFils: number
}
export type OriginalReturnLine = {
  lineNumber: number
  productId: string
  name: string
  unit: 'piece' | 'pack' | 'kg'
  quantityMilli: number
  unitPriceFils: number
  taxRateBps: number
  grossFils: number
  netFils: number
  taxFils: number
  beforeDiscountFils?: number
  discountFils?: number
}
export const returnAmountFields = [
  'beforeDiscountFils',
  'discountFils',
  'grossFils',
  'netFils',
  'taxFils',
] as const
export function originalReturnAmounts(value: {
  grossFils: number
  netFils: number
  taxFils: number
  beforeDiscountFils?: number
  discountFils?: number
}): ReturnAmounts {
  return {
    beforeDiscountFils: value.beforeDiscountFils ?? value.grossFils,
    discountFils: value.discountFils ?? 0,
    grossFils: value.grossFils,
    netFils: value.netFils,
    taxFils: value.taxFils,
  }
}
export function cumulativeReturnComponent(
  component: number,
  quantity: number,
  originalQuantity: number
) {
  if (
    !Number.isSafeInteger(component) ||
    component < 0 ||
    component > 100_000_000 ||
    !Number.isSafeInteger(quantity) ||
    !Number.isSafeInteger(originalQuantity) ||
    originalQuantity < 1 ||
    originalQuantity > 1_000_000 ||
    quantity < 0 ||
    quantity > originalQuantity
  )
    throw new Error('Invalid original return allocation')
  return Number((BigInt(component) * BigInt(quantity)) / BigInt(originalQuantity))
}
export function allocateReturnAmounts(
  original: OriginalReturnLine,
  before: number,
  quantity: number
): ReturnAmounts {
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < 0 ||
    before < 0 ||
    before + quantity > original.quantityMilli ||
    (original.unit !== 'kg' && (before % 1000 !== 0 || quantity % 1000 !== 0))
  )
    throw new Error('Invalid return quantity')
  const saved = originalReturnAmounts(original)
  if (
    returnAmountFields.some(
      (field) =>
        !Number.isSafeInteger(saved[field]) || saved[field] < 0 || saved[field] > 100_000_000
    ) ||
    saved.beforeDiscountFils - saved.discountFils !== saved.grossFils ||
    saved.netFils + saved.taxFils !== saved.grossFils
  )
    throw new Error('Invalid original return amounts')
  const at = (q: number): ReturnAmounts => {
    const beforeDiscountFils = cumulativeReturnComponent(
      saved.beforeDiscountFils,
      q,
      original.quantityMilli
    )
    const discountFils =
      saved.beforeDiscountFils === 0
        ? 0
        : Number(
            (BigInt(saved.discountFils) * BigInt(beforeDiscountFils)) /
              BigInt(saved.beforeDiscountFils)
          )
    const grossFils = beforeDiscountFils - discountFils
    const taxFils =
      saved.grossFils === 0
        ? 0
        : Number((BigInt(saved.taxFils) * BigInt(grossFils)) / BigInt(saved.grossFils))
    return { beforeDiscountFils, discountFils, grossFils, taxFils, netFils: grossFils - taxFils }
  }
  return subtractReturnAmounts(at(before + quantity), at(before))
}
export function allocateReturnLine<T extends OriginalReturnLine>(
  original: T,
  before: number,
  quantity: number,
  lineNumber: number
) {
  if (quantity <= 0) throw new Error('Select a positive return quantity')
  return {
    lineNumber,
    originalLineNumber: original.lineNumber,
    productId: original.productId,
    name: original.name,
    unit: original.unit,
    quantityMilli: quantity,
    unitPriceFils: original.unitPriceFils,
    taxRateBps: original.taxRateBps,
    ...allocateReturnAmounts(original, before, quantity),
    returnedBeforeQuantityMilli: before,
    returnedAfterQuantityMilli: before + quantity,
    originalLine: original,
  }
}
export function sumReturnAmounts(values: ReturnAmounts[]): ReturnAmounts {
  const result: ReturnAmounts = {
    beforeDiscountFils: 0,
    discountFils: 0,
    grossFils: 0,
    netFils: 0,
    taxFils: 0,
  }
  for (const value of values) for (const field of returnAmountFields) result[field] += value[field]
  return result
}
export function subtractReturnAmounts(before: ReturnAmounts, delta: ReturnAmounts): ReturnAmounts {
  const result = { ...before }
  for (const field of returnAmountFields) {
    result[field] -= delta[field]
    if (result[field] < 0) throw new Error('Return exceeds original balance')
  }
  return result
}
export function allocateReturnPayments(
  original: { method: 'cash' | 'card'; amountFils: number }[],
  before: number,
  gross: number,
  originalGross: number
) {
  if (
    ![before, gross, originalGross].every(Number.isSafeInteger) ||
    before < 0 ||
    gross < 0 ||
    originalGross < 1 ||
    originalGross > 100_000_000 ||
    before + gross > originalGross ||
    original.some((p) => !Number.isSafeInteger(p.amountFils) || p.amountFils <= 0) ||
    new Set(original.map((p) => p.method)).size !== original.length ||
    original.reduce((sum, p) => sum + p.amountFils, 0) !== originalGross
  )
    throw new Error('Invalid original return payments')
  const cash = original.find((p) => p.method === 'cash')?.amountFils ?? 0
  const cashAt = (amount: number) => Number((BigInt(cash) * BigInt(amount)) / BigInt(originalGross))
  const cashDelta = cashAt(before + gross) - cashAt(before)
  return (
    [
      { method: 'cash', amountFils: cashDelta },
      { method: 'card', amountFils: gross - cashDelta },
    ] as const
  ).filter((p) => p.amountFils > 0)
}
