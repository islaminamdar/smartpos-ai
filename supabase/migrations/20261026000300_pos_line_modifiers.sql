-- Non-financial item modifiers are operational preparation choices. They are kept in
-- an immutable journal so VAT, price and historic fiscal snapshots are never rewritten.
create table public.pos_order_line_modifiers (
 order_id uuid primary key,
 organization_id uuid not null,
 branch_id uuid not null,
 invoice_id uuid not null unique references public.pos_documents(id),
 actor_id uuid not null references auth.users,
 modifiers jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,branch_id,order_id) references public.pos_orders(organization_id,branch_id,id),
 check(jsonb_typeof(modifiers)='object')
);
alter table public.pos_order_line_modifiers enable row level security;
revoke all on public.pos_order_line_modifiers from public,anon,authenticated;
create trigger pos_order_line_modifiers_immutable before update or delete on public.pos_order_line_modifiers for each row execute function public.pos_preserve_document();

create function public.pos_apply_line_modifiers(p_receipt jsonb,p_modifiers jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_set(p_receipt,'{lines}',coalesce((
  select jsonb_agg(case when p_modifiers ? ord::text then jsonb_set(line,'{modifiers}',p_modifiers->ord::text,true) else line end order by ord)
  from jsonb_array_elements(p_receipt->'lines') with ordinality x(line,ord)
 ),'[]'::jsonb),true)
$$;
revoke all on function public.pos_apply_line_modifiers(jsonb,jsonb) from public,anon,authenticated;

create function public.pos_list_order_line_modifiers(p_branch uuid,p_order_ids uuid[])
returns table(order_id uuid,modifiers jsonb)
language plpgsql security definer set search_path='' as $$
declare org uuid;
begin
 org:=public.pos_lock_staff_authority(p_branch);
 return query select m.order_id,m.modifiers from public.pos_order_line_modifiers m
  where m.organization_id=org and m.branch_id=p_branch and m.order_id=any(p_order_ids);
end $$;
revoke all on function public.pos_list_order_line_modifiers(uuid,uuid[]) from public,anon;
grant execute on function public.pos_list_order_line_modifiers(uuid,uuid[]) to authenticated;

-- Preserve the established financial writer. This wrapper validates and strips only
-- operational modifiers, then persists/projections them inside its transaction.
alter function public.pos_record_live_order_unbound(jsonb) rename to pos_record_live_order_without_line_modifiers;
revoke all on function public.pos_record_live_order_without_line_modifiers(jsonb) from public,anon,authenticated;
create function public.pos_record_live_order_unbound(p_order jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare base jsonb; result jsonb; line jsonb; modifiers jsonb:='{}'::jsonb; existing public.pos_order_line_modifiers%rowtype;
 invoice_id uuid; branch uuid; org uuid; actor uuid:=auth.uid(); ord bigint; changed integer;
begin
 if jsonb_typeof(p_order) is distinct from 'object' then raise exception 'POS_INVALID_ORDER'; end if;
 if not exists(select 1 from jsonb_array_elements(coalesce(p_order->'lines','[]'::jsonb)) l where l ? 'modifiers') then
  return public.pos_record_live_order_without_line_modifiers(p_order);
 end if;
 if p_order ? 'sourceTab' then raise exception 'POS_LINE_MODIFIER_TAB_UNSUPPORTED'; end if;
 if jsonb_typeof(p_order->'lines') is distinct from 'array' then raise exception 'POS_INVALID_ORDER'; end if;
 for line,ord in select value,ordinality from jsonb_array_elements(p_order->'lines') with ordinality loop
  if line ? 'modifiers' then
   if jsonb_typeof(line->'modifiers') is distinct from 'array' or jsonb_array_length(line->'modifiers') not between 1 and 8
    or exists(select 1 from jsonb_array_elements(line->'modifiers') x where jsonb_typeof(x.value) is distinct from 'string' or length(trim(x.value#>>'{}')) not between 1 and 80 or x.value#>>'{}'<>trim(x.value#>>'{}'))
    or (select count(*) from jsonb_array_elements(line->'modifiers'))<>(select count(distinct lower(value#>>'{}')) from jsonb_array_elements(line->'modifiers')) then raise exception 'POS_INVALID_ORDER'; end if;
   modifiers:=modifiers||jsonb_build_object(ord::text,line->'modifiers');
  end if;
 end loop;
 if modifiers='{}'::jsonb then raise exception 'POS_INVALID_ORDER'; end if;
 base:=jsonb_set(p_order,'{lines}',(select coalesce(jsonb_agg(value-'modifiers' order by ordinality),'[]'::jsonb) from jsonb_array_elements(p_order->'lines') with ordinality),true);
 result:=public.pos_record_live_order_without_line_modifiers(base);
 if result->>'status' is distinct from 'synced' or result->>'orderId' is distinct from base->>'id' or jsonb_typeof(result->'receipt') is distinct from 'object' then raise exception 'POS_INVALID_ORDER'; end if;
 invoice_id:=(result->'receipt'->>'id')::uuid; branch:=(base->>'branchId')::uuid;
 select organization_id into org from public.pos_branches where id=branch;
 if org is null or actor is null then raise exception 'POS_ACCESS_DENIED'; end if;
 select * into existing from public.pos_order_line_modifiers where order_id=(base->>'id')::uuid;
 if found then
  if existing.organization_id<>org or existing.branch_id<>branch or existing.invoice_id<>invoice_id or existing.actor_id<>actor or existing.modifiers<>modifiers then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
 else
  insert into public.pos_order_line_modifiers(order_id,organization_id,branch_id,invoice_id,actor_id,modifiers)
   values((base->>'id')::uuid,org,branch,invoice_id,actor,modifiers);
  update public.pos_kitchen_tickets t set lines=(select jsonb_agg(case when modifiers ? ord::text then jsonb_set(line,'{modifiers}',modifiers->ord::text,true) else line end order by ord)
    from jsonb_array_elements(t.lines) with ordinality x(line,ord))
   where t.order_id=(base->>'id')::uuid and t.organization_id=org and t.branch_id=branch;
  get diagnostics changed=row_count;
  if changed<>1 then raise exception 'POS_KITCHEN_MODIFIERS_UNAVAILABLE'; end if;
  insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
   values(org,branch,actor,'sale.line_modifiers_recorded',(base->>'id')::uuid,jsonb_build_object('invoiceId',invoice_id,'lineCount',jsonb_object_length(modifiers)));
 end if;
 return result||jsonb_build_object('receipt',public.pos_apply_line_modifiers(result->'receipt',modifiers));
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'POS_INVALID_ORDER';
end $$;
revoke all on function public.pos_record_live_order_unbound(jsonb) from public,anon,authenticated;
