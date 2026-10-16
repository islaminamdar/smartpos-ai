-- Additive return notices. Financial credit is the sole notice source; no stock writes.
create table public.pos_kitchen_return_notices (
 id uuid primary key references public.pos_documents, organization_id uuid not null, branch_id uuid not null,
 order_id uuid not null, issued_at timestamptz not null, snapshot jsonb not null,
 foreign key(organization_id,branch_id,order_id) references public.pos_orders(organization_id,branch_id,id)
);
create index pos_kitchen_returns_branch_page on public.pos_kitchen_return_notices(branch_id,issued_at,id);
create index pos_kitchen_returns_order on public.pos_kitchen_return_notices(order_id);
create table public.pos_kitchen_return_acknowledgements (
 notice_id uuid primary key references public.pos_kitchen_return_notices,
 actor_id uuid not null references auth.users, device_id uuid not null references public.pos_devices,
 acknowledged_at timestamptz not null default clock_timestamp()
);
alter table public.pos_kitchen_return_notices enable row level security;
alter table public.pos_kitchen_return_acknowledgements enable row level security;
revoke all on public.pos_kitchen_return_notices,public.pos_kitchen_return_acknowledgements from public,anon,authenticated,service_role;
create trigger pos_kitchen_return_notices_immutable before update or delete on public.pos_kitchen_return_notices for each row execute function public.pos_preserve_document();
create trigger pos_kitchen_return_ack_immutable before update or delete on public.pos_kitchen_return_acknowledgements for each row execute function public.pos_preserve_document();

create function public.pos_list_kitchen_returns(p_branch uuid,p_binding text,p_cursor jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid; bound jsonb; after_time timestamptz; after_id uuid; result jsonb; total bigint;
begin
 org:=public.pos_lock_staff_authority(p_branch);bound:=public.pos_bound_device(p_binding);
 if bound is null or bound->>'branchId' is distinct from p_branch::text then raise exception 'POS_DEVICE_INVALID';end if;
 if p_cursor is not null then
  if jsonb_typeof(p_cursor) is distinct from 'object' or not p_cursor ?& array['issuedAt','id'] or p_cursor-array['issuedAt','id']<>'{}'::jsonb or jsonb_typeof(p_cursor->'issuedAt') is distinct from 'string' or jsonb_typeof(p_cursor->'id') is distinct from 'string' then raise exception 'POS_INVALID_KITCHEN_CURSOR';end if;
  after_time:=(p_cursor->>'issuedAt')::timestamptz;after_id:=(p_cursor->>'id')::uuid;
  if not isfinite(after_time) then raise exception 'POS_INVALID_KITCHEN_CURSOR';end if;
 end if;
 with pending as materialized(select n.* from public.pos_kitchen_return_notices n where n.organization_id=org and n.branch_id=p_branch and not exists(select 1 from public.pos_kitchen_return_acknowledgements a where a.notice_id=n.id)),
 page as materialized(select * from pending n where after_time is null or (n.issued_at,n.id)>(after_time,after_id) order by n.issued_at,n.id limit 51),
 shown as materialized(select * from page order by issued_at,id limit 50)
 select (select count(*) from pending),jsonb_build_object('status','ready','branchId',p_branch,'pendingCount',(select count(*) from pending),
 'notices',(select coalesce(jsonb_agg(snapshot order by issued_at,id),'[]'::jsonb) from shown),
 'nextCursor',case when (select count(*) from page)>50 then (select jsonb_build_object('issuedAt',issued_at,'id',id) from shown order by issued_at desc,id desc limit 1) else null end)
 into total,result;
 if total>50000 then raise exception 'POS_KITCHEN_LIMIT';end if;return result;
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then raise exception 'POS_INVALID_KITCHEN_CURSOR';
end $$;
revoke all on function public.pos_list_kitchen_returns(uuid,text,jsonb) from public,anon;
grant execute on function public.pos_list_kitchen_returns(uuid,text,jsonb) to authenticated;

create function public.pos_acknowledge_kitchen_return(p_branch uuid,p_device uuid,p_notice uuid,p_binding text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid; bound jsonb; notice public.pos_kitchen_return_notices; inserted integer;
begin
 org:=public.pos_lock_staff_authority(p_branch);bound:=public.pos_bound_device(p_binding);
 if bound is null or bound->>'id' is distinct from p_device::text or bound->>'branchId' is distinct from p_branch::text then raise exception 'POS_DEVICE_INVALID';end if;
 -- Current authorization serializes with device and original binding revocation.
 perform 1 from public.pos_devices d where d.id=p_device and d.organization_id=org and d.branch_id=p_branch and d.active for update;
 if not found then raise exception 'POS_DEVICE_INVALID';end if;
 perform 1 from public.pos_device_bindings b where b.token_hash=p_binding and b.user_id=auth.uid() and b.organization_id=org and b.branch_id=p_branch and b.device_id=p_device and b.revoked_at is null for share;
 if not found then raise exception 'POS_DEVICE_INVALID';end if;
 select * into notice from public.pos_kitchen_return_notices n where n.id=p_notice and n.organization_id=org and n.branch_id=p_branch;
 if not found then raise exception 'POS_ORDER_UNAVAILABLE';end if;
 perform 1 from public.pos_orders where id=notice.order_id for update;
 insert into public.pos_kitchen_return_acknowledgements(notice_id,actor_id,device_id) values(p_notice,auth.uid(),p_device) on conflict do nothing;
 get diagnostics inserted=row_count;
 return jsonb_build_object('status','acknowledged','branchId',p_branch,'noticeId',p_notice,'replayed',inserted=0);
end $$;
revoke all on function public.pos_acknowledge_kitchen_return(uuid,uuid,uuid,text) from public,anon;
grant execute on function public.pos_acknowledge_kitchen_return(uuid,uuid,uuid,text) to authenticated;

create function public.pos_guard_kitchen_return_stage() returns trigger language plpgsql security definer set search_path='' as $$
declare target_order uuid;
begin
 if tg_table_name='pos_kitchen_tickets' then
  if new.status=old.status or new.status='cancelled' then return new;end if;target_order:=new.order_id;
 else
  if new.stage=old.stage or new.stage='cancelled' then return new;end if;
  select paid_order_id into target_order from public.pos_tab_kitchen_tickets where id=new.ticket_id;
 end if;
 if exists(select 1 from public.pos_kitchen_return_notices n where n.order_id=target_order and not exists(select 1 from public.pos_kitchen_return_acknowledgements a where a.notice_id=n.id)) then raise exception 'POS_KITCHEN_RETURN_PENDING';end if;
 return new;
end $$;
revoke all on function public.pos_guard_kitchen_return_stage() from public,anon,authenticated,service_role;
create trigger pos_kitchen_return_stage_guard before update on public.pos_kitchen_tickets for each row execute function public.pos_guard_kitchen_return_stage();
create trigger pos_tab_kitchen_return_stage_guard before update on public.pos_tab_kitchen_batches for each row execute function public.pos_guard_kitchen_return_stage();

create or replace function public.pos_project_kitchen_document() returns trigger language plpgsql security definer set search_path='' as $$
declare linked uuid; dispatched public.pos_tab_kitchen_tickets; previous public.pos_kitchen_tickets; kitchen_lines jsonb; changed_at timestamptz:=clock_timestamp();
begin
 if exists(select 1 from public.pos_offline_receipts r where r.issuance_id=new.order_id and r.organization_id=new.organization_id and r.branch_id=new.branch_id) then return new;end if;
 -- Every writer already owns this order (new invoice insert, refund FOR UPDATE).
 -- Taking it explicitly also preserves the invariant for privileged fixture/import paths.
 perform 1 from public.pos_orders o where o.id=new.order_id and o.organization_id=new.organization_id and o.branch_id=new.branch_id for update;
 if not found then raise exception 'POS_ORDER_UNAVAILABLE'; end if;
 -- V3 partial credits are notices, never whole preparation cancellation.
 if new.kind='tax_credit_note' and new.snapshot->>'schemaVersion'='3' then
  if exists(select 1 from public.pos_kitchen_tickets where order_id=new.order_id) or exists(select 1 from public.pos_tab_kitchen_payments where order_id=new.order_id) then
   insert into public.pos_kitchen_return_notices(id,organization_id,branch_id,order_id,issued_at,snapshot)
   values(new.id,new.organization_id,new.branch_id,new.order_id,new.issued_at,jsonb_build_object('id',new.id,'branchId',new.branch_id,'orderId',new.order_id,
    'invoiceId',new.snapshot#>'{originalInvoice,documentId}','invoiceNumber',new.snapshot#>'{originalInvoice,documentNumber}',
    'creditNumber',new.document_number,'issuedAt',new.issued_at,'reason',new.snapshot->'reason','fullyReturned',new.snapshot->'fullyReturned',
    'lines',(select jsonb_agg(jsonb_build_object('originalLineNumber',l->'originalLineNumber','productId',l->'productId','name',l->'name','unit',l->'unit','quantityMilli',l->'quantityMilli',
     'remainingQuantityMilli',(l#>>'{originalLine,quantityMilli}')::bigint-(l->>'returnedAfterQuantityMilli')::bigint) order by ord) from jsonb_array_elements(new.snapshot->'lines') with ordinality x(l,ord))));
   if not (new.snapshot->>'fullyReturned')::boolean then
    update public.pos_kitchen_tickets set revision=revision+1,updated_at=changed_at where order_id=new.order_id;
    update public.pos_tab_kitchen_tickets set revision=revision+1,updated_at=changed_at where paid_order_id=new.order_id;
   end if;
  end if;
  if not (new.snapshot->>'fullyReturned')::boolean then return new;end if;
 end if;
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
