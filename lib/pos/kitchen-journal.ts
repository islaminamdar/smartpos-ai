import { kitchenCommandSchema, type KitchenCommand } from './server/kitchen'

export type PendingKitchenRequest = { actorId: string; command: KitchenCommand }
const databaseName = 'internext-pos-kitchen-journal-v1'
const table = 'requests'
export const kitchenJournalEvent = 'pos-kitchen-journal-changed'
function changed() {
  // Notification delivery is best effort; it must not change a committed transaction's outcome.
  try {
    window.dispatchEvent(new Event(kitchenJournalEvent))
  } catch {
    /* Poll/focus reads remain available. */
  }
  let channel: BroadcastChannel | null = null
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(kitchenJournalEvent)
      channel.postMessage('changed')
    }
  } catch {
    /* Storage remains authoritative when notifications are unavailable. */
  } finally {
    try {
      channel?.close()
    } catch {
      /* Best effort. */
    }
  }
}

const keyFor = (actorId: string, branchId: string) => `${actorId}:${branchId}`

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(table, { keyPath: 'key' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('Kitchen request storage is unavailable.'))
    request.onblocked = () => reject(new Error('Close other counter tabs and try again.'))
  })
}

export async function readPendingKitchenRequests(
  actorId: string
): Promise<PendingKitchenRequest[]> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, 'readonly')
    const request = tx.objectStore(table).getAll()
    tx.oncomplete = () => {
      db.close()
      try {
        const records = (
          request.result as Array<{ key: string; actorId: string; command: unknown }>
        )
          .filter((record) => record.actorId === actorId || record.key.startsWith(`${actorId}:`))
          .map((record) => {
            const command = kitchenCommandSchema.parse(record.command)
            if (record.actorId !== actorId || record.key !== keyFor(actorId, command.branchId))
              throw new Error('Kitchen request scope does not match.')
            return { actorId, command }
          })
        resolve(records)
      } catch {
        reject(
          new Error('The saved kitchen request could not be verified. Keep browser data intact.')
        )
      }
    }
    tx.onabort = tx.onerror = () => {
      db.close()
      reject(new Error('The saved kitchen requests could not be read.'))
    }
  })
}

export async function savePendingKitchenRequest(record: PendingKitchenRequest): Promise<void> {
  const command = kitchenCommandSchema.parse(record.command)
  if (!record.actorId) throw new Error('Kitchen actor is required.')
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, 'readwrite')
    // add is atomic across tabs: a second action never overwrites an uncertain request.
    tx.objectStore(table).add({
      key: keyFor(record.actorId, command.branchId),
      actorId: record.actorId,
      command,
    })
    tx.oncomplete = () => {
      db.close()
      changed()
      resolve()
    }
    tx.onabort = tx.onerror = () => {
      db.close()
      reject(
        new Error('A kitchen change may already be pending. Recover it before another change.')
      )
    }
  })
}

export async function acknowledgeKitchenRequest(
  actorId: string,
  branchId: string,
  requestId: string
): Promise<void> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, 'readwrite')
    const store = tx.objectStore(table)
    const key = keyFor(actorId, branchId)
    const request = store.get(key)
    request.onsuccess = () => {
      if (request.result && request.result.command.id !== requestId) {
        tx.abort()
        return
      }
      if (request.result) store.delete(key)
    }
    tx.oncomplete = () => {
      db.close()
      changed()
      resolve()
    }
    tx.onabort = tx.onerror = () => {
      db.close()
      reject(
        new Error('Confirmation could not be saved on this device. Check the same request again.')
      )
    }
  })
}
