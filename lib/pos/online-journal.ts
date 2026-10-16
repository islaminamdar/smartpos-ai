/** Online requests are persisted before dispatch. An uncertain response never
 * authorizes a new payment request or a success receipt. No credentials stored. */
export type PendingOnlineRequest = {
  actorId: string
  deviceId: string
  branchId: string
  id: string
  endpoint: '/api/pos/sync' | '/api/pos/commands'
  body: unknown
  savedAt: string
}

const databaseName = 'internext-pos-online-journal-v1'
const table = 'pending_requests'

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(table, { keyPath: 'actorId' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('Device storage is unavailable. No request was sent.'))
    request.onblocked = () => reject(new Error('Close other counter tabs and retry.'))
  })
}

export async function readPendingRequest(actorId: string): Promise<PendingOnlineRequest | null> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, 'readonly')
    const request = tx.objectStore(table).get(actorId)
    tx.oncomplete = () => {
      db.close()
      resolve(request.result ?? null)
    }
    tx.onabort = tx.onerror = () => {
      db.close()
      reject(new Error('Could not read pending counter requests.'))
    }
  })
}

export async function savePendingRequest(value: PendingOnlineRequest): Promise<void> {
  if (
    !value.actorId ||
    !value.deviceId ||
    !value.branchId ||
    !value.id ||
    !['/api/pos/sync', '/api/pos/commands'].includes(value.endpoint)
  )
    throw new Error('Invalid counter request.')
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, 'readwrite')
    // add (not put) prevents a second tab from overwriting an uncertain payment.
    tx.objectStore(table).add(structuredClone(value))
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onabort = tx.onerror = () => {
      db.close()
      reject(new Error('Resolve the pending request before starting another.'))
    }
  })
}

export async function acknowledgePendingRequest(actorId: string, id: string): Promise<void> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, 'readwrite')
    const store = tx.objectStore(table)
    const request = store.get(actorId)
    request.onsuccess = () => {
      const record = request.result as PendingOnlineRequest | undefined
      if (record && record.id !== id) {
        tx.abort()
        return
      }
      if (record) store.delete(actorId)
    }
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onabort = tx.onerror = () => {
      db.close()
      reject(
        new Error(
          'Server confirmed the request, but device confirmation failed. Retry the same request.'
        )
      )
    }
  })
}
