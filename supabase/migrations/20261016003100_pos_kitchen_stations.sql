-- Configuration foundation only: no preparation routing or financial projection changes.
-- Lock namespaces: existing15 actor authority; new43 request,44 branch configuration,
-- 45 station identity. Order: actor -> request -> branch row/staff/device/binding ->
-- branch configuration -> station identity. No order, shift or tab locks are acquired.
create function public.pos_station_trim(p text) returns text language sql immutable set search_path='' as $$
 select btrim(p,chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
 chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||
 chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279))
$$;
create table public.pos_kitchen_station_config (
 branch_id uuid primary key, organization_id uuid not null,
 revision integer not null check(revision between 1 and 2147483647),
 foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id)
);
create table public.pos_kitchen_stations (
 id uuid primary key, organization_id uuid not null, branch_id uuid not null,
 name text not null check(name=public.pos_station_trim(name) and length(name) between 1 and 60 and lower(name)<>'general' and name !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')),
 active boolean not null, created_at timestamptz not null, updated_at timestamptz not null check(updated_at>=created_at),
 foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id),
 unique(organization_id,branch_id,id)
);
create unique index pos_kitchen_station_active_name on public.pos_kitchen_stations(branch_id,lower(name)) where active;
create index pos_kitchen_stations_branch on public.pos_kitchen_stations(branch_id,id);
create table public.pos_kitchen_product_routes (
 organization_id uuid not null, branch_id uuid not null, product_id uuid primary key, station_id uuid not null,
 foreign key(organization_id,branch_id,product_id) references public.pos_products(organization_id,branch_id,id),
 foreign key(organization_id,branch_id,station_id) references public.pos_kitchen_stations(organization_id,branch_id,id)
);
create index pos_kitchen_routes_branch on public.pos_kitchen_product_routes(branch_id,product_id);
create index pos_kitchen_routes_station on public.pos_kitchen_product_routes(station_id);
create table public.pos_kitchen_station_commands (
 id uuid primary key, organization_id uuid not null, branch_id uuid not null,
 actor_id uuid not null references auth.users, device_id uuid not null,
 payload jsonb not null, result jsonb not null,
 status text not null check(status in ('applied','cancelled')), created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,branch_id,device_id) references public.pos_devices(organization_id,branch_id,id),
 check(result->>'status'=status and result->>'requestId'=id::text and result->>'branchId'=branch_id::text)
);
alter table public.pos_kitchen_station_config enable row level security;
alter table public.pos_kitchen_stations enable row level security;
alter table public.pos_kitchen_product_routes enable row level security;
alter table public.pos_kitchen_station_commands enable row level security;
revoke all on public.pos_kitchen_station_config,public.pos_kitchen_stations,public.pos_kitchen_product_routes,public.pos_kitchen_station_commands from public,anon,authenticated,service_role;
create trigger pos_kitchen_station_commands_immutable before update or delete on public.pos_kitchen_station_commands for each row execute function public.pos_preserve_document();
create function public.pos_station_identity_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'POS_STATION_INVALID';end if;
 if new.id<>old.id or new.organization_id<>old.organization_id or new.branch_id<>old.branch_id or new.created_at<>old.created_at then raise exception 'POS_STATION_INVALID';end if;
 return new;
end $$;
create trigger pos_kitchen_station_identity before update or delete on public.pos_kitchen_stations for each row execute function public.pos_station_identity_guard();

create function public.pos_station_uuid(p jsonb) returns uuid language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p) is distinct from 'string' or p#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'POS_STATION_INVALID';end if;
 return (p#>>'{}')::uuid;
end $$;
create function public.pos_station_validate(p jsonb) returns void language plpgsql immutable set search_path='' as $$
declare keys text[];s jsonb;n numeric;
begin
 if jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>4096 then raise exception 'POS_STATION_INVALID';end if;
 if p->>'type'='station.save' then keys:=array['id','branchId','deviceId','expectedRevision','type','station'];
 elsif p->>'type'='route.set' then keys:=array['id','branchId','deviceId','expectedRevision','type','productId','stationId'];
 else raise exception 'POS_STATION_INVALID';end if;
 if not p ?& keys or (p-keys)<>'{}'::jsonb then raise exception 'POS_STATION_INVALID';end if;
 perform public.pos_station_uuid(p->'id');perform public.pos_station_uuid(p->'branchId');perform public.pos_station_uuid(p->'deviceId');
 if jsonb_typeof(p->'expectedRevision') is distinct from 'number' then raise exception 'POS_STATION_INVALID';end if;
 n:=(p->>'expectedRevision')::numeric;
 if n<>trunc(n) or n not between 0 and 2147483646 then raise exception 'POS_STATION_INVALID';end if;
 if p->>'type'='station.save' then
  s:=p->'station';keys:=array['id','name','active'];
  if jsonb_typeof(s) is distinct from 'object' or not s ?& keys or (s-keys)<>'{}'::jsonb then raise exception 'POS_STATION_INVALID';end if;
  perform public.pos_station_uuid(s->'id');
  if jsonb_typeof(s->'name') is distinct from 'string' or length(s->>'name') not between 1 and 60
   or s->>'name'<>public.pos_station_trim(s->>'name') or lower(s->>'name')='general'
   or s->>'name' ~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')
   or jsonb_typeof(s->'active') is distinct from 'boolean' then raise exception 'POS_STATION_INVALID';end if;
 elsif p->>'type'='route.set' then
  perform public.pos_station_uuid(p->'productId');
  if p->'stationId'<>'null'::jsonb then perform public.pos_station_uuid(p->'stationId');end if;
 end if;
end $$;

-- Derive immutable branch organization even for historical recovery. Current
-- access is checked separately after the shared actor gate and request lock.
create function public.pos_station_actor_gate(p_branch uuid) returns uuid language plpgsql volatile security definer set search_path='' as $$
declare org uuid;
begin
 if auth.uid() is null or p_branch is null then raise exception 'POS_ACCESS_DENIED';end if;
 select organization_id into org from public.pos_branches where id=p_branch;
 if org is null then raise exception 'POS_ACCESS_DENIED';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(org::text||':'||auth.uid()::text,15));
 return org;
end $$;
create function public.pos_station_current_actor(p_org uuid,p_branch uuid,p_manager boolean) returns text language plpgsql volatile security definer set search_path='' as $$
declare actor_role text;
begin
 perform 1 from public.pos_branches where id=p_branch and organization_id=p_org and active for share;
 if not found then raise exception 'POS_ACCESS_DENIED';end if;
 select role into actor_role from public.pos_staff where organization_id=p_org and user_id=auth.uid() and active
  and (branch_id=p_branch or (branch_id is null and role in ('owner','manager'))) for share;
 if not found then raise exception 'POS_ACCESS_DENIED';end if;
 if p_manager and actor_role not in ('owner','manager') then raise exception 'POS_MANAGER_REQUIRED';end if;
 return actor_role;
end $$;
-- Lock device before token to serialize both direct device and binding revocation.
create function public.pos_station_device(p_org uuid,p_branch uuid,p_device uuid,p_binding text,p_historical boolean) returns void language plpgsql volatile security definer set search_path='' as $$
begin
 if auth.uid() is null or p_binding is null or p_binding !~ '^[a-f0-9]{64}$' then raise exception 'POS_DEVICE_INVALID';end if;
 perform 1 from public.pos_devices where id=p_device and organization_id=p_org and branch_id=p_branch and (p_historical or active) for share;
 if not found then raise exception 'POS_DEVICE_INVALID';end if;
 perform 1 from public.pos_device_bindings where token_hash=p_binding and user_id=auth.uid() and organization_id=p_org and branch_id=p_branch and device_id=p_device and (p_historical or revoked_at is null) for share;
 if not found then raise exception 'POS_DEVICE_INVALID';end if;
end $$;
create function public.pos_station_recovery_device(p_org uuid,p_branch uuid,p_original uuid,p_binding text,p_current boolean) returns void language plpgsql volatile security definer set search_path='' as $$
declare replacement uuid;
begin
 if p_binding is null or p_binding !~ '^[a-f0-9]{64}$' then raise exception 'POS_DEVICE_INVALID';end if;
 -- Every recovery, including replacement-device recovery, proves this actor
 -- previously owned the original device. A new device never adopts another actor.
 if not exists(select 1 from public.pos_device_bindings where user_id=auth.uid() and organization_id=p_org and branch_id=p_branch and device_id=p_original) then raise exception 'POS_DEVICE_INVALID';end if;
 select device_id into replacement from public.pos_device_bindings where token_hash=p_binding and user_id=auth.uid() and organization_id=p_org and branch_id=p_branch;
 if replacement is null then raise exception 'POS_DEVICE_INVALID';end if;
 if replacement=p_original and not p_current then
  perform public.pos_station_device(p_org,p_branch,p_original,p_binding,true);
 else
  perform public.pos_station_current_actor(p_org,p_branch,false);
  perform public.pos_station_device(p_org,p_branch,replacement,p_binding,false);
 end if;
end $$;
create function public.pos_station_snapshot(p public.pos_kitchen_stations) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',p.id,'name',p.name,'active',p.active,
 'createdAt',to_char(p.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'updatedAt',to_char(p.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;

create function public.pos_list_kitchen_stations(p_branch uuid,p_device uuid,p_binding text,p_after_product uuid default null) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare org uuid;actor_role text;answer jsonb;
begin
 org:=public.pos_station_actor_gate(p_branch);
 actor_role:=public.pos_station_current_actor(org,p_branch,false);
 perform public.pos_station_device(org,p_branch,p_device,p_binding,false);
 -- One statement snapshot covers revision, stations, total count and page.
 with route_source as materialized(select product_id,station_id from public.pos_kitchen_product_routes where organization_id=org and branch_id=p_branch),
 page as materialized(select * from route_source where p_after_product is null or product_id>p_after_product order by product_id limit 101)
 select jsonb_build_object('status','ready','organizationId',org,'branchId',p_branch,'actorRole',actor_role,
 'revision',coalesce((select revision from public.pos_kitchen_station_config where branch_id=p_branch),0),
 'generatedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'stations',coalesce((select jsonb_agg(public.pos_station_snapshot(s) order by s.id) from public.pos_kitchen_stations s where s.organization_id=org and s.branch_id=p_branch),'[]'::jsonb),
 'routes',coalesce((select jsonb_agg(jsonb_build_object('productId',r.product_id,'stationId',r.station_id) order by r.product_id) from (select * from page order by product_id limit 100) r),'[]'::jsonb),
 'routeCount',(select count(*)::integer from route_source),
 'nextProductId',case when (select count(*) from page)>100 then (select product_id from page order by product_id offset 99 limit 1) else null end) into answer;
 return answer;
end $$;

create function public.pos_execute_kitchen_station_command(p_command jsonb,p_binding text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare org uuid;branch uuid;device uuid;request uuid;v_station_id uuid;product uuid;expected integer;revision integer;kind text;
 old public.pos_kitchen_station_commands;prior public.pos_kitchen_stations;saved public.pos_kitchen_stations;old_route uuid;
 station jsonb;route jsonb;answer jsonb;before_value jsonb;stamp timestamptz;
begin
 perform public.pos_station_validate(p_command);
 branch:=(p_command->>'branchId')::uuid;device:=(p_command->>'deviceId')::uuid;request:=(p_command->>'id')::uuid;kind:=p_command->>'type';
 org:=public.pos_station_actor_gate(branch);
 perform pg_advisory_xact_lock(hashtextextended(request::text,43));
 perform public.pos_station_current_actor(org,branch,true);
 perform public.pos_station_device(org,branch,device,p_binding,false);
 select * into old from public.pos_kitchen_station_commands where id=request;
 if found then
  if old.actor_id<>auth.uid() or old.organization_id<>org or old.branch_id<>branch or old.device_id<>device or old.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;
  if old.status='cancelled' then raise exception 'POS_REQUEST_CANCELLED';end if;
  return old.result||jsonb_build_object('replayed',true);
 end if;
 perform pg_advisory_xact_lock(hashtextextended(branch::text,44));
 select c.revision into revision from public.pos_kitchen_station_config c where c.branch_id=branch;
 revision:=coalesce(revision,0);expected:=(p_command->>'expectedRevision')::integer;
 if revision>=2147483647 then raise exception 'POS_STATION_CAPACITY';end if;
 if revision<>expected then raise exception 'POS_STATION_CONFLICT';end if;
 stamp:=date_trunc('milliseconds',clock_timestamp());
 if kind='station.save' then
  station:=p_command->'station';v_station_id:=(station->>'id')::uuid;
  perform pg_advisory_xact_lock(hashtextextended(v_station_id::text,45));
  select * into prior from public.pos_kitchen_stations where id=v_station_id for update;
  if found and (prior.organization_id<>org or prior.branch_id<>branch) then raise exception 'POS_STATION_NOT_FOUND';end if;
  if prior.id is null then
   if not (station->>'active')::boolean then raise exception 'POS_STATION_INVALID';end if;
   if (select count(*) from public.pos_kitchen_stations where branch_id=branch)>=128 then raise exception 'POS_STATION_CAPACITY';end if;
  elsif prior.name=station->>'name' and prior.active=(station->>'active')::boolean then raise exception 'POS_STATION_NO_CHANGES';
  end if;
  if (station->>'active')::boolean and exists(select 1 from public.pos_kitchen_stations s where s.branch_id=branch and s.active and lower(s.name)=lower(station->>'name') and s.id<>v_station_id) then raise exception 'POS_STATION_NAME_CONFLICT';end if;
  if not (station->>'active')::boolean and exists(select 1 from public.pos_kitchen_product_routes r where r.station_id=v_station_id) then raise exception 'POS_STATION_ASSIGNED';end if;
  before_value:=case when prior.id is null then null else public.pos_station_snapshot(prior) end;
  if prior.id is null then
   insert into public.pos_kitchen_stations(id,organization_id,branch_id,name,active,created_at,updated_at)
   values(v_station_id,org,branch,station->>'name',true,stamp,stamp) returning * into saved;
  else
   update public.pos_kitchen_stations set name=station->>'name',active=(station->>'active')::boolean,updated_at=greatest(stamp,prior.updated_at) where id=v_station_id returning * into saved;
  end if;
  station:=public.pos_station_snapshot(saved);
 else
  product:=(p_command->>'productId')::uuid;v_station_id:=(p_command->>'stationId')::uuid;
  perform 1 from public.pos_products where id=product and organization_id=org and branch_id=branch for share;
  if not found then raise exception 'POS_STATION_PRODUCT_INVALID';end if;
  if v_station_id is not null then
   perform 1 from public.pos_kitchen_stations where id=v_station_id and organization_id=org and branch_id=branch and active for share;
   if not found then raise exception 'POS_STATION_NOT_FOUND';end if;
  end if;
  select r.station_id into old_route from public.pos_kitchen_product_routes r where r.product_id=product;
  if old_route is not distinct from v_station_id then raise exception 'POS_STATION_NO_CHANGES';end if;
  if old_route is null and v_station_id is not null and (select count(*) from public.pos_kitchen_product_routes where branch_id=branch)>=2147483647 then raise exception 'POS_STATION_CAPACITY';end if;
  before_value:=jsonb_build_object('productId',product,'stationId',old_route);
  if v_station_id is null then delete from public.pos_kitchen_product_routes where product_id=product;
  else insert into public.pos_kitchen_product_routes(organization_id,branch_id,product_id,station_id) values(org,branch,product,v_station_id)
   on conflict(product_id) do update set station_id=excluded.station_id;
  end if;
  route:=jsonb_build_object('productId',product,'stationId',v_station_id);
 end if;
 revision:=revision+1;
 insert into public.pos_kitchen_station_config(organization_id,branch_id,revision) values(org,branch,revision)
 on conflict(branch_id) do update set revision=excluded.revision;
 answer:=jsonb_build_object('status','applied','requestId',request,'branchId',branch,'replayed',false,'revision',revision,'station',station,'route',route);
 insert into public.pos_kitchen_station_commands(id,organization_id,branch_id,actor_id,device_id,payload,result,status)
 values(request,org,branch,auth.uid(),device,p_command,answer,'applied');
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
 values(org,branch,auth.uid(),'kitchen.'||kind,coalesce(product,v_station_id),jsonb_build_object('requestId',request,'revision',revision,'before',before_value,'after',coalesce(station,route)));
 return answer;
end $$;

create function public.pos_resolve_kitchen_station_request(p_command jsonb,p_binding text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare org uuid;branch uuid;device uuid;request uuid;old public.pos_kitchen_station_commands;answer jsonb;
begin
 perform public.pos_station_validate(p_command);
 branch:=(p_command->>'branchId')::uuid;device:=(p_command->>'deviceId')::uuid;request:=(p_command->>'id')::uuid;
 org:=public.pos_station_actor_gate(branch);
 perform pg_advisory_xact_lock(hashtextextended(request::text,43));
 select * into old from public.pos_kitchen_station_commands where id=request;
 if found then
  if old.actor_id<>auth.uid() or old.organization_id<>org or old.branch_id<>branch or old.device_id<>device or old.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;
  perform public.pos_station_recovery_device(org,branch,device,p_binding,false);
  return old.result||jsonb_build_object('replayed',true);
 end if;
 -- Cancellation requires current branch access, but not current manager role.
 -- Demotion cannot strand a pending command and does not grant execution rights.
 perform public.pos_station_current_actor(org,branch,false);
 perform public.pos_station_recovery_device(org,branch,device,p_binding,true);
 answer:=jsonb_build_object('status','cancelled','requestId',request,'branchId',branch,'replayed',false);
 insert into public.pos_kitchen_station_commands(id,organization_id,branch_id,actor_id,device_id,payload,result,status)
 values(request,org,branch,auth.uid(),device,p_command,answer,'cancelled');
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
 values(org,branch,auth.uid(),'kitchen.request_cancelled',request,jsonb_build_object('deviceId',device,'type',p_command->>'type'));
 return answer;
end $$;

revoke all on function public.pos_station_trim(text),public.pos_station_identity_guard(),public.pos_station_uuid(jsonb),public.pos_station_validate(jsonb),public.pos_station_actor_gate(uuid),public.pos_station_current_actor(uuid,uuid,boolean),public.pos_station_device(uuid,uuid,uuid,text,boolean),public.pos_station_recovery_device(uuid,uuid,uuid,text,boolean),public.pos_station_snapshot(public.pos_kitchen_stations),public.pos_list_kitchen_stations(uuid,uuid,text,uuid),public.pos_execute_kitchen_station_command(jsonb,text),public.pos_resolve_kitchen_station_request(jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.pos_list_kitchen_stations(uuid,uuid,text,uuid),public.pos_execute_kitchen_station_command(jsonb,text),public.pos_resolve_kitchen_station_request(jsonb,text) to authenticated;
