import { z } from 'zod'

// Preserve PostgreSQL microseconds: converting through Date would lose precision.
const timestamp = z.string().datetime({ offset: true }).regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/)
export const receiptCursorSchema = z.object({ issuedAt: timestamp, id: z.string().uuid() }).strict()
export type ReceiptCursor = z.infer<typeof receiptCursorSchema>
export function encodeReceiptCursor(value: ReceiptCursor) {
  return Buffer.from(JSON.stringify(receiptCursorSchema.parse(value))).toString('base64url')
}
export function decodeReceiptCursor(value: string): ReceiptCursor {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error('Invalid receipt cursor')
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw new Error('Invalid receipt cursor')
  return receiptCursorSchema.parse(JSON.parse(decoded.toString('utf8')))
}
export function receiptCursorFilter(value: ReceiptCursor) {
  const { issuedAt, id } = receiptCursorSchema.parse(value)
  // Both fields use strict punctuation allowlists before entering PostgREST syntax.
  return `issued_at.lt.${issuedAt},and(issued_at.eq.${issuedAt},id.lt.${id})`
}
