-- Shared unpaid orders. These are neither fiscal documents nor kitchen dispatches.
create table public.pos_dining_tables (
 id uuid primary key, organization_id uuid not null, branch_id uuid not null,
 name text not null check(length(name) between 1 and 80 and name=trim(name)),
 area text not null check(length(area)<=80 and area=trim(area)), seats integer not null check(seats between 1 and 99),
 active boolean not null, revision integer not null default 1 check(revision>0),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id), unique(organization_id,branch_id,id)
);
create unique index pos_dining_table_name on public.pos_dining_tables(branch_id,lower(name));
create table public.pos_open_tabs (
 id uuid primary key, organization_id uuid not null, branch_id uuid not null,
 revision integer not null default 1 check(revision>0), status text not null default 'open' check(status in ('open','voided','settled')),
 label text not null check(length(label) between 1 and 120 and label=trim(label)),
 service_type text not null check(service_type in ('dine_in','takeaway','delivery')),
 table_id uuid, guest_count integer check(guest_count between 1 and 99), note text not null check(length(note)<=400 and note=trim(note)),
 lines jsonb not null, request_lines jsonb not null,
 subtotal_fils integer not null check(subtotal_fils between 0 and 100000000), tax_fils integer not null check(tax_fils between 0 and subtotal_fils),
 created_by uuid not null references auth.users, updated_by uuid not null references auth.users,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(), settled_order_id uuid,
 foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id),
 foreign key(organization_id,branch_id,table_id) references public.pos_dining_tables(organization_id,branch_id,id),
 foreign key(organization_id,branch_id,settled_order_id) references public.pos_orders(organization_id,branch_id,id),
 unique(organization_id,branch_id,id), unique(settled_order_id),
 check(table_id is null or service_type='dine_in'), check((status='settled')=(settled_order_id is not null)),
 check(jsonb_typeof(lines)='array' and jsonb_array_length(lines)<=200 and jsonb_typeof(request_lines)='array' and jsonb_array_length(request_lines)=jsonb_array_length(lines))
);
create unique index pos_one_open_tab_per_table on public.pos_open_tabs(table_id) where status='open' and table_id is not null;
create index pos_open_tabs_page on public.pos_open_tabs(branch_id,created_at,id) where status='open';
create index pos_closed_tabs_page on public.pos_open_tabs(branch_id,updated_at desc,id desc) where status<>'open';
create table public.pos_tab_commands (
 id uuid primary key, organization_id uuid not null, branch_id uuid not null, actor_id uuid not null references auth.users,
 payload jsonb not null, result jsonb not null, created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id)
);
create table public.pos_tab_request_cancellations (
 request_id uuid primary key, organization_id uuid not null, branch_id uuid not null, actor_id uuid not null references auth.users,
 payload jsonb not null, created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id)
);
-- Unlike the fiscal public payload this preserves sourceTab and private offer coupon input.
create table public.pos_tab_sale_requests (
 order_id uuid primary key, tab_id uuid not null unique, organization_id uuid not null, branch_id uuid not null,
 actor_id uuid not null references auth.users, device_id uuid not null, request_payload jsonb not null, result jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,branch_id,order_id) references public.pos_orders(organization_id,branch_id,id),
 foreign key(organization_id,branch_id,tab_id) references public.pos_open_tabs(organization_id,branch_id,id),
 foreign key(organization_id,branch_id,device_id) references public.pos_devices(organization_id,branch_id,id)
);
do $$declare t text;begin
 foreach t in array array['pos_dining_tables','pos_open_tabs','pos_tab_commands','pos_tab_request_cancellations','pos_tab_sale_requests'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
 end loop;
end $$;
create trigger pos_tab_commands_immutable before update or delete on public.pos_tab_commands for each row execute function public.pos_preserve_document();
create trigger pos_tab_cancellations_immutable before update or delete on public.pos_tab_request_cancellations for each row execute function public.pos_preserve_document();
create trigger pos_tab_sales_immutable before update or delete on public.pos_tab_sale_requests for each row execute function public.pos_preserve_document();
create function public.pos_tab_snapshot(p public.pos_open_tabs) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',p.id,'branchId',p.branch_id,'revision',p.revision,'status',p.status,'label',p.label,'serviceType',p.service_type,
 'tableId',p.table_id,'guestCount',p.guest_count,'note',p.note,'lines',p.lines,'subtotalFils',p.subtotal_fils,'taxFils',p.tax_fils,
 'createdBy',p.created_by,'updatedBy',p.updated_by,'createdAt',p.created_at,'updatedAt',p.updated_at,'settledOrderId',p.settled_order_id)
$$;
revoke all on function public.pos_tab_snapshot(public.pos_open_tabs) from public,anon,authenticated;
create function public.pos_dining_table_snapshot(p public.pos_dining_tables,p_occupied uuid) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',p.id,'branchId',p.branch_id,'name',p.name,'area',p.area,'seats',p.seats,'active',p.active,'revision',p.revision,
 'createdAt',p.created_at,'updatedAt',p.updated_at,'occupiedTabId',p_occupied)
$$;
revoke all on function public.pos_dining_table_snapshot(public.pos_dining_tables,uuid) from public,anon,authenticated;
create function public.pos_tab_scope(p_branch uuid,p_binding text,p_device uuid default null) returns uuid language plpgsql security definer set search_path='' as $$
declare org uuid; bound jsonb;
begin
 org:=public.pos_lock_staff_authority(p_branch); bound:=public.pos_bound_device(p_binding);
 if bound is null or bound->>'branchId' is distinct from p_branch::text or (p_device is not null and bound->>'id' is distinct from p_device::text) then raise exception 'POS_DEVICE_INVALID'; end if;
 return org;
end $$;
revoke all on function public.pos_tab_scope(uuid,text,uuid) from public,anon,authenticated;
create function public.pos_validate_tab_command(p jsonb) returns void language plpgsql set search_path='' as $$
declare keys text[]; item jsonb;
begin
 if jsonb_typeof(p) is distinct from 'object' or coalesce(p->>'type','') not in ('table.save','tab.save','tab.void','tab.reopen') then raise exception 'POS_INVALID_TAB_COMMAND'; end if;
 keys:=array['id','branchId','deviceId','type','expectedRevision'];
 if p->>'type'='table.save' then keys:=keys||array['table','reason'];
 elsif p->>'type'='tab.void' then keys:=keys||array['tabId','reason'];
 else keys:=keys||array['tabId','label','serviceType','tableId','guestCount','note','lines'];
  if p->>'type'='tab.reopen' then keys:=keys||array['reason']; end if;
 end if;
 if not p ?& keys or exists(select 1 from jsonb_object_keys(p) k where not(k=any(keys)))
  or jsonb_typeof(p->'id') is distinct from 'string' or jsonb_typeof(p->'branchId') is distinct from 'string' or jsonb_typeof(p->'deviceId') is distinct from 'string'
  or not public.pos_offer_integer(p->'expectedRevision',case when p->>'type' in ('tab.void','tab.reopen') then 1 else 0 end,2147483646)
  or (p->>'type'<>'tab.save' and (jsonb_typeof(p->'reason') is distinct from 'string' or length(trim(p->>'reason')) not between 1 and 240 or p->>'reason'<>trim(p->>'reason')))
 then raise exception 'POS_INVALID_TAB_COMMAND'; end if;
 perform (p->>'id')::uuid;perform (p->>'branchId')::uuid;perform (p->>'deviceId')::uuid;
 if p->>'type'='table.save' then
  item:=p->'table';
  if jsonb_typeof(item) is distinct from 'object' or not item ?& array['id','name','area','seats','active'] or item-array['id','name','area','seats','active']<>'{}'::jsonb
   or jsonb_typeof(item->'id') is distinct from 'string' or jsonb_typeof(item->'name') is distinct from 'string' or length(item->>'name') not between 1 and 80 or item->>'name'<>trim(item->>'name')
   or jsonb_typeof(item->'area') is distinct from 'string' or length(item->>'area')>80 or item->>'area'<>trim(item->>'area')
   or not public.pos_offer_integer(item->'seats',1,99) or jsonb_typeof(item->'active') is distinct from 'boolean' then raise exception 'POS_INVALID_TAB_COMMAND'; end if;
  perform (item->>'id')::uuid;
 else
  if jsonb_typeof(p->'tabId') is distinct from 'string' then raise exception 'POS_INVALID_TAB_COMMAND'; end if;
  perform (p->>'tabId')::uuid;
  if p->>'type'<>'tab.void' then
   if jsonb_typeof(p->'label') is distinct from 'string' or length(p->>'label') not between 1 and 120 or p->>'label'<>trim(p->>'label')
    or coalesce(p->>'serviceType','') not in ('dine_in','takeaway','delivery')
    or (p->'tableId'<>'null'::jsonb and (jsonb_typeof(p->'tableId') is distinct from 'string' or p->>'serviceType'<>'dine_in'))
    or (p->'guestCount'<>'null'::jsonb and not public.pos_offer_integer(p->'guestCount',1,99))
    or jsonb_typeof(p->'note') is distinct from 'string' or length(p->>'note')>400 or p->>'note'<>trim(p->>'note')
    or jsonb_typeof(p->'lines') is distinct from 'array' then raise exception 'POS_INVALID_TAB_COMMAND'; end if;
   if jsonb_array_length(p->'lines')>200 then raise exception 'POS_INVALID_TAB_COMMAND'; end if;
   perform (p->>'tableId')::uuid;
  end if;
 end if;
exception when invalid_text_representation then raise exception 'POS_INVALID_TAB_COMMAND';
end $$;
revoke all on function public.pos_validate_tab_command(jsonb) from public,anon,authenticated;
create function public.pos_list_tabs(p_branch uuid,p_binding text,p_cursor jsonb default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid; role_name text; after_time timestamptz; after_id uuid; result jsonb;
begin
 org:=public.pos_tab_scope(p_branch,p_binding);
 select role into role_name from public.pos_staff where organization_id=org and user_id=auth.uid() and active;
 if p_cursor is not null then
  if jsonb_typeof(p_cursor) is distinct from 'object' or not p_cursor ?& array['createdAt','id'] or p_cursor-array['createdAt','id']<>'{}'::jsonb
   or jsonb_typeof(p_cursor->'createdAt') is distinct from 'string' or jsonb_typeof(p_cursor->'id') is distinct from 'string' then raise exception 'POS_INVALID_TAB_CURSOR'; end if;
  after_time:=(p_cursor->>'createdAt')::timestamptz;after_id:=(p_cursor->>'id')::uuid;
  if not isfinite(after_time) then raise exception 'POS_INVALID_TAB_CURSOR'; end if;
 end if;
 with active as not materialized(select * from public.pos_open_tabs t where t.organization_id=org and t.branch_id=p_branch and t.status='open'),
 page as materialized(select * from active where after_time is null or (created_at,id)>(after_time,after_id) order by created_at,id limit 101),
 shown as materialized(select * from page order by created_at,id limit 100),
 closed as materialized(select * from public.pos_open_tabs t where t.organization_id=org and t.branch_id=p_branch and t.status<>'open' order by updated_at desc,id desc limit 51),
 recent as materialized(select * from closed order by updated_at desc,id desc limit 50)
 select jsonb_build_object('status','ready','organizationId',org,'branchId',p_branch,'actorRole',role_name,'generatedAt',clock_timestamp(),
 'tables',(select coalesce(jsonb_agg(public.pos_dining_table_snapshot(t,a.id) order by t.area,t.name,t.id),'[]') from public.pos_dining_tables t left join active a on a.table_id=t.id where t.organization_id=org and t.branch_id=p_branch),
 'openTabs',(select coalesce(jsonb_agg(public.pos_tab_snapshot(s) order by s.created_at,s.id),'[]') from shown s),
 'openCount',(select count(*) from active),'openNextCursor',case when (select count(*) from page)>100 then (select jsonb_build_object('createdAt',created_at,'id',id) from shown order by created_at desc,id desc limit 1) else null end,
 'recentTabs',(select coalesce(jsonb_agg(public.pos_tab_snapshot(r) order by r.updated_at desc,r.id desc),'[]') from recent r),'recentTruncated',(select count(*)>50 from closed)) into result;
 return result;
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then raise exception 'POS_INVALID_TAB_CURSOR';
end $$;
revoke all on function public.pos_list_tabs(uuid,text,jsonb) from public,anon;
grant execute on function public.pos_list_tabs(uuid,text,jsonb) to authenticated;
create function public.pos_get_tab(p_branch uuid,p_tab uuid,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid; role_name text; item public.pos_open_tabs;
begin
 org:=public.pos_tab_scope(p_branch,p_binding);
 select role into role_name from public.pos_staff where organization_id=org and user_id=auth.uid() and active;
 select * into item from public.pos_open_tabs where id=p_tab and organization_id=org and branch_id=p_branch;
 if not found then raise exception 'POS_TAB_NOT_FOUND'; end if;
 return jsonb_build_object('status','ready','organizationId',org,'branchId',p_branch,'actorRole',role_name,'tab',public.pos_tab_snapshot(item));
end $$;
revoke all on function public.pos_get_tab(uuid,uuid,text) from public,anon;
grant execute on function public.pos_get_tab(uuid,uuid,text) to authenticated;
create function public.pos_execute_tab_command(p_command jsonb,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid; branch uuid; device uuid; v_request_id uuid; role_name text; kind text; rev integer; target uuid; assigned uuid; occupied uuid;
 previous public.pos_tab_commands; cancellation public.pos_tab_request_cancellations; dining public.pos_dining_tables; tab public.pos_open_tabs;
 catalogue jsonb; saved_lines jsonb; total bigint; tax bigint; result jsonb; changed_at timestamptz;
begin
 perform public.pos_validate_tab_command(p_command);
 branch:=(p_command->>'branchId')::uuid;device:=(p_command->>'deviceId')::uuid;v_request_id:=(p_command->>'id')::uuid;kind:=p_command->>'type';rev:=(p_command->>'expectedRevision')::integer;
 org:=public.pos_tab_scope(branch,p_binding,device);
 perform pg_advisory_xact_lock(hashtextextended(v_request_id::text,19));
 select * into previous from public.pos_tab_commands c where c.id=v_request_id;
 if found then
  if previous.organization_id<>org or previous.branch_id<>branch or previous.actor_id<>auth.uid() or previous.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  return previous.result||jsonb_build_object('replayed',true);
 end if;
 select * into cancellation from public.pos_tab_request_cancellations c where c.request_id=v_request_id;
 if found then
  if cancellation.organization_id<>org or cancellation.branch_id<>branch or cancellation.actor_id<>auth.uid() or cancellation.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  raise exception 'POS_REQUEST_CANCELLED';
 end if;
 select role into role_name from public.pos_staff where organization_id=org and user_id=auth.uid() and active;
 if kind<>'tab.save' and role_name not in ('owner','manager') then raise exception 'POS_MANAGER_REQUIRED'; end if;
 perform 1 from public.pos_devices d where d.id=device and d.organization_id=org and d.branch_id=branch and d.active for share;
 if not found then raise exception 'POS_DEVICE_INVALID'; end if;
 -- Coordinate table occupancy and capacity without inverting device/shift/product locks.
 perform pg_advisory_xact_lock(hashtextextended(branch::text,20));
 changed_at:=clock_timestamp();
 if kind='table.save' then
  target:=(p_command#>>'{table,id}')::uuid;
  select * into dining from public.pos_dining_tables where id=target for update;
  if found then
   if dining.organization_id<>org or dining.branch_id<>branch then raise exception 'POS_ACCESS_DENIED'; end if;
   if dining.revision<>rev then raise exception 'POS_TABLE_CHANGED'; end if;
  elsif rev<>0 then raise exception 'POS_TABLE_CHANGED';
  elsif (select count(*) from public.pos_dining_tables where branch_id=branch)>=200 then raise exception 'POS_TABLE_LIMIT'; end if;
  if exists(select 1 from public.pos_dining_tables t where t.branch_id=branch and lower(t.name)=lower(p_command#>>'{table,name}') and t.id<>target) then raise exception 'POS_TABLE_NAME_EXISTS'; end if;
  select id into occupied from public.pos_open_tabs where table_id=target and status='open';
  if occupied is not null and not (p_command#>>'{table,active}')::boolean then raise exception 'POS_TABLE_OCCUPIED'; end if;
  if dining.id is null then
   insert into public.pos_dining_tables(id,organization_id,branch_id,name,area,seats,active,created_at,updated_at)
   values(target,org,branch,p_command#>>'{table,name}',p_command#>>'{table,area}',(p_command#>>'{table,seats}')::integer,(p_command#>>'{table,active}')::boolean,changed_at,changed_at) returning * into dining;
  else
   update public.pos_dining_tables set name=p_command#>>'{table,name}',area=p_command#>>'{table,area}',seats=(p_command#>>'{table,seats}')::integer,
    active=(p_command#>>'{table,active}')::boolean,revision=revision+1,updated_at=changed_at where id=target returning * into dining;
  end if;
  result:=jsonb_build_object('status','updated','requestId',v_request_id,'replayed',false,'table',public.pos_dining_table_snapshot(dining,occupied));
 else
  target:=(p_command->>'tabId')::uuid;
  select * into tab from public.pos_open_tabs where id=target for update;
  if found then
   if tab.organization_id<>org or tab.branch_id<>branch then raise exception 'POS_ACCESS_DENIED'; end if;
   if tab.status='settled' then raise exception 'POS_TAB_ALREADY_SETTLED'; end if;
   if tab.revision<>rev then raise exception 'POS_TAB_CHANGED'; end if;
   if (kind='tab.reopen' and tab.status<>'voided') or (kind<>'tab.reopen' and tab.status<>'open') then raise exception 'POS_TAB_STATE_INVALID'; end if;
  elsif rev<>0 or kind<>'tab.save' then raise exception 'POS_TAB_NOT_FOUND'; end if;
  if kind<>'tab.void' and (tab.id is null or kind='tab.reopen') and (select count(*) from public.pos_open_tabs where branch_id=branch and status='open')>=1000 then raise exception 'POS_TAB_LIMIT'; end if;
  if kind='tab.void' then
   update public.pos_open_tabs set status='voided',revision=revision+1,updated_by=auth.uid(),updated_at=changed_at where id=target returning * into tab;
  else
   assigned:=(p_command->>'tableId')::uuid;
   if assigned is not null then
    select * into dining from public.pos_dining_tables t where t.id=assigned and t.organization_id=org and t.branch_id=branch for share;
    if not found then raise exception 'POS_TABLE_NOT_FOUND'; end if;
    if not dining.active then raise exception 'POS_TABLE_INACTIVE'; end if;
    if exists(select 1 from public.pos_open_tabs t where t.table_id=assigned and t.status='open' and t.id<>target) then raise exception 'POS_TABLE_OCCUPIED'; end if;
   end if;
   if jsonb_array_length(p_command->'lines')=0 then catalogue:='[]';saved_lines:='[]';total:=0;tax:=0;
   else
    catalogue:=public.pos_offer_catalogue_lines(org,branch,p_command->'lines',true);
    select jsonb_agg(l||jsonb_build_object('imageUrl',p.image_url,'revision',p.revision) order by ord),
     sum(round((l->>'unitPriceFils')::numeric*(l->>'quantityMilli')::numeric/1000)),
     sum(round(round((l->>'unitPriceFils')::numeric*(l->>'quantityMilli')::numeric/1000)*(l->>'taxRateBps')::numeric/(10000+(l->>'taxRateBps')::numeric)))
    into saved_lines,total,tax from jsonb_array_elements(catalogue) with ordinality x(l,ord) join public.pos_products p on p.id=(l->>'productId')::uuid;
   end if;
   if tab.id is null then
    insert into public.pos_open_tabs(id,organization_id,branch_id,label,service_type,table_id,guest_count,note,lines,request_lines,subtotal_fils,tax_fils,created_by,updated_by,created_at,updated_at)
    values(target,org,branch,p_command->>'label',p_command->>'serviceType',assigned,(p_command->>'guestCount')::integer,p_command->>'note',saved_lines,p_command->'lines',total,tax,auth.uid(),auth.uid(),changed_at,changed_at) returning * into tab;
   else
    update public.pos_open_tabs set status='open',label=p_command->>'label',service_type=p_command->>'serviceType',table_id=assigned,guest_count=(p_command->>'guestCount')::integer,note=p_command->>'note',
     lines=saved_lines,request_lines=p_command->'lines',subtotal_fils=total,tax_fils=tax,revision=revision+1,updated_by=auth.uid(),updated_at=changed_at where id=target returning * into tab;
   end if;
  end if;
  result:=jsonb_build_object('status','updated','requestId',v_request_id,'replayed',false,'tab',public.pos_tab_snapshot(tab));
 end if;
 insert into public.pos_tab_commands(id,organization_id,branch_id,actor_id,payload,result) values(v_request_id,org,branch,auth.uid(),p_command,result);
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
 values(org,branch,auth.uid(),kind,target,jsonb_build_object('requestId',v_request_id,'deviceId',device,'expectedRevision',rev,'resultRevision',rev+1,'reason',p_command->'reason'));
 return result;
end $$;
revoke all on function public.pos_execute_tab_command(jsonb,text) from public,anon;
grant execute on function public.pos_execute_tab_command(jsonb,text) to authenticated;
create function public.pos_resolve_tab_request(p_command jsonb,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid; branch uuid; device uuid; v_request_id uuid; bound jsonb; previous public.pos_tab_commands; cancellation public.pos_tab_request_cancellations; role_name text;
begin
 if auth.uid() is null then raise exception 'POS_ACCESS_DENIED'; end if;
 perform public.pos_validate_tab_command(p_command);
 branch:=(p_command->>'branchId')::uuid;device:=(p_command->>'deviceId')::uuid;v_request_id:=(p_command->>'id')::uuid;
 select b.organization_id into org from public.pos_device_bindings b where b.user_id=auth.uid() and b.branch_id=branch and b.device_id=device limit 1;
 if org is null then raise exception 'POS_DEVICE_INVALID'; end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(org::text||':'||auth.uid()::text,15));
 if not exists(select 1 from public.pos_device_bindings b where b.token_hash=p_binding and b.user_id=auth.uid() and b.organization_id=org and b.branch_id=branch and b.device_id=device) then
  bound:=public.pos_bound_device(p_binding);
  if bound is null or bound->>'branchId' is distinct from branch::text then raise exception 'POS_DEVICE_INVALID'; end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(v_request_id::text,19));
 select * into previous from public.pos_tab_commands c where c.id=v_request_id;
 if found then
  if previous.organization_id<>org or previous.branch_id<>branch or previous.actor_id<>auth.uid() or previous.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  return previous.result||jsonb_build_object('replayed',true);
 end if;
 perform public.pos_lock_staff_authority(branch);
 select role into role_name from public.pos_staff where organization_id=org and user_id=auth.uid() and active;
 if p_command->>'type'<>'tab.save' and role_name not in ('owner','manager') then raise exception 'POS_MANAGER_REQUIRED'; end if;
 select * into cancellation from public.pos_tab_request_cancellations c where c.request_id=v_request_id;
 if found then
  if cancellation.organization_id<>org or cancellation.branch_id<>branch or cancellation.actor_id<>auth.uid() or cancellation.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  return jsonb_build_object('status','cancelled','requestId',v_request_id,'replayed',true);
 end if;
 insert into public.pos_tab_request_cancellations(request_id,organization_id,branch_id,actor_id,payload) values(v_request_id,org,branch,auth.uid(),p_command);
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
 values(org,branch,auth.uid(),'tab.request_cancelled',v_request_id,jsonb_build_object('deviceId',device,'type',p_command->>'type'));
 return jsonb_build_object('status','cancelled','requestId',v_request_id,'replayed',false);
end $$;
revoke all on function public.pos_resolve_tab_request(jsonb,text) from public,anon;
grant execute on function public.pos_resolve_tab_request(jsonb,text) to authenticated;

-- Compare basket meaning, allowing harmless line order/UUID case differences only.
create function public.pos_tab_lines_match(p_left jsonb,p_right jsonb) returns boolean language plpgsql set search_path='' as $$
declare a jsonb; b jsonb;
begin
 if jsonb_typeof(p_left) is distinct from 'array' or jsonb_typeof(p_right) is distinct from 'array' then return false; end if;
 select coalesce(jsonb_agg(jsonb_set(value,'{productId}',to_jsonb(((value->>'productId')::uuid)::text)) order by (value->>'productId')::uuid),'[]') into a from jsonb_array_elements(p_left);
 select coalesce(jsonb_agg(jsonb_set(value,'{productId}',to_jsonb(((value->>'productId')::uuid)::text)) order by (value->>'productId')::uuid),'[]') into b from jsonb_array_elements(p_right);
 return a=b;
exception when invalid_text_representation then return false;
end $$;
revoke all on function public.pos_tab_lines_match(jsonb,jsonb) from public,anon,authenticated;

alter function public.pos_record_live_order(jsonb,text) rename to pos_record_live_order_before_tabs;
revoke all on function public.pos_record_live_order_before_tabs(jsonb,text) from public,anon,authenticated;
create function public.pos_record_live_order(p_order jsonb,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid; branch uuid; device uuid; v_request_id uuid; source jsonb; original public.pos_tab_sale_requests; tab public.pos_open_tabs; result jsonb;
begin
 if jsonb_typeof(p_order) is distinct from 'object' or p_order->>'id' is null or p_order->>'branchId' is null or p_order->>'deviceId' is null then raise exception 'POS_INVALID_ORDER'; end if;
 branch:=(p_order->>'branchId')::uuid;device:=(p_order->>'deviceId')::uuid;v_request_id:=(p_order->>'id')::uuid;
 org:=public.pos_tab_scope(branch,p_binding,device);
 perform pg_advisory_xact_lock(hashtextextended(v_request_id::text,0));
 -- Check linked canonical requests even when sourceTab was stripped by the caller.
 select * into original from public.pos_tab_sale_requests r where r.order_id=v_request_id;
 if found then
  if original.organization_id<>org or original.branch_id<>branch or original.actor_id<>auth.uid() or original.device_id<>device or original.request_payload<>p_order then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  return original.result||jsonb_build_object('replayed',true);
 end if;
 if not p_order ? 'sourceTab' then return public.pos_record_live_order_before_tabs(p_order,p_binding); end if;
 source:=p_order->'sourceTab';
 if jsonb_typeof(source) is distinct from 'object' or not source ?& array['id','expectedRevision'] or source-array['id','expectedRevision']<>'{}'::jsonb
  or jsonb_typeof(source->'id') is distinct from 'string' or not public.pos_offer_integer(source->'expectedRevision',1,2147483646)
  or (source->>'id')::uuid=v_request_id then raise exception 'POS_INVALID_ORDER'; end if;
 -- Never adopt an earlier ordinary invoice as payment for a newly supplied tab.
 if exists(select 1 from public.pos_orders where id=v_request_id) or exists(select 1 from public.pos_documents where order_id=v_request_id) then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
 perform public.pos_assert_not_cancelled('sale',p_order,org);
 -- Match financial lock order before acquiring the branch coordination gate and tab.
 perform 1 from public.pos_branch_receipt_config c where c.organization_id=org and c.branch_id=branch and c.live_enabled for share;
 if not found then raise exception 'POS_PROFILE_REQUIRED'; end if;
 perform 1 from public.pos_devices d where d.organization_id=org and d.branch_id=branch and d.id=device and d.active for share;
 if not found then raise exception 'POS_DEVICE_INVALID'; end if;
 perform 1 from public.pos_shifts s where s.id=(p_order->>'shiftId')::uuid and s.organization_id=org and s.branch_id=branch and s.device_id=device and s.opened_by=auth.uid() and s.status='open' for update;
 if not found then raise exception 'POS_SHIFT_INVALID'; end if;
 perform pg_advisory_xact_lock(hashtextextended(branch::text,20));
 select * into tab from public.pos_open_tabs t where t.id=(source->>'id')::uuid and t.organization_id=org and t.branch_id=branch for update;
 if not found then raise exception 'POS_TAB_NOT_FOUND'; end if;
 if tab.status='settled' then raise exception 'POS_TAB_ALREADY_SETTLED'; end if;
 if tab.status<>'open' then raise exception 'POS_TAB_STATE_INVALID'; end if;
 if tab.revision<>(source->>'expectedRevision')::integer then raise exception 'POS_TAB_CHANGED'; end if;
 if tab.service_type is distinct from p_order->>'serviceType' or not public.pos_tab_lines_match(tab.request_lines,p_order->'lines') then raise exception 'POS_TAB_CONTENT_CHANGED'; end if;
 -- The audited engine alone calculates discounts, VAT, tender and immutable invoice.
 result:=public.pos_record_live_order_before_tabs(p_order-'sourceTab',p_binding);
 update public.pos_open_tabs set status='settled',settled_order_id=v_request_id,revision=revision+1,updated_by=auth.uid(),updated_at=clock_timestamp() where id=tab.id returning * into tab;
 result:=result||jsonb_build_object('settledTab',jsonb_build_object('id',tab.id,'revision',tab.revision));
 insert into public.pos_tab_sale_requests(order_id,tab_id,organization_id,branch_id,actor_id,device_id,request_payload,result)
 values(v_request_id,tab.id,org,branch,auth.uid(),device,p_order,result);
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
 values(org,branch,auth.uid(),'tab.settled',tab.id,jsonb_build_object('orderId',v_request_id,'revision',tab.revision,'deviceId',device));
 return result;
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'POS_INVALID_ORDER';
end $$;
revoke all on function public.pos_record_live_order(jsonb,text) from public,anon;
grant execute on function public.pos_record_live_order(jsonb,text) to authenticated;
alter function public.pos_lookup_own_committed_request(text,jsonb,text) rename to pos_lookup_own_committed_request_before_tabs;
revoke all on function public.pos_lookup_own_committed_request_before_tabs(text,jsonb,text) from public,anon,authenticated;
create function public.pos_lookup_own_committed_request(p_kind text,p_request jsonb,p_binding text) returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid; branch uuid; device uuid; v_request_id uuid; original public.pos_tab_sale_requests;
begin
 if p_kind is distinct from 'sale' then return public.pos_lookup_own_committed_request_before_tabs(p_kind,p_request,p_binding); end if;
 if auth.uid() is null or jsonb_typeof(p_request) is distinct from 'object' or p_request->>'id' is null or p_request->>'branchId' is null or p_request->>'deviceId' is null then raise exception 'POS_INVALID_REQUEST'; end if;
 branch:=(p_request->>'branchId')::uuid;device:=(p_request->>'deviceId')::uuid;v_request_id:=(p_request->>'id')::uuid;
 select b.organization_id into org from public.pos_device_bindings b where b.token_hash=p_binding and b.user_id=auth.uid() and b.branch_id=branch and b.device_id=device;
 if org is null then raise exception 'POS_DEVICE_INVALID'; end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(org::text||':'||auth.uid()::text,15));
 perform pg_advisory_xact_lock(hashtextextended(v_request_id::text,0));
 select * into original from public.pos_tab_sale_requests r where r.order_id=v_request_id;
 if found then
  if original.organization_id<>org or original.branch_id<>branch or original.actor_id<>auth.uid() or original.device_id<>device or original.request_payload<>p_request then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  return original.result||jsonb_build_object('replayed',true);
 end if;
 return public.pos_lookup_own_committed_request_before_tabs(p_kind,p_request,p_binding);
exception when invalid_text_representation then raise exception 'POS_INVALID_REQUEST';
end $$;
revoke all on function public.pos_lookup_own_committed_request(text,jsonb,text) from public,anon;
grant execute on function public.pos_lookup_own_committed_request(text,jsonb,text) to authenticated;
