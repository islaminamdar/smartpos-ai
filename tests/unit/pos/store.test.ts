// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
let browser: Browser;
let server: Server;
let page: Page;

beforeAll(async () => {
  const modules = new Map(['types', 'money', 'local-store', 'sync'].map(name => [name, ts.transpileModule(readFileSync(join(process.cwd(), 'lib/pos', `${name}.ts`), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${path}.js'`)]));
  server = createServer((req, res) => {
    const name = (req.url ?? '').replace(/^\//, '').replace(/\.js$/, '');
    res.setHeader('Content-Type', modules.has(name) ? 'application/javascript' : 'text/html');
    res.end(modules.get(name) ?? '<!doctype html><title>Offline storage verification</title>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server unavailable.');
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? (existsSync(chromium.executablePath()) ? undefined : existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined) });
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
}, 30000);
afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });

describe('actual Chromium IndexedDB transaction verification', () => {
  it('saves atomically, deduplicates retries, caps refunds, closes shifts and survives reopening', async () => {
    const result = await page.evaluate(async () => {
      const modulePath = '/local-store.js'; const { createLocalPosStore, expectedCashFils } = await new Function('url', 'return import(url)')(modulePath);
      const scope = { organisationId: 'test-org', branchId: 'burdubai', deviceId: 'counter-1', mode: 'training' };
      const store = await createLocalPosStore(scope);
      await store.openShift({ cashierName: 'Training cashier', openingCashFils: 10000 });
      const input = { idempotencyKey: 'order-1', lines: [{ id: 'line-1', itemId: 'sweet', name: 'Sweet', unit: 'kg', quantity: 250, unitPriceFils: 6000 }], tax: { rateBps: 500, inclusive: true, confirmed: false }, tenders: [{ method: 'cash', amountFils: 2000 }], serviceType: 'takeaway' };
      const [a, b] = await Promise.all([store.completeSale(input), store.completeSale(input)]);
      let conflict = false;
      try { await store.completeSale({ ...input, label: 'Changed payload' }); } catch { conflict = true; }
      const hold = await store.holdOrder({ label: 'Table 1', serviceType: 'dine_in', lines: input.lines });
      let heldCloseRejected = false;
      try { await store.closeShift({ countedCashFils: 11500 }); } catch { heldCloseRejected = true; }
      await store.deleteHold(hold.id);
      const refundInput = { idempotencyKey: 'refund-1', saleId: a.id, amountFils: 500, method: 'cash', reason: 'Training partial refund' };
      const r1 = await store.refundSale(refundInput); const r2 = await store.refundSale(refundInput);
      let excessiveRefundRejected = false;
      try { await store.refundSale({ ...refundInput, idempotencyKey: 'refund-2', amountFils: 1100 }); } catch { excessiveRefundRejected = true; }
      await store.cashMovement({ idempotencyKey: 'cash-1', direction: 'out', amountFils: 1000, reason: 'Training petty cash' });
      const state = await store.snapshot();
      const expectedCash = expectedCashFils(state, a.shiftId);
      const closed = await store.closeShift({ countedCashFils: 9900 });
      const backup = JSON.parse(await store.exportBackup());
      store.close();
      const reopened = await createLocalPosStore(scope); const saved = await reopened.snapshot(); reopened.close();
      const otherDevice = await createLocalPosStore({ ...scope, deviceId: 'counter-2' }); const isolated = await otherDevice.snapshot(); otherDevice.close();
      return { sameSale: a.id === b.id, sameRefund: r1.id === r2.id, conflict, heldCloseRejected, excessiveRefundRejected, expectedCash, difference: closed.differenceFils, saleCount: saved.sales.length, refundCount: saved.refunds.length, outboxCount: saved.outbox.length, backupSales: backup.snapshot.sales.length, isolatedSales: isolated.sales.length, saleTotal: saved.sales[0].totals.totalFils, cashRetained: saved.sales[0].payment.cashRetainedFils, receipt: saved.sales[0].receiptNumber };
    });
    expect(result).toMatchObject({ sameSale: true, sameRefund: true, conflict: true, heldCloseRejected: true, excessiveRefundRejected: true, expectedCash: 10000, difference: -100, saleCount: 1, refundCount: 1, outboxCount: 5, backupSales: 1, isolatedSales: 0, saleTotal: 1500, cashRetained: 1500 });
    expect(result.receipt).toContain('TRAIN-COUNTER1-');
  });
  it('a failed database write never leaves a sale or outbox success behind', async () => {
    const result = await page.evaluate(async () => {
      const modulePath = '/local-store.js'; const { createLocalPosStore } = await new Function('url', 'return import(url)')(modulePath);
      const store = await createLocalPosStore({ organisationId: 'test-org', branchId: 'burdubai', deviceId: 'counter-failure', mode: 'training' });
      await store.openShift({ cashierName: 'Tester', openingCashFils: 0 });
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function () { throw new DOMException('Storage quota exhausted', 'QuotaExceededError'); };
      let rejected = false;
      try { await store.completeSale({ idempotencyKey: 'failed-order', lines: [{ id: 'l', itemId: 'i', name: 'Item', unit: 'each', quantity: 1, unitPriceFils: 100 }], tax: { rateBps: 0, inclusive: true, confirmed: false }, tenders: [{ method: 'cash', amountFils: 100 }], serviceType: 'takeaway' }); } catch { rejected = true; }
      finally { IDBObjectStore.prototype.put = originalPut; }
      const state = await store.snapshot(); store.close();
      return { rejected, sales: state.sales.length, outbox: state.outbox.length };
    });
    expect(result).toEqual({ rejected: true, sales: 0, outbox: 1 });
  });
  it('blocks unprovisioned live writes and does not report training records as cloud synced', async () => {
    const result = await page.evaluate(async () => {
      const storePath = '/local-store.js'; const syncPath = '/sync.js';
      const { createLocalPosStore } = await new Function('url', 'return import(url)')(storePath); const { getSyncStatus } = await new Function('url', 'return import(url)')(syncPath);
      const scope = { organisationId: 'test-org', branchId: 'burdubai', deviceId: 'live-counter', mode: 'live' };
      const store = await createLocalPosStore(scope);
      let blocked = false; try { await store.openShift({ cashierName: 'Live', openingCashFils: 0 }); } catch { blocked = true; }
      const state = await store.snapshot(); store.close();
      return { blocked, shifts: state.shifts.length, status: getSyncStatus({ ...state, scope: { ...scope, mode: 'training' } }, true) };
    });
    expect(result).toMatchObject({ blocked: true, shifts: 0, status: { state: 'training_local_only', syncedEvents: 0 } });
  });
  it('recovers only validated exact-device training backups into empty state without changing financial originals', async () => {
    const result = await page.evaluate(async () => {
      const modulePath = '/local-store.js'; const { createLocalPosStore, inspectTrainingBackup, scopeKey } = await new Function('url', 'return import(url)')(modulePath);
      const scope = { organisationId: 'recovery-org', branchId: 'recovery-branch', deviceId: 'recover-this-device', mode: 'training' };
      let store = await createLocalPosStore(scope);
      await store.openShift({ cashierName: 'Recovery tester', openingCashFils: 1000 });
      const input = { idempotencyKey: 'restore-sale', lines: [{ id: 'restore-line', itemId: 'item', name: 'Item', unit: 'each', quantity: 1, unitPriceFils: 1050 }], tax: { rateBps: 500, inclusive: true, confirmed: false }, tenders: [{ method: 'cash', amountFils: 1100 }], serviceType: 'takeaway' };
      const sale = await store.completeSale(input);
      await store.refundSale({ idempotencyKey: 'restore-refund', saleId: sale.id, amountFils: 50, method: 'cash', reason: 'Training recovery test' });
      await store.closeShift({ countedCashFils: 2000 });
      const backup = await store.exportBackup(); const inspection = inspectTrainingBackup(backup);
      let overwriteBlocked = false; try { await store.restoreBackup(backup); } catch { overwriteBlocked = true; }
      store.close();
      const wrong = await createLocalPosStore({ ...scope, deviceId: 'wrong-device' });
      let scopeBlocked = false; try { await wrong.restoreBackup(backup); } catch { scopeBlocked = true; } wrong.close();
      // Simulate losing this one local device namespace, then recovering its original identity.
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('internext-pos-local-v1', 1);
        request.onsuccess = () => { const db = request.result; const tx = db.transaction('branch_device_state', 'readwrite'); tx.objectStore('branch_device_state').delete(scopeKey(scope)); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
        request.onerror = () => reject(request.error);
      });
      store = await createLocalPosStore(scope);
      const corrupt = JSON.parse(backup); corrupt.snapshot.sales[0].totals.totalFils += 1;
      let corruptBlocked = false; try { await store.restoreBackup(JSON.stringify(corrupt)); } catch { corruptBlocked = true; }
      const before = await store.snapshot();
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exhausted', 'QuotaExceededError'); };
      let quotaBlocked = false;
      try { await store.restoreBackup(backup); } catch { quotaBlocked = true; } finally { IDBObjectStore.prototype.put = originalPut; }
      const afterFailure = await store.snapshot();
      await store.restoreBackup(backup);
      const restored = await store.snapshot(); store.close();
      const modifiedRefund = JSON.parse(backup); modifiedRefund.snapshot.refunds[0].amountFils = 2000;
      let refundCorruptionBlocked = false; try { inspectTrainingBackup(JSON.stringify(modifiedRefund)); } catch { refundCorruptionBlocked = true; }
      const missingAudit = JSON.parse(backup); missingAudit.snapshot.outbox.pop();
      let missingAuditBlocked = false; try { inspectTrainingBackup(JSON.stringify(missingAudit)); } catch { missingAuditBlocked = true; }
      return { overwriteBlocked, scopeBlocked, corruptBlocked, quotaBlocked, refundCorruptionBlocked, missingAuditBlocked, beforeCount: before.sales.length, failedCount: afterFailure.sales.length, inspectionCount: inspection.sales, restoredCount: restored.sales.length, identicalSale: JSON.stringify(restored.sales[0]) === JSON.stringify(sale), device: restored.scope.deviceId, refundCount: restored.refunds.length, shiftClosed: restored.shifts[0].status === 'closed' };
    });
    expect(result).toEqual({ overwriteBlocked: true, scopeBlocked: true, corruptBlocked: true, quotaBlocked: true, refundCorruptionBlocked: true, missingAuditBlocked: true, beforeCount: 0, failedCount: 0, inspectionCount: 1, restoredCount: 1, identicalSale: true, device: 'recover-this-device', refundCount: 1, shiftClosed: true });
  });
  it('clears a paid basket atomically and ignores delayed autosave for an already-paid operation', async () => {
    const result = await page.evaluate(async () => {
      const modulePath = '/local-store.js'; const { createLocalPosStore } = await new Function('url', 'return import(url)')(modulePath);
      const store = await createLocalPosStore({ organisationId: 'draft-org', branchId: 'draft-branch', deviceId: 'draft-device', mode: 'training' });
      await store.openShift({ cashierName: 'Draft tester', openingCashFils: 0 });
      const lines = [{ id: 'draft-line', itemId: 'item', name: 'Item', unit: 'each', quantity: 1, unitPriceFils: 100 }];
      const draft = { cart: lines, idempotencyKey: 'draft-paid-key' };
      await store.setPreference('draft', draft);
      await store.completeSale({ idempotencyKey: 'draft-paid-key', lines, tax: { rateBps: 0, inclusive: true, confirmed: false }, tenders: [{ method: 'cash', amountFils: 100 }], serviceType: 'takeaway' });
      const afterPaid = await store.snapshot();
      await store.setPreference('draft', draft);
      const afterStaleSave = await store.snapshot(); store.close();
      return { paidDraftCleared: afterPaid.preferences.draft === undefined, staleDraftIgnored: afterStaleSave.preferences.draft === undefined, sales: afterStaleSave.sales.length };
    });
    expect(result).toEqual({ paidDraftCleared: true, staleDraftIgnored: true, sales: 1 });
  });

  it('commits held order, kitchen ticket and draft resolution together and rejects resolved operation resurrection', async () => {
    const result = await page.evaluate(async () => {
      const modulePath = '/local-store.js'; const { createLocalPosStore, inspectTrainingBackup } = await new Function('url', 'return import(url)')(modulePath);
      const store = await createLocalPosStore({ organisationId: 'hold-org', branchId: 'hold-branch', deviceId: 'hold-device', mode: 'training' });
      await store.openShift({ cashierName: 'Hold tester', openingCashFils: 0 });
      const lines = [{ id: 'held-line', itemId: 'item', name: 'Item', unit: 'each', quantity: 1, unitPriceFils: 100 }];
      const draft = { cart: lines, idempotencyKey: 'hold-command' };
      await store.setPreference('draft', draft);
      const input = { idempotencyKey: 'hold-command', sendToKitchen: true, label: 'Table 3', serviceType: 'dine_in', lines, discountFils: 10, discountReason: 'Training adjustment' };
      const [first, retry] = await Promise.all([store.holdOrder(input), store.holdOrder(input)]);
      await store.setPreference('draft', draft);
      const held = await store.snapshot(); const inspectedHeld = inspectTrainingBackup(await store.exportBackup());
      let conflictBlocked = false; try { await store.holdOrder({ ...input, label: 'Changed' }); } catch { conflictBlocked = true; }
      await store.setPreference('kitchen', []); await store.deleteHold(first.id);
      let cancelledBlocked = false; try { await store.holdOrder(input); } catch { cancelledBlocked = true; }
      const paidInput = { ...input, idempotencyKey: 'held-for-payment', sendToKitchen: false };
      const toPay = await store.holdOrder(paidInput);
      await store.completeSale({ idempotencyKey: 'paid-held-key', holdId: toPay.id, lines, discountFils: 10, discountReason: 'Training adjustment', tax: { rateBps: 0, inclusive: true, confirmed: false }, tenders: [{ method: 'cash', amountFils: 90 }], serviceType: 'dine_in', label: 'Table 3' });
      let paidBlocked = false; try { await store.holdOrder(paidInput); } catch { paidBlocked = true; }
      const inspectedPaid = inspectTrainingBackup(await store.exportBackup()); store.close();
      return { sameHold: first.id === retry.id, holds: held.holds.length, kitchen: held.preferences.kitchen.length, draftCleared: held.preferences.draft === undefined, discountReason: first.discountReason, inspectedHolds: inspectedHeld.heldOrders, conflictBlocked, cancelledBlocked, paidBlocked, paidCount: inspectedPaid.sales };
    });
    expect(result).toEqual({ sameHold: true, holds: 1, kitchen: 1, draftCleared: true, discountReason: 'Training adjustment', inspectedHolds: 1, conflictBlocked: true, cancelledBlocked: true, paidBlocked: true, paidCount: 1 });
  });
  it('a failed atomic kitchen dispatch preserves the draft without leaving a hold or kitchen ticket', async () => {
    const result = await page.evaluate(async () => {
      const modulePath = '/local-store.js'; const { createLocalPosStore } = await new Function('url', 'return import(url)')(modulePath);
      const store = await createLocalPosStore({ organisationId: 'hold-org', branchId: 'hold-branch', deviceId: 'hold-failure', mode: 'training' });
      await store.openShift({ cashierName: 'Hold tester', openingCashFils: 0 });
      const lines = [{ id: 'failed-held-line', itemId: 'item', name: 'Item', unit: 'each', quantity: 1, unitPriceFils: 100 }];
      await store.setPreference('draft', { cart: lines, idempotencyKey: 'failed-hold-command' });
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exhausted', 'QuotaExceededError'); };
      let failed = false;
      try { await store.holdOrder({ idempotencyKey: 'failed-hold-command', sendToKitchen: true, label: 'Table 4', serviceType: 'dine_in', lines }); } catch { failed = true; } finally { IDBObjectStore.prototype.put = originalPut; }
      const state = await store.snapshot(); store.close();
      return { failed, holds: state.holds.length, kitchen: state.preferences.kitchen?.length ?? 0, draftPreserved: state.preferences.draft?.cart?.length === 1, operations: Object.keys(state.holdOperations ?? {}).length };
    });
    expect(result).toEqual({ failed: true, holds: 0, kitchen: 0, draftPreserved: true, operations: 0 });
  });

  it('rejects kitchen-order edits at checkout while allowing discounts and payment-method changes', async () => {
    const result = await page.evaluate(async () => {
      const modulePath = '/local-store.js'; const { createLocalPosStore } = await new Function('url', 'return import(url)')(modulePath);
      const store = await createLocalPosStore({ organisationId: 'kitchen-invariant', branchId: 'branch', deviceId: 'counter', mode: 'training' });
      await store.openShift({ cashierName: 'Kitchen tester', openingCashFils: 0 });
      const lines = [{ id: 'kitchen-line', itemId: 'item', name: 'Sweet', unit: 'each', quantity: 1, unitPriceFils: 100, note: 'Less sugar' }];
      const held = await store.holdOrder({ idempotencyKey: 'kitchen-original', sendToKitchen: true, label: 'Table 6', serviceType: 'dine_in', note: 'No peanuts', lines });
      const original = { holdId: held.id, lines, label: 'Table 6', serviceType: 'dine_in', note: 'No peanuts', tax: { rateBps: 0, inclusive: true, confirmed: false }, tenders: [{ method: 'cash', amountFils: 100 }] };
      const edits = [
        { lines: [{ ...lines[0], quantity: 2 }] },
        { lines: [{ ...lines[0], note: 'Extra sugar' }] },
        { serviceType: 'takeaway' },
        { label: 'Table 7' },
        { note: 'Peanuts allowed' },
      ];
      const errors = [];
      for (let index = 0; index < edits.length; index++) {
        try { await store.completeSale({ ...original, ...edits[index], idempotencyKey: `rejected-kitchen-edit-${index}` }); errors.push('not rejected'); } catch (error) { errors.push((error as Error).message); }
      }
      const unchanged = await store.snapshot();
      const paid = await store.completeSale({ ...original, idempotencyKey: 'allowed-discount-payment', discountFils: 10, discountReason: 'Approved training discount', tenders: [{ method: 'card', amountFils: 90 }] });
      const final = await store.snapshot(); store.close();
      return { rejectedEdits: errors.filter(message => message.includes('differs from its kitchen ticket')).length, unpaidHolds: unchanged.holds.length, salesBefore: unchanged.sales.length, salesAfter: final.sales.length, holdsAfter: final.holds.length, total: paid.totals.totalFils, recordedCard: paid.payment.cardRecordedFils, unchangedKitchenQuantity: final.preferences.kitchen[0].lines[0].quantity };
    });
    expect(result).toEqual({ rejectedEdits: 5, unpaidHolds: 1, salesBefore: 0, salesAfter: 1, holdsAfter: 0, total: 90, recordedCard: 90, unchangedKitchenQuantity: 1 });
  });

});
