-- Online recovery is an atomic committed-result lookup OR an immutable cancellation.
-- Cancelling never deletes paid records. A delayed original request cannot pass its tombstone.
create table public.pos_request_cancellations (
  kind text not null check(kind in ('sale','command')), request_id uuid not null,
  organization_id uuid not null, branch_id uuid not null, device_id uuid not null,
  actor_id uuid not null references auth.users, request_payload jsonb not null,
  cancelled_at timestamptz not null default now(), primary key(kind,request_id),
  foreign key(organization_id,branch_id,device_id) references public.pos_devices(organization_id,branch_id,id)
);
alter table public.pos_request_cancellations enable row level security;
revoke all on public.pos_request_cancellations from public,anon,authenticated;
create trigger pos_cancellations_immutable before update or delete on public.pos_request_cancellations
  for each row execute function public.pos_preserve_document();

create function public.pos_recovery_scope(p_request jsonb,p_binding text) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_device jsonb; v_org uuid;
begin
  if auth.uid() is null then raise exception 'POS_ACCESS_DENIED'; end if;
  if jsonb_typeof(p_request) is distinct from 'object' or p_request->>'id' is null
    or p_request->>'branchId' is null or p_request->>'deviceId' is null then raise exception 'POS_INVALID_REQUEST'; end if;
  perform (p_request->>'id')::uuid;
  v_device:=public.pos_bound_device(p_binding);
  if v_device is null or v_device->>'id' is distinct from p_request->>'deviceId'
    or v_device->>'branchId' is distinct from p_request->>'branchId' then raise exception 'POS_DEVICE_INVALID'; end if;
  select organization_id into v_org from public.pos_branches where id=(p_request->>'branchId')::uuid;
  if v_org is null or not public.pos_can_access(v_org,(p_request->>'branchId')::uuid) then raise exception 'POS_ACCESS_DENIED'; end if;
  return v_org;
exception when invalid_text_representation then raise exception 'POS_INVALID_REQUEST';
end; $$;
revoke all on function public.pos_recovery_scope(jsonb,text) from public,anon,authenticated;

create function public.pos_assert_not_cancelled(p_kind text,p_request jsonb,p_org uuid) returns void
language plpgsql security definer set search_path='' as $$
declare v_old public.pos_request_cancellations%rowtype;
begin
  select * into v_old from public.pos_request_cancellations where kind=p_kind and request_id=(p_request->>'id')::uuid;
  if found then
    if v_old.actor_id<>auth.uid() or v_old.organization_id<>p_org
      or v_old.branch_id<>(p_request->>'branchId')::uuid or v_old.device_id<>(p_request->>'deviceId')::uuid
      or v_old.request_payload<>p_request then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
    raise exception 'POS_REQUEST_CANCELLED';
  end if;
end; $$;
revoke all on function public.pos_assert_not_cancelled(text,jsonb,uuid) from public,anon,authenticated;

alter function public.pos_record_live_order(jsonb,text) rename to pos_record_live_order_before_recovery;
revoke all on function public.pos_record_live_order_before_recovery(jsonb,text) from public,anon,authenticated;
create function public.pos_record_live_order(p_order jsonb,p_binding text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_org uuid;
begin
  v_org:=public.pos_recovery_scope(p_order,p_binding);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(((p_order->>'id')::uuid)::text,0));
  perform public.pos_assert_not_cancelled('sale',p_order,v_org);
  return public.pos_record_live_order_before_recovery(p_order,p_binding);
end; $$;
revoke all on function public.pos_record_live_order(jsonb,text) from public,anon;
grant execute on function public.pos_record_live_order(jsonb,text) to authenticated;

alter function public.pos_execute_live_command(jsonb,text) rename to pos_execute_live_command_before_recovery;
revoke all on function public.pos_execute_live_command_before_recovery(jsonb,text) from public,anon,authenticated;
create function public.pos_execute_live_command(p_command jsonb,p_binding text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_org uuid;
begin
  v_org:=public.pos_recovery_scope(p_command,p_binding);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(((p_command->>'id')::uuid)::text,1));
  perform public.pos_assert_not_cancelled('command',p_command,v_org);
  return public.pos_execute_live_command_before_recovery(p_command,p_binding);
end; $$;
revoke all on function public.pos_execute_live_command(jsonb,text) from public,anon;
grant execute on function public.pos_execute_live_command(jsonb,text) to authenticated;

create function public.pos_resolve_live_request(p_kind text,p_request jsonb,p_binding text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_org uuid; v_id uuid; v_branch uuid; v_device uuid; v_old public.pos_request_cancellations%rowtype;
  v_invoice public.pos_documents%rowtype; v_command public.pos_command_receipts%rowtype;
begin
  if p_kind is null or p_kind not in ('sale','command') then raise exception 'POS_INVALID_REQUEST'; end if;
  v_org:=public.pos_recovery_scope(p_request,p_binding);
  v_id:=(p_request->>'id')::uuid; v_branch:=(p_request->>'branchId')::uuid; v_device:=(p_request->>'deviceId')::uuid;
  if p_kind='command' and coalesce(p_request->>'type','') not in ('shift.open','shift.close','cash.move','refund.full') then raise exception 'POS_INVALID_REQUEST'; end if;
  -- Same lock acquired by each financial wrapper BEFORE it can write or acknowledge anything.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_id::text,case p_kind when 'sale' then 0 else 1 end));
  if p_kind='sale' then
    select * into v_invoice from public.pos_documents where order_id=v_id and kind='tax_invoice';
    if found then
      if v_invoice.actor_id<>auth.uid() or v_invoice.organization_id<>v_org or v_invoice.branch_id<>v_branch
        or v_invoice.snapshot->>'deviceId'<>v_device::text or v_invoice.request_payload<>p_request then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
      return jsonb_build_object('status','synced','orderId',v_id,'totalFils',v_invoice.snapshot#>'{totals,grossFils}',
        'taxFils',v_invoice.snapshot#>'{totals,taxFils}','replayed',true,'receipt',v_invoice.snapshot);
    end if;
    -- A legacy financial original must not be mislabeled unsaved just because no fiscal snapshot exists.
    if exists(select 1 from public.pos_orders where id=v_id) then raise exception 'POS_LEGACY_RECEIPT_UNAVAILABLE'; end if;
  else
    select * into v_command from public.pos_command_receipts where id=v_id;
    if found then
      if v_command.actor_id<>auth.uid() or v_command.organization_id<>v_org or v_command.branch_id<>v_branch
        or v_command.payload<>p_request then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
      return v_command.result||jsonb_build_object('replayed',true);
    end if;
  end if;
  select * into v_old from public.pos_request_cancellations where kind=p_kind and request_id=v_id;
  if found then
    if v_old.actor_id<>auth.uid() or v_old.organization_id<>v_org or v_old.branch_id<>v_branch or v_old.device_id<>v_device
      or v_old.request_payload<>p_request then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('status','cancelled','requestId',v_id,'kind',p_kind,'replayed',true);
  end if;
  -- Foundation branches still permit their old RPCs. Only configured live branches can
  -- create tombstones, so no legacy mutation path can bypass a live cancellation.
  if not exists(select 1 from public.pos_branch_receipt_config where branch_id=v_branch and organization_id=v_org) then raise exception 'POS_PROFILE_REQUIRED'; end if;
  insert into public.pos_request_cancellations(kind,request_id,organization_id,branch_id,device_id,actor_id,request_payload)
    values(p_kind,v_id,v_org,v_branch,v_device,auth.uid(),p_request);
  insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
    values(v_org,v_branch,auth.uid(),'request.cancelled',v_id,jsonb_build_object('kind',p_kind,'deviceId',v_device));
  return jsonb_build_object('status','cancelled','requestId',v_id,'kind',p_kind,'replayed',false);
end; $$;
revoke all on function public.pos_resolve_live_request(text,jsonb,text) from public,anon;
grant execute on function public.pos_resolve_live_request(text,jsonb,text) to authenticated;
