import { assertMoney, calculateTotals, validatePayment } from './money';
import type { CashMovement, CashMovementInput, HeldOrder, HoldInput, OutboxEvent, PosScope, PosSnapshot, Refund, RefundInput, Sale, SaleInput, Shift } from './types';

const DATABASE_NAME = 'internext-pos-local-v1';
const OBJECT_STORE = 'branch_device_state';
export function createId(): string {
  if (typeof crypto === 'undefined' || !crypto.randomUUID) throw new Error('Secure local storage requires HTTPS or localhost.');
  return crypto.randomUUID();
}
export function scopeKey(scope: PosScope): string { return JSON.stringify([scope.mode, scope.organisationId, scope.branchId, scope.deviceId]); }
function clone<T>(value: T): T { return structuredClone(value); }
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(k => object[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stable(object[k])}`).join(',')}}`;
}
function emptySnapshot(scope: PosScope): PosSnapshot {
  return { schemaVersion: 1, scope: clone(scope), revision: 0, sales: [], refunds: [], holds: [], shifts: [], cashMovements: [], outbox: [], preferences: {}, holdOperations: {} };
}
function openShiftFrom(state: PosSnapshot): Shift {
  const shift = state.shifts.find(s => s.status === 'open');
  if (!shift) throw new Error('Open a shift on this device first.');
  return shift;
}
function requireTraining(scope: PosScope): void {
  if (scope.mode !== 'training') throw new Error('Live selling is not enabled. Server provisioning and device authorisation are still required.');
}
function nonblank(value: string, name: string): void { if (!value?.trim()) throw new Error(`${name} is required.`); }
function validateServiceType(value: string): void { if (!['dine_in', 'takeaway', 'delivery'].includes(value)) throw new Error('Select a supported order type.'); }
function appendEvent(state: PosSnapshot, type: OutboxEvent['type'], entity: { id: string }): void {
  state.outbox.push({ id: createId(), scopeKey: scopeKey(state.scope), type, entityId: entity.id, createdAt: new Date().toISOString(), payload: clone(entity), status: 'pending' });
}
export function expectedCashFils(state: PosSnapshot, shiftId: string): number {
  const shift = state.shifts.find(s => s.id === shiftId);
  if (!shift) throw new Error('Shift not found.');
  const amount = shift.openingCashFils
    + state.sales.filter(s => s.shiftId === shiftId).reduce((n, s) => n + s.payment.cashRetainedFils, 0)
    - state.refunds.filter(r => r.shiftId === shiftId && r.method === 'cash').reduce((n, r) => n + r.amountFils, 0)
    + state.cashMovements.filter(m => m.shiftId === shiftId).reduce((n, m) => n + (m.direction === 'in' ? m.amountFils : -m.amountFils), 0);
  if (!Number.isSafeInteger(amount)) throw new Error('Cash amount exceeds the supported range.');
  return amount;
}
export function remainingRefundFils(state: PosSnapshot, saleId: string): number {
  const sale = state.sales.find(s => s.id === saleId);
  if (!sale) throw new Error('Order is not held on this device. Refunds must use the original selling device until server coordination is enabled.');
  return sale.totals.totalFils - state.refunds.filter(r => r.saleId === saleId).reduce((n, r) => n + r.amountFils, 0);
}
export type TrainingBackupInspection = { scope: PosScope; exportedAt: string; sales: number; refunds: number; heldOrders: number; shifts: number; openShift: boolean };
function validTimestamp(value: unknown): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Backup contains an invalid date.');
}
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Backup structure is invalid.');
}
function backupString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Backup ${label} is invalid.`);
}
function backupLines(value: unknown): asserts value is import('./types').CartLine[] {
  if (!Array.isArray(value)) throw new Error('Backup order lines are invalid.');
  for (const line of value) {
    object(line); backupString(line.id, 'line identity'); backupString(line.itemId, 'item identity'); backupString(line.name, 'item name');
    if (line.note !== undefined && typeof line.note !== 'string') throw new Error('Backup preparation note is invalid.');
  }
  calculateTotals(value);
}
function validateBackupPreferences(preferences: Record<string, unknown>): void {
  if (preferences.draft !== undefined) {
    object(preferences.draft); const draft = preferences.draft;
    backupLines(draft.cart);
    if (draft.service !== undefined) { backupString(draft.service, 'draft order type'); validateServiceType(draft.service); }
    for (const field of ['label', 'note', 'holdId', 'discount', 'discountReason', 'idempotencyKey']) if (draft[field] !== undefined && typeof draft[field] !== 'string') throw new Error('Backup draft text is invalid.');
  }
  if (preferences.favourites !== undefined && (!Array.isArray(preferences.favourites) || preferences.favourites.some(item => typeof item !== 'string'))) throw new Error('Backup favourites are invalid.');
  if (preferences.catalogueOverrides !== undefined) {
    object(preferences.catalogueOverrides);
    for (const value of Object.values(preferences.catalogueOverrides)) {
      object(value);
      if (value.priceFils !== undefined) assertMoney(value.priceFils as number);
      if (value.unit !== undefined && !['each', 'kg'].includes(value.unit as string)) throw new Error('Backup menu unit is invalid.');
      if (value.available !== undefined && typeof value.available !== 'boolean') throw new Error('Backup menu availability is invalid.');
    }
  }
  if (preferences.kitchen !== undefined) {
    if (!Array.isArray(preferences.kitchen)) throw new Error('Backup kitchen tickets are invalid.');
    for (const ticket of preferences.kitchen) {
      object(ticket); backupString(ticket.id, 'kitchen identity'); backupString(ticket.label, 'kitchen label'); validTimestamp(ticket.createdAt);
      backupLines(ticket.lines); backupString(ticket.serviceType, 'kitchen order type'); validateServiceType(ticket.serviceType);
      if (!['new', 'preparing', 'ready', 'cancelled'].includes(ticket.status as string)) throw new Error('Backup kitchen status is invalid.');
    }
  }
}
/** Validate financial relationships as well as the file shape. A backup is not
 * trusted merely because it calls itself an Internext export. No data is written here. */
function parseTrainingBackup(text: string): { snapshot: PosSnapshot; exportedAt: string } {
  if (text.length > 50_000_000) throw new Error('Backup is too large for this recovery tool.');
  let root: unknown;
  try { root = JSON.parse(text); } catch { throw new Error('Choose a valid JSON backup exported by this app.'); }
  object(root);
  if (root.format !== 'internext-pos-device-backup') throw new Error('This file is not an Internext POS device backup.');
  validTimestamp(root.exportedAt); object(root.snapshot);
  const raw = root.snapshot;
  if (raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0) throw new Error('Unsupported or invalid backup version.');
  object(raw.scope);
  for (const field of ['organisationId', 'branchId', 'deviceId']) backupString(raw.scope[field], field);
  if (raw.scope.mode !== 'training') throw new Error('Only training backups can be restored in this workspace.');
  for (const field of ['sales', 'refunds', 'holds', 'shifts', 'cashMovements', 'outbox']) if (!Array.isArray(raw[field])) throw new Error(`Backup ${field} is invalid.`);
  object(raw.preferences); validateBackupPreferences(raw.preferences);
  for (const name of Object.keys(raw.preferences)) if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Backup contains invalid setting names.');
  const state = raw as unknown as PosSnapshot;
  const key = scopeKey(state.scope);
  if (state.holdOperations !== undefined) {
    object(state.holdOperations);
    for (const [operationKey, operation] of Object.entries(state.holdOperations)) {
      object(operation); backupString(operation.holdId, 'held operation identity'); backupString(operation.fingerprint, 'held operation fingerprint');
      if (!operationKey.startsWith('op:') || !['held', 'paid', 'cancelled'].includes(operation.status)) throw new Error('Backup held-operation state is invalid.');
      if (operation.status === 'held' && !state.holds.some(hold => hold.id === operation.holdId)) throw new Error('Backup active held operation has no matching order.');
      if (operation.status !== 'held' && state.holds.some(hold => hold.id === operation.holdId)) throw new Error('Backup resolved held operation still has an unpaid order.');
      if (operation.status === 'paid' && !state.sales.some(sale => sale.holdId === operation.holdId)) throw new Error('Backup paid held operation has no matching sale.');
    }
  }
  const allIds = new Set<string>();
  for (const entries of [state.sales, state.refunds, state.holds, state.shifts, state.cashMovements, state.outbox]) {
    for (const entry of entries) {
      object(entry); backupString(entry.id, 'record identity');
      if (allIds.has(entry.id)) throw new Error('Backup contains duplicate record identities.');
      allIds.add(entry.id);
    }
  }
  const shifts = new Map(state.shifts.map(shift => [shift.id, shift]));
  if (state.shifts.filter(shift => shift.status === 'open').length > 1) throw new Error('Backup has more than one open shift on the same device.');
  for (const shift of state.shifts) {
    validTimestamp(shift.openedAt); backupString(shift.cashierName, 'cashier'); assertMoney(shift.openingCashFils);
    if (!['open', 'closed'].includes(shift.status)) throw new Error('Backup shift status is invalid.');
    if (shift.status === 'closed') { validTimestamp(shift.closedAt); assertMoney(shift.countedCashFils as number); assertMoney(shift.expectedCashFils as number); }
  }
  const orderKeys = new Set<string>(); const receipts = new Set<string>();
  for (const sale of state.sales) {
    object(sale.scope); if (scopeKey(sale.scope) !== key || !shifts.has(sale.shiftId)) throw new Error('Backup sale has an invalid device or shift.');
    validTimestamp(sale.createdAt); backupString(sale.idempotencyKey, 'sale operation key'); backupString(sale.inputFingerprint, 'sale fingerprint'); backupString(sale.receiptNumber, 'receipt number');
    if (orderKeys.has(sale.idempotencyKey) || receipts.has(sale.receiptNumber)) throw new Error('Backup contains duplicate sales or receipt numbers.');
    orderKeys.add(sale.idempotencyKey); receipts.add(sale.receiptNumber); validateServiceType(sale.serviceType);
    backupLines(sale.lines);
    if (!sale.lines.length) throw new Error('Backup sale has no order lines.');
    object(sale.totals); object(sale.tax); object(sale.payment);
    // Unversioned backups were created with order-wide VAT. Never rewrite paid history.
    const totals = calculateTotals(sale.lines, sale.totals.discountFils, sale.tax, sale.calculationVersion === undefined ? 'order-v1' : sale.calculationVersion);
    if (stable(totals) !== stable(sale.totals)) throw new Error('Backup sale totals do not match its order lines.');
    if (totals.discountFils > 0) backupString(sale.discountReason, 'discount reason');
    if (!Array.isArray(sale.payment.tenders) || stable(validatePayment(totals.totalFils, sale.payment.tenders)) !== stable(sale.payment)) throw new Error('Backup payment does not reconcile.');
  }
  for (const hold of state.holds) {
    validTimestamp(hold.createdAt); validTimestamp(hold.updatedAt); backupString(hold.label, 'held order label'); validateServiceType(hold.serviceType);
    backupLines(hold.lines);
    if (!hold.lines.length) throw new Error('Backup held order has no lines.');
    calculateTotals(hold.lines, hold.discountFils);
  }
  if (state.holds.length && !state.shifts.some(shift => shift.status === 'open')) throw new Error('Backup has unpaid held orders but no open shift.');
  const refundKeys = new Set<string>();
  for (const refund of state.refunds) {
    validTimestamp(refund.createdAt); backupString(refund.reason, 'refund reason'); backupString(refund.idempotencyKey, 'refund operation key'); assertMoney(refund.amountFils);
    if (!refund.amountFils || !shifts.has(refund.shiftId) || !['cash', 'card'].includes(refund.method) || refundKeys.has(refund.idempotencyKey)) throw new Error('Backup refund is invalid.');
    refundKeys.add(refund.idempotencyKey);
    const sale = state.sales.find(item => item.id === refund.saleId);
    if (!sale || remainingRefundFils(state, sale.id) < 0) throw new Error('Backup refunds exceed an original sale.');
    const amount = state.refunds.filter(item => item.saleId === sale.id && item.method === refund.method).reduce((sum, item) => sum + item.amountFils, 0);
    const original = refund.method === 'cash' ? sale.payment.cashRetainedFils : sale.payment.cardRecordedFils;
    if (!Number.isSafeInteger(amount) || amount > original) throw new Error('Backup refund payment method does not reconcile.');
  }
  const movementKeys = new Set<string>();
  for (const movement of state.cashMovements) {
    validTimestamp(movement.createdAt); backupString(movement.reason, 'cash movement reason'); backupString(movement.idempotencyKey, 'cash operation key'); assertMoney(movement.amountFils);
    if (!movement.amountFils || !shifts.has(movement.shiftId) || !['in', 'out'].includes(movement.direction) || movementKeys.has(movement.idempotencyKey)) throw new Error('Backup cash movement is invalid.');
    movementKeys.add(movement.idempotencyKey);
  }
  for (const shift of state.shifts) {
    const expected = expectedCashFils(state, shift.id); assertMoney(expected);
    if (shift.status === 'closed' && (shift.expectedCashFils !== expected || shift.differenceFils !== (shift.countedCashFils as number) - expected)) throw new Error('Backup closing cash does not reconcile.');
  }
  const entityLists: Record<OutboxEvent['type'], Array<{ id: string }>> = { 'sale.created': state.sales, 'refund.created': state.refunds, 'shift.opened': state.shifts, 'shift.closed': state.shifts.filter(shift => shift.status === 'closed'), 'cash.moved': state.cashMovements };
  for (const event of state.outbox) {
    validTimestamp(event.createdAt); object(event.payload);
    if (event.scopeKey !== key || event.status !== 'pending' || !Object.prototype.hasOwnProperty.call(entityLists, event.type)) throw new Error('Backup audit event is invalid.');
    const entity = entityLists[event.type].find(item => item.id === event.entityId);
    if (!entity || event.payload.id !== entity.id) throw new Error('Backup audit event has no matching record.');
    if (event.type === 'shift.opened') {
      const shift = entity as Shift;
      if (event.payload.status !== 'open' || event.payload.openingCashFils !== shift.openingCashFils || event.payload.openedAt !== shift.openedAt || event.payload.cashierName !== shift.cashierName) throw new Error('Backup opening shift event is inconsistent.');
    } else if (stable(event.payload) !== stable(entity)) throw new Error('Backup audit event does not match its record.');
  }
  for (const type of Object.keys(entityLists) as OutboxEvent['type'][]) for (const entity of entityLists[type]) {
    if (state.outbox.filter(event => event.type === type && event.entityId === entity.id).length !== 1) throw new Error('Backup has missing or duplicate audit events.');
  }
  return { snapshot: state, exportedAt: root.exportedAt as string };
}
export function inspectTrainingBackup(text: string): TrainingBackupInspection {
  const { snapshot, exportedAt } = parseTrainingBackup(text);
  return { scope: clone(snapshot.scope), exportedAt, sales: snapshot.sales.length, refunds: snapshot.refunds.length, heldOrders: snapshot.holds.length, shifts: snapshot.shifts.length, openShift: snapshot.shifts.some(shift => shift.status === 'open') };
}
export interface LocalPosStore {
  snapshot(): Promise<PosSnapshot>;
  openShift(input: { cashierName: string; openingCashFils: number }): Promise<Shift>;
  holdOrder(input: HoldInput): Promise<HeldOrder>;
  deleteHold(id: string): Promise<void>;
  completeSale(input: SaleInput): Promise<Sale>;
  refundSale(input: RefundInput): Promise<Refund>;
  cashMovement(input: CashMovementInput): Promise<CashMovement>;
  closeShift(input: { countedCashFils: number; note?: string }): Promise<Shift>;
  setPreference(key: string, value: unknown): Promise<void>;
  exportBackup(): Promise<string>;
  restoreBackup(text: string): Promise<PosSnapshot>;
  subscribe(listener: () => void): () => void;
  close(): void;
}

/** One scoped record is read and written in the SAME IDB transaction. Concurrent tabs
 * serialize through IndexedDB; an order, outbox event and shift linkage commit together.
 * Training records never share a key with live records. No cloud success is implied. */
export async function createLocalPosStore(scope: PosScope): Promise<LocalPosStore> {
  scope = clone(scope);
  ['organisationId', 'branchId', 'deviceId'].forEach(k => nonblank(scope[k as keyof PosScope], k));
  if (scope.mode !== 'training' && scope.mode !== 'live') throw new Error('Invalid environment.');
  if (typeof indexedDB === 'undefined') throw new Error('Offline database unavailable. This device cannot safely record sales.');
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(OBJECT_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the offline database.'));
    request.onblocked = () => reject(new Error('Close older POS tabs and reopen to upgrade the offline database.'));
  });
  db.onversionchange = () => db.close();
  const key = scopeKey(scope);
  const listeners = new Set<() => void>();
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`internext-pos:${key}`);
  const notify = () => { listeners.forEach(fn => { try { fn(); } catch { /* Observers cannot reverse an already committed write. */ } }); };
  if (channel) channel.onmessage = notify;
  let closed = false;
  function read(): Promise<PosSnapshot> {
    return new Promise((resolve, reject) => {
      if (closed) { reject(new Error('Offline database connection is closed.')); return; }
      const tx = db.transaction(OBJECT_STORE, 'readonly');
      const request = tx.objectStore(OBJECT_STORE).get(key);
      let state: PosSnapshot;
      request.onsuccess = () => { state = request.result ?? emptySnapshot(scope); };
      tx.oncomplete = () => resolve(clone(state));
      tx.onerror = () => reject(tx.error ?? new Error('Could not read saved orders.'));
      tx.onabort = () => reject(tx.error ?? new Error('Reading saved orders was interrupted.'));
    });
  }
  function mutate<T>(change: (state: PosSnapshot) => T): Promise<T> {
    requireTraining(scope);
    return new Promise((resolve, reject) => {
      if (closed) { reject(new Error('Offline database connection is closed.')); return; }
      const tx = db.transaction(OBJECT_STORE, 'readwrite');
      const objectStore = tx.objectStore(OBJECT_STORE);
      const request = objectStore.get(key);
      let result: T;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const state: PosSnapshot = request.result ?? emptySnapshot(scope);
          if (state.schemaVersion !== 1 || scopeKey(state.scope) !== key) throw new Error('Saved device data failed validation. Export and seek support.');
          result = clone(change(state));
          state.revision += 1;
          objectStore.put(state, key);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => {
        resolve(result);
        notify();
        if (!closed) { try { channel?.postMessage({ revisionChanged: true }); } catch { /* A closed observer channel cannot invalidate a committed save. */ } }
      };
      tx.onerror = () => reject(failure ?? tx.error ?? new Error('Sale was not saved. Check device storage and retry.'));
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Save interrupted. No success has been recorded.'));
    });
  }
  return {
    snapshot: read,
    openShift(input) {
      input = clone(input);
      return mutate(state => {
        nonblank(input.cashierName, 'Cashier name'); assertMoney(input.openingCashFils, 'Opening cash');
        if (state.shifts.some(s => s.status === 'open')) throw new Error('A shift is already open on this device.');
        const shift: Shift = { id: createId(), openedAt: new Date().toISOString(), cashierName: input.cashierName.trim(), openingCashFils: input.openingCashFils, status: 'open' };
        state.shifts.push(shift); appendEvent(state, 'shift.opened', shift); return shift;
      });
    },
    holdOrder(input) {
      input = clone(input);
      return mutate(state => {
        const fingerprint = stable(input);
        const operationKey = input.idempotencyKey ? `op:${input.idempotencyKey}` : undefined;
        if (input.idempotencyKey !== undefined) nonblank(input.idempotencyKey, 'Hold operation key');
        if (operationKey) {
          const prior = state.holdOperations?.[operationKey];
          if (prior) {
            if (prior.status !== 'held') throw new Error('This held-order operation was already paid or cancelled. Start a new order.');
            if (prior.fingerprint !== fingerprint) throw new Error('This hold operation key was already used with different order details.');
            const saved = state.holds.find(hold => hold.id === prior.holdId);
            if (!saved) throw new Error('This held-order operation was already resolved.');
            return saved;
          }
          if (state.sales.some(sale => sale.idempotencyKey === input.idempotencyKey)) throw new Error('This order was already paid. Start a new order.');
        }
        openShiftFrom(state); nonblank(input.label, 'Order label'); validateServiceType(input.serviceType);
        if (!input.lines.length) throw new Error('Add items before holding an order.');
        calculateTotals(input.lines, input.discountFils ?? 0);
        const existing = input.id ? state.holds.find(h => h.id === input.id) : undefined;
        if (input.id && !existing) throw new Error('This held order was already resolved.');
        const kitchen = (state.preferences.kitchen ?? []) as Array<{ id: string }>;
        if (!Array.isArray(kitchen)) throw new Error('Kitchen ticket storage is invalid. Recover from a backup.');
        if (existing && kitchen.some(ticket => ticket.id === existing.id)) throw new Error('This order already has a kitchen ticket. Reconcile it before changing the held order.');
        const now = new Date().toISOString();
        const hold: HeldOrder = { id: existing?.id ?? createId(), createdAt: existing?.createdAt ?? now, updatedAt: now, label: input.label.trim(), serviceType: input.serviceType, lines: clone(input.lines), discountFils: input.discountFils ?? 0, discountReason: input.discountReason, note: input.note };
        state.holds = state.holds.filter(h => h.id !== hold.id); state.holds.push(hold);
        if (operationKey) {
          state.holdOperations ??= {};
          state.holdOperations[operationKey] = { holdId: hold.id, fingerprint, status: 'held' };
        }
        if (input.sendToKitchen) state.preferences.kitchen = [...kitchen, { id: hold.id, label: hold.label, createdAt: hold.createdAt, lines: clone(hold.lines), status: 'new', serviceType: hold.serviceType }];
        const draft = state.preferences.draft as { cart?: unknown; idempotencyKey?: string } | undefined;
        if (draft && ((input.idempotencyKey && draft.idempotencyKey === input.idempotencyKey) || (!draft.idempotencyKey && stable(draft.cart) === stable(input.lines)))) delete state.preferences.draft;
        return hold;
      });
    },
    deleteHold(id) { return mutate(state => {
      if (!state.holds.some(h => h.id === id)) throw new Error('Held order not found.');
      state.holds = state.holds.filter(h => h.id !== id);
      for (const operation of Object.values(state.holdOperations ?? {})) if (operation.holdId === id) operation.status = 'cancelled';
    }); },
    completeSale(input) {
      input = clone(input);
      return mutate(state => {
        nonblank(input.idempotencyKey, 'Order operation key');
        const fingerprint = stable(input);
        const existing = state.sales.find(s => s.idempotencyKey === input.idempotencyKey);
        if (existing) {
          if (existing.inputFingerprint !== fingerprint) throw new Error('This order key was used for a different payment. Start a new order.');
          return existing;
        }
        const shift = openShiftFrom(state); validateServiceType(input.serviceType);
        if (!input.lines.length) throw new Error('Add items before completing payment.');
        const heldOrder = input.holdId ? state.holds.find(hold => hold.id === input.holdId) : undefined;
        if (input.holdId && !heldOrder) throw new Error('This held order was already resolved. Check receipts before retrying.');
        const kitchen = (state.preferences.kitchen ?? []) as Array<{ id: string }>;
        if (heldOrder && kitchen.some(ticket => ticket.id === heldOrder.id)) {
          const sentLines = heldOrder.lines.map(line => ({ ...line, note: line.note ?? '' }));
          const checkoutLines = input.lines.map(line => ({ ...line, note: line.note ?? '' }));
          if (stable(sentLines) !== stable(checkoutLines) || input.serviceType !== heldOrder.serviceType || (input.label ?? '').trim() !== heldOrder.label.trim() || (input.note ?? '') !== (heldOrder.note ?? '')) {
            throw new Error('This order differs from its kitchen ticket. Restore the sent items, order type, label and notes before payment, or cancel and reconcile the kitchen order before replacing it. Discounts and payment methods can still be changed.');
          }
        }
        const totals = calculateTotals(input.lines, input.discountFils ?? 0, input.tax);
        if (totals.discountFils > 0) nonblank(input.discountReason ?? '', 'Discount reason');
        const payment = validatePayment(totals.totalFils, input.tenders);
        const id = createId();
        const prefix = scope.deviceId.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase() || 'DEVICE';
        const sale: Sale = { calculationVersion: 'line-v2', holdId: input.holdId, id, idempotencyKey: input.idempotencyKey, receiptNumber: `${scope.mode === 'training' ? 'TRAIN-' : ''}${prefix}-${String(state.sales.length + 1).padStart(6, '0')}`, scope: clone(scope), shiftId: shift.id, createdAt: new Date().toISOString(), lines: clone(input.lines), totals, tax: clone(input.tax), payment, serviceType: input.serviceType, label: input.label, note: input.note, discountReason: input.discountReason, inputFingerprint: fingerprint };
        state.sales.push(sale);
        const draft = state.preferences.draft as { cart?: unknown; idempotencyKey?: string } | undefined;
        if (draft && (draft.idempotencyKey === input.idempotencyKey || stable(draft.cart) === stable(input.lines))) delete state.preferences.draft;
        if (input.holdId) {
          state.holds = state.holds.filter(h => h.id !== input.holdId);
          for (const operation of Object.values(state.holdOperations ?? {})) if (operation.holdId === input.holdId) operation.status = 'paid';
        }
        appendEvent(state, 'sale.created', sale); expectedCashFils(state, shift.id); return sale;
      });
    },
    refundSale(input) {
      input = clone(input);
      return mutate(state => {
        nonblank(input.idempotencyKey, 'Refund operation key'); nonblank(input.reason, 'Refund reason'); assertMoney(input.amountFils, 'Refund');
        if (!input.amountFils) throw new Error('Refund must be positive.');
        if (!['cash', 'card'].includes(input.method)) throw new Error('Invalid refund method.');
        const existing = state.refunds.find(r => r.idempotencyKey === input.idempotencyKey);
        if (existing) {
          if (existing.saleId !== input.saleId || existing.amountFils !== input.amountFils || existing.method !== input.method || existing.reason !== input.reason.trim()) throw new Error('Refund key already used with different details.');
          return existing;
        }
        const shift = openShiftFrom(state);
        if (input.amountFils > remainingRefundFils(state, input.saleId)) throw new Error('Refund exceeds the remaining refundable balance.');
        const sale = state.sales.find(s => s.id === input.saleId)!;
        const paidByMethod = input.method === 'cash' ? sale.payment.cashRetainedFils : sale.payment.cardRecordedFils;
        const alreadyRefundedByMethod = state.refunds.filter(r => r.saleId === input.saleId && r.method === input.method).reduce((sum, r) => sum + r.amountFils, 0);
        if (input.amountFils > paidByMethod - alreadyRefundedByMethod) throw new Error('Refund exceeds the original amount paid by this method.');
        if (input.method === 'cash' && input.amountFils > expectedCashFils(state, shift.id)) throw new Error('Insufficient recorded cash in the drawer for this refund.');
        const refund: Refund = { id: createId(), idempotencyKey: input.idempotencyKey, saleId: input.saleId, shiftId: shift.id, createdAt: new Date().toISOString(), amountFils: input.amountFils, method: input.method, reason: input.reason.trim() };
        state.refunds.push(refund); appendEvent(state, 'refund.created', refund); return refund;
      });
    },
    cashMovement(input) {
      input = clone(input);
      return mutate(state => {
        nonblank(input.idempotencyKey, 'Cash movement operation key'); nonblank(input.reason, 'Cash movement reason'); assertMoney(input.amountFils);
        if (!input.amountFils || !['in', 'out'].includes(input.direction)) throw new Error('Enter a positive amount and valid cash movement direction.');
        const existing = state.cashMovements.find(m => m.idempotencyKey === input.idempotencyKey);
        if (existing) {
          if (existing.direction !== input.direction || existing.amountFils !== input.amountFils || existing.reason !== input.reason.trim()) throw new Error('Cash movement key already used with different details.');
          return existing;
        }
        const shift = openShiftFrom(state);
        if (input.direction === 'out' && input.amountFils > expectedCashFils(state, shift.id)) throw new Error('Cash payout exceeds recorded drawer cash.');
        const movement: CashMovement = { id: createId(), idempotencyKey: input.idempotencyKey, shiftId: shift.id, createdAt: new Date().toISOString(), direction: input.direction, amountFils: input.amountFils, reason: input.reason.trim() };
        state.cashMovements.push(movement); expectedCashFils(state, shift.id); appendEvent(state, 'cash.moved', movement); return movement;
      });
    },
    closeShift(input) {
      input = clone(input);
      return mutate(state => {
        assertMoney(input.countedCashFils, 'Counted cash'); const shift = openShiftFrom(state);
        if (state.holds.length) throw new Error('Resolve or explicitly discard all unpaid held orders before closing this shift.');
        shift.status = 'closed'; shift.closedAt = new Date().toISOString(); shift.expectedCashFils = expectedCashFils(state, shift.id);
        shift.countedCashFils = input.countedCashFils; shift.differenceFils = input.countedCashFils - shift.expectedCashFils; shift.closingNote = input.note;
        appendEvent(state, 'shift.closed', shift); return shift;
      });
    },
    setPreference(name, value) { return mutate(state => {
      if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Invalid setting name.');
      if (name === 'draft' && value && typeof value === 'object') {
        const draftKey = (value as { idempotencyKey?: string }).idempotencyKey;
        if (draftKey && (state.sales.some(sale => sale.idempotencyKey === draftKey) || state.holdOperations?.[`op:${draftKey}`])) { delete state.preferences.draft; return; }
      }
      state.preferences[name] = clone(value);
    }); },
    async exportBackup() {
      const snapshot = await read();
      return JSON.stringify({ format: 'internext-pos-device-backup', exportedAt: new Date().toISOString(), notice: 'Local training backup. This is not proof of cloud sync or a tax invoice archive.', snapshot }, null, 2);
    },
    restoreBackup(text) {
      const parsed = parseTrainingBackup(text);
      if (scopeKey(parsed.snapshot.scope) !== key) throw new Error('This backup belongs to a different device identity. Recover its original training device identity before restoring; receipts must not be reassigned.');
      return mutate(state => {
        if ([state.sales, state.refunds, state.holds, state.shifts, state.cashMovements, state.outbox].some(records => records.length)) throw new Error('Restore requires an empty training device. Existing orders, shifts and audit records will never be overwritten or merged.');
        const recovered = clone(parsed.snapshot);
        Object.assign(state, recovered);
        return { ...state, revision: state.revision + 1 };
      });
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { closed = true; channel?.close(); listeners.clear(); db.close(); },
  };
}
