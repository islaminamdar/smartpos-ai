// Disposable PostgreSQL; no provider requests, credentials or production data.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const { PGlite } = await import(pathToFileURL(process.argv[2]).href)
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`)
for(const file of ['20261016000100_pos_platform.sql','20261016000200_pos_operations.sql','20261016000700_pos_paypal_subscriptions.sql']) await db.exec(await readFile(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'))
const id=()=>crypto.randomUUID(), [manager,cashier,outsider,org,otherOrg,branch,otherBranch] = Array.from({length:7},id)
await db.exec(`insert into auth.users values('${manager}'),('${cashier}'),('${outsider}');
insert into public.pos_organizations(id,legal_name) values('${org}','Synthetic'),('${otherOrg}','Other');
insert into public.pos_branches(id,organization_id,name) values('${branch}','${org}','One'),('${otherBranch}','${otherOrg}','Other');
insert into public.pos_staff values('${org}','${manager}','${branch}','manager',true),('${org}','${cashier}','${branch}','cashier',true),('${otherOrg}','${outsider}','${otherBranch}','manager',true);`)
const legacyBefore=(await db.query('select * from pos_subscriptions')).rows
const plan='P-ABCDEFGHIJKLMNOPQRSTUVWX', request=id(), lease=id()
const begin=async(actor=manager,b=branch,key=request,token=lease)=>(await db.query('select pos_paypal_begin($1,$2,$3,$4,$5,$6) as result',[b,actor,'sandbox',plan,key,token])).rows[0].result
const reserve=async(sub,token,actor=manager,event=null,digest=null)=>(await db.query('select pos_paypal_reserve($1,$2,$3,$4,$5,$6) as result',[sub,actor,'sandbox',token,event,digest])).rows[0].result
const release=async(sub,token)=>db.query('select pos_paypal_release($1,$2)',[sub,token])
const apply=async(sub,token,snapshot,tx=[],event=null)=>(await db.query('select pos_paypal_apply($1,$2,$3::jsonb,$4::jsonb,$5,$6,true) as result',[sub,token,JSON.stringify(snapshot),JSON.stringify(tx),new Date().toISOString(),event])).rows[0].result
await db.exec('set role service_role')
await assert.rejects(begin(cashier),/PAYPAL_ACCESS_DENIED/)
await assert.rejects(begin(outsider),/PAYPAL_ACCESS_DENIED/)
const first=await begin()
assert.equal(first.price_cents,10000);assert.equal(first.currency,'USD');assert.equal(first.actor_id,manager)
await assert.rejects(begin(),/PAYPAL_BUSY/)
await release(first.id,id());await assert.rejects(begin(),/PAYPAL_BUSY/,'wrong release token cannot unlock lease')
await release(first.id,lease)
assert.equal((await begin(manager,branch,id())).id,first.id,'another checkout request reuses nonterminal branch subscription')
const snapshot={checkoutId:first.id,providerId:'I-ABCDEF123456',planId:plan,status:'ACTIVE',lastPaymentCents:10000}
await assert.rejects(apply(first.id,id(),snapshot),/PAYPAL_LEASE_LOST/)
await assert.rejects(apply(first.id,lease,{...snapshot,checkoutId:id()}),/PAYPAL_SUBSCRIPTION_MISMATCH/)
await assert.rejects(apply(first.id,lease,{...snapshot,providerId:null}),/PAYPAL_SUBSCRIPTION_MISMATCH/)
const tx={id:'TX-ABCDE12345',status:'COMPLETED',amountCents:10000,currency:'USD',time:new Date().toISOString()}
await apply(first.id,lease,snapshot,[tx]);await assert.rejects(apply(first.id,lease,snapshot),/PAYPAL_LEASE_LOST/);await assert.rejects(apply(first.id,null,snapshot),/PAYPAL_LEASE_LOST/)
const secondLease=id();await reserve(first.id,secondLease,null,'EVT-ONE','a'.repeat(64));await apply(first.id,secondLease,snapshot,[tx],'EVT-ONE')
assert.deepEqual(await reserve(first.id,id(),null,'EVT-ONE','a'.repeat(64)),{duplicate:true})
await assert.rejects(reserve(first.id,id(),null,'EVT-ONE','b'.repeat(64)),/PAYPAL_EVENT_CONFLICT/)
assert.equal((await db.query('select * from pos_paypal_transactions')).rows.length,1)
await db.exec(`set role authenticated; set app.user_id='${cashier}'`)
assert.equal((await db.query('select * from pos_paypal_subscriptions')).rows.length,0)
await assert.rejects(begin(),/permission denied/)
await assert.rejects(db.query("update pos_paypal_subscriptions set status='CANCELLED'"),/permission denied/)
await assert.rejects(apply(first.id,lease,snapshot),/permission denied/)
await db.exec(`set app.user_id='${outsider}'`)
assert.equal((await db.query('select * from pos_paypal_subscriptions')).rows.length,0)
await db.exec(`set app.user_id='${manager}'`)
assert.equal((await db.query('select * from pos_paypal_subscriptions')).rows.length,1)
assert.equal((await db.query('select * from pos_paypal_transactions')).rows.length,1)
await db.exec('set role service_role')
const endLease=id();await reserve(first.id,endLease);await apply(first.id,endLease,{...snapshot,status:'CANCELLED'})
const stale=id();await reserve(first.id,stale);await assert.rejects(apply(first.id,stale,snapshot),/PAYPAL_TERMINAL_STATE_CONFLICT/);await release(first.id,stale)
const freshLease=id();const fresh=await begin(manager,branch,id(),freshLease);assert.notEqual(fresh.id,first.id)
await assert.rejects(apply(fresh.id,freshLease,{...snapshot,checkoutId:fresh.id,providerId:'I-ZYXWVU123456'},[tx]),/PAYPAL_TRANSACTION_CONFLICT/)
await release(fresh.id,freshLease)
await db.exec(`reset role; update pos_paypal_subscriptions set created_at=now()-interval '71 hours' where id='${fresh.id}'; set role service_role;`)
await assert.rejects(begin(manager,branch,id(),id()),/PAYPAL_MANUAL_RECONCILIATION_REQUIRED/)
await db.exec('reset role')
assert.deepEqual((await db.query('select * from pos_subscriptions')).rows,legacyBefore,'legacy AED rows untouched')
await db.close()
console.log('PASS: branch/role isolation, service-only mutation, duplicate checkout/event/payment protection, lease fencing, cancellation terminal protection, uncertain-create retention boundary, existing AED preservation. Multi-session races and real PayPal sandbox roundtrip remain staging gates.')
