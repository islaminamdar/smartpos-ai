-- Unpaid preparation uses its own identity and immutable dispatch history.
-- Existing paid kitchen tickets/requests remain byte-compatible.
create table public.pos_tab_kitchen_tickets(
 id uuid primary key default gen_random_uuid(),tab_id uuid not null unique,organization_id uuid not null,branch_id uuid not null,
 revision integer not null default 1 check(revision>0),generation integer not null default 1 check(generation>0),dispatched_tab_revision integer not null,
 state text not null default 'open' check(state in ('open','cancelled')),payment text not null default 'unpaid' check(payment in ('unpaid','paid','refunded')),
 paid_order_id uuid unique,invoice_id uuid unique references public.pos_documents,invoice_number text,paid_at timestamptz,refunded_at timestamptz,
 metadata jsonb not null,lines jsonb not null default '[]',event_sequence integer not null default 0,acknowledged_sequence integer not null default 0,
 issued_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,branch_id,tab_id) references public.pos_open_tabs(organization_id,branch_id,id),
 foreign key(organization_id,branch_id,paid_order_id) references public.pos_orders(organization_id,branch_id,id),
 check(acknowledged_sequence between 0 and event_sequence),check(event_sequence>=0),
 check((payment='unpaid')=(paid_order_id is null)),check((payment='unpaid')=(invoice_id is null)),check((payment='unpaid')=(invoice_number is null)),check((payment='unpaid')=(paid_at is null)),
 check((payment='refunded')=(refunded_at is not null)),check(payment<>'refunded' or state='cancelled'),
 check(jsonb_typeof(lines)='array' and jsonb_array_length(lines)<=200)
);
create index pos_tab_kitchen_branch on public.pos_tab_kitchen_tickets(branch_id,issued_at,id);
-- One row per positive addition: original identity/quantity is immutable; withdrawals
-- reduce only remaining quantity. Bucket movement never manufactures new preparation.
create table public.pos_tab_kitchen_batches(
 id uuid primary key default gen_random_uuid(),ticket_id uuid not null references public.pos_tab_kitchen_tickets,
 generation integer not null,dispatch_sequence integer not null,product_id uuid not null,name text not null,unit text not null check(unit in ('piece','pack','kg')),
 initial_name text not null,initial_quantity_milli integer not null check(initial_quantity_milli between 1 and 1000000),
 quantity_milli integer not null check(quantity_milli>=0),stage text not null default 'queued' check(stage in ('queued','preparing','ready','served','cancelled')),
 created_at timestamptz not null default clock_timestamp(),check(quantity_milli<=initial_quantity_milli),check((quantity_milli=0)=(stage='cancelled'))
);
create index pos_tab_kitchen_batch_ticket on public.pos_tab_kitchen_batches(ticket_id,stage,product_id);
create table public.pos_tab_kitchen_events(ticket_id uuid not null references public.pos_tab_kitchen_tickets,sequence integer not null,event jsonb not null,primary key(ticket_id,sequence));
create table public.pos_tab_kitchen_commands(id uuid primary key,organization_id uuid not null,branch_id uuid not null,actor_id uuid not null references auth.users,payload jsonb not null,result jsonb not null,created_at timestamptz not null default clock_timestamp(),foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id));
create table public.pos_tab_kitchen_request_cancellations(request_id uuid primary key,organization_id uuid not null,branch_id uuid not null,actor_id uuid not null references auth.users,payload jsonb not null,created_at timestamptz not null default clock_timestamp(),foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id));
-- The only pre-invoice routing authority. No custom GUC or caller-chosen ticket link.
create table public.pos_tab_kitchen_payments(order_id uuid primary key,ticket_id uuid not null unique references public.pos_tab_kitchen_tickets,organization_id uuid not null,branch_id uuid not null,actor_id uuid not null references auth.users,created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,branch_id,order_id) references public.pos_orders(organization_id,branch_id,id) deferrable initially deferred);
do $$declare t text;begin
 foreach t in array array['pos_tab_kitchen_tickets','pos_tab_kitchen_batches','pos_tab_kitchen_events','pos_tab_kitchen_commands','pos_tab_kitchen_request_cancellations','pos_tab_kitchen_payments'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);
 end loop;
 foreach t in array array['pos_tab_kitchen_events','pos_tab_kitchen_commands','pos_tab_kitchen_request_cancellations','pos_tab_kitchen_payments'] loop
 execute format('create trigger %I before update or delete on public.%I for each row execute function public.pos_preserve_document()',t||'_immutable',t);
 end loop;
end $$;
create function public.pos_preserve_kitchen_batch() returns trigger language plpgsql set search_path='' as $$begin
 if tg_op='DELETE' or row(new.id,new.ticket_id,new.generation,new.dispatch_sequence,new.product_id,new.unit,new.initial_name,new.initial_quantity_milli,new.created_at) is distinct from row(old.id,old.ticket_id,old.generation,old.dispatch_sequence,old.product_id,old.unit,old.initial_name,old.initial_quantity_milli,old.created_at) then raise exception 'POS_IMMUTABLE_DOCUMENT'; end if;
 return new;
end $$;
revoke all on function public.pos_preserve_kitchen_batch() from public,anon,authenticated;
create trigger pos_tab_kitchen_batch_immutable before update or delete on public.pos_tab_kitchen_batches for each row execute function public.pos_preserve_kitchen_batch();
create function public.pos_tab_kitchen_content(p public.pos_open_tabs) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('metadata',jsonb_build_object('label',p.label,'serviceType',p.service_type,'tableId',p.table_id,'tableName',(select name from public.pos_dining_tables where id=p.table_id),'guestCount',p.guest_count,'note',p.note),
 'lines',(select coalesce(jsonb_agg(jsonb_build_object('productId',l->'productId','name',l->'name','unit',l->'unit','quantityMilli',l->'quantityMilli') order by l->>'productId'),'[]') from jsonb_array_elements(p.lines) l))
$$;
create function public.pos_tab_kitchen_stages(p_id uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_object_agg(s,coalesce((select jsonb_agg(jsonb_build_object('productId',q.product_id,'name',q.name,'unit',q.unit,'quantityMilli',q.quantity) order by q.product_id) from
 (select product_id,name,unit,sum(quantity_milli) quantity from public.pos_tab_kitchen_batches where ticket_id=p_id and stage=s and quantity_milli>0 group by product_id,name,unit) q),'[]')) from unnest(array['queued','preparing','ready','served']) s
$$;
create function public.pos_tab_kitchen_snapshot(p public.pos_tab_kitchen_tickets) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p.id,'tabId',p.tab_id,'branchId',p.branch_id,'revision',p.revision,'generation',p.generation,'dispatchedTabRevision',p.dispatched_tab_revision,'state',p.state,'payment',p.payment,
 'paidOrderId',p.paid_order_id,'invoiceId',p.invoice_id,'invoiceNumber',p.invoice_number,'paidAt',p.paid_at,'refundedAt',p.refunded_at,'metadata',p.metadata,'lines',p.lines,'stages',public.pos_tab_kitchen_stages(p.id),
 'eventSequence',p.event_sequence,'acknowledgedSequence',p.acknowledged_sequence,'pendingChangeCount',p.event_sequence-p.acknowledged_sequence,'issuedAt',p.issued_at,'updatedAt',p.updated_at)
$$;
revoke all on function public.pos_tab_kitchen_content(public.pos_open_tabs),public.pos_tab_kitchen_stages(uuid),public.pos_tab_kitchen_snapshot(public.pos_tab_kitchen_tickets) from public,anon,authenticated;
create function public.pos_validate_tab_kitchen_command(p jsonb) returns void language plpgsql set search_path='' as $$
declare keys text[];
begin
 if jsonb_typeof(p) is distinct from 'object' or coalesce(p->>'type','') not in ('dispatch','stage','acknowledge') then raise exception 'POS_INVALID_TAB_KITCHEN_COMMAND';end if;
 keys:=array['id','branchId','deviceId','type'];
 if p->>'type'='dispatch' then keys:=keys||array['tabId','expectedTabRevision','expectedTicketRevision','reason'];
 elsif p->>'type'='stage' then keys:=keys||array['ticketId','expectedRevision','from','to','reason'];
 else keys:=keys||array['ticketId','expectedRevision','throughSequence'];end if;
 if not p ?& keys or p-keys<>'{}'::jsonb or jsonb_typeof(p->'id') is distinct from 'string' or jsonb_typeof(p->'branchId') is distinct from 'string' or jsonb_typeof(p->'deviceId') is distinct from 'string' then raise exception 'POS_INVALID_TAB_KITCHEN_COMMAND';end if;
 perform(p->>'id')::uuid;perform(p->>'branchId')::uuid;perform(p->>'deviceId')::uuid;
 if p->>'type'='dispatch' then
 if jsonb_typeof(p->'tabId') is distinct from 'string' or not public.pos_offer_integer(p->'expectedTabRevision',1,2147483646) or not public.pos_offer_integer(p->'expectedTicketRevision',0,2147483646) then raise exception 'POS_INVALID_TAB_KITCHEN_COMMAND';end if;perform(p->>'tabId')::uuid;
 else
 if jsonb_typeof(p->'ticketId') is distinct from 'string' or not public.pos_offer_integer(p->'expectedRevision',1,2147483646) then raise exception 'POS_INVALID_TAB_KITCHEN_COMMAND';end if;perform(p->>'ticketId')::uuid;
 end if;
 if p->>'type'='acknowledge' then
 if not public.pos_offer_integer(p->'throughSequence',1,2147483647) then raise exception 'POS_INVALID_TAB_KITCHEN_COMMAND';end if;
 else
 if p->'reason'<>'null'::jsonb and (jsonb_typeof(p->'reason') is distinct from 'string' or length(p->>'reason') not between 1 and 240 or p->>'reason'<>trim(p->>'reason')) then raise exception 'POS_INVALID_TAB_KITCHEN_COMMAND';end if;
 end if;
 if p->>'type'='stage' and (coalesce(p->>'from','') not in ('queued','preparing','ready','served') or coalesce(p->>'to','') not in ('queued','preparing','ready','served')) then raise exception 'POS_INVALID_TAB_KITCHEN_COMMAND';end if;
exception when invalid_text_representation then raise exception 'POS_INVALID_TAB_KITCHEN_COMMAND';end $$;
revoke all on function public.pos_validate_tab_kitchen_command(jsonb) from public,anon,authenticated;
create function public.pos_list_tab_kitchen(p_branch uuid,p_binding text,p_cursor jsonb default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid; role_name text; after_time timestamptz; after_id uuid; result jsonb;
begin
 org:=public.pos_tab_scope(p_branch,p_binding);select role into role_name from public.pos_staff where organization_id=org and user_id=auth.uid();
 if p_cursor is not null then
 if jsonb_typeof(p_cursor) is distinct from 'object' or not p_cursor ?& array['issuedAt','id'] or p_cursor-array['issuedAt','id']<>'{}'::jsonb or jsonb_typeof(p_cursor->'issuedAt') is distinct from 'string' or jsonb_typeof(p_cursor->'id') is distinct from 'string' then raise exception 'POS_INVALID_TAB_KITCHEN_CURSOR';end if;
 after_time:=(p_cursor->>'issuedAt')::timestamptz;after_id:=(p_cursor->>'id')::uuid;if not isfinite(after_time) then raise exception 'POS_INVALID_TAB_KITCHEN_CURSOR';end if;
 end if;
 with scoped as materialized(select t.id,t.issued_at,t.updated_at,t.event_sequence,t.acknowledged_sequence,t.event_sequence>t.acknowledged_sequence or exists(select 1 from public.pos_tab_kitchen_batches b where b.ticket_id=t.id and b.stage in ('queued','preparing','ready') and b.quantity_milli>0) actionable from public.pos_tab_kitchen_tickets t where t.organization_id=org and t.branch_id=p_branch),
 active as not materialized(select * from scoped where actionable),page as materialized(select * from active where after_time is null or (issued_at,id)>(after_time,after_id) order by issued_at,id limit 101),shown as materialized(select * from page order by issued_at,id limit 100),
 closed as materialized(select * from scoped where not actionable order by updated_at desc,id desc limit 51),recent as materialized(select * from closed order by updated_at desc,id desc limit 50)
 select jsonb_build_object('status','ready','organizationId',org,'branchId',p_branch,'actorRole',role_name,'generatedAt',clock_timestamp(),
 'activeTickets',(select coalesce(jsonb_agg(public.pos_tab_kitchen_snapshot(t) order by t.issued_at,t.id),'[]') from public.pos_tab_kitchen_tickets t join shown s on s.id=t.id),
 'terminalTickets',(select coalesce(jsonb_agg(public.pos_tab_kitchen_snapshot(t) order by t.updated_at desc,t.id desc),'[]') from public.pos_tab_kitchen_tickets t join recent r on r.id=t.id),
 'activeCount',(select count(*) from active),'pendingCount',(select count(*) from active where event_sequence>acknowledged_sequence),
 'activeNextCursor',case when (select count(*) from page)>100 then(select jsonb_build_object('issuedAt',issued_at,'id',id) from shown order by issued_at desc,id desc limit 1) else null end,'terminalTruncated',(select count(*)>50 from closed)) into result;
 if (result->>'activeCount')::bigint>2147483647 then raise exception 'POS_KITCHEN_LIMIT';end if;
 return result;
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then raise exception 'POS_INVALID_TAB_KITCHEN_CURSOR';end $$;
create function public.pos_get_tab_kitchen(p_branch uuid,p_ticket uuid,p_binding text,p_after_sequence integer default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid; role_name text; result jsonb;
begin
 org:=public.pos_tab_scope(p_branch,p_binding);select role into role_name from public.pos_staff where organization_id=org and user_id=auth.uid();
 if p_after_sequence<0 then raise exception 'POS_INVALID_TAB_KITCHEN_CURSOR';end if;
 with item as materialized(select * from public.pos_tab_kitchen_tickets where id=p_ticket and organization_id=org and branch_id=p_branch),
 events as materialized(select e.* from public.pos_tab_kitchen_events e join item t on t.id=e.ticket_id where e.sequence>coalesce(p_after_sequence,t.acknowledged_sequence) order by e.sequence limit 21),
 shown as materialized(select * from events order by sequence limit 20)
 select jsonb_build_object('status','ready','organizationId',org,'branchId',p_branch,'actorRole',role_name,'ticket',public.pos_tab_kitchen_snapshot(t),
 'events',(select coalesce(jsonb_agg(event order by sequence),'[]') from shown),'eventsNextAfter',case when(select count(*) from events)>20 then(select max(sequence) from shown) else null end) into result from item t;
 if result is null then raise exception 'POS_TAB_KITCHEN_NOT_FOUND';end if;return result;
end $$;
create function public.pos_get_tab_kitchen_for_tab(p_branch uuid,p_tab uuid,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid; role_name text; result jsonb;
begin
 org:=public.pos_tab_scope(p_branch,p_binding);select role into role_name from public.pos_staff where organization_id=org and user_id=auth.uid();
 select jsonb_build_object('status','ready','organizationId',org,'branchId',p_branch,'actorRole',role_name,'tabId',s.id,'tabRevision',s.revision,
 'ticket',case when t.id is null then null else public.pos_tab_kitchen_snapshot(t) end,
 'dispatchRequired',t.id is not null and (t.state='cancelled' or public.pos_tab_kitchen_content(s)<>jsonb_build_object('metadata',t.metadata,'lines',t.lines))) into result
 from public.pos_open_tabs s left join public.pos_tab_kitchen_tickets t on t.tab_id=s.id where s.id=p_tab and s.organization_id=org and s.branch_id=p_branch and s.status='open';
 if result is null then raise exception 'POS_TAB_NOT_FOUND';end if;return result;
end $$;
revoke all on function public.pos_list_tab_kitchen(uuid,text,jsonb),public.pos_get_tab_kitchen(uuid,uuid,text,integer),public.pos_get_tab_kitchen_for_tab(uuid,uuid,text) from public,anon;
grant execute on function public.pos_list_tab_kitchen(uuid,text,jsonb),public.pos_get_tab_kitchen(uuid,uuid,text,integer),public.pos_get_tab_kitchen_for_tab(uuid,uuid,text) to authenticated;

create function public.pos_execute_tab_kitchen_command(p_command jsonb,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid;branch uuid;device uuid;v_request uuid;kind text;role_name text;previous public.pos_tab_kitchen_commands;cancelled public.pos_tab_kitchen_request_cancellations;
 tab public.pos_open_tabs;ticket public.pos_tab_kitchen_tickets;batch public.pos_tab_kitchen_batches;content jsonb;before_content jsonb;old_line jsonb;new_line jsonb;additions jsonb:='[]';withdrawals jsonb:='[]';
 need bigint;take_qty integer;old_qty integer;new_qty integer;result jsonb;fresh boolean:=false;reopening boolean:=false;now_at timestamptz;seq integer;old_rank integer;new_rank integer;
begin
 perform public.pos_validate_tab_kitchen_command(p_command);branch:=(p_command->>'branchId')::uuid;device:=(p_command->>'deviceId')::uuid;v_request:=(p_command->>'id')::uuid;kind:=p_command->>'type';
 org:=public.pos_tab_scope(branch,p_binding,device);perform pg_advisory_xact_lock(hashtextextended(v_request::text,21));
 select * into previous from public.pos_tab_kitchen_commands where id=v_request;
 if found then if previous.organization_id<>org or previous.branch_id<>branch or previous.actor_id<>auth.uid() or previous.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;return previous.result||'{"replayed":true}'::jsonb;end if;
 select * into cancelled from public.pos_tab_kitchen_request_cancellations where request_id=v_request;
 if found then if cancelled.organization_id<>org or cancelled.branch_id<>branch or cancelled.actor_id<>auth.uid() or cancelled.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;raise exception 'POS_REQUEST_CANCELLED';end if;
 select role into role_name from public.pos_staff where organization_id=org and user_id=auth.uid();
 perform 1 from public.pos_devices where id=device and organization_id=org and branch_id=branch and active for share;if not found then raise exception 'POS_DEVICE_INVALID';end if;
 if kind='dispatch' then
 perform pg_advisory_xact_lock(hashtextextended(branch::text,20));
 select * into tab from public.pos_open_tabs where id=(p_command->>'tabId')::uuid and organization_id=org and branch_id=branch for update;
 if not found then raise exception 'POS_TAB_NOT_FOUND';end if;
 if tab.status='settled' then raise exception 'POS_TAB_ALREADY_SETTLED';end if;if tab.status<>'open' then raise exception 'POS_TAB_STATE_INVALID';end if;
 if tab.revision<>(p_command->>'expectedTabRevision')::integer then raise exception 'POS_TAB_CHANGED';end if;
 -- Menu check is authoritative even though prices never enter the kitchen snapshot.
 perform public.pos_offer_catalogue_lines(org,branch,tab.request_lines,true);content:=public.pos_tab_kitchen_content(tab);
 select * into ticket from public.pos_tab_kitchen_tickets where tab_id=tab.id for update;
 fresh:=not found;
 if fresh then
 if (p_command->>'expectedTicketRevision')::integer<>0 then raise exception 'POS_TAB_KITCHEN_CHANGED';end if;
 insert into public.pos_tab_kitchen_tickets(tab_id,organization_id,branch_id,dispatched_tab_revision,metadata) values(tab.id,org,branch,tab.revision,content->'metadata') returning * into ticket;before_content:=null;
 else
 if ticket.revision<>(p_command->>'expectedTicketRevision')::integer then raise exception 'POS_TAB_KITCHEN_CHANGED';end if;
 if ticket.payment<>'unpaid' then raise exception 'POS_TAB_ALREADY_SETTLED';end if;
 reopening:=ticket.state='cancelled';before_content:=jsonb_build_object('metadata',ticket.metadata,'lines',ticket.lines);
 if reopening then
 if role_name not in ('owner','manager') then raise exception 'POS_MANAGER_REQUIRED';end if;if p_command->'reason'='null'::jsonb then raise exception 'POS_KITCHEN_REASON_REQUIRED';end if;
 elsif content=before_content then raise exception 'POS_KITCHEN_NO_CHANGES';end if;
 end if;
 if ticket.event_sequence=2147483647 or ticket.generation=2147483647 then raise exception 'POS_KITCHEN_LIMIT';end if;
 seq:=ticket.event_sequence+1;now_at:=clock_timestamp();
 -- Withdraw queued quantities first, then the newest working quantities. Never
 -- subtract incompatible units, and never conceal already-started waste.
 for old_line in select value from jsonb_array_elements(ticket.lines) loop
 select value into new_line from jsonb_array_elements(content->'lines') where value->>'productId'=old_line->>'productId';
 need:=(old_line->>'quantityMilli')::integer-case when new_line->>'unit'=old_line->>'unit' then least((old_line->>'quantityMilli')::integer,(new_line->>'quantityMilli')::integer) else 0 end;
 for batch in select * from public.pos_tab_kitchen_batches b where b.ticket_id=ticket.id and b.product_id=(old_line->>'productId')::uuid and b.quantity_milli>0 order by array_position(array['queued','preparing','ready','served'],b.stage),b.created_at desc,b.id desc for update loop
 exit when need=0;take_qty:=least(need,batch.quantity_milli);
 if batch.stage<>'queued' then if role_name not in ('owner','manager') then raise exception 'POS_MANAGER_REQUIRED';end if;if p_command->'reason'='null'::jsonb then raise exception 'POS_KITCHEN_REASON_REQUIRED';end if;end if;
 withdrawals:=withdrawals||jsonb_build_array(jsonb_build_object('stage',batch.stage,'productId',batch.product_id,'name',batch.name,'unit',batch.unit,'quantityMilli',take_qty));
 update public.pos_tab_kitchen_batches set quantity_milli=quantity_milli-take_qty,stage=case when quantity_milli=take_qty then 'cancelled' else stage end where id=batch.id;need:=need-take_qty;
 end loop;
 if need<>0 then raise exception 'POS_TAB_KITCHEN_CHANGED';end if;
 end loop;
 for new_line in select value from jsonb_array_elements(content->'lines') loop
 select value into old_line from jsonb_array_elements(ticket.lines) where value->>'productId'=new_line->>'productId';
 old_qty:=case when old_line->>'unit'=new_line->>'unit' then (old_line->>'quantityMilli')::integer else 0 end;new_qty:=greatest((new_line->>'quantityMilli')::integer-old_qty,0);
 -- Renaming keeps the existing quantities and stage, but remains a visible event.
 update public.pos_tab_kitchen_batches set name=new_line->>'name' where ticket_id=ticket.id and product_id=(new_line->>'productId')::uuid and quantity_milli>0;
 if new_qty>0 then
 additions:=additions||jsonb_build_array(new_line||jsonb_build_object('quantityMilli',new_qty));
 insert into public.pos_tab_kitchen_batches(ticket_id,generation,dispatch_sequence,product_id,name,initial_name,unit,initial_quantity_milli,quantity_milli,created_at)
 values(ticket.id,ticket.generation+case when reopening then 1 else 0 end,seq,(new_line->>'productId')::uuid,new_line->>'name',new_line->>'name',new_line->>'unit',new_qty,new_qty,now_at);
 end if;
 end loop;
 -- Bound the public notice by preparation buckets, not historical batch count.
 select coalesce(jsonb_agg(jsonb_build_object('stage',q.stage,'productId',q.product,'name',q.name,'unit',q.unit,'quantityMilli',q.quantity) order by q.stage,q.product),'[]') into withdrawals from
 (select w->>'stage' stage,w->>'productId' product,w->>'name' name,w->>'unit' unit,sum((w->>'quantityMilli')::integer) quantity from jsonb_array_elements(withdrawals) w group by w->>'stage',w->>'productId',w->>'name',w->>'unit') q;
 update public.pos_tab_kitchen_tickets set state='open',revision=case when fresh then 1 else revision+1 end,generation=generation+case when reopening then 1 else 0 end,dispatched_tab_revision=tab.revision,metadata=content->'metadata',lines=content->'lines',event_sequence=seq,updated_at=now_at where id=ticket.id returning * into ticket;
 insert into public.pos_tab_kitchen_events values(ticket.id,seq,jsonb_build_object('sequence',seq,'generation',ticket.generation,'kind',case when reopening then 'reopen' else 'dispatch' end,'tabRevision',tab.revision,'reason',p_command->'reason','createdAt',now_at,'before',before_content,'after',content,'additions',additions,'withdrawals',withdrawals));
 else
 select * into ticket from public.pos_tab_kitchen_tickets where id=(p_command->>'ticketId')::uuid and organization_id=org and branch_id=branch for update;
 if not found then raise exception 'POS_TAB_KITCHEN_NOT_FOUND';end if;if ticket.revision<>(p_command->>'expectedRevision')::integer then raise exception 'POS_TAB_KITCHEN_CHANGED';end if;
 if kind='acknowledge' then
 if (p_command->>'throughSequence')::integer<=ticket.acknowledged_sequence or (p_command->>'throughSequence')::integer>ticket.event_sequence then raise exception 'POS_KITCHEN_NO_CHANGES';end if;
 update public.pos_tab_kitchen_tickets set acknowledged_sequence=(p_command->>'throughSequence')::integer,revision=revision+1,updated_at=clock_timestamp() where id=ticket.id returning * into ticket;
 else
 if ticket.state='cancelled' then raise exception 'POS_KITCHEN_CANCELLED';end if;
 if ticket.event_sequence>ticket.acknowledged_sequence then raise exception 'POS_TAB_KITCHEN_PENDING_ACK';end if;
 old_rank:=array_position(array['queued','preparing','ready','served'],p_command->>'from');new_rank:=array_position(array['queued','preparing','ready','served'],p_command->>'to');
 if new_rank=old_rank-1 then if role_name not in ('owner','manager') then raise exception 'POS_MANAGER_REQUIRED';end if;if p_command->'reason'='null'::jsonb then raise exception 'POS_KITCHEN_REASON_REQUIRED';end if;
 elsif new_rank<>old_rank+1 then raise exception 'POS_KITCHEN_TRANSITION_INVALID';end if;
 update public.pos_tab_kitchen_batches set stage=p_command->>'to' where ticket_id=ticket.id and stage=p_command->>'from' and quantity_milli>0;
 if not found then raise exception 'POS_KITCHEN_NO_CHANGES';end if;
 update public.pos_tab_kitchen_tickets set revision=revision+1,updated_at=clock_timestamp() where id=ticket.id returning * into ticket;
 end if;
 end if;
 result:=jsonb_build_object('status','updated','requestId',v_request,'replayed',false,'ticket',public.pos_tab_kitchen_snapshot(ticket));
 insert into public.pos_tab_kitchen_commands(id,organization_id,branch_id,actor_id,payload,result) values(v_request,org,branch,auth.uid(),p_command,result);
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details) values(org,branch,auth.uid(),'tab_kitchen.'||kind,ticket.id,jsonb_build_object('requestId',v_request,'revision',ticket.revision,'command',p_command));
 return result;
exception when numeric_value_out_of_range then raise exception 'POS_KITCHEN_LIMIT';end $$;
revoke all on function public.pos_execute_tab_kitchen_command(jsonb,text) from public,anon;
grant execute on function public.pos_execute_tab_kitchen_command(jsonb,text) to authenticated;
create function public.pos_resolve_tab_kitchen_request(p_command jsonb,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid;branch uuid;device uuid;v_request uuid;bound jsonb;previous public.pos_tab_kitchen_commands;cancelled public.pos_tab_kitchen_request_cancellations;
begin
 if auth.uid() is null then raise exception 'POS_ACCESS_DENIED';end if;perform public.pos_validate_tab_kitchen_command(p_command);
 branch:=(p_command->>'branchId')::uuid;device:=(p_command->>'deviceId')::uuid;v_request:=(p_command->>'id')::uuid;
 select organization_id into org from public.pos_device_bindings where user_id=auth.uid() and branch_id=branch and device_id=device limit 1;if org is null then raise exception 'POS_DEVICE_INVALID';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(org::text||':'||auth.uid()::text,15));
 if not exists(select 1 from public.pos_device_bindings where token_hash=p_binding and user_id=auth.uid() and organization_id=org and branch_id=branch and device_id=device) then
 bound:=public.pos_bound_device(p_binding);if bound is null or bound->>'branchId' is distinct from branch::text then raise exception 'POS_DEVICE_INVALID';end if;end if;
 perform pg_advisory_xact_lock(hashtextextended(v_request::text,21));
 select * into previous from public.pos_tab_kitchen_commands where id=v_request;
 if found then if previous.organization_id<>org or previous.branch_id<>branch or previous.actor_id<>auth.uid() or previous.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;return previous.result||'{"replayed":true}'::jsonb;end if;
 perform public.pos_lock_staff_authority(branch);
 select * into cancelled from public.pos_tab_kitchen_request_cancellations where request_id=v_request;
 if found then if cancelled.organization_id<>org or cancelled.branch_id<>branch or cancelled.actor_id<>auth.uid() or cancelled.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;return jsonb_build_object('status','cancelled','requestId',v_request,'replayed',true);end if;
 -- Cancellation never performs the pending manager-only mutation. Role downgrades
 -- and changed menu/preparation state must not strand a recoverable own journal.
 insert into public.pos_tab_kitchen_request_cancellations(request_id,organization_id,branch_id,actor_id,payload) values(v_request,org,branch,auth.uid(),p_command);
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details) values(org,branch,auth.uid(),'tab_kitchen.request_cancelled',v_request,jsonb_build_object('deviceId',device,'type',p_command->>'type'));
 return jsonb_build_object('status','cancelled','requestId',v_request,'replayed',false);
end $$;
revoke all on function public.pos_resolve_tab_kitchen_request(jsonb,text) from public,anon;
grant execute on function public.pos_resolve_tab_kitchen_request(jsonb,text) to authenticated;

create function public.pos_cancel_tab_kitchen(p_ticket uuid,p_kind text,p_tab_revision integer,p_reason text,p_actor uuid) returns void language plpgsql set search_path='' as $$
declare ticket public.pos_tab_kitchen_tickets;withdrawals jsonb;now_at timestamptz:=clock_timestamp();seq integer;
begin
 select * into ticket from public.pos_tab_kitchen_tickets where id=p_ticket for update;if not found then raise exception 'POS_TAB_KITCHEN_NOT_FOUND';end if;
 if p_kind not in ('void','refund') then raise exception 'POS_INVALID_TAB_KITCHEN_COMMAND';end if;
 if ticket.revision=2147483647 or ticket.event_sequence=2147483647 then raise exception 'POS_KITCHEN_LIMIT';end if;seq:=ticket.event_sequence+1;
 select coalesce(jsonb_agg(jsonb_build_object('stage',s,'productId',l->'productId','name',l->'name','unit',l->'unit','quantityMilli',l->'quantityMilli') order by s,l->>'productId'),'[]') into withdrawals
 from jsonb_each(public.pos_tab_kitchen_stages(ticket.id)) x(s,lines),jsonb_array_elements(lines) l;
 insert into public.pos_tab_kitchen_events values(ticket.id,seq,jsonb_build_object('sequence',seq,'generation',ticket.generation,'kind',p_kind,'tabRevision',p_tab_revision,'reason',p_reason,'createdAt',now_at,
 'before',jsonb_build_object('metadata',ticket.metadata,'lines',ticket.lines),'after',jsonb_build_object('metadata',ticket.metadata,'lines','[]'::jsonb),'additions','[]'::jsonb,'withdrawals',withdrawals));
 update public.pos_tab_kitchen_batches set quantity_milli=0,stage='cancelled' where ticket_id=ticket.id and quantity_milli>0;
 update public.pos_tab_kitchen_tickets set state='cancelled',lines='[]',revision=revision+1,event_sequence=seq,updated_at=now_at,
 payment=case when p_kind='refund' then 'refunded' else payment end,refunded_at=case when p_kind='refund' then now_at else refunded_at end where id=ticket.id;
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details) values(ticket.organization_id,ticket.branch_id,p_actor,'tab_kitchen.'||p_kind,ticket.id,jsonb_build_object('revision',ticket.revision+1,'sequence',seq,'reason',p_reason));
end $$;
revoke all on function public.pos_cancel_tab_kitchen(uuid,text,integer,text,uuid) from public,anon,authenticated;

alter function public.pos_execute_tab_command(jsonb,text) rename to pos_execute_tab_command_before_kitchen_dispatch;
revoke all on function public.pos_execute_tab_command_before_kitchen_dispatch(jsonb,text) from public,anon,authenticated;
create function public.pos_execute_tab_command(p_command jsonb,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;ticket uuid;
begin
 result:=public.pos_execute_tab_command_before_kitchen_dispatch(p_command,p_binding);
 -- Old request19/device/branch20/tab locks remain held. The kitchen side effect is
 -- in the same transaction as the existing immutable command acknowledgement.
 if p_command->>'type'='tab.void' and not (result->>'replayed')::boolean then
 select id into ticket from public.pos_tab_kitchen_tickets where tab_id=(p_command->>'tabId')::uuid for update;
 if found then perform public.pos_cancel_tab_kitchen(ticket,'void',(result#>>'{tab,revision}')::integer,p_command->>'reason',auth.uid());end if;
 end if;return result;
end $$;
revoke all on function public.pos_execute_tab_command(jsonb,text) from public,anon;
grant execute on function public.pos_execute_tab_command(jsonb,text) to authenticated;

alter function public.pos_record_live_order(jsonb,text) rename to pos_record_live_order_before_kitchen_dispatch;
revoke all on function public.pos_record_live_order_before_kitchen_dispatch(jsonb,text) from public,anon,authenticated;
create function public.pos_record_live_order(p_order jsonb,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid;branch uuid;device uuid;v_order uuid;tab public.pos_open_tabs;ticket public.pos_tab_kitchen_tickets;content jsonb;
begin
 -- Ordinary sales and exact committed retries keep SQL015's canonical full payload.
 if not p_order ? 'sourceTab' then return public.pos_record_live_order_before_kitchen_dispatch(p_order,p_binding);end if;
 branch:=(p_order->>'branchId')::uuid;device:=(p_order->>'deviceId')::uuid;v_order:=(p_order->>'id')::uuid;
 org:=public.pos_tab_scope(branch,p_binding,device);perform pg_advisory_xact_lock(hashtextextended(v_order::text,0));
 if exists(select 1 from public.pos_tab_sale_requests where order_id=v_order) then return public.pos_record_live_order_before_kitchen_dispatch(p_order,p_binding);end if;
 -- An existing ordinary invoice must NEVER become a private kitchen reservation.
 if exists(select 1 from public.pos_orders where id=v_order) or exists(select 1 from public.pos_documents where order_id=v_order) then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;
 perform public.pos_assert_not_cancelled('sale',p_order,org);
 perform 1 from public.pos_branch_receipt_config where organization_id=org and branch_id=branch and live_enabled for share;if not found then raise exception 'POS_PROFILE_REQUIRED';end if;
 perform 1 from public.pos_devices where id=device and organization_id=org and branch_id=branch and active for share;if not found then raise exception 'POS_DEVICE_INVALID';end if;
 perform 1 from public.pos_shifts where id=(p_order->>'shiftId')::uuid and organization_id=org and branch_id=branch and device_id=device and opened_by=auth.uid() and status='open' for update;if not found then raise exception 'POS_SHIFT_INVALID';end if;
 perform pg_advisory_xact_lock(hashtextextended(branch::text,20));
 select * into tab from public.pos_open_tabs where id=(p_order#>>'{sourceTab,id}')::uuid and organization_id=org and branch_id=branch for update;if not found then raise exception 'POS_TAB_NOT_FOUND';end if;
 if tab.status='settled' then raise exception 'POS_TAB_ALREADY_SETTLED';end if;if tab.status<>'open' then raise exception 'POS_TAB_STATE_INVALID';end if;
 if tab.revision<>(p_order#>>'{sourceTab,expectedRevision}')::integer then raise exception 'POS_TAB_CHANGED';end if;
 -- Products precede the ticket. No existing financial order is acquired after the
 -- ticket; only the new order protected by request0 can be inserted downstream.
 perform public.pos_offer_catalogue_lines(org,branch,tab.request_lines,true);
 content:=public.pos_tab_kitchen_content(tab);
 select * into ticket from public.pos_tab_kitchen_tickets where tab_id=tab.id for update;
 if found then
 if ticket.state='cancelled' or content<>jsonb_build_object('metadata',ticket.metadata,'lines',ticket.lines) then raise exception 'POS_KITCHEN_DISPATCH_REQUIRED';end if;
 if ticket.payment<>'unpaid' then raise exception 'POS_TAB_ALREADY_SETTLED';end if;
 if ticket.revision=2147483647 then raise exception 'POS_KITCHEN_LIMIT';end if;
 insert into public.pos_tab_kitchen_payments(order_id,ticket_id,organization_id,branch_id,actor_id) values(v_order,ticket.id,org,branch,auth.uid());
 end if;
 return public.pos_record_live_order_before_kitchen_dispatch(p_order,p_binding);
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'POS_INVALID_ORDER';end $$;
revoke all on function public.pos_record_live_order(jsonb,text) from public,anon;
grant execute on function public.pos_record_live_order(jsonb,text) to authenticated;

-- Preserve the complete legacy projection when no trusted private reservation exists.
create or replace function public.pos_project_kitchen_document() returns trigger language plpgsql security definer set search_path='' as $$
declare linked uuid; dispatched public.pos_tab_kitchen_tickets; previous public.pos_kitchen_tickets; kitchen_lines jsonb; changed_at timestamptz:=clock_timestamp();
begin
 -- Every writer already owns this order (new invoice insert, refund FOR UPDATE).
 -- Taking it explicitly also preserves the invariant for privileged fixture/import paths.
 perform 1 from public.pos_orders o where o.id=new.order_id and o.organization_id=new.organization_id and o.branch_id=new.branch_id for update;
 if not found then raise exception 'POS_ORDER_UNAVAILABLE'; end if;
 select ticket_id into linked from public.pos_tab_kitchen_payments where order_id=new.order_id and organization_id=new.organization_id and branch_id=new.branch_id;
 if found then
  select * into dispatched from public.pos_tab_kitchen_tickets where id=linked for update;
  if new.kind='tax_invoice' then
   if dispatched.payment<>'unpaid' or dispatched.state<>'open' then raise exception 'POS_TAB_KITCHEN_CHANGED';end if;
   update public.pos_tab_kitchen_tickets set payment='paid',paid_order_id=new.order_id,invoice_id=new.id,invoice_number=new.document_number,paid_at=new.issued_at,revision=revision+1,updated_at=clock_timestamp() where id=linked;
   insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details) values(new.organization_id,new.branch_id,new.actor_id,'tab_kitchen.paid',linked,jsonb_build_object('orderId',new.order_id,'revision',dispatched.revision+1));
  else
   perform public.pos_cancel_tab_kitchen(linked,'refund',dispatched.dispatched_tab_revision,new.snapshot->>'reason',new.actor_id);
  end if;
  return new;
 end if;
 if new.kind='tax_invoice' then
  select jsonb_agg(jsonb_build_object('lineNumber',l->'lineNumber','productId',l->'productId','name',l->'name','unit',l->'unit','quantityMilli',l->'quantityMilli') order by ord)
  into kitchen_lines from jsonb_array_elements(new.snapshot->'lines') with ordinality x(l,ord);
  insert into public.pos_kitchen_tickets(order_id,organization_id,branch_id,invoice_id,invoice_number,issued_at,service_type,lines,updated_at)
  values(new.order_id,new.organization_id,new.branch_id,new.id,new.document_number,new.issued_at,new.snapshot->>'serviceType',kitchen_lines,changed_at);
  insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
  values(new.organization_id,new.branch_id,new.actor_id,'kitchen.queued',new.order_id,jsonb_build_object('invoiceId',new.id,'revision',1));
 else
  select * into previous from public.pos_kitchen_tickets t where t.order_id=new.order_id and t.organization_id=new.organization_id and t.branch_id=new.branch_id for update;
  if found then
   update public.pos_kitchen_tickets set status='cancelled',revision=revision+1,updated_at=changed_at,refunded_at=changed_at where order_id=new.order_id;
   insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
   values(new.organization_id,new.branch_id,new.actor_id,'kitchen.refunded',new.order_id,jsonb_build_object('creditNoteId',new.id,'previousStatus',previous.status,'previousRevision',previous.revision,'revision',previous.revision+1));
  end if;
 end if;
 return new;
end $$;
revoke all on function public.pos_project_kitchen_document() from public,anon,authenticated;
