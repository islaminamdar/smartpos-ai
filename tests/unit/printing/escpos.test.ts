import { describe, it, expect } from 'vitest'
import { formatTicket } from '@/lib/printing/escpos'

describe('escpos formatTicket', () => {
  it('contains header, items, and total', () => {
    const out = formatTicket({
      tenantName: 'Test Café',
      orderId: 'abc12345',
      tableLabel: 'T5',
      items: [
        { name: 'Karak Tea', qty: 2, price_aed: 5, modifiers: [{ name: 'sugar', value: 'less' }] },
      ],
      total_aed: 10,
      createdAt: new Date('2026-05-31T10:00:00Z'),
    })
    expect(out).toContain('Test Café')
    expect(out).toContain('T5')
    expect(out).toContain('2 x Karak Tea')
    expect(out).toContain('AED 10.00')
  })
})
