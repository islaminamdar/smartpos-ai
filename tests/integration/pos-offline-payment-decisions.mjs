// Synthetic disposable SQL020 manager payment-decision tests. No real merchants, provider calls or signature claims.
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
    database = 'pos_qa_decisions_' + uid().replaceAll('-', '')
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
  const files = (await readdir(directory)).filter(f => /^20261016/.test(f) && !f.includes('007') && !f.includes('009') && f < '202610160021').sort()
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
async function scenarios(){
  for(const tender of ['cash','card','mixed']){
    const f=await managerFixture({tender}),r=request(f),first=await decide(f,r)
    check(first.replayed,false,tender+' return creates one decision');check(first.resolutionEnvelope,null,tender+' unsigned decision stays delivery pending')
    check(first.resolution.decision,'funds_returned',tender+' return type retained');check(first.resolution.replacement,null,tender+' return creates no replacement invoice')
    check(first.resolution.managerActorId,f.manager,tender+' current approving manager recorded');check(first.resolution.actorId,f.owner,tender+' original cashier remains distinct')
    check(first.resolution.requestSha256,f.freeze.requestSha256,tender+' original frozen basket hash preserved');check(first.resolution.evidenceSha256,hash(canonical(r.evidence)),tender+' evidence hash is exact canonical array')
    await noFinancial(f,tender+' returned')
    await rejects(()=>service('pos_offline_seal',...sealArgs(f)),/POS_OFFLINE_PAYMENT_HOLD/,tender+' signing pending blocks seal')
    await rejects(()=>db.query("update public.pos_shifts set status='closed',closed_at=now() where id=$1",[f.shift]),/POS_/,tender+' signing pending blocks closing original drawer')
    await enablePolicy(f,false)
    const retry=await decide(f,r,f.manager,new Date(Date.now()-600000).toISOString());check(retry.replayed,true,tender+' exact retry recovers paused old decision');check(retry.resolution,first.resolution,tender+' retry preserves first result timestamp and ID')
    await rejects(()=>decide(f,{...r,reason:'Changed statement'}),/POS_/,tender+' request ID cannot change evidence or reason')
    await rejects(()=>decide(f,{...r,requestId:uid()}),/POS_/,tender+' second request ID cannot create another terminal outcome')
    await rejects(()=>decide(f,r,f.owner),/POS_/,tender+' other current manager cannot claim original request retry')
    const signed=envelope(first.resolution),attached=await attach(first.resolution,signed)
    check(attached.resolutionEnvelope,signed,tender+' stores original server envelope')
    const resigned=await attach(first.resolution,envelope(first.resolution,'synthetic-rotated-server','MAgCAQECAQI'));check(resigned.resolutionEnvelope,signed,tender+' rotated resign returns exact first stored envelope')
    check(await count('pos_offline_intent_claims','payment_intent_id=$1',[f.freeze.paymentIntentId]),1,tender+' decision never releases original identity claim')
    check(await scalar('select public.pos_offline_payment_hold($1)',[f.enrollment.keyEpoch]),false,tender+' signed clean outcome releases only own pending hold')
    check((await service('pos_offline_seal',...sealArgs(f))).status,'sealed',tender+' signed outcome permits explicit unused allocation seal')
    await db.query("update public.pos_shifts set status='closed',closed_at=now() where id=$1",[f.shift]);check(await scalar('select status from public.pos_shifts where id=$1',[f.shift]),'closed',tender+' explicitly sealed completed case can close')
    for(const table of ['pos_offline_payment_decisions','pos_offline_payment_result_signatures']){
      const column=await scalar('select column_name from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position limit 1',['public',table])
      await rejects(()=>db.exec(`update public.${table} set ${column}=${column}`),/POS_|immutable/i,table+' rows cannot be rewritten')
      await rejects(()=>db.exec(`delete from public.${table}`),/POS_|immutable/i,table+' rows cannot be deleted')
    }
  }
  {
    const f=await managerFixture({tender:'card'}),r=request(f,'payment_voided'),result=await decide(f,r)
    check(result.resolution.decision,'payment_voided','card-only full authorization void accepted');check(r.cashDrawerShiftId,null,'card-only evidence requires no drawer');await noFinancial(f,'card void')
  }
  for(const opts of [{role:'cashier'},{active:false},{policy:false}]){
    const f=await managerFixture(opts);await rejectNew(f,request(f))
  }
  {
    const f=await managerFixture(),other=await fixture();await rejects(()=>decide(f,request(f),other.owner),/POS_/,'foreign organization owner cannot approve case')
    const branch=uid();await db.query('insert into public.pos_branches(id,organization_id,name) values($1,$2,$3)',[branch,f.org,'Other synthetic branch']);await db.query('update public.pos_staff set branch_id=$1 where organization_id=$2 and user_id=$3',[branch,f.org,f.manager]);await rejectNew(f,request(f))
  }
  {
    const f=await managerFixture({assigned:false});check((await decide(f,request(f))).resolution.managerActorId,f.manager,'organization-wide manager can approve assigned organization branch')
  }
  for(const offset of [-121000,10000]){
    const f=await managerFixture();await rejects(()=>decide(f,request(f),f.manager,new Date(Date.now()+offset).toISOString()),/POS_/,'stale or future password confirmation rejected');check(await count('pos_offline_payment_decisions','freeze_id=$1',[f.freeze.freezeId]),0,'invalid confirmation makes no decision')
  }
  {
    const f=await managerFixture();check((await decide(f,request(f),f.manager,new Date(Date.now()-119000).toISOString())).replayed,false,'confirmation within120-second window accepted')
  }
  const mutations={cashTenderRatherThanNet:r=>r.evidence[0].amountFils=1500,partial:r=>r.evidence[0].amountFils=999,zero:r=>r.evidence[0].amountFils=0,fraction:r=>r.evidence[0].amountFils=1000.5,unknown:r=>r.extra=true,nestedUnknown:r=>r.evidence[0].extra=true,emptyReference:r=>r.evidence[0].reference='',untrimmedReason:r=>r.reason=' extra ',badTime:r=>r.evidence[0].completedAt='not-a-time',futureTime:r=>r.evidence[0].completedAt=new Date(Date.now()+60000).toISOString(),reversedTimes:r=>r.evidence[0].completedAt='2000-01-01T00:00:00.000Z',wrongDrawer:r=>r.cashDrawerShiftId=uid(),missingDrawer:r=>r.cashDrawerShiftId=null,wrongHash:r=>r.freezeSha256='0'.repeat(64),cashVoid:r=>r.decision='payment_voided',unknownDecision:r=>r.decision='current_time_invoice',missingLeg:r=>r.evidence=[],extraLeg:r=>r.evidence.push(clone(r.evidence[0])),nulReason:r=>r.reason='A\0B',nulNote:r=>r.evidence[0].note='A\0B'}
  for(const [name,mutate] of Object.entries(mutations)){
    const f=await managerFixture(),r=request(f);mutate(r);await rejects(()=>decide(f,r),/POS_|unicode|unsupported|invalid|canonical/i,name+' rejected before decision');check(await count('pos_offline_payment_decisions','freeze_id=$1',[f.freeze.freezeId]),0,name+' creates no terminal decision');await noFinancial(f,name)
  }
  for(const bad of ['reversed','cardAmount','mixedVoid']){
    const f=await managerFixture({tender:'mixed'}),r=request(f);if(bad==='reversed')r.evidence.reverse();if(bad==='cardAmount')r.evidence[1].amountFils=399;if(bad==='mixedVoid')r.decision='payment_voided';await rejectNew(f,r)
  }
  {
    const f=await managerFixture(),r=request(f),draft=(await decide(f,r)).resolution,beforeSignatures=await count('pos_offline_payment_result_signatures')
    for(const mutation of ['payload','noncanonical','malformedKey','extraEnvelope']){
      const signed=envelope(draft);if(mutation==='payload')signed.payloadBase64Url=Buffer.from(canonical({...draft,managerActorId:uid()})).toString('base64url');if(mutation==='noncanonical')signed.payloadBase64Url=Buffer.from(canonical(draft)+' ').toString('base64url');if(mutation==='malformedKey')signed.keyId='contains spaces';if(mutation==='extraEnvelope')signed.extra=true
      await rejects(()=>attach(draft,signed),/POS_/,mutation+' result attachment rejected');check(await count('pos_offline_payment_result_signatures'),beforeSignatures,'invalid attachment creates no new signature')
    }
    await attach(draft);check(await scalar('select public.pos_offline_payment_hold($1)',[f.enrollment.keyEpoch]),false,'valid attachment can follow rejected attempts')
    const late=await service('pos_offline_import',...importArgs(f,f.sale));check(late.status,'reconciliation_required','late original issuance after signed decision remains conflict');check(await scalar('select public.pos_offline_payment_hold($1)',[f.enrollment.keyEpoch]),true,'late contradiction restores durable hold');await noFinancial(f,'late contradictory issuance')
    check((await decide(f,r)).resolution,draft,'exact manager retry cannot erase late contradiction or rewrite result');await rejects(()=>service('pos_offline_seal',...sealArgs(f)),/POS_OFFLINE_PAYMENT_HOLD/,'signed outcome cannot hide later conflict from sealing');await rejects(()=>service('pos_offline_reserve',f.owner,{...f.request,requestId:uid()}),/POS_/,'signed outcome cannot bypass later conflict renewal hold')
  }
  {
    const f=await managerFixture(),second=freeze(f);await register(f,second)
    const d=(await decide(f,request(f))).resolution;await attach(d)
    check(await scalar('select public.pos_offline_payment_hold($1)',[f.enrollment.keyEpoch]),true,'one signed outcome never clears another pending freeze in same epoch')
    await rejects(()=>service('pos_offline_seal',...sealArgs(f)),/POS_OFFLINE_PAYMENT_HOLD/,'remaining unrelated pending freeze blocks seal')
    await noFinancial(f,'partial epoch resolution')
  }
  {
    const f=await managerFixture();check((await decide(f,request(f),f.owner)).resolution.managerActorId,f.owner,'active organization owner may approve original branch case')
  }
  for(const kind of ['conflict','raw']){
    const f=await managerFixture();if(kind==='conflict'){const changed=clone(f.freeze);changed.request.cashTenderedFils=2000;changed.requestSha256=hash(canonical(changed.request));await register(f,changed)}else{const raw=clone(f.freeze);raw.request.customer={name:'Old\0buyer',address:'Synthetic address',trn:null};raw.requestSha256=hash(canonical(raw.request));await service('pos_offline_retain_unsupported',f.bundle.authority.id,signedFreeze(f,raw))}
    await rejectNew(f,request(f));await noFinancial(f,kind+' blocked case')
  }
  {
    const f=await managerFixture(),draft=(await decide(f,request(f))).resolution;await attach(draft);await service('pos_offline_seal',...sealArgs(f));const next=await service('pos_offline_reserve',f.owner,{...f.request,requestId:uid()});check(next.authority.id!==f.bundle.authority.id,true,'signed clean resolution plus explicit seal permits later allocation');check(await count('pos_offline_intent_claims','payment_intent_id=$1',[f.freeze.paymentIntentId]),1,'renewal retains original claim forever')
  }
}
async function concurrency(){
  if(!postgres){report.concurrency='Not tested: PGlite cannot prove independent sessions';return}
  for(const decisionFirst of [true,false]){
    const f=await managerFixture(),r=request(f),decideOp=c=>rpcOn(c,'pos_offline_payment_decide',f.manager,r,new Date().toISOString()),importOp=c=>rpcOn(c,'pos_offline_import',...importArgs(f,f.sale))
    const result=await raced(decisionFirst?'decision_before_import':'import_before_decision',decisionFirst?decideOp:importOp,decisionFirst?importOp:decideOp)
    if(decisionFirst){check(result.first.resolution.decision,'funds_returned','decision wins shared intent lock');check(result.second.value?.status,'reconciliation_required','late import cannot create invoice after decision')}
    else{check(result.first.status,'reconciliation_required','already frozen import retained as conflict');check(/POS_/.test(result.second.error??''),true,'conflict winning first blocks new decision')}
    await noFinancial(f,'decision/import race')
  }
  for(const sameRequest of [true,false]){
    const f=await managerFixture(),r=request(f),other=sameRequest?r:{...r,requestId:uid()}
    const result=await raced(sameRequest?'decision_exact_retry':'decision_competing_ids',c=>rpcOn(c,'pos_offline_payment_decide',f.manager,r,new Date().toISOString()),c=>rpcOn(c,'pos_offline_payment_decide',f.manager,other,new Date().toISOString()))
    if(sameRequest){check(result.second.value?.replayed,true,'simultaneous exact decision returns original');check(result.second.value?.resolution,result.first.resolution,'simultaneous exact decision preserves original result')}
    else check(/POS_IDEMPOTENCY_CONFLICT/.test(result.second.error??''),true,'different request IDs cannot resolve same freeze twice')
    check(await count('pos_offline_payment_decisions','freeze_id=$1',[f.freeze.freezeId]),1,'decision race produces exactly one immutable row')
  }
  for(const revokeFirst of [true,false]){
    const f=await managerFixture(),r=request(f),command={id:uid(),branchId:f.branch,deviceId:f.device,targetUserId:f.manager,expectedRevision:1,active:false,role:'manager',assignedBranchId:f.branch,displayName:'Synthetic revoked manager',reason:'Synthetic access revocation'}
    const decideOp=c=>rpcOn(c,'pos_offline_payment_decide',f.manager,r,new Date().toISOString()),revokeOp=c=>rpcOn(c,'pos_manage_staff',command,f.binding)
    const result=await raced(revokeFirst?'revoke_before_decision':'decision_before_revoke',revokeFirst?revokeOp:decideOp,revokeFirst?decideOp:revokeOp,{firstRole:revokeFirst?'authenticated':'service_role',secondRole:revokeFirst?'service_role':'authenticated',actor:f.owner})
    if(revokeFirst){check(result.first.status,'updated','actual staff writer revokes manager first');check(/POS_/.test(result.second.error??''),true,'manager decision rechecks after authority lock release');check(await count('pos_offline_payment_decisions','freeze_id=$1',[f.freeze.freezeId]),0,'revoked manager creates no decision')}
    else{check(result.first.resolution.managerActorId,f.manager,'decision holds current authority until committed');check(result.second.value?.status,'updated','revocation proceeds after committed decision');check(await count('pos_offline_payment_decisions','freeze_id=$1',[f.freeze.freezeId]),1,'later revocation preserves already committed evidence')}
    await rejects(()=>decide(f,r),/POS_/,'revoked manager cannot even retrieve via manager retry')
  }
  {
    const f=await managerFixture(),d=(await decide(f,request(f))).resolution,first=envelope(d),second=envelope(d,'synthetic-rotated-server','MAgCAQECAQI')
    const result=await raced('competing_signature_attachments',c=>rpcOn(c,'pos_offline_payment_attach',d.resolutionId,first),c=>rpcOn(c,'pos_offline_payment_attach',d.resolutionId,second))
    check(result.first.resolutionEnvelope,first,'first attachment stores envelope');check(result.second.value?.resolutionEnvelope,first,'competing resign returns exact first bytes')
  }
  {
    const f=await managerFixture(),d=(await decide(f,request(f))).resolution
    const result=await raced('signature_before_seal',c=>rpcOn(c,'pos_offline_payment_attach',d.resolutionId,envelope(d)),c=>rpcOn(c,'pos_offline_seal',...sealArgs(f)))
    check(result.second.value?.status,'sealed','seal observes committed signature and resolved hold')
  }
  {
    const f=await managerFixture(),r=request(f)
    const result=await raced('decision_before_close',c=>rpcOn(c,'pos_offline_payment_decide',f.manager,r,new Date().toISOString()),async c=>{await c.query("update public.pos_shifts set status='closed',closed_at=now() where id=$1",[f.shift]);return 'closed'},{secondRole:null})
    check(/POS_/.test(result.second.error??''),true,'closing drawer waits for unsigned decision then remains blocked');check(await scalar('select status from public.pos_shifts where id=$1',[f.shift]),'open','blocked concurrent close preserves open drawer')
  }
}
async function readers(){
  const f=await managerFixture(),known=[f.freeze.freezeId]
  for(let i=1;i<52;i++){const proof=freeze(f);await register(f,proof);known.push(proof.freezeId)}
  const raw=freeze(f);raw.request.customer={name:'Old\0buyer',address:'Synthetic address',trn:null};raw.requestSha256=hash(canonical(raw.request))
  const held=await service('pos_offline_retain_unsupported',f.bundle.authority.id,signedFreeze(f,raw));known.push(held.exceptionId)
  const first=await service('pos_offline_payment_list',f.manager,f.branch,null)
  check(first.cases.length,50,'list returns at most50 case summaries');check(first.nextCursor!==null,true,'bounded first page has continuation')
  check(first.nextCursor.recordedAt,first.cases[49].recordedAt,'keyset cursor preserves exact final timestamp');check(/\.\d{6}Z$/.test(first.nextCursor.recordedAt),true,'keyset timestamp retains database microseconds')
  const second=await service('pos_offline_payment_list',f.manager,f.branch,first.nextCursor)
  check(second.cases.length,3,'second page returns exact remaining cases');check(second.nextCursor,null,'last page ends cursor')
  const all=[...first.cases,...second.cases];check(new Set(all.map(x=>x.caseId)).size,53,'keyset pages neither repeat nor skip cases');check(all.map(x=>x.caseId).sort(),known.sort(),'all freeze and raw cases represented exactly once');check(all.every(x=>x.branchId===f.branch),true,'list remains branch scoped')
  check(all.some(x=>x.caseKind==='raw'&&x.state==='unsupported_text'&&x.grossFils===null),true,'raw amount remains unknown rather than fabricated zero')
  for(const cursor of [{...first.nextCursor,caseKind:null},{...first.nextCursor,extra:true},{...first.nextCursor,recordedAt:'2026-02-30T00:00:00.000000Z'}])await rejects(()=>service('pos_offline_payment_list',f.manager,f.branch,cursor),/POS_|date|time/i,'invalid typed or calendar cursor rejected')
  const detail=await service('pos_offline_payment_detail',f.manager,f.branch,f.freeze.freezeId,'freeze')
  check(detail.freezeEnvelope,signedFreeze(f,f.freeze),'manager detail returns exact stored freeze envelope')
  check(detail.quote.payments,[{method:'cash',amountFils:1000}],'manager detail separates cash net from tender');check(detail.quote.cashTenderedFils,1500,'manager detail preserves original note tender');check(detail.quote.changeFils,500,'manager detail preserves original change')
  check(detail.capabilities.canDecide,false,'raw custody prevents decision capability');check(detail.capabilities.holdCode,'unsupported_text','blocked capability explains raw custody')
  const rawDetail=await service('pos_offline_payment_detail',f.manager,f.branch,held.exceptionId,'raw')
  for(const field of ['freezeEnvelope','request','quote','decisionRequest','resolution','resolutionEnvelope'])check(rawDetail[field],null,'raw detail never pretends parsed '+field)
  check(rawDetail.capabilities.canDecide,false,'raw detail cannot authorize a decision')
  const foreign=await fixture();await rejects(()=>service('pos_offline_payment_list',foreign.owner,f.branch,null),/POS_ACCESS_DENIED/,'foreign organization cannot enumerate cases');await rejects(()=>service('pos_offline_payment_detail',foreign.owner,f.branch,f.freeze.freezeId,'freeze'),/POS_ACCESS_DENIED/,'foreign organization cannot retrieve full proof')
  await rejects(()=>service('pos_offline_payment_detail',f.manager,f.branch,uid(),'freeze'),/POS_OFFLINE_CASE_UNKNOWN/,'nonexistent scoped case has bounded error')
  await db.query("update public.pos_staff set role='cashier' where organization_id=$1 and user_id=$2",[f.org,f.manager]);await rejects(()=>service('pos_offline_payment_list',f.manager,f.branch,null),/POS_ACCESS_DENIED|POS_MANAGER_REQUIRED/,'cashier cannot enumerate manager evidence');await rejects(()=>service('pos_offline_payment_detail',f.manager,f.branch,f.freeze.freezeId,'freeze'),/POS_ACCESS_DENIED|POS_MANAGER_REQUIRED/,'cashier cannot retrieve full manager evidence')
  await db.query("update public.pos_staff set role='manager',active=false where organization_id=$1 and user_id=$2",[f.org,f.manager]);await rejects(()=>service('pos_offline_payment_detail',f.manager,f.branch,f.freeze.freezeId,'freeze'),/POS_ACCESS_DENIED/,'removed manager cannot retrieve prior case')
  const clean=await managerFixture({policy:false}),off=await service('pos_offline_payment_detail',clean.manager,clean.branch,clean.freeze.freezeId,'freeze');check(off.capabilities.policyEnabled,false,'default disabled policy visible in detail');check(off.capabilities.canDecide,false,'default disabled policy gives no decision capability')
}
async function acl(){
  for(const table of ['pos_offline_payment_resolution_policy','pos_offline_payment_decisions','pos_offline_payment_result_signatures']){
    check(await scalar('select relrowsecurity from pg_class where oid=$1::regclass',['public.'+table]),true,table+' enables RLS')
    for(const role of ['anon','authenticated','service_role'])check(await scalar('select has_table_privilege($1,$2,$3)',[role,'public.'+table,'SELECT,INSERT,UPDATE,DELETE']),false,role+' cannot directly access '+table)
  }
  const funcs=(await db.query("select p.proname,p.oid::regprocedure::text signature,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pos_offline_payment_%'")).rows
  const granted=new Set(['pos_offline_payment_freeze','pos_offline_payment_case','pos_offline_payment_decide','pos_offline_payment_attach','pos_offline_payment_detail','pos_offline_payment_list'])
  for(const f of funcs){for(const role of ['anon','authenticated'])check(await scalar('select has_function_privilege($1,$2,$3)',[role,f.signature,'EXECUTE']),false,role+' cannot invoke '+f.signature)
    if(!granted.has(f.proname))check(await scalar("select has_function_privilege('service_role',$1,'EXECUTE')",[f.signature]),false,'private helper inaccessible '+f.signature)
  }
}

try {
  await initialize();await scenarios();await concurrency();await readers();await acl();report.status='passed'
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
