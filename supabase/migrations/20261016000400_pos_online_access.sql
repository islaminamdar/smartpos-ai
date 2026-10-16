-- Server-only online session guards. No real user or merchant seed data.
create table public.pos_login_windows (
  key text primary key, window_started timestamptz not null, attempts integer not null
);
alter table public.pos_login_windows enable row level security;
revoke all on public.pos_login_windows from public,anon,authenticated;
create function public.pos_login_attempt(p_key text) returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer; v_global integer;
begin
  if p_key !~ '^[a-f0-9]{64}$' then return false; end if;
  -- Fixed-window rows are locked by each upsert, including a shared global cap.
  insert into public.pos_login_windows values ('global',now(),1)
  on conflict(key) do update set window_started=case when public.pos_login_windows.window_started < now()-interval '1 minute' then now() else public.pos_login_windows.window_started end,
    attempts=case when public.pos_login_windows.window_started < now()-interval '1 minute' then 1 else public.pos_login_windows.attempts+1 end returning attempts into v_global;
  if v_global>60 then return false; end if;
  insert into public.pos_login_windows values (p_key,now(),1)
  on conflict(key) do update set window_started=case when public.pos_login_windows.window_started < now()-interval '15 minutes' then now() else public.pos_login_windows.window_started end,
    attempts=case when public.pos_login_windows.window_started < now()-interval '15 minutes' then 1 else public.pos_login_windows.attempts+1 end returning attempts into v_count;
  delete from public.pos_login_windows where window_started < now()-interval '1 day';
  return v_count<=10;
end $$;
revoke all on function public.pos_login_attempt(text) from public,anon,authenticated;
grant execute on function public.pos_login_attempt(text) to service_role;

create table public.pos_device_bindings (
  token_hash text primary key check(token_hash ~ '^[a-f0-9]{64}$'), user_id uuid not null references auth.users,
  organization_id uuid not null, branch_id uuid not null, device_id uuid not null,
  created_at timestamptz not null default now(), revoked_at timestamptz,
  foreign key(organization_id,branch_id,device_id) references public.pos_devices(organization_id,branch_id,id)
);
alter table public.pos_device_bindings enable row level security;
revoke all on public.pos_device_bindings from public,anon,authenticated;
create function public.pos_bound_device(p_binding text) returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',d.id,'branchId',d.branch_id,'name',d.name)
  from public.pos_device_bindings b join public.pos_devices d on d.id=b.device_id
  where b.token_hash=p_binding and b.user_id=auth.uid() and b.revoked_at is null and d.active
    and public.pos_can_access(d.organization_id,d.branch_id)
$$;
revoke all on function public.pos_bound_device(text) from public,anon;
grant execute on function public.pos_bound_device(text) to authenticated;
create function public.pos_enroll_device(p_branch uuid,p_name text,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_org uuid; v_device uuid:=gen_random_uuid(); v_existing jsonb;
begin
  if auth.uid() is null or p_binding !~ '^[a-f0-9]{64}$' or length(trim(p_name)) not between 1 and 80 then raise exception 'POS_ACCESS_DENIED'; end if;
  select organization_id into v_org from public.pos_branches where id=p_branch and active;
  if v_org is null or not public.pos_can_access(v_org,p_branch) then raise exception 'POS_ACCESS_DENIED'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_binding,0));
  v_existing:=public.pos_bound_device(p_binding);
  if v_existing is not null then
    if v_existing->>'branchId'<>p_branch::text then raise exception 'POS_DEVICE_ALREADY_BOUND'; end if;
    return v_existing;
  end if;
  if exists(select 1 from public.pos_device_bindings where token_hash=p_binding) then raise exception 'POS_DEVICE_ALREADY_BOUND'; end if;
  insert into public.pos_devices(id,organization_id,branch_id,name) values(v_device,v_org,p_branch,trim(p_name));
  insert into public.pos_device_bindings(token_hash,user_id,organization_id,branch_id,device_id) values(p_binding,auth.uid(),v_org,p_branch,v_device);
  return jsonb_build_object('id',v_device,'branchId',p_branch,'name',trim(p_name));
end $$;
revoke all on function public.pos_enroll_device(uuid,text,text) from public,anon;
grant execute on function public.pos_enroll_device(uuid,text,text) to authenticated;

-- Even a JWT holder invoking PostgREST directly must supply its own device binding.
alter function public.pos_record_live_order(jsonb) rename to pos_record_live_order_unbound;
revoke all on function public.pos_record_live_order_unbound(jsonb) from public,anon,authenticated;
create function public.pos_record_live_order(p_order jsonb,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_device jsonb;
begin
  v_device:=public.pos_bound_device(p_binding);
  if v_device is null or v_device->>'id' is distinct from p_order->>'deviceId' or v_device->>'branchId' is distinct from p_order->>'branchId' then raise exception 'POS_DEVICE_INVALID'; end if;
  return public.pos_record_live_order_unbound(p_order);
end $$;
revoke all on function public.pos_record_live_order(jsonb,text) from public,anon;
grant execute on function public.pos_record_live_order(jsonb,text) to authenticated;
alter function public.pos_execute_live_command(jsonb) rename to pos_execute_live_command_unbound;
revoke all on function public.pos_execute_live_command_unbound(jsonb) from public,anon,authenticated;
create function public.pos_execute_live_command(p_command jsonb,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_device jsonb;
begin
  v_device:=public.pos_bound_device(p_binding);
  if v_device is null or v_device->>'id' is distinct from p_command->>'deviceId' or v_device->>'branchId' is distinct from p_command->>'branchId' then raise exception 'POS_DEVICE_INVALID'; end if;
  return public.pos_execute_live_command_unbound(p_command);
end $$;
revoke all on function public.pos_execute_live_command(jsonb,text) from public,anon;
grant execute on function public.pos_execute_live_command(jsonb,text) to authenticated;

create function public.pos_open_shift_summaries() returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'branchId',s.branch_id,'deviceId',s.device_id,'openedBy',s.opened_by,
    'openedAt',s.opened_at,'openingCashFils',s.opening_cash_fils,'expectedCashFils',s.opening_cash_fils
      +coalesce((select sum(p.amount_fils) from public.pos_payments p join public.pos_orders o on o.id=p.order_id where o.shift_id=s.id and p.method='cash'),0)
      +coalesce((select sum(amount_fils) from public.pos_cash_movements where shift_id=s.id),0)
      -coalesce((select sum(amount_fils) from public.pos_refunds where shift_id=s.id and method='cash'),0))), '[]'::jsonb)
  from public.pos_shifts s where s.status='open' and public.pos_can_access(s.organization_id,s.branch_id)
$$;
revoke all on function public.pos_open_shift_summaries() from public,anon;
grant execute on function public.pos_open_shift_summaries() to authenticated;
