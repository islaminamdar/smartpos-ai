// Synthetic disposable SQL018 tests. No real merchants, provider calls or signature claims.
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
    database = 'pos_qa_freeze_' + uid().replaceAll('-', '')
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
  const files = (await readdir(directory)).filter(f => /^20261016/.test(f) && !f.includes('007') && !f.includes('009') && f < '202610160018').sort()
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
async function migrated() {
  const f = await fixture(), issued = sale(f), args = importArgs(f, issued)
  const accepted = await service('pos_offline_import', ...args); check(accepted.status, 'accepted', '017 baseline actual financial receipt')
  const seal = sealArgs(f, 1, eh(args[1])); await service('pos_offline_seal', ...seal)
  const original = await scalar('select row_to_json(r) from public.pos_offline_receipts r where issuance_id=$1', [issued.id])
  const file = '20261016001800_pos_offline_payment_resolution.sql', sql = await readFile(new URL('../../supabase/migrations/' + file, import.meta.url), 'utf8')
  report.migrationHashes[file] = hash(sql); await db.exec(sql)
  check(await scalar('select row_to_json(r) from public.pos_offline_receipts r where issuance_id=$1', [issued.id]), original, '018 preserves original receipt and ACK')
  check(await count('pos_offline_intent_claims', 'payment_intent_id=$1', [issued.paymentIntentId]), 1, '018 backfills historical receipt identity claim')
  const replay = await service('pos_offline_import', ...importArgs(f, issued, 'MAgCAQECAQI'))
  check(replay.acknowledgement, args[2], 'backfilled receipt retry keeps first ACK after seal')
  check(replay.replayed, true, 'backfilled receipt retry is recognized')
  const contradiction = await register(f, freeze(f, issued))
  check(contradiction.status, 'already_issued', 'receipt before freeze returns original custody')
  check(contradiction.receipt, issued.document, 'already-issued result retains exact original document')
  check(contradiction.acknowledgement, args[2], 'already-issued result retains original ACK')
  check(contradiction.issuanceEnvelope, args[1], 'already-issued includes original device-signed envelope')
  check((await service('pos_offline_seal', ...seal)).status, 'sealed', 'original seal retry remains recoverable after contradiction')
  await rejects(service('pos_offline_reserve', f.owner, { ...f.request, requestId: uid() }), /POS_/, 'sealed grant contradiction blocks renewal')
  await rejects(db.query("update public.pos_shifts set status='closed',closed_at=now() where id=$1", [f.shift]), /POS_/, 'contradiction blocks closing original drawer')
}

async function acl() {
  const functions = (await db.query("select p.oid::regprocedure::text signature,p.prosecdef,p.proconfig,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pos_offline_%'")).rows
  assert.ok(functions.length >= 2)
  for (const fn of functions) for (const role of ['anon', 'authenticated']) check(await scalar('select has_function_privilege($1,$2,$3)', [role, fn.signature, 'EXECUTE']), false, `${role} cannot call ${fn.signature}`)
  const serviceAllowed = new Set(['pos_offline_enroll','pos_offline_reserve','pos_offline_attach','pos_offline_authority','pos_offline_import','pos_offline_seal','pos_offline_reject','pos_offline_limit','pos_offline_payment_freeze','pos_offline_payment_case'])
  for (const fn of functions) if (!serviceAllowed.has(fn.proname)) check(await scalar('select has_function_privilege($1,$2,$3)', ['service_role', fn.signature, 'EXECUTE']), false, `service_role cannot directly bypass via ${fn.signature}`)
  for (const fn of functions) if (fn.proname === 'pos_offline_payment_freeze' || fn.proname === 'pos_offline_payment_case') {
    check(fn.prosecdef, true, `${fn.proname} is security definer`)
    assert.ok(fn.proconfig?.some(v => /^search_path=(""|)$/.test(v)), `${fn.proname} pins empty search_path`); report.checks.push(`${fn.proname} empty search_path`)
  }
  const tables = ['pos_offline_intent_claims', 'pos_offline_payment_freezes', 'pos_offline_payment_conflicts']
  for (const table of tables) {
    check(await scalar('select relrowsecurity from pg_class where oid=$1::regclass', ['public.' + table]), true, `${table} enables RLS`)
    for (const role of ['anon', 'authenticated', 'service_role']) check(await scalar('select has_table_privilege($1,$2,$3)', [role, 'public.' + table, 'SELECT,INSERT,UPDATE,DELETE']), false, `${role} has no direct ${table} access`)
  }
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

async function concurrency() {
  if (!postgres) { report.concurrency = 'not tested: embedded PGlite cannot prove independent PostgreSQL lock ordering'; return }
  {
    const f = await fixture(), salePayload = sale(f), proof = freeze(f, salePayload)
    const result = await raced('freeze_before_import', c => rpcOn(c, 'pos_offline_payment_freeze', signedFreeze(f, proof)), c => rpcOn(c, 'pos_offline_import', ...importArgs(f, salePayload)))
    check(result.first.status, 'registered', 'race freeze commits first'); check(result.second.value?.status, 'reconciliation_required', 'late receipt cannot cross committed freeze')
    check(await count('pos_documents', 'id=$1', [salePayload.document.id]), 0, 'race leaves no frozen document')
  }
  {
    const f = await fixture(), salePayload = sale(f), proof = freeze(f, salePayload), args = importArgs(f, salePayload)
    const result = await raced('import_before_freeze', c => rpcOn(c, 'pos_offline_import', ...args), c => rpcOn(c, 'pos_offline_payment_freeze', signedFreeze(f, proof)))
    check(result.first.status, 'accepted', 'race receipt commits first'); check(result.second.value?.status, 'already_issued', 'late freeze retrieves original custody'); check(result.second.value?.acknowledgement, args[2], 'race returns first original ACK')
  }
  {
    const f = await fixture(), proof = freeze(f)
    const result = await raced('freeze_exact_retry', c => rpcOn(c, 'pos_offline_payment_freeze', signedFreeze(f, proof)), c => rpcOn(c, 'pos_offline_payment_freeze', signedFreeze(f, proof, 'MAgCAQECAQI')))
    check(result.second.value?.replayed, true, 'simultaneous resigned retry is idempotent'); check(await count('pos_offline_payment_freezes', 'authority_id=$1', [f.bundle.authority.id]), 1, 'concurrent retries store one freeze')
  }
  {
    const a = await fixture(), b = await fixture(), first = freeze(a), second = freeze(b)
    second.paymentIntentId = first.paymentIntentId
    const result = await raced('cross_scope_intent', c => rpcOn(c, 'pos_offline_payment_freeze', signedFreeze(a, first)), c => rpcOn(c, 'pos_offline_payment_freeze', signedFreeze(b, second)))
    check(result.second.value?.status, 'conflict', 'same intent across organizations serializes globally')
  }
  for (const onlineFirst of [false, true]) {
    const f = await fixture(), proof = freeze(f), order = onlineRequest(f, proof.orderId)
    const registerOp = c => rpcOn(c, 'pos_offline_payment_freeze', signedFreeze(f, proof)), orderOp = c => rpcOn(c, 'pos_record_live_order', order, f.binding)
    const result = await raced(onlineFirst ? 'online_before_freeze' : 'freeze_before_online', onlineFirst ? orderOp : registerOp, onlineFirst ? registerOp : orderOp,
      { firstRole: onlineFirst ? 'authenticated' : 'service_role', secondRole: onlineFirst ? 'service_role' : 'authenticated', actor: f.owner })
    if (onlineFirst) check(result.second.value?.status, 'conflict', 'online order wins before freeze')
    else { assert.match(result.second.error ?? '', /POS_/); report.checks.push('frozen identity rejects concurrent online order'); check(await count('pos_orders', 'id=$1', [proof.orderId]), 0, 'frozen concurrent online order rolls back') }
  }
  {
    const f = await fixture(), proof = freeze(f)
    const result = await raced('freeze_before_close', c => rpcOn(c, 'pos_offline_payment_freeze', signedFreeze(f, proof)), async c => { await c.query("update public.pos_shifts set status='closed',closed_at=now() where id=$1", [f.shift]); return 'closed' }, { secondRole: null })
    assert.match(result.second.error ?? '', /POS_/); report.checks.push('freeze serializes against shift close'); check(await scalar('select status from public.pos_shifts where id=$1', [f.shift]), 'open', 'blocked close leaves drawer open')
  }
  {
    const f = await fixture(), proof = freeze(f); await service('pos_offline_seal', ...sealArgs(f))
    const result = await raced('freeze_before_renewal', c => rpcOn(c, 'pos_offline_payment_freeze', signedFreeze(f, proof)), c => rpcOn(c, 'pos_offline_reserve', f.owner, { ...f.request, requestId: uid() }))
    check(result.first.status, 'registered', 'sealed grant retains late freeze'); assert.match(result.second.error ?? '', /POS_/); report.checks.push('late freeze hold prevents concurrent renewal')
  }
  for (const cancellationFirst of [false, true]) {
    const f = await fixture(), proof = freeze(f), args = ['sale', proof.orderId, f.org, f.branch, f.device, f.owner, JSON.stringify(onlineRequest(f, proof.orderId))]
    const cancelOp = async c => { await c.query('insert into public.pos_request_cancellations(kind,request_id,organization_id,branch_id,device_id,actor_id,request_payload) values($1,$2,$3,$4,$5,$6,$7)', args); return 'cancelled' }
    const registerOp = c => rpcOn(c, 'pos_offline_payment_freeze', signedFreeze(f, proof))
    const result = await raced(cancellationFirst ? 'cancel_before_freeze' : 'freeze_before_cancel', cancellationFirst ? cancelOp : registerOp, cancellationFirst ? registerOp : cancelOp, { firstRole: cancellationFirst ? null : 'service_role', secondRole: cancellationFirst ? 'service_role' : null })
    if (cancellationFirst) check(result.second.value?.status, 'conflict', 'online cancellation wins before freeze')
    else { assert.match(result.second.error ?? '', /POS_/); report.checks.push('freeze prevents concurrent online cancellation') }
  }
  for (const documentFirst of [false, true]) {
    const f = await fixture(), proof = freeze(f), order = onlineRequest(f), document = sale(f).document
    document.id = proof.documentId; document.orderId = order.id; document.documentNumber = 'TEST-INV-9999999999'
    await db.query('insert into public.pos_orders(id,organization_id,branch_id,device_id,shift_id,created_by,client_created_at,service_type,total_fils,tax_fils,request_payload) values($1,$2,$3,$4,$5,$6,$7,$8,1000,48,$9)', [order.id, f.org, f.branch, f.device, f.shift, f.owner, order.createdAt, 'takeaway', JSON.stringify(order)])
    const documentOp = async c => { await c.query('insert into public.pos_documents(id,organization_id,branch_id,order_id,actor_id,kind,document_number,issued_at,request_payload,snapshot) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [document.id, f.org, f.branch, order.id, f.owner, 'tax_invoice', document.documentNumber, document.issuedAt, JSON.stringify(order), JSON.stringify(document)]); return 'document_inserted' }
    const registerOp = c => rpcOn(c, 'pos_offline_payment_freeze', signedFreeze(f, proof))
    const result = await raced(documentFirst ? 'document_before_freeze' : 'freeze_before_document', documentFirst ? documentOp : registerOp, documentFirst ? registerOp : documentOp, { firstRole: documentFirst ? null : 'service_role', secondRole: documentFirst ? 'service_role' : null })
    if (documentFirst) check(result.second.value?.status, 'conflict', 'document identity serializes across different orders before freeze')
    else { assert.match(result.second.error ?? '', /POS_/); report.checks.push('frozen document identity cannot be reused by different online order'); check(await count('pos_documents', 'id=$1', [proof.documentId]), 0, 'blocked document insertion rolls back completely') }
  }
}

async function scenarios() {
  // Create this grant first so the later historical-expiry check waits at most one minute.
  const retired = await fixture(), historical = freeze(retired)
  const f = await fixture(), issued = sale(f), proof = freeze(f, issued), original = signedFreeze(f, proof)
  const registered = await register(f, proof)
  check(registered.status, 'registered', 'valid frozen intent registers')
  check(registered.hasConflicts, false, 'clean registration has no contradiction')
  check(registered.freezeSha256, eh(original), 'registered canonical proof hash matches')
  const replay = await register(f, proof, 'MAgCAQECAQI')
  check(replay.replayed, true, 'resigned same payload returns original registration')
  check(replay.freezeId, registered.freezeId, 'resigning cannot replace freeze identity')
  const read = await service('pos_offline_payment_case', f.bundle.authority.id, proof.freezeId)
  check(read.proofEnvelope, original, 'case returns first signature bytes')
  check(await service('pos_offline_payment_case', uid(), proof.freezeId), null, 'case read requires exact authority scope')
  const rejected = await service('pos_offline_import', ...importArgs(f, issued))
  check(rejected.status, 'reconciliation_required', 'freeze before receipt blocks import')
  check(await count('pos_orders', 'id=$1', [issued.id]), 0, 'frozen import writes no order')
  check(await count('pos_documents', 'id=$1', [issued.document.id]), 0, 'frozen import writes no document')
  check(await count('pos_payments', 'order_id=$1', [issued.id]), 0, 'frozen import writes no payment')
  check(await count('pos_offline_receipts', 'issuance_id=$1', [issued.id]), 0, 'frozen import does not ACK custody')
  await rejects(service('pos_offline_seal', ...sealArgs(f)), /POS_/, 'unresolved freeze blocks seal')
  await rejects(service('pos_offline_reserve', f.owner, { ...f.request, requestId: uid() }), /POS_/, 'unresolved freeze blocks another allocation')
  await rejects(db.query("update public.pos_shifts set status='closed',closed_at=now() where id=$1", [f.shift]), /POS_/, 'unresolved freeze blocks shift close')
  await rejects(online(f, onlineRequest(f, proof.orderId)), /POS_/, 'online order cannot reuse frozen original order identity')
  const altered = clone(proof); altered.request.cashTenderedFils = 2000; altered.requestSha256 = hash(canonical(altered.request))
  check((await register(f, altered)).status, 'conflict', 'same freeze identity changed request is durable conflict')
  const changedId = { ...proof, freezeId: uid() }
  check((await register(f, changedId)).status, 'conflict', 'new freeze ID cannot claim same payment intent')
  for (const table of ['pos_offline_intent_claims', 'pos_offline_payment_freezes', 'pos_offline_payment_conflicts']) {
    await rejects(db.exec(`delete from public.${table}`), /POS_IMMUTABLE/, `${table} cannot be deleted`)
    const field = table === 'pos_offline_intent_claims' ? 'payment_intent_id' : 'id'
    await rejects(db.exec(`update public.${table} set ${field}=${field}`), /POS_IMMUTABLE/, `${table} cannot be rewritten`)
  }
  for (const mutation of ['scope', 'request_hash', 'bundle_hash', 'gross', 'tender', 'unknown']) {
    const g = await fixture(), bad = freeze(g)
    if (mutation === 'scope') bad.branchId = uid()
    if (mutation === 'request_hash') bad.requestSha256 = 'f'.repeat(64)
    if (mutation === 'bundle_hash') bad.authoritySha256 = 'f'.repeat(64)
    if (mutation === 'gross') { bad.request.presentedTotalFils = 999; bad.requestSha256 = hash(canonical(bad.request)) }
    if (mutation === 'tender') { bad.request.recordedCardFils = 1001; bad.requestSha256 = hash(canonical(bad.request)) }
    if (mutation === 'unknown') bad.extra = true
    const result = await register(g, bad)
    check(result.status, 'conflict', `${mutation} cannot register trusted frozen claim`)
    check(await count('pos_offline_payment_freezes', 'authority_id=$1', [g.bundle.authority.id]), 0, `${mutation} leaves no accepted freeze`)
    check(await count('pos_orders', 'branch_id=$1', [g.branch]), 0, `${mutation} creates no financial data`)
  }
  const foreign = await fixture(), crossed = freeze(foreign)
  crossed.paymentIntentId = proof.paymentIntentId
  check((await register(foreign, crossed)).status, 'conflict', 'payment intent identity is global across organizations')
  const existingOnline = await fixture(), onlineId = uid(), onlineResult = await online(existingOnline, onlineRequest(existingOnline, onlineId))
  check(onlineResult.status, 'synced', 'baseline online sale succeeds before conflicting freeze')
  const orderCollision = freeze(existingOnline); orderCollision.orderId = onlineId
  check((await register(existingOnline, orderCollision)).status, 'conflict', 'online order before freeze is retained collision')
  const docCollision = freeze(existingOnline); docCollision.documentId = onlineResult.receipt.id
  check((await register(existingOnline, docCollision)).status, 'conflict', 'ordinary document identity collision is detected')
  const cancelled = await fixture(), cancelledProof = freeze(cancelled)
  await db.query('insert into public.pos_request_cancellations(kind,request_id,organization_id,branch_id,device_id,actor_id,request_payload) values($1,$2,$3,$4,$5,$6,$7)', ['sale', cancelledProof.orderId, cancelled.org, cancelled.branch, cancelled.device, cancelled.owner, JSON.stringify(onlineRequest(cancelled, cancelledProof.orderId))])
  check((await register(cancelled, cancelledProof)).status, 'conflict', 'online cancellation before freeze is retained collision')
  const noncanonical = await fixture(), ncProof = freeze(noncanonical), ncEnvelope = signedFreeze(noncanonical, ncProof)
  ncEnvelope.payloadBase64Url = Buffer.from(JSON.stringify(ncProof)).toString('base64url')
  check((await service('pos_offline_payment_freeze', ncEnvelope)).status, 'conflict', 'SQL rejects noncanonical signed-payload bytes')
  check(await count('pos_offline_payment_freezes', 'authority_id=$1', [noncanonical.bundle.authority.id]), 0, 'noncanonical proof cannot acquire frozen claim')
  const wrongSigner = await fixture(), wrongProof = freeze(wrongSigner), wrongEnvelope = envelope(wrongProof, 'f'.repeat(64))
  await rejects(service('pos_offline_payment_freeze', wrongEnvelope), /POS_OFFLINE_INVALID_PROOF/, 'named foreign signer cannot quarantine authority')
  check(await count('pos_offline_payment_conflicts', 'authority_id=$1', [wrongSigner.bundle.authority.id]), 0, 'wrong signer leaves no quarantine evidence')
  historical.intentCreatedAt = new Date(Date.parse(retired.bundle.authority.expiresAt) + 1000).toISOString()
  await db.query('update public.pos_staff set active=false where organization_id=$1', [retired.org]); await db.query('update public.pos_devices set active=false where id=$1', [retired.device]); await db.query('update public.pos_offline_branch_policy set enabled=false where branch_id=$1', [retired.branch])
  const waitForExpiry = Date.parse(retired.bundle.authority.expiresAt) - Date.now() + 10
  if (waitForExpiry > 0) { console.log('Waiting for synthetic 60-second grant expiry; no production state involved.'); await new Promise(resolve => setTimeout(resolve, waitForExpiry)) }
  check(await scalar('select clock_timestamp()>$1::timestamptz', [retired.bundle.authority.expiresAt]), true, 'historical fixture is actually expired on PostgreSQL clock')
  check((await register(retired, historical)).status, 'registered', 'expired historical registration ignores revoked staff/device/policy')
  const closed = await fixture(); await service('pos_offline_seal', ...sealArgs(closed)); await db.query("update public.pos_shifts set status='closed',closed_at=now() where id=$1", [closed.shift])
  const closedResult = await register(closed, freeze(closed))
  check(closedResult.status, 'registered', 'closed shift historical evidence is retained')
  check(closedResult.hasConflicts, true, 'closed state retains contradiction hold')
  check(await scalar('select status from public.pos_shifts where id=$1', [closed.shift]), 'closed', 'historical evidence does not reopen cash drawer')
}

try {
  await initialize(); await migrated(); await acl(); await scenarios(); await concurrency()
  report.status = 'passed'
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
