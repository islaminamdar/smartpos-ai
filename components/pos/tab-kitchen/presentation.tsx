import type { TabKitchenTicket } from '@/lib/pos/server/tab-kitchen'
import styles from './tab-kitchen.module.css'
export type KitchenLine = TabKitchenTicket['lines'][number]
export type KitchenMetadata = TabKitchenTicket['metadata']
export const stages = ['queued', 'preparing', 'ready', 'served'] as const
export const stageLabels = {
  queued: 'Queued',
  preparing: 'Preparing',
  ready: 'Ready',
  served: 'Served',
}
export const serviceLabels = { dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' }
export function quantity(line: Pick<KitchenLine, 'quantityMilli' | 'unit'>) {
  return `${new Intl.NumberFormat('en-AE', { maximumFractionDigits: 3 }).format(line.quantityMilli / 1000)} ${line.unit}`
}
export function time(value: string) {
  return new Date(value).toLocaleString('en-AE', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Dubai',
  })
}
export function KitchenLines({ lines }: { lines: KitchenLine[] }) {
  return (
    <ul className={styles.lines}>
      {lines.map((line) => (
        <li key={`${line.productId}:${line.unit}`}>
          <strong>{quantity(line)}</strong>
          <span>{line.name}</span>
        </li>
      ))}
    </ul>
  )
}
export function Metadata({ value }: { value: KitchenMetadata }) {
  return (
    <>
      <p className={styles.meta}>
        <strong>{serviceLabels[value.serviceType]}</strong>
        {value.tableName && <span>{value.tableName}</span>}
        {value.guestCount && (
          <span>
            {value.guestCount} {value.guestCount === 1 ? 'guest' : 'guests'}
          </span>
        )}
      </p>
      {value.note && <p className={styles.notes}>{value.note}</p>}
    </>
  )
}
export function changesBetween(
  before: { metadata: KitchenMetadata; lines: KitchenLine[] } | null,
  after: { metadata: KitchenMetadata; lines: KitchenLine[] }
) {
  const changes: string[] = []
  for (const line of after.lines) {
    const previous = before?.lines.find((item) => item.productId === line.productId)
    if (!previous) changes.push(`Add ${quantity(line)} ${line.name}`)
    else if (previous.unit !== line.unit)
      changes.push(
        `${line.name}: replace ${quantity(previous)} with ${quantity(line)} (unit changed)`
      )
    else if (previous.quantityMilli !== line.quantityMilli)
      changes.push(`${line.name}: ${quantity(previous)} → ${quantity(line)}`)
    else if (previous.name !== line.name) changes.push(`Item name: ${previous.name} → ${line.name}`)
  }
  for (const line of before?.lines ?? [])
    if (!after.lines.some((item) => item.productId === line.productId))
      changes.push(`Remove ${quantity(line)} ${line.name}`)
  if (before) {
    const fields: Array<[keyof KitchenMetadata, string]> = [
      ['label', 'Order label'],
      ['serviceType', 'Order type'],
      ['tableName', 'Table'],
      ['guestCount', 'Guests'],
      ['note', 'Order note'],
    ]
    for (const [key, label] of fields) {
      if (before.metadata[key] === after.metadata[key]) continue
      const display = (metadata: KitchenMetadata) =>
        key === 'serviceType'
          ? serviceLabels[metadata.serviceType]
          : String(metadata[key] || 'None')
      changes.push(`${label}: ${display(before.metadata)} → ${display(after.metadata)}`)
    }
    if (
      before.metadata.tableId !== after.metadata.tableId &&
      before.metadata.tableName === after.metadata.tableName
    )
      changes.push('Table assignment changed')
  }
  return changes
}
export function ChangeList({ changes }: { changes: string[] }) {
  return (
    <ul className={styles.changes}>
      {changes.map((change, index) => (
        <li key={index}>{change}</li>
      ))}
    </ul>
  )
}
export function PaymentBadge({ ticket }: { ticket: TabKitchenTicket }) {
  const label =
    ticket.payment === 'refunded' ? 'Refunded' : ticket.payment === 'paid' ? 'Paid' : 'Unpaid'
  return (
    <span
      className={`${styles.payment} ${ticket.payment === 'unpaid' ? styles.unpaid : ticket.payment === 'refunded' ? styles.cancelled : ''}`}
    >
      {label}
    </span>
  )
}
