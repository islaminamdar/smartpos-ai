// Disposable embedded PostgreSQL only; same invocation/dependency as pos-schema.mjs.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { fiscalDocumentSchema } from '../../lib/pos/server/documents.ts'
const { PGlite } = await import(pathToFileURL(process.argv[2]).href)
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`)
for (const file of ['20261016000100_pos_platform.sql', '20261016000200_pos_operations.sql', '20261016000300_pos_live_documents.sql']) {
  await db.exec(await readFile(new URL('../../supabase/migrations/' + file, import.meta.url), 'utf8'))
}
const [manager, cashier, outsider, org, branch, otherOrg, otherBranch, device, otherDevice, product, profile] = Array.from({ length: 11 }, () => crypto.randomUUID())
await db.exec(`insert into auth.users values('${manager}'),('${cashier}'),('${outsider}');
insert into public.pos_organizations(id,legal_name) values('${org}','Synthetic company'),('${otherOrg}','Other company');
insert into public.pos_branches(id,organization_id,name) values('${branch}','${org}','Test branch'),('${otherBranch}','${otherOrg}','Other branch');
insert into public.pos_staff values('${org}','${manager}','${branch}','manager',true),('${org}','${cashier}','${branch}','cashier',true),('${otherOrg}','${outsider}','${otherBranch}','manager',true);
insert into public.pos_devices(id,organization_id,branch_id,name) values('${device}','${org}','${branch}','One'),('${otherDevice}','${org}','${branch}','Two');
insert into public.pos_products(id,organization_id,branch_id,name,category,unit_price_fils,tax_rate_bps) values('${product}','${org}','${branch}','Synthetic sweet','Test',300,500);
set role authenticated; set app.user_id='${manager}';`)
const rpc = async (name, value) => (await db.query(`select public.${name}($1::jsonb) as result`, [JSON.stringify(value)])).rows[0].result
const command = value => ({ id: crypto.randomUUID(), branchId: branch, ...value })
const shiftId = crypto.randomUUID()
const open = command({ type: 'shift.open', deviceId: device, shiftId, openingCashFils: 1000 })
await assert.rejects(rpc('pos_execute_live_command', open), /POS_PROFILE_REQUIRED/)
await db.exec(`reset role;
insert into public.pos_merchant_profiles(id,organization_id,branch_id,legal_name,branch_name,address,phone,trn,tax_registered,tax_inclusive,confirmed_by)
values('${profile}','${org}','${branch}','Synthetic receipt seller','Test branch','Synthetic test address','Synthetic contact','100000000000001',true,true,'${manager}');
insert into public.pos_branch_receipt_config(branch_id,organization_id,profile_id,series_prefix,live_enabled) values('${branch}','${org}','${profile}','TEST',true);
set role authenticated;`)
await rpc('pos_execute_live_command', open)
const sale = { id: crypto.randomUUID(), branchId: branch, deviceId: device, shiftId, createdAt: new Date().toISOString(), serviceType: 'takeaway', lines: [1, 2].map(() => ({ productId: product, quantityMilli: 1000, expectedUnitPriceFils: 300, expectedTaxRateBps: 500 })), payments: [{ method: 'cash', amountFils: 200 }, { method: 'card', amountFils: 400 }], expectedTotalFils: 600, profileId: profile, cashTenderedFils: 500, customer: null }
const live = value => rpc('pos_record_live_order', value)
const first = await live(sale)
fiscalDocumentSchema.parse(first.receipt)
assert.equal(first.taxFils, 28)
assert.equal(first.receipt.documentNumber, 'TEST-INV-0000000001')
assert.equal(first.receipt.changeFils, 300)
assert.equal(first.receipt.merchant.legalName, 'Synthetic receipt seller')
assert.deepEqual((await live(sale)).receipt, first.receipt)
await assert.rejects(live({ ...sale, cashTenderedFils: 501 }), /POS_IDEMPOTENCY_CONFLICT/)
await assert.rejects(live({ ...sale, customer: { name: 'Different buyer', address: 'Different', trn: null } }), /POS_IDEMPOTENCY_CONFLICT/)
const fresh = changes => ({ ...sale, id: crypto.randomUUID(), ...changes })
await assert.rejects(live(fresh({ profileId: crypto.randomUUID() })), /POS_PROFILE_CHANGED/)
await assert.rejects(live(fresh({ cashTenderedFils: 199 })), /POS_PAYMENT_MISMATCH/)
await assert.rejects(live(fresh({ customer: {} })), /POS_INVALID_CUSTOMER/)
await assert.rejects(live(fresh({ customer: { name: 'Buyer', address: 'Address', trn: 'bad' } })), /POS_INVALID_CUSTOMER/)
await assert.rejects(live(fresh({ payments: [{ method: 'other', amountFils: 600 }] })), /POS_INVALID_ORDER/)
await assert.rejects(live(fresh({ expectedTotalFils: 601 })), /POS_TOTAL_MISMATCH/)
const { profileId: _profile, cashTenderedFils: _cash, customer: _customer, ...foundationOrder } = sale
await assert.rejects(rpc('pos_record_paid_order', { ...foundationOrder, id: crypto.randomUUID() }), /POS_LIVE_CONTRACT_REQUIRED/)
await assert.rejects(rpc('pos_record_paid_order_foundation', foundationOrder), /permission denied/)
await assert.rejects(rpc('pos_execute_command_foundation', open), /permission denied/)
await assert.rejects(rpc('pos_execute_command', open), /POS_LIVE_CONTRACT_REQUIRED/)
const oldRefund = command({ type: 'refund.create', deviceId: device, shiftId, orderId: sale.id, method: 'cash', amountFils: 1, reason: 'Partial must not bypass' })
await assert.rejects(rpc('pos_execute_command', oldRefund), /POS_LIVE_CONTRACT_REQUIRED/)
await assert.rejects(rpc('pos_execute_live_command', oldRefund), /POS_INVALID_COMMAND/)
assert.equal((await db.query('select * from public.pos_orders')).rows.length, 1, 'failed post-sale validations rolled back the entire sale')
const second = await live(fresh({}))
assert.equal(second.receipt.documentNumber, 'TEST-INV-0000000002', 'failed calls and retries consume no numbers')

const replacement = crypto.randomUUID()
await db.exec(`reset role;
insert into public.pos_merchant_profiles(id,organization_id,branch_id,legal_name,branch_name,address,phone,trn,tax_registered,tax_inclusive,confirmed_by)
values('${replacement}','${org}','${branch}','New profile version','Test branch','Updated address','Synthetic contact','100000000000001',true,true,'${manager}');
update public.pos_branch_receipt_config set profile_id='${replacement}' where branch_id='${branch}';
update public.pos_products set name='Renamed menu item',unit_price_fils=500 where id='${product}';`)
await assert.rejects(db.exec(`update public.pos_merchant_profiles set legal_name='Changed original' where id='${profile}'`), /POS_IMMUTABLE_DOCUMENT/)
await assert.rejects(db.exec(`delete from public.pos_documents`), /POS_IMMUTABLE_DOCUMENT/)
await assert.rejects(db.exec(`update public.pos_branch_receipt_config set series_prefix='REPLACED' where branch_id='${branch}'`), /POS_IMMUTABLE_SERIES/)
await db.exec('set role authenticated;')
assert.deepEqual((await live(sale)).receipt, first.receipt, 'profile/catalogue edits never rewrite a committed retry')
const refund = command({ type: 'refund.full', deviceId: device, shiftId, orderId: sale.id, reason: 'Full synthetic return' })
await db.exec(`set app.user_id='${cashier}';`)
await assert.rejects(rpc('pos_execute_live_command', refund), /POS_MANAGER_REQUIRED/)
await assert.rejects(live(sale), /POS_IDEMPOTENCY_CONFLICT/)
await db.exec(`set app.user_id='${manager}';`)
const refundOtherShift = crypto.randomUUID()
await rpc('pos_execute_live_command', command({ type: 'shift.open', deviceId: otherDevice, shiftId: refundOtherShift, openingCashFils: 0 }))
await assert.rejects(rpc('pos_execute_live_command', { ...refund, id: crypto.randomUUID(), deviceId: otherDevice, shiftId: refundOtherShift }), /POS_INSUFFICIENT_CASH/)
await db.exec(`reset role;
create function public.test_refund_storage_failure() returns trigger language plpgsql as $$begin raise exception 'SIMULATED_REFUND_WRITE_FAILURE'; end;$$;
create trigger test_refund_fail before insert on public.pos_refunds for each row execute function public.test_refund_storage_failure();
set role authenticated;`)
await assert.rejects(rpc('pos_execute_live_command', refund), /SIMULATED_REFUND_WRITE_FAILURE/)
assert.equal((await db.query('select * from public.pos_documents')).rows.length, 2, 'failed refund insert rolled back credit document and its numbering')
assert.equal((await db.query('select * from public.pos_refunds')).rows.length, 0)
await db.exec('reset role; drop trigger test_refund_fail on public.pos_refunds; drop function public.test_refund_storage_failure(); set role authenticated;')
const returned = await rpc('pos_execute_live_command', refund)
fiscalDocumentSchema.parse(returned.creditNote)
assert.equal(returned.creditNote.documentNumber, 'TEST-CN-0000000001')
assert.deepEqual(returned.creditNote.lines, first.receipt.lines)
assert.deepEqual(returned.creditNote.merchant, first.receipt.merchant)
assert.deepEqual(returned.creditNote.totals, first.receipt.totals)
assert.equal(returned.creditNote.originalInvoice.documentNumber, first.receipt.documentNumber)
assert.deepEqual(returned.creditNote.adjustedTotals, { grossFils: 0, netFils: 0, taxFils: 0 })
assert.deepEqual((await rpc('pos_execute_live_command', refund)).creditNote, returned.creditNote)
await assert.rejects(rpc('pos_execute_live_command', { ...refund, reason: 'Changed reason' }), /POS_IDEMPOTENCY_CONFLICT/)
await assert.rejects(rpc('pos_execute_live_command', { ...refund, id: crypto.randomUUID() }), /POS_PRIOR_REFUND_EXISTS/)
assert.equal((await db.query('select * from public.pos_refunds')).rows.length, 2, 'one reversal per original tender')

// Simulate an existing partial-refund record that requires manual reconciliation, never automatic full reversal.
await db.exec(`reset role; insert into public.pos_refunds(id,organization_id,branch_id,order_id,device_id,shift_id,actor_id,method,amount_fils,reason)
values('${crypto.randomUUID()}','${org}','${branch}','${second.orderId}','${device}','${shiftId}','${manager}','cash',1,'Synthetic prior partial'); set role authenticated;`)
await assert.rejects(rpc('pos_execute_live_command', { ...refund, id: crypto.randomUUID(), orderId: second.orderId }), /POS_PRIOR_REFUND_EXISTS/)
const closed = await rpc('pos_execute_live_command', command({ type: 'shift.close', deviceId: device, shiftId, countedCashFils: 1199 }))
assert.equal(closed.expectedCashFils, 1199)
assert.deepEqual((await rpc('pos_execute_live_command', refund)).creditNote, returned.creditNote, 'ack retry survives closed shift')
assert.deepEqual((await live(sale)).receipt, first.receipt, 'sale ack survives closed shift')
await db.exec(`set app.user_id='${outsider}';`)
assert.equal((await db.query('select * from public.pos_documents')).rows.length, 0)
assert.equal((await db.query('select * from public.pos_merchant_profiles')).rows.length, 0)
await assert.rejects(live(sale), /POS_ACCESS_DENIED/)
await db.exec('reset role; set role anon;')
await assert.rejects(live(sale), /permission denied/)
await assert.rejects(db.query('select * from public.pos_documents'), /permission denied/)
await db.close()
console.log('PASS: live profiles, immutable numbered receipts, rollback/no-gap retries, exact credit notes, role/RLS boundaries, old API bypass denial, prior-refund rejection and drawer reconciliation.')
