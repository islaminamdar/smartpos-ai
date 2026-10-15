import type { CalculationVersion, CartLine, PaymentSummary, TaxConfig, Tender, Totals } from './types';

export function assertMoney(value: number, name = 'Amount'): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative whole number of fils.`);
}
function safeAdd(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result)) throw new Error('Amount exceeds the supported range.');
  return result;
}
function roundedRatio(a: number, b: number, divisor: number): number {
  const product = a * b;
  if (!Number.isSafeInteger(product)) throw new Error('Amount exceeds the supported range.');
  return Math.round(product / divisor);
}
export function lineTotalFils(line: CartLine): number {
  if (!line.id || !line.itemId || !line.name.trim()) throw new Error('A menu item and line identity are required.');
  if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) throw new Error('Quantity must be a positive whole number of pieces or grams.');
  if (line.unit !== 'each' && line.unit !== 'kg') throw new Error('Unsupported sale unit.');
  assertMoney(line.unitPriceFils, 'Unit price');
  return roundedRatio(line.unitPriceFils, line.quantity, line.unit === 'kg' ? 1000 : 1);
}
/** Proportional integer-fils discount, largest remainder first; ties use immutable line IDs. */
export function allocateLineDiscounts(lines: CartLine[], discountFils = 0): Array<{ lineId: string; grossFils: number; discountFils: number }> {
  assertMoney(discountFils, 'Discount');
  if (new Set(lines.map(line => line.id)).size !== lines.length) throw new Error('Duplicate order line identity.');
  const amounts = lines.map(line => ({ lineId: line.id, grossFils: lineTotalFils(line), discountFils: 0 }));
  const subtotal = amounts.reduce((sum, line) => safeAdd(sum, line.grossFils), 0);
  if (discountFils > subtotal) throw new Error('Discount cannot exceed the order subtotal.');
  if (!discountFils) return amounts;
  const denominator = BigInt(subtotal);
  const remainders = amounts.map((line, index) => {
    const product = BigInt(line.grossFils) * BigInt(discountFils);
    line.discountFils = Number(product / denominator);
    return { index, remainder: product % denominator, lineId: line.lineId };
  });
  remainders.sort((a, b) => a.remainder > b.remainder ? -1 : a.remainder < b.remainder ? 1 : a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0);
  const remaining = discountFils - amounts.reduce((sum, line) => safeAdd(sum, line.discountFils), 0);
  for (let index = 0; index < remaining; index++) amounts[remainders[index].index].discountFils++;
  return amounts;
}
/** New sales use per-line tax. order-v1 exists only to validate immutable historical receipts. */
export function calculateTotals(lines: CartLine[], discountFils = 0, tax: TaxConfig = { rateBps: 0, inclusive: true, confirmed: false }, version: CalculationVersion = 'line-v2'): Totals {
  if (version !== 'line-v2' && version !== 'order-v1') throw new Error('Unsupported calculation version.');
  if (!Number.isSafeInteger(tax.rateBps) || tax.rateBps < 0 || tax.rateBps > 10000) throw new Error('Tax rate is invalid.');
  if (typeof tax.inclusive !== 'boolean' || typeof tax.confirmed !== 'boolean') throw new Error('Tax configuration is invalid.');
  const allocated = allocateLineDiscounts(lines, discountFils);
  const subtotalFils = allocated.reduce((sum, line) => safeAdd(sum, line.grossFils), 0);
  const discounted = subtotalFils - discountFils;
  const divisor = tax.inclusive ? 10000 + tax.rateBps : 10000;
  const taxFils = version === 'order-v1'
    ? roundedRatio(discounted, tax.rateBps, divisor)
    : allocated.reduce((sum, line) => safeAdd(sum, roundedRatio(line.grossFils - line.discountFils, tax.rateBps, divisor)), 0);
  return { subtotalFils, discountFils, netFils: tax.inclusive ? discounted - taxFils : discounted, taxFils, totalFils: tax.inclusive ? discounted : safeAdd(discounted, taxFils) };
}
export function validatePayment(totalFils: number, tenders: Tender[]): PaymentSummary {
  assertMoney(totalFils, 'Total');
  if (totalFils <= 0) throw new Error('Paid orders must have a positive total.');
  if (!tenders.length || tenders.length > 2) throw new Error('Select cash, recorded card, or one of each.');
  if (new Set(tenders.map(t => t.method)).size !== tenders.length) throw new Error('Combine payments of the same method.');
  let cash = 0;
  let card = 0;
  for (const tender of tenders) {
    assertMoney(tender.amountFils, 'Payment');
    if (!tender.amountFils) throw new Error('Payments must be positive.');
    if (tender.method === 'cash') cash = tender.amountFils;
    else if (tender.method === 'card') card = tender.amountFils;
    else throw new Error('Unsupported payment method.');
  }
  const tenderedFils = safeAdd(cash, card);
  if (tenderedFils < totalFils) throw new Error('Payment does not cover the order total.');
  if (card > totalFils) throw new Error('Recorded card payment cannot exceed the order total.');
  const changeFils = tenderedFils - totalFils;
  if (changeFils > cash || (changeFils > 0 && cash === 0)) throw new Error('Only cash can produce change.');
  return { tenders: tenders.map(t => ({ ...t })), tenderedFils, changeFils, cashRetainedFils: cash - changeFils, cardRecordedFils: card };
}
export function formatFils(fils: number): string {
  if (!Number.isSafeInteger(fils)) throw new Error('Amount must be whole fils.');
  return new Intl.NumberFormat('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(fils / 100);
}
/** Strict decimal parser: rejects blanks, exponent notation and fractions smaller than a fil. */
export function parseMoney(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) throw new Error('Enter an amount with at most two decimal places.');
  const [whole, fraction = ''] = value.trim().split('.');
  const fils = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  assertMoney(fils);
  return fils;
}
