import { z } from 'zod'
import {
  stationCommandSchema,
  stationRecoverySchema,
  stationResultMatches,
  type StationCommand,
} from './server/kitchen-stations'

export type PendingStationRequest = { actorId: string; command: StationCommand }
const databaseName = 'internext-pos-kitchen-station-journal-v1'
const table = 'requests'
export const stationJournalEvent = 'pos-kitchen-station-journal-changed'
function changed() {
  // Notification delivery is best effort; it must not change a committed transaction's outcome.
  try {
    window.dispatchEvent(new Event(stationJournalEvent))
  } catch {
    /* Poll/focus reads remain available. */
  }
  let channel: BroadcastChannel | null = null
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(stationJournalEvent)
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
    request.onerror = () => reject(new Error('Station request storage is unavailable.'))
    request.onblocked = () => reject(new Error('Close other counter tabs and try again.'))
  })
}

export async function readPendingStationRequests(
  actorId: string
): Promise<PendingStationRequest[]> {
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
            const command = stationCommandSchema.parse(record.command)
            if (record.actorId !== actorId || record.key !== keyFor(actorId, command.branchId))
              throw new Error('Station request scope does not match.')
            return { actorId, command }
          })
        resolve(records)
      } catch {
        reject(
          new Error('The saved station request could not be verified. Keep browser data intact.')
        )
      }
    }
    tx.onabort = tx.onerror = () => {
      db.close()
      reject(new Error('The saved station requests could not be read.'))
    }
  })
}

export async function savePendingStationRequest(record: PendingStationRequest): Promise<void> {
  const command = stationCommandSchema.parse(record.command)
  if (
    !z.string().uuid().safeParse(record.actorId).success ||
    record.actorId !== record.actorId.toLowerCase()
  )
    throw new Error('Station actor is required.')
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
        new Error('A station change may already be pending. Recover it before another change.')
      )
    }
  })
}

export async function acknowledgeStationRequest(
  actorId: string,
  command: StationCommand,
  confirmation: unknown
): Promise<void> {
  const savedCommand = stationCommandSchema.parse(command)
  const result = stationRecoverySchema.parse(confirmation)
  if (!stationResultMatches(savedCommand, result))
    throw new Error('Station confirmation does not match.')
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, 'readwrite')
    const store = tx.objectStore(table)
    const key = keyFor(actorId, savedCommand.branchId)
    const request = store.get(key)
    request.onsuccess = () => {
      try {
        if (
          request.result &&
          (request.result.actorId !== actorId ||
            request.result.key !== key ||
            JSON.stringify(stationCommandSchema.parse(request.result.command)) !==
              JSON.stringify(savedCommand))
        ) {
          tx.abort()
          return
        }
      } catch {
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
