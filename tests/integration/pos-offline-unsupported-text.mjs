// Synthetic disposable SQL019 raw unsupported-text custody tests. No real merchants, provider calls or signature claims.
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
    database = 'pos_qa_raw_' + uid().replaceAll('-', '')
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
  const files = (await readdir(directory)).filter(f => /^20261016/.test(f) && !f.includes('007') && !f.includes('009') && f < '202610160020').sort()
  for (const file of files) { const sql = await readFile(new URL(file, directory), 'utf8'); report.migrationHashes[file] = hash(sql); await db.exec(sql) }
  await save()
}

async function fixture(productCount = 1) {
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
  if(productCount>1){
    await db.query('update public.pos_products set unit_price_fils=100 where id=$1',[product])
    for(let i=1;i<productCount;i++) await db.query('insert into public.pos_products(id,organization_id,branch_id,name,category,unit_price_fils,tax_rate_bps) values($1,$2,$3,$4,$5,100,500)',[uid(),org,branch,'Synthetic large item '+i,'Test'])
  }
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

// The service verifies full canonical schema, arithmetic and real P256 signatures first.
// These RPC tests deliberately exercise the narrower database trust boundary with synthetic envelopes.
function rawSale(f, existing = sale(f)) {
  existing.document.customer = {name: 'Old\0buyer', address: 'Synthetic Dubai 🍰', trn: null}
  return existing
}
function rawFreeze(f, existing = freeze(f)) {
  existing.request.customer = {name: 'Old\0buyer', address: 'Synthetic Dubai 🍰', trn: null}
  existing.requestSha256 = hash(canonical(existing.request))
  return existing
}
const rawEnvelope = (f,p,signature) => envelope(p,f.bundle.authority.deviceKeySha256,signature)
const retain = (f,p,signature) => service('pos_offline_retain_unsupported',f.bundle.authority.id,rawEnvelope(f,p,signature))
const row = async (id) => (await db.query('select * from public.pos_offline_raw_evidence where id=$1',[id])).rows[0]
async function noFinancial(f,label) {
  for (const table of ['pos_orders','pos_documents','pos_payments','pos_offline_receipts']) check(await count(table,'branch_id=$1',[f.branch]),0,label+' creates no '+table)
}
async function scenarios() {
  for (const kind of ['freeze','issuance']) {
    const f=await fixture(), p=kind==='freeze'?rawFreeze(f):rawSale(f), signed=rawEnvelope(f,p), first=await retain(f,p)
    check(first.status,'reconciliation_required',kind+' retains unsupported original as evidence')
    check(first.code,'unsupported_text',kind+' cannot masquerade as ACK')
    check(Object.keys(first).sort(),['code','exceptionId','status'],kind+' reply discloses no financial data')
    const saved=await row(first.exceptionId)
    check(saved.envelope,signed,kind+' exact first envelope retained');check(saved.payload_sha256,eh(signed),kind+' hash is exact canonical bytes')
    check(saved.claimed,true,kind+' claims all free identities');check(saved.kind,kind,kind+' routing kind retained')
    check((await retain(f,p,'MAgCAQECAQI')).exceptionId,first.exceptionId,kind+' same payload resign keeps original evidence ID')
    check((await row(first.exceptionId)).envelope,signed,kind+' resign preserves first signature bytes')
    check(await count('pos_offline_intent_claims','payment_intent_id=$1',[p.paymentIntentId]),1,kind+' one immutable identity claim')
    const changed=clone(p);if(kind==='freeze'){changed.request.customer.address='Changed address';changed.requestSha256=hash(canonical(changed.request))}else changed.document.customer.address='Changed address'
    const second=await retain(f,changed);check(second.exceptionId!==first.exceptionId,true,kind+' changed exact payload retained independently');check((await row(second.exceptionId)).claimed,false,kind+' changed payload cannot overwrite first claim')
    const issuance=kind==='issuance'?clone(p):sale(f,{id:p.orderId,paymentIntentId:p.paymentIntentId});if(kind==='freeze')issuance.document.id=p.documentId
    issuance.document.customer=null
    check((await service('pos_offline_import',...importArgs(f,issuance))).status,'reconciliation_required',kind+' blocks later normal issuance with same identity')
    await noFinancial(f,kind)
    await rejects(()=>service('pos_offline_seal',...sealArgs(f)),/POS_OFFLINE_PAYMENT_HOLD/,kind+' unresolved raw evidence blocks seal')
    await rejects(()=>service('pos_offline_reserve',f.owner,{...f.request,requestId:uid()}),/POS_/,kind+' unresolved raw evidence blocks new grant')
    await rejects(()=>db.query("update public.pos_shifts set status='closed',closed_at=now() where id=$1",[f.shift]),/POS_OFFLINE_PAYMENT_HOLD/,kind+' raw evidence blocks shift close')
    await rejects(()=>db.query("update public.pos_offline_raw_evidence set reason='unsupported_text' where id=$1",[first.exceptionId]),/immutable|POS_/i,kind+' evidence cannot be rewritten')
    await rejects(()=>db.query('delete from public.pos_offline_raw_evidence where id=$1',[first.exceptionId]),/immutable|POS_/i,kind+' evidence cannot be deleted')
  }
  {
    const f=await fixture(), p=rawSale(f);p.document.customer.name='Literal '+String.fromCharCode(92)+'u0000 buyer'
    await rejects(()=>retain(f,p),/POS_OFFLINE_UNSUPPORTED_TEXT_REQUIRED/,'literal backslash escape does not enter NUL quarantine')
    p.document.customer.name='عميل 🍰';await rejects(()=>retain(f,p),/POS_OFFLINE_UNSUPPORTED_TEXT_REQUIRED/,'Arabic and emoji do not enter NUL quarantine')
    check(await count('pos_offline_raw_evidence','authority_id=$1',[f.bundle.authority.id]),0,'supported strings retain no spurious evidence')
  }
  for(const name of ['quoted routing \"paymentIntentId\":\"'+uid()+'\" {},[]: \0 🍰', String.fromCharCode(92)+'\0 real NUL after literal slash']) {
    const f=await fixture(),p=rawSale(f);p.document.customer.name=name
    const result=await retain(f,p),saved=await row(result.exceptionId)
    check(saved.payment_intent_id,p.paymentIntentId,'nested routing-like text never replaces top-level payment intent')
    check(saved.order_id,p.id,'escaped quotes and braces preserve original order routing')
    check(saved.envelope,rawEnvelope(f,p),'multibyte escaped structure retains exact original envelope')
  }
  for(const type of ['duplicate_intent','duplicate_order','duplicate_document','authority','bundle_hash','scope','named_key','request_hash']) {
    const f=await fixture(),p=type==='request_hash'?rawFreeze(f):rawSale(f);let signed
    if(type==='authority')p.authorityId=uid()
    if(type==='bundle_hash')p.authoritySha256='0'.repeat(64)
    if(type==='scope')p.document.actorId=uid()
    if(type==='request_hash')p.requestSha256='0'.repeat(64)
    signed=rawEnvelope(f,p)
    if(type==='named_key')signed.keyId='0'.repeat(64)
    if(type.startsWith('duplicate_')) {
      const key=type==='duplicate_intent'?'paymentIntentId':type==='duplicate_order'?'id':'id'
      let exact=canonical(p)
      if(type==='duplicate_document') {const doc=canonical(p.document);const altered=doc.replace('"id":', '"id":'+JSON.stringify(p.document.id)+',"id":');exact=exact.replace(doc,altered)}
      else if(type==='duplicate_order') exact=exact.replace('"kind":"offline-sale"','"id":'+JSON.stringify(p.id)+',"kind":"offline-sale"')
      else exact=exact.replace('"paymentIntentId":','"paymentIntentId":'+JSON.stringify(p.paymentIntentId)+',"paymentIntentId":')
      signed.payloadBase64Url=Buffer.from(exact).toString('base64url')
    }
    await rejects(()=>service('pos_offline_retain_unsupported',f.bundle.authority.id,signed),/POS_|invalid/i,type+' cannot acquire ambiguous or foreign custody')
    check(await count('pos_offline_raw_evidence','authority_id=$1',[f.bundle.authority.id]),0,type+' retains no invalid evidence')
    check(await count('pos_offline_intent_claims','authority_id=$1',[f.bundle.authority.id]),0,type+' creates no claim')
  }
  {
    const foreign=await fixture(),own=await fixture(),claim=freeze(foreign);await register(foreign,claim)
    const p=rawSale(own);p.paymentIntentId=claim.paymentIntentId
    const result=await retain(own,p);check((await row(result.exceptionId)).claimed,false,'foreign intent collision retains incoming evidence without taking claim')
    check(await count('pos_offline_raw_evidence','authority_id=$1',[foreign.bundle.authority.id]),0,'foreign authority receives no incoming quarantine evidence')
    check(await scalar('select authority_id from public.pos_offline_intent_claims where payment_intent_id=$1',[claim.paymentIntentId]),foreign.bundle.authority.id,'foreign original identity owner unchanged')
    await rejects(()=>online(own,onlineRequest(own,p.id)),/POS_/,'partial collision still protects own order ID')
    const later=sale(own,{id:p.id,paymentIntentId:uid()});later.document.id=p.document.id
    check((await service('pos_offline_import',...importArgs(own,later))).status,'reconciliation_required','partial collision blocks own leftover IDs with different intent')
    await noFinancial(own,'foreign collision')
  }
  {
    const f=await fixture(),seal=sealArgs(f);await service('pos_offline_seal',...seal)
    await db.query("update public.pos_shifts set status='closed',closed_at=now() where id=$1",[f.shift]);await db.query('update public.pos_staff set active=false where organization_id=$1',[f.org]);await db.query('update public.pos_devices set active=false where id=$1',[f.device]);await db.query('update public.pos_offline_branch_policy set enabled=false where branch_id=$1',[f.branch])
    const kept=await retain(f,rawFreeze(f));check(kept.status,'reconciliation_required','revoked closed sealed scope still retains old signed custody')
    check(await scalar('select status from public.pos_shifts where id=$1',[f.shift]),'closed','historical custody never reopens shift')
    check((await service('pos_offline_seal',...seal)).status,'sealed','exact original seal replay survives later unsupported custody')
    await noFinancial(f,'revoked historical')
  }
  {
    const f=await fixture(),p=rawSale(f),order=onlineRequest(f,p.id),document=sale(f).document
    document.orderId=order.id;document.documentNumber='TEST-INV-9999999999'
    await db.query('insert into public.pos_orders(id,organization_id,branch_id,device_id,shift_id,created_by,client_created_at,service_type,total_fils,tax_fils,request_payload) values($1,$2,$3,$4,$5,$6,$7,$8,1000,48,$9)',[order.id,f.org,f.branch,f.device,f.shift,f.owner,order.createdAt,'takeaway',JSON.stringify(order)])
    const kept=await retain(f,p);check((await row(kept.exceptionId)).claimed,false,'preexisting own order makes raw evidence an unclaimed collision')
    await rejects(()=>db.query('insert into public.pos_documents(id,organization_id,branch_id,order_id,actor_id,kind,document_number,issued_at,request_payload,snapshot) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[document.id,f.org,f.branch,order.id,f.owner,'tax_invoice',document.documentNumber,document.issuedAt,JSON.stringify(order),JSON.stringify(document)]),/POS_OFFLINE_PAYMENT_HOLD/,'unclaimed own order hold also blocks a different new document ID')
    check(await count('pos_documents','order_id=$1',[order.id]),0,'held existing order cannot receive a new invoice')
  }
  {
    const f=await fixture(),order=onlineRequest(f),original=await online(f,order),p=rawSale(f,{...sale(f),id:order.id});p.document.orderId=order.id
    const kept=await retain(f,p);check((await row(kept.exceptionId)).claimed,false,'later raw proof cannot own committed online order')
    await db.query("select set_config('app.user_id',$1,false)",[f.owner]);await db.exec('set role authenticated')
    let refunded;try{refunded=await rpcOn(db,'pos_execute_live_command',{id:uid(),branchId:f.branch,deviceId:f.device,type:'refund.full',shiftId:f.shift,orderId:order.id,reason:'Synthetic authorized refund'},f.binding)}finally{await db.exec('reset role')}
    check(refunded.status,'applied','contradictory raw proof does not block legitimate original-invoice refund')
    check(refunded.creditNote.originalInvoice.documentId,original.receipt.id,'refund remains bound to original invoice')
    check(await count('pos_offline_raw_evidence','id=$1',[kept.exceptionId]),1,'legitimate refund does not erase raw hold')
  }
  for(const role of ['anon','authenticated','service_role']) check(await scalar("select has_table_privilege($1,'public.pos_offline_raw_evidence','SELECT,INSERT,UPDATE,DELETE')",[role]),false,role+' cannot read or mutate raw evidence directly')
  for(const role of ['anon','authenticated']) check(await scalar("select has_function_privilege($1,'public.pos_offline_retain_unsupported(uuid,jsonb)','EXECUTE')",[role]),false,role+' cannot invoke trusted raw-custody RPC')
  const helpers=(await db.query("select p.oid::regprocedure::text signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pos_offline_raw_%'")).rows
  for(const h of helpers) check(await scalar("select has_function_privilege('service_role',$1,'EXECUTE')",[h.signature]),false,'service cannot bypass through '+h.signature)
}
async function largeHistoricalCase() {
  const f=await fixture(200),p=rawSale(f),products=f.bundle.snapshot.products
  check(products.length,200,'large signed catalogue has 200 unique real fixture products')
  p.document.lines=products.map((product,index)=>({lineNumber:index+1,productId:product.id,name:product.name,unit:product.unit,quantityMilli:1000,unitPriceFils:100,taxRateBps:500,grossFils:100,netFils:95,taxFils:5}))
  p.document.totals={grossFils:20000,netFils:19000,taxFils:1000};p.document.payments=[{method:'cash',amountFils:20000}];p.document.cashTenderedFils=20000;p.document.changeFils=0
  const signed=rawEnvelope(f,p),bytes=Buffer.byteLength(canonical(p)),started=performance.now()
  const result=await service('pos_offline_retain_unsupported',f.bundle.authority.id,signed)
  const durationMs=performance.now()-started
  report.performance={case:'one 200-line historical NUL invoice, unique signed-catalogue products, exact 5% inclusive tax arithmetic',payloadBytes:bytes,envelopeBytes:Buffer.byteLength(JSON.stringify(signed)),durationMs:Math.round(durationMs*100)/100,notALoadTest:true}
  check(result.code,'unsupported_text','large supported-size NUL invoice retained as evidence')
  check((await row(result.exceptionId)).envelope,signed,'large invoice exact envelope retained')
  check(bytes<1048576,true,'large fixture within signed payload byte limit')
  check(durationMs<15000,true,'single large local custody operation completes within bounded 15-second check')
  await noFinancial(f,'large historical evidence')
}
async function concurrency() {
  if(!postgres){report.concurrency='Not tested: PGlite cannot prove independent locks';return}
  for(const rawFirst of [true,false]) {
    const f=await fixture(),normal=sale(f),p=rawSale(f,clone(normal)),rawOp=c=>rpcOn(c,'pos_offline_retain_unsupported',f.bundle.authority.id,rawEnvelope(f,p)),importOp=c=>rpcOn(c,'pos_offline_import',...importArgs(f,normal))
    const result=await raced(rawFirst?'raw_before_import':'import_before_raw',rawFirst?rawOp:importOp,rawFirst?importOp:rawOp)
    if(rawFirst){check(result.second.value?.status,'reconciliation_required','concurrent raw claim prevents invoice import');await noFinancial(f,'raw first race')}
    else {check(result.first.status,'accepted','original valid invoice wins before raw evidence');check(result.second.value?.code,'unsupported_text','late raw evidence does not become ACK');check(await count('pos_documents','branch_id=$1',[f.branch]),1,'late raw evidence never duplicates original invoice')}
  }
  {
    const f=await fixture(),p=rawFreeze(f),result=await raced('raw_resigned_retry',c=>rpcOn(c,'pos_offline_retain_unsupported',f.bundle.authority.id,rawEnvelope(f,p)),c=>rpcOn(c,'pos_offline_retain_unsupported',f.bundle.authority.id,rawEnvelope(f,p,'MAgCAQECAQI')))
    check(result.first.exceptionId,result.second.value?.exceptionId,'concurrent resign retains exact original evidence identity')
  }
  {
    const a=await fixture(),b=await fixture(),p=rawFreeze(a),q=rawFreeze(b);q.paymentIntentId=p.paymentIntentId
    const result=await raced('raw_cross_scope_intent',c=>rpcOn(c,'pos_offline_retain_unsupported',a.bundle.authority.id,rawEnvelope(a,p)),c=>rpcOn(c,'pos_offline_retain_unsupported',b.bundle.authority.id,rawEnvelope(b,q)))
    check((await row(result.first.exceptionId)).claimed,true,'first scope owns global raw claim');check((await row(result.second.value.exceptionId)).claimed,false,'second scope retains evidence without stealing foreign claim')
  }
  for(const onlineFirst of [false,true]){
    const f=await fixture(),p=rawSale(f),rawOp=c=>rpcOn(c,'pos_offline_retain_unsupported',f.bundle.authority.id,rawEnvelope(f,p)),onlineOp=c=>rpcOn(c,'pos_record_live_order',onlineRequest(f,p.id),f.binding)
    const result=await raced(onlineFirst?'online_before_raw':'raw_before_online',onlineFirst?onlineOp:rawOp,onlineFirst?rawOp:onlineOp,{firstRole:onlineFirst?'authenticated':'service_role',secondRole:onlineFirst?'service_role':'authenticated',actor:f.owner})
    if(onlineFirst){check(result.first.status,'synced','online original wins before raw evidence');check((await row(result.second.value.exceptionId)).claimed,false,'late raw evidence does not steal online identity')}
    else {check(/POS_/.test(result.second.error??''),true,'raw evidence rejects competing online order');await noFinancial(f,'raw before online')}
  }
}
try {
  await initialize();if(process.argv.includes('--large-only'))await largeHistoricalCase();else{await scenarios();await concurrency();await largeHistoricalCase()}report.status='passed'
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
