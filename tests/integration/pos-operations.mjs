// Disposable PostgreSQL test; usage matches pos-schema.mjs.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const { PGlite } = await import(pathToFileURL(process.argv[2]).href)
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`)
for (const file of ['20261016000100_pos_platform.sql','20261016000200_pos_operations.sql']) await db.exec(await readFile(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'))
const ids = Array.from({length:9},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`)
const [manager,cashier,admin,org,branch,device,device2,product,orderId] = ids
await db.exec(`insert into auth.users values('${manager}'),('${cashier}'),('${admin}');
insert into public.pos_organizations(id,legal_name) values('${org}','Disposable test');
insert into public.pos_branches(id,organization_id,name) values('${branch}','${org}','Test branch');
insert into public.pos_staff values('${org}','${manager}','${branch}','manager',true),('${org}','${cashier}','${branch}','cashier',true);
insert into public.pos_devices(id,organization_id,branch_id,name) values('${device}','${org}','${branch}','One'),('${device2}','${org}','${branch}','Two');
insert into public.pos_products(id,organization_id,branch_id,name,category,unit_price_fils,tax_rate_bps) values('${product}','${org}','${branch}','Product','Test',1000,0);
insert into public.pos_platform_admins values('${admin}',true);
set role authenticated; set app.user_id='${manager}';`)
const command = data => ({id:crypto.randomUUID(),branchId:branch,...data})
const execute = async data => (await db.query('select public.pos_execute_command($1::jsonb) as result',[JSON.stringify(data)])).rows[0].result
const shiftId=crypto.randomUUID(), shift2=crypto.randomUUID()
const open=command({type:'shift.open',deviceId:device,shiftId,openingCashFils:5000})
assert.equal((await execute(open)).status,'applied')
assert.equal((await execute(open)).replayed,true)
await assert.rejects(execute({...open,openingCashFils:2}),/POS_IDEMPOTENCY_CONFLICT/)
await assert.rejects(execute(command({type:'shift.open',deviceId:device,shiftId:crypto.randomUUID(),openingCashFils:0})),/POS_SHIFT_ALREADY_OPEN/)
await execute(command({type:'shift.open',deviceId:device2,shiftId:shift2,openingCashFils:0}))
const sale={id:orderId,branchId:branch,deviceId:device,shiftId,createdAt:new Date().toISOString(),serviceType:'takeaway',lines:[{productId:product,quantityMilli:1000,expectedUnitPriceFils:1000,expectedTaxRateBps:0}],payments:[{method:'cash',amountFils:600},{method:'card',amountFils:400}],expectedTotalFils:1000}
await db.query('select public.pos_record_paid_order($1::jsonb)',[JSON.stringify(sale)])
const refund=command({type:'refund.create',deviceId:device,shiftId,orderId,method:'cash',amountFils:200,reason:'Customer return'})
await execute(refund)
assert.equal((await execute(refund)).replayed,true)
await assert.rejects(execute(command({...refund,id:crypto.randomUUID(),deviceId:device2,shiftId:shift2,amountFils:401})),/POS_REFUND_LIMIT/)
await execute(command({...refund,id:crypto.randomUUID(),deviceId:device2,shiftId:shift2,amountFils:400}))
await assert.rejects(execute(command({...refund,id:crypto.randomUUID(),amountFils:1})),/POS_REFUND_LIMIT/)
await assert.rejects(execute(command({...refund,id:crypto.randomUUID(),method:'card',amountFils:401})),/POS_REFUND_LIMIT/)
const movement=command({type:'cash.move',deviceId:device,shiftId,amountFils:-100,reason:'Petty cash'})
await execute(movement)
assert.equal((await execute(movement)).replayed,true)
const subscription=command({type:'subscription.update',status:'active',paidThrough:'2026-11-16',reason:'Operator recorded manual collection'})
await assert.rejects(execute(subscription),/POS_ADMIN_REQUIRED/)
await db.exec(`set app.user_id='${cashier}';`)
await assert.rejects(execute(command({...refund,id:crypto.randomUUID()})),/POS_MANAGER_REQUIRED/)
await assert.rejects(execute(command({...movement,id:crypto.randomUUID()})),/POS_MANAGER_REQUIRED/)
await assert.rejects(execute(command({type:'shift.close',deviceId:device,shiftId,countedCashFils:0})),/POS_SHIFT_INVALID/)
await db.exec(`set app.user_id='${manager}';`)
const closed=await execute(command({type:'shift.close',deviceId:device,shiftId,countedCashFils:5290}))
assert.equal(closed.expectedCashFils,5300)
assert.equal(closed.cashDifferenceFils,-10)
assert.equal((await execute(open)).replayed,true,'acknowledged open command replays even after close')
await assert.rejects(execute(command({...movement,id:crypto.randomUUID()})),/POS_SHIFT_CLOSED/)
assert.equal((await db.query('select * from public.pos_refunds')).rows.length,2,'failed/duplicate refunds never insert rows')
await db.exec(`set app.user_id='${admin}';`)
await execute(subscription)
assert.equal((await execute(subscription)).replayed,true)
const sub=(await db.query('select * from public.pos_subscriptions')).rows[0]
assert.equal(sub.price_fils,10000)
assert.equal(sub.collection_method,'manual')
assert.equal(sub.status,'active')
await assert.rejects(db.exec(`update public.pos_subscriptions set status='cancelled'`),/permission denied/)
await db.exec('reset role; set role anon;')
await assert.rejects(db.query('select public.pos_execute_command($1::jsonb)',[JSON.stringify(open)]),/permission denied/)
await db.close()
console.log('PASS: operational SQL executes; shift ownership, duplicate guards, tender-specific refund caps across devices, drawer totals, role denial, manual subscription admin boundary and audit idempotency verified.')
