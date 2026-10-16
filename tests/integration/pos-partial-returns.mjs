// Synthetic disposable SQL029 partial-return tests. No real merchants, provider calls or signature claims.
// Usage: node this.mjs /absolute/pglite/dist/index.js [report.json]
// Or: node this.mjs --postgres /absolute/pg/lib/index.js /private/unix/socket [report.json]
// PostgreSQL mode creates/drops its own unique DB; never accepts a database URL or TCP host.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { userInfo } from 'node:os'
const postgres = process.argv[2] === '--postgres'
const reportPath = process.argv[postgres ? 5 : 3]
const report = { startedAt: new Date().toISOString(), backend: postgres ? 'PostgreSQL' : 'PGlite (not true concurrency)', productionTouched: false, checks: [], races: [], migrationHashes: {}, cleanup: 'pending' }
let db, control, Client, database, config, returnMigrationSql, ownedDatabase = false
const sessions = []
const save = async () => { if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }) }
const check = (actual, expected, name) => { assert.deepEqual(actual, expected, name); report.checks.push(name) }
const rejects = async (operation, pattern, name) => { await assert.rejects(operation, pattern); report.checks.push(name) }
const uid = randomUUID
const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])) : value)
const envelope = (payload, keyId = 'synthetic-server', signatureBase64Url = 'MAgCAQICAQE') => ({ format: 'pos-signed-v1', alg: 'ECDSA-P256-SHA256-DER', keyId, payloadBase64Url: Buffer.from(canonical(payload)).toString('base64url'), signatureBase64Url })
const eh = value => hash(Buffer.from(value.payloadBase64Url, 'base64url'))
const scalar = async (sql, params = [], connection = db) => Object.values((await connection.query(sql, params)).rows[0])[0]
const rpcOn = (connection, name, ...args) => scalar(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args.map(v => v !== null && typeof v === 'object' ? JSON.stringify(v) : v), connection)
const service = async (name, ...args) => { await db.exec('set role service_role'); try { return await rpcOn(db, name, ...args) } finally { await db.exec('reset role') } }

async function initialize() {
  if (postgres) {
    const module = await import(pathToFileURL(process.argv[3]).href)
    Client = module.Client ?? module.default.Client
    const host = process.argv[4]
    assert.ok(host?.startsWith('/tmp/pos-qa-pg-') && !host.includes('..'), 'Only an isolated QA Unix socket is accepted')
    config = { host, port: 55432, user: userInfo().username, database: 'postgres', connectionTimeoutMillis: 5000 }
    control = new Client(config); await control.connect()
    assert.equal(await scalar('select inet_server_addr() is null', [], control), true)
    database = 'pos_qa_partial_returns_' + uid().replaceAll('-', '')
    await control.query(`create database ${database}`); ownedDatabase = true
    report.database = database
    db = new Client({ ...config, database }); await db.connect(); db.exec = sql => db.query(sql)
    // The private portable PostgreSQL runtime does not bundle optional LLVM JIT.
    // Keep exhaustive allocation checks on the normal executor, without downloads.
    await db.exec('set jit=off')
    report.serverVersion = await scalar('select version()')
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!await scalar('select exists(select 1 from pg_roles where rolname=$1)', [role])) await db.exec(`create role ${role}`)
    }
  } else {
    const { PGlite } = await import(pathToFileURL(process.argv[2]).href)
    db = new PGlite(); await db.exec('create role anon;create role authenticated;create role service_role;')
  }
  await db.exec(`create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`)
  const directory = new URL('../../supabase/migrations/', import.meta.url)
  const files = (await readdir(directory)).filter(f => /^2026101600(?:0[1-9]|1[0-9]|2[0-9])00_/.test(f)).sort()
  for (const file of files) {
    const sql = await readFile(new URL(file, directory), 'utf8'); report.migrationHashes[file] = hash(sql)
    if (file === '20261016002900_pos_partial_returns.sql') returnMigrationSql = sql
    else await db.exec(sql)
  }
  assert.ok(returnMigrationSql, 'the exact SQL029 migration must exist')
  await save()
}

async function raced(name, firstOperation, secondOperation, { firstRole = 'service_role', secondRole = 'service_role', actor, releaseDelayMs = 0 } = {}) {
  assert.ok(postgres, 'A real two-session race requires PostgreSQL')
  const a = new Client({ ...config, database, application_name: name + '_a' }), b = new Client({ ...config, database, application_name: name + '_b' })
  sessions.push(a, b); await a.connect(); await b.connect()
  for (const connection of [a, b]) { await connection.query("set statement_timeout='8s'"); if (actor) await connection.query("select set_config('app.user_id',$1,false)", [actor]) }
  await a.query('begin'); await b.query('begin')
  if (firstRole) await a.query('set local role ' + firstRole)
  if (secondRole) await b.query('set local role ' + secondRole)
  let second
  try {
    const first = await firstOperation(a)
    let completed = false
    const task = secondOperation(b).then(value => { completed = true; return { value } }, error => { completed = true; return { error: error.message } })
    let wait = null
    for (let i = 0; i < 150; i++) {
      const row = (await control.query("select wait_event_type,wait_event,cardinality(pg_blocking_pids(pid)) blockers from pg_stat_activity where datname=$1 and application_name=$2", [database, name + '_b'])).rows[0]
      if (row?.wait_event_type === 'Lock' && row.blockers > 0) { wait = row; break }
      if (completed) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.ok(wait, `${name}: independent second backend must observably wait for first transaction`)
    if (releaseDelayMs) await new Promise(resolve => setTimeout(resolve, releaseDelayMs))
    await a.query('commit'); second = await task
    await b.query(second.error ? 'rollback' : 'commit')
    const evidence = { name, first, second, blockingObserved: wait }
    report.races.push(evidence); await save(); return evidence
  } finally { await a.query('rollback').catch(() => {}); await b.query('rollback').catch(() => {}); await a.end(); await b.end(); sessions.splice(sessions.indexOf(a), 1); sessions.splice(sessions.indexOf(b), 1) }
}

async function as(f, name, ...args) {
  await db.query("select set_config('app.user_id',$1,false)", [f.owner]); await db.exec('set role authenticated')
  try { return await rpcOn(db, name, ...args) } finally { await db.exec('reset role') }
}
async function fixture() {
  const f = Object.fromEntries(['owner','cashier','org','branch','device','shift','profile','product','weight'].map(k=>[k,uid()])); f.binding=hash(uid())
  await db.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'return-owner@example.test',now()),($2,'return-cashier@example.test',now())`,[f.owner,f.cashier])
  await db.query('insert into public.pos_organizations(id,legal_name) values($1,$2)',[f.org,'Synthetic returns'])
  await db.query('insert into public.pos_branches(id,organization_id,name) values($1,$2,$3)',[f.branch,f.org,'Synthetic branch'])
  await db.query("insert into public.pos_staff(organization_id,user_id,branch_id,role) values($1,$2,null,'owner'),($1,$3,$4,'cashier')",[f.org,f.owner,f.cashier,f.branch])
  await db.query("insert into public.pos_devices(id,organization_id,branch_id,name) values($1,$2,$3,'Synthetic counter')",[f.device,f.org,f.branch])
  await db.query('insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)',[f.binding,f.owner,f.org,f.branch,f.device])
  await db.query('insert into public.pos_shifts(id,organization_id,branch_id,device_id,opened_by,opening_cash_fils) values($1,$2,$3,$4,$5,100000)',[f.shift,f.org,f.branch,f.device,f.owner])
  await db.query("insert into public.pos_merchant_profiles(id,organization_id,branch_id,legal_name,branch_name,address,phone,trn,tax_registered,tax_inclusive,confirmed_by) values($1,$2,$3,'Synthetic legal','Synthetic branch','Synthetic address','Synthetic phone','100000000000001',true,true,$4)",[f.profile,f.org,f.branch,f.owner])
  await db.query("insert into public.pos_branch_receipt_config values($1,$2,$3,'TEST',true)",[f.branch,f.org,f.profile])
  await db.query("insert into public.pos_products(id,organization_id,branch_id,name,category,unit,unit_price_fils,tax_rate_bps) values($1,$2,$3,'Synthetic piece','Test','piece',101,500),($4,$2,$3,'Synthetic weight','Test','kg',103,0)",[f.product,f.org,f.branch,f.weight])
  return f
}
async function sale(f,lines=[{productId:f.product,quantityMilli:3000,expectedUnitPriceFils:101,expectedTaxRateBps:500},{productId:f.weight,quantityMilli:333,expectedUnitPriceFils:103,expectedTaxRateBps:0}],cash=137) {
 const gross=lines.reduce((n,l)=>n+Math.round(l.quantityMilli*l.expectedUnitPriceFils/1000),0)
 const request={id:uid(),branchId:f.branch,deviceId:f.device,shiftId:f.shift,createdAt:new Date().toISOString(),serviceType:'takeaway',lines,payments:[...(cash?[{method:'cash',amountFils:cash}]:[]),...(gross>cash?[{method:'card',amountFils:gross-cash}]:[])],expectedTotalFils:gross,profileId:f.profile,cashTenderedFils:cash,customer:null}
 const result=await as(f,'pos_record_live_order',request,f.binding);return {request,invoice:result.receipt}
}
async function offeredSale(f,discount){
 const offer={id:uid(),name:'Synthetic saved discount',active:true,benefit:{kind:'fixed',amountFils:discount,eligibility:{scope:'products',productIds:[f.product]}},schedule:{timezone:'Asia/Dubai',startsAt:null,endsAt:null,windows:[]},minimumSpendFils:0,serviceTypes:['dine_in','takeaway','delivery'],managerOnly:false,coupon:null,totalRedemptionsLimit:null,perCustomerLimit:null}
 await as(f,'pos_manage_offer',{id:uid(),branchId:f.branch,deviceId:f.device,expectedRevision:0,reason:'Synthetic return allocation fixture',offer},f.binding)
 const lines=[{productId:f.product,quantityMilli:3000,expectedUnitPriceFils:101,expectedTaxRateBps:500,expectedRevision:1},{productId:f.weight,quantityMilli:1000,expectedUnitPriceFils:103,expectedTaxRateBps:0,expectedRevision:1}],gross=406-discount,cash=40
 const request={id:uid(),branchId:f.branch,deviceId:f.device,shiftId:f.shift,createdAt:new Date().toISOString(),serviceType:'takeaway',lines,payments:[{method:'cash',amountFils:cash},{method:'card',amountFils:gross-cash}],expectedTotalFils:gross,profileId:f.profile,cashTenderedFils:cash,customer:null,offerSelection:{offerId:offer.id,expectedRevision:1,couponCode:null,expectedDiscountFils:discount}}
 const result=await as(f,'pos_record_live_order',request,f.binding);return {request,invoice:result.receipt,offer}
}
async function importedSale(f){
 await db.query('insert into public.pos_offline_branch_policy(branch_id,enabled) values($1,true)',[f.branch])
 const bytes=Buffer.from('synthetic-import-key-'+uid()),fingerprint=hash(bytes),requestId=uid()
 const enrollment=await service('pos_offline_enroll',f.owner,{requestId,branchId:f.branch,deviceId:f.device,publicKeySpki:bytes.toString('base64url'),deviceKeySha256:fingerprint,proof:envelope({kind:'offline-enrollment',schemaVersion:1,requestId,branchId:f.branch,deviceId:f.device,actorId:f.owner,deviceKeySha256:fingerprint,issuedAt:new Date().toISOString()},fingerprint)})
 const draft=await service('pos_offline_reserve',f.owner,{requestId:uid(),branchId:f.branch,deviceId:f.device,shiftId:f.shift,count:3,lifetimeSeconds:60,maxInvoiceTotalFils:10000,maxGrossFils:30000,permissions:{cash:true,recordedCard:true,mixedTender:true}}),snapshotEnvelope=envelope(draft.snapshot)
 const bundle=await service('pos_offline_attach',draft.authority.id,snapshotEnvelope,envelope({...draft.authority,snapshotSha256:eh(snapshotEnvelope)})),a=bundle.authority,id=uid()
 const invoice={schemaVersion:1,id:uid(),kind:'tax_invoice',documentNumber:`${a.invoiceRange.prefix}-INV-${String(a.invoiceRange.first).padStart(10,'0')}`,issuedAt:a.issuedAt,merchant:bundle.snapshot.profile,orderId:id,branchId:f.branch,deviceId:f.device,shiftId:f.shift,actorId:f.owner,serviceType:'takeaway',customer:null,lines:[{lineNumber:1,productId:f.product,name:'Synthetic piece',unit:'piece',quantityMilli:1000,unitPriceFils:101,taxRateBps:500,grossFils:101,netFils:96,taxFils:5}],totals:{grossFils:101,netFils:96,taxFils:5},payments:[{method:'cash',amountFils:101}],paymentSettlement:'recorded',cashTenderedFils:101,changeFils:0}
 const proof=envelope({kind:'offline-sale',schemaVersion:1,id,authorityId:a.id,authoritySha256:bundle.authoritySha256,snapshotSha256:bundle.snapshotSha256,deviceSequence:1,previousEventSha256:null,document:invoice,clock:{estimatedServerAt:a.issuedAt,bootId:uid(),elapsedRealtimeMs:1234},paymentIntentId:uid()},fingerprint)
 const ack=envelope({kind:'offline-ack',schemaVersion:1,id:uid(),issuanceId:id,payloadSha256:eh(proof),authorityId:a.id,keyEpoch:enrollment.keyEpoch,deviceSequence:1,receivedAt:new Date().toISOString()})
 await service('pos_offline_import',a.id,proof,ack);return {invoice,authorityId:a.id,proof,ack}
}
async function secondCounter(f,opening=0){const other={...f,device:uid(),shift:uid(),binding:hash(uid())};await db.query("insert into public.pos_devices(id,organization_id,branch_id,name) values($1,$2,$3,'Synthetic second counter')",[other.device,f.org,f.branch]);await db.query('insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)',[other.binding,f.owner,f.org,f.branch,other.device]);await db.query('insert into public.pos_shifts(id,organization_id,branch_id,device_id,opened_by,opening_cash_fils) values($1,$2,$3,$4,$5,$6)',[other.shift,f.org,f.branch,other.device,f.owner,opening]);return other}
const state=(f,s)=>as(f,'pos_return_state',f.branch,f.device,s.invoice.orderId,f.binding)
const request=(f,s,lines,expectedRevision=0)=>({branchId:f.branch,deviceId:f.device,shiftId:f.shift,orderId:s.invoice.orderId,invoiceId:s.invoice.id,expectedRevision,lines,reason:'Synthetic original-item return'})
const preview=(f,r)=>as(f,'pos_preview_return',r,f.binding)
const command=(r,p)=>({id:uid(),type:'refund.items',...r,quoteHash:p.quoteHash})
const execute=(f,c)=>as(f,'pos_execute_live_command',c,f.binding)
const full=(f,s)=>({id:uid(),type:'refund.full',branchId:f.branch,deviceId:f.device,shiftId:f.shift,orderId:s.invoice.orderId,reason:'Synthetic full return'})
const amount=(net,tax,discount=0)=>({beforeDiscountFils:net+tax+discount,discountFils:discount,grossFils:net+tax,netFils:net,taxFils:tax})
const vectors=[]
async function vector(f,s,lines,label){const before=await state(f,s),r=request(f,s,lines,before.revision),p=await preview(f,r),c=command(r,p),result=await execute(f,c),after=await state(f,s);vectors.push({label,state:before,request:r,preview:p,command:c,result,nextState:after});return {before,r,p,c,result,after}}
async function originalRows(){const result={};for(const table of ['pos_orders','pos_order_lines','pos_payments','pos_merchant_profiles','pos_stock_items','pos_stock_movements'])result[table]=hash(canonical(await scalar(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') from public.${table} x`)));result.invoices=hash(canonical(await scalar("select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from public.pos_documents x where kind='tax_invoice'")));return result}
async function allRows(){const result={};for(const row of (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows){assert.match(row.tablename,/^[a-z_]+$/);result[row.tablename]=hash(canonical(await scalar(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') from public.${row.tablename} x`)))}return result}

async function run(){
 await initialize();const f=await fixture(),old=await sale(f),oldFull=full(f,old),oldResult=await execute(f,oldFull);const s=await sale(f)
 const before=await allRows();await db.exec('begin');try{await db.exec(returnMigrationSql);await db.exec('commit')}catch(e){await db.exec('rollback');throw e}
 check(await allRows(),before,'migration preserves every populated prior public row')
 // SQL030 is owned and tested by the kitchen integrator; include it when present.
 const kitchen=new URL('../../supabase/migrations/20261016003000_pos_kitchen_returns.sql',import.meta.url)
 try{const sql=await readFile(kitchen,'utf8');report.migrationHashes['20261016003000_pos_kitchen_returns.sql']=hash(sql);await db.exec(sql);report.kitchenMigration='included'}catch(e){if(e.code!=='ENOENT')throw e;report.kitchenMigration='not-yet-present; kitchen semantics not claimed'}
 check((await execute(f,oldFull)).creditNote,oldResult.creditNote,'old full command replays unchanged')
 check((await state(f,old)).fullyReturned,true,'old full credit consumes all original quantities')
 const first=await state(f,s);check(first.returned,[{lineNumber:1,quantityMilli:0},{lineNumber:2,quantityMilli:0}],'state includes every original line including zero returned')
 check(first.adjustedTotals,amount(s.invoice.totals.netFils,s.invoice.totals.taxFils),'state original balances')
 const r=request(f,s,[{lineNumber:1,quantityMilli:1000},{lineNumber:2,quantityMilli:1}]),p=await preview(f,r),c=command(r,p),original=await originalRows()
 check(p.totals,amount(97,4),'hierarchical saved-price gross with original tax allocation')
 check(p.lines[0].originalLine,s.invoice.lines[0],'exact immutable original line evidence')
 check(p.quoteHash,hash(canonical(Object.fromEntries(Object.entries(p).filter(([k])=>k!=='quoteHash')))),'SQL canonical quote hash matches JavaScript')
 const applied=await execute(f,c);check(applied.creditNote.schemaVersion,3,'new v3 credit')
 vectors.push({label:'v1 mixed tender and one-gram selection',state:first,request:r,preview:p,command:c,result:applied,nextState:await state(f,s)})
 check(applied.creditNote.previousAdjustedTotals,first.adjustedTotals,'credit preserves supply before this adjustment')
 check((await execute(f,c)).creditNote,applied.creditNote,'exact committed item return replays')
 await rejects(execute(f,{...c,reason:'Changed after submit'}),/POS_IDEMPOTENCY_CONFLICT/,'changed payload conflicts')
 await rejects(preview(f,r),/POS_RETURN_STALE/,'old preview revision cannot return twice')
 await rejects(execute(f,full(f,s)),/POS_PRIOR_REFUND_EXISTS/,'historical full command does not over-refund partial return')
 check(await originalRows(),original,'partial return never changes original invoices orders payments profiles stock')
 const finalReq=request(f,s,[{lineNumber:1,quantityMilli:2000},{lineNumber:2,quantityMilli:332}],1),finalPreview=await preview(f,finalReq),finalCommand=command(finalReq,finalPreview),final=await execute(f,finalCommand),complete=await state(f,s)
 vectors.push({label:'v1 final remainder',state:vectors[0].nextState,request:finalReq,preview:finalPreview,command:finalCommand,result:final,nextState:complete})
 check(complete.adjustedTotals,amount(0,0),'final quantities exactly exhaust original components')
 check(complete.fullyReturned,true,'final quantity return completed')
 check(complete.refundedPayments,s.invoice.payments.slice().sort((a,b)=>a.method==='cash'?-1:1),'final tender allocation equals original')
 check(final.creditNote.previousAdjustedTotals,applied.creditNote.adjustedTotals,'second note starts at prior adjusted balance')
 check(final.creditNote.originalInvoice.documentId,s.invoice.id,'all credits link same original invoice')
 await rejects(preview(f,request(f,s,[{lineNumber:1,quantityMilli:1000}],2)),/POS_RETURN_QUANTITY/,'cumulative line cap')

 // Each undiscounted whole unit refunds its saved 101-fils price; only VAT residuals move.
 const whole=await sale(f,[{productId:f.product,quantityMilli:3000,expectedUnitPriceFils:101,expectedTaxRateBps:500}],137),wholeParts=[]
 for(let i=0;i<3;i++){const rq=request(f,whole,[{lineNumber:1,quantityMilli:1000}],i),pr=await preview(f,rq),cr=await execute(f,command(rq,pr));wholeParts.push(cr.creditNote.totals);check(cr.creditNote.totals.grossFils,101,'whole unit '+(i+1)+' returns its saved 101-fils price')}
 check(wholeParts.map(x=>x.taxFils),[4,5,5],'whole-unit tax residuals conserve original fourteen fils');check((await state(f,whole)).fullyReturned,true,'three whole-unit returns fully exhaust original quantities')
 const discountFixture=await fixture(),discountUnits=await offeredSale(discountFixture,101),discountParts=[]
 for(let i=0;i<3;i++){const rq=request(discountFixture,discountUnits,[{lineNumber:1,quantityMilli:1000}],i),pr=await preview(discountFixture,rq),cr=await execute(discountFixture,command(rq,pr));discountParts.push(cr.creditNote.totals)}
 check(discountParts.map(x=>x.beforeDiscountFils),[101,101,101],'discounted unit prefix keeps each saved before-discount price')
 check(discountParts.map(x=>x.discountFils),[33,34,34],'303-fils line with 101-fils discount allocates exact discount residuals')
 check(discountParts.map(x=>x.grossFils),[68,67,67],'discounted unit refunds conserve exact 202-fils gross')
 check((await state(discountFixture,discountUnits)).returned,[{lineNumber:1,quantityMilli:3000},{lineNumber:2,quantityMilli:0}],'discount allocation does not consume unselected original weight')

 const dup=await sale(f,[{productId:f.product,quantityMilli:1000,expectedUnitPriceFils:101,expectedTaxRateBps:500},{productId:f.product,quantityMilli:2000,expectedUnitPriceFils:101,expectedTaxRateBps:500}],100)
 await vector(f,dup,[{lineNumber:2,quantityMilli:1000}],'v1 duplicate product second original line');check((await state(f,dup)).returned,[{lineNumber:1,quantityMilli:0},{lineNumber:2,quantityMilli:1000}],'duplicate products retain separate original-line identity')
 const zero=await sale(f,[{productId:f.weight,quantityMilli:1000,expectedUnitPriceFils:103,expectedTaxRateBps:0}],0),zr=request(f,zero,[{lineNumber:1,quantityMilli:1}]),zp=await preview(f,zr),zc=command(zr,zp),za=await execute(f,zc)
 check(zp.totals,amount(0,0),'tiny weight return can have zero monetary value');check(za.creditNote.payments,[],'zero credit has empty payments');check(await scalar('select count(*)::int from public.pos_refunds where credit_document_id=$1',[za.creditNote.id]),0,'zero credit does not manufacture a payment row');check((await state(f,zero)).returned[0].quantityMilli,1,'zero credit still consumes quantity')
 vectors.push({label:'v1 zero-value one-gram return',state:{schemaVersion:1,invoice:zero.invoice,revision:0,returned:[{lineNumber:1,quantityMilli:0}],refundedPayments:[],adjustedTotals:amount(103,0),fullyReturned:false},request:zr,preview:zp,command:zc,result:za,nextState:await state(f,zero)})
 await vector(f,zero,[{lineNumber:1,quantityMilli:333}],'v1 weighted intermediate allocation');await vector(f,zero,[{lineNumber:1,quantityMilli:666}],'v1 weighted final residual')
 const discounted=await offeredSale(f,101),discountBefore=await originalRows(),redemptions=await scalar('select count(*)::int from public.pos_offer_redemptions where order_id=$1',[discounted.invoice.orderId])
 await vector(f,discounted,[{lineNumber:1,quantityMilli:1000}],'v2 partial saved discount');await vector(f,discounted,[{lineNumber:1,quantityMilli:1000},{lineNumber:2,quantityMilli:333}],'v2 mixed quantity partial');await vector(f,discounted,[{lineNumber:1,quantityMilli:1000},{lineNumber:2,quantityMilli:667}],'v2 final original allocation')
 check(await originalRows(),discountBefore,'discounted returns preserve all original financial and stock rows');check(await scalar('select count(*)::int from public.pos_offer_redemptions where order_id=$1',[discounted.invoice.orderId]),redemptions,'returns do not restore offer redemption limit')
 const free=await offeredSale(f,303);await vector(f,free,[{lineNumber:1,quantityMilli:1000}],'v2 free item quantity-only credit');const freePaid=await vector(f,free,[{lineNumber:2,quantityMilli:1000}],'v2 paid line returned with free quantities remaining');check(freePaid.after.adjustedTotals.grossFils,0,'paid value exhausted before all quantities');check(freePaid.after.fullyReturned,false,'free remaining quantity prevents premature full return');const freeFinal=await vector(f,free,[{lineNumber:1,quantityMilli:2000}],'v2 final free quantity-only credit');check(freeFinal.after.fullyReturned,true,'all free and paid quantities finally returned')
 const discountFull=await offeredSale(f,101),discountFullCommand=full(f,discountFull),discountFullResult=await execute(f,discountFullCommand);check((await state(f,discountFull)).fullyReturned,true,'legacy v2 full credit remains recognized');check((await execute(f,discountFullCommand)).creditNote,discountFullResult.creditNote,'legacy discounted full replay remains exact')
 const nativeFixture=await fixture(),native=await importedSale(nativeFixture),nativeOriginal=await scalar('select to_jsonb(r) from public.pos_offline_receipts r where issuance_id=$1',[native.invoice.orderId]),nativeAuthority=await scalar('select to_jsonb(a) from public.pos_offline_authorities a where id=$1',[native.authorityId]);await vector(nativeFixture,native,[{lineNumber:1,quantityMilli:1000}],'native imported invoice online return');check(await scalar('select to_jsonb(r) from public.pos_offline_receipts r where issuance_id=$1',[native.invoice.orderId]),nativeOriginal,'return preserves imported signed receipt and ACK');check(await scalar('select to_jsonb(a) from public.pos_offline_authorities a where id=$1',[native.authorityId]),nativeAuthority,'return does not restore or mutate original native authority');check(await scalar('select count(*)::int from public.pos_kitchen_tickets where order_id=$1',[native.invoice.orderId]),0,'imported native return creates no kitchen replay')
 if(report.kitchenMigration==='included')check(await scalar('select count(*)::int from public.pos_kitchen_return_notices where order_id=$1',[native.invoice.orderId]),0,'native imported return creates no kitchen notice')
 // Read and quote must continue using the frozen invoice after current catalogue edits.
 const immutable=await sale(f),immReq=request(f,immutable,[{lineNumber:1,quantityMilli:1000}]),immPreview=await preview(f,immReq)
 await db.query("update public.pos_products set name='Changed synthetic menu',unit_price_fils=9999,tax_rate_bps=0 where id=$1",[f.product]);check(await preview(f,immReq),immPreview,'current product name price and VAT cannot reprice return');await execute(f,command(immReq,immPreview));await db.query("update public.pos_products set name='Synthetic piece',unit_price_fils=101,tax_rate_bps=500 where id=$1",[f.product])

 const invalid=await sale(f)
 for(const [change,pattern,name] of [
  [{lines:[{lineNumber:1,quantityMilli:1}]},/POS_RETURN_QUANTITY/,'fractional piece'],[{lines:[{lineNumber:2,quantityMilli:334}]},/POS_RETURN_QUANTITY/,'excess weight'],
  [{lines:[{lineNumber:1,quantityMilli:1000},{lineNumber:1,quantityMilli:1000}]},/POS_RETURN_QUANTITY/,'duplicate line'],[{lines:[{lineNumber:2,quantityMilli:1},{lineNumber:1,quantityMilli:1000}]},/POS_RETURN_QUANTITY/,'unsorted lines'],
  [{lines:[{lineNumber:0,quantityMilli:1000}]},/POS_RETURN_QUANTITY/,'invalid line'],[{reason:' '} ,/POS_INVALID_COMMAND/,'blank reason'],[{expectedRevision:1},/POS_RETURN_STALE/,'wrong revision'],[{invoiceId:uid()},/POS_RETURN_STALE/,'wrong invoice']])
  await rejects(preview(f,{...request(f,invalid,[{lineNumber:1,quantityMilli:1000}]),...change}),pattern,name)
 const ir=request(f,invalid,[{lineNumber:1,quantityMilli:1000}]),ip=await preview(f,ir),ic=command(ir,ip)
 const emptyCounter=await secondCounter(f);await rejects(preview(emptyCounter,{...ir,deviceId:emptyCounter.device,shiftId:emptyCounter.shift}),/POS_INSUFFICIENT_CASH/,'manager own empty second drawer cannot fund cash return')
 await db.query("update public.pos_shifts set opened_by=$2 where id=$1",[emptyCounter.shift,f.cashier]);await rejects(preview(emptyCounter,{...ir,deviceId:emptyCounter.device,shiftId:emptyCounter.shift}),/POS_SHIFT_INVALID/,'manager cannot refund from another staff shift');await db.query('update public.pos_shifts set opened_by=$2 where id=$1',[emptyCounter.shift,f.owner])
 await rejects(execute(f,{...ic,quoteHash:'0'.repeat(64)}),/POS_RETURN_STALE/,'tampered quote hash')
 await rejects(as({...f,owner:f.cashier},'pos_return_state',f.branch,f.device,invalid.invoice.orderId,f.binding),/POS_MANAGER_REQUIRED/,'cashier cannot read manager returns')
 const outsider=await fixture();await rejects(as(outsider,'pos_return_state',f.branch,outsider.device,invalid.invoice.orderId,outsider.binding),/POS_ACCESS_DENIED/,'cross tenant denied')
 await rejects(preview(f,{...ir,shiftId:outsider.shift}),/POS_SHIFT_INVALID/,'foreign shift denied');await rejects(as(f,'pos_preview_return',ir,hash(uid())),/POS_DEVICE_INVALID/,'wrong binding denied')
 await db.query("update public.pos_shifts set opening_cash_fils=0 where id=$1",[f.shift])
 const poor=await fixture();await db.query('update public.pos_shifts set opening_cash_fils=0 where id=$1',[poor.shift]);await rejects(preview({...f,device:poor.device,shift:poor.shift,binding:poor.binding},{...ir,deviceId:poor.device,shiftId:poor.shift}),/POS_DEVICE_INVALID/,'foreign counter cannot draw refund')
 await db.query('update public.pos_shifts set opening_cash_fils=100000 where id=$1',[f.shift])
 await db.exec("create function public.synthetic_return_fail() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_RETURN_FAILURE';end$$;create trigger synthetic_return_fail before insert on public.pos_command_receipts for each row execute function public.synthetic_return_fail()")
 const snapshot=await allRows();await rejects(execute(f,ic),/SYNTHETIC_RETURN_FAILURE/,'injected failure after document and tender writes');check(await allRows(),snapshot,'failure rolls back all rows counters kitchen and tender');await db.exec('drop trigger synthetic_return_fail on public.pos_command_receipts;drop function public.synthetic_return_fail()')
 const recovered=await execute(f,ic);await db.query("update public.pos_shifts set status='closed',closed_at=now() where id=$1",[f.shift]);check((await execute(f,ic)).creditNote,recovered.creditNote,'exact replay after shift close')
 await db.query('update public.pos_device_bindings set revoked_at=now() where token_hash=$1',[f.binding]);check((await as(f,'pos_resolve_live_request','command',ic,f.binding)).creditNote,recovered.creditNote,'historical replay after original binding revoked')
 await db.query('update public.pos_staff set active=false where organization_id=$1 and user_id=$2',[f.org,f.owner]);check((await as(f,'pos_lookup_own_committed_request','command',ic,f.binding)).creditNote,recovered.creditNote,'disabled original actor can recover exact committed result')
 await rejects(as(f,'pos_lookup_own_committed_request','command',{...ic,id:uid()},f.binding),/POS_STAFF_INACTIVE/,'disabled actor cannot infer unsaved request success')
 await db.query('update public.pos_staff set active=true where organization_id=$1 and user_id=$2',[f.org,f.owner]);await db.query('update public.pos_device_bindings set revoked_at=null where token_hash=$1',[f.binding]);await db.query("update public.pos_shifts set status='open',closed_at=null where id=$1",[f.shift])
 const cancel={...ic,id:uid()};check((await as(f,'pos_resolve_live_request','command',cancel,f.binding)).status,'cancelled','unknown exact return gets immutable tombstone');await rejects(execute(f,cancel),/POS_REQUEST_CANCELLED/,'late cancelled request cannot commit')

 if(postgres){
  const rf=await fixture(),rs=await sale(rf),rr=request(rf,rs,[{lineNumber:1,quantityMilli:1000}]),rp=await preview(rf,rr),rc=command(rr,rp)
  let race=await raced('return_same_request',a=>rpcOn(a,'pos_execute_live_command',rc,rf.binding),b=>rpcOn(b,'pos_execute_live_command',rc,rf.binding),{firstRole:'authenticated',secondRole:'authenticated',actor:rf.owner});check(race.first.creditNote,race.second.value.creditNote,'concurrent identical requests share one credit')
  const r2=request(rf,rs,[{lineNumber:1,quantityMilli:2000}],1),p2=await preview(rf,r2),c2=command(r2,p2)
  race=await raced('return_competing_quantity',a=>rpcOn(a,'pos_execute_live_command',c2,rf.binding),b=>rpcOn(b,'pos_execute_live_command',{...c2,id:uid()},rf.binding),{firstRole:'authenticated',secondRole:'authenticated',actor:rf.owner});check(race.second.error,'POS_RETURN_STALE','competing operation must refresh state')
  const cs=await sale(rf),cr=request(rf,cs,[{lineNumber:1,quantityMilli:1000}]),cp=await preview(rf,cr),cc=command(cr,cp)
  race=await raced('return_cancel_commit',a=>rpcOn(a,'pos_resolve_live_request','command',cc,rf.binding),b=>rpcOn(b,'pos_execute_live_command',cc,rf.binding),{firstRole:'authenticated',secondRole:'authenticated',actor:rf.owner});check(race.second.error,'POS_REQUEST_CANCELLED','cancellation defeats delayed commit')
  race=await raced('return_full_partial',a=>rpcOn(a,'pos_execute_live_command',full(rf,cs),rf.binding),b=>rpcOn(b,'pos_execute_live_command',{...cc,id:uid()},rf.binding),{firstRole:'authenticated',secondRole:'authenticated',actor:rf.owner});check(race.second.error,'POS_RETURN_STALE','full return serializes with partial return')
  const cross=await sale(rf),counter=await secondCounter(rf,100000),rA=request(rf,cross,[{lineNumber:1,quantityMilli:2000}]),rB=request(counter,cross,[{lineNumber:1,quantityMilli:2000}]),cA=command(rA,await preview(rf,rA)),cB=command(rB,await preview(counter,rB))
  race=await raced('return_cross_device',a=>rpcOn(a,'pos_execute_live_command',cA,rf.binding),b=>rpcOn(b,'pos_execute_live_command',cB,counter.binding),{firstRole:'authenticated',secondRole:'authenticated',actor:rf.owner});check(race.second.error,'POS_RETURN_STALE','different counters cannot over-return the same original line')
  for(const [name,sql,params,error]of [
   ['branch',"update public.pos_branches set active=false where id=$1",[rf.branch],'POS_ACCESS_DENIED'],
   ['device',"update public.pos_devices set active=false where id=$1",[rf.device],'POS_DEVICE_INVALID'],
   ['binding',"update public.pos_device_bindings set revoked_at=now() where token_hash=$1",[rf.binding],'POS_DEVICE_INVALID'],
  ]){
   const x=await sale(rf),r=request(rf,x,[{lineNumber:1,quantityMilli:1000}]),c=command(r,await preview(rf,r))
   race=await raced('return_revoke_'+name,async a=>{await a.query(sql,params);return 'revoked'},b=>rpcOn(b,'pos_execute_live_command',c,rf.binding),{firstRole:null,secondRole:'authenticated',actor:rf.owner});check(race.second.error,error,'concurrent '+name+' revoke prevents new return')
   if(name==='branch')await db.query('update public.pos_branches set active=true where id=$1',[rf.branch]);if(name==='device')await db.query('update public.pos_devices set active=true where id=$1',[rf.device]);if(name==='binding')await db.query('update public.pos_device_bindings set revoked_at=null where token_hash=$1',[rf.binding])
  }
  const cashSale=await sale(rf),cashCounter=await secondCounter(rf,100),cashRequest=request(cashCounter,cashSale,[{lineNumber:1,quantityMilli:1000}]),cashCommand=command(cashRequest,await preview(cashCounter,cashRequest)),withdraw={id:uid(),type:'cash.move',branchId:rf.branch,deviceId:cashCounter.device,shiftId:cashCounter.shift,amountFils:-100,reason:'Synthetic competing withdrawal'}
  race=await raced('return_drawer_withdrawal',a=>rpcOn(a,'pos_execute_live_command',withdraw,cashCounter.binding),b=>rpcOn(b,'pos_execute_live_command',cashCommand,cashCounter.binding),{firstRole:'authenticated',secondRole:'authenticated',actor:rf.owner});check(race.second.error,'POS_INSUFFICIENT_CASH','concurrent withdrawal and refund cannot spend same drawer balance')
  const revoked=await fixture(),revokedSale=await sale(revoked),revokedRequest=request(revoked,revokedSale,[{lineNumber:1,quantityMilli:1000}]),revokedCommand=command(revokedRequest,await preview(revoked,revokedRequest)),admin=uid(),adminBinding=hash(uid())
  await db.query("insert into auth.users values($1,'synthetic-returns-admin@example.test',now())",[admin]);await db.query("insert into public.pos_staff(organization_id,user_id,role) values($1,$2,'owner')",[revoked.org,admin]);await db.query("update public.pos_staff set role='manager' where organization_id=$1 and user_id=$2",[revoked.org,revoked.owner]);await db.query('insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)',[adminBinding,admin,revoked.org,revoked.branch,revoked.device])
  const revoke={id:uid(),branchId:revoked.branch,deviceId:revoked.device,targetUserId:revoked.owner,expectedRevision:1,role:'manager',assignedBranchId:null,active:false,displayName:'Synthetic return manager',reason:'Synthetic authority race'}
  race=await raced('return_staff_revocation',async a=>{
   // Production staff revocation intentionally requires the manager to close their shift first.
   await rpcOn(a,'pos_execute_live_command',{id:uid(),type:'shift.close',branchId:revoked.branch,deviceId:revoked.device,shiftId:revoked.shift,countedCashFils:0},revoked.binding)
   await a.query("select set_config('app.user_id',$1,true)",[admin]);return rpcOn(a,'pos_manage_staff',revoke,adminBinding)
  },b=>rpcOn(b,'pos_execute_live_command',revokedCommand,revoked.binding),{firstRole:'authenticated',secondRole:'authenticated',actor:revoked.owner});check(race.first.status,'updated','real staff writer revokes manager after own shift close');check(race.second.error,'POS_ACCESS_DENIED','waiting item return sees revoked manager authority')
 }
 const legacy=await sale(f);await db.query("insert into public.pos_refunds(id,organization_id,branch_id,order_id,device_id,shift_id,actor_id,method,amount_fils,reason) values($1,$2,$3,$4,$5,$6,$7,'cash',1,'Synthetic unsupported old amount-only refund')",[uid(),f.org,f.branch,legacy.invoice.orderId,f.device,f.shift,f.owner]);await rejects(state(f,legacy),/POS_RETURN_UNAVAILABLE/,'unsupported old amount-only refund fails closed')
 // Actual SQL conservation over many bounded quantity partitions and maximum safe money.
 let allocations=0
 for(const [net,tax,discount,q]of [[0,0,0,11],[0,0,7,11],[1,1,1,7],[9,4,8,17],[95238095,4761905,0,1000000],[0,0,100000000,1000000],...Array.from({length:25},(_,i)=>[i,Math.floor(i/3),25-i,2+i%11])]){
  const line={quantityMilli:q,netFils:net,taxFils:tax,discountFils:discount},points=q>100?[0,1,333333,777777,q]:Array.from({length:q+1},(_,i)=>i);let sums=amount(0,0)
  for(let i=1;i<points.length;i++){const delta=await rpcOn(db,'pos_return_delta',line,points[i-1],points[i]);for(const field of Object.keys(sums)){assert(delta[field]>=0);sums[field]+=delta[field]}allocations++}
  assert.deepEqual(sums,amount(net,tax,discount))
 }
 report.sqlAllocationPartitions=allocations;report.checks.push('actual SQL bounded partition allocations conserve all components with nonnegative deltas')
 // Exhaust every small valid original component tuple and quantity partition in actual SQL.
 const properties=await scalar(`with deltas as materialized (
 select b,d,t,q,k,public.pos_return_delta(jsonb_build_object('quantityMilli',q,'netFils',b-d-t,'taxFils',t,'discountFils',d),k-1,k) a
 from generate_series(0,20)b cross join lateral generate_series(0,b)d cross join lateral generate_series(0,b-d)t cross join generate_series(1,9)q cross join lateral generate_series(1,q)k),
 groups as (select b,d,t,q,count(*) parts,
 bool_and((a->>'beforeDiscountFils')::bigint>=0 and (a->>'discountFils')::bigint>=0 and (a->>'grossFils')::bigint>=0 and (a->>'netFils')::bigint>=0 and (a->>'taxFils')::bigint>=0
 and (a->>'beforeDiscountFils')::bigint-(a->>'discountFils')::bigint=(a->>'grossFils')::bigint and (a->>'netFils')::bigint+(a->>'taxFils')::bigint=(a->>'grossFils')::bigint) valid,
 sum((a->>'beforeDiscountFils')::bigint) sb,sum((a->>'discountFils')::bigint) sd,sum((a->>'grossFils')::bigint) sg,sum((a->>'netFils')::bigint) sn,sum((a->>'taxFils')::bigint) st
 from deltas group by b,d,t,q)
 select jsonb_build_object('partitions',sum(parts),'originalCases',count(*),'valid',bool_and(valid and sb=b and sd=d and sg=b-d and sn=b-d-t and st=t)) from groups`)
 check(properties.valid,true,'exhaustive small SQL original amounts and quantities have nonnegative deltas and exact component conservation');report.sqlExhaustiveProperties=properties
 const day=await scalar("select (clock_timestamp() at time zone 'Asia/Dubai')::date::text"),branchReport=await as(f,'pos_branch_report',f.branch,day,day)
 check(branchReport.summary.refundGrossFils,Number(await scalar("select coalesce(sum((snapshot#>>'{totals,grossFils}')::bigint),0) from public.pos_documents where branch_id=$1 and kind='tax_credit_note'",[f.branch])),'branch report includes actual cumulative partial credit values')
 for(const method of ['cash','card'])check(branchReport.payments.find(p=>p.method===method).refundsFils,Number(await scalar('select coalesce(sum(amount_fils),0) from public.pos_refunds where branch_id=$1 and method=$2 and credit_document_id is not null',[f.branch,method])),'branch report '+method+' agrees with recorded fiscal tender refunds')
 for(const product of branchReport.products)check(product.refundedQuantityMilli,Number(await scalar("select coalesce(sum((l->>'quantityMilli')::bigint),0) from public.pos_documents d cross join lateral jsonb_array_elements(d.snapshot->'lines') l where d.branch_id=$1 and d.kind='tax_credit_note' and l->>'productId'=$2",[f.branch,product.productId])),'report quantities include zero-value returns for '+product.productId)
 const expectedCash=Number(await scalar("select s.opening_cash_fils+coalesce((select sum(p.amount_fils) from public.pos_payments p join public.pos_orders o on o.id=p.order_id where o.shift_id=s.id and p.method='cash'),0)+coalesce((select sum(amount_fils) from public.pos_cash_movements where shift_id=s.id),0)-coalesce((select sum(amount_fils) from public.pos_refunds where shift_id=s.id and method='cash'),0) from public.pos_shifts s where s.id=$1",[f.shift]))
 const closed=await as(f,'pos_execute_live_command',{id:uid(),type:'shift.close',branchId:f.branch,deviceId:f.device,shiftId:f.shift,countedCashFils:expectedCash},f.binding);check(closed.expectedCashFils,expectedCash,'real shift close reconciles mixed partial returns and prior cash records')
 // New private helpers stay inaccessible through browser direct RPC.
 for(const fn of ['pos_return_state_locked(uuid,uuid,uuid)','pos_return_context(uuid,uuid,uuid,uuid,text)','pos_return_delta(jsonb,bigint,bigint)','pos_execute_live_command_before_item_returns(jsonb)','pos_execute_live_command_unbound(jsonb)'])check(await scalar('select has_function_privilege($1,$2,$3)',['authenticated','public.'+fn,'EXECUTE']),false,'private '+fn)
 report.status='passed'
}
try{await run()}catch(error){report.status='failed';report.error=error.stack;throw error}finally{
 for(const client of sessions)await client.end().catch(()=>{});if(db){if(postgres)await db.end();else await db.close()}
 if(control){if(ownedDatabase){await control.query(`drop database ${database}`);check(await scalar('select exists(select 1 from pg_database where datname=$1)',[database],control),false,'owned test database dropped');report.cleanup='verified-dropped'}await control.end()}
 report.finishedAt=new Date().toISOString();await save();if(reportPath)await writeFile(new URL('actual-documents.json',pathToFileURL(reportPath)),JSON.stringify({syntheticOnly:true,status:report.status,vectors},null,2)+'\n',{mode:0o600})
}
console.log(`PASS ${report.checks.length} checks; ${report.races.length} observed races`)
