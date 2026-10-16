// Disposable PostgreSQL verification; pass the installed PGlite entry point as argv[2].
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const { PGlite } = await import(pathToFileURL(process.argv[2]).href)
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`)
for (const file of ['20261016000100_pos_platform.sql','20261016000200_pos_operations.sql','20261016000300_pos_live_documents.sql','20261016000400_pos_online_access.sql','20261016000500_pos_request_recovery.sql','20261016000600_pos_cash_out_balance.sql','20261016000800_pos_catalogue_management.sql','20261016001000_pos_sale_lock_order.sql']) {
 await db.exec(await readFile(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'))
}
const [actor,cashier,org,branch,profile,product,foreignOrg,foreignBranch,foreignProduct] = Array.from({length:9},()=>crypto.randomUUID())
await db.exec(`insert into auth.users values('${actor}'),('${cashier}');
insert into public.pos_organizations(id,legal_name) values('${org}','Synthetic'),('${foreignOrg}','Other synthetic');
insert into public.pos_branches(id,organization_id,name) values('${branch}','${org}','Test'),('${foreignBranch}','${foreignOrg}','Other');
insert into public.pos_staff values('${org}','${actor}','${branch}','manager',true),('${org}','${cashier}','${branch}','cashier',true);
insert into public.pos_merchant_profiles(id,organization_id,branch_id,legal_name,branch_name,address,phone,trn,tax_registered,tax_inclusive,confirmed_by)
values('${profile}','${org}','${branch}','Synthetic','Test','Test address','Test contact','100000000000001',true,true,'${actor}');
insert into public.pos_branch_receipt_config values('${branch}','${org}','${profile}','TEST',true);
insert into public.pos_products(id,organization_id,branch_id,name,category,unit_price_fils,tax_rate_bps) values('${product}','${org}','${branch}','Original item','Test',1000,500),('${foreignProduct}','${foreignOrg}','${foreignBranch}','Other item','Test',1000,500);
set role authenticated; set app.user_id='${actor}';`)
const binding='a'.repeat(64)
const device=(await db.query('select public.pos_enroll_device($1::uuid,$2,$3) as result',[branch,'Test counter',binding])).rows[0].result
const rpc=async(name,value,key=binding)=>(await db.query(`select public.${name}($1::jsonb,$2) as result`,[JSON.stringify(value),key])).rows[0].result
const command=value=>({id:crypto.randomUUID(),branchId:branch,deviceId:device.id,...value})
const shiftId=crypto.randomUUID()
await rpc('pos_execute_live_command',command({type:'shift.open',shiftId,openingCashFils:0}))
const order={id:crypto.randomUUID(),branchId:branch,deviceId:device.id,shiftId,createdAt:new Date().toISOString(),serviceType:'takeaway',lines:[{productId:product,quantityMilli:1000,expectedUnitPriceFils:1000,expectedTaxRateBps:500}],payments:[{method:'cash',amountFils:1000}],expectedTotalFils:1000,profileId:profile,customer:null,cashTenderedFils:1000}
const original=await rpc('pos_record_live_order',order)
const update=command({expectedRevision:1,reason:'Use correct weight unit',product:{id:product,name:'Sweets by weight',category:'Sweets',imageUrl:null,unit:'kg',unitPriceFils:1000,taxRateBps:500,active:true}})
const changed=await rpc('pos_manage_catalogue',update)
assert.equal(changed.product.revision,2)
assert.equal(changed.product.unit,'kg')
assert.deepEqual(await rpc('pos_manage_catalogue',update),{...changed,replayed:true})
await assert.rejects(rpc('pos_manage_catalogue',{...update,reason:'Different payload'}),/POS_IDEMPOTENCY_CONFLICT/)
await assert.rejects(rpc('pos_manage_catalogue',{...update,id:crypto.randomUUID()}),/POS_CATALOGUE_CONFLICT/)
assert.deepEqual(await rpc('pos_record_live_order',order),{...original,replayed:true},'paid original remains replayable after menu edits')
assert.equal(original.receipt.lines[0].name,'Original item')
assert.equal(original.receipt.lines[0].unit,'piece')
await assert.rejects(rpc('pos_record_live_order',{...order,id:crypto.randomUUID()}),/POS_PRICE_CHANGED/,'old client cannot sell changed unit without refreshing')
await assert.rejects(rpc('pos_record_live_order',{...order,id:crypto.randomUUID(),lines:[{...order.lines[0],expectedRevision:1}]}),/POS_PRICE_CHANGED/,'same price with changed unit invalidates basket')
const fresh={...order,id:crypto.randomUUID(),lines:[{...order.lines[0],quantityMilli:250,expectedRevision:2}],payments:[{method:'cash',amountFils:250}],expectedTotalFils:250,cashTenderedFils:250}
const weighted=await rpc('pos_record_live_order',fresh)
assert.equal(weighted.receipt.lines[0].unit,'kg')
assert.equal(weighted.receipt.totals.grossFils,250)
assert.deepEqual(await rpc('pos_record_live_order',fresh),{...weighted,replayed:true})
assert.deepEqual((await db.query('select public.pos_resolve_live_request($1,$2::jsonb,$3) as result',['sale',JSON.stringify(fresh),binding])).rows[0].result,{...weighted,replayed:true})
await assert.rejects(rpc('pos_record_live_order',{...fresh,id:crypto.randomUUID(),lines:[{...fresh.lines[0],extra:1}]}),/POS_INVALID_ORDER/)
await assert.rejects(rpc('pos_record_live_order',{...fresh,id:crypto.randomUUID(),lines:[{...fresh.lines[0],expectedRevision:2.5}]}),/POS_INVALID_ORDER/)
const refund=await rpc('pos_execute_live_command',command({type:'refund.full',shiftId,orderId:order.id,reason:'Original test returned'}))
assert.equal(refund.creditNote.lines[0].name,'Original item')
assert.equal(refund.creditNote.lines[0].unit,'piece')
assert.equal(refund.creditNote.totals.grossFils,1000)
const newItem=command({expectedRevision:0,reason:'Add unavailable item for review',product:{...update.product,id:crypto.randomUUID(),name:'Needs price',unit:'pack',unitPriceFils:0,active:false}})
const created=await rpc('pos_manage_catalogue',newItem)
assert.equal(created.product.revision,1)
assert.equal(created.product.active,false)
assert.deepEqual(await rpc('pos_manage_catalogue',newItem),{...created,replayed:true})
for(const patch of [{active:true},{unitPriceFils:1.5},{unitPriceFils:-1},{taxRateBps:0},{name:''},{unit:'litre'},{imageUrl:'https://evil.example/image.webp'},{imageUrl:'/pos-assets/menu/../secret.webp'},{extra:1}]) {
 await assert.rejects(rpc('pos_manage_catalogue',{...newItem,id:crypto.randomUUID(),product:{...newItem.product,id:crypto.randomUUID(),...patch}}),/POS_INVALID_COMMAND/)
}
await assert.rejects(rpc('pos_manage_catalogue',{...newItem,id:crypto.randomUUID(),extra:1}),/POS_INVALID_COMMAND/)
await assert.rejects(rpc('pos_manage_catalogue',{...newItem,id:crypto.randomUUID(),expectedRevision:0.5}),/POS_INVALID_COMMAND/)
await assert.rejects(rpc('pos_manage_catalogue',{...update,id:crypto.randomUUID(),expectedRevision:2,product:{...update.product,id:foreignProduct}}),/POS_ACCESS_DENIED/)
await assert.rejects(rpc('pos_manage_catalogue',{...update,branchId:foreignBranch}),/POS_DEVICE_INVALID/)
await assert.rejects(rpc('pos_manage_catalogue',update,'b'.repeat(64)),/POS_DEVICE_INVALID/)
await assert.rejects(db.query('select * from public.pos_catalogue_commands'),/permission denied/)
await assert.rejects(db.query('update public.pos_products set unit_price_fils=1'),/permission denied/)
await assert.rejects(db.query('select public.pos_record_live_order_unbound($1::jsonb)',[JSON.stringify(fresh)]),/permission denied/)
await db.exec(`set app.user_id='${cashier}';`)
const cashDevice=(await db.query('select public.pos_enroll_device($1::uuid,$2,$3) as result',[branch,'Cashier counter','c'.repeat(64)])).rows[0].result
await assert.rejects(rpc('pos_manage_catalogue',{...newItem,id:crypto.randomUUID(),deviceId:cashDevice.id},'c'.repeat(64)),/POS_ACCESS_DENIED/)
await db.exec('reset role;')
assert.equal((await db.query('select * from public.pos_catalogue_commands')).rows.length,2)
assert.equal((await db.query("select * from public.pos_audit_events where event_type='catalogue.updated'")).rows.length,2,'retries and rejected writes do not add audit events')
assert.equal((await db.query('select * from public.pos_orders')).rows.length,2,'stale and malformed orders never commit')
assert.equal((await db.query('select * from public.pos_products')).rows.length,3)
await db.exec('set role anon;')
await assert.rejects(rpc('pos_manage_catalogue',update),/permission denied/)
await db.close()
console.log('PASS: catalogue permissions, idempotency, conflicts, validation, tenant/device scope, audit atomicity, changed-unit stale basket rejection, immutable invoice/credit replay and private helper denial. Sequential embedded PostgreSQL; concurrent server test pending.')
