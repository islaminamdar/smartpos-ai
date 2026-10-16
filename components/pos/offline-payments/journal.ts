import { z } from 'zod'
import {
  paymentDecisionRequestSchema,
  type PaymentDecisionRequest,
} from '@/lib/pos/offline/payment-review-contracts'
const uuid = z.string().uuid()
const recordSchema = z
  .object({ actorId: uuid, branchId: uuid, caseId: uuid, request: paymentDecisionRequestSchema })
  .strict()
export type PendingPaymentReview = z.infer<typeof recordSchema>
export const paymentReviewJournalEvent = 'pos-payment-review-journal-changed'
const databaseName = 'internext-pos-payment-review-journal-v1'
const storeName = 'requests'
const keyFor = (actor: string, branch: string) => `${actor}:${branch}`
export const samePaymentDecision = (a: PaymentDecisionRequest, b: PaymentDecisionRequest) =>
  JSON.stringify(paymentDecisionRequestSchema.parse(a)) ===
  JSON.stringify(paymentDecisionRequestSchema.parse(b))
function changed() {
  try {
    window.dispatchEvent(new Event(paymentReviewJournalEvent))
  } catch {
    /* Commit is authoritative. */
  }
  let channel: BroadcastChannel | undefined
  try {
    channel = new BroadcastChannel(paymentReviewJournalEvent)
    channel.postMessage('changed')
  } catch {
    /* Focus read remains available. */
  } finally {
    try {
      channel?.close()
    } catch {
      /* Best effort. */
    }
  }
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'key' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = request.onblocked = () =>
      reject(new Error('Saved review requests are unavailable. Keep browser data intact.'))
  })
}
export async function readPendingPaymentReviews(actorId: string): Promise<PendingPaymentReview[]> {
  uuid.parse(actorId)
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly'),
      read = tx.objectStore(storeName).getAll()
    tx.oncomplete = () => {
      db.close()
      try {
        const result: PendingPaymentReview[] = []
        for (const value of read.result as unknown[]) {
          const record = z
            .object({ key: z.string(), actorId: z.string() })
            .passthrough()
            .parse(value)
          if (record.actorId !== actorId && !record.key.startsWith(`${actorId}:`)) continue
          const { key, ...rest } = record
          const parsed = recordSchema.parse(rest)
          if (parsed.actorId !== actorId || key !== keyFor(parsed.actorId, parsed.branchId))
            throw new Error('Scope mismatch')
          result.push(parsed)
        }
        resolve(result)
      } catch {
        reject(
          new Error('The saved review request could not be verified. Keep browser data intact.')
        )
      }
    }
    tx.onabort = tx.onerror = () => {
      db.close()
      reject(new Error('Saved review requests could not be read.'))
    }
  })
}
export async function savePendingPaymentReview(value: PendingPaymentReview): Promise<void> {
  const record = recordSchema.parse(value),
    db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).add({ key: keyFor(record.actorId, record.branchId), ...record })
    tx.oncomplete = () => {
      db.close()
      changed()
      resolve()
    }
    tx.onabort = tx.onerror = () => {
      db.close()
      reject(
        new Error(
          'A review request may already be pending. Check saved requests before another decision.'
        )
      )
    }
  })
}
export async function acknowledgePaymentReview(record: PendingPaymentReview): Promise<void> {
  recordSchema.parse(record)
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite'),
      store = tx.objectStore(storeName)
    const read = store.get(keyFor(record.actorId, record.branchId))
    read.onsuccess = () => {
      try {
        if (read.result) {
          const saved = recordSchema.parse({
            actorId: read.result.actorId,
            branchId: read.result.branchId,
            caseId: read.result.caseId,
            request: read.result.request,
          })
          if (
            saved.caseId !== record.caseId ||
            !samePaymentDecision(saved.request, record.request)
          ) {
            tx.abort()
            return
          }
          store.delete(keyFor(record.actorId, record.branchId))
        }
      } catch {
        tx.abort()
      }
    }
    tx.oncomplete = () => {
      db.close()
      changed()
      resolve()
    }
    tx.onabort = tx.onerror = () => {
      db.close()
      reject(new Error('Local confirmation could not be saved. Check the same request again.'))
    }
  })
}
