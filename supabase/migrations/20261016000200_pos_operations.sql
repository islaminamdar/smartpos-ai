-- Operational commands are atomic and audited. Never seeds customer/admin identities.
alter table public.pos_shifts add column counted_cash_fils bigint;
alter table public.pos_shifts add column expected_cash_fils bigint;
alter table public.pos_shifts add column cash_difference_fils bigint;
create table public.pos_platform_admins (
  user_id uuid primary key references auth.users, active boolean not null default true
);
alter table public.pos_platform_admins enable row level security;
revoke all on public.pos_platform_admins from public, anon, authenticated;
grant select on public.pos_platform_admins to authenticated;
create policy pos_admin_self on public.pos_platform_admins for select to authenticated using (user_id = auth.uid());
create function public.pos_is_platform_admin() returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.pos_platform_admins where user_id = auth.uid() and active);
$$;
revoke all on function public.pos_is_platform_admin() from public,anon;
grant execute on function public.pos_is_platform_admin() to authenticated;
create policy pos_subscription_platform_read on public.pos_subscriptions for select to authenticated using (public.pos_is_platform_admin());

create table public.pos_command_receipts (
  id uuid primary key, organization_id uuid not null, branch_id uuid not null,
  actor_id uuid not null references auth.users, command_type text not null,
  payload jsonb not null, result jsonb not null, recorded_at timestamptz not null default now(),
  foreign key (organization_id,branch_id) references public.pos_branches(organization_id,id)
);
create table public.pos_cash_movements (
  id uuid primary key, organization_id uuid not null, branch_id uuid not null, device_id uuid not null,
  shift_id uuid not null, actor_id uuid not null references auth.users,
  amount_fils integer not null check (amount_fils between -100000000 and 100000000 and amount_fils <> 0),
  reason text not null check (length(trim(reason)) between 1 and 240), created_at timestamptz not null default now(),
  foreign key (organization_id,branch_id,device_id,shift_id) references public.pos_shifts(organization_id,branch_id,device_id,id)
);
create table public.pos_refunds (
  id uuid primary key, organization_id uuid not null, branch_id uuid not null,
  order_id uuid not null, device_id uuid not null, shift_id uuid not null,
  actor_id uuid not null references auth.users, method text not null check (method in ('cash','card','other')),
  amount_fils integer not null check (amount_fils between 1 and 100000000),
  reason text not null check (length(trim(reason)) between 1 and 240), created_at timestamptz not null default now(),
  foreign key (organization_id,branch_id,order_id) references public.pos_orders(organization_id,branch_id,id),
  foreign key (organization_id,branch_id,device_id,shift_id) references public.pos_shifts(organization_id,branch_id,device_id,id)
);
create index pos_refunds_order_tender on public.pos_refunds(order_id,method);
create index pos_cash_movements_shift on public.pos_cash_movements(shift_id);
create index pos_refunds_shift on public.pos_refunds(shift_id);
do $$
declare t text;
begin
  foreach t in array array['pos_command_receipts','pos_cash_movements','pos_refunds'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy %I on public.%I for select to authenticated using (public.pos_can_access(organization_id,branch_id))',t || '_read',t);
  end loop;
end $$;

create function public.pos_execute_command(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid(); v_id uuid; v_branch uuid; v_org uuid; v_device uuid; v_shift uuid;
  v_type text; v_allowed text[]; v_result jsonb; v_old public.pos_command_receipts%rowtype;
  v_shift_row public.pos_shifts%rowtype; v_order public.pos_orders%rowtype;
  v_amount integer; v_expected bigint; v_counted bigint; v_paid bigint; v_refunded bigint;
  v_role text; v_reason text;
begin
  if v_actor is null then raise exception 'POS_ACCESS_DENIED'; end if;
  if jsonb_typeof(p_command) is distinct from 'object' then raise exception 'POS_INVALID_COMMAND'; end if;
  v_type := p_command->>'type';
  v_allowed := case v_type
    when 'shift.open' then array['id','type','branchId','deviceId','shiftId','openingCashFils']
    when 'shift.close' then array['id','type','branchId','deviceId','shiftId','countedCashFils']
    when 'cash.move' then array['id','type','branchId','deviceId','shiftId','amountFils','reason']
    when 'refund.create' then array['id','type','branchId','deviceId','shiftId','orderId','method','amountFils','reason']
    when 'subscription.update' then array['id','type','branchId','status','paidThrough','reason']
    else null end;
  if v_allowed is null or not (p_command ?& v_allowed) or (p_command - v_allowed) <> '{}'::jsonb then raise exception 'POS_INVALID_COMMAND'; end if;
  v_id := (p_command->>'id')::uuid; v_branch := (p_command->>'branchId')::uuid;
  if v_id is null or v_branch is null then raise exception 'POS_INVALID_COMMAND'; end if;
  select organization_id into v_org from public.pos_branches where id=v_branch;
  if v_org is null then raise exception 'POS_ACCESS_DENIED'; end if;
  if v_type = 'subscription.update' then
    if not public.pos_is_platform_admin() then raise exception 'POS_ADMIN_REQUIRED'; end if;
  else
    if not public.pos_can_access(v_org,v_branch) then raise exception 'POS_ACCESS_DENIED'; end if;
    select role into v_role from public.pos_staff where organization_id=v_org and user_id=v_actor and active;
    if v_type in ('refund.create','cash.move') and v_role not in ('owner','manager') then raise exception 'POS_MANAGER_REQUIRED'; end if;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_id::text, 1));
  select * into v_old from public.pos_command_receipts where id=v_id;
  if found then
    if v_old.actor_id <> v_actor or v_old.payload <> p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
    return v_old.result || jsonb_build_object('replayed',true);
  end if;
  if v_type in ('cash.move','refund.create','subscription.update') then
    v_reason := trim(p_command->>'reason');
    if v_reason is null or length(v_reason) not between 1 and 240 then raise exception 'POS_INVALID_COMMAND'; end if;
  end if;
  if v_type = 'subscription.update' then
    if coalesce(p_command->>'status','') not in ('trial','active','past_due','cancelled')
      or (p_command->>'paidThrough' is not null and (p_command->>'paidThrough') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
      then raise exception 'POS_INVALID_COMMAND'; end if;
    insert into public.pos_subscriptions(organization_id,branch_id,status,paid_through)
      values(v_org,v_branch,p_command->>'status',(p_command->>'paidThrough')::date)
      on conflict(branch_id) do update set status=excluded.status,paid_through=excluded.paid_through,updated_at=now();
    v_result := jsonb_build_object('status','applied','commandId',v_id,'subscriptionStatus',p_command->>'status','paidThrough',p_command->>'paidThrough','replayed',false);
  else
    v_device := (p_command->>'deviceId')::uuid; v_shift := (p_command->>'shiftId')::uuid;
    if v_device is null or v_shift is null then raise exception 'POS_INVALID_COMMAND'; end if;
    -- Lock device first for consistent operational lock ordering; an inactive device cannot mutate.
    perform 1 from public.pos_devices d join public.pos_branches b on b.id=d.branch_id
      where d.id=v_device and d.organization_id=v_org and d.branch_id=v_branch and d.active and b.active for update of d;
    if not found then raise exception 'POS_DEVICE_INVALID'; end if;
    if v_type = 'shift.open' then
      if coalesce(p_command->>'openingCashFils','') !~ '^[0-9]{1,9}$' then raise exception 'POS_INVALID_COMMAND'; end if;
      v_amount := (p_command->>'openingCashFils')::integer;
      if v_amount not between 0 and 100000000 then raise exception 'POS_INVALID_COMMAND'; end if;
      if exists(select 1 from public.pos_shifts where device_id=v_device and status='open') then raise exception 'POS_SHIFT_ALREADY_OPEN'; end if;
      if exists(select 1 from public.pos_shifts where id=v_shift) then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
      insert into public.pos_shifts(id,organization_id,branch_id,device_id,opened_by,opening_cash_fils)
        values(v_shift,v_org,v_branch,v_device,v_actor,v_amount);
      v_result := jsonb_build_object('status','applied','commandId',v_id,'shiftId',v_shift,'replayed',false);
    else
      select * into v_shift_row from public.pos_shifts where id=v_shift and organization_id=v_org and branch_id=v_branch and device_id=v_device for update;
      if not found or v_shift_row.opened_by <> v_actor then raise exception 'POS_SHIFT_INVALID'; end if;
      if v_shift_row.status <> 'open' then raise exception 'POS_SHIFT_CLOSED'; end if;
      if v_type = 'shift.close' then
        if coalesce(p_command->>'countedCashFils','') !~ '^[0-9]{1,9}$' then raise exception 'POS_INVALID_COMMAND'; end if;
        v_counted := (p_command->>'countedCashFils')::bigint;
        if v_counted not between 0 and 100000000 then raise exception 'POS_INVALID_COMMAND'; end if;
        select v_shift_row.opening_cash_fils
          + coalesce((select sum(p.amount_fils) from public.pos_payments p join public.pos_orders o on o.id=p.order_id where o.shift_id=v_shift and p.method='cash'),0)
          + coalesce((select sum(amount_fils) from public.pos_cash_movements where shift_id=v_shift),0)
          - coalesce((select sum(amount_fils) from public.pos_refunds where shift_id=v_shift and method='cash'),0) into v_expected;
        update public.pos_shifts set status='closed',closed_at=now(),counted_cash_fils=v_counted,expected_cash_fils=v_expected,cash_difference_fils=v_counted-v_expected where id=v_shift;
        v_result := jsonb_build_object('status','applied','commandId',v_id,'shiftId',v_shift,'expectedCashFils',v_expected,'countedCashFils',v_counted,'cashDifferenceFils',v_counted-v_expected,'replayed',false);
      else
        if coalesce(p_command->>'amountFils','') !~ '^-?[0-9]{1,9}$' then raise exception 'POS_INVALID_COMMAND'; end if;
        v_amount := (p_command->>'amountFils')::integer;
        if v_amount = 0 or v_amount not between -100000000 and 100000000 then raise exception 'POS_INVALID_COMMAND'; end if;
        if v_type = 'cash.move' then
          insert into public.pos_cash_movements(id,organization_id,branch_id,device_id,shift_id,actor_id,amount_fils,reason)
            values(v_id,v_org,v_branch,v_device,v_shift,v_actor,v_amount,v_reason);
        else
          if v_amount < 1 or coalesce(p_command->>'method','') not in ('cash','card','other') then raise exception 'POS_INVALID_COMMAND'; end if;
          -- Serializes every device's refund attempts against the original sale.
          select * into v_order from public.pos_orders where id=(p_command->>'orderId')::uuid and organization_id=v_org and branch_id=v_branch for update;
          if not found then raise exception 'POS_ORDER_UNAVAILABLE'; end if;
          select coalesce(sum(amount_fils),0) into v_paid from public.pos_payments where order_id=v_order.id and method=p_command->>'method';
          select coalesce(sum(amount_fils),0) into v_refunded from public.pos_refunds where order_id=v_order.id and method=p_command->>'method';
          if v_amount > v_paid-v_refunded then raise exception 'POS_REFUND_LIMIT'; end if;
          insert into public.pos_refunds(id,organization_id,branch_id,order_id,device_id,shift_id,actor_id,method,amount_fils,reason)
            values(v_id,v_org,v_branch,v_order.id,v_device,v_shift,v_actor,p_command->>'method',v_amount,v_reason);
        end if;
        v_result := jsonb_build_object('status','applied','commandId',v_id,'amountFils',v_amount,'replayed',false);
      end if;
    end if;
  end if;
  insert into public.pos_command_receipts(id,organization_id,branch_id,actor_id,command_type,payload,result)
    values(v_id,v_org,v_branch,v_actor,v_type,p_command,v_result);
  insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
    values(v_org,v_branch,v_actor,v_type,v_id,jsonb_build_object('result',v_result,'reason',v_reason));
  return v_result;
exception when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
  raise exception 'POS_INVALID_COMMAND';
end;
$$;
revoke all on function public.pos_execute_command(jsonb) from public,anon;
grant execute on function public.pos_execute_command(jsonb) to authenticated;
