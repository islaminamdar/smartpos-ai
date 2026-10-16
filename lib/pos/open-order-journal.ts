import { openOrderCommandSchema, type OpenOrderCommand } from './server/open-order-contracts'

export type PendingOpenOrderRequest = { actorId: string; command: OpenOrderCommand }
const databaseName = 'internext-pos-open-order-journal-v1'
const table = 'requests'
export const openOrderJournalEvent = 'pos-open-order-journal-changed'
function changed() {
  // Notification delivery is best effort; it must not change a committed transaction's outcome.
  try {
    window.dispatchEvent(new Event(openOrderJournalEvent))
  } catch {
    /* Poll/focus reads remain available. */
  }
  let channel: BroadcastChannel | null = null
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(openOrderJournalEvent)
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
    request.onerror = () => reject(new Error('Open-order request storage is unavailable.'))
    request.onblocked = () => reject(new Error('Close other counter tabs and try again.'))
  })
}

export async function readPendingOpenOrderRequests(
  actorId: string
): Promise<PendingOpenOrderRequest[]> {
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
            const command = openOrderCommandSchema.parse(record.command)
            if (record.actorId !== actorId || record.key !== keyFor(actorId, command.branchId))
              throw new Error('Open-order request scope does not match.')
            return { actorId, command }
          })
        resolve(records)
      } catch {
        reject(
          new Error('The saved open-order request could not be verified. Keep browser data intact.')
        )
      }
    }
    tx.onabort = tx.onerror = () => {
      db.close()
      reject(new Error('The saved open-order requests could not be read.'))
    }
  })
}

export async function savePendingOpenOrderRequest(record: PendingOpenOrderRequest): Promise<void> {
  const command = openOrderCommandSchema.parse(record.command)
  if (!record.actorId) throw new Error('Open-order actor is required.')
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
        new Error('A open-order change may already be pending. Recover it before another change.')
      )
    }
  })
}

export async function acknowledgeOpenOrderRequest(
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
