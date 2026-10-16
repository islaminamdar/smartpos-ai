// Synthetic disposable SQL021 historical device-query retrieval tests. No real merchants, provider calls or signature claims.
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
    database = 'pos_qa_retrieval_' + uid().replaceAll('-', '')
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
  const files = (await readdir(directory)).filter(f => /^20261016/.test(f) && !f.includes('007') && !f.includes('009') && f < '202610160022').sort()
  for (const file of files) { const sql = await readFile(new URL(file, directory), 'utf8'); report.migrationHashes[file] = hash(sql); await db.exec(sql) }
  await save()
}

async function fixture() {
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

// The server verifies passwords/P256 signatures; these isolated SQL tests exercise
// the service_role trust boundary using synthetic signature bytes, never real money.
const decide = (f,request,actor=f.manager,confirmedAt=new Date().toISOString()) => service('pos_offline_payment_decide',actor,request,confirmedAt)
const attach = (resolution,signed=envelope(resolution)) => service('pos_offline_payment_attach',resolution.resolutionId,signed)
async function managerFixture({role='manager',assigned=true,active=true,policy=true,tender='cash'}={}) {
  const f=await fixture();f.manager=uid()
  await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[f.manager,'synthetic-manager@example.test'])
  await db.query('insert into public.pos_staff(organization_id,user_id,branch_id,role,active) values($1,$2,$3,$4,$5)',[f.org,f.manager,assigned?f.branch:null,role,active])
  // Policy name/columns are part of the frozen SQL020 contract.
  if(policy) await enablePolicy(f)
  f.sale=sale(f);f.freeze=freeze(f,f.sale)
  if(tender==='card'){f.freeze.request.cashTenderedFils=0;f.freeze.request.recordedCardFils=1000}
  if(tender==='mixed'){f.freeze.request.cashTenderedFils=700;f.freeze.request.recordedCardFils=400}
  f.freeze.requestSha256=hash(canonical(f.freeze.request));await register(f,f.freeze)
  return f
}
function request(f,decision='funds_returned') {
  const card=f.freeze.request.recordedCardFils,cash=1000-card,completedAt=new Date().toISOString()
  const evidence=[]
  for(const [method,amountFils] of [['cash',cash],['card',card]]) if(amountFils)evidence.push({method,amountFils,paymentObservedAt:f.bundle.authority.issuedAt,completedAt,reference:'Synthetic '+method+' reference',note:'Synthetic completed external action, no processor call'})
  return {requestId:uid(),freezeId:f.freeze.freezeId,freezeSha256:eh(signedFreeze(f,f.freeze)),decision,reason:'Synthetic completed full return or authorization void',evidence,cashDrawerShiftId:cash?f.shift:null}
}
async function noFinancial(f,label) {
  for(const table of ['pos_orders','pos_documents','pos_payments','pos_refunds','pos_cash_movements','pos_offline_receipts'])check(await count(table,'branch_id=$1',[f.branch]),0,label+' creates no '+table)
  check(await scalar('select invoice_count from public.pos_offline_authorities where id=$1',[f.bundle.authority.id]),0,label+' consumes no invoice count')
  check(await scalar('select gross_fils::int from public.pos_offline_authorities where id=$1',[f.bundle.authority.id]),0,label+' records no offline revenue')
  check(await scalar('select last_sequence::int from public.pos_offline_key_epochs where id=$1',[f.enrollment.keyEpoch]),0,label+' does not advance device chain')
}
async function rejectNew(f,r,pattern=/POS_/){await rejects(()=>decide(f,r),pattern,'invalid decision rejected');check(await count('pos_offline_payment_decisions','freeze_id=$1',[f.freeze.freezeId]),0,'invalid decision creates no terminal row')}
async function enablePolicy(f,enabled=true){await db.query('insert into public.pos_offline_payment_resolution_policy(branch_id,enabled) values($1,$2) on conflict(branch_id) do update set enabled=excluded.enabled',[f.branch,enabled])}
const readArgs = f => [f.bundle.authority.id,f.enrollment.keyEpoch,f.device,f.freeze.freezeId,eh(signedFreeze(f,f.freeze))]
const readCase = f => service('pos_offline_payment_native_read',...readArgs(f))
const custody = async f => {
  const result={}
  for(const [table,where,params] of [
    ['pos_offline_authorities','id=$1',[f.bundle.authority.id]],['pos_offline_key_epochs','id=$1',[f.enrollment.keyEpoch]],
    ['pos_offline_payment_freezes','id=$1',[f.freeze.freezeId]],['pos_offline_intent_claims','authority_id=$1',[f.bundle.authority.id]],
    ['pos_offline_payment_decisions','freeze_id=$1',[f.freeze.freezeId]],['pos_offline_payment_result_signatures','resolution_id in (select id from public.pos_offline_payment_decisions where freeze_id=$1)',[f.freeze.freezeId]],
  ]) result[table]=(await db.query(`select to_jsonb(x) row from public.${table} x where ${where}`,params)).rows
  return result
}
async function scenarios(){
  const f=await managerFixture(),before=await custody(f),pending=await readCase(f)
  check(Object.keys(pending).sort(),['state','freezeEnvelope','decisionRequest','resolution','resolutionEnvelope','managerActorId'].sort(),'exact historical reader shape')
  check(pending,{state:'pending',freezeEnvelope:signedFreeze(f,f.freeze),decisionRequest:null,resolution:null,resolutionEnvelope:null,managerActorId:null},'registered original pending evidence')
  check(await custody(f),before,'pending retrieval is read-only')
  for(let i=0;i<5;i++){const args=readArgs(f);args[i]=i===4?'0'.repeat(64):uid();await rejects(()=>service('pos_offline_payment_native_read',...args),/POS_OFFLINE_CASE_UNKNOWN/,'wrong independently routed field '+i+' rejected')}
  for(const value of [null,'','A'.repeat(64),'f'.repeat(63),'f'.repeat(65)]){const args=readArgs(f);args[4]=value;await rejects(()=>service('pos_offline_payment_native_read',...args),/POS_OFFLINE_CASE_UNKNOWN/,'malformed proof hash rejected')}
  const other=await managerFixture();for(let i=0;i<5;i++){const args=readArgs(f);args[i]=readArgs(other)[i];await rejects(()=>service('pos_offline_payment_native_read',...args),/POS_OFFLINE_CASE_UNKNOWN/,'foreign scope component '+i+' rejected')}
  const r=request(f),decision=await decide(f,r),unsigned=await readCase(f)
  check(unsigned.state,'pending','accepted unsigned decision remains pending')
  check(unsigned.resolution,decision.resolution,'only committed immutable decision draft recoverable')
  check(unsigned.decisionRequest,r,'exact manager evidence retained for service validation')
  check(unsigned.managerActorId,f.manager,'actual deciding actor returned')
  check(unsigned.resolutionEnvelope,null,'no signature invented')
  const first=envelope(decision.resolution),attached=await attach(decision.resolution,first),signed=await readCase(f)
  check(signed.state,'resolved','attached terminal result recoverable')
  check(signed.resolutionEnvelope,first,'first exact signature preserved')
  check(attached.resolutionEnvelope,first,'attach actual first signature')
  const stable=await custody(f);await readCase(f);check(await custody(f),stable,'signed retrieval no custody writes')
  await db.query('update public.pos_staff set active=false where organization_id=$1',[f.org]);await db.query('update public.pos_devices set active=false where id=$1',[f.device]);await enablePolicy(f,false)
  await db.query('update public.pos_offline_branch_policy set enabled=false where branch_id=$1',[f.branch]);await db.query('update public.pos_offline_key_epochs set blocked=true where id=$1',[f.enrollment.keyEpoch])
  check((await readCase(f)).resolutionEnvelope,first,'historical retrieval independent of login/revocation/sales policies/epoch block')
  await noFinancial(f,'historical retrieval')
  const late=await service('pos_offline_import',...importArgs(f,f.sale));check(late.status,'reconciliation_required','late genuine signed issuance retained as contradiction')
  const conflicted=await readCase(f);check(conflicted.state,'conflict','new contradiction outranks prior signed outcome')
  for(const key of ['resolution','resolutionEnvelope','decisionRequest','managerActorId'])check(conflicted[key],null,'conflict never supplies '+key)
  check(await count('pos_offline_payment_result_signatures','resolution_id=$1',[decision.resolution.resolutionId]),1,'contradiction preserves original result signature')
  const raw=await fixture();raw.freeze=freeze(raw);raw.freeze.request.customer={name:'Historical\u0000buyer',address:'Synthetic address',trn:null};raw.freeze.requestSha256=hash(canonical(raw.freeze.request))
  const rawProof=signedFreeze(raw,raw.freeze);await service('pos_offline_retain_unsupported',raw.bundle.authority.id,rawProof)
  const retained=await readCase(raw);check(retained.state,'conflict','raw unsupported historical freeze readable as conflict');check(retained.freezeEnvelope,rawProof,'raw original ASCII envelope retained exactly');check(retained.resolution,null,'raw proof never resolved')
  await noFinancial(raw,'raw historical query')
  const issued=await fixture();issued.sale=sale(issued);issued.freeze=freeze(issued,issued.sale);const imported=await service('pos_offline_import',...importArgs(issued,issued.sale));check(imported.status,'accepted','synthetic preexisting bill imported')
  check((await register(issued,issued.freeze)).status,'already_issued','registration returns original receipt evidence')
  const contradiction=await readCase(issued);check(contradiction.state,'conflict','query-only receipt-before-freeze remains conservatively conflict');check(contradiction.freezeEnvelope,signedFreeze(issued,issued.freeze),'query retains original contradictory freeze')
  check(await count('pos_offline_receipts','authority_id=$1',[issued.bundle.authority.id]),1,'query never duplicates original receipt')
  await rejects(()=>service('pos_offline_seal',...sealArgs(raw)),/POS_/,'raw query does not clear seal hold')
  await rejects(()=>service('pos_offline_seal',...sealArgs(f)),/POS_/,'conflict query does not clear seal hold')
}
async function concurrency(){
  if(!postgres)return
  let f=await managerFixture(),r=request(f)
  let race=await raced('decision_then_query',a=>rpcOn(a,'pos_offline_payment_decide',f.manager,r,new Date().toISOString()),b=>rpcOn(b,'pos_offline_payment_native_read',...readArgs(f)))
  check(race.second.value.state,'pending','waited query sees unsigned committed decision');check(race.second.value.resolution,race.first.resolution,'query returns exact post-wait decision')
  const result=race.first.resolution
  race=await raced('signature_then_query',a=>rpcOn(a,'pos_offline_payment_attach',result.resolutionId,envelope(result)),b=>rpcOn(b,'pos_offline_payment_native_read',...readArgs(f)))
  check(race.second.value.state,'resolved','waited query sees atomic attached result');check(race.second.value.resolutionEnvelope,race.first.resolutionEnvelope,'query receives original committed signature')
  race=await raced('late_import_then_query',a=>rpcOn(a,'pos_offline_import',...importArgs(f,f.sale)),b=>rpcOn(b,'pos_offline_payment_native_read',...readArgs(f)))
  check(race.first.status,'reconciliation_required','late import durably records collision');check(race.second.value.state,'conflict','waited reader sees committed late contradiction')
  f=await managerFixture();r=request(f)
  race=await raced('query_then_decision',a=>rpcOn(a,'pos_offline_payment_native_read',...readArgs(f)),b=>rpcOn(b,'pos_offline_payment_decide',f.manager,r,new Date().toISOString()))
  check(race.first.state,'pending','query serializes before decision');check(race.second.value.resolution.freezeId,f.freeze.freezeId,'decision after query commits same case')
}
async function acl(){
  const signature='public.pos_offline_payment_native_read(uuid,uuid,uuid,uuid,text)'
  const row=(await db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure',[signature])).rows[0]
  check(row.prosecdef,true,'reader SECURITY DEFINER');check(row.proconfig.includes('search_path=""'),true,'reader empty search_path')
  for(const role of ['anon','authenticated']){
    check(await scalar('select has_function_privilege($1,$2,$3)',[role,signature,'EXECUTE']),false,role+' cannot invoke historical reader')
    await db.exec('set role '+role);try{await rejects(()=>rpcOn(db,'pos_offline_payment_native_read',uid(),uid(),uid(),uid(),'0'.repeat(64)),/permission denied/,'actual '+role+' RPC denied')}finally{await db.exec('reset role')}
  }
  check(await scalar("select has_function_privilege('service_role',$1,'EXECUTE')",[signature]),true,'only trusted service role invokes reader after signature verification')
}

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
