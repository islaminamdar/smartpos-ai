-- Native drawer close reads only. Financial writes use the existing bound,
-- serialized pos_execute_live_command and its immutable original receipt.
create function public.pos_native_shift_close_context(p_branch uuid,p_device uuid,p_shift uuid,p_binding text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid;s public.pos_shifts;bound jsonb;reason text;
begin
 org:=public.pos_lock_staff_authority(p_branch);
 if org is null or not public.pos_can_access(org,p_branch) then raise exception 'POS_ACCESS_DENIED';end if;
 perform 1 from public.pos_devices where id=p_device and organization_id=org and branch_id=p_branch and active for update;
 if not found then raise exception 'POS_DEVICE_INVALID';end if;
 bound:=public.pos_bound_device(p_binding);
 if bound is null or bound->>'id' is distinct from p_device::text or bound->>'branchId' is distinct from p_branch::text then raise exception 'POS_DEVICE_INVALID';end if;
 select * into s from public.pos_shifts where id=p_shift and device_id=p_device and branch_id=p_branch and organization_id=org and opened_by=auth.uid() for update;
 if not found or s.status not in ('open','closed') then raise exception 'POS_SHIFT_INVALID';end if;
 if s.status='closed' then reason:='shift_already_closed';
 elsif not exists(select 1 from public.pos_branch_receipt_config where branch_id=p_branch and organization_id=org and live_enabled) then reason:='shift_close_unavailable';
 elsif exists(select 1 from public.pos_offline_authorities g where g.shift_id=s.id and public.pos_offline_payment_hold(g.key_epoch)) then reason:='payment_reconciliation_required';
 elsif exists(select 1 from public.pos_offline_authorities where shift_id=s.id and sealed_at is null) then reason:='offline_allocation_active';
 elsif exists(select 1 from public.pos_offline_exceptions x join public.pos_offline_authorities g on g.id=x.authority_id where g.shift_id=s.id and not exists(select 1 from public.pos_offline_exception_resolutions z where z.exception_id=x.id)) then reason:='offline_upload_required';
 end if;
 return jsonb_build_object('actorId',auth.uid(),'organizationId',org,'branchId',p_branch,'deviceId',p_device,'shiftId',p_shift,
  'status',s.status,'canClose',reason is null,'reasonCode',reason);
end $$;
revoke all on function public.pos_native_shift_close_context(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.pos_native_shift_close_context(uuid,uuid,uuid,text) to authenticated;

-- This lookup never executes or cancels an absent command. Historical binding
-- permits the original authenticated actor to retrieve a committed close after
-- staff/device revocation, without granting any current financial authority.
create function public.pos_native_shift_close_lookup(p_command jsonb,p_binding text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid;branch uuid;device uuid;shift uuid;v_request_id uuid;counted bigint;
 original public.pos_command_receipts;s public.pos_shifts;cancelled public.pos_request_cancellations;answer jsonb;result jsonb;state text:='not_found';
begin
 if auth.uid() is null then raise exception 'POS_ACCESS_DENIED';end if;
 if not public.pos_offline_exact_fields(p_command,array['id','type','branchId','deviceId','shiftId','countedCashFils']) or p_command->>'type' is distinct from 'shift.close' then raise exception 'POS_INVALID_COMMAND';end if;
 v_request_id:=public.pos_offline_uuid(p_command->'id');branch:=public.pos_offline_uuid(p_command->'branchId');device:=public.pos_offline_uuid(p_command->'deviceId');shift:=public.pos_offline_uuid(p_command->'shiftId');
 counted:=public.pos_offline_integer(p_command->'countedCashFils',0,100000000);
 select b.organization_id into org from public.pos_device_bindings b where b.token_hash=p_binding and b.user_id=auth.uid() and b.branch_id=branch and b.device_id=device;
 if org is null then raise exception 'POS_DEVICE_INVALID';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(org::text||':'||auth.uid()::text,15));
 perform pg_advisory_xact_lock(hashtextextended(v_request_id::text,1));
 select * into original from public.pos_command_receipts where id=v_request_id;
 if found then
  if original.actor_id<>auth.uid() or original.organization_id<>org or original.branch_id<>branch or original.command_type<>'shift.close' or original.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;
 end if;
 select * into s from public.pos_shifts where id=shift and organization_id=org and branch_id=branch and device_id=device and opened_by=auth.uid();
 if not found then raise exception 'POS_SHIFT_INVALID';end if;
 if original.id is not null then
  result:=original.result;
  if s.status<>'closed' or s.closed_at is null or s.counted_cash_fils is distinct from counted
   or result->>'status' is distinct from 'applied' or result->>'commandId' is distinct from v_request_id::text or result->>'shiftId' is distinct from shift::text
   or (result->>'countedCashFils')::bigint is distinct from counted or (result->>'expectedCashFils')::bigint is distinct from s.expected_cash_fils
   or (result->>'cashDifferenceFils')::bigint is distinct from s.cash_difference_fils or s.cash_difference_fils is distinct from counted-s.expected_cash_fils then raise exception 'POS_INVALID_CLOSE_RESULT';end if;
  state:='applied';answer:=jsonb_build_object('commandId',v_request_id,'shiftId',shift,'countedCashFils',counted,'expectedCashFils',s.expected_cash_fils,'cashDifferenceFils',s.cash_difference_fils,'closedAt',to_char(s.closed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 else
  select * into cancelled from public.pos_request_cancellations c where c.kind='command' and c.request_id=v_request_id;
  if found then
   if cancelled.actor_id<>auth.uid() or cancelled.organization_id<>org or cancelled.branch_id<>branch or cancelled.device_id<>device or cancelled.request_payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;
   state:='cancelled';
  end if;
 end if;
 return jsonb_build_object('actorId',auth.uid(),'organizationId',org,'branchId',branch,'deviceId',device,'shiftId',shift,'commandId',v_request_id,'countedCashFils',counted,'status',state,'result',answer);
end $$;
revoke all on function public.pos_native_shift_close_lookup(jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.pos_native_shift_close_lookup(jsonb,text) to authenticated;
