// Synthetic disposable SQL025 native PIN recovery custody tests. No real merchants, provider calls or signature claims.
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
    database = 'pos_qa_pin_recovery_' + uid().replaceAll('-', '')
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
  const files = (await readdir(directory)).filter(f => /^20261016/.test(f) && !f.includes('007') && !f.includes('009') && f < '202610160026').sort()
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

async function ledger(f){const result={};for(const table of ['pos_shifts','pos_command_receipts','pos_request_cancellations','pos_orders','pos_documents','pos_payments','pos_refunds','pos_cash_movements','pos_audit_events'])result[table]=await scalar(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from public.${table} x where organization_id=$1`,[f.org]);return result}


function proof(f,changes={}){return{kind:'native-pin-recovery',schemaVersion:1,requestId:uid(),organizationId:f.org,branchId:f.branch,deviceId:f.device,actorId:f.owner,keyEpoch:f.enrollment.keyEpoch,deviceKeySha256:f.bundle.authority.deviceKeySha256,oldCredentialSha256:hash(uid()),newCredentialSha256:hash(uid()),signedAt:new Date().toISOString(),...changes}}
const signed=(p,signature)=>envelope(p,p.deviceKeySha256,signature)
const approve=(f,p,confirmed=new Date().toISOString(),binding=f.binding,actor=f.owner)=>service('pos_native_pin_recovery_approve',actor,binding,signed(p),confirmed)
const lookup=p=>service('pos_native_pin_recovery_lookup',signed(p))
const refresh=p=>({...p,signedAt:new Date(Date.now()+1000).toISOString()})
async function scenarios(){
 let f=await fixture(true),p=proof(f);const context=await service('pos_native_pin_recovery_context',f.enrollment.keyEpoch);
 check(context,{organizationId:f.org,branchId:f.branch,deviceId:f.device,keyEpoch:f.enrollment.keyEpoch,deviceKeySha256:p.deviceKeySha256,publicKeySpki:f.enrollment.publicKeySpki},'minimal historical enrolled-key context');check(await service('pos_native_pin_recovery_context',uid()),null,'unknown context null');check(await lookup(p),null,'unaccepted request lookup is read only null');
 const before=await ledger(f),epochBefore=await scalar('select to_jsonb(e) from public.pos_offline_key_epochs e where id=$1',[p.keyEpoch]),authorityBefore=await scalar('select to_jsonb(a) from public.pos_offline_authorities a where id=$1',[f.bundle.authority.id]);
 let result=await approve(f,p);check(result.approvalEnvelope,null,'acceptance commits before signature');check(result.approval.kind,'native-pin-recovery-approval','dedicated approval purpose');check(result.approval.proofSha256,eh(signed(p)),'original exact proof hash bound');check(result.approval.oldCredentialSha256,p.oldCredentialSha256,'old generation commitment');check(result.approval.newCredentialSha256,p.newCredentialSha256,'new generation commitment');check(Object.keys(result).sort(),['approval','approvalEnvelope'],'exact response keys');check('signedAt' in result.approval,false,'approval does not substitute refresh time');
 check(await ledger(f),before,'approval creates no financial records or audit');check(await scalar('select to_jsonb(e) from public.pos_offline_key_epochs e where id=$1',[p.keyEpoch]),epochBefore,'epoch head and blocked state unchanged');check(await scalar('select to_jsonb(a) from public.pos_offline_authorities a where id=$1',[f.bundle.authority.id]),authorityBefore,'authority custody and clock limits unchanged');
 check(await lookup(refresh(p)),result,'refreshed signed proof looks up first accepted hash');check(await approve(f,refresh(p),'2000-01-01T00:00:00Z','bad-binding'),result,'committed exact retry bypasses fresh auth grant checks');
 const secondDer=signed(p,'MAgCAQMCAQE');check(await service('pos_native_pin_recovery_approve',f.owner,f.binding,secondDer,new Date().toISOString()),result,'same payload resigned exact replay');check(await scalar('select proof_envelope from public.pos_native_pin_recoveries where request_id=$1',[p.requestId]),signed(p),'first device envelope retained');
 await rejects(()=>lookup({...p,newCredentialSha256:hash(uid())}),/POS_PIN_RECOVERY_CONFLICT/,'changed new verifier same ID conflicts');await rejects(()=>lookup({...p,actorId:uid()}),/POS_PIN_RECOVERY_CONFLICT/,'changed actor same ID conflicts');await rejects(()=>approve(f,{...p,requestId:uid()}),/POS_PIN_RECOVERY_CONFLICT/,'new ID cannot reuse old credential generation');await rejects(()=>approve(f,p,undefined,undefined,uid()),/POS_ACCESS_DENIED/,'supplied actor must equal original proof even replay');
 const server=envelope(result.approval);check(await service('pos_native_pin_recovery_attach',p.requestId,server),{...result,approvalEnvelope:server},'exact approval signature attached');check((await service('pos_native_pin_recovery_attach',p.requestId,envelope(result.approval,'rotated-server','MAgCAQMCAQE'))).approvalEnvelope,server,'first server signature preserved across legitimate rotation');
 await rejects(()=>service('pos_native_pin_recovery_attach',p.requestId,envelope({...result.approval,newCredentialSha256:hash(uid())})),/POS_PIN_RECOVERY_APPROVAL_CHANGED/,'changed signed approval payload rejected');const spaced={...server,payloadBase64Url:Buffer.from(canonical(result.approval)+' ').toString('base64url')};await rejects(()=>service('pos_native_pin_recovery_attach',p.requestId,spaced),/POS_PIN_RECOVERY_APPROVAL_CHANGED/,'noncanonical signature attachment rejected');await rejects(()=>service('pos_native_pin_recovery_attach',uid(),server),/POS_PIN_RECOVERY_UNKNOWN/,'unknown attachment rejected');
 await db.query('update public.pos_staff set active=false where user_id=$1',[f.owner]);await db.query('update public.pos_devices set active=false where id=$1',[f.device]);await db.query('update public.pos_device_bindings set revoked_at=now() where token_hash=$1',[f.binding]);check((await lookup({...p,signedAt:'2000-01-01T00:00:00.000Z'})).approvalEnvelope,server,'historical exact lookup after all revocations and stale proof');check((await service('pos_native_pin_recovery_context',p.keyEpoch)).publicKeySpki,context.publicKeySpki,'historical verification key remains available');await rejects(()=>approve(f,proof(f)),/POS_ACCESS_DENIED/,'revoked actor cannot create another grant');
 f=await fixture(true);p=proof(f,{signedAt:'2000-01-01T00:00:00.000Z'});await rejects(()=>approve(f,p),/POS_PIN_RECOVERY_PROOF_EXPIRED/,'absent expired proof rejected under locks');check(await lookup(p),null,'expired rejection did not accept or cancel');result=await approve(f,refresh(p));check(result.approval.requestId,p.requestId,'same ID refreshed after proven absence');
 for(const [stamp,label] of [[new Date(Date.now()+31000).toISOString(),'future proof'],['2000-01-01T00:00:00.000Z','old proof']])await rejects(()=>approve(f,proof(f,{signedAt:stamp})),/POS_PIN_RECOVERY_PROOF_EXPIRED/,label+' blocked');
 for(const [stamp,label] of [[null,'missing'],['2000-01-01T00:00:00Z','stale'],[new Date(Date.now()+60000).toISOString(),'future'],['infinity','infinite']])await rejects(()=>approve(f,proof(f),stamp),/POS_PIN_RECOVERY_CONFIRMATION_REQUIRED/,label+' password confirmation denied');
 await rejects(()=>approve(f,proof(f),undefined,hash(uid())),/POS_DEVICE_INVALID/,'wrong binding denied');await db.query('update public.pos_device_bindings set revoked_at=now() where token_hash=$1',[f.binding]);await rejects(()=>approve(f,proof(f)),/POS_DEVICE_INVALID/,'revoked binding denied');
 f=await fixture(true);await db.query('update public.pos_devices set active=false where id=$1',[f.device]);await rejects(()=>approve(f,proof(f)),/POS_DEVICE_INVALID/,'inactive device denied');
 f=await fixture(true);await db.query('update public.pos_branches set active=false where id=$1',[f.branch]);await rejects(()=>approve(f,proof(f)),/POS_ACCESS_DENIED/,'inactive branch denied');
 f=await fixture(true);await db.query('update public.pos_offline_key_epochs set blocked=true where id=$1',[f.enrollment.keyEpoch]);result=await approve(f,proof(f));check(result.approval.kind,'native-pin-recovery-approval','financially blocked epoch still permits local PIN recovery');check(await scalar('select blocked from public.pos_offline_key_epochs where id=$1',[f.enrollment.keyEpoch]),true,'recovery never unblocks epoch');check(await scalar('select sealed_at from public.pos_offline_authorities where id=$1',[f.bundle.authority.id]),null,'recovery never seals allocation');
 // Existing enrolled manager key can belong to a current cashier credential scope.
 const cashier=uid(),binding=hash(uid());await db.query('insert into auth.users values($1,\'synthetic-cashier@example.test\',now())',[cashier]);await db.query('insert into public.pos_staff(organization_id,user_id,branch_id,role) values($1,$2,$3,\'cashier\')',[f.org,cashier,f.branch]);await db.query('insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)',[binding,cashier,f.org,f.branch,f.device]);p=proof(f,{actorId:cashier});check((await approve({...f,owner:cashier,binding},p)).approval.actorId,cashier,'original cashier recovery does not require manager/enrolled_by identity');
 for(const changes of [{extra:true},{schemaVersion:2},{organizationId:uid()},{branchId:uid()},{deviceId:uid()},{keyEpoch:uid()},{deviceKeySha256:hash(uid())},{signedAt:'2026-01-01T00:00:00Z'},{oldCredentialSha256:'wrong'},{newCredentialSha256:null}])await rejects(()=>lookup(proof(f,changes)),/POS_PIN_RECOVERY_|invalid_request/,'malformed or foreign proof '+Object.keys(changes)[0]);
 p=proof(f);await rejects(()=>lookup({...p,newCredentialSha256:p.oldCredentialSha256}),/POS_PIN_RECOVERY_INVALID_PROOF/,'identical old/new commitments denied');
 const original=signed(p);await rejects(()=>service('pos_native_pin_recovery_lookup',{...original,payloadBase64Url:Buffer.from(canonical(p)+' ').toString('base64url')}),/POS_PIN_RECOVERY_INVALID_PROOF/,'trailing signed whitespace rejected');await rejects(()=>service('pos_native_pin_recovery_lookup',{...original,payloadBase64Url:Buffer.from(canonical(p).replace('{','{"kind":"native-pin-recovery",')).toString('base64url')}),/POS_PIN_RECOVERY_INVALID_PROOF/,'duplicate signed key rejected');await rejects(()=>service('pos_native_pin_recovery_lookup',{...original,extra:'x'.repeat(9000)}),/POS_PIN_RECOVERY_INVALID_PROOF/,'oversized envelope rejected before decode');
 for(const table of ['pos_native_pin_recoveries','pos_native_pin_recovery_signatures']){await rejects(()=>db.query(`update public.${table} set request_id=request_id`),/POS_IMMUTABLE_DOCUMENT/,table+' rejects updates');await rejects(()=>db.query(`delete from public.${table}`),/POS_IMMUTABLE_DOCUMENT/,table+' rejects deletion');}
}
async function concurrency(){if(!postgres)return;
 let f=await fixture(true),p=proof(f),when=new Date().toISOString();let r=await raced('same_request_approval',x=>rpcOn(x,'pos_native_pin_recovery_approve',f.owner,f.binding,signed(p),when),x=>rpcOn(x,'pos_native_pin_recovery_approve',f.owner,f.binding,signed(refresh(p)),when));check(r.second.value,r.first,'concurrent identical operation shares first approval');
 f=await fixture(true);p=proof(f);when=new Date().toISOString();r=await raced('competing_generation_ids',x=>rpcOn(x,'pos_native_pin_recovery_approve',f.owner,f.binding,signed(p),when),x=>rpcOn(x,'pos_native_pin_recovery_approve',f.owner,f.binding,signed({...p,requestId:uid()}),when));check(/POS_PIN_RECOVERY_CONFLICT/.test(r.second.error??''),true,'only one request consumes old generation');
 f=await fixture(true);p=proof(f);when=new Date().toISOString();r=await raced('approval_then_lookup',x=>rpcOn(x,'pos_native_pin_recovery_approve',f.owner,f.binding,signed(p),when),x=>rpcOn(x,'pos_native_pin_recovery_lookup',signed(p)));check(r.second.value,r.first,'lookup waits accepted transaction, never reports false absence');
 const first=envelope(r.first.approval);r=await raced('first_signature',x=>rpcOn(x,'pos_native_pin_recovery_attach',p.requestId,first),x=>rpcOn(x,'pos_native_pin_recovery_attach',p.requestId,envelope(r.first.approval,'rotated','MAgCAQMCAQE')));check(r.second.value.approvalEnvelope,first,'concurrent signature attach preserves first');
 f=await fixture(true);p=proof(f);when=new Date().toISOString();r=await raced('binding_revoke_then_approve',async x=>{await x.query('update public.pos_device_bindings set revoked_at=now() where token_hash=$1',[f.binding]);return'revoked'},x=>rpcOn(x,'pos_native_pin_recovery_approve',f.owner,f.binding,signed(p),when),{firstRole:null});check(/POS_DEVICE_INVALID/.test(r.second.error??''),true,'waiting approval rejects committed binding revocation');
 f=await fixture(true);p=proof(f);when=new Date().toISOString();
 const a=f.bundle.authority;await service('pos_offline_seal',a.id,0,null,envelope({kind:'offline-seal',schemaVersion:1,id:uid(),authorityId:a.id,keyEpoch:a.keyEpoch,deviceId:f.device,finalSequence:0,finalEventSha256:null},a.deviceKeySha256));
 await db.query("select set_config('app.user_id',$1,false)",[f.owner]);await db.exec('set role authenticated');await rpcOn(db,'pos_execute_live_command',{id:uid(),type:'shift.close',branchId:f.branch,deviceId:f.device,shiftId:f.shift,countedCashFils:0},f.binding);await db.exec('reset role');
 const admin=uid(),token=hash(uid());await db.query('insert into auth.users values($1,\'synthetic-admin@example.test\',now())',[admin]);await db.query('insert into public.pos_staff(organization_id,user_id,role) values($1,$2,\'owner\')',[f.org,admin]);await db.query('update public.pos_staff set role=\'manager\' where user_id=$1',[f.owner]);await db.query('insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)',[token,admin,f.org,f.branch,f.device]);
 const revoke={id:uid(),branchId:f.branch,deviceId:f.device,targetUserId:f.owner,expectedRevision:1,role:'manager',assignedBranchId:null,active:false,displayName:'Synthetic manager',reason:'Synthetic revocation'};
 r=await raced('staff_revoke_then_approve',async x=>{await x.query("select set_config('app.user_id',$1,true)",[admin]);return rpcOn(x,'pos_manage_staff',revoke,token)},x=>rpcOn(x,'pos_native_pin_recovery_approve',f.owner,f.binding,signed(p),when),{firstRole:'authenticated'});check(r.first.status,'updated','real staff writer committed revocation');check(/POS_ACCESS_DENIED/.test(r.second.error??''),true,'waiting approval sees post-lock staff revocation');
 f=await fixture(true);p=proof(f);when=new Date().toISOString();r=await raced('device_revoke_then_approve',async x=>{await x.query('update public.pos_devices set active=false where id=$1',[f.device]);return'disabled'},x=>rpcOn(x,'pos_native_pin_recovery_approve',f.owner,f.binding,signed(p),when),{firstRole:null});check(/POS_DEVICE_INVALID/.test(r.second.error??''),true,'waiting approval rejects inactive device');
}
async function acl(){
 for(const sig of ['pos_native_pin_recovery_context(uuid)','pos_native_pin_recovery_lookup(jsonb)','pos_native_pin_recovery_approve(uuid,text,jsonb,timestamp with time zone)','pos_native_pin_recovery_attach(uuid,jsonb)']){for(const role of ['anon','authenticated'])check(await scalar('select has_function_privilege($1,$2,\'EXECUTE\')',[role,'public.'+sig]),false,role+' denied '+sig);check(await scalar('select has_function_privilege(\'service_role\',$1,\'EXECUTE\')',['public.'+sig]),true,'service allowed '+sig);check(await scalar('select proconfig from pg_proc where oid=$1::regprocedure',['public.'+sig]),['search_path=""'],'empty search path '+sig)}
 check(await scalar('select has_function_privilege(\'service_role\',\'public.pos_native_pin_recovery_proof(jsonb)\',\'EXECUTE\')'),false,'private proof parser not exposed');
 for(const role of ['anon','authenticated','service_role'])for(const table of ['pos_native_pin_recoveries','pos_native_pin_recovery_signatures'])for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])check(await scalar('select has_table_privilege($1,$2,$3)',[role,'public.'+table,privilege]),false,role+' no '+privilege+' on '+table);
 await db.exec('set role authenticated');await rejects(()=>rpcOn(db,'pos_native_pin_recovery_context',uid()),/permission denied/,'actual browser role cannot call context');await db.exec('reset role');
}
try{await initialize();await scenarios();await concurrency();await acl();report.status='passed'}catch(error){report.status='failed';report.failure={message:error.message,where:error.where,stack:error.stack};process.exitCode=1;console.error(error.message,error.where??'')}
finally{for(const session of sessions)await session.end().catch(()=>{});if(db)await(postgres?db.end():db.close()).catch(()=>{});if(control&&database){try{await control.query(`drop database ${database}`);assert.equal(await scalar('select count(*)::int from pg_database where datname=$1',[database],control),0);report.cleanup='verified-dropped'}catch(error){report.cleanup='failed: '+error.message;process.exitCode=1}await control.end()}else report.cleanup=db?'embedded-database-closed':'not-created';report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({status:report.status,backend:report.backend,checks:report.checks.length,races:report.races.length,cleanup:report.cleanup,productionTouched:false}))}
