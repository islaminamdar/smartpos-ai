// @vitest-environment node
import { describe, expect, it } from 'vitest'
import fixture from '../../../fixtures/offline-line-v1.json'
import { invoice } from '../../../fixtures/pos-invoice'
import { catalogueLineTotals } from '@/lib/pos/server/contracts'
import { fiscalDocumentSchema } from '@/lib/pos/server/documents'

/** The exact JSON resource is also consumed by Android OfflineCalculatorTest. */
describe('native offline-line-v1 financial interoperability', () => {
  for (const vector of fixture.vectors) {
    it(vector.name, () => {
      expect(vector.input.calculationVersion).toBe('offline-line-v1')
      expect(vector.input.taxInclusive).toBe(true)
      const expected = vector.expected
      const lines = vector.input.lines.map((line, index) => {
        const { grossFils, taxFils } = catalogueLineTotals(line.unitPriceFils, line.quantityMilli, line.taxRateBps)
        return { ...line, lineNumber: index + 1, grossFils, taxFils, netFils: grossFils - taxFils }
      })
      expect(lines).toEqual(expected.lines)
      for (const field of ['grossFils', 'netFils', 'taxFils'] as const)
        expect(lines.reduce((sum, line) => sum + line[field], 0)).toBe(expected.totals[field])
      const cashApplied = expected.totals.grossFils - vector.input.recordedCardFils
      expect(expected.changeFils).toBe(vector.input.cashTenderedFils - cashApplied)
      expect(expected.payments).toEqual([
        ...(cashApplied ? [{ method: 'cash', amountFils: cashApplied }] : []),
        ...(vector.input.recordedCardFils ? [{ method: 'card', amountFils: vector.input.recordedCardFils }] : []),
      ])
      expect(expected.requiresBuyerDetails).toBe(expected.totals.grossFils > 1_000_000)
      const { requiresBuyerDetails, ...financialFields } = expected
      const document = { ...structuredClone(invoice), ...financialFields,
        customer: requiresBuyerDetails ? { name: 'Synthetic buyer', address: 'Synthetic address', trn: null } : null }
      expect(fiscalDocumentSchema.safeParse(document).success).toBe(true)
      if (requiresBuyerDetails)
        expect(fiscalDocumentSchema.safeParse({ ...document, customer: null }).success).toBe(false)
    })
  }
})
