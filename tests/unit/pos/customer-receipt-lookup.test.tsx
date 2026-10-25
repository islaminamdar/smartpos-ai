import { expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import CustomerReceiptLookup from '@/components/pos/customer/CustomerReceiptLookup'
import { fiscalDocumentSchema } from '@/lib/pos/server/documents'
import fixture from '../../fixtures/pos-offer-documents.json'

const source = fiscalDocumentSchema.parse(fixture.receipts[0])
const document = fiscalDocumentSchema.parse({
  schemaVersion: 1,
  id: '10000000-0000-4000-8000-000000000101',
  kind: 'tax_invoice',
  documentNumber: 'QA-INV-0000000101',
  issuedAt: '2026-10-21T10:00:00.000Z',
  merchant: source.merchant,
  orderId: '10000000-0000-4000-8000-000000000101',
  branchId: source.branchId,
  deviceId: source.deviceId,
  shiftId: source.shiftId,
  actorId: source.actorId,
  serviceType: 'takeaway',
  customer: { name: 'Fatima Ali', address: 'Dubai Marina', trn: '100000000000001' },
  lines: [
    {
      lineNumber: 1,
      productId: source.lines[0].productId,
      name: 'Test item',
      unit: 'piece',
      quantityMilli: 1000,
      unitPriceFils: 105,
      taxRateBps: 500,
      grossFils: 105,
      netFils: 100,
      taxFils: 5,
    },
  ],
  totals: { grossFils: 105, netFils: 100, taxFils: 5 },
  payments: [{ method: 'cash', amountFils: 105 }],
  paymentSettlement: 'recorded',
  cashTenderedFils: 105,
  changeFils: 0,
})

it('copies only an exact customer snapshot selected by staff', () => {
  const useCustomer = vi.fn()
  render(<CustomerReceiptLookup documents={[document]} onUseCustomer={useCustomer} />)
  fireEvent.change(screen.getByLabelText('Search name, address or TRN'), {
    target: { value: 'marina' },
  })
  fireEvent.click(screen.getByRole('button', { name: /Fatima Ali/ }))
  expect(useCustomer).toHaveBeenCalledWith(document.customer)
})
