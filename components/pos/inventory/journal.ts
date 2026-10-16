import { inventoryCommandSchema, type InventoryCommand } from '@/lib/pos/inventory'

export const stockJournalEvent = 'pos-stock-journal-changed'
const key = (actorId: string, branchId: string, deviceId: string) =>
  `pos-stock-request:${actorId}:${branchId}:${deviceId}`
const changed = () => window.dispatchEvent(new Event(stockJournalEvent))
export function readStockRequest(
  actorId: string,
  branchId: string,
  deviceId: string
): InventoryCommand | null {
  const raw = localStorage.getItem(key(actorId, branchId, deviceId))
  if (!raw) return null
  const command = inventoryCommandSchema.parse(JSON.parse(raw))
  if (command.branchId !== branchId || command.deviceId !== deviceId)
    throw new Error('stock_journal_scope')
  return command
}
export function readStockRequests(actorId: string): InventoryCommand[] {
  const prefix = `pos-stock-request:${actorId}:`
  const result: InventoryCommand[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const savedKey = localStorage.key(index)
    if (!savedKey?.startsWith(prefix)) continue
    const scope = savedKey.slice(prefix.length).split(':')
    if (scope.length !== 2) throw new Error('stock_journal_scope')
    const command = readStockRequest(actorId, scope[0], scope[1])
    if (command) result.push(command)
  }
  return result
}
export async function saveStockRequest(actorId: string, command: InventoryCommand) {
  const parsed = inventoryCommandSchema.parse(command)
  if (!navigator.locks) throw new Error('stock_journal_lock_unavailable')
  await navigator.locks.request(key(actorId, command.branchId, command.deviceId), () => {
    const existing = readStockRequest(actorId, command.branchId, command.deviceId)
    if (existing && JSON.stringify(existing) !== JSON.stringify(parsed))
      throw new Error('stock_journal_conflict')
    localStorage.setItem(key(actorId, command.branchId, command.deviceId), JSON.stringify(parsed))
  })
  changed()
}
export async function clearStockRequest(actorId: string, command: InventoryCommand) {
  if (!navigator.locks) throw new Error('stock_journal_lock_unavailable')
  await navigator.locks.request(key(actorId, command.branchId, command.deviceId), () => {
    const existing = readStockRequest(actorId, command.branchId, command.deviceId)
    if (existing && JSON.stringify(existing) !== JSON.stringify(command))
      throw new Error('stock_journal_conflict')
    localStorage.removeItem(key(actorId, command.branchId, command.deviceId))
  })
  changed()
}
