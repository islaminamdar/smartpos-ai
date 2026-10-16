// Synthetic disposable SQL028 native clock recovery custody tests. No real merchants, provider calls or signature claims.
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
let db, control, Client, database, config, clockMigrationSql, ownedDatabase = false
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
    database = 'pos_qa_clock_recovery_' + uid().replaceAll('-', '')
    await control.query(`create database ${database}`); ownedDatabase = true
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
  const files = (await readdir(directory)).filter(f => /^2026101600(?:0[1-9]|1[0-9]|2[0-8])00_/.test(f)).sort()
  for (const file of files) {
    const sql = await readFile(new URL(file, directory), 'utf8'); report.migrationHashes[file] = hash(sql)
    if (file === '20261016002800_pos_native_clock_recovery.sql') clockMigrationSql = sql
    else await db.exec(sql)
  }
  assert.ok(clockMigrationSql, 'the exact SQL028 migration must exist')
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

async function custody() {
  const result = {}
  const tables = (await db.query("select tablename from pg_tables where schemaname='public' and tablename not in ('pos_native_clock_recoveries','pos_native_clock_recovery_signatures') order by tablename")).rows
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_]+$/)
    const rows = await scalar(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from public.${tablename} x`)
    result[tablename] = hash(canonical(rows))
  }
  return result
}

function proof(f, changes = {}) {
  return { kind: 'native-clock-recovery', schemaVersion: 1, requestId: uid(), installationId: uid(),
    organizationId: f.org, branchId: f.branch, deviceId: f.device, actorId: f.owner,
    keyEpoch: f.enrollment.keyEpoch, deviceKeySha256: f.bundle.authority.deviceKeySha256,
    oldClockGeneration: 0, oldClockSha256: hash(uid()), retirementSha256: hash(uid()), ...changes }
}
const signed = (p, signature) => envelope(p, p.deviceKeySha256, signature)
const approve = (f, p, confirmed = new Date().toISOString(), binding = f.binding, actor = f.owner) =>
  service('pos_native_clock_recovery_approve', actor, binding, signed(p), confirmed)
const lookup = p => service('pos_native_clock_recovery_lookup', signed(p))

async function seedFinancialCustody(f) {
  const issued = sale(f), args = importArgs(f, issued)
  await service('pos_offline_import', ...args)
  const held = freeze(f, sale(f), { chainHead: { sequence: 1, eventSha256: eh(args[1]) } })
  await register(f, held)
  const pin = { kind: 'native-pin-recovery', schemaVersion: 1, requestId: uid(),
    organizationId: f.org, branchId: f.branch, deviceId: f.device, actorId: f.owner,
    keyEpoch: f.enrollment.keyEpoch, deviceKeySha256: f.bundle.authority.deviceKeySha256,
    oldCredentialSha256: hash(uid()), newCredentialSha256: hash(uid()), signedAt: new Date().toISOString() }
  const approved = await service('pos_native_pin_recovery_approve', f.owner, f.binding,
    envelope(pin, pin.deviceKeySha256), new Date().toISOString())
  await service('pos_native_pin_recovery_attach', pin.requestId, envelope(approved.approval))
  const populated = {}
  for (const table of ['pos_orders', 'pos_documents', 'pos_payments', 'pos_offline_receipts',
    'pos_offline_authorities', 'pos_offline_payment_freezes', 'pos_native_pin_recoveries', 'pos_native_pin_recovery_signatures']) {
    populated[table] = await scalar(`select count(*)::int from public.${table}`)
    check(populated[table] > 0, true, 'custody fixture has actual nonempty ' + table)
  }
  report.populatedCustodyFixture = populated
}

async function scenarios() {
  let f = await fixture(true), p = proof(f)
  await seedFinancialCustody(f)
  const beforeUpgrade = await custody()
  await db.exec('begin;\n' + clockMigrationSql + '\ncommit;')
  check(await custody(), beforeUpgrade, 'SQL001-027 populated custody survives transactional SQL028 upgrade unchanged')
  check(await scalar('select (select count(*) from public.pos_native_clock_recoveries)+(select count(*) from public.pos_native_clock_recovery_signatures)'),
    postgres ? '0' : 0, 'SQL028 creates no seeded approval or signature')
  const context = await service('pos_native_clock_recovery_context', f.enrollment.keyEpoch)
  check(context, { organizationId: f.org, branchId: f.branch, deviceId: f.device,
    keyEpoch: f.enrollment.keyEpoch, deviceKeySha256: p.deviceKeySha256,
    publicKeySpki: f.enrollment.publicKeySpki }, 'minimal historical verification context')
  check(await service('pos_native_clock_recovery_context', uid()), null, 'unknown context is null')
  check(await lookup(p), null, 'absent exact request lookup does not authorize repair')
  const before = await custody()
  let result = await approve(f, p)
  const { kind: _kind, ...identity } = p
  check(result, { approval: { ...identity, kind: 'native-clock-recovery-approval',
    proofSha256: eh(signed(p)), approvedAt: result.approval.approvedAt }, approvalEnvelope: null }, 'exact immutable approval contract')
  check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result.approval.approvedAt), true, 'server approval is UTC milliseconds')
  check('signedAt' in result.approval || 'serverTimeMs' in result.approval || 'challenge' in result.approval,
    false, 'approval contains no broken clock timestamp or transient time handoff')
  check(await custody(), before, 'every preexisting public table unchanged by approval')
  check(await lookup(p), result, 'exact accepted lookup returns original approval')
  check(await approve(f, p, '2000-01-01T00:00:00Z', 'bad-binding'), result, 'exact accepted replay creates no fresh authorization')
  check(await service('pos_native_clock_recovery_approve', f.owner, f.binding,
    signed(p, 'MAgCAQMCAQE'), new Date().toISOString()), result, 'same payload different DER replays first approval')
  check(await scalar('select proof_envelope from public.pos_native_clock_recoveries where request_id=$1', [p.requestId]), signed(p), 'first proof envelope retained')
  for (const change of [{ oldClockSha256: hash(uid()) }, { retirementSha256: hash(uid()) },
    { installationId: uid() }, { oldClockGeneration: 1 }, { actorId: uid() }]) {
    await rejects(() => lookup({ ...p, ...change }), /POS_CLOCK_RECOVERY_CONFLICT/, 'same request rejects changed ' + Object.keys(change)[0])
    await rejects(() => approve(f, { ...p, ...change }), /POS_CLOCK_RECOVERY_CONFLICT|POS_ACCESS_DENIED/, 'approve same request rejects changed ' + Object.keys(change)[0])
  }
  for (const change of [{}, { oldClockSha256: hash(uid()) }, { retirementSha256: hash(uid()) }])
    await rejects(() => approve(f, { ...p, requestId: uid(), ...change }), /POS_CLOCK_RECOVERY_CONFLICT/, 'same installation/epoch/generation cannot use another request ' + Object.keys(change).join(','))
  await rejects(() => approve(f, p, undefined, undefined, uid()), /POS_ACCESS_DENIED/, 'wrong supplied actor rejected even on replay')
  await rejects(() => approve(f, p, undefined, undefined, null), /POS_ACCESS_DENIED/, 'null supplied actor rejected even on replay')
  const server = envelope(result.approval)
  check(await service('pos_native_clock_recovery_attach', p.requestId, server), { ...result, approvalEnvelope: server }, 'first exact server approval attached')
  check((await service('pos_native_clock_recovery_attach', p.requestId,
    envelope(result.approval, 'rotated-server', 'MAgCAQMCAQE'))).approvalEnvelope, server, 'first envelope immutable across legitimate signing key rotation')
  for (const change of [{ retirementSha256: hash(uid()) }, { proofSha256: hash(uid()) },
    { approvedAt: '2000-01-01T00:00:00.000Z' }, { oldClockGeneration: 2 }])
    await rejects(() => service('pos_native_clock_recovery_attach', p.requestId, envelope({ ...result.approval, ...change })),
      /POS_CLOCK_RECOVERY_APPROVAL_CHANGED/, 'signature attachment rejects changed ' + Object.keys(change)[0])
  await rejects(() => service('pos_native_clock_recovery_attach', p.requestId,
    { ...server, payloadBase64Url: Buffer.from(canonical(result.approval) + ' ').toString('base64url') }),
    /POS_CLOCK_RECOVERY_APPROVAL_CHANGED/, 'noncanonical attachment rejected')
  await rejects(() => service('pos_native_clock_recovery_attach', uid(), server), /POS_CLOCK_RECOVERY_UNKNOWN/, 'unknown approval attachment denied')
  check(await custody(), before, 'lookup/replay/attachment leave every preexisting public table unchanged')

  await db.query('update public.pos_staff set active=false where user_id=$1', [f.owner])
  await db.query('update public.pos_devices set active=false where id=$1', [f.device])
  await db.query('update public.pos_device_bindings set revoked_at=now() where token_hash=$1', [f.binding])
  check((await lookup(p)).approvalEnvelope, server, 'historical exact approval remains retrievable after staff/device/binding revocation')
  check((await service('pos_native_clock_recovery_context', p.keyEpoch)).publicKeySpki, context.publicKeySpki, 'historical enrolled key remains available')
  await rejects(() => approve(f, proof(f)), /POS_ACCESS_DENIED/, 'revoked staff cannot authorize another repair')

  f = await fixture(true)
  for (const [stamp, label] of [[null, 'missing'], ['2000-01-01T00:00:00Z', 'stale'],
    [new Date(Date.now() + 60000).toISOString(), 'future'], ['infinity', 'infinite']])
    await rejects(() => approve(f, proof(f), stamp), /POS_CLOCK_RECOVERY_CONFIRMATION_REQUIRED/, label + ' password confirmation denied')
  await rejects(() => approve(f, proof(f), undefined, hash(uid())), /POS_DEVICE_INVALID/, 'foreign binding denied')
  await rejects(() => approve(f, proof(f), undefined, null), /POS_DEVICE_INVALID/, 'missing binding denied')
  await db.query('update public.pos_device_bindings set revoked_at=now() where token_hash=$1', [f.binding])
  await rejects(() => approve(f, proof(f)), /POS_DEVICE_INVALID/, 'revoked binding denied')
  f = await fixture(true)
  await db.query('update public.pos_devices set active=false where id=$1', [f.device])
  await rejects(() => approve(f, proof(f)), /POS_DEVICE_INVALID/, 'inactive device denied')
  f = await fixture(true)
  await db.query('update public.pos_branches set active=false where id=$1', [f.branch])
  await rejects(() => approve(f, proof(f)), /POS_ACCESS_DENIED/, 'inactive branch denied')
  f = await fixture(true)
  await db.query('update public.pos_offline_key_epochs set blocked=true where id=$1', [f.enrollment.keyEpoch])
  const blockedBefore = await custody()
  check((await approve(f, proof(f))).approval.kind, 'native-clock-recovery-approval', 'financially blocked epoch permits bounded access repair approval')
  check(await custody(), blockedBefore, 'approval preserves financial hold, authority, PIN approvals and all other tables')

  // A cashier credential may use a key originally enrolled by a manager.
  const cashier = uid(), binding = hash(uid())
  await db.query("insert into auth.users values($1,'synthetic-clock-cashier@example.test',now())", [cashier])
  await db.query("insert into public.pos_staff(organization_id,user_id,branch_id,role) values($1,$2,$3,'cashier')", [f.org, cashier, f.branch])
  await db.query('insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)', [binding, cashier, f.org, f.branch, f.device])
  p = proof(f, { actorId: cashier })
  check((await approve({ ...f, owner: cashier, binding }, p)).approval.actorId, cashier, 'original cashier does not have to be enrolled_by manager')
  await rejects(() => approve(f, { ...p, actorId: f.owner, requestId: uid() }), /POS_CLOCK_RECOVERY_CONFLICT/,
    'generation consumption cannot be bypassed by another current actor')
  check((await approve({ ...f, owner: cashier, binding }, { ...p, requestId: uid(), oldClockGeneration: 1 })).approval.oldClockGeneration,
    1, 'later distinct native generation can obtain its own approval')
  check((await approve(f, proof(f, { oldClockGeneration: Number.MAX_SAFE_INTEGER }))).approval.oldClockGeneration,
    Number.MAX_SAFE_INTEGER, 'largest safe integer accepted without numeric coercion')

  for (const changes of [{ extra: true }, { schemaVersion: 2 }, { organizationId: uid() }, { branchId: uid() },
    { deviceId: uid() }, { keyEpoch: uid() }, { deviceKeySha256: hash(uid()) }, { installationId: 'invalid' },
    { oldClockSha256: 'wrong' }, { retirementSha256: null }, { oldClockGeneration: -1 }, { oldClockGeneration: 0.5 },
    { oldClockGeneration: '0' }, { oldClockGeneration: null }, { oldClockGeneration: true },
    { oldClockGeneration: Number.MAX_SAFE_INTEGER + 1 }, { signedAt: new Date().toISOString() }])
    await rejects(() => lookup(proof(f, changes)), /POS_CLOCK_RECOVERY_|invalid_request|POS_OFFLINE_INVALID_UUID|canonical/,
      'strict proof rejects ' + Object.keys(changes)[0] + ':' + JSON.stringify(Object.values(changes)[0]))
  p = proof(f)
  for (const field of Object.keys(p)) {
    const missing = { ...p }; delete missing[field]
    await rejects(() => lookup(missing), /POS_CLOCK_RECOVERY_|POS_OFFLINE_INVALID_ENVELOPE/, 'proof requires field ' + field)
  }
  const original = signed(p)
  await rejects(() => service('pos_native_clock_recovery_lookup', { ...original,
    payloadBase64Url: Buffer.from(canonical(p) + ' ').toString('base64url') }), /POS_CLOCK_RECOVERY_INVALID_PROOF/, 'trailing signed whitespace rejected')
  await rejects(() => service('pos_native_clock_recovery_lookup', { ...original,
    payloadBase64Url: Buffer.from(canonical(p).replace('{', '{"kind":"native-clock-recovery",')).toString('base64url') }),
    /POS_CLOCK_RECOVERY_INVALID_PROOF/, 'duplicate signed JSON key rejected')
  await rejects(() => service('pos_native_clock_recovery_lookup', { ...original, extra: 'x'.repeat(9000) }),
    /POS_CLOCK_RECOVERY_INVALID_PROOF/, 'oversized envelope rejected before parsing')
  await rejects(() => service('pos_native_clock_recovery_lookup', { ...original, keyId: 'wrong-key' }),
    /POS_CLOCK_RECOVERY_INVALID_PROOF/, 'envelope key ID must match enrolled device fingerprint')
  for (const table of ['pos_native_clock_recoveries', 'pos_native_clock_recovery_signatures']) {
    await rejects(() => db.query(`update public.${table} set request_id=request_id`), /POS_IMMUTABLE_DOCUMENT/, table + ' rejects update')
    await rejects(() => db.query(`delete from public.${table}`), /POS_IMMUTABLE_DOCUMENT/, table + ' rejects delete')
  }
}

async function concurrency() {
  if (!postgres) return
  let f = await fixture(true), p = proof(f), when = new Date().toISOString()
  let r = await raced('clock_same_request', x => rpcOn(x, 'pos_native_clock_recovery_approve', f.owner, f.binding, signed(p), when),
    x => rpcOn(x, 'pos_native_clock_recovery_approve', f.owner, f.binding, signed(p, 'MAgCAQMCAQE'), when))
  check(r.second.value, r.first, 'concurrent same request preserves original approval')
  f = await fixture(true); p = proof(f); when = new Date().toISOString()
  r = await raced('clock_competing_generation', x => rpcOn(x, 'pos_native_clock_recovery_approve', f.owner, f.binding, signed(p), when),
    x => rpcOn(x, 'pos_native_clock_recovery_approve', f.owner, f.binding, signed({ ...p, requestId: uid(), retirementSha256: hash(uid()) }), when))
  check(/POS_CLOCK_RECOVERY_CONFLICT/.test(r.second.error ?? ''), true, 'one generation rejects competing request/manifest after wait')
  f = await fixture(true); p = proof(f); when = new Date().toISOString()
  r = await raced('clock_approval_lookup', x => rpcOn(x, 'pos_native_clock_recovery_approve', f.owner, f.binding, signed(p), when),
    x => rpcOn(x, 'pos_native_clock_recovery_lookup', signed(p)))
  check(r.second.value, r.first, 'lookup waits approval commit instead of reporting false absence')
  const first = envelope(r.first.approval)
  r = await raced('clock_first_signature', x => rpcOn(x, 'pos_native_clock_recovery_attach', p.requestId, first),
    x => rpcOn(x, 'pos_native_clock_recovery_attach', p.requestId, envelope(r.first.approval, 'rotated', 'MAgCAQMCAQE')))
  check(r.second.value.approvalEnvelope, first, 'concurrent signature attachment preserves first envelope')
  f = await fixture(true); p = proof(f); when = new Date().toISOString()
  r = await raced('clock_binding_revoke', async x => {
    await x.query('update public.pos_device_bindings set revoked_at=now() where token_hash=$1', [f.binding]); return 'revoked'
  }, x => rpcOn(x, 'pos_native_clock_recovery_approve', f.owner, f.binding, signed(p), when), { firstRole: null })
  check(/POS_DEVICE_INVALID/.test(r.second.error ?? ''), true, 'waiting approval rejects committed binding revocation')
  f = await fixture(true); p = proof(f); when = new Date().toISOString()
  r = await raced('clock_device_revoke', async x => {
    await x.query('update public.pos_devices set active=false where id=$1', [f.device]); return 'disabled'
  }, x => rpcOn(x, 'pos_native_clock_recovery_approve', f.owner, f.binding, signed(p), when), { firstRole: null })
  check(/POS_DEVICE_INVALID/.test(r.second.error ?? ''), true, 'waiting approval rejects committed device revocation')
  f = await fixture(true); p = proof(f); when = new Date().toISOString()
  r = await raced('clock_branch_deactivate', async x => {
    await x.query('update public.pos_branches set active=false where id=$1', [f.branch]); return 'disabled'
  }, x => rpcOn(x, 'pos_native_clock_recovery_approve', f.owner, f.binding, signed(p), when), { firstRole: null })
  check(/POS_ACCESS_DENIED/.test(r.second.error ?? ''), true, 'waiting approval rejects committed branch deactivation')

  // Exercise the real staff writer, not an artificial advisory lock imitation.
  f = await fixture(true); p = proof(f); when = new Date().toISOString()
  const authority = f.bundle.authority
  await service('pos_offline_seal', authority.id, 0, null, envelope({ kind: 'offline-seal', schemaVersion: 1,
    id: uid(), authorityId: authority.id, keyEpoch: authority.keyEpoch, deviceId: f.device,
    finalSequence: 0, finalEventSha256: null }, authority.deviceKeySha256))
  await db.query("select set_config('app.user_id',$1,false)", [f.owner]); await db.exec('set role authenticated')
  await rpcOn(db, 'pos_execute_live_command', { id: uid(), type: 'shift.close', branchId: f.branch,
    deviceId: f.device, shiftId: f.shift, countedCashFils: 0 }, f.binding)
  await db.exec('reset role')
  const admin = uid(), token = hash(uid())
  await db.query("insert into auth.users values($1,'synthetic-clock-admin@example.test',now())", [admin])
  await db.query("insert into public.pos_staff(organization_id,user_id,role) values($1,$2,'owner')", [f.org, admin])
  await db.query("update public.pos_staff set role='manager' where user_id=$1", [f.owner])
  await db.query('insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)', [token, admin, f.org, f.branch, f.device])
  const revoke = { id: uid(), branchId: f.branch, deviceId: f.device, targetUserId: f.owner,
    expectedRevision: 1, role: 'manager', assignedBranchId: null, active: false,
    displayName: 'Synthetic manager', reason: 'Synthetic clock recovery revocation test' }
  r = await raced('clock_staff_revoke', async x => {
    await x.query("select set_config('app.user_id',$1,true)", [admin]); return rpcOn(x, 'pos_manage_staff', revoke, token)
  }, x => rpcOn(x, 'pos_native_clock_recovery_approve', f.owner, f.binding, signed(p), when), { firstRole: 'authenticated' })
  check(r.first.status, 'updated', 'real staff writer commits revocation')
  check(/POS_ACCESS_DENIED/.test(r.second.error ?? ''), true, 'waiting approval sees staff revocation after shared authority gate')

  // Confirmation is fresh when submitted but expires while waiting for a device lock.
  // Near-boundary timestamp + a short real delay avoids changing server time or SQL.
  f = await fixture(true); p = proof(f); when = new Date(Date.now() - 119500).toISOString()
  r = await raced('clock_confirmation_expires_while_waiting', async x => {
    await x.query('select id from public.pos_devices where id=$1 for update', [f.device])
    return 'device locked'
  }, x => rpcOn(x, 'pos_native_clock_recovery_approve', f.owner, f.binding, signed(p), when),
  { firstRole: null, releaseDelayMs: 650 })
  check(/POS_CLOCK_RECOVERY_CONFIRMATION_REQUIRED/.test(r.second.error ?? ''), true, 'password confirmation evaluated after lock wait')
  check(await lookup(p), null, 'expired confirmation commits no repair approval')
}

async function acl() {
  const functions = ['pos_native_clock_recovery_context(uuid)', 'pos_native_clock_recovery_lookup(jsonb)',
    'pos_native_clock_recovery_approve(uuid,text,jsonb,timestamp with time zone)', 'pos_native_clock_recovery_attach(uuid,jsonb)']
  for (const signature of functions) {
    for (const role of ['anon', 'authenticated'])
      check(await scalar("select has_function_privilege($1,$2,'EXECUTE')", [role, 'public.' + signature]), false, role + ' denied ' + signature)
    check(await scalar("select has_function_privilege('service_role',$1,'EXECUTE')", ['public.' + signature]), true, 'service allowed ' + signature)
    check(await scalar('select proconfig from pg_proc where oid=$1::regprocedure', ['public.' + signature]), ['search_path=""'], 'empty search path ' + signature)
  }
  check(await scalar("select has_function_privilege('service_role','public.pos_native_clock_recovery_proof(jsonb)','EXECUTE')"), false, 'parser private even from service role')
  for (const role of ['anon', 'authenticated', 'service_role'])
    for (const table of ['pos_native_clock_recoveries', 'pos_native_clock_recovery_signatures'])
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
        check(await scalar('select has_table_privilege($1,$2,$3)', [role, 'public.' + table, privilege]), false, role + ' no ' + privilege + ' on ' + table)
  for (const table of ['pos_native_clock_recoveries', 'pos_native_clock_recovery_signatures'])
    check(await scalar('select relrowsecurity from pg_class where oid=$1::regclass', ['public.' + table]), true, table + ' has RLS')
  await db.exec('set role authenticated')
  await rejects(() => rpcOn(db, 'pos_native_clock_recovery_context', uid()), /permission denied/, 'actual browser role cannot call context')
  await db.exec('reset role')
}

try {
  await initialize(); await scenarios(); await concurrency(); await acl(); report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.failure = { message: error.message, where: error.where, stack: error.stack }
  process.exitCode = 1; console.error(error.message, error.where ?? '')
} finally {
  for (const session of sessions) await session.end().catch(() => {})
  if (db) await (postgres ? db.end() : db.close()).catch(() => {})
  if (control && ownedDatabase) {
    try {
      await control.query(`drop database ${database}`)
      assert.equal(await scalar('select count(*)::int from pg_database where datname=$1', [database], control), 0)
      report.cleanup = 'verified-dropped'
    } catch (error) { report.cleanup = 'failed: ' + error.message; process.exitCode = 1 }
  } else report.cleanup = db && !postgres ? 'embedded-database-closed' : 'not-created'
  if (control) await control.end()
  report.finishedAt = new Date().toISOString(); await save()
  console.log(JSON.stringify({ status: report.status, backend: report.backend, checks: report.checks.length,
    races: report.races.length, cleanup: report.cleanup, productionTouched: false }))
}
