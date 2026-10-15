import { describe, expect, it } from 'vitest';
import { calculateTotals, lineTotalFils, parseMoney, validatePayment } from '../../../lib/pos/money';
import { TRAINING_TAX, type CartLine } from '../../../lib/pos/types';
const line: CartLine = { id: 'line-1', itemId: 'sweet-1', name: 'Sweet', unit: 'each', quantity: 1, unitPriceFils: 1050 };

describe('POS monetary invariants', () => {
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
