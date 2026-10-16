-- Shared paid-order preparation state. Existing invoices are deliberately not backfilled.
-- Financial document insertion and kitchen projection share one transaction.
create table public.pos_kitchen_tickets (
 order_id uuid primary key, organization_id uuid not null, branch_id uuid not null,
 invoice_id uuid not null unique references public.pos_documents, invoice_number text not null,
 issued_at timestamptz not null, service_type text not null check(service_type in ('dine_in','takeaway','delivery')),
 lines jsonb not null check(jsonb_typeof(lines)='array' and jsonb_array_length(lines) between 1 and 200),
 status text not null default 'queued' check(status in ('queued','preparing','ready','served','cancelled')),
 revision integer not null default 1 check(revision>0), updated_at timestamptz not null default clock_timestamp(), refunded_at timestamptz,
 foreign key(organization_id,branch_id,order_id) references public.pos_orders(organization_id,branch_id,id),
 check((status='cancelled')=(refunded_at is not null))
);
create index pos_kitchen_active_page on public.pos_kitchen_tickets(branch_id,issued_at,order_id) where status in ('queued','preparing','ready');
create index pos_kitchen_terminal_page on public.pos_kitchen_tickets(branch_id,updated_at desc,order_id) where status in ('served','cancelled');
create table public.pos_kitchen_commands (
 id uuid primary key, organization_id uuid not null, branch_id uuid not null, actor_id uuid not null references auth.users,
 payload jsonb not null, result jsonb not null, created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id)
);
create table public.pos_kitchen_request_cancellations (
 request_id uuid primary key, organization_id uuid not null, branch_id uuid not null, actor_id uuid not null references auth.users,
 payload jsonb not null, created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id)
);
alter table public.pos_kitchen_tickets enable row level security;
alter table public.pos_kitchen_commands enable row level security;
alter table public.pos_kitchen_request_cancellations enable row level security;
revoke all on public.pos_kitchen_tickets,public.pos_kitchen_commands,public.pos_kitchen_request_cancellations from public,anon,authenticated;
create trigger pos_kitchen_commands_immutable before update or delete on public.pos_kitchen_commands for each row execute function public.pos_preserve_document();
create trigger pos_kitchen_cancellations_immutable before update or delete on public.pos_kitchen_request_cancellations for each row execute function public.pos_preserve_document();
create function public.pos_kitchen_snapshot(p public.pos_kitchen_tickets) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('orderId',p.order_id,'branchId',p.branch_id,'invoiceId',p.invoice_id,'invoiceNumber',p.invoice_number,
 'issuedAt',p.issued_at,'serviceType',p.service_type,'lines',p.lines,'status',p.status,'revision',p.revision,'updatedAt',p.updated_at,'refundedAt',p.refunded_at)
$$;
revoke all on function public.pos_kitchen_snapshot(public.pos_kitchen_tickets) from public,anon,authenticated;
create function public.pos_project_kitchen_document() returns trigger language plpgsql security definer set search_path='' as $$
declare previous public.pos_kitchen_tickets; kitchen_lines jsonb; changed_at timestamptz:=clock_timestamp();
begin
 -- Every writer already owns this order (new invoice insert, refund FOR UPDATE).
 -- Taking it explicitly also preserves the invariant for privileged fixture/import paths.
 perform 1 from public.pos_orders o where o.id=new.order_id and o.organization_id=new.organization_id and o.branch_id=new.branch_id for update;
 if not found then raise exception 'POS_ORDER_UNAVAILABLE'; end if;
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
create trigger pos_documents_kitchen after insert on public.pos_documents for each row execute function public.pos_project_kitchen_document();
create function public.pos_validate_kitchen_command(p jsonb) returns void language plpgsql set search_path='' as $$
begin
 if jsonb_typeof(p) is distinct from 'object' or not p ?& array['id','branchId','deviceId','orderId','expectedRevision','status','reason']
  or p-array['id','branchId','deviceId','orderId','expectedRevision','status','reason']<>'{}'::jsonb
  or jsonb_typeof(p->'id') is distinct from 'string' or jsonb_typeof(p->'branchId') is distinct from 'string'
  or jsonb_typeof(p->'deviceId') is distinct from 'string' or jsonb_typeof(p->'orderId') is distinct from 'string'
  or not public.pos_offer_integer(p->'expectedRevision',1,2147483646)
  or coalesce(p->>'status','') not in ('queued','preparing','ready','served')
  or (p->'reason'<>'null'::jsonb and (jsonb_typeof(p->'reason') is distinct from 'string' or length(trim(p->>'reason')) not between 1 and 240 or p->>'reason'<>trim(p->>'reason')))
 then raise exception 'POS_INVALID_KITCHEN_COMMAND'; end if;
 perform (p->>'id')::uuid; perform (p->>'branchId')::uuid; perform (p->>'deviceId')::uuid; perform (p->>'orderId')::uuid;
exception when invalid_text_representation then raise exception 'POS_INVALID_KITCHEN_COMMAND';
end $$;
revoke all on function public.pos_validate_kitchen_command(jsonb) from public,anon,authenticated;
create function public.pos_list_kitchen(p_branch uuid,p_binding text,p_cursor jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid; bound jsonb; role_name text; after_time timestamptz; after_order uuid; active_items jsonb; terminal_items jsonb;
 counts jsonb; total bigint; terminal_count bigint; next_cursor jsonb; page_rows integer;
begin
 org:=public.pos_lock_staff_authority(p_branch); bound:=public.pos_bound_device(p_binding);
 if bound is null or bound->>'branchId' is distinct from p_branch::text then raise exception 'POS_DEVICE_INVALID'; end if;
 select s.role into role_name from public.pos_staff s where s.organization_id=org and s.user_id=auth.uid() and s.active;
 if p_cursor is not null then
  if jsonb_typeof(p_cursor) is distinct from 'object' or not p_cursor ?& array['issuedAt','orderId'] or p_cursor-array['issuedAt','orderId']<>'{}'::jsonb
   or jsonb_typeof(p_cursor->'issuedAt') is distinct from 'string' or jsonb_typeof(p_cursor->'orderId') is distinct from 'string'
  then raise exception 'POS_INVALID_KITCHEN_CURSOR'; end if;
  after_time:=(p_cursor->>'issuedAt')::timestamptz; after_order:=(p_cursor->>'orderId')::uuid;
  if not isfinite(after_time) then raise exception 'POS_INVALID_KITCHEN_CURSOR'; end if;
 end if;
 -- One statement snapshot keeps page/count metadata internally consistent while other devices work.
 with active as not materialized(select * from public.pos_kitchen_tickets t where t.organization_id=org and t.branch_id=p_branch and t.status in ('queued','preparing','ready')),
 page as materialized(select * from active t where after_time is null or (t.issued_at,t.order_id)>(after_time,after_order) order by t.issued_at,t.order_id limit 101),
 shown as materialized(select * from page order by issued_at,order_id limit 100),
 terminal as materialized(select * from public.pos_kitchen_tickets t where t.organization_id=org and t.branch_id=p_branch and t.status in ('served','cancelled') order by updated_at desc,order_id desc limit 51),
 recent as materialized(select * from terminal order by updated_at desc,order_id desc limit 50)
 select (select coalesce(jsonb_agg(public.pos_kitchen_snapshot(s) order by s.issued_at,s.order_id),'[]') from shown s),
 (select coalesce(jsonb_agg(public.pos_kitchen_snapshot(r) order by r.updated_at desc,r.order_id desc),'[]') from recent r),
 (select count(*) from active),(select count(*) from terminal),(select count(*) from page),
 (select jsonb_build_object('queued',count(*) filter(where status='queued'),'preparing',count(*) filter(where status='preparing'),'ready',count(*) filter(where status='ready')) from active),
 (select jsonb_build_object('issuedAt',issued_at,'orderId',order_id) from shown order by issued_at desc,order_id desc limit 1)
 into active_items,terminal_items,total,terminal_count,page_rows,counts,next_cursor;
 if total>2147483647 then raise exception 'POS_KITCHEN_LIMIT'; end if;
 return jsonb_build_object('status','ready','organizationId',org,'branchId',p_branch,'actorRole',role_name,'generatedAt',clock_timestamp(),
 'activeTickets',active_items,'terminalTickets',terminal_items,'activeCount',total,'activeCounts',counts,
 'activeNextCursor',case when page_rows>100 then next_cursor else null end,'terminalTruncated',terminal_count>50);
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then raise exception 'POS_INVALID_KITCHEN_CURSOR';
end $$;
revoke all on function public.pos_list_kitchen(uuid,text,jsonb) from public,anon;
grant execute on function public.pos_list_kitchen(uuid,text,jsonb) to authenticated;
create function public.pos_transition_kitchen(p_command jsonb,p_binding text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid; branch uuid; v_request_id uuid; bound jsonb; previous public.pos_kitchen_commands; cancellation public.pos_kitchen_request_cancellations;
 ticket public.pos_kitchen_tickets; role_name text; result jsonb; old_rank integer; new_rank integer;
begin
 perform public.pos_validate_kitchen_command(p_command);
 branch:=(p_command->>'branchId')::uuid; v_request_id:=(p_command->>'id')::uuid;
 org:=public.pos_lock_staff_authority(branch); bound:=public.pos_bound_device(p_binding);
 if bound is null or bound->>'branchId' is distinct from branch::text or bound->>'id' is distinct from p_command->>'deviceId' then raise exception 'POS_DEVICE_INVALID'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_request_id::text,18));
 select * into previous from public.pos_kitchen_commands c where c.id=v_request_id;
 if found then
  if previous.organization_id<>org or previous.branch_id<>branch or previous.actor_id<>auth.uid() or previous.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  return previous.result||jsonb_build_object('replayed',true);
 end if;
 select * into cancellation from public.pos_kitchen_request_cancellations c where c.request_id=v_request_id;
 if found then
  if cancellation.organization_id<>org or cancellation.branch_id<>branch or cancellation.actor_id<>auth.uid() or cancellation.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  raise exception 'POS_REQUEST_CANCELLED';
 end if;
 -- Authority -> request -> device -> order -> ticket. Refund shares device -> shift -> order.
 perform 1 from public.pos_devices d where d.id=(p_command->>'deviceId')::uuid and d.organization_id=org and d.branch_id=branch and d.active for share;
 if not found then raise exception 'POS_DEVICE_INVALID'; end if;
 perform 1 from public.pos_orders o where o.id=(p_command->>'orderId')::uuid and o.organization_id=org and o.branch_id=branch for update;
 if not found then raise exception 'POS_KITCHEN_NOT_FOUND'; end if;
 select * into ticket from public.pos_kitchen_tickets t where t.order_id=(p_command->>'orderId')::uuid and t.organization_id=org and t.branch_id=branch for update;
 if not found then raise exception 'POS_KITCHEN_NOT_FOUND'; end if;
 if ticket.status='cancelled' then raise exception 'POS_KITCHEN_REFUNDED'; end if;
 if ticket.revision<>(p_command->>'expectedRevision')::integer then raise exception 'POS_KITCHEN_CHANGED'; end if;
 select s.role into role_name from public.pos_staff s where s.organization_id=org and s.user_id=auth.uid() and s.active;
 old_rank:=array_position(array['queued','preparing','ready','served'],ticket.status);
 new_rank:=array_position(array['queued','preparing','ready','served'],p_command->>'status');
 if new_rank=old_rank-1 then
  if role_name not in ('owner','manager') then raise exception 'POS_MANAGER_REQUIRED'; end if;
  if p_command->'reason'='null'::jsonb then raise exception 'POS_KITCHEN_REASON_REQUIRED'; end if;
 elsif new_rank<>old_rank+1 then raise exception 'POS_KITCHEN_TRANSITION_INVALID'; end if;
 update public.pos_kitchen_tickets set status=p_command->>'status',revision=revision+1,updated_at=clock_timestamp() where order_id=ticket.order_id returning * into ticket;
 result:=jsonb_build_object('status','updated','requestId',v_request_id,'replayed',false,'ticket',public.pos_kitchen_snapshot(ticket));
 insert into public.pos_kitchen_commands(id,organization_id,branch_id,actor_id,payload,result) values(v_request_id,org,branch,auth.uid(),p_command,result);
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
 values(org,branch,auth.uid(),'kitchen.transitioned',ticket.order_id,jsonb_build_object('requestId',v_request_id,'deviceId',bound->>'id',
 'previousStatus',(array['queued','preparing','ready','served'])[old_rank],'status',ticket.status,'previousRevision',ticket.revision-1,'revision',ticket.revision,'reason',p_command->'reason'));
 return result;
end $$;
revoke all on function public.pos_transition_kitchen(jsonb,text) from public,anon;
grant execute on function public.pos_transition_kitchen(jsonb,text) to authenticated;
create function public.pos_resolve_kitchen_request(p_command jsonb,p_binding text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid; branch uuid; device uuid; v_request_id uuid; bound jsonb; previous public.pos_kitchen_commands; cancellation public.pos_kitchen_request_cancellations;
begin
 if auth.uid() is null then raise exception 'POS_ACCESS_DENIED'; end if;
 perform public.pos_validate_kitchen_command(p_command);
 branch:=(p_command->>'branchId')::uuid; device:=(p_command->>'deviceId')::uuid; v_request_id:=(p_command->>'id')::uuid;
 select b.organization_id into org from public.pos_device_bindings b where b.user_id=auth.uid() and b.branch_id=branch and b.device_id=device limit 1;
 if org is null then raise exception 'POS_DEVICE_INVALID'; end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(org::text||':'||auth.uid()::text,15));
 if not exists(select 1 from public.pos_device_bindings b where b.token_hash=p_binding and b.user_id=auth.uid() and b.organization_id=org and b.branch_id=branch and b.device_id=device) then
  bound:=public.pos_bound_device(p_binding);
  if bound is null or bound->>'branchId' is distinct from branch::text then raise exception 'POS_DEVICE_INVALID'; end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(v_request_id::text,18));
 select * into previous from public.pos_kitchen_commands c where c.id=v_request_id;
 if found then
  if previous.organization_id<>org or previous.branch_id<>branch or previous.actor_id<>auth.uid() or previous.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  return previous.result||jsonb_build_object('replayed',true);
 end if;
 -- An inactive actor can read only their exact committed acknowledgement above.
 perform public.pos_lock_staff_authority(branch);
 select * into cancellation from public.pos_kitchen_request_cancellations c where c.request_id=v_request_id;
 if found then
  if cancellation.organization_id<>org or cancellation.branch_id<>branch or cancellation.actor_id<>auth.uid() or cancellation.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  return jsonb_build_object('status','cancelled','requestId',v_request_id,'replayed',true);
 end if;
 insert into public.pos_kitchen_request_cancellations(request_id,organization_id,branch_id,actor_id,payload) values(v_request_id,org,branch,auth.uid(),p_command);
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
 values(org,branch,auth.uid(),'kitchen.request_cancelled',v_request_id,jsonb_build_object('deviceId',device,'orderId',p_command->>'orderId'));
 return jsonb_build_object('status','cancelled','requestId',v_request_id,'replayed',false);
end $$;
revoke all on function public.pos_resolve_kitchen_request(jsonb,text) from public,anon;
grant execute on function public.pos_resolve_kitchen_request(jsonb,text) to authenticated;
