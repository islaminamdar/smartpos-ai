// Synthetic disposable SQL027 stock ledger tests. No real merchants, provider calls or signature claims.
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
    database = 'pos_qa_inventory_' + uid().replaceAll('-', '')
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
  const files = (await readdir(directory)).filter(f => /^20261016/.test(f) && !f.includes('007') && !f.includes('009') && f < '202610160028').sort()
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

const schemas=await import('../../lib/pos/inventory.ts')
const parsed=(schema,value)=>{schema.parse(value);return value}
const auth=async(f,name,...args)=>{await db.query("select set_config('app.user_id',$1,false)",[f.owner]);await db.exec('set role authenticated');try{return await rpcOn(db,name,...args)}finally{await db.exec('reset role')}}
const saveCommand=(f,patch={},revision=0,itemId=uid())=>({id:uid(),type:'item.save',branchId:f.branch,deviceId:f.device,expectedRevision:revision,reason:'Synthetic item metadata',item:{id:itemId,name:'Synthetic ingredient',sku:null,unit:'kg',reorderLevelMilli:1000,active:true,...patch}})
const movement=(f,item,type,quantity,patch={})=>({id:uid(),type,branchId:f.branch,deviceId:f.device,itemId:item.id,expectedRevision:item.revision,quantityMilli:quantity,reason:'Synthetic stock record',reference:null,...patch})
const apply=async(f,c)=>parsed(schemas.inventoryResultSchema,await auth(f,'pos_manage_inventory',c,f.binding))
const recover=async(f,c,mode='lookup')=>parsed(schemas.inventoryRecoverySchema,await auth(f,'pos_inventory_request',mode,c,f.binding))
const list=async(f,q={})=>parsed(schemas.inventoryListSchema,await auth(f,'pos_inventory',f.branch,{search:'',filter:'all',afterId:null,...q}))
const history=async(f,item,before=null)=>parsed(schemas.inventoryHistorySchema,await auth(f,'pos_inventory_history',f.branch,item,before))
const created=async(f,patch={})=> (await apply(f,saveCommand(f,patch))).item
const count=async(f,item,qty=0)=> (await apply(f,movement(f,item,'stock.count',qty))).item
async function unchangedFinancial(f){const value=await ledger(f);delete value.pos_audit_events;return value}
async function seedItems(f,n){await db.query(`insert into public.pos_stock_items(id,organization_id,branch_id,name,sku,unit,reorder_level_milli,active,revision,on_hand_milli,movement_count,created_at,updated_at) select gen_random_uuid(),$1,$2,'Synthetic bulk '||s,null,'kg',0,true,1,null,0,clock_timestamp(),clock_timestamp() from generate_series(1,$3::int) s`,[f.org,f.branch,n])}
async function scenarios(){
 let f=await fixture(),before=await unchangedFinancial(f);let l=await list(f);check(l.counts,{totalItems:0,activeItems:0,inactiveItems:0,lowStockItems:0,uncountedItems:0},'empty inventory is explicit');
 const initial=saveCommand(f,{name:'طحين 🧁',sku:'FLOUR-01'});let result=await apply(f,initial),item=result.item;check([item.revision,item.onHandMilli,item.movementCount,result.movement],[1,null,0,null],'new item unknown balance not zero');check((await list(f)).counts.uncountedItems,1,'unknown balance counted separately');check((await list(f,{filter:'low'})).items.length,0,'unknown excluded from low stock');
 for(const type of ['stock.receive','stock.waste','stock.adjust'])await rejects(()=>apply(f,movement(f,item,type,1)),/POS_INVENTORY_COUNT_REQUIRED/,'opening count required for '+type);
 let edit=saveCommand(f,{...initial.item,name:'Updated flour'},item.revision,item.id);result=await apply(f,edit);item=result.item;check([item.onHandMilli,item.movementCount,item.revision],[null,0,2],'metadata edit preserves uninitialized stock');
 const opening=movement(f,item,'stock.count',0);result=await apply(f,opening);item=result.item;check([result.movement.beforeMilli,result.movement.deltaMilli,result.movement.afterMilli,item.movementCount],[null,null,0,1],'opening zero count has unknown prior and delta');check((await list(f)).counts.lowStockItems,1,'initialized zero is low stock');check((await list(f)).counts.uncountedItems,0,'zero no longer uncounted');
 for(const [type,qty,balance,delta]of[['stock.receive',1501,1501,1501],['stock.waste',500,1001,-500],['stock.adjust',-1,1000,-1],['stock.count',950,950,-50],['stock.count',950,950,0]]){result=await apply(f,movement(f,item,type,qty));check([result.item.onHandMilli,result.movement.afterMilli,result.movement.deltaMilli],[balance,balance,delta],type+' exact milli arithmetic');item=result.item}
 const oldOpening=await recover(f,opening);check(oldOpening,{...(await scalar('select result from public.pos_inventory_commands where id=$1',[opening.id])),replayed:true},'recovery reads original stored result');check(oldOpening.item.onHandMilli,0,'recovery never substitutes current balance');check((await apply(f,opening)).item.onHandMilli,0,'same old write retry returns original result');
 await rejects(()=>apply(f,{...opening,quantityMilli:1}),/POS_IDEMPOTENCY_CONFLICT/,'changed request with same ID denied');await rejects(()=>apply(f,movement(f,item,'stock.count',2,{expectedRevision:item.revision-1})),/POS_INVENTORY_CONFLICT/,'stale revision denied');
 await rejects(()=>apply(f,movement(f,item,'stock.waste',951)),/POS_INVENTORY_INSUFFICIENT/,'waste never produces negative');await rejects(()=>apply(f,movement(f,item,'stock.adjust',-951)),/POS_INVENTORY_INSUFFICIENT/,'adjust never produces negative');
 for(const [label,c]of[['fraction',movement(f,item,'stock.count',1.25)],['negative count',movement(f,item,'stock.count',-1)],['zero receive',movement(f,item,'stock.receive',0)],['zero adjust',movement(f,item,'stock.adjust',0)],['zero waste',movement(f,item,'stock.waste',0)],['over cap',movement(f,item,'stock.count',1000000000001)],['extra',{...movement(f,item,'stock.count',1),extra:1}],['null reason',{...movement(f,item,'stock.count',1),reason:null}],['empty reason',{...movement(f,item,'stock.count',1),reason:''}],['long reference',{...movement(f,item,'stock.count',1),reference:'x'.repeat(121)}],['uppercase id',{...movement(f,item,'stock.count',1),id:uid().toUpperCase()}],['missing reference',Object.fromEntries(Object.entries(movement(f,item,'stock.count',1)).filter(([k])=>k!=='reference'))]])await rejects(()=>auth(f,'pos_manage_inventory',c,f.binding),/POS_INVENTORY_INVALID/,'strict input '+label);
 await rejects(()=>auth(f,'pos_manage_inventory',{...movement(f,item,'stock.count',1),reason:'actual\0nul'},f.binding),/unsupported Unicode|\\u0000|Unicode escape/i,'actual NUL rejected before JSONB SQL');
 result=await apply(f,movement(f,item,'stock.count',950,{reason:String.raw`literal\u0000 reason`,reference:'دفعة 🧁'}));item=result.item;check(result.movement.reason,String.raw`literal\u0000 reason`,'literal escaped text preserved');
 const stable=await history(f,item.id);await db.query("update public.pos_staff set display_name='Renamed manager' where user_id=$1",[f.owner]);await db.query("update public.pos_devices set name='Renamed counter' where id=$1",[f.device]);check((await history(f,item.id)).entries,stable.entries,'historical actor/device labels remain snapshots');
 await rejects(()=>apply(f,saveCommand(f,{...initial.item,unit:'litre'},item.revision,item.id)),/POS_INVENTORY_UNIT_IMMUTABLE/,'unit immutable after initialization');
 result=await apply(f,saveCommand(f,{...initial.item,active:false},item.revision,item.id));item=result.item;check([item.onHandMilli,item.movementCount],[950,stable.item.movementCount],'retire preserves balance/history');await rejects(()=>apply(f,movement(f,item,'stock.count',0)),/POS_INVENTORY_INACTIVE/,'inactive item cannot move');check((await list(f,{filter:'inactive'})).items[0].id,item.id,'inactive filter');check((await recover(f,opening)).item.onHandMilli,0,'retirement never changes old result');
 let piece=await created(f,{name:'Eggs',sku:'EGGS',unit:'piece',reorderLevelMilli:2000});await rejects(()=>apply(f,movement(f,piece,'stock.count',1)),/POS_INVENTORY_INVALID/,'piece opening count whole units');piece=await count(f,piece,2000);await rejects(()=>apply(f,movement(f,piece,'stock.adjust',-1)),/POS_INVENTORY_INVALID/,'piece adjustment whole units');piece=(await apply(f,movement(f,piece,'stock.waste',1000))).item;check(piece.onHandMilli,1000,'piece whole-unit waste');
 await rejects(()=>apply(f,saveCommand(f,{unit:'piece',reorderLevelMilli:1})),/POS_INVENTORY_INVALID/,'piece threshold whole units');await rejects(()=>apply(f,saveCommand(f,{sku:'EGGS'})),/POS_INVENTORY_SKU_CONFLICT/,'SKU branch uniqueness');await rejects(()=>apply(f,saveCommand(f,{sku:'lower-case'})),/POS_INVENTORY_INVALID/,'SKU uppercase contract');
 const foreign=await fixture();check((await created(foreign,{sku:'EGGS'})).sku,'EGGS','same SKU another branch allowed');await rejects(()=>history(foreign,item.id),/POS_INVENTORY_NOT_FOUND/,'foreign history inaccessible');await rejects(()=>apply(foreign,saveCommand(foreign,{},0,item.id)),/POS_ACCESS_DENIED/,'foreign global item ID inaccessible');
 let max=await created(f,{unit:'litre'});max=await count(f,max,1000000000000);await rejects(()=>apply(f,movement(f,max,'stock.receive',1)),/POS_INVENTORY_CAPACITY/,'balance upper bound guarded');max=(await apply(f,movement(f,max,'stock.adjust',-1000000000000))).item;check(max.onHandMilli,0,'signed boundary exact without float');
 check(await unchangedFinancial(f),before,'inventory leaves all financial ledgers unchanged');
 for(const table of ['pos_inventory_commands','pos_stock_movements']){await rejects(()=>db.query(`delete from public.${table} where organization_id=$1`,[f.org]),/immutable/i,'no delete '+table);await rejects(()=>db.query(`update public.${table} set actor_id=actor_id where organization_id=$1`,[f.org]),/immutable/i,'no update '+table)}
 await rejects(()=>db.query("update public.pos_stock_items set unit='litre' where id=$1",[piece.id]),/POS_INVENTORY_IMMUTABLE/,'database unit guard');await rejects(()=>db.query('delete from public.pos_stock_items where id=$1',[piece.id]),/POS_INVENTORY_IMMUTABLE/,'items cannot be deleted');
 // Real request cancellation: lookup alone never creates an absence tombstone.
 let missing=saveCommand(f);check(await recover(f,missing),{status:'not_found',requestId:missing.id},'missing lookup explicit absence');check(await scalar('select count(*)::int from public.pos_inventory_commands where id=$1',[missing.id]),0,'missing lookup no mutation');check((await recover(f,missing,'cancel')).status,'cancelled','explicit cancel durable');check((await apply(f,missing)).status,'cancelled','late exact writer cannot resurrect cancelled request');check(await scalar('select count(*)::int from public.pos_stock_items where id=$1',[missing.item.id]),0,'cancel leaves no item');await rejects(()=>apply(f,{...missing,reason:'Changed'}),/POS_IDEMPOTENCY_CONFLICT/,'cancelled ID changed payload conflict');check((await recover(f,opening,'cancel')).status,'applied','cancel after applied never undoes stock');
 // Original revoked actor may only retrieve/cancel its exact historical request scope.
 const pending=saveCommand(f);await db.query('update public.pos_staff set active=false where user_id=$1',[f.owner]);await db.query('update public.pos_device_bindings set revoked_at=now() where device_id=$1',[f.device]);await db.query('update public.pos_devices set active=false where id=$1',[f.device]);await db.query('update public.pos_branches set active=false where id=$1',[f.branch]);
 check((await recover(f,opening)).item.onHandMilli,0,'exact historical result survives all revocations');check((await recover(f,pending,'cancel')).status,'cancelled','revoked original actor can safely tombstone own absent request');await rejects(()=>apply(f,pending),/POS_ACCESS_DENIED|POS_MANAGER_REQUIRED/,'revoked actor cannot execute even cancelled write');await rejects(()=>list(f),/POS_ACCESS_DENIED|POS_MANAGER_REQUIRED/,'revoked actor cannot read latest branch stock');await rejects(()=>recover({...f,binding:hash(uid())},opening),/POS_DEVICE_INVALID/,'historical exact binding required');await rejects(()=>recover({...f,owner:foreign.owner},opening),/POS_DEVICE_INVALID|POS_IDEMPOTENCY_CONFLICT/,'other actor cannot retrieve old result');
 f=await fixture();await db.query("update public.pos_staff set role='cashier',branch_id=$1 where user_id=$2",[f.branch,f.owner]);await rejects(()=>list(f),/POS_MANAGER_REQUIRED/,'cashier read denied');await rejects(()=>apply(f,saveCommand(f)),/POS_MANAGER_REQUIRED/,'cashier write denied');
 f=await fixture();const branch=uid();await db.query("insert into public.pos_branches(id,organization_id,name)values($1,$2,'Synthetic other branch')",[branch,f.org]);await db.query("update public.pos_staff set role='manager',branch_id=$1 where user_id=$2",[branch,f.owner]);await rejects(()=>list(f),/POS_MANAGER_REQUIRED|POS_ACCESS_DENIED/,'manager other branch denied');await db.query('update public.pos_staff set branch_id=$1 where user_id=$2',[f.branch,f.owner]);check((await list(f)).status,'ready','branch manager own branch allowed');
 f=await fixture();let clockItem=await created(f);const future=new Date(Date.now()+60000).toISOString();await db.query('update public.pos_stock_items set updated_at=$1 where id=$2',[future,clockItem.id]);const clockResult=await apply(f,movement(f,clockItem,'stock.count',0));check(new Date(clockResult.item.updatedAt).toISOString(),future,'projection timestamp never regresses across server clock rollback');
 const clockEdit=await apply(f,saveCommand(f,{name:'Timestamp test'},clockResult.item.revision,clockItem.id));check(new Date(clockEdit.item.updatedAt).toISOString(),future,'metadata timestamp also remains monotonic');

}
async function pagination(){
 const f=await fixture();for(let i=0;i<57;i++)await created(f,{name:i===0?'Sugar 100%':i===1?'A_B':i===2?'O\'Reilly':`Flour ${String(i).padStart(2,'0')}`});
 let a=await list(f),b=await list(f,{afterId:a.nextCursor});check([a.items.length,b.items.length,a.counts.totalItems,b.counts.totalItems,a.matchingItems,b.matchingItems],[50,7,57,57,57,57],'full counts independent of display page');check(new Set([...a.items,...b.items].map(x=>x.id)).size,57,'keyset pages no missing or duplicated items');check(b.nextCursor,null,'final cursor absent');
 for(const search of ['%','_',"O'Reilly"]){const result=await list(f,{search});check(result.matchingItems,1,'literal search '+search)}check((await list(f,{search:"' OR true --"})).matchingItems,0,'search injection treated as text');
 for(const query of [{search:'',filter:'all',afterId:null,extra:1},{search:'x'.repeat(161),filter:'all',afterId:null},{search:'',filter:null,afterId:null},{search:'',filter:'all',afterId:5}])await rejects(()=>auth(f,'pos_inventory',f.branch,query),/POS_INVENTORY_INVALID/,'malformed list query denied');
 let item=a.items[0];item=await count(f,item,0);for(let i=0;i<53;i++)item=(await apply(f,movement(f,item,'stock.receive',1))).item;let h=await history(f,item.id),h2=await history(f,item.id,h.nextBeforeRevision);check([h.entries.length,h2.entries.length,h.item.movementCount,h2.item.movementCount],[50,4,54,54],'history pages preserve full movement count');check(new Set([...h.entries,...h2.entries].map(x=>x.id)).size,54,'history pages no duplicates/gaps');check(h2.entries.at(-1).beforeMilli,null,'history includes initial unknown count');
 await rejects(()=>history(f,item.id,1),/POS_INVENTORY_INVALID/,'history cursor revision1 denied');
 const capacity=await fixture();const first=saveCommand(capacity);await apply(capacity,first);await seedItems(capacity,999);check((await list(capacity)).counts.totalItems,1000,'complete 1000 item boundary read');await rejects(()=>apply(capacity,saveCommand(capacity)),/POS_INVENTORY_CAPACITY/,'1001st item denied');check((await apply(capacity,first)).replayed,true,'existing command replay allowed at quota');await seedItems(capacity,1);await rejects(()=>list(capacity),/POS_INVENTORY_CAPACITY/,'oversized source fails instead of publishing partial count');
}
async function concurrency(){if(!postgres)return;
 const opts=f=>({firstRole:'authenticated',secondRole:'authenticated',actor:f.owner});
 let f=await fixture(),c=saveCommand(f);let r=await raced('same_command',x=>rpcOn(x,'pos_manage_inventory',c,f.binding),x=>rpcOn(x,'pos_manage_inventory',c,f.binding),opts(f));check(r.second.value,{...r.first,replayed:true},'same command concurrent exactly once');
 f=await fixture();c=saveCommand(f);r=await raced('changed_command_same_id',x=>rpcOn(x,'pos_manage_inventory',c,f.binding),x=>rpcOn(x,'pos_manage_inventory',{...c,reason:'Changed'},f.binding),opts(f));check(r.second.error,'POS_IDEMPOTENCY_CONFLICT','different body same ID fails after wait');
 let item=await created(f);item=await count(f,item,1000);const receive=movement(f,item,'stock.receive',100),waste=movement(f,item,'stock.waste',50);r=await raced('same_revision_movements',x=>rpcOn(x,'pos_manage_inventory',receive,f.binding),x=>rpcOn(x,'pos_manage_inventory',waste,f.binding),opts(f));check(r.second.error,'POS_INVENTORY_CONFLICT','one exact revision winner');check((await history(f,item.id)).item.onHandMilli,1100,'failed competing waste did not change balance');
 item=(await history(f,item.id)).item;const countCmd=movement(f,item,'stock.count',5),receive2=movement(f,item,'stock.receive',10);r=await raced('count_then_receive',x=>rpcOn(x,'pos_manage_inventory',countCmd,f.binding),x=>rpcOn(x,'pos_manage_inventory',receive2,f.binding),opts(f));check(r.second.error,'POS_INVENTORY_CONFLICT','count prevents stale receive overwrite');
 c=saveCommand(f);r=await raced('cancel_then_delayed_write',x=>rpcOn(x,'pos_inventory_request','cancel',c,f.binding),x=>rpcOn(x,'pos_manage_inventory',c,f.binding),opts(f));check(r.second.value.status,'cancelled','cancel wins against delayed writer');check(await scalar('select count(*)::int from public.pos_stock_items where id=$1',[c.item.id]),0,'cancel winner no item');
 c=saveCommand(f);r=await raced('write_then_cancel',x=>rpcOn(x,'pos_manage_inventory',c,f.binding),x=>rpcOn(x,'pos_inventory_request','cancel',c,f.binding),opts(f));check(r.second.value,{...r.first,replayed:true},'committed write wins cancellation exact result');
 c=saveCommand(f);r=await raced('write_then_lookup',x=>rpcOn(x,'pos_manage_inventory',c,f.binding),x=>rpcOn(x,'pos_inventory_request','lookup',c,f.binding),opts(f));check(r.second.value.status,'applied','lookup waits for in flight committed writer');
 const sku='SIMULTANEOUS';r=await raced('same_branch_sku',x=>rpcOn(x,'pos_manage_inventory',saveCommand(f,{sku}),f.binding),x=>rpcOn(x,'pos_manage_inventory',saveCommand(f,{sku}),f.binding),opts(f));check(r.second.error,'POS_INVENTORY_SKU_CONFLICT','SKU contention one winner');
 f=await fixture();const other=await fixture();c=saveCommand(f);const foreign={...saveCommand(other),item:{...c.item}};r=await raced('cross_branch_global_item',x=>rpcOn(x,'pos_manage_inventory',c,f.binding),async x=>{await x.query("select set_config('app.user_id',$1,true)",[other.owner]);return rpcOn(x,'pos_manage_inventory',foreign,other.binding)},opts(f));check(r.second.error,'POS_ACCESS_DENIED','global item identity serialized across branches');
 for(const target of ['device','binding','branch']){f=await fixture();c=saveCommand(f);r=await raced(target+'_revocation_then_write',async x=>{if(target==='device')await x.query('update public.pos_devices set active=false where id=$1',[f.device]);else if(target==='binding')await x.query('update public.pos_device_bindings set revoked_at=now() where device_id=$1',[f.device]);else await x.query('update public.pos_branches set active=false where id=$1',[f.branch]);return'revoked'},x=>rpcOn(x,'pos_manage_inventory',c,f.binding),{...opts(f),firstRole:null});check(r.second.error,target==='branch'?'POS_ACCESS_DENIED':'POS_DEVICE_INVALID','waiting write observes '+target+' revocation')}
 f=await fixture();await auth(f,'pos_execute_live_command',{id:uid(),type:'shift.close',branchId:f.branch,deviceId:f.device,shiftId:f.shift,countedCashFils:0},f.binding);const admin=uid(),token=hash(uid());await db.query("insert into auth.users values($1,'synthetic-admin@example.test',now())",[admin]);await db.query("insert into public.pos_staff(organization_id,user_id,role) values($1,$2,'owner')",[f.org,admin]);await db.query("update public.pos_staff set role='manager' where user_id=$1",[f.owner]);await db.query('insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)',[token,admin,f.org,f.branch,f.device]);const revoke={id:uid(),branchId:f.branch,deviceId:f.device,targetUserId:f.owner,expectedRevision:1,role:'manager',assignedBranchId:null,active:false,displayName:'Synthetic manager',reason:'Synthetic revocation'};c=saveCommand(f);
 r=await raced('real_staff_revocation_then_write',async x=>{await x.query("select set_config('app.user_id',$1,true)",[admin]);return rpcOn(x,'pos_manage_staff',revoke,token)},x=>rpcOn(x,'pos_manage_inventory',c,f.binding),opts(f));check(r.first.status,'updated','actual staff revocation commits');check(/POS_ACCESS_DENIED|POS_MANAGER_REQUIRED/.test(r.second.error),true,'waiting inventory write denies revoked staff');
 // Reader starts while atomic writer is uncommitted; item and history must share one snapshot.
 f=await fixture();item=await created(f);const writer=new Client({...config,database,application_name:'inventory_snapshot_writer'});sessions.push(writer);await writer.connect();await writer.query('begin');await writer.query("select set_config('app.user_id',$1,true)",[f.owner]);await writer.query('set local role authenticated');const write=await rpcOn(writer,'pos_manage_inventory',movement(f,item,'stock.count',1234),f.binding);const during=await history(f,item.id);check([during.item.onHandMilli,during.item.movementCount,during.entries.length],[null,0,0],'uncommitted writer yields complete prior history snapshot');await writer.query('commit');await writer.end();sessions.splice(sessions.indexOf(writer),1);const after=await history(f,item.id);check([after.item.onHandMilli,after.item.movementCount,after.entries.length,after.entries[0].id],[1234,1,1,write.requestId],'committed item and movement appear together');

}
async function acl(){
 for(const sig of ['pos_inventory(uuid,jsonb)','pos_inventory_history(uuid,uuid,integer)','pos_manage_inventory(jsonb,text)','pos_inventory_request(text,jsonb,text)'])for(const role of ['anon','authenticated','service_role'])check(await scalar('select has_function_privilege($1,$2,\'EXECUTE\')',[role,'public.'+sig]),role==='authenticated',role+' RPC '+sig);
 for(const role of ['anon','authenticated','service_role'])for(const table of ['pos_stock_items','pos_inventory_commands','pos_stock_movements'])for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])check(await scalar('select has_table_privilege($1,$2,$3)',[role,'public.'+table,privilege]),false,role+' no '+privilege+' '+table);
 for(const sig of ['pos_inventory_validate(jsonb)','pos_inventory_authority(uuid)','pos_inventory_device(uuid,uuid,text,boolean)'])check(await scalar('select has_function_privilege(\'authenticated\',$1,\'EXECUTE\')',['public.'+sig]),false,'private helper '+sig);
 await db.exec('set role anon');await rejects(()=>rpcOn(db,'pos_inventory',uid(),{search:'',filter:'all',afterId:null}),/permission denied/,'actual anonymous role cannot read inventory');await db.exec('reset role');
}
try{await initialize();await scenarios();await pagination();await concurrency();await acl();report.status='passed'}catch(error){report.status='failed';report.failure={message:error.message,where:error.where,stack:error.stack};process.exitCode=1;console.error(error.message,error.where??'')}
finally{for(const session of sessions)await session.end().catch(()=>{});if(db)await(postgres?db.end():db.close()).catch(()=>{});if(control&&database){try{await control.query(`drop database ${database}`);assert.equal(await scalar('select count(*)::int from pg_database where datname=$1',[database],control),0);report.cleanup='verified-dropped'}catch(error){report.cleanup='failed: '+error.message;process.exitCode=1}await control.end()}else report.cleanup=db?'embedded-database-closed':'not-created';report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({status:report.status,backend:report.backend,checks:report.checks.length,races:report.races.length,cleanup:report.cleanup,productionTouched:false}))}
