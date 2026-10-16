import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { renderToStaticMarkup } from 'react-dom/server'
import fixtures from '../../fixtures/pos-partial-return-documents.json'
import { fiscalDocumentSchema } from '@/lib/pos/server/documents'
import {
  returnStateSchema,
  returnRequestSchema,
  validateReturnPreview,
  returnCreditMatchesCommand,
} from '@/lib/pos/server/returns'
import { canonicalJson } from '@/lib/pos/offline/canonical'
import FiscalReceipt from '@/components/pos/FiscalReceipt'

describe('actual PostgreSQL partial return documents', () => {
  for (const vector of fixtures.vectors)
    it(vector.label, () => {
      expect(fixtures.syntheticOnly).toBe(true)
      const state = returnStateSchema.parse(vector.state),
        next = returnStateSchema.parse(vector.nextState)
      const request = returnRequestSchema.parse(vector.request)
      const preview = validateReturnPreview(state, request, vector.preview)
      const { quoteHash, ...unsigned } = preview
      expect(createHash('sha256').update(canonicalJson(unsigned)).digest('hex')).toBe(quoteHash)
      const credit = fiscalDocumentSchema.parse(vector.result.creditNote)
      expect(credit.schemaVersion).toBe(3)
      expect(returnCreditMatchesCommand(vector.command, credit, credit.actorId)).toBe(true)
      expect(next.invoice).toEqual(state.invoice)
      expect(next.revision).toBe(state.revision + 1)
      expect(next.adjustedTotals).toEqual(preview.adjustedTotals)
      expect(next.fullyReturned).toBe(preview.fullyReturned)
      const html = renderToStaticMarkup(<FiscalReceipt document={credit} />)
      expect(html.toLowerCase()).toContain('tax credit note')
      expect(html).toContain(vector.result.creditNote.originalInvoice.documentNumber)
      expect(html).not.toContain('Invoice total after full credit')
      if (credit.totals.grossFils === 0) expect(html.toLowerCase()).toContain('no refund')
    })
})
