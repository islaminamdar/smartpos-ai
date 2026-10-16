# Kitchen station workflow — SQL032 contract

Frozen implementation contract, 2026-10-16. Root approved the default-off routing direction, partial-credit notice-only behavior, and SQL-level legacy-list exclusion with correct counts/paging. SQL032 implementation has resumed; no production admission is enabled. No activation is established by this document.

## Routing admission and compatibility

A private `pos_kitchen_station_policy` table has one optional branch row with `enabled=false` by default. The migration inserts no enabled rows and exposes no client policy setter. Only a new paid kitchen ticket or new unpaid kitchen ticket created while its branch is explicitly enabled receives a routed root. Existing legacy tickets never change mode, including later dispatches/reopening. Once routed, a root remains routed even if the policy is later disabled. Already routed work must remain readable and actionable; rollback may disable new admission but must retain its reader, scoped commands and recovery.

Unassigned products belong to General, represented on the wire by `stationId:null` and `stationName:"General"`. Internally, an explicit `station_key='general'` avoids SQL NULL uniqueness holes. Real stations use canonical UUID text keys. Each snapshot stores both identity and name; later renaming, assignment changes and archival cannot move previous preparation.

Partial credits preserve SQL030 behavior: they create notices and do not rewrite preparation quantities or stages. Full refunds cancel existing preparation as before. Unpaid withdrawals reduce the existing batch ledger as before. Financial return quantities and preparation quantities must not be silently conflated.

## Storage

All new tables enable RLS and revoke all direct grants from public/anon/authenticated/service_role. Roots and policy are tenant-bound. Root paid orders and unpaid tickets have matching organization/branch composite foreign keys; product ownership also has a matching root/generation/work composite foreign key. Batch-to-work and invoice-to-work mappings have individual identity foreign keys and are created only by private authoritative projection helpers from the same locked parent. They do not claim a database-level composite constraint across the entire mapping chain. Immutable mapping, notice, acknowledgement and request rows reject UPDATE/DELETE.

- `pos_kitchen_station_policy`: branch, organization, enabled. No initial activation.
- `pos_kitchen_station_roots`: generated ID; organization/branch; family `paid|tab`; unique underlying paid order or unpaid ticket; Mode never changes. A promoted unpaid root remains family `tab`.
- `pos_kitchen_station_work`: generated work ID; root ID; generation; station key/ID/name; per-work revision and timestamps; paid child stage where applicable. Unique `(root_id,generation,station_key)`; General identity is explicit. Tab stages derive solely from batches, never a duplicate quantity table.
- `pos_kitchen_station_product_ownership`: immutable `(root_id,generation,product_id)` to work ID and station snapshot. It survives all quantity withdrawals; re-adding that product in the same generation uses the original station.
- `pos_kitchen_station_batch_ownership`: immutable existing batch ID to work ID. All tab quantities remain in `pos_tab_kitchen_batches`.
- `pos_kitchen_station_invoice_lines`: immutable original `(invoice_id,line_number)` to work ID and original kitchen line snapshot. Ordinary paid lines are routed once. Promotion maps invoice lines to the already dispatched generation/ownership, creating no paid preparation or new quantity.
- `pos_kitchen_station_notices`: immutable work ID, per-work sequence, generated notice ID, source identity, kind, reason/time and station-filtered before/after/addition/withdrawal/return detail. Source identity deduplicates document and event projection. No prices or customer data.
- `pos_kitchen_station_notice_acknowledgements`: immutable notice ID, actor/device and acknowledgement time. Each affected station has an independent notice obligation.
- `pos_kitchen_station_work_commands`: immutable actor/org/branch/original device, exact command, applied/cancelled result and timestamp.

## Integration mechanism

New private triggers attach routing on ticket creation, batch creation, immutable tab events and invoice/credit projection. Each hook is part of the original transaction. The final SQL030 document projection remains the financial/preparation authority; its offline-import exclusion must run before station projection too.

Routing configuration is read using one statement snapshot, without acquiring configuration lock44 after an order, product or ticket. No stage, historical recovery or acknowledgement reads current product assignments. Batch hooks bind first product/generation ownership while the existing ticket lock serializes dispatch; subsequent batches reuse that immutable mapping.

Cancellation events are emitted before batches are zeroed by `pos_cancel_tab_kitchen`; their station targets must be derived then from historical ownership. Metadata changes notify every affected station, including relevant zero-quantity work. Reopening creates a new generation while prior-generation pending notices remain visible. Refund-generated tab events must not duplicate the corresponding credit notice obligation.

Payment continues to use the existing private `pos_tab_kitchen_payments` link. Invoice projection freezes line ownership onto the same unpaid root/batches; no ordinary paid ticket/child is manufactured. Partial credit routing uses the immutable invoice-line mapping, including duplicate products on ordinary invoices. Full refunds preserve each station obligation after cancellation.

Paid parent status is the least advanced noncancelled child stage (`queued < preparing < ready < served`); it is served only when all live children are served. Full refund cancels parent and children. Updating one station never moves another station's quantities. Existing parent revisions still advance for relevant mutations, while new commands compare the target work revision so independent stations do not reject solely because another station advanced.

Legacy whole-ticket stage and whole-event/return acknowledgement entry points reject new actions against routed work with `POS_KITCHEN_STATION_REQUIRED`. They still delegate exact previously committed requests and their recovery to the existing immutable acknowledgement stores. Private legacy helpers remain non-callable. Legacy stage guards keep their current behavior for legacy work; routed batch guards examine only that batch's work notices. A scoped ACK never clears another station's obligation. Aggregate legacy return acknowledgement/event high-water marks may advance only after all station obligations for that source are acknowledged.

Proposed reader compatibility: existing paid/unpaid/return list functions exclude routed roots/notices in SQL before pagination/counting; the new station board lists routed work. Existing tab-specific dispatch detail still identifies its existing ticket/revision for dispatch. This avoids duplicate cards while retaining legacy work. Root confirmed this compatibility choice.

## Wire

All objects are strict. UUIDs are canonical lowercase, integers are JSON numbers and timestamps are UTC strings. Configured station names use SQL031 validation; the server-owned General/null snapshot is the explicit reserved-name exception. Product names retain existing menu/kitchen limits (1–200 characters), not the station-name limit. Neither station names nor product allocations are caller-chosen in workflow commands.

`PreparationLine = {productId,name,unit,quantityMilli}`. Quantities are positive milli-units; each stage array is bounded to 200 products. The four stage arrays remain `queued`, `preparing`, `ready`, `served`.

`StationWork = {id,branchId,family,stationId,stationName,generation,revision,orderId,tabId,ticketId,invoiceId,invoiceNumber,payment,state,metadata,stages,pendingNoticeCount,issuedAt,updatedAt}`.

- `family` is `paid|tab`; `payment` is `unpaid|paid|refunded`; `state` is `open|cancelled`.
- `orderId/invoiceId/invoiceNumber` are null before unpaid promotion. `tabId/ticketId` are null for ordinary paid work.
- `metadata = {label,serviceType,tableId,tableName,guestCount,note}` matches existing unpaid metadata; ordinary paid work uses its actual service type and null optional fields.
- `stages` contains only this work's quantities. Cancelled/zero-quantity work has empty stage arrays but can remain actionable through notices.

List RPC: `pos_list_kitchen_station_work(p_branch uuid,p_device uuid,p_binding text,p_query jsonb)`.

Query: `{station:"all"|"general"|uuid,view:"active"|"history",cursor:{at,id}|null}`. Active means pending notices OR any queued/preparing/ready quantity; fully served/cancelled work without pending notices belongs to history. Active pages order `(issuedAt,id)` ascending; history pages order `(updatedAt,id)` descending. Max100 rows, exclusive cursor, no silent truncation.

Result: `{status:"ready",organizationId,branchId,actorRole,generatedAt,items:StationWork[],matchingCount,nextCursor,attentionCount,stations:[{stationId,name,active,activeCount,pendingNoticeCount}]}`. `attentionCount` and station counts cover the entire branch regardless of selected filter; selector includes General and archived stations. One statement snapshot supplies list, counts and next cursor.

Detail RPC: `pos_get_kitchen_station_work(p_branch uuid,p_device uuid,p_binding text,p_work uuid,p_query jsonb)`.

Query: `{noticeView:"pending"|"all",afterSequence:integer}`. Result: `{status:"ready",organizationId,branchId,actorRole,work:StationWork,notices:StationNotice[0..50],noticeCount,nextAfterSequence:integer|null}`. Notice pages use exclusive per-work sequence ascending.

`StationNotice = {id,workId,sequence,kind,createdAt,reason,source,detail,acknowledgedAt}`. Sequence is 1–2147483647, `reason` is null or the existing validated 1–240-character reason, and `acknowledgedAt` is null or a UTC timestamp. The proposed exact discriminated union is:

- `kind: "dispatch"|"reopen"|"void"`: `source = {ticketId,eventSequence,tabRevision}`; `detail = {metadataBefore,metadataAfter,beforeLines,afterLines,additions,withdrawals}`. Metadata uses the exact `StationWork.metadata` object; `metadataBefore` alone may be null on initial dispatch. Before/after/addition arrays use `PreparationLine`, filtered to this work. Withdrawals use `{stage,productId,name,unit,quantityMilli}` with stage `queued|preparing|ready|served`. Arrays are bounded to 200 except withdrawals, bounded to 800 (200 products × four stages), and repeated compatible entries are aggregated. Metadata-only events retain this exact shape with empty addition/withdrawal arrays.
- `kind: "return"`: `source = {invoiceId,invoiceNumber,creditNoteId,creditNumber,fullyReturned}`; `detail = {lines:[{originalLineNumber,productId,name,unit,quantityMilli,remainingQuantityMilli}]}`. Lines are sorted by original line number, max200; quantity is positive, remaining quantity nonnegative. Both values come from the immutable credit/invoice and historical line ownership. No monetary/customer fields are exposed. Legacy full credits use their immutable original invoice lines with remaining quantity zero.

- `kind: "cancel"`: uses the same invoice/credit source as return with `fullyReturned:true`; `detail = {lines: PreparationLine[1..200]}`. When a final credit cancels preparation at a station with no lines in that credit, this separate notice preserves the positive preparation snapshot immediately before cancellation. It does not fabricate financial return quantities. Stations already receiving that credit's return notice do not also receive cancel. Aggregate legacy ACK waits for both kinds for the credit ID. Event high-water calculations exclude both kinds.

Source objects reject extra fields. Every notice belongs to exactly one work row and carries only that station's affected lines. Root/API confirmed this notice union before implementation.

Mutation RPC: `pos_execute_kitchen_station_work_command(p_command jsonb,p_binding text)`.

Common fields: `{id,branchId,deviceId,workId,expectedRevision,type}`.

- `type:"stage"`: adds `{from,to,reason}`. Adjacent forward transitions are permitted for current branch staff; one step backwards requires owner/manager and nonempty reason. It moves only positive quantities currently in the specified source stage for this work. Pending notices for this work block stage movement.
- `type:"notice.ack"`: adds `{noticeId}`. Only a notice owned by this work can be acknowledged. Already acknowledged notices with a fresh request fail as no-change; exact request replay returns the original acknowledgement.

Applied result: `{status:"updated",requestId,branchId,replayed,work:StationWork,acknowledgedNoticeId:uuid|null}`. Work revision equals expectedRevision+1. Stage result must match the requested target movement; acknowledgement result binds the exact notice ID. Exact replay changes only `replayed`.

Recovery RPC: `pos_resolve_kitchen_station_work_request(p_command jsonb,p_binding text)`. Exact saved result recovery and missing-request cancellation follow SQL031 original-actor/original-device historical or current replacement rules. Cancellation: `{status:"cancelled",requestId,branchId,workId,replayed}`; it permanently blocks the exact delayed command.

## Locking and acceptance

Request namespace46 is reserved after checking SQL001–031; none uses46. Actor gate15 precedes request lock. Current branch/staff/device/binding revocation locks precede order/ticket. Paid stage/ACK takes order then ticket/root/work; unpaid stage/ACK takes existing unpaid ticket then work, and must never acquire order/tab/config/shift afterwards. Refund already takes order then unpaid ticket. Dispatch retains branch20/tab/product/ticket ordering and does not acquire config44. Every source notice and stage command serializes on the same underlying parent ticket; independent child revisions keep station actions scoped.

Required actual PostgreSQL cases include mixed stations/General in both families; independent stages and ACKs; served quantities plus additions; same-generation removal/re-add after reassignment; weighted withdrawals; metadata-only events; void/reopen with old notices; payment without duplicate preparation; partial/final credits and duplicate-product invoice mapping; archived work; legacy guards and exact old recovery; complete active/history/notice pagination; audit failure rollback; tenant/actor/revocation and request cancellation races; stage/refund, stage/payment, dispatch/config, withdrawal/stage and ACK/new-notice races.

No policy enabling, public allowlist change, deployment, printer support or physical-device acceptance is authorized by this document.


## Implementation decisions frozen at resume

Unpaid dispatch uses a private `pos_kitchen_station_dispatch_context` row keyed by `txid_current()` and the immutable request ID. The dispatch wrapper first acquires actor/request/device/binding/branch20/tab locks, captures policy, configuration revision and routes for all current tab products in ONE statement, and delegates the existing dispatch. Row triggers consume that trusted transaction context; no caller GUC supplies routing. The row is deleted before the wrapper returns; exceptions roll back its creation. Existing ownership is reused. This is bounded by the existing200-product tab limit and does not acquire config44. Paid ticket creation captures all invoice lines/routes in one statement.

`pos_kitchen_station_generations` stores metadata/state/payment/invoice linkage per root+generation; old cancelled unpaid generations never inherit later payment. Batch ownership uses NEW.generation, including reopen batches inserted before their parent's generation changes. Event projection updates only the source generation; promotion links only its actual invoiced generation.

Stage quantities are grouped per product/name/unit and bounded at200000000 (ordinary invoice duplicates can sum200 lines×1000000); tabs remain bounded by their existing per-product limits. Product name length is1..200. Metadata tablabel≤120, tabnote≤400, tableName≤80, guestCount1..99; ordinary paid label/note/table/guest fields are null. All timestamps are UTC with six fractional digits to preserve cursor microseconds.

`attentionCount` counts branch-wide work rows with pending notices. Selector `pendingNoticeCount` counts individual unacknowledged notices; `activeCount` counts active work rows. `matchingCount` counts the selected filter/view before the cursor. General plus all configured archived/active stations are included (max129). Current selector names may differ from historical work names.

The earlier handover questions are resolved by these decisions. Implementation and actual PostgreSQL/browser acceptance remain pending until their evidence is recorded.
