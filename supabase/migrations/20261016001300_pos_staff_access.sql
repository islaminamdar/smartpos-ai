-- Branch staff administration and application invitations. No Auth identities or email sends.
alter table public.pos_staff add column revision integer not null default 1 check(revision>0);
alter table public.pos_staff add column display_name text check(display_name is null or length(trim(display_name)) between 1 and 120);
create table public.pos_staff_commands (
 id uuid primary key, organization_id uuid not null, branch_id uuid not null, actor_id uuid not null references auth.users,
 kind text not null check(kind in ('staff.update','invitation.create','invitation.revoke')),
 payload jsonb not null, result jsonb not null, created_at timestamptz not null default now(),
 foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id)
);
create table public.pos_staff_invitations (
 id uuid primary key, organization_id uuid not null, management_branch_id uuid not null, branch_id uuid,
 invited_by uuid not null references auth.users, email text not null check(length(email) between 3 and 254 and email=lower(trim(email))),
 display_name text not null check(length(trim(display_name)) between 1 and 120),
 role text not null check(role in ('cashier','manager')), token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 status text not null default 'pending' check(status in ('pending','accepted','revoked','expired')),
 expires_at timestamptz not null, created_at timestamptz not null default now(), accepted_at timestamptz, accepted_by uuid references auth.users,
 foreign key(organization_id,management_branch_id) references public.pos_branches(organization_id,id),
 foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id),
 check(role<>'cashier' or branch_id is not null),
 check((status='accepted' and accepted_by is not null and accepted_at is not null) or (status<>'accepted' and accepted_by is null and accepted_at is null))
);
create unique index pos_one_pending_staff_invite on public.pos_staff_invitations(organization_id,email) where status='pending';
create index pos_staff_invitation_branch on public.pos_staff_invitations(management_branch_id,created_at desc);
alter table public.pos_staff_commands enable row level security;
alter table public.pos_staff_invitations enable row level security;
revoke all on public.pos_staff_commands,public.pos_staff_invitations from public,anon,authenticated;
create trigger pos_staff_commands_immutable before update or delete on public.pos_staff_commands for each row execute function public.pos_preserve_document();

-- Shared/exclusive actor authority gates come BEFORE request/device/shift/product locks.
-- Revocation never locks a device after a staff row, avoiding the financial lock inversion.
create function public.pos_lock_staff_authority(p_branch uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare org uuid;
begin
 if auth.uid() is null then raise exception 'POS_ACCESS_DENIED'; end if;
 select b.organization_id into org from public.pos_branches b where b.id=p_branch and b.active;
 if org is null then raise exception 'POS_ACCESS_DENIED'; end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(org::text||':'||auth.uid()::text,15));
 if not public.pos_can_access(org,p_branch) then raise exception 'POS_ACCESS_DENIED'; end if;
 return org;
end $$;
revoke all on function public.pos_lock_staff_authority(uuid) from public,anon,authenticated;

alter function public.pos_record_live_order(jsonb,text) rename to pos_record_live_order_before_staff;
revoke all on function public.pos_record_live_order_before_staff(jsonb,text) from public,anon,authenticated;
create function public.pos_record_live_order(p_order jsonb,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.pos_lock_staff_authority((p_order->>'branchId')::uuid);
 return public.pos_record_live_order_before_staff(p_order,p_binding);
end $$;
revoke all on function public.pos_record_live_order(jsonb,text) from public,anon;
grant execute on function public.pos_record_live_order(jsonb,text) to authenticated;

alter function public.pos_execute_live_command(jsonb,text) rename to pos_execute_live_command_before_staff;
revoke all on function public.pos_execute_live_command_before_staff(jsonb,text) from public,anon,authenticated;
create function public.pos_execute_live_command(p_command jsonb,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.pos_lock_staff_authority((p_command->>'branchId')::uuid);
 return public.pos_execute_live_command_before_staff(p_command,p_binding);
end $$;
revoke all on function public.pos_execute_live_command(jsonb,text) from public,anon;
grant execute on function public.pos_execute_live_command(jsonb,text) to authenticated;

alter function public.pos_record_paid_order(jsonb) rename to pos_record_paid_order_before_staff;
revoke all on function public.pos_record_paid_order_before_staff(jsonb) from public,anon,authenticated;
create function public.pos_record_paid_order(p_order jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.pos_lock_staff_authority((p_order->>'branchId')::uuid);
 return public.pos_record_paid_order_before_staff(p_order);
end $$;
revoke all on function public.pos_record_paid_order(jsonb) from public,anon;
grant execute on function public.pos_record_paid_order(jsonb) to authenticated;

alter function public.pos_execute_command(jsonb) rename to pos_execute_command_before_staff;
revoke all on function public.pos_execute_command_before_staff(jsonb) from public,anon,authenticated;
create function public.pos_execute_command(p_command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 -- Platform subscription bookkeeping has its own independent platform-admin authority.
 if p_command->>'type' is distinct from 'subscription.update' then perform public.pos_lock_staff_authority((p_command->>'branchId')::uuid); end if;
 return public.pos_execute_command_before_staff(p_command);
end $$;
revoke all on function public.pos_execute_command(jsonb) from public,anon;
grant execute on function public.pos_execute_command(jsonb) to authenticated;

alter function public.pos_resolve_live_request(text,jsonb,text) rename to pos_resolve_live_request_before_staff;
revoke all on function public.pos_resolve_live_request_before_staff(text,jsonb,text) from public,anon,authenticated;
create function public.pos_resolve_live_request(p_kind text,p_request jsonb,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.pos_lock_staff_authority((p_request->>'branchId')::uuid);
 return public.pos_resolve_live_request_before_staff(p_kind,p_request,p_binding);
end $$;
revoke all on function public.pos_resolve_live_request(text,jsonb,text) from public,anon;
grant execute on function public.pos_resolve_live_request(text,jsonb,text) to authenticated;

alter function public.pos_manage_catalogue(jsonb,text) rename to pos_manage_catalogue_before_staff;
revoke all on function public.pos_manage_catalogue_before_staff(jsonb,text) from public,anon,authenticated;
create function public.pos_manage_catalogue(p_command jsonb,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.pos_lock_staff_authority((p_command->>'branchId')::uuid);
 return public.pos_manage_catalogue_before_staff(p_command,p_binding);
end $$;
revoke all on function public.pos_manage_catalogue(jsonb,text) from public,anon;
grant execute on function public.pos_manage_catalogue(jsonb,text) to authenticated;

alter function public.pos_manage_offer(jsonb,text) rename to pos_manage_offer_before_staff;
revoke all on function public.pos_manage_offer_before_staff(jsonb,text) from public,anon,authenticated;
create function public.pos_manage_offer(p_command jsonb,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.pos_lock_staff_authority((p_command->>'branchId')::uuid);
 return public.pos_manage_offer_before_staff(p_command,p_binding);
end $$;
revoke all on function public.pos_manage_offer(jsonb,text) from public,anon;
grant execute on function public.pos_manage_offer(jsonb,text) to authenticated;

alter function public.pos_enroll_device(uuid,text,text) rename to pos_enroll_device_before_staff;
revoke all on function public.pos_enroll_device_before_staff(uuid,text,text) from public,anon,authenticated;
create function public.pos_enroll_device(p_branch uuid,p_name text,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.pos_lock_staff_authority(p_branch);
 return public.pos_enroll_device_before_staff(p_branch,p_name,p_binding);
end $$;
revoke all on function public.pos_enroll_device(uuid,text,text) from public,anon;
grant execute on function public.pos_enroll_device(uuid,text,text) to authenticated;

create function public.pos_staff_snapshot(p public.pos_staff) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('userId',p.user_id,'email',u.email,'displayName',p.display_name,'role',p.role,'branchId',p.branch_id,'active',p.active,'revision',p.revision) from auth.users u where u.id=p.user_id
$$;
revoke all on function public.pos_staff_snapshot(public.pos_staff) from public,anon,authenticated;
create function public.pos_invitation_snapshot(p public.pos_staff_invitations) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p.id,'email',p.email,'displayName',p.display_name,'role',p.role,'branchId',p.branch_id,
 'status',case when p.status='pending' and p.expires_at<=statement_timestamp() then 'expired' else p.status end,'expiresAt',p.expires_at,'createdAt',p.created_at)
$$;
revoke all on function public.pos_invitation_snapshot(public.pos_staff_invitations) from public,anon,authenticated;

-- Called under the actor shared gate. No caller-supplied role or organisation is trusted.
create function public.pos_staff_manager(p_branch uuid,p_binding text default null) returns public.pos_staff
language plpgsql security definer set search_path='' as $$
declare org uuid; staff public.pos_staff%rowtype; device jsonb;
begin
 select organization_id into org from public.pos_branches where id=p_branch and active;
 select * into staff from public.pos_staff s where s.organization_id=org and s.user_id=auth.uid() and s.active and s.role in ('owner','manager') and (s.branch_id is null or s.branch_id=p_branch);
 if not found then raise exception 'POS_MANAGER_REQUIRED'; end if;
 if p_binding is not null then
  device:=public.pos_bound_device(p_binding);
  if device is null or device->>'branchId' is distinct from p_branch::text then raise exception 'POS_DEVICE_INVALID'; end if;
 end if;
 return staff;
end $$;
revoke all on function public.pos_staff_manager(uuid,text) from public,anon,authenticated;

create function public.pos_staff_scope_allowed(p_actor public.pos_staff,p_branch uuid,p_role text,p_assigned uuid) returns boolean language sql immutable set search_path='' as $$
 select coalesce(p_role in ('cashier','manager') and (p_role<>'cashier' or p_assigned is not null) and
  case when p_actor.role='owner' then p_actor.branch_id is null or p_assigned=p_actor.branch_id
       when p_actor.role='manager' then p_role='cashier' and p_assigned=p_branch else false end,false)
$$;
revoke all on function public.pos_staff_scope_allowed(public.pos_staff,uuid,text,uuid) from public,anon,authenticated;

-- Capacity lock is acquired by every membership insert/move before this check.
create function public.pos_staff_check_capacity(p_org uuid,p_assigned uuid,p_exclude uuid default null) returns void
language plpgsql security definer set search_path='' as $$
declare globals integer; largest integer;
begin
 select count(*) into globals from public.pos_staff s where s.organization_id=p_org and s.branch_id is null and s.user_id is distinct from p_exclude;
 if p_assigned is null then
  select coalesce(max(c),0) into largest from (select count(*) c from public.pos_staff s where s.organization_id=p_org and s.branch_id is not null and s.user_id is distinct from p_exclude group by s.branch_id) q;
 else
  select count(*) into largest from public.pos_staff s where s.organization_id=p_org and s.branch_id=p_assigned and s.user_id is distinct from p_exclude;
 end if;
 if globals+largest>=500 then raise exception 'POS_STAFF_LIMIT_REACHED'; end if;
end $$;
revoke all on function public.pos_staff_check_capacity(uuid,uuid,uuid) from public,anon,authenticated;

create function public.pos_list_staff(p_branch uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.pos_staff%rowtype; org uuid; members jsonb; invites jsonb; history_count integer;
begin
 org:=public.pos_lock_staff_authority(p_branch); actor:=public.pos_staff_manager(p_branch);
 if (select count(*) from public.pos_staff s where s.organization_id=org and (s.branch_id=p_branch or s.branch_id is null))>500 then raise exception 'POS_STAFF_LIMIT_REACHED'; end if;
 if exists(select 1 from public.pos_shifts h where h.organization_id=org and h.status='open' group by h.opened_by having count(*)>500) then raise exception 'POS_STAFF_LIMIT_REACHED'; end if;
 select coalesce(jsonb_agg(public.pos_staff_snapshot(s)||jsonb_build_object('openShifts',(
  select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'deviceId',h.device_id,'deviceName',d.name,'openedAt',h.opened_at,
    'expectedCashFils',h.opening_cash_fils
      +coalesce((select sum(p.amount_fils) from public.pos_payments p join public.pos_orders o on o.id=p.order_id where o.shift_id=h.id and p.method='cash'),0)
      +coalesce((select sum(m.amount_fils) from public.pos_cash_movements m where m.shift_id=h.id),0)
      -coalesce((select sum(r.amount_fils) from public.pos_refunds r where r.shift_id=h.id and r.method='cash'),0)) order by h.opened_at),'[]')
  from public.pos_shifts h join public.pos_devices d on d.id=h.device_id where h.organization_id=org and h.opened_by=s.user_id and h.status='open' and public.pos_can_access(org,h.branch_id)
  )) order by s.role,s.display_name,s.user_id),'[]') into members
 from public.pos_staff s where s.organization_id=org and (s.branch_id=p_branch or s.branch_id is null)
  and (actor.role='owner' or (s.role='cashier' and s.branch_id=p_branch));
 if (select count(*) from public.pos_staff_invitations i where i.organization_id=org and i.management_branch_id=p_branch and i.status='pending' and i.expires_at>statement_timestamp())>100 then raise exception 'POS_INVITATION_LIMIT_REACHED'; end if;
 select count(*) into history_count from public.pos_staff_invitations i where i.organization_id=org and i.management_branch_id=p_branch
  and public.pos_staff_scope_allowed(actor,p_branch,i.role,i.branch_id) and (i.status<>'pending' or i.expires_at<=statement_timestamp());
 select coalesce(jsonb_agg(public.pos_invitation_snapshot(q) order by q.created_at desc,q.id),'[]') into invites from (
  select i.* from public.pos_staff_invitations i where i.organization_id=org and i.management_branch_id=p_branch and i.status='pending' and i.expires_at>statement_timestamp()
   and public.pos_staff_scope_allowed(actor,p_branch,i.role,i.branch_id)
  union all
  (select i.* from public.pos_staff_invitations i where i.organization_id=org and i.management_branch_id=p_branch and (i.status<>'pending' or i.expires_at<=statement_timestamp())
   and public.pos_staff_scope_allowed(actor,p_branch,i.role,i.branch_id) order by i.created_at desc,i.id limit 100)
 ) q;
 return jsonb_build_object('status','ready','organizationId',org,'branchId',p_branch,'actorRole',actor.role,'staff',members,'invitations',invites,'invitationHistoryTruncated',history_count>100);
end $$;
revoke all on function public.pos_list_staff(uuid) from public,anon;
grant execute on function public.pos_list_staff(uuid) to authenticated;

-- Uniform validation is enforced in SQL too: direct PostgREST calls cannot bypass the HTTP schema.
create function public.pos_validate_staff_command(p jsonb,p_keys text[]) returns void language plpgsql set search_path='' as $$
begin
 if jsonb_typeof(p) is distinct from 'object' or not p ?& p_keys or exists(select 1 from jsonb_object_keys(p) k where not(k=any(p_keys)))
  or jsonb_typeof(p->'reason') is distinct from 'string' or length(trim(p->>'reason')) not between 1 and 240
  or jsonb_typeof(p->'id') is distinct from 'string' or jsonb_typeof(p->'branchId') is distinct from 'string' or jsonb_typeof(p->'deviceId') is distinct from 'string'
 then raise exception 'POS_INVALID_STAFF_COMMAND'; end if;
 perform (p->>'id')::uuid; perform (p->>'branchId')::uuid; perform (p->>'deviceId')::uuid;
exception when invalid_text_representation then raise exception 'POS_INVALID_STAFF_COMMAND';
end $$;
revoke all on function public.pos_validate_staff_command(jsonb,text[]) from public,anon,authenticated;

create function public.pos_manage_staff(p_command jsonb,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.pos_staff%rowtype; target public.pos_staff%rowtype; old public.pos_staff_commands%rowtype;
 org uuid; branch uuid; assigned uuid; target_id uuid; request_id uuid; result jsonb; before_state jsonb; permission_change boolean; bound jsonb;
begin
 perform public.pos_validate_staff_command(p_command,array['id','branchId','deviceId','targetUserId','expectedRevision','active','role','assignedBranchId','displayName','reason']);
 if jsonb_typeof(p_command->'active') is distinct from 'boolean' or jsonb_typeof(p_command->'expectedRevision') is distinct from 'number'
  or coalesce(p_command->>'expectedRevision','') !~ '^[1-9][0-9]{0,9}$'
  or (p_command->>'expectedRevision')::numeric>2147483647
  or jsonb_typeof(p_command->'targetUserId') is distinct from 'string'
  or jsonb_typeof(p_command->'role') is distinct from 'string'
  or jsonb_typeof(p_command->'assignedBranchId') not in ('string','null')
  or jsonb_typeof(p_command->'displayName') not in ('string','null')
  or (p_command->>'displayName' is not null and length(trim(p_command->>'displayName')) not between 1 and 120)
 then raise exception 'POS_INVALID_STAFF_COMMAND'; end if;
 branch:=(p_command->>'branchId')::uuid; assigned:=(p_command->>'assignedBranchId')::uuid; target_id:=(p_command->>'targetUserId')::uuid; request_id:=(p_command->>'id')::uuid;
 org:=public.pos_lock_staff_authority(branch); actor:=public.pos_staff_manager(branch,p_binding); bound:=public.pos_bound_device(p_binding);
 if bound->>'id' is distinct from p_command->>'deviceId' then raise exception 'POS_DEVICE_INVALID'; end if;
 perform pg_advisory_xact_lock(hashtextextended(request_id::text,16));
 select * into old from public.pos_staff_commands where id=request_id;
 if found then
  if old.actor_id<>auth.uid() or old.organization_id<>org or old.kind<>'staff.update' or old.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  return old.result||jsonb_build_object('replayed',true);
 end if;
 perform public.pos_assert_staff_not_cancelled('staff.update',request_id,org,p_command);
 select * into target from public.pos_staff s where s.organization_id=org and s.user_id=target_id;
 if not found or target_id=auth.uid() or target.role='owner' or not public.pos_staff_scope_allowed(actor,branch,target.role,target.branch_id) then raise exception 'POS_STAFF_TARGET_FORBIDDEN'; end if;
 if not public.pos_staff_scope_allowed(actor,branch,p_command->>'role',assigned) then raise exception 'POS_STAFF_SCOPE_FORBIDDEN'; end if;
 if assigned is not null and not exists(select 1 from public.pos_branches b where b.id=assigned and b.organization_id=org and b.active) then raise exception 'POS_STAFF_SCOPE_FORBIDDEN'; end if;
 perform pg_advisory_xact_lock(hashtextextended(org::text||':'||target_id::text,15));
 perform pg_advisory_xact_lock(hashtextextended(org::text,17));
 select * into target from public.pos_staff s where s.organization_id=org and s.user_id=target_id for update;
 if not found or target.role='owner' or not public.pos_staff_scope_allowed(actor,branch,target.role,target.branch_id) then raise exception 'POS_STAFF_TARGET_FORBIDDEN'; end if;
 if target.revision>(p_command->>'expectedRevision')::integer then raise exception 'POS_STAFF_CHANGED'; end if;
 if target.revision<(p_command->>'expectedRevision')::integer then raise exception 'POS_STAFF_REVISION_AHEAD'; end if;
 permission_change:=target.role is distinct from p_command->>'role' or target.branch_id is distinct from assigned or (target.active and not (p_command->>'active')::boolean);
 if permission_change and exists(select 1 from public.pos_shifts h where h.organization_id=org and h.opened_by=target_id and h.status='open') then raise exception 'POS_STAFF_OPEN_SHIFT'; end if;
 perform public.pos_staff_check_capacity(org,assigned,target_id);
 before_state:=public.pos_staff_snapshot(target);
 update public.pos_staff set role=p_command->>'role',branch_id=assigned,active=(p_command->>'active')::boolean,display_name=trim(p_command->>'displayName'),revision=revision+1
  where organization_id=org and user_id=target_id returning * into target;
 if permission_change then update public.pos_device_bindings set revoked_at=coalesce(revoked_at,clock_timestamp()) where organization_id=org and user_id=target_id; end if;
 result:=jsonb_build_object('status','updated','requestId',request_id,'replayed',false,'staff',public.pos_staff_snapshot(target));
 insert into public.pos_staff_commands values(request_id,org,branch,auth.uid(),'staff.update',p_command,result,now());
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
  values(org,branch,auth.uid(),'staff.updated',target_id,jsonb_build_object('requestId',request_id,'reason',trim(p_command->>'reason'),
   'before',before_state-'email','after',(result->'staff')-'email'));
 return result;
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'POS_INVALID_STAFF_COMMAND';
end $$;
revoke all on function public.pos_manage_staff(jsonb,text) from public,anon;
grant execute on function public.pos_manage_staff(jsonb,text) to authenticated;

create function public.pos_create_staff_invitation(p_command jsonb,p_binding text,p_token_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.pos_staff%rowtype; invitation public.pos_staff_invitations%rowtype; old public.pos_staff_commands%rowtype;
 org uuid; branch uuid; assigned uuid; request_id uuid; expires timestamptz; mail text; result jsonb; payload jsonb; bound jsonb;
begin
 perform public.pos_validate_staff_command(p_command,array['id','branchId','deviceId','email','displayName','role','assignedBranchId','expiresAt','reason']);
 if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_command->'email') is distinct from 'string'
  or length(p_command->>'email') not between 3 and 254 or p_command->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  or jsonb_typeof(p_command->'displayName') is distinct from 'string' or length(trim(p_command->>'displayName')) not between 1 and 120
  or jsonb_typeof(p_command->'role') is distinct from 'string' or jsonb_typeof(p_command->'assignedBranchId') not in ('string','null')
  or jsonb_typeof(p_command->'expiresAt') is distinct from 'string' then raise exception 'POS_INVALID_STAFF_COMMAND'; end if;
 branch:=(p_command->>'branchId')::uuid; assigned:=(p_command->>'assignedBranchId')::uuid; request_id:=(p_command->>'id')::uuid; mail:=lower(trim(p_command->>'email')); expires:=(p_command->>'expiresAt')::timestamptz;
 org:=public.pos_lock_staff_authority(branch); actor:=public.pos_staff_manager(branch,p_binding); bound:=public.pos_bound_device(p_binding);
 if bound->>'id' is distinct from p_command->>'deviceId' then raise exception 'POS_DEVICE_INVALID'; end if;
 payload:=jsonb_build_object('command',p_command,'tokenHash',p_token_hash);
 perform pg_advisory_xact_lock(hashtextextended(request_id::text,16));
 select * into old from public.pos_staff_commands where id=request_id;
 if found then
  if old.actor_id<>auth.uid() or old.organization_id<>org or old.kind<>'invitation.create' or old.payload<>payload then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  return old.result||jsonb_build_object('replayed',true);
 end if;
 perform public.pos_assert_staff_not_cancelled('invitation.create',request_id,org,payload);
 if not public.pos_staff_scope_allowed(actor,branch,p_command->>'role',assigned) then raise exception 'POS_STAFF_SCOPE_FORBIDDEN'; end if;
 if assigned is not null and not exists(select 1 from public.pos_branches b where b.id=assigned and b.organization_id=org and b.active) then raise exception 'POS_STAFF_SCOPE_FORBIDDEN'; end if;
 if expires<=clock_timestamp() or expires>clock_timestamp()+interval '7 days' then raise exception 'POS_INVITATION_EXPIRY_INVALID'; end if;
 if exists(select 1 from auth.users u join public.pos_staff s on s.user_id=u.id where s.organization_id=org and lower(trim(u.email))=mail) then raise exception 'POS_STAFF_MEMBERSHIP_EXISTS'; end if;
 perform pg_advisory_xact_lock(hashtextextended(org::text,17));
 update public.pos_staff_invitations set status='expired' where organization_id=org and status='pending' and expires_at<=clock_timestamp();
 if exists(select 1 from public.pos_staff_invitations where organization_id=org and email=mail and status='pending') then raise exception 'POS_INVITATION_PENDING'; end if;
 if (select count(*) from public.pos_staff_invitations where organization_id=org and management_branch_id=branch and status='pending')>=100 then raise exception 'POS_INVITATION_LIMIT_REACHED'; end if;
 perform public.pos_staff_check_capacity(org,assigned);
 insert into public.pos_staff_invitations(id,organization_id,management_branch_id,branch_id,invited_by,email,display_name,role,token_hash,expires_at)
 values(request_id,org,branch,assigned,auth.uid(),mail,trim(p_command->>'displayName'),p_command->>'role',p_token_hash,expires) returning * into invitation;
 result:=jsonb_build_object('status','invited','requestId',request_id,'replayed',false,'invitation',public.pos_invitation_snapshot(invitation));
 insert into public.pos_staff_commands values(request_id,org,branch,auth.uid(),'invitation.create',payload,result,now());
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
 values(org,branch,auth.uid(),'staff.invited',request_id,jsonb_build_object('role',invitation.role,'assignedBranchId',assigned,'reason',trim(p_command->>'reason')));
 return result;
exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then raise exception 'POS_INVALID_STAFF_COMMAND';
end $$;
revoke all on function public.pos_create_staff_invitation(jsonb,text,text) from public,anon;
grant execute on function public.pos_create_staff_invitation(jsonb,text,text) to authenticated;

create function public.pos_revoke_staff_invitation(p_command jsonb,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.pos_staff%rowtype; invitation public.pos_staff_invitations%rowtype; old public.pos_staff_commands%rowtype;
 org uuid; branch uuid; request_id uuid; invite_id uuid; result jsonb; bound jsonb;
begin
 perform public.pos_validate_staff_command(p_command,array['id','branchId','deviceId','invitationId','reason']);
 if jsonb_typeof(p_command->'invitationId') is distinct from 'string' then raise exception 'POS_INVALID_STAFF_COMMAND'; end if;
 branch:=(p_command->>'branchId')::uuid; invite_id:=(p_command->>'invitationId')::uuid; request_id:=(p_command->>'id')::uuid;
 org:=public.pos_lock_staff_authority(branch); actor:=public.pos_staff_manager(branch,p_binding); bound:=public.pos_bound_device(p_binding);
 if bound->>'id' is distinct from p_command->>'deviceId' then raise exception 'POS_DEVICE_INVALID'; end if;
 perform pg_advisory_xact_lock(hashtextextended(request_id::text,16));
 select * into old from public.pos_staff_commands where id=request_id;
 if found then
  if old.actor_id<>auth.uid() or old.organization_id<>org or old.kind<>'invitation.revoke' or old.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  return old.result||jsonb_build_object('replayed',true);
 end if;
 perform public.pos_assert_staff_not_cancelled('invitation.revoke',request_id,org,p_command);
 select * into invitation from public.pos_staff_invitations where id=invite_id and organization_id=org and management_branch_id=branch for update;
 if not found or not public.pos_staff_scope_allowed(actor,branch,invitation.role,invitation.branch_id) then raise exception 'POS_INVITATION_FORBIDDEN'; end if;
 if invitation.status='accepted' then raise exception 'POS_INVITATION_ACCEPTED'; end if;
 update public.pos_staff_invitations set status='revoked' where id=invite_id;
 result:=jsonb_build_object('status','revoked','requestId',request_id,'replayed',false,'invitationId',invite_id);
 insert into public.pos_staff_commands values(request_id,org,branch,auth.uid(),'invitation.revoke',p_command,result,now());
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
 values(org,branch,auth.uid(),'staff.invitation_revoked',invite_id,jsonb_build_object('requestId',request_id,'reason',trim(p_command->>'reason')));
 return result;
exception when invalid_text_representation then raise exception 'POS_INVALID_STAFF_COMMAND';
end $$;
revoke all on function public.pos_revoke_staff_invitation(jsonb,text) from public,anon;
grant execute on function public.pos_revoke_staff_invitation(jsonb,text) to authenticated;

create function public.pos_accept_staff_invitation(p_token_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare invitation public.pos_staff_invitations%rowtype; inviter public.pos_staff%rowtype; recipient_mail text; confirmed timestamptz;
begin
 if auth.uid() is null or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'POS_INVITATION_INVALID'; end if;
 select * into invitation from public.pos_staff_invitations where token_hash=p_token_hash;
 if not found then raise exception 'POS_INVITATION_INVALID'; end if;
 -- Reject identities that already have authority before acquiring an inviter/recipient pair.
 -- This also avoids owner->manager versus manager-inviter->owner lock inversion on stale links.
 select lower(trim(u.email)),u.email_confirmed_at into recipient_mail,confirmed from auth.users u where u.id=auth.uid();
 if recipient_mail is distinct from invitation.email or confirmed is null then raise exception 'POS_INVITATION_IDENTITY_MISMATCH'; end if;
 if invitation.status='accepted' and invitation.accepted_by=auth.uid() then
  return jsonb_build_object('status','accepted','invitationId',invitation.id,'branchId',invitation.branch_id,'role',invitation.role,'replayed',true);
 end if;
 if exists(select 1 from public.pos_staff s where s.organization_id=invitation.organization_id and s.user_id=auth.uid()) then
  -- A duplicate acceptance can commit between our initial invitation read and this
  -- membership check. Refresh the same immutable acceptance before rejecting it.
  select * into invitation from public.pos_staff_invitations where token_hash=p_token_hash;
  if invitation.status='accepted' and invitation.accepted_by=auth.uid() then
   return jsonb_build_object('status','accepted','invitationId',invitation.id,'branchId',invitation.branch_id,'role',invitation.role,'replayed',true);
  end if;
  raise exception 'POS_STAFF_MEMBERSHIP_EXISTS';
 end if;
 -- The inviting authority must survive until commit; the recipient cannot race a staff update.
 if invitation.invited_by=auth.uid() then raise exception 'POS_INVITATION_INVALID'; end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(invitation.organization_id::text||':'||invitation.invited_by::text,15));
 perform pg_advisory_xact_lock(hashtextextended(invitation.organization_id::text||':'||auth.uid()::text,15));
 perform pg_advisory_xact_lock(hashtextextended(invitation.organization_id::text,17));
 select * into invitation from public.pos_staff_invitations where token_hash=p_token_hash for update;
 select lower(trim(u.email)),u.email_confirmed_at into recipient_mail,confirmed from auth.users u where u.id=auth.uid() for share;
 if recipient_mail is distinct from invitation.email or confirmed is null then raise exception 'POS_INVITATION_IDENTITY_MISMATCH'; end if;
 if invitation.status='accepted' and invitation.accepted_by=auth.uid() then
  return jsonb_build_object('status','accepted','invitationId',invitation.id,'branchId',invitation.branch_id,'role',invitation.role,'replayed',true);
 end if;
 if invitation.status<>'pending' or invitation.expires_at<=clock_timestamp() then raise exception 'POS_INVITATION_UNAVAILABLE'; end if;
 select * into inviter from public.pos_staff s where s.organization_id=invitation.organization_id and s.user_id=invitation.invited_by and s.active;
 if not found or (inviter.branch_id is not null and inviter.branch_id<>invitation.management_branch_id)
  or not public.pos_staff_scope_allowed(inviter,invitation.management_branch_id,invitation.role,invitation.branch_id)
  or not exists(select 1 from public.pos_branches b where b.id=invitation.management_branch_id and b.active)
  or (invitation.branch_id is not null and not exists(select 1 from public.pos_branches b where b.id=invitation.branch_id and b.active))
 then raise exception 'POS_INVITATION_UNAVAILABLE'; end if;
 if exists(select 1 from public.pos_staff s where s.organization_id=invitation.organization_id and s.user_id=auth.uid()) then raise exception 'POS_STAFF_MEMBERSHIP_EXISTS'; end if;
 perform public.pos_staff_check_capacity(invitation.organization_id,invitation.branch_id);
 insert into public.pos_staff(organization_id,user_id,branch_id,role,display_name) values(invitation.organization_id,auth.uid(),invitation.branch_id,invitation.role,invitation.display_name);
 update public.pos_staff_invitations set status='accepted',accepted_by=auth.uid(),accepted_at=clock_timestamp() where id=invitation.id;
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
 values(invitation.organization_id,invitation.management_branch_id,auth.uid(),'staff.invitation_accepted',invitation.id,jsonb_build_object('invitedBy',invitation.invited_by,'role',invitation.role,'assignedBranchId',invitation.branch_id));
 return jsonb_build_object('status','accepted','invitationId',invitation.id,'branchId',invitation.branch_id,'role',invitation.role,'replayed',false);
end $$;
revoke all on function public.pos_accept_staff_invitation(text) from public,anon;
grant execute on function public.pos_accept_staff_invitation(text) to authenticated;

-- A disabled cashier can acknowledge only their own already-committed request. The
-- old binding proves original device ownership; it grants no general read or write access.
create function public.pos_lookup_own_committed_request(p_kind text,p_request jsonb,p_binding text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid; branch uuid; device uuid; request_id uuid; invoice public.pos_documents%rowtype;
 original public.pos_offer_sale_requests%rowtype; command public.pos_command_receipts%rowtype;
begin
 if auth.uid() is null or p_kind is null or p_kind not in ('sale','command') or jsonb_typeof(p_request) is distinct from 'object'
  or p_request->>'id' is null or p_request->>'branchId' is null or p_request->>'deviceId' is null then raise exception 'POS_INVALID_REQUEST'; end if;
 branch:=(p_request->>'branchId')::uuid; device:=(p_request->>'deviceId')::uuid; request_id:=(p_request->>'id')::uuid;
 select b.organization_id into org from public.pos_device_bindings b where b.token_hash=p_binding and b.user_id=auth.uid() and b.branch_id=branch and b.device_id=device;
 if org is null then raise exception 'POS_DEVICE_INVALID'; end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(org::text||':'||auth.uid()::text,15));
 perform pg_advisory_xact_lock(hashtextextended(request_id::text,case p_kind when 'sale' then 0 else 1 end));
 if p_kind='sale' then
  select * into invoice from public.pos_documents d where d.order_id=request_id and d.kind='tax_invoice';
  if found then
   if invoice.actor_id<>auth.uid() or invoice.organization_id<>org or invoice.branch_id<>branch or invoice.snapshot->>'deviceId' is distinct from device::text then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
   select * into original from public.pos_offer_sale_requests r where r.order_id=request_id;
   if found then
    if original.actor_id<>auth.uid() or original.organization_id<>org or original.branch_id<>branch or original.device_id<>device or original.request_payload<>p_request then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
   elsif invoice.request_payload<>p_request then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
   return jsonb_build_object('status','synced','orderId',request_id,'totalFils',invoice.snapshot#>'{totals,grossFils}','taxFils',invoice.snapshot#>'{totals,taxFils}','replayed',true,'receipt',invoice.snapshot);
  end if;
 else
  if coalesce(p_request->>'type','') not in ('shift.open','shift.close','cash.move','refund.full') then raise exception 'POS_INVALID_REQUEST'; end if;
  select * into command from public.pos_command_receipts c where c.id=request_id;
  if found then
   if command.actor_id<>auth.uid() or command.organization_id<>org or command.branch_id<>branch or command.payload<>p_request then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
   return command.result||jsonb_build_object('replayed',true);
  end if;
 end if;
 raise exception 'POS_STAFF_INACTIVE';
exception when invalid_text_representation then raise exception 'POS_INVALID_REQUEST';
end $$;
revoke all on function public.pos_lookup_own_committed_request(text,jsonb,text) from public,anon;
grant execute on function public.pos_lookup_own_committed_request(text,jsonb,text) to authenticated;

-- Restored access may resolve an old device's journal without restoring that device's
-- permission to sell. This historical-binding exception exists ONLY in recovery.
create or replace function public.pos_resolve_live_request(p_kind text,p_request jsonb,p_binding text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid; branch uuid; device uuid; v_request_id uuid; result jsonb; cancelled public.pos_request_cancellations%rowtype;
begin
 if p_kind is null or p_kind not in ('sale','command') or jsonb_typeof(p_request) is distinct from 'object'
  or p_request->>'id' is null or p_request->>'branchId' is null or p_request->>'deviceId' is null then raise exception 'POS_INVALID_REQUEST'; end if;
 branch:=(p_request->>'branchId')::uuid; device:=(p_request->>'deviceId')::uuid; v_request_id:=(p_request->>'id')::uuid;
 org:=public.pos_lock_staff_authority(branch);
 if not exists(select 1 from public.pos_device_bindings b where b.token_hash=p_binding and b.user_id=auth.uid() and b.organization_id=org and b.branch_id=branch and b.device_id=device) then raise exception 'POS_DEVICE_INVALID'; end if;
 if p_kind='command' and coalesce(p_request->>'type','') not in ('shift.open','shift.close','cash.move','refund.full') then raise exception 'POS_INVALID_REQUEST'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_request_id::text,case p_kind when 'sale' then 0 else 1 end));
 begin
  return public.pos_lookup_own_committed_request(p_kind,p_request,p_binding);
 exception when raise_exception then
  if sqlerrm<>'POS_STAFF_INACTIVE' then raise; end if;
 end;
 if p_kind='sale' and exists(select 1 from public.pos_orders where id=v_request_id) then raise exception 'POS_LEGACY_RECEIPT_UNAVAILABLE'; end if;
 select * into cancelled from public.pos_request_cancellations c where c.kind=p_kind and c.request_id=v_request_id;
 if found then
  if cancelled.actor_id<>auth.uid() or cancelled.organization_id<>org or cancelled.branch_id<>branch or cancelled.device_id<>device or cancelled.request_payload<>p_request then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  return jsonb_build_object('status','cancelled','requestId',v_request_id,'kind',p_kind,'replayed',true);
 end if;
 if not exists(select 1 from public.pos_branch_receipt_config c where c.branch_id=branch and c.organization_id=org) then raise exception 'POS_PROFILE_REQUIRED'; end if;
 insert into public.pos_request_cancellations(kind,request_id,organization_id,branch_id,device_id,actor_id,request_payload)
 values(p_kind,v_request_id,org,branch,device,auth.uid(),p_request);
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
 values(org,branch,auth.uid(),'request.cancelled',v_request_id,jsonb_build_object('kind',p_kind,'deviceId',device));
 return jsonb_build_object('status','cancelled','requestId',v_request_id,'kind',p_kind,'replayed',false);
exception when invalid_text_representation then raise exception 'POS_INVALID_REQUEST';
end $$;

-- Management requests have the same durable resolve/cancel guarantee as paid sales.
-- These private tombstones never contain raw setup tokens and are immutable.
create table public.pos_staff_request_cancellations (
 request_id uuid primary key, organization_id uuid not null, branch_id uuid not null, actor_id uuid not null references auth.users,
 kind text not null check(kind in ('staff.update','invitation.create','invitation.revoke')),
 payload jsonb not null, cancelled_at timestamptz not null default now(),
 foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id)
);
alter table public.pos_staff_request_cancellations enable row level security;
revoke all on public.pos_staff_request_cancellations from public,anon,authenticated;
create trigger pos_staff_cancellations_immutable before update or delete on public.pos_staff_request_cancellations for each row execute function public.pos_preserve_document();
create function public.pos_assert_staff_not_cancelled(p_kind text,p_id uuid,p_org uuid,p_payload jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare cancelled public.pos_staff_request_cancellations%rowtype;
begin
 select * into cancelled from public.pos_staff_request_cancellations where request_id=p_id;
 if found then
  if cancelled.kind<>p_kind or cancelled.organization_id<>p_org or cancelled.actor_id<>auth.uid() or cancelled.payload<>p_payload then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  raise exception 'POS_REQUEST_CANCELLED';
 end if;
end $$;
revoke all on function public.pos_assert_staff_not_cancelled(text,uuid,uuid,jsonb) from public,anon,authenticated;

create function public.pos_resolve_staff_request(p_kind text,p_command jsonb,p_binding text,p_token_hash text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid; branch uuid; original_device uuid; v_request_id uuid; bound jsonb; original public.pos_staff_commands%rowtype;
 cancelled public.pos_staff_request_cancellations%rowtype; payload jsonb; actor public.pos_staff%rowtype;
begin
 if auth.uid() is null or p_kind is null or p_kind not in ('staff.update','invitation.create','invitation.revoke') then raise exception 'POS_INVALID_STAFF_COMMAND'; end if;
 perform public.pos_validate_staff_command(p_command,case p_kind
  when 'staff.update' then array['id','branchId','deviceId','targetUserId','expectedRevision','active','role','assignedBranchId','displayName','reason']
  when 'invitation.create' then array['id','branchId','deviceId','email','displayName','role','assignedBranchId','expiresAt','reason']
  else array['id','branchId','deviceId','invitationId','reason'] end);
 branch:=(p_command->>'branchId')::uuid; original_device:=(p_command->>'deviceId')::uuid; v_request_id:=(p_command->>'id')::uuid;
 if p_kind='invitation.create' then
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'POS_INVALID_STAFF_COMMAND'; end if;
  payload:=jsonb_build_object('command',p_command,'tokenHash',p_token_hash);
 else
  if p_token_hash is not null then raise exception 'POS_INVALID_STAFF_COMMAND'; end if;
  payload:=p_command;
 end if;
 -- Verify original device ownership independently, including after the original
 -- cookie has been replaced by enrollment of another device by the same person.
 select b.organization_id into org from public.pos_device_bindings b where b.user_id=auth.uid() and b.branch_id=branch and b.device_id=original_device limit 1;
 if org is null then raise exception 'POS_DEVICE_INVALID'; end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(org::text||':'||auth.uid()::text,15));
 if not exists(select 1 from public.pos_device_bindings b where b.token_hash=p_binding and b.user_id=auth.uid() and b.organization_id=org and b.branch_id=branch and b.device_id=original_device) then
  bound:=public.pos_bound_device(p_binding);
  if bound is null or bound->>'branchId' is distinct from branch::text then raise exception 'POS_DEVICE_INVALID'; end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(v_request_id::text,16));
 select * into original from public.pos_staff_commands c where c.id=v_request_id;
 if found then
  if original.actor_id<>auth.uid() or original.organization_id<>org or original.branch_id<>branch or original.kind<>p_kind or original.payload<>payload then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  return original.result||jsonb_build_object('replayed',true);
 end if;
 -- A missing operation may only be cancelled by an active manager for this branch.
 -- Read-only committed lookup above is the only inactive-staff exception.
 actor:=public.pos_staff_manager(branch);
 select * into cancelled from public.pos_staff_request_cancellations c where c.request_id=v_request_id;
 if found then
  if cancelled.actor_id<>auth.uid() or cancelled.organization_id<>org or cancelled.branch_id<>branch or cancelled.kind<>p_kind or cancelled.payload<>payload then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  return jsonb_build_object('status','cancelled','requestId',v_request_id,'kind',p_kind,'replayed',true);
 end if;
 insert into public.pos_staff_request_cancellations(request_id,organization_id,branch_id,actor_id,kind,payload)
 values(v_request_id,org,branch,auth.uid(),p_kind,payload);
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
 values(org,branch,auth.uid(),'staff.request_cancelled',v_request_id,jsonb_build_object('kind',p_kind,'deviceId',original_device));
 return jsonb_build_object('status','cancelled','requestId',v_request_id,'kind',p_kind,'replayed',false);
exception when invalid_text_representation then raise exception 'POS_INVALID_STAFF_COMMAND';
end $$;
revoke all on function public.pos_resolve_staff_request(text,jsonb,text,text) from public,anon;
grant execute on function public.pos_resolve_staff_request(text,jsonb,text,text) to authenticated;
