// Synthetic disposable PostgreSQL fixture. No production records or credentials.
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { branchReportSchema } from '../../lib/pos/reports/contracts.ts'
const { PGlite }=await import(pathToFileURL(process.argv[2]).href)
const db=new PGlite()
await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`)
for(const file of ['20261016000100_pos_platform.sql','20261016000200_pos_operations.sql','20261016000300_pos_live_documents.sql','20261016001100_pos_branch_reports.sql'])await db.exec(await readFile(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'))
const id=()=>crypto.randomUUID(),[org,otherOrg,branch,sibling,otherBranch,manager,cashier,outsider,owner,device,shift,profile,piece,weight,pack]=Array.from({length:15},id)
await db.exec(`insert into auth.users values('${manager}'),('${cashier}'),('${outsider}'),('${owner}');
insert into pos_organizations(id,legal_name) values('${org}','Synthetic'),('${otherOrg}','Other tenant');
insert into pos_branches(id,organization_id,name) values('${branch}','${org}','Synthetic branch'),('${sibling}','${org}','Sibling'),('${otherBranch}','${otherOrg}','Other');
insert into pos_staff values('${org}','${manager}','${branch}','manager',true),('${org}','${cashier}','${branch}','cashier',true),('${otherOrg}','${outsider}','${otherBranch}','manager',true),('${org}','${owner}',null,'owner',true);
insert into pos_devices(id,organization_id,branch_id,name) values('${device}','${org}','${branch}','Synthetic');
insert into pos_shifts(id,organization_id,branch_id,device_id,opened_by,opening_cash_fils) values('${shift}','${org}','${branch}','${device}','${manager}',0);
insert into pos_merchant_profiles(id,organization_id,branch_id,legal_name,branch_name,address,phone,trn,tax_registered,tax_inclusive,confirmed_by) values('${profile}','${org}','${branch}','Synthetic','Synthetic branch','Test address','Test phone','100000000000001',true,true,'${manager}');
insert into pos_branch_receipt_config values('${branch}','${org}','${profile}','TEST',false);`)
let sequence=0
const line=(productId,name,unit,quantityMilli,grossFils,taxRateBps=500)=>({productId,name,unit,quantityMilli,grossFils,taxRateBps,taxFils:Math.round(grossFils*taxRateBps/(10000+taxRateBps)),unitPriceFils:99999})
async function document({time,lines,payments,original}){
 const order=original?.order??id(),docId=id(),kind=original?'tax_credit_note':'tax_invoice'
 const normalized=lines.map((l,index)=>({...l,lineNumber:index+1,netFils:l.grossFils-l.taxFils}))
 const totals={grossFils:normalized.reduce((s,l)=>s+l.grossFils,0),netFils:normalized.reduce((s,l)=>s+l.netFils,0),taxFils:normalized.reduce((s,l)=>s+l.taxFils,0)}
 if(!original)await db.query('insert into pos_orders(id,organization_id,branch_id,device_id,shift_id,created_by,client_created_at,received_at,service_type,total_fils,tax_fils,request_payload) values($1,$2,$3,$4,$5,$6,$7,$7,\'takeaway\',$8,$9,\'{}\')',[order,org,branch,device,shift,manager,time,totals.grossFils,totals.taxFils])
 const number='TEST-'+(original?'CN':'INV')+'-'+String(++sequence).padStart(10,'0')
 // Deliberately final snapshot values differ from current/reconstructed price. Reports must use saved amounts.
 const snapshot={schemaVersion:2,id:docId,kind,documentNumber:number,issuedAt:time,branchId:branch,orderId:order,customer:{name:'Private buyer must never be exported'},lines:normalized,totals,payments,cashTenderedFils:90000,changeFils:80000}
 await db.query('insert into pos_documents(id,organization_id,branch_id,order_id,actor_id,kind,document_number,issued_at,request_payload,snapshot) values($1,$2,$3,$4,$5,$6,$7,$8,\'{}\',$9::jsonb)',[docId,org,branch,order,manager,kind,number,time,JSON.stringify(snapshot)])
 return {order,lines,payments}
}
const prior=await document({time:'2026-10-14T19:59:59.999999Z',lines:[line(piece,'Old sweet','piece',1000,1050)],payments:[{method:'cash',amountFils:1050}]})
const first=await document({time:'2026-10-14T20:00:00Z',lines:[line(piece,'Renamed sweet','piece',1000,1050)],payments:[{method:'cash',amountFils:600},{method:'card',amountFils:450}]})
await document({time:'2026-10-15T19:59:59.999999Z',lines:[line(weight,'Weighted sweet','kg',500,1050)],payments:[{method:'cash',amountFils:1050}]})
await document({time:'2026-10-15T20:00:00Z',lines:[line(pack,'Zero rated pack','pack',2000,600,0)],payments:[{method:'card',amountFils:600}]})
await document({time:'2026-10-15T10:00:00Z',...prior,original:prior})
await document({time:'2026-10-16T10:00:00Z',...first,original:first})
await db.query("insert into pos_orders(id,organization_id,branch_id,device_id,shift_id,created_by,client_created_at,received_at,service_type,total_fils,tax_fils,request_payload) values($1,$2,$3,$4,$5,$6,'2026-10-15T12:00Z','2026-10-15T12:00Z','takeaway',777,37,'{}')",[id(),org,branch,device,shift,manager])
await db.exec(`set role authenticated;set app.user_id='${manager}';`)
const report=async(start,end=start,b=branch)=>(await db.query('select pos_branch_report($1,$2::date,$3::date) as result',[b,start,end])).rows[0].result
const day15=branchReportSchema.parse(await report('2026-10-15'))
assert.deepEqual(day15.summary,{invoiceCount:2,creditNoteCount:1,salesGrossFils:2100,refundGrossFils:1050,netGrossFils:1050,netExVatFils:1000,vatFils:50})
assert.equal(day15.legacyOrdersExcluded,1);assert.equal(day15.timezone,'Asia/Dubai')
assert.deepEqual(day15.payments.find(p=>p.method==='cash'),{method:'cash',salesFils:1650,refundsFils:1050,netFils:600})
assert.equal(day15.products.find(p=>p.name==='Old sweet').netQuantityMilli,-1000,'prior-day invoice refund recognized in current period')
assert.equal(day15.products.find(p=>p.unit==='kg').netQuantityMilli,500)
assert(!JSON.stringify(day15).includes('Private buyer'))
const day16=branchReportSchema.parse(await report('2026-10-16'))
assert.deepEqual(day16.summary,{invoiceCount:1,creditNoteCount:1,salesGrossFils:600,refundGrossFils:1050,netGrossFils:-450,netExVatFils:-400,vatFils:-50})
assert.equal(day16.vatRates.find(r=>r.taxRateBps===0).netExVatFils,600)
assert.equal(day16.vatRates.find(r=>r.taxRateBps===500).vatFils,-50)
const both=branchReportSchema.parse(await report('2026-10-15','2026-10-16'));assert.equal(both.summary.netGrossFils,600);assert.equal(both.summary.vatFils,0);assert.equal(both.days.length,2)
const empty=branchReportSchema.parse(await report('2026-10-17','2026-10-18'));assert.equal(empty.documentCount,0);assert.equal(empty.days.length,2);assert.equal(empty.products.length,0)
await assert.rejects(report('2026-10-16','2026-10-15'),/POS_REPORT_INVALID_RANGE/)
await assert.rejects(report('2026-01-01','2026-04-04'),/POS_REPORT_INVALID_RANGE/)
await assert.rejects(report('2026-10-15','2026-10-15',sibling),/POS_REPORT_ACCESS_DENIED/)
await assert.rejects(report('2026-10-15','2026-10-15',otherBranch),/POS_REPORT_ACCESS_DENIED/)
await db.exec(`set app.user_id='${cashier}'`);await assert.rejects(report('2026-10-15'),/POS_REPORT_ACCESS_DENIED/)
await db.exec(`set app.user_id='${outsider}'`);await assert.rejects(report('2026-10-15'),/POS_REPORT_ACCESS_DENIED/)
await db.exec(`set app.user_id='${owner}'`);assert.equal((await report('2026-10-15')).documentCount,3)
await assert.rejects(report('2026-10-15','2026-10-15',sibling),/POS_REPORT_PROFILE_REQUIRED/,'missing setup is unavailable, never zero')
await db.exec('set role anon');await assert.rejects(report('2026-10-15'),/permission denied/)
await db.exec(`reset role;update pos_staff set active=false where user_id='${manager}';set role authenticated;set app.user_id='${manager}'`);await assert.rejects(report('2026-10-15'),/POS_REPORT_ACCESS_DENIED/)
if(process.argv[3])await writeFile(process.argv[3],JSON.stringify({report:both,negativeReport:day16,bootstrap:{status:'ready',userId:manager,branches:[{id:branch,organizationId:org,name:'Synthetic reporting QA branch',role:'manager',canSell:false,canRefund:true,canManageCash:true,profile:{id:profile,organizationId:org,branchId:branch,legalName:'Synthetic QA merchant',branchName:'Synthetic reporting QA branch',address:'Synthetic address',phone:'Synthetic phone',trn:'100000000000001',taxRegistered:true,currency:'AED',timezone:'Asia/Dubai',taxInclusive:true,calculationVersion:'line-v2',confirmedBy:manager,confirmedAt:'2026-10-16T10:00:00Z'}}],catalogue:[],device:{id:device,branchId:branch,name:'Synthetic read-only QA counter'},shifts:[],capabilities:{onlineSales:false,offlineSales:false}}},null,2),{mode:0o600})
await db.close();console.log('PASS: saved final totals, Dubai microsecond cutoffs, prior-period credits/negative net VAT, split payments excluding change, kg quantities, historical names, zero-date rows, excluded legacy coverage, manager/owner scope, cashier/other-tenant denial, no customer data, bounded ranges; migration011 independent of010.')
