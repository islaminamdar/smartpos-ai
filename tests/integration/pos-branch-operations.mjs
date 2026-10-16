// Synthetic disposable SQL024 manager operations read-only tests. No real merchants, provider calls or signature claims.
// Usage: node this.mjs /absolute/pglite/dist/index.js [report.json]
// Or: node this.mjs --postgres /absolute/pg/lib/index.js /private/unix/socket [report.json]
// PostgreSQL mode creates/drops its own unique DB; never accepts a database URL or TCP host.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { userInfo } from 'node:os'
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) return nextResolve(new URL('../../' + specifier.slice(2) + '.ts', import.meta.url).href, context)
  return nextResolve(specifier, context)
} })
const { branchOperationsSchema } = await import('../../lib/pos/operations/contracts.ts')
const fixtures = {}

const postgres = process.argv[2] === '--postgres'
const reportPath = process.argv[postgres ? 5 : 3]
const report = { startedAt: new Date().toISOString(), backend: postgres ? 'PostgreSQL' : 'PGlite (not true concurrency)', productionTouched: false, checks: [], races: [], migrationHashes: {}, cleanup: 'pending' }
let db, control, Client, database, config
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
    database = 'pos_qa_operations_' + uid().replaceAll('-', '')
    await control.query(`create database ${database}`)
    report.database = database
    db = new Client({ ...config, database }); await db.connect(); db.exec = sql => db.query(sql)
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
  const files = (await readdir(directory)).filter(f => /^20261016/.test(f) && !f.includes('007') && !f.includes('009') && f < '202610160025').sort()
  for (const file of files) { const sql = await readFile(new URL(file, directory), 'utf8'); report.migrationHashes[file] = hash(sql); await db.exec(sql) }
  await save()
}

async function fixture(withAuthority = false) {
  const f = Object.fromEntries(['owner', 'org', 'branch', 'profile', 'product', 'device', 'shift'].map(k => [k, uid()]))
  const { owner, org, branch, profile, product, device, shift } = f
  f.binding = hash(uid())
  await db.exec(`insert into auth.users(id,email,email_confirmed_at) values('${owner}','freeze-test@example.test',now());
    insert into public.pos_organizations values('${org}','Synthetic freeze audit',now());
    insert into public.pos_branches(id,organization_id,name) values('${branch}','${org}','Synthetic branch');
    insert into public.pos_staff(organization_id,user_id,branch_id,role) values('${org}','${owner}',null,'owner');
    insert into public.pos_devices(id,organization_id,branch_id,name) values('${device}','${org}','${branch}','Synthetic counter');
    insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values('${f.binding}','${owner}','${org}','${branch}','${device}');
    insert into public.pos_shifts(id,organization_id,branch_id,device_id,opened_by,opening_cash_fils) values('${shift}','${org}','${branch}','${device}','${owner}',0);
    insert into public.pos_merchant_profiles(id,organization_id,branch_id,legal_name,branch_name,address,phone,trn,tax_registered,tax_inclusive,confirmed_by) values('${profile}','${org}','${branch}','Synthetic legal','Synthetic branch','Synthetic address','Synthetic phone','100000000000001',true,true,'${owner}');
    insert into public.pos_branch_receipt_config values('${branch}','${org}','${profile}','TEST',true);
    insert into public.pos_products(id,organization_id,branch_id,name,category,unit_price_fils,tax_rate_bps) values('${product}','${org}','${branch}','Synthetic product','Test',1000,500);
    insert into public.pos_offline_branch_policy(branch_id,enabled) values('${branch}',true);`)
  if (!withAuthority) return f
  const key = Buffer.from('synthetic-key-' + uid()), requestId = uid(), deviceKeySha256 = hash(key)
  f.enrollment = await service('pos_offline_enroll', owner, { requestId, branchId: branch, deviceId: device, publicKeySpki: key.toString('base64url'), deviceKeySha256,
    proof: envelope({ kind: 'offline-enrollment', schemaVersion: 1, requestId, branchId: branch, deviceId: device, actorId: owner, deviceKeySha256, issuedAt: new Date().toISOString() }, deviceKeySha256) })
  f.request = { requestId: uid(), branchId: branch, deviceId: device, shiftId: shift, count: 3, lifetimeSeconds: 60, maxInvoiceTotalFils: 100000, maxGrossFils: 300000, permissions: { cash: true, recordedCard: true, mixedTender: true } }
  const draft = await service('pos_offline_reserve', owner, f.request), snapshotEnvelope = envelope(draft.snapshot)
  f.bundle = await service('pos_offline_attach', draft.authority.id, snapshotEnvelope, envelope({ ...draft.authority, snapshotSha256: eh(snapshotEnvelope) }))
  return f
}
function sale(f, extra = {}) {
  const b = f.bundle, a = b.authority, id = uid(), issuedAt = a.issuedAt
  return { kind: 'offline-sale', schemaVersion: 1, id, authorityId: a.id, authoritySha256: b.authoritySha256, snapshotSha256: b.snapshotSha256, deviceSequence: 1, previousEventSha256: null,
    document: { schemaVersion: 1, id: uid(), kind: 'tax_invoice', documentNumber: `${a.invoiceRange.prefix}-INV-${String(a.invoiceRange.first).padStart(10, '0')}`, issuedAt, merchant: b.snapshot.profile, orderId: id, branchId: f.branch, deviceId: f.device, shiftId: f.shift, actorId: f.owner, serviceType: 'takeaway', customer: null,
      lines: [{ lineNumber: 1, productId: f.product, name: 'Synthetic product', unit: 'piece', quantityMilli: 1000, unitPriceFils: 1000, taxRateBps: 500, grossFils: 1000, netFils: 952, taxFils: 48 }], totals: { grossFils: 1000, netFils: 952, taxFils: 48 }, payments: [{ method: 'cash', amountFils: 1000 }], paymentSettlement: 'recorded', cashTenderedFils: 1500, changeFils: 500 },
    clock: { estimatedServerAt: issuedAt, bootId: uid(), elapsedRealtimeMs: 1234 }, paymentIntentId: uid(), ...extra }
}
function importArgs(f, payload, signature) {
  const signed = envelope(payload, f.bundle.authority.deviceKeySha256, signature)
  const ack = envelope({ kind: 'offline-ack', schemaVersion: 1, id: uid(), issuanceId: payload.id, payloadSha256: eh(signed), authorityId: f.bundle.authority.id, keyEpoch: f.enrollment.keyEpoch, deviceSequence: payload.deviceSequence, receivedAt: new Date().toISOString() })
  return [f.bundle.authority.id, signed, ack]
}
function freeze(f, issued = sale(f), changes = {}) {
  const a = f.bundle.authority
  const request = { authorityId: a.id, serviceType: 'takeaway', customer: null, lines: [{ productId: f.product, quantityMilli: 1000 }], cashTenderedFils: 1500, recordedCardFils: 0, presentedTotalFils: 1000 }
  return { kind: 'offline-payment-freeze', schemaVersion: 1, freezeId: uid(), paymentIntentId: issued.paymentIntentId, orderId: issued.id, documentId: issued.document.id,
    organizationId: f.org, branchId: f.branch, deviceId: f.device, actorId: f.owner, shiftId: f.shift, keyEpoch: f.enrollment.keyEpoch, deviceKeySha256: a.deviceKeySha256,
    authorityId: a.id, authoritySha256: f.bundle.authoritySha256, snapshotSha256: f.bundle.snapshotSha256, requestSha256: hash(canonical(request)), request, intentCreatedAt: a.issuedAt,
    chainHead: { sequence: 0, eventSha256: null }, observation: null, declaration: 'local-intent-unissued-and-permanently-frozen', ...changes }
}
const signedFreeze = (f, value, signature) => envelope(value, f.bundle.authority.deviceKeySha256, signature)
const register = (f, value, signature) => service('pos_offline_payment_freeze', signedFreeze(f, value, signature))
function sealArgs(f, sequence = 0, event = null) {
  const a = f.bundle.authority, proof = { kind: 'offline-seal', schemaVersion: 1, id: uid(), authorityId: a.id, keyEpoch: a.keyEpoch, deviceId: f.device, finalSequence: sequence, finalEventSha256: event }
  return [a.id, sequence, event, envelope(proof, a.deviceKeySha256)]
}
async function raced(name, firstOperation, secondOperation, { firstRole = 'service_role', secondRole = 'service_role', actor } = {}) {
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
    await a.query('commit'); second = await task
    await b.query(second.error ? 'rollback' : 'commit')
    const evidence = { name, first, second, blockingObserved: wait }
    report.races.push(evidence); await save(); return evidence
  } finally { await a.query('rollback').catch(() => {}); await b.query('rollback').catch(() => {}); await a.end(); await b.end(); sessions.splice(sessions.indexOf(a), 1); sessions.splice(sessions.indexOf(b), 1) }
}

const auth = async (f,name,...args) => { await db.query("select set_config('app.user_id',$1,false)",[f.owner]);await db.exec('set role authenticated');try{return await rpcOn(db,name,...args)}finally{await db.exec('reset role')} }
const command = (f,counted=0) => ({id:uid(),type:'shift.close',branchId:f.branch,deviceId:f.device,shiftId:f.shift,countedCashFils:counted})
const execute = (f,c) => auth(f,'pos_execute_live_command',c,f.binding)
async function ledger(f){const result={};for(const table of ['pos_shifts','pos_command_receipts','pos_request_cancellations','pos_orders','pos_documents','pos_payments','pos_refunds','pos_cash_movements','pos_audit_events'])result[table]=await scalar(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from public.${table} x where organization_id=$1`,[f.org]);return result}

const operations = async f => branchOperationsSchema.parse(await auth(f, 'pos_branch_operations', f.branch))
async function addStaff(f,role,branch=f.branch){const actor=uid();await db.query('insert into auth.users values($1,$2,now())',[actor,'synthetic-'+actor+'@example.test']);await db.query('insert into public.pos_staff(organization_id,user_id,branch_id,role) values($1,$2,$3,$4)',[f.org,actor,branch,role]);return actor}
async function addShifts(f,n,closed=false){
 for(let i=0;i<n;i++){const device=uid(),shift=uid();await db.query('insert into public.pos_devices(id,organization_id,branch_id,name) values($1,$2,$3,$4)',[device,f.org,f.branch,'Synthetic counter '+i]);
 await db.query(`insert into public.pos_shifts(id,organization_id,branch_id,device_id,opened_by,opening_cash_fils,opened_at,status,closed_at,counted_cash_fils,expected_cash_fils,cash_difference_fils) values($1,$2,$3,$4,$5,100,now()-interval '2 days',$6,${closed?"now()-interval '1 hour'":"null"},$7,$8,$9)`,[shift,f.org,f.branch,device,f.owner,closed?'closed':'open',closed?100:null,closed?120:null,closed?-20:null]);}
}
async function addTabs(f,n,total=1000){return (await db.query(`insert into public.pos_open_tabs(id,organization_id,branch_id,label,service_type,note,lines,request_lines,subtotal_fils,tax_fils,created_by,updated_by,created_at) select gen_random_uuid(),$1,$2,'Synthetic tab '||i,'takeaway','Private note not exported','[]','[]',$4,0,$3,$3,now()-interval '3 days'+i*interval '1 second' from generate_series(1,$5) i returning id`,[f.org,f.branch,f.owner,total,n])).rows.map(x=>x.id)}
let documentNumber=0
async function document(f,time,gross=1050,payments=[{method:'cash',amountFils:gross}],original=null,connection=db){
 const order=original?.order??uid(),id=uid(),kind=original?'tax_credit_note':'tax_invoice',tax=Math.round(gross*500/10500);
 if(!original)await connection.query(`insert into public.pos_orders(id,organization_id,branch_id,device_id,shift_id,created_by,client_created_at,received_at,service_type,total_fils,tax_fils,request_payload) values($1,$2,$3,$4,$5,$6,$7,$7,'takeaway',$8,$9,'{}')`,[order,f.org,f.branch,f.device,f.shift,f.owner,time,gross,tax]);
 const snapshot={schemaVersion:1,id,kind,documentNumber:'TEST-'+(original?'CN':'INV')+'-'+String(++documentNumber).padStart(10,'0'),issuedAt:time,branchId:f.branch,orderId:order,serviceType:'takeaway',customer:{name:'Private synthetic buyer must not be exported'},lines:[{lineNumber:1,productId:f.product,name:'Historical sweet',unit:'piece',quantityMilli:1000,unitPriceFils:99999,taxRateBps:500,grossFils:gross,netFils:gross-tax,taxFils:tax}],totals:{grossFils:gross,netFils:gross-tax,taxFils:tax},payments,cashTenderedFils:99000,changeFils:97950};
 await connection.query('insert into public.pos_documents(id,organization_id,branch_id,order_id,actor_id,kind,document_number,issued_at,request_payload,snapshot) values($1,$2,$3,$4,$5,$6,$7,$8,\'{}\',$9::jsonb)',[id,f.org,f.branch,order,f.owner,kind,snapshot.documentNumber,time,JSON.stringify(snapshot)]);return{order,id,snapshot}
}
async function dates(){return await scalar(`select jsonb_build_object('date',(statement_timestamp() at time zone 'Asia/Dubai')::date,'start',to_char(((statement_timestamp() at time zone 'Asia/Dubai')::date::timestamp at time zone 'Asia/Dubai') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'before',to_char((((statement_timestamp() at time zone 'Asia/Dubai')::date::timestamp at time zone 'Asia/Dubai')-interval '1 microsecond') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'endBefore',to_char(((((statement_timestamp() at time zone 'Asia/Dubai')::date+1)::timestamp at time zone 'Asia/Dubai')-interval '1 microsecond') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'end',to_char((((statement_timestamp() at time zone 'Asia/Dubai')::date+1)::timestamp at time zone 'Asia/Dubai') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`)}
async function scenarios(){
 let f=await fixture(),r=await operations(f);fixtures.empty=r;check(r.sales.documentCount,0,'empty recorded sales are zero');check(r.offlineDeviceCoverage,'unknown','empty server still cannot assert local completeness');check(r.openShifts.totalCount,1,'empty drawer visible before first allocation');check(r.closedShifts.netDifferenceFils,0,'no closed rows is known zero');check(r.unpaidOrders.oldestCreatedAt,null,'empty tabs have no oldest timestamp');check(r.basis,'server_recorded','basis explicit');
 const before=await ledger(f);await operations(f);check(await ledger(f),before,'report does not write ledger or audits');
 const sibling=uid();await db.query('insert into public.pos_branches(id,organization_id,name) values($1,$2,\'Sibling\')',[sibling,f.org]);
 const manager=await addStaff(f,'manager'),cashier=await addStaff(f,'cashier'),orgManager=await addStaff(f,'manager',null),siblingManager=await addStaff(f,'manager',sibling);
 check((await operations({...f,owner:manager})).branchId,f.branch,'branch manager allowed');check((await operations({...f,owner:orgManager})).branchId,f.branch,'organization manager allowed');
 for(const [actor,name] of [[cashier,'cashier'],[siblingManager,'sibling manager'],[uid(),'nonmember']])await rejects(()=>operations({...f,owner:actor}),/POS_(OPERATIONS_ACCESS_DENIED|ACCESS_DENIED)/,name+' denied');
 const foreign=await fixture();await rejects(()=>operations({...f,owner:foreign.owner}),/POS_ACCESS_DENIED/,'other tenant denied');
 await db.query('update public.pos_staff set active=false where user_id=$1',[manager]);await rejects(()=>operations({...f,owner:manager}),/POS_ACCESS_DENIED/,'revoked manager denied');
 await db.query('update public.pos_branches set active=false where id=$1',[f.branch]);await rejects(()=>operations(f),/POS_ACCESS_DENIED/,'inactive branch denied');await db.query('update public.pos_branches set active=true where id=$1',[f.branch]);
 await rejects(()=>auth(f,'pos_branch_operations',null),/POS_ACCESS_DENIED/,'null branch denied');await rejects(()=>auth(f,'pos_branch_operations',"x');select 1;--"),/invalid input syntax for type uuid/,'injection rejected by typed UUID');
 await rejects(()=>operations({...f,branch:sibling}),/POS_REPORT_PROFILE_REQUIRED/,'missing fiscal setup is unavailable, not zero');
 f=await fixture();const d=await dates(),prior=await document(f,d.before,2100);await document(f,d.start,1050,[{method:'cash',amountFils:600},{method:'card',amountFils:450}]);await document(f,d.endBefore,1050);await document(f,d.end,700);await document(f,d.start,2100,[{method:'cash',amountFils:2100}],prior);
 await db.query('insert into public.pos_orders(id,organization_id,branch_id,device_id,shift_id,created_by,client_created_at,received_at,service_type,total_fils,tax_fils,request_payload) values($1,$2,$3,$4,$5,$6,$7,$7,\'takeaway\',777,0,\'{}\')',[uid(),f.org,f.branch,f.device,f.shift,f.owner,d.start]);
 r=await operations(f);check(r.businessDate,d.date,'Dubai business day');check(r.sales.documentCount,3,'Dubai half-open microsecond boundaries');check(r.sales.legacyOrdersExcluded,1,'legacy nonfiscal order excluded explicitly');check(r.sales.summary,{invoiceCount:2,creditNoteCount:1,salesGrossFils:2100,refundGrossFils:2100,netGrossFils:0,netExVatFils:0,vatFils:0},'historical totals and current-period credit note');check(r.sales.payments.find(p=>p.method==='cash'),{method:'cash',salesFils:1650,refundsFils:2100,netFils:-450},'cash split excludes tender/change');check(JSON.stringify(r).includes('Private synthetic buyer'),false,'no customer disclosure');check(JSON.stringify(r).includes('Historical sweet'),false,'no unnecessary product detail');check(r.kitchen.paidTickets.queued,3,'current kitchen includes unfinished tickets outside fiscal day');fixtures.normal=r;
 f=await fixture();const old=await document(f,d.before);await document(f,d.start,1050,undefined,old);r=await operations(f);check(r.sales.summary.netGrossFils,-1050,'refund-only day negative net retained');check(r.sales.summary.vatFils,-50,'refund-only day negative VAT retained');fixtures.negative=r;
 f=await fixture();await addShifts(f,24);await addShifts(f,23,true);const tabs=await addTabs(f,107,100000000);r=await operations(f);check(r.openShifts.totalCount,25,'open shift count exceeds list');check(r.openShifts.items.length,20,'open shift displayed cap');check(r.openShifts.truncated,true,'open truncation explicit');check(r.closedShifts.totalCount,23,'closed count not limited to twenty');check(r.closedShifts.discrepancyCount,23,'discrepancies count full window');check(r.closedShifts.netDifferenceFils,-460,'closed total includes hidden rows');check(r.unpaidOrders.totalCount,107,'all 107 old unpaid tabs counted');check(r.unpaidOrders.totalFils,10700000000,'unpaid sum exact beyond int32');check(r.unpaidOrders.items.length,20,'unpaid list cap');check(JSON.stringify(r).includes('Private note'),false,'unpaid notes not leaked');
 const hidden=await scalar("select id from public.pos_shifts where branch_id=$1 and status='closed' order by closed_at,id limit 1",[f.branch]);check(r.closedShifts.items.some(x=>x.id===hidden),false,'oldest closure hidden from recent20');await db.query('update public.pos_shifts set counted_cash_fils=-1,cash_difference_fils=-121 where id=$1',[hidden]);await rejects(()=>operations(f),/POS_OPERATIONS_INVALID_DATA/,'invalid hidden closure rejects complete snapshot');await db.query('update public.pos_shifts set counted_cash_fils=100,cash_difference_fils=-20 where id=$1',[hidden]);const closedId=r.closedShifts.items[0].id;await db.query('update public.pos_shifts set counted_cash_fils=null where id=$1',[closedId]);r=await operations(f);check(r.closedShifts.incompleteCount,1,'incomplete drawer count explicit');check(r.closedShifts.netDifferenceFils,null,'incomplete drawer total unknown');check(r.closedShifts.discrepancyCount,22,'incomplete drawer excluded from discrepancy count');fixtures.truncated=r;
 await db.query('update public.pos_shifts set counted_cash_fils=100,cash_difference_fils=1 where id=$1',[closedId]);await rejects(()=>operations(f),/POS_OPERATIONS_INVALID_DATA/,'inconsistent drawer arithmetic rejected');await db.query('update public.pos_shifts set counted_cash_fils=-1,cash_difference_fils=-121 where id=$1',[closedId]);await rejects(()=>operations(f),/POS_OPERATIONS_INVALID_DATA/,'negative counted cash rejected');await db.query('update public.pos_shifts set counted_cash_fils=100,cash_difference_fils=-20 where id=$1',[closedId]);
 // Kitchen fixture uses distinct ticket/batch counts; quantities deliberately differ.
 for(let i=0;i<tabs.length;i++){const ticket=uid();await db.query('insert into public.pos_tab_kitchen_tickets(id,tab_id,organization_id,branch_id,dispatched_tab_revision,metadata,event_sequence,acknowledged_sequence) values($1,$2,$3,$4,1,\'{}\',1,$5)',[ticket,tabs[i],f.org,f.branch,i%2]);await db.query('insert into public.pos_tab_kitchen_batches(ticket_id,generation,dispatch_sequence,product_id,name,initial_name,unit,initial_quantity_milli,quantity_milli,stage) values($1,1,1,$2,\'Sweet\',\'Sweet\',$3,1000,1000,$4)',[ticket,f.product,i%2?'kg':'piece',['queued','preparing','ready'][i%3]])}
 r=await operations(f);check(r.kitchen.tabTickets.activeCount,107,'all 107 kitchen tickets counted');check(r.kitchen.tabTickets.withUnacknowledgedChanges,54,'unacknowledged notice count');check(r.kitchen.tabBatches,{queued:36,preparing:36,ready:35},'batch count not quantity or unit total');
 const inactiveTicket=uid(),extraTab=(await addTabs(f,1))[0];await db.query('insert into public.pos_tab_kitchen_tickets(id,tab_id,organization_id,branch_id,dispatched_tab_revision,metadata,state,event_sequence) values($1,$2,$3,$4,1,\'{}\',\'cancelled\',2)',[inactiveTicket,extraTab,f.org,f.branch]);check((await operations(f)).kitchen.tabTickets.activeCount,108,'cancelled ticket with unacknowledged notices remains actionable');
 fixtures.truncated=await operations(f);
 // Closed entries outside rolling window and future entries do not contaminate it.
 await db.query("update public.pos_shifts set closed_at=now()-interval '31 days' where id=$1",[closedId]);check((await operations(f)).closedShifts.totalCount,22,'old closed shifts outside30localdates excluded');await db.query("update public.pos_shifts set closed_at=now()+interval '1 day' where id=$1",[closedId]);check((await operations(f)).closedShifts.totalCount,22,'future closed shifts excluded');
}
async function custody(){
 const f=await fixture(true);let r=await operations(f);check(r.offlineCustody.unsealedAuthorities,1,'authority outstanding before import');
 // Direct synthetic historical rows exercise reporting only; no signature-verification claim.
 const expired=await fixture(),epoch=uid(),authority=uid();await db.query("insert into public.pos_offline_key_epochs(id,organization_id,branch_id,device_id,public_key_spki,device_key_sha256,enrolled_by,request_id,request_payload) values($1,$2,$3,$4,'synthetic',$5,$6,$7,'{}')",[epoch,expired.org,expired.branch,expired.device,hash(uid()),expired.owner,uid()]);await db.query("insert into public.pos_offline_authorities(id,organization_id,branch_id,device_id,key_epoch,actor_id,shift_id,request_payload,snapshot,authority,base_sequence) values($1,$2,$3,$4,$5,$6,$7,'{}','{}','{\"expiresAt\":\"2001-01-01T00:00:00.000Z\"}',0)",[authority,expired.org,expired.branch,expired.device,epoch,expired.owner,expired.shift]);check((await operations(expired)).offlineCustody.unsealedAuthorities,1,'expired unsealed allocation remains outstanding');
 const pending=freeze(f);await register(f,pending);check((await operations(f)).offlineCustody.pendingPaymentFreezes,1,'frozen payment visible');
 await db.query('insert into public.pos_offline_payment_resolution_policy(branch_id,enabled) values($1,true)',[f.branch]);
 const now=new Date().toISOString(),request={requestId:uid(),freezeId:pending.freezeId,freezeSha256:eh(signedFreeze(f,pending)),decision:'funds_returned',reason:'Synthetic returned cash',evidence:[{method:'cash',amountFils:1000,paymentObservedAt:now,completedAt:now,reference:'Synthetic',note:'Synthetic attestation'}],cashDrawerShiftId:f.shift};
 const decision=await service('pos_offline_payment_decide',f.owner,request,now);check((await operations(f)).offlineCustody.pendingPaymentFreezes,1,'unsigned decision is still pending');await service('pos_offline_payment_attach',decision.resolution.resolutionId,envelope(decision.resolution));check((await operations(f)).offlineCustody.pendingPaymentFreezes,0,'attached signature clears only freeze pending count');
 await service('pos_offline_reject',f.bundle.authority.id,envelope(sale(f),f.bundle.authority.deviceKeySha256),'invalid_historical_receipt');check((await operations(f)).offlineCustody.unresolvedUploadExceptions,1,'upload exception visible');
 await db.query('update public.pos_offline_key_epochs set blocked=true where id=$1',[f.enrollment.keyEpoch]);check((await operations(f)).offlineCustody.blockedDeviceEpochs,1,'blocked epoch visible');
 const conflictSale=sale(f);await rpcOn(db,'pos_offline_payment_conflict',f.bundle.authority.id,null,conflictSale.paymentIntentId,'identity',envelope(conflictSale,f.bundle.authority.deviceKeySha256));check((await operations(f)).offlineCustody.conflictRecords,1,'durable conflict persists after signed decision');
 const raw=sale(f);raw.document.customer={name:'Synthetic\u0000buyer',address:'Test',trn:null};await service('pos_offline_retain_unsupported',f.bundle.authority.id,envelope(raw,f.bundle.authority.deviceKeySha256));check((await operations(f)).offlineCustody.unsupportedEvidenceRecords,1,'unsupported historical evidence visible');r=await operations(f);check(JSON.stringify(r).includes('payloadBase64Url'),false,'no signed proofs exposed');check(r.offlineDeviceCoverage,'unknown','server custody does not imply local completeness');fixtures.custody=r;
 const resolved=await fixture(true),issuance=sale(resolved),args=importArgs(resolved,issuance);await service('pos_offline_import',...args);await service('pos_offline_reject',resolved.bundle.authority.id,envelope(issuance,resolved.bundle.authority.deviceKeySha256),'invalid_historical_receipt');check((await operations(resolved)).offlineCustody.unresolvedUploadExceptions,1,'unresolved exception join counted');const exception=await scalar('select id from public.pos_offline_exceptions where authority_id=$1',[resolved.bundle.authority.id]);await db.query('insert into public.pos_offline_exception_resolutions(exception_id,issuance_id) values($1,$2)',[exception,issuance.id]);check((await operations(resolved)).offlineCustody.unresolvedUploadExceptions,0,'resolved exception excluded by immutable resolution record');await service('pos_offline_seal',...sealArgs(resolved,1,eh(args[1])));check((await operations(resolved)).offlineCustody.unsealedAuthorities,0,'actual server sealed authority no longer outstanding');
}
async function limits(){
 let f=await fixture();await addTabs(f,50001,1);await rejects(()=>operations(f),/POS_OPERATIONS_TOO_LARGE/,'50001 source rows fail whole response');
 f=await fixture();const d=await dates();for(let left=50001;left>0;left-=500)await db.query(`insert into public.pos_orders(id,organization_id,branch_id,device_id,shift_id,created_by,client_created_at,received_at,service_type,total_fils,tax_fils,request_payload) select gen_random_uuid(),$1,$2,$3,$4,$5,$6,$6,'takeaway',1,0,'{}' from generate_series(1,$7)`,[f.org,f.branch,f.device,f.shift,f.owner,d.start,Math.min(500,left)]);await rejects(()=>operations(f),/POS_OPERATIONS_TOO_LARGE/,'50001 legacy rows fail whole response');
 f=await fixture();await addTabs(f,50001,1);await db.query("update public.pos_open_tabs set status='voided' where branch_id=$1",[f.branch]);await db.query("insert into public.pos_tab_kitchen_tickets(tab_id,organization_id,branch_id,dispatched_tab_revision,metadata,state) select id,organization_id,branch_id,1,'{}','cancelled' from public.pos_open_tabs where branch_id=$1",[f.branch]);await rejects(()=>operations(f),/POS_OPERATIONS_TOO_LARGE/,'50001 terminal kitchen history source also capped');f=await fixture();await addShifts(f,1,true);await db.query('update public.pos_shifts set counted_cash_fils=9007199254740992,expected_cash_fils=9007199254740992,cash_difference_fils=0 where branch_id=$1 and status=\'closed\'',[f.branch]);await rejects(()=>operations(f),/POS_OPERATIONS_INVALID_DATA/,'unsafe JavaScript integer cannot escape hidden or visible cash fields');
}
async function concurrency(){if(!postgres)return;
 const f=await fixture(),admin=uid(),token=hash(uid());await execute(f,command(f));await db.query('insert into auth.users values($1,\'synthetic-admin@example.test\',now())',[admin]);await db.query('insert into public.pos_staff(organization_id,user_id,role) values($1,$2,\'owner\')',[f.org,admin]);await db.query('update public.pos_staff set role=\'manager\' where user_id=$1',[f.owner]);await db.query('insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)',[token,admin,f.org,f.branch,f.device]);
 const revoke={id:uid(),branchId:f.branch,deviceId:f.device,targetUserId:f.owner,expectedRevision:1,role:'manager',assignedBranchId:null,active:false,displayName:'Synthetic manager',reason:'Synthetic revocation'};
 const racedResult=await raced('staff_revocation_then_operations',async x=>{await x.query("select set_config('app.user_id',$1,true)",[admin]);return rpcOn(x,'pos_manage_staff',revoke,token)},x=>rpcOn(x,'pos_branch_operations',f.branch),{firstRole:'authenticated',secondRole:'authenticated',actor:f.owner});check(/POS_ACCESS_DENIED/.test(racedResult.second.error??''),true,'blocked reader sees actual committed revocation');
 const g=await fixture(),tab=(await addTabs(g,1))[0],date=(await dates()).start;
 const writer=new Client({...config,database,application_name:'operations_snapshot_writer'}),reader=new Client({...config,database,application_name:'operations_snapshot_reader'});sessions.push(writer,reader);await writer.connect();await reader.connect();await reader.query("select set_config('app.user_id',$1,false)",[g.owner]);await reader.query('set role authenticated');
 try{
  await writer.query('begin');await writer.query('lock table public.pos_documents in access exclusive mode');const bill=await document(g,date,1050,undefined,null,writer);await writer.query('update public.pos_open_tabs set status=\'settled\',settled_order_id=$2 where id=$1',[tab,bill.order]);
  let finished=false;const pending=rpcOn(reader,'pos_branch_operations',g.branch).then(x=>{finished=true;return x});let observed=null;
  for(let i=0;i<100;i++){const x=(await control.query("select wait_event_type,wait_event,cardinality(pg_blocking_pids(pid)) blockers from pg_stat_activity where datname=$1 and application_name='operations_snapshot_reader'",[database])).rows[0];if(x?.wait_event_type==='Lock'&&x.blockers>0){observed=x;break}if(finished)break;await new Promise(r=>setTimeout(r,20))}
  assert.ok(observed,'snapshot reader demonstrably waits on writer table lock');await writer.query('commit');const r=branchOperationsSchema.parse(await pending);check(r.sales.documentCount+r.unpaidOrders.totalCount,1,'snapshot never mixes sale commit with stale unpaid state');check(r.sales.summary.salesGrossFils,r.sales.documentCount*1050,'snapshot sales count and amount reconcile');report.races.push({name:'atomic_sale_tab_transition',blockingObserved:observed,documents:r.sales.documentCount,tabs:r.unpaidOrders.totalCount});
 }finally{await writer.query('rollback').catch(()=>{});await writer.end();await reader.end();sessions.splice(sessions.indexOf(writer),1);sessions.splice(sessions.indexOf(reader),1)}
}
async function acl(){const sig='public.pos_branch_operations(uuid)';for(const role of ['anon','service_role'])check(await scalar('select has_function_privilege($1,$2,\'EXECUTE\')',[role,sig]),false,role+' cannot invoke');check(await scalar('select has_function_privilege(\'authenticated\',$1,\'EXECUTE\')',[sig]),true,'authenticated execute');check(await scalar('select proconfig from pg_proc where oid=$1::regprocedure',[sig]),['search_path=""'],'empty search path');check(await scalar('select provolatile from pg_proc where oid=$1::regprocedure',[sig]),'v','volatile for post-lock auth refresh');await db.exec('set role anon');await rejects(()=>rpcOn(db,'pos_branch_operations',uid()),/permission denied/,'actual anon permission denied');await db.exec('reset role');await db.exec('set role service_role');await rejects(()=>rpcOn(db,'pos_branch_operations',uid()),/permission denied/,'actual service role invocation denied');await db.exec('reset role')}
try{await initialize();await scenarios();await custody();await limits();await concurrency();await acl();report.status='passed';if(reportPath)await writeFile(reportPath.replace(/\.json$/,'.fixtures.json'),JSON.stringify(fixtures,null,2)+'\n',{mode:0o600})}
catch(error){report.status='failed';report.failure={message:error.message,where:error.where,stack:error.stack};process.exitCode=1;console.error(error.message,error.where??'')}
finally{for(const session of sessions)await session.end().catch(()=>{});if(db)await(postgres?db.end():db.close()).catch(()=>{});if(control&&database){try{await control.query(`drop database ${database}`);assert.equal(await scalar('select count(*)::int from pg_database where datname=$1',[database],control),0);report.cleanup='verified-dropped'}catch(error){report.cleanup='failed: '+error.message;process.exitCode=1}await control.end()}else report.cleanup=db?'embedded-database-closed':'not-created';report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({status:report.status,backend:report.backend,checks:report.checks.length,races:report.races.length,cleanup:report.cleanup,productionTouched:false}))}
