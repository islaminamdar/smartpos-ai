-- Direct paid-order notes are immutable operational instructions. Keep them separate
-- from the fiscal payload so historic invoices and accounting totals remain untouched.
alter table public.pos_kitchen_tickets add column order_note text;
alter table public.pos_kitchen_tickets add constraint pos_kitchen_ticket_order_note
 check(order_note is null or (order_note=trim(order_note) and length(order_note) between 1 and 240));

create table public.pos_order_notes (
 order_id uuid primary key,
 organization_id uuid not null,
 branch_id uuid not null,
 invoice_id uuid not null unique references public.pos_documents(id),
 actor_id uuid not null references auth.users,
 note text not null check(note=trim(note) and length(note) between 1 and 240),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,branch_id,order_id) references public.pos_orders(organization_id,branch_id,id)
);
alter table public.pos_order_notes enable row level security;
revoke all on public.pos_order_notes from public,anon,authenticated;
create trigger pos_order_notes_immutable before update or delete on public.pos_order_notes for each row execute function public.pos_preserve_document();

create or replace function public.pos_kitchen_snapshot(p public.pos_kitchen_tickets) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('orderId',p.order_id,'branchId',p.branch_id,'invoiceId',p.invoice_id,'invoiceNumber',p.invoice_number,
 'issuedAt',p.issued_at,'serviceType',p.service_type,'orderNote',p.order_note,'lines',p.lines,'status',p.status,'revision',p.revision,'updatedAt',p.updated_at,'refundedAt',p.refunded_at)
$$;
revoke all on function public.pos_kitchen_snapshot(public.pos_kitchen_tickets) from public,anon,authenticated;

-- The established financial writer remains responsible for all price/tax/tender
-- checks. This wrapper only strips a validated note before that immutable writer,
-- then records and projects it in the same transaction.
alter function public.pos_record_live_order_unbound(jsonb) rename to pos_record_live_order_without_order_note;
revoke all on function public.pos_record_live_order_without_order_note(jsonb) from public,anon,authenticated;
create function public.pos_record_live_order_unbound(p_order jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare note text; base jsonb; result jsonb; existing public.pos_order_notes%rowtype; invoice_id uuid; branch uuid; org uuid; actor uuid:=auth.uid(); changed integer;
begin
 if jsonb_typeof(p_order) is distinct from 'object' then raise exception 'POS_INVALID_ORDER'; end if;
 if not (p_order ? 'orderNote') then return public.pos_record_live_order_without_order_note(p_order); end if;
 if jsonb_typeof(p_order->'orderNote') is distinct from 'string' or length(trim(p_order->>'orderNote')) not between 1 and 240 or p_order->>'orderNote'<>trim(p_order->>'orderNote') then raise exception 'POS_INVALID_ORDER'; end if;
 if p_order ? 'sourceTab' then raise exception 'POS_ORDER_NOTE_TAB_UNSUPPORTED'; end if;
 note:=p_order->>'orderNote'; base:=p_order-'orderNote';
 result:=public.pos_record_live_order_without_order_note(base);
 if result->>'status' is distinct from 'synced' or result->>'orderId' is distinct from base->>'id' or jsonb_typeof(result->'receipt') is distinct from 'object' then raise exception 'POS_INVALID_ORDER'; end if;
 invoice_id:=(result->'receipt'->>'id')::uuid; branch:=(base->>'branchId')::uuid;
 select organization_id into org from public.pos_branches where id=branch;
 if org is null or actor is null then raise exception 'POS_ACCESS_DENIED'; end if;
 select * into existing from public.pos_order_notes where order_id=(base->>'id')::uuid;
 if found then
  if existing.organization_id<>org or existing.branch_id<>branch or existing.invoice_id<>invoice_id or existing.actor_id<>actor or existing.note<>note then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
 else
  insert into public.pos_order_notes(order_id,organization_id,branch_id,invoice_id,actor_id,note) values((base->>'id')::uuid,org,branch,invoice_id,actor,note);
  update public.pos_kitchen_tickets set order_note=note where order_id=(base->>'id')::uuid and organization_id=org and branch_id=branch;
  get diagnostics changed=row_count;
  if changed<>1 then raise exception 'POS_KITCHEN_NOTE_UNAVAILABLE'; end if;
  insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
   values(org,branch,actor,'sale.note_recorded',(base->>'id')::uuid,jsonb_build_object('invoiceId',invoice_id));
 end if;
 return result || jsonb_build_object('receipt',jsonb_set(result->'receipt','{orderNote}',to_jsonb(note),true));
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'POS_INVALID_ORDER';
end $$;
revoke all on function public.pos_record_live_order_unbound(jsonb) from public,anon,authenticated;

-- Pending-sale recovery must use exactly the same note that was originally saved.
alter function public.pos_resolve_live_request(text,jsonb,text) rename to pos_resolve_live_request_without_order_note;
revoke all on function public.pos_resolve_live_request_without_order_note(text,jsonb,text) from public,anon,authenticated;
create function public.pos_resolve_live_request(p_kind text,p_request jsonb,p_binding text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare note text; base jsonb; result jsonb; existing public.pos_order_notes%rowtype;
begin
 if p_kind is distinct from 'sale' or jsonb_typeof(p_request) is distinct from 'object' or not (p_request ? 'orderNote') then return public.pos_resolve_live_request_without_order_note(p_kind,p_request,p_binding); end if;
 if jsonb_typeof(p_request->'orderNote') is distinct from 'string' or length(trim(p_request->>'orderNote')) not between 1 and 240 or p_request->>'orderNote'<>trim(p_request->>'orderNote') then raise exception 'POS_INVALID_ORDER'; end if;
 note:=p_request->>'orderNote'; base:=p_request-'orderNote';
 result:=public.pos_resolve_live_request_without_order_note(p_kind,base,p_binding);
 if result->>'status'='synced' then
  select * into existing from public.pos_order_notes where order_id=(base->>'id')::uuid;
  if not found or existing.note<>note or existing.invoice_id<>(result->'receipt'->>'id')::uuid then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  return result || jsonb_build_object('receipt',jsonb_set(result->'receipt','{orderNote}',to_jsonb(note),true));
 end if;
 return result;
exception when invalid_text_representation then raise exception 'POS_INVALID_ORDER';
end $$;
revoke all on function public.pos_resolve_live_request(text,jsonb,text) from public,anon,authenticated;

create function public.pos_list_order_notes(p_branch uuid,p_order_ids uuid[]) returns table(order_id uuid,note text)
language plpgsql security definer set search_path='' as $$
declare org uuid;
begin
 org:=public.pos_lock_staff_authority(p_branch);
 return query select n.order_id,n.note from public.pos_order_notes n where n.organization_id=org and n.branch_id=p_branch and n.order_id=any(p_order_ids);
end $$;
revoke all on function public.pos_list_order_notes(uuid,uuid[]) from public,anon;
grant execute on function public.pos_list_order_notes(uuid,uuid[]) to authenticated;
