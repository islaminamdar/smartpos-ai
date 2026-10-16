// Disposable PostgreSQL verification; pass the installed PGlite entry point as argv[2].
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { quoteOffer } from '../../lib/pos/offers.ts'
import { branchReportSchema } from '../../lib/pos/reports/contracts.ts'
const { PGlite } = await import(pathToFileURL(process.argv[2]).href)
process.on('uncaughtException',error=>{console.error(error.message,error.where??'');process.exit(1)})
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`)
for (const file of ['20261016000100_pos_platform.sql','20261016000200_pos_operations.sql','20261016000300_pos_live_documents.sql','20261016000400_pos_online_access.sql','20261016000500_pos_request_recovery.sql','20261016000600_pos_cash_out_balance.sql','20261016000800_pos_catalogue_management.sql','20261016001000_pos_sale_lock_order.sql','20261016001100_pos_branch_reports.sql','20261016001200_pos_offers.sql']) {
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
const order={id:crypto.randomUUID(),branchId:branch,deviceId:device.id,shiftId,createdAt:new Date().toISOString(),serviceType:'takeaway',lines:[{productId:product,quantityMilli:1000,expectedUnitPriceFils:1000,expectedTaxRateBps:500,expectedRevision:1}],payments:[{method:'cash',amountFils:1000}],expectedTotalFils:1000,profileId:profile,customer:null,cashTenderedFils:1000}
const baseOffer={id:crypto.randomUUID(),name:'Synthetic offer',active:true,benefit:{kind:'percentage',basisPoints:1000,maximumDiscountFils:null,eligibility:{scope:'all'}},schedule:{timezone:'Asia/Dubai',startsAt:null,endsAt:null,windows:[]},minimumSpendFils:0,serviceTypes:['dine_in','takeaway','delivery'],managerOnly:false,coupon:null,totalRedemptionsLimit:null,perCustomerLimit:null}
const manage=(offer,expectedRevision=0,extra={})=>command({expectedRevision,reason:'Synthetic test update',offer,...extra})
const managed=await rpc('pos_manage_offer',manage(baseOffer))
assert.equal(managed.offer.revision,1)
const quoteRpc=async(lines=order.lines,coupon=null,service='takeaway')=>(await db.query('select public.pos_quote_offers($1,$2::jsonb,$3,$4) as result',[branch,JSON.stringify(lines),service,coupon])).rows[0].result
const quoted=await quoteRpc()
assert.equal(quoted.quotes.length,1)
assert.equal(quoted.quotes[0].discountFils,100)
const offered={...order,id:crypto.randomUUID(),payments:[{method:'cash',amountFils:900}],expectedTotalFils:900,cashTenderedFils:1000,offerSelection:{offerId:baseOffer.id,expectedRevision:1,couponCode:null,expectedDiscountFils:100}}
const paid=await rpc('pos_record_live_order',offered)
assert.equal(paid.receipt.schemaVersion,2)
assert.equal(paid.receipt.totals.discountFils,100)
assert.equal(paid.receipt.lines[0].grossFils,900)
assert.equal(paid.receipt.lines[0].unitPriceFils,1000)
assert.equal(paid.receipt.changeFils,100)
assert.deepEqual(paid.receipt.appliedOffer,quoted.quotes[0])
assert.deepEqual(await rpc('pos_record_live_order',offered),{...paid,replayed:true})

const scalar=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0])[0]
const recover=async(request)=>(await db.query('select public.pos_resolve_live_request($1,$2::jsonb,$3) as result',['sale',JSON.stringify(request),binding])).rows[0].result
const list=async()=>scalar('select public.pos_list_offers($1) as result',[branch])
const used=async(offerId)=>(await list()).offers.find(o=>o.offer.id===offerId).redemptionsUsed
const asAdmin=async(fn)=>{await db.exec('reset role');try{return await fn()}finally{await db.exec(`set role authenticated;set app.user_id='${actor}'`)}}
const definition=(input)=>({...input,branchId:branch,revision:1})
const context={branchId:branch,now:'2026-10-16T08:00:00Z',serviceType:'takeaway',role:'manager',coupon:null,customerId:null,redemptionsUsed:0,customerRedemptionsUsed:0}
const calculator=async(offer,lines,ctx=context)=>scalar('select public.pos_calculate_offer($1::jsonb,$2::jsonb,$3::timestamptz,$4,$5,$6,$7)',[JSON.stringify(offer),JSON.stringify(lines),ctx.now,ctx.role,ctx.serviceType,ctx.coupon,ctx.redemptionsUsed])
const product2=crypto.randomUUID(),weightedProduct=crypto.randomUUID()
await asAdmin(async()=>db.query("insert into public.pos_products(id,organization_id,branch_id,name,category,unit,unit_price_fils,tax_rate_bps) values($1,$2,$3,'Second item','Test','piece',500,500),($4,$2,$3,'Weighted item','Weight','kg',1001,500)",[product2,org,branch,weightedProduct]))
const inputLine=(productId,price,quantityMilli=1000)=>({productId,quantityMilli,expectedUnitPriceFils:price,expectedTaxRateBps:500,expectedRevision:1})
const calcLine=(productId,price,quantityMilli=1000,unit='piece',category='Test',rate=500)=>({productId,unitPriceFils:price,quantityMilli,unit,category,taxRateBps:rate})
const pair=[calcLine(product,1000,3000),calcLine(product2,500,3000)]
const definitions=[
 {...baseOffer,benefit:{kind:'percentage',basisPoints:3333,maximumDiscountFils:99,eligibility:{scope:'products',productIds:[product]}}},
 {...baseOffer,benefit:{kind:'fixed',amountFils:1,eligibility:{scope:'all'}}},
 {...baseOffer,benefit:{kind:'fixed',amountFils:999999,eligibility:{scope:'categories',categories:['Test']}}},
 {...baseOffer,benefit:{kind:'buy_x_get_y',buyUnits:2,freeUnits:1,eligibility:{scope:'all'}}},
 {...baseOffer,benefit:{kind:'bundle',priceFils:1200,components:[{productId:product,units:2},{productId:product2,units:1}]}}
]
await asAdmin(async()=>{
 assert.deepEqual(await calculator(definition({...baseOffer,managerOnly:true}),pair,{...context,role:null}),{eligible:false,reason:'manager_required'});
 for(const offer of definitions){const parsed=definition(offer);assert.deepEqual(await calculator(parsed,pair),quoteOffer(parsed,pair,context))}
 // SQL and TS agree on monetary/quantity limits, stable UUID ties, mixed VAT and weighted rounding.
 let seed=98231;const random=max=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max}
 for(let sample=0;sample<400;sample++){
  const lines=Array.from({length:2+random(6)},(_,i)=>calcLine(`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,1+random(5000000),1+random(1000),'kg','Test',[0,500,10000][random(3)]))
  const offer=definition({...baseOffer,benefit:sample%2?{kind:'percentage',basisPoints:1+random(9999),maximumDiscountFils:null,eligibility:{scope:'all'}}:{kind:'fixed',amountFils:1+random(100000),eligibility:{scope:'all'}}})
  assert.deepEqual(await calculator(offer,lines),quoteOffer(offer,lines,context),`numeric parity sample${sample}`)
 }
 const windows=[{weekdays:[5],startMinute:720,endMinute:840},{weekdays:[7],startMinute:1320,endMinute:120}]
 for(const window of windows)for(const now of ['2026-10-16T07:59:59Z','2026-10-16T08:00:00Z','2026-10-16T09:59:59Z','2026-10-16T10:00:00Z','2026-10-18T18:00:00Z','2026-10-18T21:59:59Z','2026-10-18T22:00:00Z']){
  const offer=definition({...baseOffer,schedule:{...baseOffer.schedule,windows:[window]}}),ctx={...context,now}
  assert.deepEqual(await calculator(offer,pair,ctx),quoteOffer(offer,pair,ctx),'weekly/overnight boundary parity')
 }
 for(const [patch,ctx] of [
  [{active:false},context],[{managerOnly:true},{...context,role:'cashier'}],
  [{coupon:'SECRET10'},{...context,coupon:' secret10 '}],[{coupon:'SECRET10'},context],
  [{serviceTypes:['delivery']},context],[{minimumSpendFils:5000},context],
  [{totalRedemptionsLimit:1},{...context,redemptionsUsed:1}],
  [{schedule:{...baseOffer.schedule,startsAt:context.now,endsAt:'2026-10-16T09:00:00Z'}},{...context,now:'2026-10-16T09:00:00Z'}]
 ]){const offer=definition({...baseOffer,...patch});assert.deepEqual(await calculator(offer,pair,ctx),quoteOffer(offer,pair,ctx))}
})
// Exact management replay is independent of later changes, but changed payloads conflict.
const cmd=manage({...baseOffer,id:crypto.randomUUID(),coupon:'PRIVATE10',totalRedemptionsLimit:1})
const couponManaged=await rpc('pos_manage_offer',cmd)
assert.deepEqual(await rpc('pos_manage_offer',cmd),{...couponManaged,replayed:true})
await assert.rejects(rpc('pos_manage_offer',{...cmd,reason:'Altered request'}),/POS_IDEMPOTENCY_CONFLICT/)
await assert.rejects(rpc('pos_manage_offer',{...cmd,id:crypto.randomUUID()}),/POS_OFFER_CONFLICT/)
assert.equal((await quoteRpc()).quotes.some(q=>q.offerId===cmd.offer.id),false,'coupon campaign hidden without matching code')
const couponQuote=(await quoteRpc(order.lines,' private10 ')).quotes.find(q=>q.offerId===cmd.offer.id)
assert(couponQuote)
assert(!JSON.stringify(couponQuote).includes('PRIVATE10'))
assert.equal(couponQuote.appliedDefinition.couponRequired,true)
const couponSale={...offered,id:crypto.randomUUID(),offerSelection:{...offered.offerSelection,offerId:cmd.offer.id,couponCode:'PRIVATE10'}}
const couponPaid=await rpc('pos_record_live_order',couponSale)
assert.equal(await used(cmd.offer.id),1)
assert.deepEqual(await recover(couponSale),{...couponPaid,replayed:true})
await assert.rejects(recover({...couponSale,offerSelection:{...couponSale.offerSelection,couponCode:'private10'}}),/POS_IDEMPOTENCY_CONFLICT/,'exact submitted request, not normalized equivalence')
await assert.rejects(rpc('pos_record_live_order',{...couponSale,id:crypto.randomUUID()}),/POS_OFFER_INELIGIBLE:usage_limit/)
// No coupon code is exposed in any branch-readable automatic record.
for(const table of ['pos_orders','pos_documents','pos_audit_events','pos_command_receipts'])assert.equal(await scalar(`select exists(select 1 from public.${table} t where to_jsonb(t)::text like '%PRIVATE10%')`),false,table+' coupon redaction')
for(const table of ['pos_offers','pos_offer_versions','pos_offer_commands','pos_offer_redemptions','pos_offer_sale_requests'])await assert.rejects(db.query(`select * from public.${table}`),/permission denied/)
for(const sql of ["select public.pos_validate_offer('{}')","select public.pos_calculate_offer('{}','[]',now(),'owner','takeaway',null,0)","select public.pos_offer_catalogue_lines(null,null,'[]',false)","select public.pos_offer_allocate(1,array[1::bigint],array['x'])","select public.pos_record_live_order_v1('{}')","select public.pos_record_live_order_unbound('{}')","select public.pos_resolve_live_request_v1('sale','{}',null)"])await assert.rejects(db.query(sql),/permission denied/)
// Immutable original is replayed after offer deactivation and usage exhaustion.
await rpc('pos_manage_offer',manage({...cmd.offer,active:false},1))
assert.deepEqual(await rpc('pos_record_live_order',couponSale),{...couponPaid,replayed:true})
assert.deepEqual(await recover(couponSale),{...couponPaid,replayed:true})
assert.deepEqual(await rpc('pos_manage_offer',cmd),{...couponManaged,replayed:true})
const creditCommand=command({type:'refund.full',shiftId,orderId:couponSale.id,reason:'Synthetic return'})
const credit=await rpc('pos_execute_live_command',creditCommand)
assert.equal(credit.creditNote.schemaVersion,2)
assert.deepEqual(credit.creditNote.appliedOffer,couponPaid.receipt.appliedOffer)
assert.deepEqual(credit.creditNote.lines,couponPaid.receipt.lines)
assert.deepEqual(credit.creditNote.totals,couponPaid.receipt.totals)
assert.deepEqual(credit.creditNote.payments,couponPaid.receipt.payments)
assert.equal(await used(cmd.offer.id),1,'refund retains redeemed-order usage')
assert.deepEqual(await rpc('pos_execute_live_command',creditCommand),{...credit,replayed:true})
await assert.rejects(rpc('pos_execute_live_command',{...creditCommand,id:crypto.randomUUID()}),/POS_PRIOR_REFUND_EXISTS/)
// All benefit types settle their final amounts directly, including a zero-paid reward line.
const receipts=[paid.receipt,couponPaid.receipt], sales=[{request:offered,result:paid},{request:couponSale,result:couponPaid}]
for(const offer of [definitions[0],definitions[1],definitions[3],definitions[4]]){
 const saved=await rpc('pos_manage_offer',manage({...offer,id:crypto.randomUUID()}))
 const lines=[inputLine(product,1000,3000),inputLine(product2,500,3000)]
 const q=(await quoteRpc(lines)).quotes.find(q=>q.offerId===saved.offer.id);assert(q)
 const sale={...order,id:crypto.randomUUID(),lines,payments:[{method:'card',amountFils:q.grossFils}],cashTenderedFils:0,expectedTotalFils:q.grossFils,offerSelection:{offerId:saved.offer.id,expectedRevision:1,couponCode:null,expectedDiscountFils:q.discountFils}}
 const result=await rpc('pos_record_live_order',sale);assert.deepEqual(result.receipt.appliedOffer,q);assert.equal(result.taxFils,q.taxFils);assert.equal(await used(saved.offer.id),1);receipts.push(result.receipt);sales.push({request:sale,result})
}
const freeLineOffer=await rpc('pos_manage_offer',manage({...baseOffer,id:crypto.randomUUID(),benefit:{kind:'fixed',amountFils:1000,eligibility:{scope:'products',productIds:[product]}}}))
const freeLines=[inputLine(product,1000),inputLine(product2,500)]
const freeSale={...order,id:crypto.randomUUID(),lines:freeLines,payments:[{method:'cash',amountFils:500}],cashTenderedFils:500,expectedTotalFils:500,offerSelection:{offerId:freeLineOffer.offer.id,expectedRevision:1,couponCode:null,expectedDiscountFils:1000}}
const freeResult=await rpc('pos_record_live_order',freeSale);assert.equal(freeResult.receipt.lines[0].grossFils,0);assert.equal(freeResult.receipt.lines[0].taxFils,0);receipts.push(freeResult.receipt);sales.push({request:freeSale,result:freeResult})
// Failed/cancelled requests reserve nothing and cannot be resurrected.
const countState=async()=>asAdmin(async()=>({orders:await scalar('select count(*)::integer from public.pos_orders'),documents:await scalar('select count(*)::integer from public.pos_documents'),uses:await scalar('select sum(redemptions_used)::integer from public.pos_offers'),counter:await scalar("select sum(last_number)::integer from public.pos_document_counters"),redemptions:await scalar('select count(*)::integer from public.pos_offer_redemptions')}))
const before=await countState()
for(const [patch,error] of [
 [{expectedTotalFils:899},/POS_TOTAL_MISMATCH/],
 [{payments:[{method:'cash',amountFils:899}]},/POS_PAYMENT_MISMATCH/],
 [{offerSelection:{...offered.offerSelection,expectedRevision:2}},/POS_OFFER_CHANGED/],
 [{offerSelection:{...offered.offerSelection,expectedDiscountFils:99}},/POS_OFFER_CHANGED/],
 [{offerSelection:{...offered.offerSelection,owner:true}},/POS_INVALID_OFFER/],
 [{lines:[{...order.lines[0],expectedRevision:2}]},/POS_PRICE_CHANGED/],
 [{lines:[{...order.lines[0],expectedRevision:undefined}]},/POS_INVALID_ORDER/],
 [{lines:[order.lines[0],{...order.lines[0],productId:product.toUpperCase()}]},/POS_INVALID_ORDER/],
 [{lines:[{...order.lines[0],quantityMilli:500}]},/POS_INVALID_ORDER/],
 [{offerSelection:{...offered.offerSelection,offerId:crypto.randomUUID()}},/POS_OFFER_UNAVAILABLE/]
])await assert.rejects(rpc('pos_record_live_order',{...offered,id:crypto.randomUUID(),...patch}),error)
assert.deepEqual(await countState(),before)
const cancelled={...offered,id:crypto.randomUUID()};assert.equal((await recover(cancelled)).status,'cancelled')
await assert.rejects(rpc('pos_record_live_order',cancelled),/POS_REQUEST_CANCELLED/)
assert.deepEqual(await countState(),before)
// v1 no-offer behavior/replay stays unchanged after012.
const old=await rpc('pos_record_live_order',{...order,id:crypto.randomUUID()})
assert.equal(old.receipt.schemaVersion,1)
assert.equal(old.receipt.appliedOffer,undefined)
const oldRequest=await scalar('select request_payload from public.pos_documents where id=$1',[old.receipt.id])
assert.deepEqual(await recover(oldRequest),{...old,replayed:true})
// Existing reports and drawer summaries consume the actual discounted ledger amounts.
const reportDay=await scalar("select (clock_timestamp() at time zone 'Asia/Dubai')::date::text")
const report=branchReportSchema.parse(await scalar('select public.pos_branch_report($1,$2::date,$2::date)',[branch,reportDay]))
assert.equal(report.summary.salesGrossFils,await scalar('select sum(total_fils)::bigint from public.pos_orders where branch_id=$1',[branch]))
assert.equal(report.summary.refundGrossFils,await scalar('select sum(amount_fils)::bigint from public.pos_refunds where branch_id=$1',[branch]))
assert.equal(report.summary.netGrossFils,report.summary.salesGrossFils-report.summary.refundGrossFils)
const summaries=await scalar('select public.pos_open_shift_summaries()')
const drawer=await scalar("select coalesce((select sum(p.amount_fils) from public.pos_payments p join public.pos_orders o on o.id=p.order_id where o.shift_id=$1 and p.method='cash'),0)-coalesce((select sum(amount_fils) from public.pos_refunds where shift_id=$1 and method='cash'),0)",[shiftId])
assert.equal(summaries.find(s=>s.id===shiftId).expectedCashFils,drawer)
// Manager input validation is authoritative even with direct PostgREST access.
for(const patch of [
 {perCustomerLimit:1},{active:'true'},{totalRedemptionsLimit:0},{minimumSpendFils:0.5},{coupon:'lowercase'},{extra:true},
 {benefit:{kind:'percentage',basisPoints:10001,maximumDiscountFils:null,eligibility:{scope:'all'}}},
 {benefit:{kind:'bundle',priceFils:1,components:[{productId:product,units:1},{productId:product.toUpperCase(),units:1}]}},
 {benefit:{kind:'fixed',amountFils:1,eligibility:{scope:'products',productIds:[foreignProduct]}}},
 {schedule:{...baseOffer.schedule,windows:[{weekdays:[1,1],startMinute:0,endMinute:1440}]}},
 {schedule:{...baseOffer.schedule,startsAt:'2026-02-30T00:00:00Z'}},
 {schedule:{...baseOffer.schedule,startsAt:'2026-10-17T00:00:00Z',endsAt:'2026-10-16T00:00:00Z'}}
])await assert.rejects(rpc('pos_manage_offer',manage({...baseOffer,id:crypto.randomUUID(),...patch})),/POS_INVALID_OFFER|POS_OFFER_CUSTOMER_UNSUPPORTED|POS_PRODUCT_UNAVAILABLE/)
await assert.rejects(rpc('pos_manage_offer',manage({...baseOffer,id:crypto.randomUUID()}),'b'.repeat(64)),/POS_DEVICE_INVALID/)
await assert.rejects(db.query('select public.pos_quote_offers($1,$2::jsonb,$3,$4)',[foreignBranch,JSON.stringify(order.lines),'takeaway',null]),/POS_ACCESS_DENIED/)
await assert.rejects(db.query('select public.pos_list_offers($1)',[foreignBranch]),/POS_MANAGER_REQUIRED/)
const managerOffer=await rpc('pos_manage_offer',manage({...baseOffer,id:crypto.randomUUID(),managerOnly:true}))
await db.exec(`set app.user_id='${cashier}'`)
await assert.rejects(list(),/POS_MANAGER_REQUIRED/)
assert.equal((await quoteRpc()).quotes.some(q=>q.offerId===managerOffer.offer.id),false)
const cashierBinding='c'.repeat(64)
const cashierDevice=(await db.query('select public.pos_enroll_device($1,$2,$3) as result',[branch,'Synthetic cashier',cashierBinding])).rows[0].result
await assert.rejects(rpc('pos_manage_offer',{...manage({...baseOffer,id:crypto.randomUUID()}),deviceId:cashierDevice.id},cashierBinding),/POS_MANAGER_REQUIRED/)
const cashierShift=crypto.randomUUID()
await rpc('pos_execute_live_command',{id:crypto.randomUUID(),branchId:branch,deviceId:cashierDevice.id,type:'shift.open',shiftId:cashierShift,openingCashFils:0},cashierBinding)
await assert.rejects(rpc('pos_record_live_order',{...offered,id:crypto.randomUUID(),deviceId:cashierDevice.id,shiftId:cashierShift,offerSelection:{...offered.offerSelection,offerId:managerOffer.offer.id}},cashierBinding),/POS_OFFER_INELIGIBLE:manager_required/)
await db.exec('set role anon');await assert.rejects(quoteRpc(),/permission denied/);await assert.rejects(list(),/permission denied/)
await db.exec(`set role authenticated;set app.user_id='${actor}'`)
// Paid v2 originals and full credits survive later catalogue/unit edits without recalculation.
await rpc('pos_manage_catalogue',command({expectedRevision:1,reason:'Synthetic later menu revision',product:{id:product,name:'Later weighted menu name',category:'Later category',imageUrl:null,unit:'kg',unitPriceFils:1200,taxRateBps:500,active:true}}))
assert.deepEqual(await rpc('pos_record_live_order',offered),{...paid,replayed:true})
assert.deepEqual(await recover(offered),{...paid,replayed:true})
const afterEditCredit=await rpc('pos_execute_live_command',command({type:'refund.full',shiftId,orderId:freeSale.id,reason:'Synthetic return after menu edit'}))
assert.deepEqual(afterEditCredit.creditNote.lines,freeResult.receipt.lines)
assert.deepEqual(afterEditCredit.creditNote.totals,freeResult.receipt.totals)
assert.equal(afterEditCredit.creditNote.lines[0].unit,'piece')
assert.equal(afterEditCredit.creditNote.lines[0].grossFils,0)
assert.equal(await used(freeLineOffer.offer.id),1)
// Immutable private originals and versions cannot be rewritten even by a privileged maintenance caller.
await asAdmin(async()=>{
 await assert.rejects(db.query('update public.pos_offer_sale_requests set request_payload=request_payload'),/POS_IMMUTABLE_DOCUMENT/)
 await assert.rejects(db.query('delete from public.pos_offer_redemptions'),/POS_IMMUTABLE_DOCUMENT/)
 await assert.rejects(db.query('update public.pos_offer_versions set definition=definition'),/POS_IMMUTABLE_DOCUMENT/)
 const currentCount=await scalar('select count(*)::integer from public.pos_offers where branch_id=$1',[branch])
 for(let i=currentCount;i<200;i++){const d=definition({...baseOffer,id:crypto.randomUUID(),active:false});await db.query('insert into public.pos_offers(id,organization_id,branch_id,revision,definition) values($1,$2,$3,1,$4::jsonb)',[d.id,org,branch,JSON.stringify(d)])}
})
await assert.rejects(rpc('pos_manage_offer',manage({...baseOffer,id:crypto.randomUUID()})),/POS_OFFER_LIMIT_REACHED/)
assert.equal((await list()).offers.length,200)
if(process.argv[3])await writeFile(process.argv[3],JSON.stringify({receipts,credit:credit.creditNote,quoted,sales},null,2),{mode:0o600})
await db.close()
console.log('PASS: SQL/TS parity400 varied baskets plus4rule types/schedules; direct discounted v2 writes and immutable full credits; v1 replay; exact private coupon replay/recovery/redaction; quotas retained across edits/refunds; failed-payment atomicity and cancellation; role/tenant/device/helper ACLs; malformed definitions and200offer cap.')
