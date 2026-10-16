// Disposable embedded PostgreSQL only. No network, real merchant, signatures or provider calls.
// RPCs are invoked as service_role, whose application caller independently verifies signatures.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
const { PGlite } = await import(pathToFileURL(process.argv[2]).href)
const db = new PGlite()
process.on('uncaughtException', error => { console.error(error.message, error.where ?? ''); process.exit(1) })
await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`)
for (const f of (await readdir(new URL('../../supabase/migrations/', import.meta.url))).filter(f => /^20261016/.test(f) && !f.includes('007') && !f.includes('009')).sort())
 await db.exec(await readFile(new URL('../../supabase/migrations/' + f, import.meta.url), 'utf8'))
const scalar = async (sql, params=[]) => Object.values((await db.query(sql, params)).rows[0])[0]
const admin = async fn => { await db.exec('reset role'); try { return await fn() } finally { await db.exec('set role service_role') } }
let checks=0
const check=(actual, expected, message) => { assert.deepEqual(actual,expected,message);checks++ }
const rejects=async(p,pattern) => { await assert.rejects(p,pattern);checks++ }
const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => JSON.stringify(value && typeof value==='object' ? Array.isArray(value) ? value.map(v=>JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])) : value)
const envelope = (payload,keyId='synthetic-server-key',signature='AQ') => ({format:'pos-signed-v1',alg:'ECDSA-P256-SHA256-DER',keyId,payloadBase64Url:Buffer.from(canonical(payload)).toString('base64url'),signatureBase64Url:signature})
const decode = e => JSON.parse(Buffer.from(e.payloadBase64Url,'base64url').toString())
const eh = e => hash(Buffer.from(e.payloadBase64Url,'base64url'))
const rpc=(name,...args) => scalar(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})`,args.map(x=>x!==null && typeof x==='object'?JSON.stringify(x):x))
const ids=Object.fromEntries(['owner','cashier','org','branch','branch2','profile','product','device','device2','shift','shift2'].map(k=>[k,randomUUID()]))
const {owner,cashier,org,branch,branch2,profile,product,device,device2,shift,shift2}=ids
const weightedProduct=randomUUID()
await db.exec(`insert into auth.users(id,email,email_confirmed_at) values('${owner}','synthetic-owner@example.test',now()),('${cashier}','synthetic-cashier@example.test',now());
 insert into public.pos_organizations values('${org}','Synthetic offline',now());
 insert into public.pos_branches(id,organization_id,name) values('${branch}','${org}','Synthetic first'),('${branch2}','${org}','Synthetic second');
 insert into public.pos_staff(organization_id,user_id,branch_id,role) values('${org}','${owner}',null,'owner'),('${org}','${cashier}','${branch}','cashier');
 insert into public.pos_devices(id,organization_id,branch_id,name) values('${device}','${org}','${branch}','Synthetic till 1'),('${device2}','${org}','${branch}','Synthetic till 2');
 insert into public.pos_shifts(id,organization_id,branch_id,device_id,opened_by,opening_cash_fils) values('${shift}','${org}','${branch}','${device}','${owner}',0),('${shift2}','${org}','${branch}','${device2}','${owner}',0);
 insert into public.pos_merchant_profiles(id,organization_id,branch_id,legal_name,branch_name,address,phone,trn,tax_registered,tax_inclusive,confirmed_by) values('${profile}','${org}','${branch}','Synthetic legal','First','Synthetic address','Synthetic phone','100000000000001',true,true,'${owner}');
 insert into public.pos_branch_receipt_config values('${branch}','${org}','${profile}','TEST',true);
 insert into public.pos_products(id,organization_id,branch_id,name,category,unit_price_fils,tax_rate_bps) values('${product}','${org}','${branch}','Synthetic product','Test',1000,500);
 insert into public.pos_products(id,organization_id,branch_id,name,category,unit,unit_price_fils,tax_rate_bps) values('${weightedProduct}','${org}','${branch}','Synthetic weighted','Test','kg',1001,500);`)
const makeEnroll=(deviceId=device,key='synthetic-public-key-1',actor=owner,at=new Date().toISOString()) => {
 const requestId=randomUUID(),publicKeySpki=Buffer.from(key).toString('base64url'),deviceKeySha256=hash(Buffer.from(key))
 return {requestId,branchId:branch,deviceId,publicKeySpki,deviceKeySha256,proof:envelope({kind:'offline-enrollment',schemaVersion:1,requestId,branchId:branch,deviceId,actorId:actor,deviceKeySha256,issuedAt:at},deviceKeySha256)}
}
const enrollRequest=makeEnroll()
await db.exec('set role service_role')
await rejects(rpc('pos_offline_enroll',owner,enrollRequest),/POS_OFFLINE_DISABLED/)
await admin(()=>db.query('insert into public.pos_offline_branch_policy(branch_id,enabled) values($1,true)',[branch]))
await rejects(rpc('pos_offline_enroll',cashier,makeEnroll(device,'cashier-key',cashier)),/POS_ACCESS_DENIED/)
await rejects(rpc('pos_offline_enroll',owner,makeEnroll(device,'expired-key',owner,new Date(Date.now()-600000).toISOString())),/POS_OFFLINE_PROOF_EXPIRED/)
const epoch=await rpc('pos_offline_enroll',owner,enrollRequest)
check(epoch.deviceKeySha256,enrollRequest.deviceKeySha256)
check(await rpc('pos_offline_enroll',owner,enrollRequest),epoch)
check(await rpc('pos_offline_enroll',owner,{...enrollRequest,proof:{...enrollRequest.proof,signatureBase64Url:'Ag'}}),epoch,'different ECDSA signature does not rebind an identical enrollment')
await rejects(rpc('pos_offline_enroll',owner,makeEnroll()),/POS_OFFLINE_KEY_ALREADY_BOUND/)
await rejects(rpc('pos_offline_enroll',owner,makeEnroll(device2,'synthetic-public-key-1')),/POS_OFFLINE_KEY_ALREADY_BOUND/)
const enroll2=makeEnroll(device2,'synthetic-public-key-2'),epoch2=await rpc('pos_offline_enroll',owner,enroll2)
const reserveRequest=(extra={})=>({requestId:randomUUID(),branchId:branch,deviceId:device,shiftId:shift,count:3,lifetimeSeconds:3600,maxInvoiceTotalFils:100000,maxGrossFils:300000,permissions:{cash:true,recordedCard:true,mixedTender:true},...extra})
const request=reserveRequest(),draft=await rpc('pos_offline_reserve',owner,request)
check(draft.authority.invoiceRange,{prefix:'TEST',first:1,last:3})
check(draft.authority.snapshotSha256,null)
check(draft.snapshot.products.find(p=>p.id===product).unitPriceFils,1000)
check(await rpc('pos_offline_reserve',owner,request),draft)
await rejects(rpc('pos_offline_reserve',owner,{...request,count:2}),/POS_IDEMPOTENCY_CONFLICT/)
await rejects(rpc('pos_offline_reserve',owner,reserveRequest()),/POS_OFFLINE_UNSEALED_AUTHORITY/)
await rejects(rpc('pos_offline_reserve',owner,reserveRequest({count:101})),/POS_OFFLINE_POLICY_LIMIT/)
const attach=async draft=>{
 const se=envelope(draft.snapshot),ae=envelope({...draft.authority,snapshotSha256:eh(se)})
 return rpc('pos_offline_attach',draft.authority.id,se,ae)
}
const bundle=await attach(draft)
check(await rpc('pos_offline_authority',request.requestId),bundle)
check(await rpc('pos_offline_attach',request.requestId,{...bundle.snapshotEnvelope,signatureBase64Url:'Ag'},{...bundle.authorityEnvelope,signatureBase64Url:'Aw'}),bundle)
await rejects(rpc('pos_offline_attach',request.requestId,envelope({...draft.snapshot,offers:[{}]}),bundle.authorityEnvelope),/POS_OFFLINE_BUNDLE_CHANGED/)
const otherRequest=reserveRequest({deviceId:device2,shiftId:shift2}),otherDraft=await rpc('pos_offline_reserve',owner,otherRequest),otherBundle=await attach(otherDraft)
check(otherDraft.authority.invoiceRange,{prefix:'TEST',first:4,last:6})
check(await admin(()=>scalar('select public.pos_allocate_document_number($1,$2)',[branch,'tax_invoice'])),'TEST-INV-0000000007','online allocation skips both reserved blocks')
await rejects(admin(()=>db.query("update public.pos_shifts set status='closed',closed_at=now() where id=$1",[shift])),/POS_OFFLINE_CHAIN_INCOMPLETE/)
const sale=(bundle,extra={})=>{
 const a=bundle.authority,id=randomUUID(),issuedAt=a.issuedAt
 const d={schemaVersion:1,id:randomUUID(),kind:'tax_invoice',documentNumber:`${a.invoiceRange.prefix}-INV-${String(a.invoiceRange.first).padStart(10,'0')}`,issuedAt,merchant:bundle.snapshot.profile,orderId:id,branchId:a.branchId,deviceId:a.deviceId,shiftId:a.shiftId,actorId:a.actorId,serviceType:'takeaway',customer:null,
 lines:[{lineNumber:1,productId:product,name:'Synthetic product',unit:'piece',quantityMilli:1000,unitPriceFils:1000,taxRateBps:500,grossFils:1000,netFils:952,taxFils:48}],totals:{grossFils:1000,netFils:952,taxFils:48},payments:[{method:'cash',amountFils:1000}],paymentSettlement:'recorded',cashTenderedFils:1500,changeFils:500}
 return {kind:'offline-sale',schemaVersion:1,id,authorityId:a.id,authoritySha256:bundle.authoritySha256,snapshotSha256:bundle.snapshotSha256,deviceSequence:1,previousEventSha256:null,document:d,clock:{estimatedServerAt:issuedAt,bootId:randomUUID(),elapsedRealtimeMs:1234},paymentIntentId:randomUUID(),...extra}
}
const importSale=async(p,b=bundle,signature='AQ',ackExtra={})=>{
 const signed=envelope(p,b.authority.deviceKeySha256,signature),ack=envelope({kind:'offline-ack',schemaVersion:1,id:randomUUID(),issuanceId:p.id,payloadSha256:eh(signed),authorityId:b.authority.id,keyEpoch:b.keyEpoch,deviceSequence:p.deviceSequence,receivedAt:new Date().toISOString(),...ackExtra})
 return {result:await rpc('pos_offline_import',b.authority.id,signed,ack),signed,ack}
}
// Historical evidence remains valid after membership removal, catalogue edits and pause.
await admin(()=>db.exec(`update public.pos_staff set active=false where user_id='${owner}';update public.pos_products set unit_price_fils=2500,active=false,revision=2 where id='${product}';update public.pos_offline_branch_policy set enabled=false where branch_id='${branch}';update public.pos_devices set active=false where id='${device}';`))
const first=sale(bundle),accepted=await importSale(first)
check(accepted.result.status,'accepted');check(accepted.result.replayed,false);check(accepted.result.receipt,first.document);check(accepted.result.acknowledgement,accepted.ack)
const replay=await importSale(first,bundle,'Ag')
check(replay.result.acknowledgement,accepted.ack);check(replay.result.replayed,true)
check(await admin(()=>scalar('select count(*)::int from public.pos_documents')),1)
check(await admin(()=>scalar('select count(*)::int from public.pos_kitchen_tickets')),0)
check(await admin(()=>scalar('select count(*)::int from public.pos_tab_kitchen_tickets')),0)
check(await admin(()=>scalar('select total_fils from public.pos_orders where id=$1',[first.id])),1000)
for (const table of ['pos_offline_receipts','pos_offline_signed_bundles','pos_documents','pos_orders','pos_order_lines','pos_payments']) {
 await rejects(admin(()=>db.exec(`delete from public.${table}`)),/POS_IMMUTABLE/)
}
await rejects(admin(()=>db.exec("update public.pos_offline_authorities set snapshot='{}'")),/POS_IMMUTABLE/)
const second=sale(bundle,{deviceSequence:2,previousEventSha256:eh(accepted.signed)})
second.document.documentNumber='TEST-INV-0000000002'
const invalid=structuredClone(second);invalid.document.totals.grossFils=999
const rejected=await importSale(invalid)
check(rejected.result.status,'reconciliation_required');check(rejected.result.code,'calculation')
check((await importSale(invalid,bundle,'Ag')).result,rejected.result,'same anomalous payload returns original exception even with a new signature')
check(await admin(()=>scalar('select count(*)::int from public.pos_orders')),1,'invalid import leaves no partial ledger writes')
const secondAccepted=await importSale(second)
check(secondAccepted.result.status,'accepted','quarantine still accepts valid historical custody')
const seal=(b,seq,h,id=randomUUID())=>({kind:'offline-seal',schemaVersion:1,id,authorityId:b.authority.id,keyEpoch:b.keyEpoch,deviceId:b.deviceId,finalSequence:seq,finalEventSha256:h})
await rejects(rpc('pos_offline_seal',bundle.authority.id,3,eh(secondAccepted.signed),envelope(seal(bundle,3,eh(secondAccepted.signed)),bundle.authority.deviceKeySha256)),/POS_OFFLINE_CHAIN_INCOMPLETE/)
const s=seal(bundle,2,eh(secondAccepted.signed)),se=envelope(s,bundle.authority.deviceKeySha256)
check((await rpc('pos_offline_seal',bundle.authority.id,2,eh(secondAccepted.signed),se)).status,'sealed')
check((await rpc('pos_offline_seal',bundle.authority.id,2,eh(secondAccepted.signed),{...se,signatureBase64Url:'Ag'})).status,'sealed')
check((await importSale(first)).result.replayed,true,'receipt retries remain recoverable after seal')
await rejects(admin(()=>db.query("update public.pos_shifts set status='closed',closed_at=now() where id=$1",[shift])),/POS_OFFLINE_CHAIN_INCOMPLETE/)
const unusedSeal=seal(otherBundle,0,null)
await rpc('pos_offline_seal',otherBundle.authority.id,0,null,envelope(unusedSeal,otherBundle.authority.deviceKeySha256))
await admin(()=>db.exec(`update public.pos_staff set active=true where user_id='${owner}';update public.pos_products set unit_price_fils=1000,active=true where id='${product}';update public.pos_offline_branch_policy set enabled=true where branch_id='${branch}';`))
const nextOtherRequest=reserveRequest({deviceId:device2,shiftId:shift2}),nextOther=await rpc('pos_offline_reserve',owner,nextOtherRequest)
check(nextOther.authority.invoiceRange.first,8,'sealed unused numbers never recycled')
check(await rpc('pos_offline_reserve',owner,otherRequest),otherDraft,'old reservation retry after seal is immutable')
const nextBundle=await attach(nextOther)
const differentEpochSale=sale(nextBundle),wrongHashAck=await importSale(differentEpochSale,nextBundle,'AQ',{payloadSha256:'f'.repeat(64)})
check(wrongHashAck.result.code,'ack')
check(await admin(()=>scalar('select count(*)::int from public.pos_documents')),2)
const expiry=sale(nextBundle)
expiry.document.issuedAt=nextBundle.authority.expiresAt;expiry.clock.estimatedServerAt=expiry.document.issuedAt
check((await importSale(expiry,nextBundle)).result.code,'time','expiry equality is forbidden')
// Historical rejected payload is retained; no fiscal ACK is manufactured.
const bad=envelope({kind:'offline-sale',authorityId:nextBundle.authority.id},nextBundle.authority.deviceKeySha256)
check((await rpc('pos_offline_reject',nextBundle.authority.id,bad,'invalid_historical_receipt')).status,'reconciliation_required')
await rejects(rpc('pos_offline_reject',nextBundle.authority.id,bad,'arbitrary'),/POS_OFFLINE_INVALID_REQUEST/)
// Separate clean epoch: out-of-order network arrivals resolve ONLY their matching
// gap evidence after the exact signed payload gains committed fiscal custody.
const thirdDevice=randomUUID(),thirdShift=randomUUID()
await admin(()=>db.query(`insert into public.pos_devices(id,organization_id,branch_id,name) values($1,$2,$3,'Synthetic till 3');`,[thirdDevice,org,branch]))
await admin(()=>db.query(`insert into public.pos_shifts(id,organization_id,branch_id,device_id,opened_by,opening_cash_fils) values($1,$2,$3,$4,$5,0)`,[thirdShift,org,branch,thirdDevice,owner]))
await rpc('pos_offline_enroll',owner,makeEnroll(thirdDevice,'synthetic-public-key-3'))
const thirdRequest=reserveRequest({deviceId:thirdDevice,shiftId:thirdShift}),thirdBundle=await attach(await rpc('pos_offline_reserve',owner,thirdRequest))
const one=sale(thirdBundle),oneSigned=envelope(one,thirdBundle.authority.deviceKeySha256),two=sale(thirdBundle,{deviceSequence:2,previousEventSha256:eh(oneSigned)})
two.document.documentNumber=two.document.documentNumber.slice(0,-10)+String(thirdBundle.authority.invoiceRange.first+1).padStart(10,'0')
two.document.lines=[{lineNumber:1,productId:weightedProduct,name:'Synthetic weighted',unit:'kg',quantityMilli:500,unitPriceFils:1001,taxRateBps:500,grossFils:501,netFils:477,taxFils:24}]
two.document.totals={grossFils:501,netFils:477,taxFils:24}
two.document.payments=[{method:'cash',amountFils:250},{method:'card',amountFils:251}]
two.document.cashTenderedFils=300;two.document.changeFils=50
const gap=await importSale(two,thirdBundle)
check(gap.result.code,'chain');check((await importSale(two,thirdBundle,'Ag')).result,gap.result)
check((await importSale(one,thirdBundle)).result.status,'accepted')
check(await admin(()=>scalar('select blocked from public.pos_offline_key_epochs where id=$1',[thirdBundle.keyEpoch])),true,'unrelated earlier receipt does not clear gap')
const twoAccepted=await importSale(two,thirdBundle)
check(twoAccepted.result.status,'accepted')
check(twoAccepted.result.receipt.totals,{grossFils:501,netFils:477,taxFils:24},'weighted half-fils and mixed tender retain native calculation')
check(await admin(()=>scalar('select blocked from public.pos_offline_key_epochs where id=$1',[thirdBundle.keyEpoch])),false,'same signed receipt resolves its own gap')
check(await admin(()=>scalar('select count(*)::int from public.pos_offline_exception_resolutions where exception_id=$1',[gap.result.exceptionId])),1)
check(await admin(()=>scalar('select count(*)::int from public.pos_offline_exceptions where id=$1',[gap.result.exceptionId])),1,'original exception evidence is retained')
const thirdSeal=seal(thirdBundle,2,eh(twoAccepted.signed)),thirdSe=envelope(thirdSeal,thirdBundle.authority.deviceKeySha256)
const thirdSealResult=await rpc('pos_offline_seal',thirdBundle.authority.id,2,eh(twoAccepted.signed),thirdSe)
await admin(()=>db.query("update public.pos_shifts set status='closed',closed_at=now() where id=$1",[thirdShift]))
check(await admin(()=>scalar('select status from public.pos_shifts where id=$1',[thirdShift])),'closed','resolved gap no longer blocks drawer close')
const source='a'.repeat(64)
const rateResults=[];for(let i=0;i<600;i++) rateResults.push(await rpc('pos_offline_limit',source))
check(rateResults.every(Boolean),true,'600 allowed requests in the same source window')
check(await rpc('pos_offline_limit',source),false);check(await rpc('pos_offline_limit','bad'),false)
await admin(()=>db.query("update public.pos_offline_source_windows set window_started=now()-interval '2 minutes' where source=$1",[source]))
check(await rpc('pos_offline_limit',source),true)
// Privileges, not hidden URLs, form the trusted JSON boundary.
await db.exec('reset role')
const functions=(await db.query("select p.oid::regprocedure::text signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pos_offline_%' order by 1")).rows
for(const role of ['anon','authenticated']) for(const f of functions) check(await scalar('select has_function_privilege($1,$2,$3)',[role,f.signature,'EXECUTE']),false)
for(const role of ['anon','authenticated','service_role']) for(const table of ['pos_offline_key_epochs','pos_offline_authorities','pos_offline_signed_bundles','pos_offline_receipts','pos_offline_exceptions','pos_offline_branch_policy','pos_offline_source_windows','pos_offline_exception_resolutions']) check(await scalar('select has_table_privilege($1,$2,$3)',[role,'public.'+table,'INSERT,UPDATE,DELETE,SELECT']),false)
await db.exec('set role authenticated')
await rejects(rpc('pos_offline_authority',request.requestId),/permission denied/)
await db.exec('reset role')
if(process.argv[3]) await writeFile(process.argv[3],JSON.stringify({enrollment:epoch,reservation:draft,bundle,issuance:first,imported:accepted.result,replayed:replay.result,reconciliation:rejected.result,seal:thirdSealResult},null,2)+'\n')
console.log(JSON.stringify({checks,throttleCalls:602,documents:await scalar('select count(*)::int from public.pos_documents'),offlineReceipts:await scalar('select count(*)::int from public.pos_offline_receipts'),exceptions:await scalar('select count(*)::int from public.pos_offline_exceptions'),productionTouched:false}))
await db.close()
