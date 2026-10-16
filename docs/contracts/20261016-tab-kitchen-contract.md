# SQL016 unpaid kitchen contract

Separate family; existing SQL014 paid kitchen RPCs, schemas, requests and recovery remain unchanged. Saved orders can be edited after dispatch. Only explicit dispatch changes preparation. Payment rejects unsent preparation changes, but accepts price/tax/menu-revision-only edits when the kitchen content is unchanged. All values below are strict JSON. UUIDs canonical lowercase; timestamps finite ISO8601. Revisions 1..2147483647; expected revisions max2147483646.

## Snapshot

KitchenLine = {productId:uuid,name:string1..200,unit:'piece'|'pack'|'kg',quantityMilli:int1..1000000}; each array unique by productId; non-kg quantities whole1000.
Metadata = {label:string1..120,serviceType:'dine_in'|'takeaway'|'delivery',tableId:uuid|null,tableName:string1..80|null,guestCount:int1..99|null,note:string0..400}.
Ticket = {id:uuid,tabId:uuid,branchId:uuid,revision:int,generation:int,dispatchedTabRevision:int,state:'open'|'cancelled',payment:'unpaid'|'paid'|'refunded',paidOrderId:uuid|null,invoiceId:uuid|null,invoiceNumber:string|null,paidAt:timestamp|null,refundedAt:timestamp|null,metadata:Metadata,lines:KitchenLine[0..200],stages:{queued:KitchenLine[0..200],preparing:KitchenLine[0..200],ready:KitchenLine[0..200],served:KitchenLine[0..200]},eventSequence:int,acknowledgedSequence:int,pendingChangeCount:int,issuedAt:timestamp,updatedAt:timestamp}.

Ticket id is server-generated and stable across amendments, void/reopen dispatch and payment. The tab has at most one ticket. Ticket revision changes for every dispatch, stage move, acknowledgement, void, payment promotion and refund. pendingChangeCount=eventSequence-acknowledgedSequence. Stage quantities sum to lines; cancelled tickets have empty lines/stages. Served quantities persist, so 8 served plus 2 added displays served8 and queued2; payment never creates extra preparation. The lines on immutable history may describe a different unit than the current ticket.

## Commands and acknowledgements

Common {id:uuid,branchId:uuid,deviceId:uuid,type:...}.

- type='dispatch': {tabId:uuid,expectedTabRevision:int1..2147483646,expectedTicketRevision:int0..2147483646,reason:trimmed string1..240|null}. Zero ticket revision is initial dispatch. Requires nonempty current open tab and authoritative current menu. Any bound branch cashier may dispatch additions or queued reductions. Reduction touching preparing/ready/served needs owner/manager and reason. Unit changes withdraw old units and queue new units; name-only changes notify without new preparation. Same kitchen content rejects POS_KITCHEN_NO_CHANGES. Dispatch after a void/reopen requires manager and reason and queues the full reopened order as new preparation; preserves old immutable history and any outstanding notices.
- type='stage': {ticketId:uuid,expectedRevision:int1..2147483646,from:'queued'|'preparing'|'ready'|'served',to:'queued'|'preparing'|'ready'|'served',reason:trimmed string1..240|null}. Move the entire named preparation bucket one step forward. One step backward requires manager and reason. Requires nonempty from bucket and no unacknowledged notices. Moves only those quantities; never resets served work because of additions.
- type='acknowledge': {ticketId:uuid,expectedRevision:int1..2147483646,throughSequence:int1..2147483647}. Acknowledges an explicit prefix greater than acknowledgedSequence and <=eventSequence. Expected ticket revision prevents swallowing a later unseen change. UI must show the whole acknowledged prefix; use detail pagination. Still-pending later notices keep progression blocked.
  ACK {status:'updated',requestId:uuid,replayed:boolean,ticket:Ticket}. For dispatch verify ticket.tabId and ticket.revision=expectedTicketRevision+1; other commands verify ticket.id and revision=expectedRevision+1. Historical ACK remains immutable even after later stage/payment/refund.
  Cancellation {status:'cancelled',requestId:uuid,replayed:boolean}.

## RPCs

pos_execute_tab_kitchen_command(p_command jsonb,p_binding text)
pos_resolve_tab_kitchen_request(p_command jsonb,p_binding text)
pos_list_tab_kitchen(p_branch uuid,p_binding text,p_cursor jsonb default null)
Cursor = {issuedAt:timestamp,id:uuid}.
List = {status:'ready',organizationId:uuid,branchId:uuid,actorRole:'owner'|'manager'|'cashier',generatedAt:timestamp,activeTickets:Ticket[0..100],terminalTickets:Ticket[0..50],activeCount:int0..2147483647,pendingCount:int0..2147483647,activeNextCursor:Cursor|null,terminalTruncated:boolean}.
Actionable means any queued/preparing/ready quantity OR pendingChangeCount>0, irrespective of payment/cancellation/age. Oldest first issuedAt,id; terminal newest updatedAt,id. Counts and pages share one SQL snapshot. pendingCount counts tickets with pending notices, not notice events; <=activeCount. Terminal cancelled/served ticket with notices is never silently hidden in recent history.
pos_get_tab_kitchen(p_branch uuid,p_ticket uuid,p_binding text,p_after_sequence integer default null)
Detail = {status:'ready',organizationId:uuid,branchId:uuid,actorRole:'owner'|'manager'|'cashier',ticket:Ticket,events:Event[0..20],eventsNextAfter:int|null}.
Default afterSequence=acknowledgedSequence (pending notices); explicit0 reads full immutable dispatch history; next is last returned sequence if more. Events ascending sequence.
Event = {sequence:int,generation:int,kind:'dispatch'|'reopen'|'void'|'refund',tabRevision:int,reason:trimmed string1..240|null,createdAt:timestamp,before:{metadata:Metadata,lines:KitchenLine[]}|null,after:{metadata:Metadata,lines:KitchenLine[]},additions:KitchenLine[],withdrawals:Array<{stage:'queued'|'preparing'|'ready'|'served',productId:uuid,name:string,unit:'piece'|'pack'|'kg',quantityMilli:int}>}.
Initial dispatch also requires acknowledgment before preparation. All notices remain until explicitly acknowledged. Price/tax/tender/customer data never appears in this family.

## Void, reopening, payment, refund

Existing manager tab.void command atomically cancels all current preparation buckets and appends visible stop-work notice with its supplied reason. Existing tab.reopen reopens only the draft; explicit manager dispatch starts new preparation and generation. Settled tabs remain non-reopenable. No first-dispatch shift required.

New outer financial wrapper pre-acquires existing authority15/request0/config/device/shift/branch20/tab locks, validates canonical full original request and anti-adoption before any kitchen linkage. For a dispatched tab it checks current kitchen content equals last dispatch (including label/service/table/note/guest/name/unit/quantity), creates a trusted private order→ticket reservation before calling SQL015. The invoice trigger promotes the same ticket in the transaction, preserving first-issued time/buckets/notices/history. It creates no legacy014 ticket or added batch. Ordinary sales and tabs never dispatched keep the legacy014 projection. Full refund finds private mapping, cancels preparation and appends a notice even if previously served. Neither payment nor refund alters any historical command ACK.

Tables: pos_tab_kitchen_tickets (id PK,tab_id unique), pos_tab_kitchen_batches (id PK,ticket_id,immutable initial lines plus mutable remaining lines/stage), pos_tab_kitchen_events ((ticket_id,sequence) PK immutable), pos_tab_kitchen_commands (id PK immutable payload/result), pos_tab_kitchen_request_cancellations (request_id PK immutable), pos_tab_kitchen_payments (order_id PK,ticket_id unique immutable trusted reservation). No direct client grants.

Locks: authority15 shared→new request21→device SHARE→branch20→tab→ticket for dispatch; stage/ack authority15→21→device→ticket only, never order/shift/tab after ticket. Void retains old19→device→20→tab→ticket. New linked payment authority15→request0→config→device→shift→20→tab→products→ticket, then only a provably NEW financial order; no existing order acquisition after ticket. Refund existing device→shift→financial order→ticket, never branch20/tab. Request recovery uses21 and exact actor/branch/device/full payload; inactive own committed ACK and same-actor replacement-device recovery follow existing management policy; unsaved cancellation requires active authority.

Errors: existing POS_ACCESS_DENIED/POS_DEVICE_INVALID/POS_MANAGER_REQUIRED/POS_IDEMPOTENCY_CONFLICT/POS_REQUEST_CANCELLED and menu/financial errors; new POS_INVALID_TAB_KITCHEN_COMMAND/POS_INVALID_TAB_KITCHEN_CURSOR/POS_TAB_KITCHEN_NOT_FOUND/POS_TAB_KITCHEN_CHANGED/POS_TAB_KITCHEN_PENDING_ACK/POS_KITCHEN_NO_CHANGES/POS_KITCHEN_REASON_REQUIRED/POS_KITCHEN_TRANSITION_INVALID/POS_KITCHEN_DISPATCH_REQUIRED/POS_KITCHEN_CANCELLED/POS_KITCHEN_LIMIT. Tab state/revision errors retain POS_TAB_CHANGED/POS_TAB_NOT_FOUND/POS_TAB_ALREADY_SETTLED/POS_TAB_STATE_INVALID.

Addition: pos_get_tab_kitchen_for_tab(p_branch uuid,p_tab uuid,p_binding text) returns {status:'ready',organizationId,branchId,actorRole,tabId,tabRevision,ticket:Ticket|null,dispatchRequired:boolean}. Current scoped open tab only. No ticket => false (legacy payment remains possible). Existing cancelled ticket or changed current kitchen content => true. Acknowledgement/cancellation requires active branch authority, not the original mutation's manager role; committed historical lookup remains read-only for inactive actors.

## Release and rollback constraint

After any SQL016 dispatch, a promoted paid order intentionally has no SQL014 ticket. Rolling the frontend back to an older kitchen reader would hide active preparation and unacknowledged change/stop/refund notices. A safe fallback must retain read/recovery/stage/acknowledgement support for both kitchen families, while optionally disabling new dispatch. Do not present database compatibility as proof that an old-only frontend rollback is operationally safe. Preserve immutable history and payment links; do not backfill duplicate legacy preparation as a rollback workaround.
