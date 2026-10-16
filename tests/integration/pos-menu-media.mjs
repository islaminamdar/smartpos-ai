// Synthetic disposable SQL026 normalized menu photo tests. No real merchants, provider calls or signature claims.
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
    database = 'pos_qa_menu_media_' + uid().replaceAll('-', '')
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
  const files = (await readdir(directory)).filter(f => /^20261016/.test(f) && !f.includes('007') && !f.includes('009') && f < '202610160027').sort()
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

// Bytes deliberately test the SQL trust boundary, not an actual image decoder.
function media(seed=uid(),id=uid(),size=48){const bytes=Buffer.alloc(size);bytes.write('RIFF');bytes.writeUInt32LE(size-8,4);bytes.write('WEBP',8);Buffer.from(hash(seed)).copy(bytes,12);return{id,sha256:hash(bytes),base64:bytes.toString('base64'),width:1,height:1,byteLength:bytes.length}}
const upload=(f,m)=>service('pos_menu_media_register',f.owner,f.branch,f.device,f.binding,m)
const context=f=>service('pos_menu_media_context',f.owner,f.branch,f.device,f.binding)
async function catalogue(f,image,commandId=uid(),revision=0,productId=uid()){
 const command={id:commandId,branchId:f.branch,deviceId:f.device,expectedRevision:revision,reason:'Synthetic photo edit',product:{id:productId,name:'Synthetic photo product',category:'Test',imageUrl:image,unit:'piece',unitPriceFils:1000,taxRateBps:500,active:true}};
 await db.query("select set_config('app.user_id',$1,false)",[f.owner]);await db.exec('set role authenticated');try{return await rpcOn(db,'pos_manage_catalogue',command,f.binding)}finally{await db.exec('reset role')}
}
async function seed(f,count,age='2 days'){
 // Trusted synthetic bulk fixtures exercise quota boundaries without 500 uploads.
 for(let i=0;i<count;i++){const m=media();await db.query(`insert into public.pos_menu_media(id,organization_id,branch_id,actor_id,device_id,sha256,width,height,bytes,created_at) values($1,$2,$3,$4,$5,$6,1,1,decode($7,'base64'),clock_timestamp()-$8::interval)`,[m.id,f.org,f.branch,f.owner,f.device,m.sha256,m.base64,age])}
}
async function scenarios(){
 let f=await fixture(),m=media();const before=await ledger(f);
 check(await context(f),{organizationId:f.org,branchId:f.branch,deviceId:f.device,actorId:f.owner},'manager admission exact context');
 let r=await upload(f,m);check(r,{status:'ready',image:{id:m.id,branchId:f.branch,imageUrl:'/pos-assets/menu/upload_'+m.id.replaceAll('-','')+'.webp',sha256:m.sha256,width:1,height:1,byteLength:48},replayed:false},'new immutable upload exact result');
 check(await service('pos_menu_media_read',m.id),m,'public asset read only normalized bytes and dimensions');check(await service('pos_menu_media_read',uid()),null,'unknown opaque asset returns null');
 check(await upload(f,m),{...r,replayed:true},'same ID exact retry');check(await upload(f,{...m,id:uid()}),{...r,replayed:true},'same branch content dedup preserves original ID');
 check(await ledger(f),before,'upload and admission have no financial or audit side effects');
 await rejects(()=>upload(f,{...m,width:2}),/POS_MEDIA_CONFLICT/,'same bytes inconsistent dimensions rejected');await rejects(()=>upload(f,media('different',m.id)),/POS_MEDIA_CONFLICT/,'same ID cannot change bytes');
 const other=await fixture();await rejects(()=>upload(other,m),/POS_MEDIA_CONFLICT/,'foreign branch cannot steal opaque ID');const otherResult=await upload(other,{...m,id:uid()});check(otherResult.replayed,false,'same bytes foreign branch separate identity');
 for(const [name,patch] of [['extra',{extra:1}],['uppercase ID',{id:m.id.toUpperCase()}],['hash',{sha256:'0'.repeat(64)}],['width null',{width:null}],['fractional width',{width:1.5}],['too wide',{width:1201}],['height zero',{height:0}],['size mismatch',{byteLength:47}],['base64 newline',{base64:m.base64+'\n'}],['base64url',{base64:'____'}],['null bytes',{base64:null}]])await rejects(()=>upload(f,{...m,id:uid(),...patch}),/POS_MEDIA_INVALID/,'invalid '+name);
 await rejects(()=>upload(f,null),/POS_MEDIA_INVALID/,'null media denied');await rejects(()=>upload(f,{...media(),base64:'a'.repeat(351001)}),/POS_MEDIA_INVALID/,'oversized JSON denied');
 const bad=Buffer.from(m.base64,'base64');bad[4]++;await rejects(()=>upload(f,{...m,id:uid(),base64:bad.toString('base64'),sha256:hash(bad)}),/POS_MEDIA_INVALID/,'RIFF declared length checked');bad[4]--;bad[0]=0;await rejects(()=>upload(f,{...m,id:uid(),base64:bad.toString('base64'),sha256:hash(bad)}),/POS_MEDIA_INVALID/,'non WebP header denied');
 check((await upload(f,media(uid(),uid(),262144))).image.byteLength,262144,'maximum normalized size accepted');await rejects(()=>upload(f,media(uid(),uid(),262145)),/POS_MEDIA_INVALID/,'oversized decoded bytes denied');
 await rejects(()=>db.query('update public.pos_menu_media set width=2 where id=$1',[m.id]),/immutable|preserved|not allowed/i,'media update blocked');await rejects(()=>db.query('delete from public.pos_menu_media where id=$1',[m.id]),/immutable|preserved|not allowed/i,'media delete blocked');
 const command=uid(),product=uid();const saved=await catalogue(f,r.image.imageUrl,command,0,product);check(saved.product.imageUrl,r.image.imageUrl,'own branch uploaded URL accepted');check((await catalogue(f,r.image.imageUrl,command,0,product)).replayed,true,'catalogue exact replay preserved');
 await rejects(()=>catalogue(other,r.image.imageUrl),/POS_MEDIA_SCOPE/,'foreign branch image rejected');await rejects(()=>catalogue(f,'/pos-assets/menu/upload_'+'0'.repeat(32)+'.webp'),/POS_MEDIA_SCOPE/,'unregistered opaque URL rejected');
 for(const url of ['/pos-assets/menu/UPLOAD_'+m.id.replaceAll('-','')+'.webp','/pos-assets/menu/upload_bad.webp','/pos-assets/menu/upload_'+m.id.replaceAll('-','').toUpperCase()+'.webp'])await rejects(()=>catalogue(f,url),/POS_MEDIA_INVALID/,'reserved namespace cannot fall back to legacy');
 check((await catalogue(f,'/pos-assets/menu/noon_legacy.webp')).status,'updated','legacy archived media remains accepted');check((await catalogue(f,null)).product.imageUrl,null,'removing photo remains accepted');
 // A historical exact command can retain an upload-looking URL from before this migration.
 const oldId=uid(),oldProduct=uid(),oldURL='/pos-assets/menu/upload_historical.webp';const oldCommand={id:oldId,branchId:f.branch,deviceId:f.device,expectedRevision:0,reason:'Synthetic photo edit',product:{id:oldProduct,name:'Synthetic photo product',category:'Test',imageUrl:oldURL,unit:'piece',unitPriceFils:1000,taxRateBps:500,active:true}};
 await db.query("select set_config('app.user_id',$1,false)",[f.owner]);await rpcOn(db,'pos_manage_catalogue_before_media',oldCommand,f.binding);check((await catalogue(f,oldURL,oldId,0,oldProduct)).replayed,true,'preexisting catalogue command replay bypasses new URL policy');
 f=await fixture();for(let i=0;i<30;i++)await context(f);await rejects(()=>context(f),/POS_MEDIA_RATE_LIMIT/,'31st predecode admission denied');check(await scalar('select attempts from public.pos_menu_media_admissions where actor_id=$1 and branch_id=$2',[f.owner,f.branch]),30,'admission counter stays bounded');
 await db.query("update public.pos_menu_media_admissions set window_start=window_start-interval '15 minutes' where actor_id=$1",[f.owner]);await context(f);check(await scalar('select attempts from public.pos_menu_media_admissions where actor_id=$1',[f.owner]),1,'next fixed window resets existing counter');
 f=await fixture();m=media();r=await upload(f,m);await seed(f,99,'0 seconds');await rejects(()=>upload(f,media()),/POS_MEDIA_DAILY_LIMIT/,'100 per UTC day cap');check((await upload(f,{...m,id:uid()})).replayed,true,'dedup allowed at daily cap');
 f=await fixture();m=media();await upload(f,m);await seed(f,511);await rejects(()=>upload(f,media()),/POS_MEDIA_CAPACITY/,'512 lifetime branch cap');check((await upload(f,{...m,id:uid()})).replayed,true,'dedup allowed at storage cap');
 for(const mutation of ["update public.pos_staff set role='cashier',branch_id=", "update public.pos_staff set active=false where user_id=", "update public.pos_devices set active=false where id=", "update public.pos_device_bindings set revoked_at=now() where device_id="]){
  f=await fixture();m=media();await upload(f,m);
  if(mutation.includes('cashier'))await db.query("update public.pos_staff set role='cashier',branch_id=$1 where user_id=$2",[f.branch,f.owner]);else await db.query(mutation+'$1',[mutation.includes('staff')?f.owner:f.device]);
  await rejects(()=>context(f),/POS_MANAGER_REQUIRED|POS_DEVICE_INVALID/,'revoked context denied '+mutation);await rejects(()=>upload(f,m),/POS_MANAGER_REQUIRED|POS_DEVICE_INVALID/,'revoked dedup denied '+mutation);check((await service('pos_menu_media_read',m.id)).id,m.id,'public immutable image survives access revocation');
 }
 f=await fixture();await db.query('update public.pos_branches set active=false where id=$1',[f.branch]);await rejects(()=>context(f),/POS_ACCESS_DENIED/,'inactive branch denied');

 f=await fixture();const differentBranch=uid();await db.query('insert into public.pos_branches(id,organization_id,name) values($1,$2,\'Synthetic second branch\')',[differentBranch,f.org]);await db.query("update public.pos_staff set role='manager',branch_id=$1 where user_id=$2",[f.branch,f.owner]);check((await context(f)).branchId,f.branch,'assigned manager allowed original branch');await db.query('update public.pos_staff set branch_id=$1 where user_id=$2',[differentBranch,f.owner]);await rejects(()=>context(f),/POS_MANAGER_REQUIRED/,'manager assigned another branch denied');
 f=await fixture();await rejects(()=>context({...f,binding:hash(uid())}),/POS_DEVICE_INVALID/,'unbound cookie denied');await rejects(()=>context({...f,owner:uid()}),/POS_MANAGER_REQUIRED/,'foreign actor denied');
}
async function concurrency(){if(!postgres)return;
 let f=await fixture(),m=media();let r=await raced('parallel_same_hash',x=>rpcOn(x,'pos_menu_media_register',f.owner,f.branch,f.device,f.binding,m),x=>rpcOn(x,'pos_menu_media_register',f.owner,f.branch,f.device,f.binding,{...m,id:uid()}));check(r.second.value.image.id,m.id,'concurrent same content keeps first identity');check(r.second.value.replayed,true,'concurrent dedup replay');
 f=await fixture();await seed(f,99,'0 seconds');r=await raced('daily_quota_final_slot',x=>rpcOn(x,'pos_menu_media_register',f.owner,f.branch,f.device,f.binding,media()),x=>rpcOn(x,'pos_menu_media_register',f.owner,f.branch,f.device,f.binding,media()));check(r.second.error,'POS_MEDIA_DAILY_LIMIT','concurrent daily final slot cannot exceed cap');
 f=await fixture();await seed(f,511);r=await raced('storage_quota_final_slot',x=>rpcOn(x,'pos_menu_media_register',f.owner,f.branch,f.device,f.binding,media()),x=>rpcOn(x,'pos_menu_media_register',f.owner,f.branch,f.device,f.binding,media()));check(r.second.error,'POS_MEDIA_CAPACITY','concurrent storage final slot cannot exceed cap');
 f=await fixture();for(let i=0;i<29;i++)await context(f);r=await raced('admission_final_slot',x=>rpcOn(x,'pos_menu_media_context',f.owner,f.branch,f.device,f.binding),x=>rpcOn(x,'pos_menu_media_context',f.owner,f.branch,f.device,f.binding));check(r.second.error,'POS_MEDIA_RATE_LIMIT','concurrent admission final slot bounded');
 for(const type of ['device','binding']){f=await fixture();r=await raced(type+'_revoke_then_upload',async x=>{if(type==='staff'){await x.query('select pg_advisory_xact_lock(hashtextextended($1,15))',[f.org+':'+f.owner]);await x.query('update public.pos_staff set active=false where user_id=$1',[f.owner])}else if(type==='device')await x.query('update public.pos_devices set active=false where id=$1',[f.device]);else await x.query('update public.pos_device_bindings set revoked_at=now() where device_id=$1',[f.device]);return'revoked'},x=>rpcOn(x,'pos_menu_media_register',f.owner,f.branch,f.device,f.binding,media()),{firstRole:null});check(r.second.error,type==='staff'?'POS_MANAGER_REQUIRED':'POS_DEVICE_INVALID','waiting upload rejects '+type+' revocation')}
 f=await fixture();await db.query("select set_config('app.user_id',$1,false)",[f.owner]);await db.exec('set role authenticated');await rpcOn(db,'pos_execute_live_command',{id:uid(),type:'shift.close',branchId:f.branch,deviceId:f.device,shiftId:f.shift,countedCashFils:0},f.binding);await db.exec('reset role');
 const admin=uid(),token=hash(uid());await db.query("insert into auth.users values($1,'synthetic-admin@example.test',now())",[admin]);await db.query("insert into public.pos_staff(organization_id,user_id,role) values($1,$2,'owner')",[f.org,admin]);await db.query("update public.pos_staff set role='manager' where user_id=$1",[f.owner]);await db.query('insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)',[token,admin,f.org,f.branch,f.device]);
 const revoke={id:uid(),branchId:f.branch,deviceId:f.device,targetUserId:f.owner,expectedRevision:1,role:'manager',assignedBranchId:null,active:false,displayName:'Synthetic manager',reason:'Synthetic revocation'};
 r=await raced('staff_writer_then_upload',async x=>{await x.query("select set_config('app.user_id',$1,true)",[admin]);return rpcOn(x,'pos_manage_staff',revoke,token)},x=>rpcOn(x,'pos_menu_media_register',f.owner,f.branch,f.device,f.binding,media()),{firstRole:'authenticated'});check(r.first.status,'updated','real staff writer commits revocation');check(r.second.error,'POS_MANAGER_REQUIRED','waiting upload observes real staff revocation');
 f=await fixture();r=await raced('branch_revoke_then_upload',async x=>{await x.query('update public.pos_branches set active=false where id=$1',[f.branch]);return'disabled'},x=>rpcOn(x,'pos_menu_media_register',f.owner,f.branch,f.device,f.binding,media()),{firstRole:null});check(r.second.error,'POS_ACCESS_DENIED','waiting upload rechecks branch active after row wait');
 f=await fixture();const foreign=await fixture();m=media();r=await raced('cross_branch_same_identity',x=>rpcOn(x,'pos_menu_media_register',f.owner,f.branch,f.device,f.binding,m),x=>rpcOn(x,'pos_menu_media_register',foreign.owner,foreign.branch,foreign.device,foreign.binding,m));check(r.second.error,'POS_MEDIA_CONFLICT','concurrent foreign ID collision cannot steal first identity');

}
async function acl(){
 for(const sig of ['pos_menu_media_context(uuid,uuid,uuid,text)','pos_menu_media_register(uuid,uuid,uuid,text,jsonb)','pos_menu_media_read(uuid)'])for(const role of ['anon','authenticated','service_role'])check(await scalar('select has_function_privilege($1,$2,\'EXECUTE\')',[role,'public.'+sig]),role==='service_role',role+' RPC '+sig);
 for(const role of ['anon','authenticated','service_role'])for(const table of ['pos_menu_media','pos_menu_media_admissions'])for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])check(await scalar('select has_table_privilege($1,$2,$3)',[role,'public.'+table,privilege]),false,role+' no '+privilege+' '+table);
 for(const sig of ['pos_menu_media_authority(uuid,uuid,uuid,text)','pos_menu_media_result(public.pos_menu_media,boolean)','pos_manage_catalogue_before_media(jsonb,text)'])for(const role of ['anon','authenticated','service_role'])check(await scalar('select has_function_privilege($1,$2,\'EXECUTE\')',[role,'public.'+sig]),false,role+' private helper '+sig);
 await db.exec('set role authenticated');await rejects(()=>rpcOn(db,'pos_menu_media_read',uid()),/permission denied/,'actual browser cannot call media reader');await db.exec('reset role');
}
try{await initialize();await scenarios();await concurrency();await acl();report.status='passed'}catch(error){report.status='failed';report.failure={message:error.message,where:error.where,stack:error.stack};process.exitCode=1;console.error(error.message,error.where??'')}
finally{for(const session of sessions)await session.end().catch(()=>{});if(db)await(postgres?db.end():db.close()).catch(()=>{});if(control&&database){try{await control.query(`drop database ${database}`);assert.equal(await scalar('select count(*)::int from pg_database where datname=$1',[database],control),0);report.cleanup='verified-dropped'}catch(error){report.cleanup='failed: '+error.message;process.exitCode=1}await control.end()}else report.cleanup=db?'embedded-database-closed':'not-created';report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({status:report.status,backend:report.backend,checks:report.checks.length,races:report.races.length,cleanup:report.cleanup,productionTouched:false}))}
