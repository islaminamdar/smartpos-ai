// Disposable PostgreSQL only; same Node/PGlite invocation as pos-documents.mjs.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const { PGlite } = await import(pathToFileURL(process.argv[2]).href)
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`)
for (const file of ['20261016000100_pos_platform.sql', '20261016000200_pos_operations.sql', '20261016000300_pos_live_documents.sql', '20261016000400_pos_online_access.sql', '20261016000500_pos_request_recovery.sql']) {
  await db.exec(await readFile(new URL('../../supabase/migrations/' + file, import.meta.url), 'utf8'))
}
const [actor, other, org, branch, profile, product] = Array.from({ length: 6 }, () => crypto.randomUUID())
await db.exec(`insert into auth.users values('${actor}'),('${other}');
insert into public.pos_organizations(id,legal_name) values('${org}','Synthetic');
insert into public.pos_branches(id,organization_id,name) values('${branch}','${org}','Test branch');
insert into public.pos_staff values('${org}','${actor}','${branch}','manager',true),('${org}','${other}','${branch}','manager',true);
insert into public.pos_merchant_profiles(id,organization_id,branch_id,legal_name,branch_name,address,phone,trn,tax_registered,tax_inclusive,confirmed_by)
values('${profile}','${org}','${branch}','Synthetic merchant','Test branch','Test address','Test contact','100000000000001',true,true,'${actor}');
insert into public.pos_branch_receipt_config values('${branch}','${org}','${profile}','TEST',true);
insert into public.pos_products(id,organization_id,branch_id,name,category,unit_price_fils,tax_rate_bps) values('${product}','${org}','${branch}','Test item','Test',1050,500);
set role authenticated; set app.user_id='${actor}';`)
const binding = 'a'.repeat(64)
const device = (await db.query('select public.pos_enroll_device($1::uuid,$2,$3) as result', [branch, 'Test counter', binding])).rows[0].result
const rpc = async (name, value, key = binding) => (await db.query(`select public.${name}($1::jsonb,$2) as result`, [JSON.stringify(value), key])).rows[0].result
const resolve = async (kind, value, key = binding) => (await db.query('select public.pos_resolve_live_request($1,$2::jsonb,$3) as result', [kind, JSON.stringify(value), key])).rows[0].result
const command = value => ({ id: crypto.randomUUID(), branchId: branch, deviceId: device.id, ...value })
const shiftId = crypto.randomUUID()
const open = command({ type: 'shift.open', shiftId, openingCashFils: 1000 })
const opened = await rpc('pos_execute_live_command', open)
assert.deepEqual(await resolve('command', open), { ...opened, replayed: true }, 'lost shift acknowledgement returns the committed result')
const order = { id: crypto.randomUUID(), branchId: branch, deviceId: device.id, shiftId, createdAt: new Date().toISOString(), serviceType: 'takeaway', lines: [{ productId: product, quantityMilli: 1000, expectedUnitPriceFils: 1050, expectedTaxRateBps: 500 }], payments: [{ method: 'cash', amountFils: 1050 }], expectedTotalFils: 1050, profileId: profile, customer: null, cashTenderedFils: 2000 }
const paid = await rpc('pos_record_live_order', order)
assert.deepEqual(await resolve('sale', order), { ...paid, replayed: true }, 'already paid is never labelled cancelled')
await assert.rejects(resolve('sale', { ...order, cashTenderedFils: 2001 }), /POS_IDEMPOTENCY_CONFLICT/)

const rejected = { ...order, id: crypto.randomUUID(), lines: [{ ...order.lines[0], expectedUnitPriceFils: 1 }] }
await assert.rejects(rpc('pos_record_live_order', rejected), /POS_PRICE_CHANGED/)
assert.deepEqual(await resolve('sale', rejected), { status: 'cancelled', requestId: rejected.id, kind: 'sale', replayed: false })
assert.equal((await resolve('sale', rejected)).replayed, true)
await assert.rejects(rpc('pos_record_live_order', rejected), /POS_REQUEST_CANCELLED/)
await assert.rejects(rpc('pos_record_live_order', { ...rejected, lines: order.lines }), /POS_IDEMPOTENCY_CONFLICT/, 'cancelled operation cannot be reused with corrected prices')
await assert.rejects(resolve('sale', { ...rejected, lines: order.lines }), /POS_IDEMPOTENCY_CONFLICT/)
const delayed = { ...order, id: crypto.randomUUID().toUpperCase() }
await resolve('sale', delayed)
await assert.rejects(rpc('pos_record_live_order', delayed), /POS_REQUEST_CANCELLED/, 'cancel-before-send prevents delayed commit')
const cash = command({ type: 'cash.move', shiftId, amountFils: -100, reason: 'Test cancellation' })
await resolve('command', cash)
await assert.rejects(rpc('pos_execute_live_command', cash), /POS_REQUEST_CANCELLED/)
assert.equal((await db.query('select * from public.pos_cash_movements')).rows.length, 0)
await assert.rejects(resolve('command', { ...cash, amountFils: -101 }), /POS_IDEMPOTENCY_CONFLICT/)
await assert.rejects(resolve('wrong-kind', order), /POS_INVALID_REQUEST/)
await assert.rejects(resolve('sale', { ...order, id: 'invalid' }), /POS_INVALID_REQUEST/)
await assert.rejects(resolve('sale', order, 'b'.repeat(64)), /POS_DEVICE_INVALID/)
await assert.rejects(db.query('select public.pos_record_live_order_before_recovery($1::jsonb,$2)', [JSON.stringify(order), binding]), /permission denied/)
await assert.rejects(db.query('select public.pos_execute_live_command_before_recovery($1::jsonb,$2)', [JSON.stringify(open), binding]), /permission denied/)
await assert.rejects(db.query('select public.pos_recovery_scope($1::jsonb,$2)', [JSON.stringify(order), binding]), /permission denied/)
await assert.rejects(db.query('select * from public.pos_request_cancellations'), /permission denied/)
const next = await rpc('pos_record_live_order', { ...order, id: crypto.randomUUID() })
assert.equal(next.receipt.documentNumber, 'TEST-INV-0000000002', 'cancellations create no invoices or consume numbers')

const refund = command({ type: 'refund.full', shiftId, orderId: order.id, reason: 'Full test return' })
const returned = await rpc('pos_execute_live_command', refund)
assert.deepEqual(await resolve('command', refund), { ...returned, replayed: true }, 'lost refund acknowledgement returns the same credit note')
const duplicateRefund = { ...refund, id: crypto.randomUUID() }
await assert.rejects(rpc('pos_execute_live_command', duplicateRefund), /POS_PRIOR_REFUND_EXISTS/)
assert.equal((await resolve('command', duplicateRefund)).status, 'cancelled')
await assert.rejects(rpc('pos_execute_live_command', duplicateRefund), /POS_REQUEST_CANCELLED/)
assert.equal((await db.query('select * from public.pos_refunds')).rows.length, 1)

// Disabled selling must not prevent recovering an acknowledgement or cancelling an unsaved request.
await db.exec(`reset role; update public.pos_branch_receipt_config set live_enabled=false where branch_id='${branch}'; set role authenticated;`)
assert.deepEqual(await resolve('sale', order), { ...paid, replayed: true })
assert.equal((await resolve('sale', { ...order, id: crypto.randomUUID() })).status, 'cancelled')
await db.exec(`set app.user_id='${other}';`)
await assert.rejects(resolve('sale', order), /POS_DEVICE_INVALID/)
const otherBinding = 'b'.repeat(64)
const otherDevice = (await db.query('select public.pos_enroll_device($1::uuid,$2,$3) as result', [branch, 'Other counter', otherBinding])).rows[0].result
await assert.rejects(resolve('sale', { ...order, deviceId: otherDevice.id }, otherBinding), /POS_IDEMPOTENCY_CONFLICT/)
await assert.rejects(resolve('sale', { ...rejected, deviceId: otherDevice.id }, otherBinding), /POS_IDEMPOTENCY_CONFLICT/)
await db.exec('reset role;')
assert.equal((await db.query('select * from public.pos_orders')).rows.length, 2, 'recovery preserves financial originals')
await assert.rejects(db.exec('delete from public.pos_request_cancellations'), /POS_IMMUTABLE_DOCUMENT/)
await db.exec('set role anon;')
await assert.rejects(resolve('sale', order), /permission denied/)
await db.close()
console.log('PASS: committed ACK recovery, cancellation idempotency, delayed-sale/command denial, payload/actor/device guards, private-wrapper bypass denial, refund recovery and preserved financial originals. Embedded sequential verification; concurrent staging test still required.')
