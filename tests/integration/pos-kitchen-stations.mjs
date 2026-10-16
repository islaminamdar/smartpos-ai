// SQL031 configuration acceptance. Creates/drops only its own disposable database.
// node tests/integration/pos-kitchen-stations.mjs /absolute/pg/lib/index.js /tmp/pos-qa-pg-<unique> /private/report.json
// Authentication is a synthetic SQL identity; this is not hosted-auth or routing acceptance.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { userInfo } from 'node:os'
import assert from 'node:assert/strict'

const [entry, socket, reportPath] = process.argv.slice(2)
assert.ok(socket?.startsWith('/tmp/pos-qa-pg-') && !socket.includes('..'))
assert.ok(entry?.startsWith('/') && reportPath?.startsWith('/'))
const pg = await import(pathToFileURL(entry).href)
const Client = pg.Client ?? pg.default.Client
const options = { host: socket, port: 55432, user: userInfo().username, connectionTimeoutMillis: 5000 }
const database = 'pos_qa_stations_' + randomUUID().replaceAll('-', '')
const control = new Client({ ...options, database: 'postgres' })
const db = new Client({ ...options, database })
const report = { startedAt: new Date().toISOString(), database, productionTouched: false, status: 'pending', checks: [], races: [], migrationHashes: {}, cleanup: 'pending' }
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
const check = (a, b, name) => { assert.deepEqual(a, b, name); report.checks.push(name) }
const reject = async (p, pattern, name) => { await assert.rejects(p, pattern); report.checks.push(name) }
const uid = randomUUID
const hash = x => createHash('sha256').update(x).digest('hex')
const scalar = async (sql, args = [], connection = db) => Object.values((await connection.query(sql, args)).rows[0])[0]
const rpc = (connection, name, ...args) => scalar(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args.map(x => x && typeof x === 'object' ? JSON.stringify(x) : x), connection)
let created = false, connected = false, schemas

async function auth(f, name, ...args) {
  await db.query("select set_config('app.user_id',$1,false)", [f.actor])
  await db.query('set role authenticated')
  try { return await rpc(db, name, ...args) } finally { await db.query('reset role') }
}
const list = async (f, cursor = null) => schemas.stationListSchema.parse(await auth(f, 'pos_list_kitchen_stations', f.branch, f.device, f.binding, cursor))
const apply = async (f, c) => schemas.stationResultSchema.parse(await auth(f, 'pos_execute_kitchen_station_command', c, f.binding))
const resolve = async (f, c) => {
  const value = await auth(f, 'pos_resolve_kitchen_station_request', c, f.binding)
  return (value.status === 'cancelled' ? schemas.stationCancellationSchema : schemas.stationResultSchema).parse(value)
}
const station = (f, revision, patch = {}) => ({ id: uid(), branchId: f.branch, deviceId: f.device, expectedRevision: revision, type: 'station.save', station: { id: uid(), name: 'Grill', active: true, ...patch } })
const route = (f, revision, stationId, productId = f.product) => ({ id: uid(), branchId: f.branch, deviceId: f.device, expectedRevision: revision, type: 'route.set', productId, stationId })

async function fixture() {
  const f = Object.fromEntries(['actor', 'org', 'branch', 'device', 'product'].map(k => [k, uid()]))
  f.binding = hash(uid())
  await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [f.actor, uid() + '@example.test'])
  await db.query('insert into public.pos_organizations(id,legal_name) values($1,$2)', [f.org, 'Synthetic station audit'])
  await db.query('insert into public.pos_branches(id,organization_id,name) values($1,$2,$3)', [f.branch, f.org, 'Synthetic branch'])
  await db.query("insert into public.pos_staff(organization_id,user_id,branch_id,role) values($1,$2,null,'owner')", [f.org, f.actor])
  await db.query('insert into public.pos_devices(id,organization_id,branch_id,name) values($1,$2,$3,$4)', [f.device, f.org, f.branch, 'Synthetic counter'])
  await db.query('insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)', [f.binding, f.actor, f.org, f.branch, f.device])
  await db.query("insert into public.pos_products(id,organization_id,branch_id,name,category,unit_price_fils,tax_rate_bps) values($1,$2,$3,'Synthetic product','Test',1000,500)", [f.product, f.org, f.branch])
  return f
}

async function unchanged() {
  const values = {}
  for (const name of ['pos_products', 'pos_orders', 'pos_documents', 'pos_payments', 'pos_open_tabs', 'pos_kitchen_tickets', 'pos_tab_kitchen_tickets', 'pos_tab_kitchen_batches', 'pos_tab_kitchen_events', 'pos_kitchen_return_notices', 'pos_stock_items'])
    values[name] = await scalar(`select md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from public.${name} t`)
  return values
}

async function race(name, f, first, second) {
  const a = new Client({ ...options, database, application_name: name + '_a' }), b = new Client({ ...options, database, application_name: name + '_b' })
  await a.connect(); await b.connect()
  try {
    for (const c of [a, b]) {
      await c.query('begin')
      await c.query("set local statement_timeout='8s'")
      await c.query("select set_config('app.user_id',$1,true)", [f.actor])
    }
    const firstResult = await first(a)
    let finished = false
    const pending = second(b).then(value => ({ value }), error => ({ error: error.message })).finally(() => { finished = true })
    let observed
    for (let i = 0; i < 150 && !finished; i++) {
      const row = (await control.query("select wait_event_type,cardinality(pg_blocking_pids(pid)) as blockers from pg_stat_activity where datname=$1 and application_name=$2", [database, name + '_b'])).rows[0]
      if (row?.wait_event_type === 'Lock' && row.blockers > 0) { observed = row; break }
      await new Promise(r => setTimeout(r, 20))
    }
    await a.query('commit')
    const result = await pending
    await b.query(result.error ? 'rollback' : 'commit')
    check(!!observed, true, name + ': independently observed lock wait')
    report.races.push({ name, firstResult, result, observed })
    await save()
    return result
  } finally {
    await a.query('rollback').catch(() => {}); await b.query('rollback').catch(() => {})
    await a.end(); await b.end()
  }
}
const userRpc = async (c, name, ...args) => { await c.query('set local role authenticated'); return rpc(c, name, ...args) }

async function scenarios() {
  const f = await fixture(), foreign = await fixture()
  const baseline = await unchanged()
  check((await list(f)).revision, 0, 'new branch starts at explicit revision zero')
  check((await list(f)).routes, [], 'General fallback needs no fabricated route rows')
  const initial = station(f, 0, { name: 'مطبخ 🧁' }), saved = await apply(f, initial)
  check(saved.revision, 1, 'create advances revision exactly once')
  check(saved.station.name, initial.station.name, 'Unicode name preserved exactly')
  check(await apply(f, initial), { ...saved, replayed: true }, 'exact create replay retains original result')
  check(await resolve(f, initial), { ...saved, replayed: true }, 'recovery returns exact original result')
  await reject(apply(f, { ...initial, station: { ...initial.station, name: 'Changed request' } }), /POS_IDEMPOTENCY_CONFLICT/, 'changed request cannot adopt committed ID')
  const assigned = route(f, 1, saved.station.id)
  check((await apply(f, assigned)).route, { productId: f.product, stationId: saved.station.id }, 'route assignment acknowledgement is exact')
  await reject(apply(f, station(f, 2, { ...initial.station, active: false })), /POS_STATION_ASSIGNED/, 'assigned station cannot be archived')
  await reject(apply(f, route(f, 2, saved.station.id)), /POS_STATION_NO_CHANGES/, 'unchanged route consumes no revision')
  check((await list(f)).revision, 2, 'failed archive and no-op consume no revisions')
  check((await apply(f, route(f, 2, null))).route, { productId: f.product, stationId: null }, 'clear explicitly restores future General fallback')
  const archive = await apply(f, station(f, 3, { ...initial.station, active: false }))
  check(archive.station.active, false, 'unassigned station archives without deletion')
  await reject(apply(f, route(f, 4, saved.station.id)), /POS_STATION_NOT_FOUND/, 'archived station cannot receive future assignment')
  const reused = await apply(f, station(f, 4, { name: initial.station.name }))
  await reject(apply(f, station(f, 5, initial.station)), /POS_STATION_NAME_CONFLICT/, 'reactivation cannot collide with active name')
  const renamed = await apply(f, station(f, 5, { ...initial.station, name: 'Grill' }))
  await reject(apply(f, station(f, 6, { name: 'gRiLl' })), /POS_STATION_NAME_CONFLICT/, 'active station names are case-insensitively unique')
  await reject(apply(f, station(f, 6, renamed.station)), /POS_STATION_INVALID/, 'snapshot fields cannot leak into strict command station')
  await reject(apply(f, station(f, 6, { id: renamed.station.id, name: 'Grill', active: true })), /POS_STATION_NO_CHANGES/, 'unchanged metadata is not a mutation')
  await reject(apply(f, station(f, 0)), /POS_STATION_CONFLICT/, 'stale branch revision rejected')
  for (const name of ['', ' General', 'General', 'gEnErAl', 'x ', '\u00a0x', 'x\uFEFF', 'x\nY', 'x\u007fY', '🧁'.repeat(61)])
    await reject(apply(f, station(f, 6, { name })), /POS_STATION_INVALID/, 'invalid station name rejected: ' + JSON.stringify(name))
  for (const change of [{ extra: true }, { expectedRevision: '6' }, { expectedRevision: 6.5 }, { expectedRevision: -1 }, { expectedRevision: 2147483647 }, { id: 'not-uuid' }, { branchId: f.branch.toUpperCase() }])
    await reject(apply(f, { ...station(f, 6), ...change }), /POS_STATION_INVALID/, 'strict command rejects ' + Object.keys(change).join(','))
  await reject(apply(f, station(f, 6, { active: false })), /POS_STATION_INVALID/, 'new archived station rejected')
  await reject(apply(f, route(f, 6, reused.station.id, foreign.product)), /POS_STATION_PRODUCT_INVALID/, 'foreign product cannot be routed')
  await reject(apply(f, route(f, 6, uid())), /POS_STATION_NOT_FOUND/, 'unknown station rejected')
  await reject(apply(foreign, station(foreign, 0, { id: reused.station.id })), /POS_ACCESS_DENIED|POS_STATION_NOT_FOUND/, 'station identity cannot be adopted across tenants')
  await reject(list({ ...f, branch: foreign.branch }), /POS_ACCESS_DENIED|POS_DEVICE_INVALID/, 'foreign branch read denied')
  await reject(list({ ...f, binding: hash('wrong') }), /POS_DEVICE_INVALID/, 'wrong current binding denied')
  check(await unchanged(), baseline, 'configuration leaves menu financial stock and kitchen records unchanged')

  const cancelled = station(f, 6, { name: 'Never applied' })
  const cancellation = await resolve(f, cancelled)
  check(cancellation.status, 'cancelled', 'uncommitted recovery creates durable cancellation')
  check(await resolve(f, cancelled), { ...cancellation, replayed: true }, 'cancel recovery idempotent')
  await reject(apply(f, cancelled), /POS_REQUEST_CANCELLED/, 'late write cannot defeat cancellation')
  await reject(resolve(f, { ...cancelled, expectedRevision: 5 }), /POS_IDEMPOTENCY_CONFLICT/, 'cancellation rejects payload substitution')
  await db.query("update public.pos_staff set role='cashier',branch_id=$1 where user_id=$2", [f.branch, f.actor])
  check((await list(f)).actorRole, 'cashier', 'cashier may read branch configuration')
  await reject(apply(f, station(f, 6)), /POS_MANAGER_REQUIRED/, 'cashier cannot configure stations')
  check((await resolve(f, station(f, 6, { name: 'Demoted pending' }))).status, 'cancelled', 'demoted original actor may cancel an unsaved request')
  await db.query('update public.pos_staff set active=false where user_id=$1', [f.actor])
  check(await resolve(f, initial), { ...saved, replayed: true }, 'inactive original actor recovers exact result without config access')
  await reject(list(f), /POS_ACCESS_DENIED|POS_STAFF_INACTIVE/, 'inactive actor cannot read configuration')
  await reject(resolve(f, station(f, 6)), /POS_ACCESS_DENIED|POS_STAFF_INACTIVE/, 'inactive actor cannot create cancellation')
  await db.query("update public.pos_staff set active=true,role='owner',branch_id=null where user_id=$1", [f.actor])
  const replacement = { ...f, device: uid(), binding: hash(uid()) }
  await db.query('insert into public.pos_devices(id,organization_id,branch_id,name) values($1,$2,$3,$4)', [replacement.device, f.org, f.branch, 'Replacement'])
  await db.query('insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)', [replacement.binding, f.actor, f.org, f.branch, replacement.device])
  await db.query('update public.pos_device_bindings set revoked_at=now() where token_hash=$1', [f.binding])
  check(await resolve(replacement, initial), { ...saved, replayed: true }, 'active replacement binding recovers exact original-device payload')
  check(await resolve(f, initial), { ...saved, replayed: true }, 'revoked original historical binding recovers committed result')
  await db.query('update public.pos_staff set active=false where user_id=$1', [f.actor])
  await reject(resolve(replacement, initial), /POS_ACCESS_DENIED/, 'inactive actor cannot use replacement binding for recovery')
  check(await resolve(f, initial), { ...saved, replayed: true }, 'inactive actor retains only exact original historical binding recovery')
  await db.query('update public.pos_staff set active=true where user_id=$1', [f.actor])
  await reject(resolve(f, station(f, 6)), /POS_DEVICE_INVALID/, 'revoked binding cannot create new cancellation')
  await reject(resolve(replacement, { ...initial, deviceId: replacement.device }), /POS_IDEMPOTENCY_CONFLICT/, 'replacement cannot rewrite original device identity')
  await reject(resolve(foreign, initial), /POS_ACCESS_DENIED|POS_DEVICE_INVALID|POS_IDEMPOTENCY_CONFLICT/, 'other actor cannot recover original request')
  await db.query('update public.pos_device_bindings set revoked_at=null where token_hash=$1', [f.binding])

  const sibling = { ...f, branch: uid(), device: uid(), product: uid(), binding: hash(uid()) }
  await db.query("insert into public.pos_branches(id,organization_id,name) values($1,$2,'Sibling branch')", [sibling.branch, f.org])
  await db.query("insert into public.pos_devices(id,organization_id,branch_id,name) values($1,$2,$3,'Sibling counter')", [sibling.device, f.org, sibling.branch])
  await db.query('insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)', [sibling.binding, f.actor, f.org, sibling.branch, sibling.device])
  await db.query("insert into public.pos_products(id,organization_id,branch_id,name,category,unit_price_fils,tax_rate_bps) values($1,$2,$3,'Sibling product','Test',1000,500)", [sibling.product, f.org, sibling.branch])
  check((await list(sibling)).revision, 0, 'organization owner can read another branch with its own binding')
  await db.query("update public.pos_staff set role='manager',branch_id=$1 where user_id=$2", [f.branch, f.actor])
  await reject(list(sibling), /POS_ACCESS_DENIED/, 'branch-scoped manager cannot read sibling branch even with old binding')
  await reject(apply(sibling, station(sibling, 0)), /POS_ACCESS_DENIED/, 'branch-scoped manager cannot mutate sibling configuration')
  await reject(apply(f, route(f, 6, renamed.station.id, sibling.product)), /POS_STATION_PRODUCT_INVALID/, 'same-organization foreign-branch product rejected')
  await db.query("update public.pos_staff set role='owner',branch_id=null where user_id=$1", [f.actor])

  // Multiple real backend sessions prove serialization rather than Promise timing alone.
  const first = station(f, 6, { name: 'Drinks' }), other = station(f, 6, { name: 'Packing' })
  let result = await race('station_revision', f, c => userRpc(c, 'pos_execute_kitchen_station_command', first, f.binding), c => userRpc(c, 'pos_execute_kitchen_station_command', other, f.binding))
  check(result.error, 'POS_STATION_CONFLICT', 'competing revision produces one mutation')
  const pending = station(f, 7, { name: 'Cold kitchen' })
  result = await race('station_cancel_wins', f, c => userRpc(c, 'pos_resolve_kitchen_station_request', pending, f.binding), c => userRpc(c, 'pos_execute_kitchen_station_command', pending, f.binding))
  check(result.error, 'POS_REQUEST_CANCELLED', 'concurrent cancellation defeats delayed execution')
  const winning = station(f, 7, { name: 'Bakery' })
  result = await race('station_write_wins', f, c => userRpc(c, 'pos_execute_kitchen_station_command', winning, f.binding), c => userRpc(c, 'pos_resolve_kitchen_station_request', winning, f.binding))
  check(result.value.replayed, true, 'concurrent recovery returns committed result')
  const assigning = route(f, 8, renamed.station.id), archiving = station(f, 8, { id: renamed.station.id, name: 'Grill', active: false })
  result = await race('station_route_archive', f, c => userRpc(c, 'pos_execute_kitchen_station_command', assigning, f.binding), c => userRpc(c, 'pos_execute_kitchen_station_command', archiving, f.binding))
  check(result.error, 'POS_STATION_CONFLICT', 'route/archive serialized by branch revision')
  await reject(apply(f, { ...archiving, id: uid(), expectedRevision: 9 }), /POS_STATION_ASSIGNED/, 'archive retry sees committed assignment')
  result = await race('station_device_revocation', f, c => c.query('update public.pos_devices set active=false where id=$1', [f.device]).then(() => 'device disabled'), c => userRpc(c, 'pos_execute_kitchen_station_command', station(f, 9, { name: 'Must not save' }), f.binding))
  check(result.error, 'POS_DEVICE_INVALID', 'waiting mutation observes device revocation')
  await db.query('update public.pos_devices set active=true where id=$1', [f.device])
  result = await race('station_binding_revocation', f, c => c.query('update public.pos_device_bindings set revoked_at=now() where token_hash=$1', [f.binding]).then(() => 'binding revoked'), c => userRpc(c, 'pos_execute_kitchen_station_command', station(f, 9, { name: 'Must not save' }), f.binding))
  check(result.error, 'POS_DEVICE_INVALID', 'waiting mutation observes binding revocation')
  await db.query('update public.pos_device_bindings set revoked_at=null where token_hash=$1', [f.binding])

  result = await race('station_staff_revocation', f, async c => {
    await c.query('select pg_advisory_xact_lock(hashtextextended($1,15))', [f.org + ':' + f.actor])
    await c.query('update public.pos_staff set active=false where user_id=$1', [f.actor])
    return 'staff disabled'
  }, c => userRpc(c, 'pos_execute_kitchen_station_command', station(f, 9, { name: 'Must not save' }), f.binding))
  check(/POS_ACCESS_DENIED|POS_STAFF_INACTIVE/.test(result.error), true, 'waiting mutation observes staff revocation')
  await db.query('update public.pos_staff set active=true where user_id=$1', [f.actor])
  result = await race('station_branch_revocation', f, c => c.query('update public.pos_branches set active=false where id=$1', [f.branch]).then(() => 'branch disabled'), c => userRpc(c, 'pos_execute_kitchen_station_command', station(f, 9, { name: 'Must not save' }), f.binding))
  check(result.error, 'POS_ACCESS_DENIED', 'waiting mutation observes branch revocation')
  await db.query('update public.pos_branches set active=true where id=$1', [f.branch])

  const configTables = ['pos_kitchen_station_config', 'pos_kitchen_stations', 'pos_kitchen_product_routes', 'pos_kitchen_station_commands', 'pos_audit_events']
  const configuration = async () => Object.fromEntries(await Promise.all(configTables.map(async table => [table, await scalar(`select md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) from public.${table} t`)])))
  const beforeFailure = await configuration()
  await db.query("create function public.synthetic_station_audit_failure() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_AUDIT_FAILURE';end $$;create trigger synthetic_station_audit_failure before insert on public.pos_audit_events for each row execute function public.synthetic_station_audit_failure()")
  await reject(apply(f, station(f, 9, { name: 'Atomic failure' })), /SYNTHETIC_AUDIT_FAILURE/, 'audit failure rejects whole configuration command')
  check(await configuration(), beforeFailure, 'audit failure leaves no configuration revision route command or audit residue')
  await db.query('drop trigger synthetic_station_audit_failure on public.pos_audit_events;drop function public.synthetic_station_audit_failure()')
  for (const table of configTables.filter(x => x !== 'pos_audit_events')) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await db.query('set role ' + role)
      try { await reject(db.query('select * from public.' + table), /permission denied/, role + ' cannot directly read ' + table) } finally { await db.query('reset role') }
    }
    check(await scalar('select relrowsecurity from pg_class where oid=$1::regclass', ['public.' + table]), true, table + ' enables RLS')
  }
  await reject(db.query("update public.pos_kitchen_station_commands set payload=payload||'{\"changed\":true}'::jsonb where id=$1", [initial.id]), /POS_IMMUTABLE_DOCUMENT|POS_STATION_IMMUTABLE/, 'committed station command payload immutable')
  await reject(db.query('delete from public.pos_kitchen_station_commands where id=$1', [cancelled.id]), /POS_IMMUTABLE_DOCUMENT|POS_STATION_IMMUTABLE/, 'cancelled request cannot be deleted')
  const helpers = (await db.query("select oid::regprocedure::text as name,prosecdef,proconfig from pg_proc where pronamespace='public'::regnamespace and proname like 'pos_station_%'")).rows
  check(helpers.length > 5, true, 'private station helpers enumerated')
  for (const helper of helpers) {
    for (const role of ['anon', 'authenticated', 'service_role'])
      check(await scalar('select has_function_privilege($1,$2,\'EXECUTE\')', [role, helper.name]), false, role + ' cannot invoke private helper ' + helper.name)
    check(helper.proconfig?.some(setting => setting.startsWith('search_path=') && ['search_path=', 'search_path=""'].includes(setting)), true, helper.name + ' fixed empty search path')
  }

  const limits = await fixture()
  for (let i = 0; i < 128; i++) await apply(limits, station(limits, i, { name: 'Station ' + i }))
  await reject(apply(limits, station(limits, 128, { name: 'One too many' })), /POS_STATION_CAPACITY/, 'station cap includes all 128 records')
  const firstLimit = (await list(limits)).stations[0]
  await apply(limits, station(limits, 128, { id: firstLimit.id, name: firstLimit.name, active: false }))
  await reject(apply(limits, station(limits, 129, { name: 'Archive does not free identity' })), /POS_STATION_CAPACITY/, 'archived identities remain in capacity bound')
  const exhaustion = await fixture(), exhaustionSaved = await apply(exhaustion, station(exhaustion, 0))
  await db.query('update public.pos_kitchen_station_config set revision=2147483646 where branch_id=$1', [exhaustion.branch])
  const last = await apply(exhaustion, station(exhaustion, 2147483646, { id: exhaustionSaved.station.id, name: 'Last revision', active: true }))
  check(last.revision, 2147483647, 'final representable revision allowed without overflow')
  await reject(apply(exhaustion, station(exhaustion, 2147483647)), /POS_STATION_INVALID/, 'revision exhaustion rejects further command')

  const pageFixture = await fixture(), pageStation = (await apply(pageFixture, station(pageFixture, 0))).station
  const products = (await db.query("insert into public.pos_products(id,organization_id,branch_id,name,category,unit_price_fils,tax_rate_bps) select gen_random_uuid(),$1,$2,'Synthetic pagination '||s,'Test',1000,500 from generate_series(1,104) s returning id", [pageFixture.org, pageFixture.branch])).rows.map(r => r.id)
  products.push(pageFixture.product)
  let revision = 1
  for (const product of products) await apply(pageFixture, route(pageFixture, revision++, pageStation.id, product))
  const page1 = await list(pageFixture), page2 = await list(pageFixture, page1.nextProductId)
  check([page1.routes.length, page1.routeCount, page2.routes.length, page2.routeCount, page2.nextProductId], [100, 105, 5, 105, null], 'bounded pagination with complete route count')
  check(new Set([...page1.routes, ...page2.routes].map(r => r.productId)).size, 105, 'pagination contains every route exactly once')
  check(page1.revision, page2.revision, 'unchanged pages share config revision')
  await apply(pageFixture, route(pageFixture, revision++, null, products[0]))
  check((await list(pageFixture, page1.nextProductId)).revision > page1.revision, true, 'changed configuration invalidates assembled page revision')
  report.sampleList = page1; report.sampleResult = saved; report.sampleCommand = initial
  await save()
}

try {
  await control.connect()
  assert.equal(await scalar('select inet_server_addr() is null', [], control), true)
  await control.query(`create database ${database}`); created = true
  await db.connect(); connected = true
  for (const role of ['anon', 'authenticated', 'service_role']) if (!await scalar('select exists(select 1 from pg_roles where rolname=$1)', [role])) await db.query(`create role ${role}`)
  await db.query("create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;")
  const directory = new URL('../../supabase/migrations/', import.meta.url)
  for (const name of (await readdir(directory)).filter(n => /^20261016/.test(n) && !n.includes('007') && !n.includes('009') && n < '202610160032').sort()) {
    const sql = await readFile(new URL(name, directory), 'utf8'); report.migrationHashes[name] = hash(sql); await db.query(sql)
  }
  schemas = await import('../../lib/pos/server/kitchen-stations.ts')
  await scenarios()
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, where: error.where, stack: error.stack }
  process.exitCode = 1
} finally {
  if (connected) await db.end()
  if (created) { await control.query(`drop database ${database}`); report.cleanup = 'owned database dropped' }
  await control.end(); report.finishedAt = new Date().toISOString(); await save()
}
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, races: report.races.length, cleanup: report.cleanup, error: report.error?.message }))
