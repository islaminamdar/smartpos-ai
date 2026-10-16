import {
  paymentDecisionRequestSchema,
  type PaymentDecisionRequest,
  type PaymentReviewDetail,
} from '@/lib/pos/offline/payment-review-contracts'
export const money = (fils: number | null) =>
  fils === null ? 'Unavailable' : `AED ${(fils / 100).toFixed(2)}`
export function dubaiInstant(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error('Enter both dates and times in Dubai time.')
  const date = new Date(`${value}:00+04:00`)
  if (
    !Number.isFinite(date.getTime()) ||
    new Date(date.getTime() + 4 * 3600_000).toISOString().slice(0, 16) !== value
  )
    throw new Error('Enter a valid calendar date and time.')
  if (date.getTime() > Date.now())
    throw new Error('A completed return or void cannot be in the future.')
  return date.toISOString()
}
export function eligible(detail: PaymentReviewDetail) {
  const { summary: s, capabilities: c, freeze, quote } = detail
  return (
    c.canDecide &&
    c.policyEnabled &&
    c.holdCode === null &&
    s.state === 'pending' &&
    s.caseKind === 'freeze' &&
    s.freezeId !== null &&
    s.freezeSha256 !== null &&
    freeze?.freezeId === s.freezeId &&
    freeze.branchId === s.branchId &&
    quote !== null &&
    detail.conflicts.length === 0 &&
    !detail.conflictsTruncated &&
    !detail.decisionRequest &&
    !detail.resolution &&
    (s.cashFils === 0 || c.originalShiftOpen)
  )
}
export function validateDecisionForCase(
  request: PaymentDecisionRequest,
  detail: PaymentReviewDetail
) {
  const parsed = paymentDecisionRequestSchema.parse(request),
    s = detail.summary
  if (parsed.freezeId !== s.freezeId || parsed.freezeSha256 !== s.freezeSha256)
    throw new Error('The saved request belongs to another frozen payment.')
  const legs = [
    ['cash', s.cashFils],
    ['card', s.cardFils],
  ].filter(([, amount]) => typeof amount === 'number' && amount > 0)
  if (
    legs.length !== parsed.evidence.length ||
    legs.some(
      ([method, amount], i) =>
        parsed.evidence[i].method !== method || parsed.evidence[i].amountFils !== amount
    )
  )
    throw new Error('Only the full original payment amounts can be recorded.')
  if (parsed.cashDrawerShiftId !== ((s.cashFils ?? 0) > 0 ? s.shiftId : null))
    throw new Error('Cash must return to the original drawer.')
  return parsed
}
