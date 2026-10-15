import type { PosSnapshot } from './types';

export type SyncStatus = { state: 'training_local_only' | 'setup_required' | 'offline'; pendingEvents: number; syncedEvents: 0; message: string };
/** Durable outbox is preparatory. No training event is sent to a server. */
export function getSyncStatus(snapshot: PosSnapshot, online = typeof navigator !== 'undefined' ? navigator.onLine : false): SyncStatus {
  const pendingEvents = snapshot.outbox.length;
  if (snapshot.scope.mode === 'training') return { state: 'training_local_only', pendingEvents, syncedEvents: 0, message: 'Training records are saved on this device only. Cloud synchronisation is not connected.' };
  if (!online) return { state: 'offline', pendingEvents, syncedEvents: 0, message: 'Device offline. Server authorisation and synchronisation are not yet configured.' };
  return { state: 'setup_required', pendingEvents, syncedEvents: 0, message: 'Authenticated business, branch and device setup is required before live sales and synchronisation.' };
}
/** A browser may deny this request. Always show its real outcome; never promise that
 * clearing site data, private browsing or uninstalling cannot erase local records. */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try { return await navigator.storage.persist(); } catch { return false; }
}
export async function getStorageStatus(): Promise<{ persistent: boolean; usageBytes: number | null; quotaBytes: number | null }> {
  if (typeof navigator === 'undefined' || !navigator.storage) return { persistent: false, usageBytes: null, quotaBytes: null };
  const [persistent, estimate] = await Promise.all([
    navigator.storage.persisted?.().catch(() => false) ?? Promise.resolve(false),
    navigator.storage.estimate?.().catch(() => ({} as StorageEstimate)) ?? Promise.resolve({} as StorageEstimate),
  ]);
  return { persistent, usageBytes: estimate.usage ?? null, quotaBytes: estimate.quota ?? null };
}
