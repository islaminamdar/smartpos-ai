// Disposable PGlite test: node tests/integration/pos-online-access.mjs /path/to/pglite/dist/index.js
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const { PGlite } = await import(pathToFileURL(process.argv[2]).href)
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`)
for (const file of ['20261016000100_pos_platform.sql','20261016000200_pos_operations.sql','20261016000300_pos_live_documents.sql','20261016000400_pos_online_access.sql']) await db.exec(await readFile(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'))
const [actor,other,org,branch,foreignOrg,foreignBranch,profile,product] = Array.from({length:8},()=>crypto.randomUUID())
await db.exec(`insert into auth.users values('${actor}'),('${other}');
insert into public.pos_organizations(id,legal_name) values('${org}','Synthetic'),('${foreignOrg}','Other');
insert into public.pos_branches(id,organization_id,name) values('${branch}','${org}','One'),('${foreignBranch}','${foreignOrg}','Other');
insert into public.pos_staff values('${org}','${actor}','${branch}','manager',true),('${foreignOrg}','${other}','${foreignBranch}','manager',true);
insert into public.pos_merchant_profiles(id,organization_id,branch_id,legal_name,branch_name,address,phone,trn,tax_registered,tax_inclusive,confirmed_by) values('${profile}','${org}','${branch}','Synthetic','One','Test address','Test phone','100000000000001',true,true,'${actor}');
insert into public.pos_branch_receipt_config values('${branch}','${org}','${profile}','TEST',true);
insert into public.pos_products(id,organization_id,branch_id,name,category,unit_price_fils,tax_rate_bps) values('${product}','${org}','${branch}','Sweet','Test',1050,500);
set role authenticated; set app.user_id='${actor}';`)
const binding='a'.repeat(64)
const enroll=(b=branch,key=binding)=>(db.query('select public.pos_enroll_device($1::uuid,$2,$3) as result',[b,'Test counter',key])).then(x=>x.rows[0].result)
const device=await enroll()
assert.deepEqual(await enroll(),device,'same binding enrollment is idempotent')
await assert.rejects(enroll(foreignBranch,'b'.repeat(64)),/POS_ACCESS_DENIED/)
await assert.rejects(db.query('select * from public.pos_device_bindings'),/permission denied/)
await assert.rejects(db.query('select public.pos_login_attempt($1)',[binding]),/permission denied/)
const rpc=(name,value,key=binding)=>db.query(`select public.${name}($1::jsonb,$2) as result`,[JSON.stringify(value),key]).then(x=>x.rows[0].result)
const shift=crypto.randomUUID()
const open={id:crypto.randomUUID(),branchId:branch,type:'shift.open',deviceId:device.id,shiftId:shift,openingCashFils:1000}
await assert.rejects(rpc('pos_execute_live_command',open,'b'.repeat(64)),/POS_DEVICE_INVALID/)
await assert.rejects(db.query('select public.pos_execute_live_command_unbound($1::jsonb)',[JSON.stringify(open)]),/permission denied/)
await rpc('pos_execute_live_command',open)
const order={id:crypto.randomUUID(),branchId:branch,deviceId:device.id,shiftId:shift,createdAt:new Date().toISOString(),serviceType:'takeaway',lines:[{productId:product,quantityMilli:1000,expectedUnitPriceFils:1050,expectedTaxRateBps:500}],payments:[{method:'cash',amountFils:1050}],expectedTotalFils:1050,profileId:profile,customer:null,cashTenderedFils:2000}
await assert.rejects(db.query('select public.pos_record_live_order_unbound($1::jsonb)',[JSON.stringify(order)]),/permission denied/)
const receipt=await rpc('pos_record_live_order',order)
assert.equal(receipt.receipt.documentNumber,'TEST-INV-0000000001')
assert.equal((await rpc('pos_record_live_order',order)).replayed,true)
assert.equal((await db.query('select public.pos_open_shift_summaries() as result')).rows[0].result[0].expectedCashFils,2050)
await db.exec(`set app.user_id='${other}';`)
assert.equal((await db.query('select public.pos_bound_device($1) as result',[binding])).rows[0].result,null)
await assert.rejects(rpc('pos_record_live_order',order),/POS_DEVICE_INVALID/)
assert.deepEqual((await db.query('select public.pos_open_shift_summaries() as result')).rows[0].result,[])
await db.exec('reset role; set role service_role;')
for(let n=0;n<10;n++) assert.equal((await db.query('select public.pos_login_attempt($1) as ok',[binding])).rows[0].ok,true)
assert.equal((await db.query('select public.pos_login_attempt($1) as ok',[binding])).rows[0].ok,false)
await db.exec(`reset role; update public.pos_login_windows set window_started=now()-interval '16 minutes'; set role service_role;`)
assert.equal((await db.query('select public.pos_login_attempt($1) as ok',[binding])).rows[0].ok,true)
console.log('PASS: device enrollment, opaque binding authority, revoked unbound RPCs, cross-user/tenant denial, receipts and drawer summary, service-only atomic rate limiter.')
await db.close()
