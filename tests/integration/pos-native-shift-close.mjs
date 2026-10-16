// Synthetic disposable SQL023 drawer-close read and recovery tests. No real merchants, provider calls or signature claims.
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
let db, control, Client, database, config
const sessions = []
const save = async () => { if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }) }
const check = (actual, expected, name) => { assert.deepEqual(actual, expected, name); report.checks.push(name) }
const rejects = async (operation, pattern, name) => { await assert.rejects(operation, pattern); report.checks.push(name) }
const uid = randomUUID
const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])) : value)
const envelope = (payload, keyId = 'synthetic-server', signatureBase64Url = 'MAgCAQICAQE') => ({ format: 'pos-signed-v1', alg: 'ECDSA-P256-SHA256-DER', keyId, payloadBase64Url: Buffer.from(canonical(payload)).toString('base64url'), signatureBase64Url })
const decode = value => JSON.parse(Buffer.from(value.payloadBase64Url, 'base64url').toString())
const eh = value => hash(Buffer.from(value.payloadBase64Url, 'base64url'))
const scalar = async (sql, params = [], connection = db) => Object.values((await connection.query(sql, params)).rows[0])[0]
const rpcOn = (connection, name, ...args) => scalar(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args.map(v => v !== null && typeof v === 'object' ? JSON.stringify(v) : v), connection)
const service = async (name, ...args) => { await db.exec('set role service_role'); try { return await rpcOn(db, name, ...args) } finally { await db.exec('reset role') } }
const count = (table, where = 'true', params = []) => scalar(`select count(*)::int from public.${table} where ${where}`, params)
const clone = structuredClone

async function initialize() {
  if (postgres) {
    const module = await import(pathToFileURL(process.argv[3]).href)
    Client = module.Client ?? module.default.Client
    const host = process.argv[4]
    assert.ok(host?.startsWith('/') && !host.includes('..'), 'Only an explicit local Unix socket is accepted')
    config = { host, port: 55432, user: userInfo().username, database: 'postgres', connectionTimeoutMillis: 5000 }
    control = new Client(config); await control.connect()
    assert.equal(await scalar('select inet_server_addr() is null', [], control), true)
    database = 'pos_qa_drawer_close_' + uid().replaceAll('-', '')
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
  const files = (await readdir(directory)).filter(f => /^20261016/.test(f) && !f.includes('007') && !f.includes('009') && f < '202610160024').sort()
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
function onlineRequest(f, id = uid()) {
  return { id, branchId: f.branch, deviceId: f.device, shiftId: f.shift, profileId: f.profile, createdAt: new Date().toISOString(), serviceType: 'takeaway', customer: null, lines: [{ productId: f.product, quantityMilli: 1000, expectedUnitPriceFils: 1000, expectedTaxRateBps: 500 }], payments: [{ method: 'cash', amountFils: 1000 }], cashTenderedFils: 1500, expectedTotalFils: 1000 }
}
async function online(f, request) {
  await db.query("select set_config('app.user_id',$1,false)", [f.owner]); await db.exec('set role authenticated')
  try { return await rpcOn(db, 'pos_record_live_order', request, f.binding) } finally { await db.exec('reset role') }
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
const context = f => auth(f,'pos_native_shift_close_context',f.branch,f.device,f.shift,f.binding)
const lookup = (f,c) => auth(f,'pos_native_shift_close_lookup',c,f.binding)
const execute = (f,c) => auth(f,'pos_execute_live_command',c,f.binding)
const resolve = (f,c) => auth(f,'pos_resolve_live_request','command',c,f.binding)
async function sealed(){const f=await fixture(true);await service('pos_offline_seal',...sealArgs(f));return f}
async function ledger(f){const result={};for(const table of ['pos_shifts','pos_command_receipts','pos_request_cancellations','pos_orders','pos_documents','pos_payments','pos_refunds','pos_cash_movements','pos_audit_events'])result[table]=await scalar(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from public.${table} x where organization_id=$1`,[f.org]);return result}
async function scenarios(){
 let f=await fixture(),c=command(f),before=await ledger(f);let r=await context(f)
 check(Object.keys(r).sort(),['actorId','organizationId','branchId','deviceId','shiftId','status','canClose','reasonCode'].sort(),'strict empty-shift context shape')
 check(r,{actorId:f.owner,organizationId:f.org,branchId:f.branch,deviceId:f.device,shiftId:f.shift,status:'open',canClose:true,reasonCode:null},'empty shift before enrollment or PIN may close')
 check(await count('pos_offline_key_epochs','device_id=$1',[f.device]),0,'empty close context needs no enrolled epoch')
 for(let i=0;i<3;i++)check((await lookup(f,c)).status,'not_found','repeated lookup remains absent')
 check(await ledger(f),before,'context and missing lookup never write or create cancellation')
 let applied=await execute(f,c);check(applied.expectedCashFils,0,'empty shift expected zero');r=await lookup(f,c);check(r.status,'applied','lookup finds exact committed command');check(r.result.cashDifferenceFils,0,'empty shift balanced');check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.result.closedAt),true,'closed timestamp exact UTC millis');check((await context(f)).reasonCode,'shift_already_closed','closed context not permission to close again')
 const saved=r;check((await execute(f,c)).replayed,true,'exact command replays');check(await lookup(f,c),saved,'lookup returns unchanged first financial result');check(await count('pos_command_receipts','id=$1',[c.id]),1,'only one close receipt')
 await rejects(()=>lookup(f,{...c,countedCashFils:1}),/POS_IDEMPOTENCY_CONFLICT/,'same ID changed count rejected');check((await lookup(f,command(f))).status,'not_found','closed by other command is not proof of local request')
 await rejects(()=>execute(f,command(f)),/POS_SHIFT_CLOSED/,'another ID cannot close same shift twice')
 await db.query('update public.pos_branch_receipt_config set live_enabled=false where branch_id=$1',[f.branch]);check(await lookup(f,c),saved,'committed lookup survives paused live profile')
 await db.query('update public.pos_device_bindings set revoked_at=now() where token_hash=$1',[f.binding]);await db.query('update public.pos_devices set active=false where id=$1',[f.device]);await db.query('update public.pos_staff set active=false where user_id=$1',[f.owner]);check(await lookup(f,c),saved,'historical own lookup survives binding device and staff revocation');await rejects(()=>context(f),/POS_ACCESS_DENIED/,'revoked staff cannot obtain fresh close permission');await rejects(()=>execute(f,c),/POS_ACCESS_DENIED/,'revoked staff cannot resubmit writer')
 before=await ledger(f);check((await lookup(f,command(f))).status,'not_found','revoked own absent lookup is read only');check(await ledger(f),before,'historical absent lookup no tombstone')
 f=await fixture();c=command(f);await resolve(f,c);before=await ledger(f);check((await lookup(f,c)).status,'cancelled','explicit preexisting cancellation returned');check(await ledger(f),before,'cancelled lookup unchanged');await rejects(()=>execute(f,c),/POS_REQUEST_CANCELLED/,'cancelled command never executes');await rejects(()=>lookup(f,{...c,countedCashFils:2}),/POS_IDEMPOTENCY_CONFLICT/,'cancelled original count immutable')
 f=await fixture();c=command(f);const foreign=await fixture();
 for(const bad of [{...f,binding:foreign.binding},{...f,owner:foreign.owner},{...f,device:foreign.device},{...f,branch:foreign.branch},{...f,shift:foreign.shift}])await rejects(()=>context(bad),/POS_/,'foreign close context denied')
 for(const bad of [{...f,binding:foreign.binding},{...f,owner:foreign.owner}])await rejects(()=>lookup(bad,c),/POS_/,'foreign original lookup denied')
 for(const mutation of [{...c,extra:true},{...c,type:'shift.open'},{...c,countedCashFils:-1},{...c,countedCashFils:100000001},{...c,countedCashFils:1.5},{...c,countedCashFils:'1'},{...c,id:uid()+'\u0000'},{...c,shiftId:foreign.shift}])await rejects(()=>lookup(f,mutation),/POS_|invalid_request|unsupported Unicode/,'strict lookup rejects malformed or foreign request')
 before=await ledger(f);check((await lookup(f,c)).status,'not_found','valid request remains absent after malformed attempts');check(await ledger(f),before,'malformed attempts cannot write')
 await db.query("update public.pos_staff set role='cashier',branch_id=$1 where user_id=$2",[f.branch,f.owner]);check((await context(f)).canClose,true,'current cashier can close own shift');await execute(f,c);check((await lookup(f,c)).status,'applied','cashier close recoverable')
 // Genuine online sale/payment/refund commands populate the arithmetic fixture.
 f=await fixture();await db.query('update public.pos_shifts set opening_cash_fils=10000 where id=$1',[f.shift]);const sale1=onlineRequest(f),sale2=onlineRequest(f);await online(f,sale1);sale2.payments=[{method:'card',amountFils:1000}];sale2.cashTenderedFils=0;await online(f,sale2)
 await execute(f,{id:uid(),type:'cash.move',branchId:f.branch,deviceId:f.device,shiftId:f.shift,amountFils:2000,reason:'Synthetic cash in'});await execute(f,{id:uid(),type:'cash.move',branchId:f.branch,deviceId:f.device,shiftId:f.shift,amountFils:-500,reason:'Synthetic cash out'});await execute(f,{id:uid(),type:'refund.full',branchId:f.branch,deviceId:f.device,shiftId:f.shift,orderId:sale1.id,reason:'Synthetic full return'})
 c=command(f,11400);applied=await execute(f,c);check(applied.expectedCashFils,11500,'opening plus net cash plus movements minus cash refund excludes card and change');check(applied.cashDifferenceFils,-100,'cash shortage signed negative');r=await lookup(f,c);check(r.result.expectedCashFils,11500,'lookup preserves original expected cash');check(r.result.cashDifferenceFils,r.result.countedCashFils-r.result.expectedCashFils,'lookup arithmetic exact');check(await count('pos_cash_movements','shift_id=$1',[f.shift]),2,'close does not invent cash movement')
 // Isolated archived synthetic imbalance: read/close must preserve signed negative expected cash.
 f=await fixture();await db.query('update public.pos_shifts set opening_cash_fils=200 where id=$1',[f.shift]);await db.query('insert into public.pos_cash_movements(id,organization_id,branch_id,device_id,shift_id,actor_id,amount_fils,reason) values($1,$2,$3,$4,$5,$6,-200,\'Synthetic archived cash imbalance\')',[uid(),f.org,f.branch,f.device,f.shift,f.owner]);await db.query('update public.pos_shifts set opening_cash_fils=0 where id=$1',[f.shift]);c=command(f,0);await execute(f,c);r=await lookup(f,c);check(r.result.expectedCashFils,-200,'negative expected cash is preserved');check(r.result.cashDifferenceFils,200,'difference against negative expected is exact')
 f=await fixture(true);check((await context(f)).reasonCode,'offline_allocation_active','unsealed allocation blocks close context');await rejects(()=>execute(f,command(f)),/POS_OFFLINE_CHAIN_INCOMPLETE/,'unsealed writer close rejected')
 f=await sealed();check((await context(f)).canClose,true,'sealed empty allocation can close');await register(f,freeze(f));check((await context(f)).reasonCode,'payment_reconciliation_required','late payment evidence blocks drawer close');await rejects(()=>execute(f,command(f)),/POS_OFFLINE_PAYMENT_HOLD/,'writer independently blocks payment hold')
 f=await sealed();await service('pos_offline_reject',f.bundle.authority.id,envelope(sale(f),f.bundle.authority.deviceKeySha256),'invalid_historical_receipt');check((await context(f)).reasonCode,'offline_upload_required','unresolved exception blocks close');await rejects(()=>execute(f,command(f)),/POS_OFFLINE_CHAIN_INCOMPLETE/,'writer independently blocks unresolved exception')
 f=await sealed();const raw=sale(f);raw.document.customer={name:'Synthetic\u0000buyer',address:'Synthetic',trn:null};await service('pos_offline_retain_unsupported',f.bundle.authority.id,envelope(raw,f.bundle.authority.deviceKeySha256));check((await context(f)).reasonCode,'payment_reconciliation_required','raw unsupported evidence holds close');await rejects(()=>execute(f,command(f)),/POS_OFFLINE_PAYMENT_HOLD/,'raw evidence writer hold')
}
async function concurrency(){
 if(!postgres)return;
 let f=await fixture(),c=command(f),race=await raced('close_then_context',x=>rpcOn(x,'pos_execute_live_command',c,f.binding),x=>rpcOn(x,'pos_native_shift_close_context',f.branch,f.device,f.shift,f.binding),{firstRole:'authenticated',secondRole:'authenticated',actor:f.owner});check(race.second.value.reasonCode,'shift_already_closed','context waits for actual close commit')
 f=await fixture();c=command(f,100);race=await raced('execute_then_lookup',x=>rpcOn(x,'pos_execute_live_command',c,f.binding),x=>rpcOn(x,'pos_native_shift_close_lookup',c,f.binding),{firstRole:'authenticated',secondRole:'authenticated',actor:f.owner});check(race.second.value.status,'applied','lookup waits for exact command commit');check(race.second.value.result.countedCashFils,100,'race retains original count')
 f=await fixture();c=command(f);race=await raced('lookup_then_execute',x=>rpcOn(x,'pos_native_shift_close_lookup',c,f.binding),x=>rpcOn(x,'pos_execute_live_command',c,f.binding),{firstRole:'authenticated',secondRole:'authenticated',actor:f.owner});check(race.first.status,'not_found','lookup absence does not cancel');check(race.second.value.status,'applied','subsequent writer allowed after no-op lookup')
 f=await fixture();c=command(f);race=await raced('cancel_then_lookup',x=>rpcOn(x,'pos_resolve_live_request','command',c,f.binding),x=>rpcOn(x,'pos_native_shift_close_lookup',c,f.binding),{firstRole:'authenticated',secondRole:'authenticated',actor:f.owner});check(race.second.value.status,'cancelled','lookup waits for explicit cancellation')
 f=await sealed();c=command(f);race=await raced('late_freeze_then_close',x=>rpcOn(x,'pos_offline_payment_freeze',signedFreeze(f,freeze(f))),x=>rpcOn(x,'pos_execute_live_command',c,f.binding),{secondRole:'authenticated',actor:f.owner});check(/POS_OFFLINE_PAYMENT_HOLD/.test(race.second.error??''),true,'late evidence wins before close atomically')
 f=await fixture();c=command(f);await execute(f,c);const admin=uid(),token=hash(uid());await db.query('insert into auth.users values($1,\'synthetic-admin@example.test\',now())',[admin]);await db.query('insert into public.pos_staff(organization_id,user_id,role) values($1,$2,\'owner\')',[f.org,admin]);await db.query('update public.pos_staff set role=\'manager\' where user_id=$1',[f.owner]);await db.query('insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)',[token,admin,f.org,f.branch,f.device]);
 const revoke={id:uid(),branchId:f.branch,deviceId:f.device,targetUserId:f.owner,expectedRevision:1,role:'manager',assignedBranchId:null,active:false,displayName:'Synthetic original manager',reason:'Synthetic revocation'};
 race=await raced('revocation_then_historical_lookup',async x=>{await x.query("select set_config('app.user_id',$1,true)",[admin]);return rpcOn(x,'pos_manage_staff',revoke,token)},x=>rpcOn(x,'pos_native_shift_close_lookup',c,f.binding),{firstRole:'authenticated',secondRole:'authenticated',actor:f.owner});check(race.first.status,'updated','actual staff writer revokes actor');check(race.second.value.status,'applied','historical lookup retains own result after waited revocation')
}
async function acl(){for(const signature of ['pos_native_shift_close_context(uuid,uuid,uuid,text)','pos_native_shift_close_lookup(jsonb,text)']){const sig='public.'+signature;for(const role of ['anon','service_role'])check(await scalar('select has_function_privilege($1,$2,\'EXECUTE\')',[role,sig]),false,role+' denied '+signature);check(await scalar('select has_function_privilege(\'authenticated\',$1,\'EXECUTE\')',[sig]),true,'authenticated only '+signature);check(await scalar('select prosecdef from pg_proc where oid=$1::regprocedure',[sig]),true,'security definer '+signature);check(await scalar('select proconfig from pg_proc where oid=$1::regprocedure',[sig]),['search_path=""'],'empty search path '+signature)}}

try {
  await initialize();await scenarios();await concurrency();await acl();report.status='passed'
} catch (error) {
  report.status = 'failed'; report.failure = { message: error.message, where: error.where, stack: error.stack }; process.exitCode = 1
  console.error(error.message, error.where ?? '')
} finally {
  for (const session of sessions) await session.end().catch(() => {})
  if (db) await (postgres ? db.end() : db.close()).catch(() => {})
  if (control && database) {
    try { await control.query(`drop database ${database}`); assert.equal(await scalar('select count(*)::int from pg_database where datname=$1', [database], control), 0); report.cleanup = 'verified-dropped' }
    catch (error) { report.cleanup = 'failed: ' + error.message; process.exitCode = 1 }
    await control.end()
  } else report.cleanup = db ? 'embedded-database-closed' : 'not-created'
  report.finishedAt = new Date().toISOString(); await save()
  console.log(JSON.stringify({ status: report.status, backend: report.backend, checks: report.checks.length, races: report.races.length, cleanup: report.cleanup, productionTouched: false }))
}
