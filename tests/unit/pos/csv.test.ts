import { describe, expect, it } from 'vitest'
import { csvTextCell } from '@/lib/pos/csv'
describe('untrusted spreadsheet text export', () => {
  it('neutralizes formulas including whitespace prefixes without changing stored text', () => {
    for (const value of [
      '=1+1',
      '+1+1',
      '-1+1',
      '@SUM(1,1)',
      ' \t=1+1',
      '\r=1+1',
      '\n+1',
      '\tname',
    ]) {
      expect(csvTextCell(value)).toBe(`"'${value}"`)
    }
  })
  it('escapes delimiters and quotes and keeps normal receipts and numeric totals readable', () => {
    expect(csvTextCell('TRAIN-00001')).toBe('"TRAIN-00001"')
    expect(csvTextCell('24.00')).toBe('"24.00"')
    expect(csvTextCell('Name, "test"')).toBe('"Name, ""test"""')
  })
})
