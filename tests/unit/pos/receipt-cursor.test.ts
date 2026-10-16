import { describe, expect, it } from 'vitest'
import { decodeReceiptCursor, encodeReceiptCursor, receiptCursorFilter } from '@/lib/pos/server/receipt-cursor'
const cursor={issuedAt:'2026-10-16T10:00:00.123456+00:00',id:'00000000-0000-4000-8000-000000000100'}
describe('stable receipt pagination cursor',()=>{
  it('preserves microseconds and uses document ID to keep rows at equal timestamps',()=>{
    expect(decodeReceiptCursor(encodeReceiptCursor(cursor))).toEqual(cursor)
    expect(receiptCursorFilter(cursor)).toBe(`issued_at.lt.${cursor.issuedAt},and(issued_at.eq.${cursor.issuedAt},id.lt.${cursor.id})`)
    const rows=[{...cursor,id:'00000000-0000-4000-8000-000000000101'},cursor,{...cursor,id:'00000000-0000-4000-8000-000000000099'},{...cursor,issuedAt:'2026-10-16T09:59:59.999999+00:00'}]
    expect(rows.filter(row=>row.issuedAt<cursor.issuedAt || (row.issuedAt===cursor.issuedAt && row.id<cursor.id))).toEqual(rows.slice(2))
  })
  it('rejects filter punctuation, oversized cursors and malformed identities',()=>{
    for(const value of ['abc=', 'a'.repeat(513), encodeReceiptCursor(cursor)+'!', Buffer.from(JSON.stringify({...cursor,id:'x),organization_id.neq.null'})).toString('base64url'),Buffer.from(JSON.stringify({...cursor,issuedAt:'2026-10-16T10:00:00Z),id.neq.null'})).toString('base64url')]) expect(()=>decodeReceiptCursor(value)).toThrow()
  })
})
