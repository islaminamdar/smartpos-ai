import { describe, expect, it } from 'vitest';
import { allocateLineDiscounts, calculateTotals, lineTotalFils, parseMoney, validatePayment } from '../../../lib/pos/money';
import { catalogueLineTotals } from '../../../lib/pos/server/contracts';
import { TRAINING_TAX, type CartLine } from '../../../lib/pos/types';
const line: CartLine = { id: 'line-1', itemId: 'sweet-1', name: 'Sweet', unit: 'each', quantity: 1, unitPriceFils: 1050 };

describe('POS monetary invariants', () => {
  it('rounds inclusive VAT per line consistently with the server, preserving the historical algorithm explicitly', () => {
    const lines = ['a', 'b'].map(id => ({ ...line, id, unitPriceFils: 300 }));
    expect(calculateTotals(lines, 0, TRAINING_TAX)).toEqual({ subtotalFils: 600, discountFils: 0, netFils: 572, taxFils: 28, totalFils: 600 });
    expect(calculateTotals(lines, 0, TRAINING_TAX, 'order-v1').taxFils).toBe(29);
    for (const rateBps of [0, 500, 1000, 2000]) {
      const cart: CartLine[] = [...lines, { ...line, id: 'weighted', unit: 'kg', quantity: 333, unitPriceFils: 1050 }, { ...line, id: 'counted', quantity: 7, unitPriceFils: 333 }];
      const expected = cart.map(item => catalogueLineTotals(item.unitPriceFils, item.unit === 'kg' ? item.quantity : item.quantity * 1000, rateBps));
      const local = calculateTotals(cart, 0, { ...TRAINING_TAX, rateBps });
      expect(local.totalFils).toBe(expected.reduce((sum, item) => sum + item.grossFils, 0));
      expect(local.taxFils).toBe(expected.reduce((sum, item) => sum + item.taxFils, 0));
    }
  });
  it('allocates discount remainders by stable line identity before calculating tax', () => {
    const lines = ['c', 'a', 'b'].map(id => ({ ...line, id, unitPriceFils: 11 }));
    expect(allocateLineDiscounts(lines, 1)).toEqual([
      { lineId: 'c', grossFils: 11, discountFils: 0 },
      { lineId: 'a', grossFils: 11, discountFils: 1 },
      { lineId: 'b', grossFils: 11, discountFils: 0 },
    ]);
    expect(calculateTotals(lines, 1, TRAINING_TAX)).toEqual({ subtotalFils: 33, discountFils: 1, netFils: 30, taxFils: 2, totalFils: 32 });
    expect(calculateTotals([...lines].reverse(), 1, TRAINING_TAX)).toEqual(calculateTotals(lines, 1, TRAINING_TAX));
  });
  it('conserves every discount fil without negative lines, including free items and full discounts', () => {
    const lines = [0, 7, 33, 101].map((price, index) => ({ ...line, id: String(index), unitPriceFils: price }));
    for (let discount = 0; discount <= 141; discount++) {
      const allocated = allocateLineDiscounts(lines, discount);
      expect(allocated.reduce((sum, item) => sum + item.discountFils, 0)).toBe(discount);
      expect(allocated.every(item => Number.isSafeInteger(item.discountFils) && item.discountFils >= 0 && item.discountFils <= item.grossFils)).toBe(true);
      const reversed = allocateLineDiscounts([...lines].reverse(), discount).reverse();
      expect(reversed).toEqual(allocated);
      expect(calculateTotals(lines, discount, TRAINING_TAX).totalFils).toBe(141 - discount);
    }
    expect(calculateTotals(lines, 141, TRAINING_TAX).taxFils).toBe(0);
    expect(allocateLineDiscounts([], 0)).toEqual([]);
    expect(() => calculateTotals(lines, 0, TRAINING_TAX, 'unknown' as never)).toThrow('Unsupported calculation version');
  });
  it('extracts inclusive VAT and applies discount before tax', () => {
    expect(calculateTotals([line], 0, TRAINING_TAX)).toEqual({ subtotalFils: 1050, discountFils: 0, netFils: 1000, taxFils: 50, totalFils: 1050 });
    expect(calculateTotals([{ ...line, quantity: 2 }], 1050, TRAINING_TAX).taxFils).toBe(50);
  });
  it('calculates weighted grams using a kilogram price and rounds once per line', () => {
    expect(lineTotalFils({ ...line, unit: 'kg', quantity: 250, unitPriceFils: 6000 })).toBe(1500);
    expect(lineTotalFils({ ...line, unit: 'kg', quantity: 333, unitPriceFils: 1000 })).toBe(333);
    expect(() => lineTotalFils({ ...line, quantity: 0.5 })).toThrow('whole number');
  });
  it('supports explicit exclusive tax and zero tax', () => {
    expect(calculateTotals([line], 0, { ...TRAINING_TAX, inclusive: false }).totalFils).toBe(1103);
    expect(calculateTotals([line], 0, { ...TRAINING_TAX, rateBps: 0 }).taxFils).toBe(0);
    expect(calculateTotals([{ ...line, unitPriceFils: 3 }], 0, { ...TRAINING_TAX, rateBps: 2000 }).taxFils).toBe(1);
  });
  it('rejects negative, non-finite, overflow, duplicate and excessive discounts', () => {
    for (const price of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) expect(() => calculateTotals([{ ...line, unitPriceFils: price, quantity: 2 }], 0, TRAINING_TAX)).toThrow();
    expect(() => calculateTotals([line], 1051, TRAINING_TAX)).toThrow('exceed');
    expect(() => calculateTotals([line, line], 0, TRAINING_TAX)).toThrow('Duplicate');
  });
  it('records mixed payments and returns change only from cash', () => {
    expect(validatePayment(1050, [{ method: 'cash', amountFils: 1000 }, { method: 'card', amountFils: 600 }])).toMatchObject({ changeFils: 550, cashRetainedFils: 450, cardRecordedFils: 600 });
    expect(() => validatePayment(1050, [{ method: 'card', amountFils: 1100 }])).toThrow('exceed');
    expect(() => validatePayment(1050, [{ method: 'cash', amountFils: 1049 }])).toThrow('cover');
    expect(() => validatePayment(1050, [{ method: 'cash', amountFils: 500 }, { method: 'cash', amountFils: 550 }])).toThrow('Combine');
  });
  it('parses currency without float rounding or silently accepting blanks', () => {
    expect(parseMoney('100.01')).toBe(10001);
    expect(parseMoney('0.10')).toBe(10);
    for (const value of ['', ' ', '-1', '1e3', '1.001', 'AED 1', '0x10']) expect(() => parseMoney(value)).toThrow();
  });
});
