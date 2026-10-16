// Disposable embedded PostgreSQL. Real multi-session concurrency is a separate staging gate.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const { PGlite } = await import(pathToFileURL(process.argv[2]).href)
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`)
for (const file of ['20261016000100_pos_platform.sql', '20261016000200_pos_operations.sql', '20261016000300_pos_live_documents.sql', '20261016000400_pos_online_access.sql', '20261016000500_pos_request_recovery.sql', '20261016000600_pos_cash_out_balance.sql']) {
  await db.exec(await readFile(new URL('../../supabase/migrations/' + file, import.meta.url), 'utf8'))
}
const [actor, org, branch, profile, product] = Array.from({ length: 5 }, () => crypto.randomUUID())
await db.exec(`insert into auth.users values('${actor}');
insert into public.pos_organizations(id,legal_name) values('${org}','Synthetic');
insert into public.pos_branches(id,organization_id,name) values('${branch}','${org}','Test branch');
insert into public.pos_staff values('${org}','${actor}','${branch}','manager',true);
insert into public.pos_merchant_profiles(id,organization_id,branch_id,legal_name,branch_name,address,phone,trn,tax_registered,tax_inclusive,confirmed_by)
values('${profile}','${org}','${branch}','Synthetic merchant','Test branch','Test address','Test contact','100000000000001',true,true,'${actor}');
insert into public.pos_branch_receipt_config values('${branch}','${org}','${profile}','TEST',true);
insert into public.pos_products(id,organization_id,branch_id,name,category,unit_price_fils,tax_rate_bps) values('${product}','${org}','${branch}','Test item','Test',1050,500);
set role authenticated; set app.user_id='${actor}';`)
const binding = 'a'.repeat(64)
const device = (await db.query('select public.pos_enroll_device($1::uuid,$2,$3) as result', [branch, 'Test counter', binding])).rows[0].result
const rpc = async (name, value, key = binding) => (await db.query(`select public.${name}($1::jsonb,$2) as result`, [JSON.stringify(value), key])).rows[0].result
const shiftId = crypto.randomUUID()
const command = value => ({ id: crypto.randomUUID(), branchId: branch, deviceId: device.id, shiftId, ...value })
await rpc('pos_execute_live_command', command({ type: 'shift.open', openingCashFils: 10000 }))
const withdrawal = command({ type: 'cash.move', amountFils: -8000, reason: 'Synthetic cash out' })
const first = await rpc('pos_execute_live_command', withdrawal)
await assert.rejects(rpc('pos_execute_live_command', { ...withdrawal, id: crypto.randomUUID() }), /POS_INSUFFICIENT_CASH/)
assert.deepEqual(await rpc('pos_execute_live_command', withdrawal), { ...first, replayed: true }, 'retry is accepted even though current balance is less than original withdrawal')
assert.equal((await db.query('select * from public.pos_cash_movements')).rows.length, 1)
assert.equal((await db.query("select * from public.pos_command_receipts where command_type='cash.move'")).rows.length, 1, 'rejected movement leaves no success receipt')
assert.equal((await db.query("select * from public.pos_audit_events where event_type='cash.move'")).rows.length, 1, 'rejected movement leaves no success audit')
const expected = async () => (await db.query('select public.pos_open_shift_summaries() as result')).rows[0].result.find(row => row.id === shiftId).expectedCashFils
assert.equal(await expected(), 2000)

const order = { id: crypto.randomUUID(), branchId: branch, deviceId: device.id, shiftId, createdAt: new Date().toISOString(), serviceType: 'takeaway', lines: [{ productId: product, quantityMilli: 1000, expectedUnitPriceFils: 1050, expectedTaxRateBps: 500 }], payments: [{ method: 'cash', amountFils: 650 }, { method: 'card', amountFils: 400 }], expectedTotalFils: 1050, profileId: profile, customer: null, cashTenderedFils: 1000 }
await rpc('pos_record_live_order', order)
assert.equal(await expected(), 2650, 'cash retained counts; change and card do not')
await rpc('pos_execute_live_command', command({ type: 'cash.move', amountFils: 350, reason: 'Test float addition' }))
assert.equal(await expected(), 3000)
await rpc('pos_execute_live_command', command({ type: 'refund.full', orderId: order.id, reason: 'Test full return' }))
assert.equal(await expected(), 2350, 'cash refund is subtracted; recorded card refund is not')
await assert.rejects(rpc('pos_execute_live_command', command({ type: 'cash.move', amountFils: -2351, reason: 'One fil overdraw' })), /POS_INSUFFICIENT_CASH/)
await rpc('pos_execute_live_command', command({ type: 'cash.move', amountFils: -2350, reason: 'Exact drawer withdrawal' }))
assert.equal(await expected(), 0)
await assert.rejects(rpc('pos_execute_live_command', command({ type: 'cash.move', amountFils: -1, reason: 'Empty drawer withdrawal' })), /POS_INSUFFICIENT_CASH/)

const otherBinding = 'b'.repeat(64)
const otherDevice = (await db.query('select public.pos_enroll_device($1::uuid,$2,$3) as result', [branch, 'Other counter', otherBinding])).rows[0].result
const otherShift = crypto.randomUUID()
await rpc('pos_execute_live_command', command({ type: 'shift.open', deviceId: otherDevice.id, shiftId: otherShift, openingCashFils: 10000 }), otherBinding)
await assert.rejects(rpc('pos_execute_live_command', command({ type: 'cash.move', amountFils: -1, reason: 'Cannot borrow other drawer balance' })), /POS_INSUFFICIENT_CASH/)
const close = await rpc('pos_execute_live_command', command({ type: 'shift.close', countedCashFils: 0 }))
assert.equal(close.expectedCashFils, 0)
assert.deepEqual(await rpc('pos_execute_live_command', withdrawal), { ...first, replayed: true }, 'replay remains available after shift closure')
await assert.rejects(rpc('pos_execute_live_command', command({ type: 'cash.move', amountFils: -1, reason: 'Closed drawer' })), /POS_SHIFT_CLOSED/)
await db.close()
console.log('PASS: cash-out cap uses retained cash, additions, refunds and own shift; exact balance allowed; failed writes atomic; acknowledged replay remains valid after balance change/close. Concurrent sessions still require staging verification.')
