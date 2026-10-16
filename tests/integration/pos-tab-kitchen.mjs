// Isolated embedded PostgreSQL fixture; never connects to an existing database.
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const { PGlite } = await import(pathToFileURL(process.argv[2]).href)
const db = new PGlite()
process.on('uncaughtException',error=>{console.error(error.message,error.where??'');process.exit(1)})
await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`)
for(const number of ['001','002','003','004','005','006','008','010','011','012','013']){
 const files={ '001':'platform','002':'operations','003':'live_documents','004':'online_access','005':'request_recovery','006':'cash_out_balance','008':'catalogue_management','010':'sale_lock_order','011':'branch_reports','012':'offers','013':'staff_access' }
 await db.exec(await readFile(new URL(`../../supabase/migrations/202610160${number}00_pos_${files[number]}.sql`,import.meta.url),'utf8'))
}
const ids=Object.fromEntries(['owner','manager','cashier','otherCashier','newUser','unverified','foreignOwner','scopedOwner','org','branch','branch2','foreignOrg','foreignBranch','profile','product'].map(k=>[k,crypto.randomUUID()]))
const {owner,manager,cashier,otherCashier,newUser,unverified,foreignOwner,scopedOwner,org,branch,branch2,foreignOrg,foreignBranch,profile,product}=ids
await db.query(`insert into auth.users(id,email,email_confirmed_at) select v::uuid,k||'@example.test',case when k='unverified' then null else now() end from jsonb_each_text($1) as x(k,v) where k=any($2::text[])`,[JSON.stringify(ids),['owner','manager','cashier','otherCashier','newUser','unverified','foreignOwner','scopedOwner']])
await db.exec(`insert into public.pos_organizations(id,legal_name) values('${org}','Synthetic access'),('${foreignOrg}','Other synthetic');
 insert into public.pos_branches(id,organization_id,name) values('${branch}','${org}','First'),('${branch2}','${org}','Second'),('${foreignBranch}','${foreignOrg}','Other');
 insert into public.pos_staff(organization_id,user_id,branch_id,role) values
 ('${org}','${owner}',null,'owner'),('${org}','${manager}','${branch}','manager'),('${org}','${cashier}','${branch}','cashier'),
 ('${org}','${otherCashier}','${branch2}','cashier'),('${org}','${scopedOwner}','${branch}','owner'),('${foreignOrg}','${foreignOwner}',null,'owner');
 insert into public.pos_merchant_profiles(id,organization_id,branch_id,legal_name,branch_name,address,phone,trn,tax_registered,tax_inclusive,confirmed_by)
 values('${profile}','${org}','${branch}','Synthetic','First','Test address','Test contact','100000000000001',true,true,'${owner}');
 insert into public.pos_branch_receipt_config values('${branch}','${org}','${profile}','TEST',true);
 insert into public.pos_products(id,organization_id,branch_id,name,category,unit_price_fils,tax_rate_bps) values('${product}','${org}','${branch}','Test item','Test',1000,500);`)
const scalar=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0])[0]
const user=async(id)=>db.exec(`set role authenticated;set app.user_id='${id}'`)
const admin=async(fn)=>{await db.exec('reset role');try{return await fn()}finally{await user(owner)}}
const binding='a'.repeat(64),managerBinding='b'.repeat(64),cashierBinding='c'.repeat(64)
await user(owner)
const device=await scalar('select public.pos_enroll_device($1,$2,$3)',[branch,'Owner',binding])
await user(manager)
const managerDevice=await scalar('select public.pos_enroll_device($1,$2,$3)',[branch,'Manager',managerBinding])
await user(cashier)
const cashierDevice=await scalar('select public.pos_enroll_device($1,$2,$3)',[branch,'Cashier',cashierBinding])
await user(owner)
const rpc=(name,cmd,key=binding)=>scalar(`select public.${name}($1::jsonb,$2)`,[JSON.stringify(cmd),key])
const base=(extra={})=>({id:crypto.randomUUID(),branchId:branch,deviceId:device.id,reason:'Synthetic test',...extra})
let checks=0
const check=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++}
const rejects=async(p,pattern)=>{await assert.rejects(p,pattern);checks++}
await db.exec('reset role')
await db.exec(await readFile(new URL('../../supabase/migrations/20261016001400_pos_kitchen.sql',import.meta.url),'utf8'))
await user(owner)
const shift=crypto.randomUUID()
await rpc('pos_execute_live_command',{id:crypto.randomUUID(),branchId:branch,deviceId:device.id,type:'shift.open',shiftId:shift,openingCashFils:100000})
const line={productId:product,quantityMilli:1000,expectedUnitPriceFils:1000,expectedTaxRateBps:500,expectedRevision:1}
const sale=(extra={})=>({id:crypto.randomUUID(),branchId:branch,deviceId:device.id,shiftId:shift,createdAt:new Date().toISOString(),serviceType:'dine_in',lines:[line],payments:[{method:'cash',amountFils:1000}],expectedTotalFils:1000,profileId:profile,customer:null,cashTenderedFils:1000,...extra})
const oldSale=sale(),oldAck=await rpc('pos_record_live_order',oldSale)
await db.exec('reset role')
await db.exec(await readFile(new URL('../../supabase/migrations/20261016001500_pos_open_tabs.sql',import.meta.url),'utf8'))
await user(owner)
const command=(extra={})=>({id:crypto.randomUUID(),branchId:branch,deviceId:device.id,...extra})
const table=(extra={})=>command({type:'table.save',expectedRevision:0,table:{id:crypto.randomUUID(),name:'Table 1',area:'Main',seats:4,active:true},reason:'Synthetic table setup',...extra})
const draft=(extra={})=>command({type:'tab.save',tabId:crypto.randomUUID(),expectedRevision:0,label:'Synthetic dine-in',serviceType:'dine_in',tableId:null,guestCount:2,note:'Synthetic note',lines:[line],...extra})
const execute=(cmd,key=binding)=>rpc('pos_execute_tab_command',cmd,key)
const resolve=(cmd,key=binding)=>rpc('pos_resolve_tab_request',cmd,key)
const list=(cursor=null,branchId=branch,key=binding)=>scalar('select public.pos_list_tabs($1,$2,$3::jsonb)',[branchId,key,cursor===null?null:JSON.stringify(cursor)])
const detail=(tabId,branchId=branch,key=binding)=>scalar('select public.pos_get_tab($1,$2,$3)',[branchId,tabId,key])
const financialResolve=(order,key=binding)=>scalar('select public.pos_resolve_live_request($1,$2::jsonb,$3)',['sale',JSON.stringify(order),key])
const lookup=(order,key=binding)=>scalar('select public.pos_lookup_own_committed_request($1,$2::jsonb,$3)',['sale',JSON.stringify(order),key])

const legacyCommand=command({orderId:oldSale.id,expectedRevision:1,status:'preparing',reason:null})
const legacyAck=await rpc('pos_transition_kitchen',legacyCommand)
await db.exec('reset role')
await db.exec(await readFile(new URL('../../supabase/migrations/20261016001600_pos_tab_kitchen.sql',import.meta.url),'utf8'))
await user(owner)
const prep=(extra={})=>command({type:'dispatch',tabId:crypto.randomUUID(),expectedTabRevision:1,expectedTicketRevision:0,reason:null,...extra})
const dispatch=(cmd,key=binding)=>rpc('pos_execute_tab_kitchen_command',cmd,key)
const recover=(cmd,key=binding)=>rpc('pos_resolve_tab_kitchen_request',cmd,key)
const board=(cursor=null,key=binding,branchId=branch)=>scalar('select public.pos_list_tab_kitchen($1,$2,$3::jsonb)',[branchId,key,cursor===null?null:JSON.stringify(cursor)])
const ticketDetail=(ticketId,after=null,key=binding)=>scalar('select public.pos_get_tab_kitchen($1,$2,$3,$4)',[branch,ticketId,key,after])
const forTab=(tabId,key=binding)=>scalar('select public.pos_get_tab_kitchen_for_tab($1,$2,$3)',[branch,tabId,key])
const acknowledge=(t,extra={})=>dispatch(command({type:'acknowledge',ticketId:t.id,expectedRevision:t.revision,throughSequence:t.eventSequence,...extra}))
const stage=(t,from,to,extra={})=>dispatch(command({type:'stage',ticketId:t.id,expectedRevision:t.revision,from,to,reason:null,...extra}))
check(await rpc('pos_transition_kitchen',legacyCommand),{...legacyAck,replayed:true})
check(await rpc('pos_resolve_kitchen_request',legacyCommand),{...legacyAck,replayed:true})
check((await board()).activeCount,0)
const savedCommand=draft({lines:[{...line,quantityMilli:8000}]}),saved=await execute(savedCommand)
check((await forTab(saved.tab.id)).ticket,null)
check((await forTab(saved.tab.id)).dispatchRequired,false)
const fixture={}
const firstCommand=prep({tabId:saved.tab.id}),first=await dispatch(firstCommand)
fixture.first=first;fixture.firstCommand=firstCommand;fixture.initialTab=await forTab(saved.tab.id)
check(first.ticket.lines[0].quantityMilli,8000)
check(first.ticket.stages.queued[0].quantityMilli,8000)
check(first.ticket.pendingChangeCount,1)
check(await dispatch(firstCommand),{...first,replayed:true})
check(await recover(firstCommand),{...first,replayed:true})
check((await forTab(saved.tab.id)).dispatchRequired,false)
await rejects(stage(first.ticket,'queued','preparing'),/POS_TAB_KITCHEN_PENDING_ACK/)
let current=(await acknowledge(first.ticket)).ticket
current=(await stage(current,'queued','preparing')).ticket
current=(await stage(current,'preparing','ready')).ticket
current=(await stage(current,'ready','served')).ticket
check(current.stages.served[0].quantityMilli,8000)
check((await board()).activeCount,0)
const additionCommand={...savedCommand,id:crypto.randomUUID(),expectedRevision:1,lines:[{...line,quantityMilli:10000}]}
await execute(additionCommand)
check((await forTab(saved.tab.id)).dispatchRequired,true)
const payTen=sale({sourceTab:{id:saved.tab.id,expectedRevision:2},lines:[{...line,quantityMilli:10000}],expectedTotalFils:10000,payments:[{method:'cash',amountFils:10000}],cashTenderedFils:10000})
await rejects(rpc('pos_record_live_order',payTen),/POS_KITCHEN_DISPATCH_REQUIRED/)
const addition=await dispatch(prep({tabId:saved.tab.id,expectedTabRevision:2,expectedTicketRevision:current.revision}))
check(addition.ticket.stages.served[0].quantityMilli,8000)
check(addition.ticket.stages.queued[0].quantityMilli,2000)
check((await ticketDetail(current.id)).events[0].additions[0].quantityMilli,2000)
fixture.addition=addition;fixture.additionDetail=await ticketDetail(current.id)
current=addition.ticket
const beforePaid=current
const paid=await rpc('pos_record_live_order',payTen)
current=(await ticketDetail(current.id)).ticket
fixture.paid=current
check(current.payment,'paid');check(current.id,beforePaid.id);check(current.issuedAt,beforePaid.issuedAt);check(current.stages,beforePaid.stages);check(current.pendingChangeCount,beforePaid.pendingChangeCount)
check(await rpc('pos_record_live_order',payTen),{...paid,replayed:true})
check(await admin(()=>scalar('select count(*)::integer from public.pos_kitchen_tickets where order_id=$1',[payTen.id])),0)
check(await scalar('select count(*)::integer from public.pos_orders where id=$1',[payTen.id]),1)
await rpc('pos_execute_live_command',command({type:'refund.full',shiftId:shift,orderId:payTen.id,reason:'Synthetic refund'}))
current=(await ticketDetail(current.id)).ticket
fixture.refundedDetail=await ticketDetail(current.id);fixture.refundedList=await board()
check(current.payment,'refunded');check(current.state,'cancelled');check(current.pendingChangeCount,2);check(current.lines,[])
check((await board()).activeTickets[0].id,current.id)
check(await recover(firstCommand),{...first,replayed:true})
check(await financialResolve(payTen),{...paid,replayed:true})
current=(await acknowledge(current,{throughSequence:2})).ticket
check(current.pendingChangeCount,1)
current=(await acknowledge(current)).ticket
check((await board()).activeCount,0)
await rejects(stage(current,'queued','preparing'),/POS_KITCHEN_CANCELLED/)

// No shift is required for a cashier to save and send preparation.
await user(cashier)
const ownSaved=draft({deviceId:cashierDevice.id}),ownSavedAck=await execute(ownSaved,cashierBinding)
const ownDispatch=prep({deviceId:cashierDevice.id,tabId:ownSaved.tabId}),ownAck=await dispatch(ownDispatch,cashierBinding)
check(ownAck.ticket.payment,'unpaid')
await user(owner)
let work=(await acknowledge(ownAck.ticket)).ticket
work=(await stage(work,'queued','preparing')).ticket
// Reduction of working quantities is a manager decision, never a silent cashier edit.
await user(cashier)
await execute({...ownSaved,id:crypto.randomUUID(),expectedRevision:1,lines:[]},cashierBinding)
await rejects(dispatch(prep({deviceId:cashierDevice.id,tabId:ownSaved.tabId,expectedTabRevision:2,expectedTicketRevision:work.revision}),cashierBinding),/POS_INVALID_ORDER/)
await execute({...ownSaved,id:crypto.randomUUID(),expectedRevision:2,lines:[{...line,quantityMilli:2000}]},cashierBinding)
const ownAdd=await dispatch(prep({deviceId:cashierDevice.id,tabId:ownSaved.tabId,expectedTabRevision:3,expectedTicketRevision:work.revision}),cashierBinding)
await execute({...ownSaved,id:crypto.randomUUID(),expectedRevision:3,lines:[line]},cashierBinding)
// A queued addition is withdrawn first, leaving the already-preparing portion intact.
work=(await dispatch(prep({deviceId:cashierDevice.id,tabId:ownSaved.tabId,expectedTabRevision:4,expectedTicketRevision:ownAdd.ticket.revision}),cashierBinding)).ticket
check(work.stages.queued,[]);check(work.stages.preparing[0].quantityMilli,1000)
// Change unit to represent a real working withdrawal and a new measured quantity.
await admin(()=>db.query("update public.pos_products set unit='kg',revision=2 where id=$1",[product]))
await user(cashier)
const kgLine={...line,quantityMilli:500,expectedRevision:2}
await execute({...ownSaved,id:crypto.randomUUID(),expectedRevision:4,lines:[kgLine]},cashierBinding)
const kgDispatch=prep({deviceId:cashierDevice.id,tabId:ownSaved.tabId,expectedTabRevision:5,expectedTicketRevision:work.revision})
await rejects(dispatch(kgDispatch,cashierBinding),/POS_MANAGER_REQUIRED/)
await user(owner)
await rejects(dispatch({...kgDispatch,id:crypto.randomUUID(),deviceId:device.id}),/POS_KITCHEN_REASON_REQUIRED/)
work=(await dispatch({...kgDispatch,id:crypto.randomUUID(),deviceId:device.id,reason:'Correct measured item'})).ticket
check(work.stages.preparing,[]);check(work.stages.queued[0].unit,'kg');check(work.stages.queued[0].quantityMilli,500)
// A menu rename changes the visible notice only, not preparation quantities.
await admin(()=>db.query("update public.pos_products set name='Renamed item',revision=3 where id=$1",[product]))
const renamedLine={...kgLine,expectedRevision:3}
await execute({...ownSaved,id:crypto.randomUUID(),deviceId:device.id,expectedRevision:5,lines:[renamedLine]})
work=(await dispatch(prep({tabId:ownSaved.tabId,expectedTabRevision:6,expectedTicketRevision:work.revision}))).ticket
const renamedNotice=(await ticketDetail(work.id,work.eventSequence-1)).events[0]
check(renamedNotice.additions,[]);check(renamedNotice.withdrawals,[]);check(work.stages.queued[0].name,'Renamed item')
// Price-only edits can be settled without manufacturing a dispatch or notice.
await admin(()=>db.query('update public.pos_products set unit_price_fils=1200,revision=4 where id=$1',[product]))
const repricedLine={...renamedLine,expectedUnitPriceFils:1200,expectedRevision:4}
await execute({...ownSaved,id:crypto.randomUUID(),deviceId:device.id,expectedRevision:6,lines:[repricedLine]})
check((await forTab(ownSaved.tabId)).dispatchRequired,false)
const pricePayment=sale({sourceTab:{id:ownSaved.tabId,expectedRevision:7},lines:[repricedLine],expectedTotalFils:600,payments:[{method:'cash',amountFils:600}],cashTenderedFils:600})
await rpc('pos_record_live_order',pricePayment)
check((await ticketDetail(work.id)).ticket.eventSequence,work.eventSequence)
await admin(()=>db.query("update public.pos_products set name='Test item',unit='piece',unit_price_fils=1000,revision=1 where id=$1",[product]))
// Explicit void notifies even served cooks; reopen requires a manager's new dispatch.
const voidDraft=draft(),voidDraftAck=await execute(voidDraft)
let v=(await dispatch(prep({tabId:voidDraft.tabId}))).ticket
v=(await acknowledge(v)).ticket;v=(await stage(v,'queued','preparing')).ticket
const voidCmd=command({type:'tab.void',tabId:voidDraft.tabId,expectedRevision:1,reason:'Stop this preparation'})
await execute(voidCmd)
v=(await ticketDetail(v.id)).ticket;check(v.state,'cancelled');check(v.pendingChangeCount,1)
check((await ticketDetail(v.id)).events[0].reason,'Stop this preparation')
await execute({...voidDraft,id:crypto.randomUUID(),type:'tab.reopen',expectedRevision:2,reason:'Customer returned'})
check((await forTab(voidDraft.tabId)).dispatchRequired,true)
await rejects(dispatch(prep({tabId:voidDraft.tabId,expectedTabRevision:3,expectedTicketRevision:v.revision})),/POS_KITCHEN_REASON_REQUIRED/)
v=(await dispatch(prep({tabId:voidDraft.tabId,expectedTabRevision:3,expectedTicketRevision:v.revision,reason:'Prepare reopened order again'}))).ticket
check(v.generation,2);check(v.pendingChangeCount,2);check(v.stages.queued[0].quantityMilli,1000)
fixture.reopened=await ticketDetail(v.id)
// Prefix acknowledgements never swallow notices that arrived later.
const staleAck=command({type:'acknowledge',ticketId:v.id,expectedRevision:v.revision,throughSequence:v.eventSequence})
await execute({...voidDraft,id:crypto.randomUUID(),expectedRevision:3,note:'More instructions'})
v=(await dispatch(prep({tabId:voidDraft.tabId,expectedTabRevision:4,expectedTicketRevision:v.revision}))).ticket
await rejects(dispatch(staleAck),/POS_TAB_KITCHEN_CHANGED/)
const cancellation=await recover(staleAck);fixture.cancelled=cancellation
check(cancellation.status,'cancelled');await rejects(dispatch(staleAck),/POS_REQUEST_CANCELLED/)
await rejects(recover({...staleAck,throughSequence:1}),/POS_IDEMPOTENCY_CONFLICT/)
// A large historical batch count still emits one bounded withdrawal per stage/product.
const largeDraft=draft({lines:[{...line,quantityMilli:802000}]}),largeSaved=await execute(largeDraft)
let large=(await dispatch(prep({tabId:largeDraft.tabId}))).ticket
await admin(async()=>{
 await db.query("update public.pos_tab_kitchen_batches set quantity_milli=0,stage='cancelled' where ticket_id=$1",[large.id])
 await db.query(`insert into public.pos_tab_kitchen_batches(ticket_id,generation,dispatch_sequence,product_id,name,initial_name,unit,initial_quantity_milli,quantity_milli)
 select $1,1,1,$2,'Test item','Test item','piece',1000,1000 from generate_series(1,802)`,[large.id,product])
})
await execute({...largeDraft,id:crypto.randomUUID(),expectedRevision:1,lines:[line]})
large=(await dispatch(prep({tabId:largeDraft.tabId,expectedTabRevision:2,expectedTicketRevision:large.revision}))).ticket
const largeNotice=(await ticketDetail(large.id,1)).events[0]
check(largeNotice.withdrawals.length,1);check(largeNotice.withdrawals[0].quantityMilli,801000)
fixture.largeWithdrawal=await ticketDetail(large.id,1)
// Metadata-only dispatches retain contiguous immutable notices across pages.
let editedRevision=4
for(let i=0;i<23;i++){
 await execute({...voidDraft,id:crypto.randomUUID(),expectedRevision:editedRevision++,note:'Instructions '+i})
 v=(await dispatch(prep({tabId:voidDraft.tabId,expectedTabRevision:editedRevision,expectedTicketRevision:v.revision}))).ticket
}
const eventPage=await ticketDetail(v.id),eventPage2=await ticketDetail(v.id,eventPage.eventsNextAfter)
check(eventPage.events.length,20);check(eventPage.eventsNextAfter,eventPage.events.at(-1).sequence);check(eventPage2.eventsNextAfter,null)
check(eventPage.events.length+eventPage2.events.length,v.pendingChangeCount)
fixture.eventPage=eventPage;fixture.eventPage2=eventPage2
v=(await acknowledge(v,{throughSequence:eventPage.eventsNextAfter})).ticket
check(v.pendingChangeCount,eventPage2.events.length)
await rejects(stage(v,'queued','preparing'),/POS_TAB_KITCHEN_PENDING_ACK/)
// Historical recovery stays available after staff revocation, without restoring writes.
await rpc('pos_manage_staff',{...base(),targetUserId:cashier,expectedRevision:1,active:false,role:'cashier',assignedBranchId:branch,displayName:null})
await user(cashier)
check(await recover(ownDispatch,cashierBinding),{...ownAck,replayed:true})
await rejects(recover(prep({deviceId:cashierDevice.id}),cashierBinding),/POS_ACCESS_DENIED/)
await rejects(board(null,cashierBinding),/POS_ACCESS_DENIED/)
await user(owner)
await rpc('pos_manage_staff',{...base(),targetUserId:cashier,expectedRevision:2,active:true,role:'cashier',assignedBranchId:branch,displayName:null})
await user(cashier)
const replacementBinding='d'.repeat(64)
await scalar('select public.pos_enroll_device($1,$2,$3)',[branch,'Replacement',replacementBinding])
check(await recover(ownDispatch,replacementBinding),{...ownAck,replayed:true})
await user(owner)
for(const name of ['pos_tab_kitchen_tickets','pos_tab_kitchen_batches','pos_tab_kitchen_events','pos_tab_kitchen_commands','pos_tab_kitchen_request_cancellations','pos_tab_kitchen_payments'])await rejects(db.query(`select * from public.${name}`),/permission denied/)
await rejects(rpc('pos_execute_tab_command_before_kitchen_dispatch',voidCmd),/permission denied/)
await rejects(rpc('pos_record_live_order_before_kitchen_dispatch',payTen),/permission denied/)
await user(foreignOwner)
await rejects(board(),/POS_ACCESS_DENIED/);await rejects(ticketDetail(v.id),/POS_ACCESS_DENIED/);await rejects(recover(firstCommand),/POS_DEVICE_INVALID/)
await user(owner)
for(const cursor of [{},{issuedAt:'infinity',id:v.id},{issuedAt:'bad',id:v.id},{issuedAt:new Date().toISOString(),id:'bad'}])await rejects(board(cursor),/POS_INVALID_TAB_KITCHEN_CURSOR/)
for(const patch of [{expectedTicketRevision:-1},{expectedTabRevision:2147483647},{reason:' padded '},{unexpected:1}])await rejects(dispatch(prep({tabId:voidDraft.tabId,...patch})),/POS_INVALID_TAB_KITCHEN_COMMAND/)
await admin(async()=>{
 await rejects(db.query('update public.pos_tab_kitchen_batches set initial_quantity_milli=1 where ticket_id=$1',[v.id]),/POS_IMMUTABLE_DOCUMENT/)
 await rejects(db.query('delete from public.pos_tab_kitchen_batches where ticket_id=$1',[v.id]),/POS_IMMUTABLE_DOCUMENT/)
 for(const name of ['pos_tab_kitchen_events','pos_tab_kitchen_commands','pos_tab_kitchen_request_cancellations','pos_tab_kitchen_payments'])await rejects(db.query(`delete from public.${name}`),/POS_IMMUTABLE_DOCUMENT/)
})
// Offered v2 settlement uses the same private reservation and immutable original request.
const offer={id:crypto.randomUUID(),name:'Synthetic dispatched discount',active:true,benefit:{kind:'percentage',basisPoints:1000,maximumDiscountFils:null,eligibility:{scope:'all'}},schedule:{timezone:'Asia/Dubai',startsAt:null,endsAt:null,windows:[]},minimumSpendFils:0,serviceTypes:['dine_in','takeaway','delivery'],managerOnly:false,coupon:'SYNTHETICONLY',totalRedemptionsLimit:null,perCustomerLimit:null}
await rpc('pos_manage_offer',base({offer,expectedRevision:0}))
const offeredTab=draft();await execute(offeredTab)
const offeredTicket=(await dispatch(prep({tabId:offeredTab.tabId}))).ticket
const offeredOrder=sale({sourceTab:{id:offeredTab.tabId,expectedRevision:1},payments:[{method:'cash',amountFils:900}],expectedTotalFils:900,offerSelection:{offerId:offer.id,expectedRevision:1,couponCode:'SYNTHETICONLY',expectedDiscountFils:100}})
const offeredAck=await rpc('pos_record_live_order',offeredOrder)
check(offeredAck.receipt.schemaVersion,2);check(JSON.stringify(offeredAck.receipt).includes('SYNTHETICONLY'),false)
check((await ticketDetail(offeredTicket.id)).ticket.stages,offeredTicket.stages)
check((await ticketDetail(offeredTicket.id)).ticket.pendingChangeCount,1)
check(await financialResolve(offeredOrder),{...offeredAck,replayed:true})
await rejects(lookup({...offeredOrder,offerSelection:{...offeredOrder.offerSelection,couponCode:'DIFFERENT'}}),/POS_IDEMPOTENCY_CONFLICT/)
await rpc('pos_execute_live_command',command({type:'refund.full',shiftId:shift,orderId:offeredOrder.id,reason:'Synthetic offered refund'}))
const offeredRefund=await ticketDetail(offeredTicket.id)
check(offeredRefund.ticket.payment,'refunded');check(offeredRefund.ticket.pendingChangeCount,2)
check(await financialResolve(offeredOrder),{...offeredAck,replayed:true})
fixture.offeredOrder=offeredOrder;fixture.offeredAck=offeredAck;fixture.offeredRefund=offeredRefund
// All-age active pagination and terminal overflow are explicit, never silently hidden.
const paged=[]
for(let i=0;i<103;i++){
 const t=draft({label:'Kitchen pagination '+i});await execute(t)
 paged.push((await dispatch(prep({tabId:t.tabId}))).ticket)
}
await admin(()=>db.query("update public.pos_tab_kitchen_tickets set issued_at=now()-interval '90 days',updated_at=now()-interval '90 days' where id=$1",[v.id]))
const boardPage=await board(),boardPage2=await board(boardPage.activeNextCursor)
check(boardPage.activeTickets.length,100);check(boardPage.activeTickets[0].id,v.id)
check(boardPage2.activeNextCursor,null)
check(boardPage.activeTickets.length+boardPage2.activeTickets.length,boardPage.activeCount)
check([...boardPage.activeTickets,...boardPage2.activeTickets].filter(t=>t.pendingChangeCount>0).length,boardPage.pendingCount)
for(const t of paged.slice(0,51)){
 await execute(command({type:'tab.void',tabId:t.tabId,expectedRevision:1,reason:'Pagination stop'}))
 await acknowledge((await ticketDetail(t.id)).ticket)
}
check((await board()).terminalTickets.length,50);check((await board()).terminalTruncated,true)
fixture.boardPage=boardPage;fixture.boardPage2=boardPage2
const legacyPending=command({orderId:oldSale.id,expectedRevision:2,status:'ready',reason:null})
check((await rpc('pos_resolve_kitchen_request',legacyPending)).status,'cancelled')
await rejects(rpc('pos_transition_kitchen',legacyPending),/POS_REQUEST_CANCELLED/)
await admin(()=>db.query('update public.pos_staff set active=false where organization_id=$1 and user_id=$2',[org,owner]))
check(await rpc('pos_resolve_kitchen_request',legacyCommand),{...legacyAck,replayed:true})
await admin(()=>db.query('update public.pos_staff set active=true where organization_id=$1 and user_id=$2',[org,owner]))
// Downgrade recovery cancels only an own exact request; it does not perform its correction.
const managerPending=command({deviceId:managerDevice.id,type:'stage',ticketId:v.id,expectedRevision:v.revision,from:'preparing',to:'queued',reason:'Previously planned correction'})
await rpc('pos_manage_staff',{...base(),targetUserId:manager,expectedRevision:1,active:true,role:'cashier',assignedBranchId:branch,displayName:null})
await user(manager)
check((await recover(managerPending,managerBinding)).status,'cancelled')
await user(owner)
await rpc('pos_manage_staff',{...base(),targetUserId:manager,expectedRevision:2,active:true,role:'manager',assignedBranchId:branch,displayName:null})
await admin(()=>db.query('update public.pos_tab_kitchen_tickets set revision=2147483646 where id=$1',[v.id]))
const limitTicket=(await ticketDetail(v.id)).ticket
check((await acknowledge(limitTicket)).ticket.revision,2147483647)
await rejects(acknowledge({...limitTicket,revision:2147483647}),/POS_INVALID_TAB_KITCHEN_COMMAND/)
if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(fixture,null,2)+'\n')
console.log(JSON.stringify({checksPassed:checks,scope:'Isolated unpaid kitchen dispatch/payment/refund/recovery/bounds'}))
await db.close()
