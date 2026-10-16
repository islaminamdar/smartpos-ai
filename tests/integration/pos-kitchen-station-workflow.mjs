// Isolated PostgreSQL acceptance for the complete station workflow. No hosted traffic.
// node --experimental-strip-types tests/integration/pos-kitchen-station-workflow.mjs <pg-entry> <owned-socket> <private-report>
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { userInfo } from 'node:os'
import assert from 'node:assert/strict'
import { stationWorkListSchema, stationWorkDetailSchema, stationWorkRecoverySchema, stationWorkCommandSchema, stationWorkResultMatches, stationWorkListMatchesQuery, stationWorkDetailMatchesQuery } from '../../lib/pos/server/kitchen-station-work.ts'

const [entry, socket, reportPath] = process.argv.slice(2)
assert.ok(entry?.startsWith('/') && reportPath?.startsWith('/'))
assert.ok(/^\/tmp\/pos-qa-pg-station-workflow-[a-f0-9]+$/.test(socket))
const pg = await import(pathToFileURL(entry).href)
const Client = pg.Client ?? pg.default.Client
const options = { host: socket, port: 55432, user: userInfo().username, connectionTimeoutMillis: 5000 }
const database = 'pos_qa_station_workflow_' + randomUUID().replaceAll('-', '')
const control = new Client({ ...options, database: 'postgres' })
const db = new Client({ ...options, database })
const report = { status: 'pending', database, productionTouched: false, startedAt: new Date().toISOString(), checks: [], races: [], migrationHashes: {}, fixtures: {}, contractOutputs: [], cleanup: 'pending' }
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); report.checks.push(label) }
const reject = async (operation, pattern, label) => { await assert.rejects(operation, pattern); report.checks.push(label) }
const id = randomUUID
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])) : value)
// SQL custody fixture only; signature authentication is covered by the separate native/server suite.
const envelope = (payload, keyId = 'synthetic-server') => ({ format: 'pos-signed-v1', alg: 'ECDSA-P256-SHA256-DER', keyId, payloadBase64Url: Buffer.from(canonical(payload)).toString('base64url'), signatureBase64Url: 'MAgCAQICAQE' })
const eh = e => hash(Buffer.from(e.payloadBase64Url, 'base64url'))
async function service(name, ...args) { await db.query('set role service_role'); try { return await rpc(db, name, ...args) } finally { await db.query('reset role') } }
const hash = value => createHash('sha256').update(value).digest('hex')
const scalar = async (connection, sql, values = []) => Object.values((await connection.query(sql, values)).rows[0])[0]
const rpc = (connection, name, ...args) => {
  assert.match(name, /^pos_[a-z_]+$/)
  return scalar(connection, `select public.${name}(${args.map((_, n) => '$' + (n + 1)).join(',')})`, args.map(value => value !== null && typeof value === 'object' ? JSON.stringify(value) : value))
}
async function auth(connection, f, name, ...args) {
  await connection.query("select set_config('app.user_id',$1,false)", [f.actor])
  await connection.query('set role authenticated')
  try { return await rpc(connection, name, ...args) } finally { await connection.query('reset role') }
}
const call = (f, name, ...args) => auth(db, f, name, ...args)
const command = (f, fields) => ({ id: id(), branchId: f.branch, deviceId: f.device, ...fields })
async function workList(f, query = {}) {
  const q = { station: 'all', view: 'active', cursor: null, ...query }
  const result = stationWorkListSchema.parse(await call(f, 'pos_list_kitchen_station_work', f.branch, f.device, f.binding, q))
  assert.ok(stationWorkListMatchesQuery({ branchId: f.branch, deviceId: f.device, station: q.station, view: q.view, cursorAt: q.cursor?.at, cursorId: q.cursor?.id }, result), 'SQL list matches production query contract')
  report.contractOutputs.push({ kind: 'list', query: q, result })
  return result
}
async function detail(f, workId, query = {}) {
  const q = { noticeView: 'pending', afterSequence: 0, ...query }
  const result = stationWorkDetailSchema.parse(await call(f, 'pos_get_kitchen_station_work', f.branch, f.device, f.binding, workId, q))
  assert.ok(stationWorkDetailMatchesQuery({ branchId: f.branch, deviceId: f.device, workId, ...q }, result), 'SQL detail matches production query contract')
  report.contractOutputs.push({ kind: 'detail', query: q, result })
  return result
}
async function action(f, c, name) {
  stationWorkCommandSchema.parse(c)
  const result = stationWorkRecoverySchema.parse(await call(f, name, c, f.binding))
  assert.ok(stationWorkResultMatches(c, result), 'SQL acknowledgement matches exact production command')
  report.contractOutputs.push({ kind: 'recovery', command: c, result })
  return result
}
const execute = (f, c) => action(f, c, 'pos_execute_kitchen_station_work_command')
const recover = (f, c) => action(f, c, 'pos_resolve_kitchen_station_work_request')
const stageCommand = (f, work, from, to, reason = null) => command(f, { type: 'stage', workId: work.id, expectedRevision: work.revision, from, to, reason })
const noticeCommand = (f, work, noticeId) => command(f, { type: 'notice.ack', workId: work.id, expectedRevision: work.revision, noticeId })
const line = (productId, quantityMilli = 1000) => ({ productId, quantityMilli, expectedUnitPriceFils: 1000, expectedTaxRateBps: 500, expectedRevision: 1 })
const sale = (f, lines = [line(f.food), line(f.drink), line(f.general)], extra = {}) => {
  const total = lines.reduce((sum, item) => sum + item.quantityMilli, 0)
  return command(f, { shiftId: f.shift, createdAt: new Date().toISOString(), serviceType: 'takeaway', profileId: f.profile, customer: null, cashTenderedFils: total, payments: [{ method: 'cash', amountFils: total }], expectedTotalFils: total, lines, ...extra })
}
const pay = (f, value) => call(f, 'pos_record_live_order', value, f.binding)
const tabSave = (f, lines, extra = {}) => command(f, { type: 'tab.save', tabId: id(), expectedRevision: 0, label: 'Synthetic station order', serviceType: 'dine_in', tableId: null, guestCount: 2, note: 'Synthetic preparation note', lines, ...extra })
const saveTab = (f, value) => call(f, 'pos_execute_tab_command', value, f.binding)
const tabDetail = (f, tabId) => call(f, 'pos_get_tab_kitchen_for_tab', f.branch, tabId, f.binding)
const dispatchCommand = (f, tabId, tabRevision, ticketRevision = 0, reason = null) => command(f, { type: 'dispatch', tabId, expectedTabRevision: tabRevision, expectedTicketRevision: ticketRevision, reason })
const dispatch = (f, value) => call(f, 'pos_execute_tab_kitchen_command', value, f.binding)
const ownWork = async (f, { orderId, tabId, view = 'active' }) => (await workList(f, { view })).items.filter(work => orderId ? work.orderId === orderId : work.tabId === tabId)
async function ackAll(f, workId) {
  for (let attempts = 0; attempts < 1000; attempts++) {
    const current = await detail(f, workId)
    if (current.notices.length === 0) { check(current.work.pendingNoticeCount, 0, 'notice drain agrees with work pending count'); return current.work }
    await execute(f, noticeCommand(f, current.work, current.notices[0].id))
  }
  throw new Error('Notice drain did not terminate')
}
async function returnCommand(f, orderId, invoiceId, revision, lines) {
  const request = { branchId: f.branch, deviceId: f.device, shiftId: f.shift, orderId, invoiceId, expectedRevision: revision, lines, reason: 'Synthetic returned items' }
  const preview = await call(f, 'pos_preview_return', request, f.binding)
  return command(f, { type: 'refund.items', ...request, quoteHash: preview.quoteHash })
}
const refund = (f, value) => call(f, 'pos_execute_live_command', value, f.binding)

async function fixture() {
  const f = Object.fromEntries(['actor', 'org', 'branch', 'device', 'shift', 'profile', 'food', 'drink', 'general', 'weight'].map(key => [key, id()]))
  f.binding = hash(id())
  await db.query('insert into auth.users values($1,$2,now())', [f.actor, id() + '@example.test'])
  await db.query("insert into public.pos_organizations(id,legal_name) values($1,'Synthetic station workflow')", [f.org])
  await db.query("insert into public.pos_branches(id,organization_id,name) values($1,$2,'Synthetic station branch')", [f.branch, f.org])
  await db.query("insert into public.pos_staff(organization_id,user_id,role) values($1,$2,'owner')", [f.org, f.actor])
  await db.query("insert into public.pos_devices(id,organization_id,branch_id,name) values($1,$2,$3,'Synthetic station counter')", [f.device, f.org, f.branch])
  await db.query('insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values($1,$2,$3,$4,$5)', [f.binding, f.actor, f.org, f.branch, f.device])
  await db.query('insert into public.pos_shifts(id,organization_id,branch_id,device_id,opened_by,opening_cash_fils) values($1,$2,$3,$4,$5,100000)', [f.shift, f.org, f.branch, f.device, f.actor])
  await db.query("insert into public.pos_merchant_profiles(id,organization_id,branch_id,legal_name,branch_name,address,phone,trn,tax_registered,tax_inclusive,confirmed_by) values($1,$2,$3,'Synthetic merchant','Synthetic branch','Synthetic address','Synthetic phone','100000000000001',true,true,$4)", [f.profile, f.org, f.branch, f.actor])
  await db.query("insert into public.pos_branch_receipt_config values($1,$2,$3,'STATIONTEST',true)", [f.branch, f.org, f.profile])
  for (const [kind, name] of [['food', 'Synthetic hot food'], ['drink', 'Synthetic cold drink'], ['general', 'Synthetic general item'], ['weight', 'Synthetic weighed food']])
    await db.query("insert into public.pos_products(id,organization_id,branch_id,name,category,unit,unit_price_fils,tax_rate_bps) values($1,$2,$3,$4,'Synthetic',$5,1000,500)", [f[kind], f.org, f.branch, name, kind === 'weight' ? 'kg' : 'piece'])
  f.configRevision = 0
  for (const [key, name] of [['grill', 'Grill'], ['drinks', 'Drinks']]) {
    f[key] = id()
    await call(f, 'pos_execute_kitchen_station_command', command(f, { expectedRevision: f.configRevision++, type: 'station.save', station: { id: f[key], name, active: true } }), f.binding)
  }
  for (const [productId, stationId] of [[f.food, f.grill], [f.drink, f.drinks], [f.weight, f.grill]])
    await call(f, 'pos_execute_kitchen_station_command', command(f, { expectedRevision: f.configRevision++, type: 'route.set', productId, stationId }), f.binding)
  return f
}
async function enable(f, enabled = true) {
  await db.query('insert into public.pos_kitchen_station_policy(organization_id,branch_id,enabled) values($1,$2,$3) on conflict(branch_id) do update set enabled=excluded.enabled', [f.org, f.branch, enabled])
}
async function actualRace(label, f, first, second) {
  const a = new Client({ ...options, database, application_name: label + '_a' })
  const b = new Client({ ...options, database, application_name: label + '_b' })
  await a.connect(); await b.connect()
  let pending
  try {
    for (const c of [a, b]) {
      await c.query('begin')
      await c.query("set local statement_timeout='10s'")
      await c.query("select set_config('app.user_id',$1,true)", [f.actor])
    }
    const firstResult = await first(a)
    let done = false
    pending = second(b).then(value => ({ value }), error => ({ error: error.message, code: error.code })).finally(() => { done = true })
    let observed = null
    for (let tries = 0; tries < 150 && !done; tries++) {
      const row = (await control.query('select wait_event_type,cardinality(pg_blocking_pids(pid)) as blockers from pg_stat_activity where datname=$1 and application_name=$2', [database, label + '_b'])).rows[0]
      if (row?.wait_event_type === 'Lock' && row.blockers > 0) { observed = row; break }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await a.query('commit')
    const outcome = await pending
    await b.query(outcome.error ? 'rollback' : 'commit')
    check(Boolean(observed), true, label + ': observed real backend lock wait')
    assert.notEqual(outcome.code, '40P01', label + ': deadlock')
    assert.notEqual(outcome.code, '57014', label + ': timeout')
    report.races.push({ label, observed, firstResult, outcome }); await save()
    return outcome
  } finally {
    await a.query('rollback').catch(() => {}); await b.query('rollback').catch(() => {})
    await Promise.allSettled([a.end(), b.end()])
  }
}
const userRpc = async (connection, name, ...args) => { await connection.query('set local role authenticated'); return rpc(connection, name, ...args) }

async function scenarios(f, legacyOrder, legacyStage, legacyAck) {
  check(await call(f, 'pos_transition_kitchen', legacyStage, f.binding), { ...legacyAck, replayed: true }, 'pre-upgrade paid request replays original immutable acknowledgement')
  check(await call(f, 'pos_resolve_kitchen_request', legacyStage, f.binding), { ...legacyAck, replayed: true }, 'pre-upgrade paid recovery remains exact')
  check((await workList(f)).items, [], 'default-off admission creates no routed work')
  await enable(f)
  check((await workList(f)).items, [], 'enabling admission does not backfill existing preparation')
  const order = sale(f, [line(f.food, 3000), line(f.drink, 2000), line(f.general)])
  const paid = await pay(f, order)
  let works = await ownWork(f, { orderId: order.id })
  check(works.length, 3, 'paid mixed order creates Grill Drinks and General work')
  check(works.map(work => work.stationName).sort(), ['Drinks', 'General', 'Grill'], 'server snapshots actual station identity and General fallback')
  let grill = works.find(work => work.stationId === f.grill), drinks = works.find(work => work.stationId === f.drinks)
  const general = works.find(work => work.stationId === null)
  check(general.stages.queued[0].productId, f.general, 'General contains only its product')
  for (const work of works) await ackAll(f, work.id)
  grill = (await detail(f, grill.id)).work; drinks = (await detail(f, drinks.id)).work
  const moving = stageCommand(f, grill, 'queued', 'preparing')
  const moved = await execute(f, moving)
  check((await detail(f, drinks.id)).work, drinks, 'Grill advancement leaves Drinks work entirely unchanged')
  check(await execute(f, moving), { ...moved, replayed: true }, 'station stage exact replay retains original snapshot')
  check(await recover(f, moving), { ...moved, replayed: true }, 'station recovery does not fetch newer state')
  const paidList = await call(f, 'pos_list_kitchen', f.branch, f.binding, null)
  check(paidList.activeTickets.some(ticket => ticket.orderId === order.id), false, 'legacy paid pages exclude routed root before pagination')
  check(paidList.activeTickets.some(ticket => ticket.orderId === legacyOrder.id), true, 'legacy preparation remains visible')
  await reject(call(f, 'pos_transition_kitchen', command(f, { orderId: order.id, expectedRevision: 1, status: 'preparing', reason: null }), f.binding), /POS_KITCHEN_STATION_REQUIRED/, 'legacy whole-order stage cannot bypass routed work')
  const pending = stageCommand(f, drinks, 'queued', 'preparing')
  const cancelled = await recover(f, pending)
  check(cancelled.status, 'cancelled', 'unsent station request is permanently cancelled')
  await reject(execute(f, pending), /POS_REQUEST_CANCELLED/, 'late station request cannot defeat cancellation')
  await reject(recover(f, { ...moving, expectedRevision: moving.expectedRevision + 1 }), /POS_IDEMPOTENCY_CONFLICT/, 'recovery cannot adopt modified original payload')
  const returns = await returnCommand(f, order.id, paid.receipt.id, 0, [{ lineNumber: 1, quantityMilli: 1000 }])
  const beforeReturn = (await detail(f, grill.id)).work
  const credit = await refund(f, returns)
  const returned = await detail(f, grill.id)
  check(returned.work.stages, beforeReturn.stages, 'partial credit preserves preparation quantities and stages')
  check(returned.notices.filter(notice => notice.kind === 'return').length, 1, 'partial credit creates exactly one target station obligation')
  check((await detail(f, drinks.id)).work.pendingNoticeCount, 0, 'unaffected station has no returned-line obligation')
  await reject(execute(f, stageCommand(f, returned.work, 'preparing', 'ready')), /POS_.*PENDING|POS_.*NOTICE/, 'target station cannot advance before return acknowledgement')
  await reject(call(f, 'pos_acknowledge_kitchen_return', f.branch, f.device, credit.creditNote.id, f.binding), /POS_KITCHEN_STATION_REQUIRED/, 'legacy credit acknowledgement cannot dismiss routed obligation')
  await execute(f, stageCommand(f, (await detail(f, drinks.id)).work, 'queued', 'preparing'))
  report.fixtures.paidWork = returned.work; report.fixtures.returnDetail = returned
  await ackAll(f, grill.id)
  await enable(f, false)
  check((await detail(f, grill.id)).work.id, grill.id, 'disabling admission retains existing routed reader')
  await execute(f, stageCommand(f, (await detail(f, grill.id)).work, 'preparing', 'ready'))
  await enable(f)
  await unpaidScenarios(f)
  await raceScenarios(f)
  await refundRaces()
  await routingSnapshotRace()
  await finalReturnScenarios()
  await lifecycleScenarios()
  await authorityScenarios()
  await paginationScenarios()
  await offlineExclusion()
  await admissionAndUnicodeScenarios()
}

async function unpaidScenarios(f) {
  const draft = tabSave(f, [line(f.food, 8000), line(f.drink, 2000), line(f.weight, 1500)])
  await saveTab(f, draft)
  const first = await dispatch(f, dispatchCommand(f, draft.tabId, 1))
  let works = await ownWork(f, { tabId: draft.tabId })
  check(works.length, 2, 'unpaid mixed order creates two station works')
  const grillId = works.find(work => work.stationId === f.grill).id
  for (const work of works) await ackAll(f, work.id)
  for (const [from, to] of [['queued', 'preparing'], ['preparing', 'ready'], ['ready', 'served']]) await execute(f, stageCommand(f, (await detail(f, grillId)).work, from, to))
  await saveTab(f, { ...draft, id: id(), expectedRevision: 1, lines: [line(f.food, 10000), line(f.drink, 2000), line(f.weight, 1500)] })
  let ticket = (await tabDetail(f, draft.tabId)).ticket
  await dispatch(f, dispatchCommand(f, draft.tabId, 2, ticket.revision))
  let grill = (await detail(f, grillId)).work
  check(grill.stages.served.find(item => item.productId === f.food).quantityMilli, 8000, 'station addition preserves served eight')
  check(grill.stages.queued.find(item => item.productId === f.food).quantityMilli, 2000, 'station addition queues only additional two')
  await ackAll(f, grillId)
  // Removing all of a product retains its immutable generation route for re-addition.
  await saveTab(f, { ...draft, id: id(), expectedRevision: 2, lines: [line(f.drink, 2000), line(f.weight, 1250)] })
  ticket = (await tabDetail(f, draft.tabId)).ticket
  await dispatch(f, dispatchCommand(f, draft.tabId, 3, ticket.revision, 'Synthetic withdrawal'))
  const withdrawal = await detail(f, grillId)
  check(withdrawal.notices.at(-1).detail.withdrawals.some(item => item.productId === f.weight && item.quantityMilli === 250), true, 'weighed withdrawal stays exact at 250 milli-units')
  await call(f, 'pos_execute_kitchen_station_command', command(f, { expectedRevision: f.configRevision++, type: 'route.set', productId: f.food, stationId: f.drinks }), f.binding)
  await saveTab(f, { ...draft, id: id(), expectedRevision: 3, lines: [line(f.food), line(f.drink, 2000), line(f.weight, 1250)] })
  ticket = (await tabDetail(f, draft.tabId)).ticket
  await dispatch(f, dispatchCommand(f, draft.tabId, 4, ticket.revision))
  grill = (await detail(f, grillId)).work
  check(grill.stages.queued.some(item => item.productId === f.food && item.quantityMilli === 1000), true, 'same-generation re-add uses original Grill ownership after reconfiguration')
  works = await ownWork(f, { tabId: draft.tabId })
  for (const work of works) await ackAll(f, work.id)
  const beforePayment = works.map(work => ({ id: work.id, stages: work.stages }))
  const order = sale(f, [line(f.food), line(f.drink, 2000), line(f.weight, 1250)], { serviceType: 'dine_in', sourceTab: { id: draft.tabId, expectedRevision: 4 } })
  const paid = await pay(f, order)
  const afterPayment = await ownWork(f, { tabId: draft.tabId })
  check(afterPayment.map(work => ({ id: work.id, stages: work.stages })), beforePayment, 'payment retains work identities and preparation quantities')
  check(afterPayment.every(work => work.family === 'tab' && work.payment === 'paid' && work.invoiceId === paid.receipt.id), true, 'payment promotes existing tab work and invoice links')
  check(await scalar(db, 'select count(*)::int from public.pos_kitchen_tickets where order_id=$1', [order.id]), 0, 'payment creates no duplicate paid kitchen ticket')
  await reject(call(f, 'pos_execute_tab_kitchen_command', command(f, { type: 'stage', ticketId: first.ticket.id, expectedRevision: (await call(f, 'pos_get_tab_kitchen', f.branch, first.ticket.id, f.binding, null)).ticket.revision, from: 'queued', to: 'preparing', reason: null }), f.binding), /POS_KITCHEN_STATION_REQUIRED/, 'legacy unpaid stage cannot move all routed station batches')
  report.fixtures.promotedWork = afterPayment
}

async function raceScenarios(f) {
  // Separate fixtures avoid confusing a revision conflict with a financial notice guard.
  const order = sale(f, [line(f.drink, 3000)])
  const paid = await pay(f, order)
  let work = (await ownWork(f, { orderId: order.id }))[0]
  work = await ackAll(f, work.id)
  const returning = await returnCommand(f, order.id, paid.receipt.id, 0, [{ lineNumber: 1, quantityMilli: 1000 }])
  const advancing = stageCommand(f, { ...work, revision: work.revision + 1 }, 'queued', 'preparing')
  let outcome = await actualRace('station_stage_return', f, c => userRpc(c, 'pos_execute_live_command', returning, f.binding), c => userRpc(c, 'pos_execute_kitchen_station_work_command', advancing, f.binding))
  check(Boolean(outcome.error), true, 'stage sees committed return and cannot advance while target notice pending')
  const d = await detail(f, work.id)
  const ack = noticeCommand(f, d.work, d.notices[0].id)
  const next = stageCommand(f, { ...d.work, revision: d.work.revision + 1 }, 'queued', 'preparing')
  outcome = await actualRace('station_ack_stage', f, c => userRpc(c, 'pos_execute_kitchen_station_work_command', ack, f.binding), c => userRpc(c, 'pos_execute_kitchen_station_work_command', next, f.binding))
  check(outcome.value?.status, 'updated', 'stage sees committed scoped acknowledgement')
  work = (await detail(f, work.id)).work
  const cancelled = stageCommand(f, work, 'preparing', 'ready')
  outcome = await actualRace('station_cancel_write', f, c => userRpc(c, 'pos_resolve_kitchen_station_work_request', cancelled, f.binding), c => userRpc(c, 'pos_execute_kitchen_station_work_command', cancelled, f.binding))
  check(outcome.error, 'POS_REQUEST_CANCELLED', 'recovery cancellation prevents concurrent delayed station write')
  const winning = stageCommand(f, work, 'preparing', 'ready')
  outcome = await actualRace('station_write_recover', f, c => userRpc(c, 'pos_execute_kitchen_station_work_command', winning, f.binding), c => userRpc(c, 'pos_resolve_kitchen_station_work_request', winning, f.binding))
  check(outcome.value?.replayed, true, 'concurrent recovery returns exact committed station write')
  const dual = sale(f, [line(f.drink), line(f.general)]); await pay(f, dual)
  const twins = await ownWork(f, { orderId: dual.id })
  const left = stageCommand(f, twins[0], 'queued', 'preparing'), right = stageCommand(f, twins[1], 'queued', 'preparing')
  outcome = await actualRace('different_stations', f, c => userRpc(c, 'pos_execute_kitchen_station_work_command', left, f.binding), c => userRpc(c, 'pos_execute_kitchen_station_work_command', right, f.binding))
  check(outcome.value?.status, 'updated', 'different station command retains its own revision despite shared parent lock')
  const draft = tabSave(f, [line(f.drink, 2000)]); await saveTab(f, draft); await dispatch(f, dispatchCommand(f, draft.tabId, 1))
  let tabWork = (await ownWork(f, { tabId: draft.tabId }))[0]; tabWork = await ackAll(f, tabWork.id)
  const tabSale = sale(f, draft.lines, { serviceType: 'dine_in', sourceTab: { id: draft.tabId, expectedRevision: 1 } })
  const tabMove = stageCommand(f, tabWork, 'queued', 'preparing')
  outcome = await actualRace('tab_stage_payment', f, c => userRpc(c, 'pos_execute_kitchen_station_work_command', tabMove, f.binding), c => userRpc(c, 'pos_record_live_order', tabSale, f.binding))
  check(Boolean(outcome.value?.receipt), true, 'payment after station stage preserves paid promotion without deadlock')
  check((await detail(f, tabWork.id)).work.stages.preparing[0].quantityMilli, 2000, 'concurrent payment does not reset preparation')
  const secondDraft = tabSave(f, [line(f.drink, 2000)]); await saveTab(f, secondDraft); await dispatch(f, dispatchCommand(f, secondDraft.tabId, 1))
  let secondWork = (await ownWork(f, { tabId: secondDraft.tabId }))[0]; secondWork = await ackAll(f, secondWork.id)
  await saveTab(f, { ...secondDraft, id: id(), expectedRevision: 1, lines: [line(f.drink)] })
  const ticket = (await tabDetail(f, secondDraft.tabId)).ticket
  const withdrawing = dispatchCommand(f, secondDraft.tabId, 2, ticket.revision, 'Synthetic withdrawal race')
  const staleStage = stageCommand(f, secondWork, 'queued', 'preparing')
  outcome = await actualRace('tab_withdrawal_stage', f, c => userRpc(c, 'pos_execute_tab_kitchen_command', withdrawing, f.binding), c => userRpc(c, 'pos_execute_kitchen_station_work_command', staleStage, f.binding))
  check(outcome.error, 'POS_STATION_WORK_CONFLICT', 'concurrent withdrawal makes previously prepared stage stale')
}

async function refundRaces() {
  const f = await fixture(); await enable(f)
  const draft = tabSave(f, [line(f.food, 3000)])
  await saveTab(f, draft); await dispatch(f, dispatchCommand(f, draft.tabId, 1))
  let w = (await ownWork(f, { tabId: draft.tabId }))[0]; w = await ackAll(f, w.id)
  const order = sale(f, draft.lines, { serviceType: 'dine_in', sourceTab: { id: draft.tabId, expectedRevision: 1 } })
  const paid = await pay(f, order); w = (await detail(f, w.id)).work
  const partial = await returnCommand(f, order.id, paid.receipt.id, 0, [{ lineNumber: 1, quantityMilli: 1000 }])
  const move = stageCommand(f, w, 'queued', 'preparing')
  let result = await actualRace('tab_stage_partial_return', f, c => userRpc(c, 'pos_execute_kitchen_station_work_command', move, f.binding), c => userRpc(c, 'pos_execute_live_command', partial, f.binding))
  check(Boolean(result.value?.creditNote), true, 'partial return following station stage completes without ticket-child cycle')
  let d = await detail(f, w.id)
  const ack = noticeCommand(f, d.work, d.notices[0].id)
  const second = await returnCommand(f, order.id, paid.receipt.id, 1, [{ lineNumber: 1, quantityMilli: 1000 }])
  result = await actualRace('station_ack_new_return_notice', f, c => userRpc(c, 'pos_execute_kitchen_station_work_command', ack, f.binding), c => userRpc(c, 'pos_execute_live_command', second, f.binding))
  check(Boolean(result.value?.creditNote), true, 'new return commits after scoped acknowledgement')
  d = await detail(f, w.id)
  check(d.work.pendingNoticeCount, 1, 'scoped acknowledgement never swallows concurrently added return notice')
  await ackAll(f, w.id); w = (await detail(f, w.id)).work
  const full = await returnCommand(f, order.id, paid.receipt.id, 2, [{ lineNumber: 1, quantityMilli: 1000 }])
  result = await actualRace('tab_full_return_station_stage', f, c => userRpc(c, 'pos_execute_live_command', full, f.binding), c => userRpc(c, 'pos_execute_kitchen_station_work_command', stageCommand(f, w, 'preparing', 'ready'), f.binding))
  check(result.error, 'POS_STATION_WORK_CONFLICT', 'full return invalidates concurrent stale tab station stage')
  check((await detail(f, w.id)).work.payment, 'refunded', 'full-return race ends with cancelled preparation and durable notice')
}

async function routingSnapshotRace() {
  const f = await fixture(); await enable(f)
  const draft = tabSave(f, [line(f.food), line(f.drink)])
  await saveTab(f, draft)
  const swapFood = command(f, { type: 'route.set', expectedRevision: f.configRevision++, productId: f.food, stationId: f.drinks })
  const swapDrink = command(f, { type: 'route.set', expectedRevision: f.configRevision++, productId: f.drink, stationId: f.grill })
  const outcome = await actualRace('configuration_dispatch_snapshot', f, async c => {
    // Independent fixture barrier makes dispatch pause after its captured routes.
    // Configuration itself takes compatible product SHARE locks and need not block dispatch.
    await c.query('select id from public.pos_products where id=$1 for update', [f.food])
    await userRpc(c, 'pos_execute_kitchen_station_command', swapFood, f.binding)
    return userRpc(c, 'pos_execute_kitchen_station_command', swapDrink, f.binding)
  }, c => userRpc(c, 'pos_execute_tab_kitchen_command', dispatchCommand(f, draft.tabId, 1), f.binding))
  check(Boolean(outcome.value?.ticket), true, 'configuration edit and dispatch serialize without configuration lock cycle')
  const works = await ownWork(f, { tabId: draft.tabId })
  check(works.find(w => w.stationId === f.grill).stages.queued.map(l => l.productId), [f.food], 'whole-dispatch snapshot keeps old food assignment across product-lock wait')
  check(works.find(w => w.stationId === f.drinks).stages.queued.map(l => l.productId), [f.drink], 'whole-dispatch snapshot keeps matching old drink assignment, never mixed revisions')
}

async function finalReturnScenarios() {
  const f = await fixture(); await enable(f)
  const order = sale(f, [line(f.food), line(f.drink)])
  const paid = await pay(f, order)
  const works = await ownWork(f, { orderId: order.id })
  const grill = works.find(w => w.stationId === f.grill), drinks = works.find(w => w.stationId === f.drinks)
  await refund(f, await returnCommand(f, order.id, paid.receipt.id, 0, [{ lineNumber: 1, quantityMilli: 1000 }]))
  await ackAll(f, grill.id)
  check((await detail(f, grill.id)).work.stages.queued.length, 1, 'first station acknowledged return retains preparation for human reconciliation')
  await refund(f, await returnCommand(f, order.id, paid.receipt.id, 1, [{ lineNumber: 2, quantityMilli: 1000 }]))
  const a = await detail(f, grill.id), b = await detail(f, drinks.id)
  check(a.work.state, 'cancelled', 'final return cancels first station preparation')
  check(a.work.pendingNoticeCount > 0, true, 'final return of other station still notifies cancelled first station')
  check(a.notices.some(n => n.kind === 'return' && n.detail.lines.some(l => l.productId === f.food)), false, 'final cancellation never fabricates newly returned food quantity')
  check(b.notices.filter(n => n.kind === 'return').length, 1, 'final credit has one actual returned-line notice at second station')
  report.fixtures.finalReturnOtherStation = { first: a, second: b }
}

async function importedSale(f){
 await db.query('insert into public.pos_offline_branch_policy(branch_id,enabled) values($1,true)',[f.branch])
 const bytes=Buffer.from('synthetic-import-key-'+id()),fingerprint=hash(bytes),requestId=id()
 const enrollment=await service('pos_offline_enroll',f.actor,{requestId,branchId:f.branch,deviceId:f.device,publicKeySpki:bytes.toString('base64url'),deviceKeySha256:fingerprint,proof:envelope({kind:'offline-enrollment',schemaVersion:1,requestId,branchId:f.branch,deviceId:f.device,actorId:f.actor,deviceKeySha256:fingerprint,issuedAt:new Date().toISOString()},fingerprint)})
 const draft=await service('pos_offline_reserve',f.actor,{requestId:id(),branchId:f.branch,deviceId:f.device,shiftId:f.shift,count:3,lifetimeSeconds:60,maxInvoiceTotalFils:10000,maxGrossFils:30000,permissions:{cash:true,recordedCard:true,mixedTender:true}}),snapshotEnvelope=envelope(draft.snapshot)
 const bundle=await service('pos_offline_attach',draft.authority.id,snapshotEnvelope,envelope({...draft.authority,snapshotSha256:eh(snapshotEnvelope)})),a=bundle.authority,issuance=id()
 const invoice={schemaVersion:1,id:id(),kind:'tax_invoice',documentNumber:`${a.invoiceRange.prefix}-INV-${String(a.invoiceRange.first).padStart(10,'0')}`,issuedAt:a.issuedAt,merchant:bundle.snapshot.profile,orderId:issuance,branchId:f.branch,deviceId:f.device,shiftId:f.shift,actorId:f.actor,serviceType:'takeaway',customer:null,lines:[{lineNumber:1,productId:f.food,name:'Synthetic hot food',unit:'piece',quantityMilli:1000,unitPriceFils:1000,taxRateBps:500,grossFils:1000,netFils:952,taxFils:48}],totals:{grossFils:1000,netFils:952,taxFils:48},payments:[{method:'cash',amountFils:1000}],paymentSettlement:'recorded',cashTenderedFils:1000,changeFils:0}
 const proof=envelope({kind:'offline-sale',schemaVersion:1,id:issuance,authorityId:a.id,authoritySha256:bundle.authoritySha256,snapshotSha256:bundle.snapshotSha256,deviceSequence:1,previousEventSha256:null,document:invoice,clock:{estimatedServerAt:a.issuedAt,bootId:id(),elapsedRealtimeMs:1234},paymentIntentId:id()},fingerprint)
 const ack=envelope({kind:'offline-ack',schemaVersion:1,id:id(),issuanceId:issuance,payloadSha256:eh(proof),authorityId:a.id,keyEpoch:enrollment.keyEpoch,deviceSequence:1,receivedAt:new Date().toISOString()})
 await service('pos_offline_import',a.id,proof,ack);return {invoice,authorityId:a.id,proof,ack}
}
async function offlineExclusion() {
  const f = await fixture(); await enable(f)
  const imported = await importedSale(f)
  const original = await scalar(db, 'select to_jsonb(r) from public.pos_offline_receipts r where issuance_id=$1', [imported.invoice.orderId])
  check((await workList(f)).items, [], 'actual SQL native import creates no routed preparation')
  await refund(f, await returnCommand(f, imported.invoice.orderId, imported.invoice.id, 0, [{ lineNumber: 1, quantityMilli: 1000 }]))
  check((await workList(f)).items, [], 'online return of imported native receipt creates no station notices')
  check(await scalar(db, 'select to_jsonb(r) from public.pos_offline_receipts r where issuance_id=$1', [imported.invoice.orderId]), original, 'station migration preserves imported receipt and signed-ACK fixture bytes')
  check(await scalar(db, 'select count(*)::int from public.pos_kitchen_tickets where order_id=$1', [imported.invoice.orderId]), 0, 'native import and return never replay kitchen')
}

async function lifecycleScenarios() {
  const f = await fixture(); await enable(f)
  const draft = tabSave(f, [line(f.food), line(f.drink)])
  await saveTab(f, draft)
  const first = await dispatch(f, dispatchCommand(f, draft.tabId, 1))
  const original = await ownWork(f, { tabId: draft.tabId })
  for (const work of original) await ackAll(f, work.id)
  await saveTab(f, command(f, { type: 'tab.void', tabId: draft.tabId, expectedRevision: 1, reason: 'Synthetic stop preparation' }))
  const stopped = await detail(f, original[0].id)
  check(stopped.work.state, 'cancelled', 'void cancels original generation')
  check(Object.values(stopped.work.stages).flat(), [], 'void clears active preparation but retains ownership')
  check(stopped.notices.some(n => n.kind === 'void'), true, 'void remains actionable at old station after quantities zeroed')
  await call(f, 'pos_execute_kitchen_station_command', command(f, { expectedRevision: f.configRevision++, type: 'route.set', productId: f.food, stationId: f.drinks }), f.binding)
  await saveTab(f, { ...draft, id: id(), type: 'tab.reopen', expectedRevision: 2, reason: 'Synthetic customer returned' })
  let ticket = (await tabDetail(f, draft.tabId)).ticket
  await dispatch(f, dispatchCommand(f, draft.tabId, 3, ticket.revision, 'Prepare reopened order'))
  let current = (await ownWork(f, { tabId: draft.tabId })).filter(w => w.generation === 2)
  check(current.length, 1, 'new generation uses new routing once for both products')
  check(current[0].stationId, f.drinks, 'reopened generation snapshots current station')
  const oldBefore = await detail(f, original[0].id)
  const paid = await pay(f, sale(f, draft.lines, { serviceType: 'dine_in', sourceTab: { id: draft.tabId, expectedRevision: 3 } }))
  check(await detail(f, original[0].id), oldBefore, 'later payment never changes prior generation metadata or invoice links')
  current = await Promise.all(current.map(w => detail(f, w.id)))
  check(current[0].work.invoiceId, paid.receipt.id, 'only current generation gains invoice custody')
  const full = await returnCommand(f, paid.receipt.orderId, paid.receipt.id, 0, [{ lineNumber: 1, quantityMilli: 1000 }, { lineNumber: 2, quantityMilli: 1000 }])
  // The request order ID is taken from the immutable receipt; no inferred live tab state.
  await refund(f, full)
  const returned = await detail(f, current[0].work.id)
  check(returned.work.payment, 'refunded', 'full paid-tab return cancels current generation')
  check(returned.notices.filter(n => n.kind === 'return').length, 1, 'full paid-tab return creates one credit obligation without duplicate cancellation notice')
  check(returned.notices.filter(n => n.kind === 'return')[0].detail.lines.length, 2, 'full credit retains both original line identities')
  for (const w of [...original, ...current.map(d => d.work)]) await ackAll(f, w.id)
  check((await ownWork(f, { tabId: draft.tabId, view: 'history' })).length, 3, 'all closed generations remain accessible in history')
  await reject(execute(f, stageCommand(f, returned.work, 'queued', 'preparing')), /POS_STATION_WORK_CONFLICT|POS_STATION_WORK_CLOSED/, 'closed generation cannot restart through station stage')
  check(await scalar(db, 'select count(*)::int from public.pos_kitchen_station_dispatch_context'), 0, 'trusted dispatch context is removed after successful calls')
  report.fixtures.closedGeneration = returned
}

async function authorityScenarios() {
  const f = await fixture(); await enable(f)
  const order = sale(f); await pay(f, order)
  const work = (await ownWork(f, { orderId: order.id }))[0]
  const c = stageCommand(f, work, 'queued', 'preparing'), ack = await execute(f, c)
  const other = await fixture()
  await reject(detail(other, work.id), /POS_STATION_WORK_NOT_FOUND/, 'foreign tenant cannot read work by guessed identity')
  await reject(recover(other, { ...c, branchId: other.branch, deviceId: other.device }), /POS_IDEMPOTENCY_CONFLICT/, 'foreign tenant cannot adopt immutable request identity')
  const foreignOrder = sale(other); await pay(other, foreignOrder)
  await reject(db.query("insert into public.pos_kitchen_station_roots(organization_id,branch_id,family,order_id) values($1,$2,'paid',$3)", [f.org, f.branch, foreignOrder.id]), { code: '23503' }, 'tenant composite FK rejects paid root linked to foreign order')
  const foreignTab = tabSave(other, [line(other.food)]); await saveTab(other, foreignTab)
  const foreignTicket = await dispatch(other, dispatchCommand(other, foreignTab.tabId, 1))
  await reject(db.query("insert into public.pos_kitchen_station_roots(organization_id,branch_id,family,ticket_id) values($1,$2,'tab',$3)", [f.org, f.branch, foreignTicket.ticket.id]), { code: '23503' }, 'tenant composite FK rejects unpaid root linked to foreign ticket')
  const secondOrder = sale(f, [line(f.general)]); await pay(f, secondOrder)
  const secondWork = (await ownWork(f, { orderId: secondOrder.id }))[0]
  const ownRoot = await scalar(db, 'select root_id from public.pos_kitchen_station_work where id=$1', [work.id])
  await reject(db.query('insert into public.pos_kitchen_station_product_ownership(root_id,generation,product_id,work_id) values($1,1,$2,$3)', [ownRoot, f.food, secondWork.id]), { code: '23503' }, 'root generation composite FK rejects ownership attached to another root work')
  const before = await scalar(db, 'select count(*)::int from public.pos_kitchen_station_work_commands')
  for (const delta of [{ extra: true }, { expectedRevision: 1.5 }, { workId: work.id.toUpperCase() }, { reason: ' hidden ' }, { expectedRevision: 0 }])
    await reject(call(f, 'pos_execute_kitchen_station_work_command', { ...c, id: id(), ...delta }, f.binding), /POS_STATION_WORK_INVALID/, 'strict SQL rejects hostile command ' + JSON.stringify(delta))
  check(await scalar(db, 'select count(*)::int from public.pos_kitchen_station_work_commands'), before, 'invalid commands create no durable request records')
  await db.query('update public.pos_staff set active=false where organization_id=$1 and user_id=$2', [f.org, f.actor])
  check(await recover(f, c), { ...ack, replayed: true }, 'original actor retains exact historical acknowledgement after staff revocation')
  await reject(execute(f, stageCommand(f, ack.work, 'preparing', 'ready')), /POS_ACCESS_DENIED|POS_STAFF/, 'revoked actor cannot perform new station work')
  await reject(recover(f, stageCommand(f, ack.work, 'preparing', 'ready')), /POS_ACCESS_DENIED|POS_STAFF/, 'revoked actor cannot create new cancellation')
  await db.query('update public.pos_staff set active=true where organization_id=$1 and user_id=$2', [f.org, f.actor])
  await db.query('update public.pos_devices set active=false where id=$1', [f.device])
  check(await recover(f, c), { ...ack, replayed: true }, 'original binding recovers accepted request after device revocation')
  await reject(detail(f, work.id), /POS_DEVICE_INVALID/, 'revoked device cannot read current work')
  await db.query('update public.pos_devices set active=true where id=$1', [f.device])
  const next = stageCommand(f, ack.work, 'preparing', 'ready')
  const snapshot = await detail(f, work.id)
  await db.query("create function public.station_qa_audit_fail() returns trigger language plpgsql as $$begin if new.event_type='kitchen.station.stage' then raise exception 'SYNTHETIC_AUDIT_FAILURE';end if;return new;end$$; create trigger station_qa_audit_fail before insert on public.pos_audit_events for each row execute function public.station_qa_audit_fail()")
  await reject(execute(f, next), /SYNTHETIC_AUDIT_FAILURE/, 'audit insertion failure aborts stage transaction')
  check(await detail(f, work.id), snapshot, 'audit failure rolls back work revision and stage')
  check(await scalar(db, 'select count(*)::int from public.pos_kitchen_station_work_commands where id=$1', [next.id]), 0, 'audit failure leaves request safe to retry')
  await db.query('drop trigger station_qa_audit_fail on public.pos_audit_events; drop function public.station_qa_audit_fail()')
  for (const role of ['anon', 'authenticated', 'service_role']) {
    check(await scalar(db, "select has_table_privilege($1,'public.pos_kitchen_station_dispatch_context','INSERT')", [role]), false, role + ' cannot forge routing snapshot context')
    check(await scalar(db, "select has_function_privilege($1,'public.pos_execute_tab_kitchen_before_station_workflow(jsonb,text)','EXECUTE')", [role]), false, role + ' cannot bypass guarded legacy mutation')
  }
}

async function admissionAndUnicodeScenarios() {
  const f = await fixture(); await enable(f)
  const label = '🍳'.repeat(120), note = '🍲'.repeat(400)
  const draft = tabSave(f, [line(f.food), line(f.drink)], { label, note })
  await saveTab(f, draft); await dispatch(f, dispatchCommand(f, draft.tabId, 1))
  const original = await ownWork(f, { tabId: draft.tabId })
  const grill = original.find(w => w.stationId === f.grill)
  check(grill.metadata.label, label, 'SQL and browser preserve 120 Unicode-codepoint label')
  check(grill.metadata.note, note, 'SQL and browser preserve 400 Unicode-codepoint note')
  for (const w of original) await ackAll(f, w.id)
  await saveTab(f, { ...draft, id: id(), expectedRevision: 1, lines: [line(f.drink)] })
  let ticket = (await tabDetail(f, draft.tabId)).ticket
  await dispatch(f, dispatchCommand(f, draft.tabId, 2, ticket.revision, 'Synthetic withdrawal'))
  await ackAll(f, grill.id)
  await enable(f, false)
  await saveTab(f, { ...draft, id: id(), expectedRevision: 2, lines: [line(f.drink)], note: 'Changed after admission paused' })
  ticket = (await tabDetail(f, draft.tabId)).ticket
  await dispatch(f, dispatchCommand(f, draft.tabId, 3, ticket.revision))
  const zero = await detail(f, grill.id)
  check(Object.values(zero.work.stages).flat(), [], 'removed station retains zero preparation quantities')
  check(zero.work.pendingNoticeCount, 1, 'metadata-only update creates visible notice at previously removed station')
  check(zero.notices[0].detail.metadataAfter.note, 'Changed after admission paused', 'existing routed dispatch remains operational with admission disabled')
  const newOrder = sale(f); await pay(f, newOrder)
  check((await ownWork(f, { orderId: newOrder.id })).length, 0, 'disabled admission sends new paid orders to legacy workflow')
  check((await call(f, 'pos_list_kitchen', f.branch, f.binding, null)).activeTickets.some(t => t.orderId === newOrder.id), true, 'new legacy order remains visible after admission disabled')
  report.fixtures.unicodeWork = original[0]
}

async function paginationScenarios() {
  const f = await fixture(); await enable(f)
  for (let index = 0; index < 103; index++) await pay(f, sale(f, [line(f.general)]))
  const first = await workList(f, { station: 'general' })
  check([first.items.length, first.matchingCount, first.nextCursor !== null], [100, 103, true], 'active page is complete at exact hundred-item boundary')
  const second = await workList(f, { station: 'general', cursor: first.nextCursor })
  check(second.items.length, 3, 'exclusive cursor returns remaining three without omission')
  check(new Set([...first.items, ...second.items].map(w => w.id)).size, 103, 'active pages contain no duplicates')
  check(second.stations, first.stations, 'station selector counts remain global across cursor pages')
  const draft = tabSave(f, [line(f.food)])
  await saveTab(f, draft); await dispatch(f, dispatchCommand(f, draft.tabId, 1))
  for (let revision = 1; revision <= 51; revision++) {
    await saveTab(f, { ...draft, id: id(), expectedRevision: revision, note: 'Synthetic note ' + revision })
    const ticket = (await tabDetail(f, draft.tabId)).ticket
    await dispatch(f, dispatchCommand(f, draft.tabId, revision + 1, ticket.revision))
  }
  const works = (await workList(f, { station: f.grill })).items
  const d = await detail(f, works[0].id)
  check([d.notices.length, d.noticeCount, d.nextAfterSequence], [50, 52, 50], 'notice page preserves exact total and continuation beyond fifty')
  const tail = await detail(f, works[0].id, { afterSequence: d.nextAfterSequence })
  check(tail.notices.length, 2, 'notice continuation returns last two obligations')
  const one = await execute(f, noticeCommand(f, d.work, d.notices[0].id))
  check(one.work.pendingNoticeCount, 51, 'single notice acknowledgement never swallows unseen later events')
  check((await detail(f, works[0].id, { noticeView: 'all' })).notices[0].acknowledgedAt !== null, true, 'all-notices history includes acknowledged identity')
  report.fixtures.noticePage = d
}

let created = false, connected = false
try {
  await control.connect()
  assert.equal(await scalar(control, 'select inet_server_addr() is null'), true)
  await control.query('create database ' + database); created = true
  await db.connect(); connected = true
  for (const role of ['anon', 'authenticated', 'service_role'])
    if (!await scalar(db, 'select exists(select 1 from pg_roles where rolname=$1)', [role])) await db.query('create role ' + role)
  await db.query("create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;")
  const directory = new URL('../../supabase/migrations/', import.meta.url)
  const migrations = (await readdir(directory)).filter(name => /^20261016/.test(name) && name < '202610160033').sort()
  const workflow = migrations.find(name => name.startsWith('202610160032'))
  assert.ok(workflow, 'SQL032 candidate must exist before acceptance runs')
  for (const name of migrations.filter(name => name !== workflow)) {
    const sql = await readFile(new URL(name, directory), 'utf8'); report.migrationHashes[name] = hash(sql); await db.query(sql)
  }
  const f = await fixture()
  const legacyOrder = sale(f), legacyPaid = await pay(f, legacyOrder)
  const legacyStage = command(f, { orderId: legacyOrder.id, expectedRevision: 1, status: 'preparing', reason: null })
  const legacyAck = await call(f, 'pos_transition_kitchen', legacyStage, f.binding)
  report.fixtures.legacyInvoiceId = legacyPaid.receipt.id
  const legacyDraft = tabSave(f, [line(f.food)]); await saveTab(f, legacyDraft)
  const legacyDispatch = dispatchCommand(f, legacyDraft.tabId, 1), legacyDispatchAck = await dispatch(f, legacyDispatch)
  const sql = await readFile(new URL(workflow, directory), 'utf8'); report.migrationHashes[workflow] = hash(sql); await db.query(sql)
  check(await dispatch(f, legacyDispatch), { ...legacyDispatchAck, replayed: true }, 'legacy unpaid dispatch immutable acknowledgement survives upgrade')
  check(await call(f, 'pos_resolve_tab_kitchen_request', legacyDispatch, f.binding), { ...legacyDispatchAck, replayed: true }, 'legacy unpaid recovery survives upgrade')
  await scenarios(f, legacyOrder, legacyStage, legacyAck)
  check((await call(f, 'pos_list_tab_kitchen', f.branch, f.binding, null)).activeTickets.some(t => t.id === legacyDispatchAck.ticket.id), true, 'legacy unpaid work remains on legacy board after admission enabled')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, where: error.where, stack: error.stack }; process.exitCode = 1
} finally {
  if (connected) await db.end()
  if (created) {
    await control.query('drop database ' + database)
    assert.equal(await scalar(control, 'select exists(select 1 from pg_database where datname=$1)', [database]), false)
    report.cleanup = 'owned database dropped and absence verified'
  }
  await control.end(); report.finishedAt = new Date().toISOString(); await save()
}
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, races: report.races.length, cleanup: report.cleanup, error: report.error?.message }))
