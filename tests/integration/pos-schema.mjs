// Run against a disposable embedded PostgreSQL engine, never a production database:
// npm install --prefix /tmp/smartpos-sql-validation --no-save @electric-sql/pglite
// node tests/integration/pos-schema.mjs /tmp/smartpos-sql-validation/node_modules/@electric-sql/pglite/dist/index.js
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const { PGlite } = await import(pathToFileURL(process.argv[2]).href)
const db = new PGlite()
await db.exec(`create role anon; create role authenticated;
create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`)
await db.exec(await readFile(new URL('../../supabase/migrations/20261016000100_pos_platform.sql', import.meta.url), 'utf8'))
const ids = Array.from({length:12},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`)
const [userA,userB,orgA,orgB,branchA,branchB,deviceA,deviceB,shiftA,shiftB,productA,productB] = ids
await db.exec(`insert into auth.users values ('${userA}'),('${userB}');
insert into public.pos_organizations(id,legal_name) values('${orgA}','Test A'),('${orgB}','Test B');
insert into public.pos_branches(id,organization_id,name) values('${branchA}','${orgA}','Branch A'),('${branchB}','${orgB}','Branch B');
insert into public.pos_staff values('${orgA}','${userA}','${branchA}','cashier',true),('${orgB}','${userB}','${branchB}','cashier',true);
insert into public.pos_devices(id,organization_id,branch_id,name) values('${deviceA}','${orgA}','${branchA}','A'),('${deviceB}','${orgB}','${branchB}','B');
insert into public.pos_shifts(id,organization_id,branch_id,device_id,opened_by,opening_cash_fils) values('${shiftA}','${orgA}','${branchA}','${deviceA}','${userA}',0),('${shiftB}','${orgB}','${branchB}','${deviceB}','${userB}',0);
insert into public.pos_products(id,organization_id,branch_id,name,category,unit,unit_price_fils,tax_rate_bps) values('${productA}','${orgA}','${branchA}','Test product','Sweets','kg',1050,500),('${productB}','${orgB}','${branchB}','Other product','Sweets','piece',100,0);
insert into public.pos_branches(id,organization_id,name) values('20000000-0000-4000-8000-000000000001','${orgA}','Other branch in A');
set role authenticated; set app.user_id = '${userA}';`)
assert.equal((await db.query('select * from public.pos_products')).rows.length,1,'RLS hides other tenant products')
assert.equal((await db.query('select * from public.pos_branches')).rows.length,1,'RLS hides other tenant branches')
const order = {id:'10000000-0000-4000-8000-000000000001',branchId:branchA,deviceId:deviceA,shiftId:shiftA,createdAt:new Date().toISOString(),serviceType:'takeaway',lines:[{productId:productA,quantityMilli:1500,expectedUnitPriceFils:1050,expectedTaxRateBps:500}],payments:[{method:'cash',amountFils:1575}],expectedTotalFils:1575}
const sync = async value => (await db.query('select public.pos_record_paid_order($1::jsonb) as result',[JSON.stringify(value)])).rows[0].result
const first = await sync(order)
assert.equal(first.totalFils,1575); assert.equal(first.taxFils,75); assert.equal(first.replayed,false)
assert.equal((await sync(order)).replayed,true,'identical retry is acknowledged without insertion')
await assert.rejects(sync({...order,expectedTotalFils:1}),/POS_IDEMPOTENCY_CONFLICT/)
const fresh = changes => ({...order,id:crypto.randomUUID(),...changes})
await assert.rejects(sync(fresh({branchId:branchB,deviceId:deviceB,shiftId:shiftB})),/POS_ACCESS_DENIED/)
await assert.rejects(sync(fresh({deviceId:deviceB})),/POS_DEVICE_INVALID/)
await assert.rejects(sync(fresh({lines:[{...order.lines[0],expectedUnitPriceFils:1}]})),/POS_PRICE_CHANGED/)
await assert.rejects(sync(fresh({expectedTotalFils:1})),/POS_TOTAL_MISMATCH/)
await assert.rejects(sync(fresh({payments:[{method:'cash',amountFils:1}]})),/POS_PAYMENT_MISMATCH/)
await assert.rejects(sync(fresh({lines:[{...order.lines[0],productId:productB}]})),/POS_PRODUCT_UNAVAILABLE/)
await assert.rejects(sync(fresh({discountFils:100})),/POS_INVALID_ORDER/)
await assert.rejects(sync(fresh({expectedTotalFils:null})),/POS_INVALID_ORDER/)
await assert.rejects(sync(fresh({branchId:'20000000-0000-4000-8000-000000000001'})),/POS_ACCESS_DENIED/)
await assert.rejects(sync(fresh({lines:[{...order.lines[0],quantityMilli:-1}]})),/POS_INVALID_ORDER/)
assert.equal((await db.query('select * from public.pos_orders')).rows.length,1,'rejected sales have no financial side effects')
assert.equal((await db.query('select * from public.pos_payments')).rows.length,1)
await assert.rejects(db.exec(`delete from public.pos_orders`),/permission denied/)
await db.exec(`reset role; update public.pos_shifts set status='closed',closed_at=now() where id='${shiftA}'; set role authenticated;`)
assert.equal((await sync(order)).replayed,true,'a committed retry remains recoverable after shift closure')
await assert.rejects(sync(fresh({})),/POS_SHIFT_CLOSED/)
await db.exec(`set app.user_id = '${userB}';`)
assert.equal((await db.query('select * from public.pos_orders')).rows.length,0,'other tenant cannot read sale')
await db.exec('reset role; set role anon;')
await assert.rejects(db.query('select public.pos_record_paid_order($1::jsonb)',[JSON.stringify(order)]),/permission denied/)
await db.close()
console.log('PASS: schema executes; RLS, atomic writes, rounding, idempotency, tenant/device protection, stale pricing, validation and shift locking verified in isolated PostgreSQL.')
