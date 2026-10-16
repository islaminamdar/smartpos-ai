-- Recorded branch stock only. No recipes, sale deductions, valuation, cash or
-- purchase ledger writes. Existing migrations and financial records are untouched.
create table public.pos_stock_items (
 id uuid primary key, organization_id uuid not null, branch_id uuid not null,
 name text not null check(name=btrim(name) and length(name) between 1 and 160),
 sku text check(sku is null or sku ~ '^[A-Z0-9._-]{1,64}$'),
 unit text not null check(unit in ('kg','litre','piece')),
 reorder_level_milli bigint not null check(reorder_level_milli between 0 and 1000000000000),
 active boolean not null, revision integer not null check(revision between 1 and 2147483646),
 on_hand_milli bigint check(on_hand_milli between 0 and 1000000000000),
 movement_count integer not null default 0 check(movement_count between 0 and 2147483645),
 created_at timestamptz not null, updated_at timestamptz not null,
 foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id),
 unique(organization_id,branch_id,id), unique(branch_id,sku),
 check((movement_count=0 and on_hand_milli is null) or (movement_count>0 and on_hand_milli is not null)),
 check(revision>movement_count), check(updated_at>=created_at),
 check(unit<>'piece' or (reorder_level_milli%1000=0 and (on_hand_milli is null or on_hand_milli%1000=0)))
);
create index pos_stock_items_branch on public.pos_stock_items(branch_id,id);
create table public.pos_inventory_commands (
 id uuid primary key, organization_id uuid not null, branch_id uuid not null,
 actor_id uuid not null references auth.users, device_id uuid not null, item_id uuid not null,
 kind text not null check(kind in ('item.save','stock.receive','stock.waste','stock.count','stock.adjust')),
 payload jsonb not null, before_item jsonb, result jsonb not null,
 status text not null check(status in ('applied','cancelled')),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,branch_id,device_id) references public.pos_devices(organization_id,branch_id,id),
 unique(organization_id,branch_id,id), check(result->>'status'=status),check(result->>'requestId'=id::text)
);
create table public.pos_stock_movements (
 id uuid primary key, organization_id uuid not null, branch_id uuid not null, item_id uuid not null,
 type text not null check(type in ('stock.receive','stock.waste','stock.count','stock.adjust')),
 quantity_milli bigint not null check(abs(quantity_milli)<=1000000000000),
 before_milli bigint check(before_milli between 0 and 1000000000000),
 delta_milli bigint check(abs(delta_milli)<=1000000000000),
 after_milli bigint not null check(after_milli between 0 and 1000000000000),
 reason text not null check(reason=btrim(reason) and length(reason) between 1 and 240),
 reference text check(reference is null or (reference=btrim(reference) and length(reference) between 1 and 120)),
 actor_id uuid not null references auth.users,device_id uuid not null,
 actor_name text not null,device_name text not null,recorded_at timestamptz not null,
 revision integer not null check(revision between 2 and 2147483646),
 foreign key(organization_id,branch_id,item_id) references public.pos_stock_items(organization_id,branch_id,id),
 foreign key(organization_id,branch_id,id) references public.pos_inventory_commands(organization_id,branch_id,id),
 foreign key(organization_id,branch_id,device_id) references public.pos_devices(organization_id,branch_id,id),
 unique(item_id,revision),
 check((before_milli is null and delta_milli is null and type='stock.count') or
       (before_milli is not null and delta_milli is not null and after_milli=before_milli+delta_milli)),
 check((type='stock.receive' and quantity_milli>0 and delta_milli=quantity_milli and before_milli is not null) or
       (type='stock.waste' and quantity_milli>0 and delta_milli=-quantity_milli and before_milli is not null) or
       (type='stock.adjust' and quantity_milli<>0 and delta_milli=quantity_milli and before_milli is not null) or
       (type='stock.count' and quantity_milli>=0 and after_milli=quantity_milli))
);
create index pos_stock_movements_history on public.pos_stock_movements(branch_id,item_id,revision desc);
alter table public.pos_stock_items enable row level security;
alter table public.pos_inventory_commands enable row level security;
alter table public.pos_stock_movements enable row level security;
revoke all on public.pos_stock_items,public.pos_inventory_commands,public.pos_stock_movements from public,anon,authenticated,service_role;
create trigger pos_inventory_commands_immutable before update or delete on public.pos_inventory_commands for each row execute function public.pos_preserve_document();
create trigger pos_stock_movements_immutable before update or delete on public.pos_stock_movements for each row execute function public.pos_preserve_document();

create function public.pos_stock_identity_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'POS_INVENTORY_IMMUTABLE';end if;
 if new.id<>old.id or new.organization_id<>old.organization_id or new.branch_id<>old.branch_id or new.unit<>old.unit or new.created_at<>old.created_at then raise exception 'POS_INVENTORY_IMMUTABLE';end if;
 return new;
end $$;
create trigger pos_stock_identity_immutable before update or delete on public.pos_stock_items for each row execute function public.pos_stock_identity_guard();

create function public.pos_inventory_uuid(p jsonb) returns uuid language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p) is distinct from 'string' or p#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'POS_INVENTORY_INVALID';end if;
 return (p#>>'{}')::uuid;
end $$;
create function public.pos_inventory_integer(p jsonb,p_min bigint,p_max bigint) returns bigint language plpgsql immutable set search_path='' as $$
declare n numeric;
begin
 if jsonb_typeof(p) is distinct from 'number' then raise exception 'POS_INVENTORY_INVALID';end if;
 n:=(p#>>'{}')::numeric;
 if n<>trunc(n) or n<p_min or n>p_max then raise exception 'POS_INVENTORY_INVALID';end if;
 return n::bigint;
end $$;
create function public.pos_inventory_validate(p jsonb) returns void language plpgsql immutable set search_path='' as $$
declare keys text[];i jsonb;n bigint;
begin
 if jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>8192 then raise exception 'POS_INVENTORY_INVALID';end if;
 if p->>'type'='item.save' then keys:=array['id','type','branchId','deviceId','expectedRevision','reason','item'];
 elsif p->>'type' in ('stock.receive','stock.waste','stock.count','stock.adjust') then keys:=array['id','type','branchId','deviceId','itemId','expectedRevision','quantityMilli','reason','reference'];
 else raise exception 'POS_INVENTORY_INVALID';end if;
 if not p ?& keys or (p-keys)<>'{}'::jsonb then raise exception 'POS_INVENTORY_INVALID';end if;
 perform public.pos_inventory_uuid(p->'id');perform public.pos_inventory_uuid(p->'branchId');perform public.pos_inventory_uuid(p->'deviceId');
 perform public.pos_inventory_integer(p->'expectedRevision',0,2147483646);
 if jsonb_typeof(p->'reason') is distinct from 'string' or length(p->>'reason') not between 1 and 240 or p->>'reason'<>btrim(p->>'reason') then raise exception 'POS_INVENTORY_INVALID';end if;
 if p->>'type'='item.save' then
  i:=p->'item';keys:=array['id','name','sku','unit','reorderLevelMilli','active'];
  if jsonb_typeof(i) is distinct from 'object' or not i ?& keys or (i-keys)<>'{}'::jsonb then raise exception 'POS_INVENTORY_INVALID';end if;
  perform public.pos_inventory_uuid(i->'id');n:=public.pos_inventory_integer(i->'reorderLevelMilli',0,1000000000000);
  if jsonb_typeof(i->'name') is distinct from 'string' or length(i->>'name') not between 1 and 160 or i->>'name'<>btrim(i->>'name')
   or (i->'sku'<>'null'::jsonb and (jsonb_typeof(i->'sku') is distinct from 'string' or i->>'sku' !~ '^[A-Z0-9._-]{1,64}$'))
   or jsonb_typeof(i->'active') is distinct from 'boolean' or jsonb_typeof(i->'unit') is distinct from 'string' or i->>'unit' not in ('kg','litre','piece')
   or (i->>'unit'='piece' and n%1000<>0) then raise exception 'POS_INVENTORY_INVALID';end if;
 else
  perform public.pos_inventory_integer(p->'expectedRevision',1,2147483646);
  perform public.pos_inventory_uuid(p->'itemId');n:=public.pos_inventory_integer(p->'quantityMilli',-1000000000000,1000000000000);
  if (p->>'type' in ('stock.receive','stock.waste') and n<=0) or (p->>'type'='stock.adjust' and n=0) or (p->>'type'='stock.count' and n<0)
   or (p->'reference'<>'null'::jsonb and (jsonb_typeof(p->'reference') is distinct from 'string' or length(p->>'reference') not between 1 and 120 or p->>'reference'<>btrim(p->>'reference'))) then raise exception 'POS_INVENTORY_INVALID';end if;
 end if;
end $$;

-- Called from VOLATILE outer RPCs so a waiter observes committed staff revocation.
create function public.pos_inventory_authority(p_branch uuid) returns uuid language plpgsql volatile security definer set search_path='' as $$
declare org uuid;
begin
 org:=public.pos_lock_staff_authority(p_branch);
 perform public.pos_staff_manager(p_branch);
 perform 1 from public.pos_branches where id=p_branch and organization_id=org and active for share;
 if not found then raise exception 'POS_ACCESS_DENIED';end if;
 return org;
end $$;
create function public.pos_inventory_device(p_branch uuid,p_device uuid,p_binding text,p_historical boolean) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare d public.pos_devices;
begin
 if auth.uid() is null or p_binding is null or p_binding !~ '^[a-f0-9]{64}$' then raise exception 'POS_DEVICE_INVALID';end if;
 select * into d from public.pos_devices where id=p_device and branch_id=p_branch for share;
 if not found or (not p_historical and not d.active) then raise exception 'POS_DEVICE_INVALID';end if;
 perform 1 from public.pos_device_bindings where token_hash=p_binding and user_id=auth.uid() and organization_id=d.organization_id and branch_id=p_branch and device_id=p_device and (p_historical or revoked_at is null) for share;
 if not found then raise exception 'POS_DEVICE_INVALID';end if;
 return jsonb_build_object('organizationId',d.organization_id,'deviceName',d.name);
end $$;
create function public.pos_stock_item_snapshot(p public.pos_stock_items) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',p.id,'branchId',p.branch_id,'name',p.name,'sku',p.sku,'unit',p.unit,'reorderLevelMilli',p.reorder_level_milli,'active',p.active,'revision',p.revision,'onHandMilli',p.on_hand_milli,'createdAt',p.created_at,'updatedAt',p.updated_at,'movementCount',p.movement_count)
$$;
create function public.pos_stock_movement_snapshot(p public.pos_stock_movements) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',p.id,'itemId',p.item_id,'type',p.type,'quantityMilli',p.quantity_milli,'beforeMilli',p.before_milli,'deltaMilli',p.delta_milli,'afterMilli',p.after_milli,'reason',p.reason,'reference',p.reference,'actorId',p.actor_id,'deviceId',p.device_id,'actorName',p.actor_name,'deviceName',p.device_name,'recordedAt',p.recorded_at,'revision',p.revision)
$$;

create function public.pos_inventory(p_branch uuid,p_query jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare org uuid;cursor_id uuid;search text;v_filter text;answer jsonb;total bigint;
begin
 org:=public.pos_inventory_authority(p_branch);
 if jsonb_typeof(p_query) is distinct from 'object' or not p_query ?& array['search','filter','afterId'] or (p_query-array['search','filter','afterId'])<>'{}'::jsonb
  or jsonb_typeof(p_query->'search') is distinct from 'string' or length(p_query->>'search')>160
  or jsonb_typeof(p_query->'filter') is distinct from 'string' or p_query->>'filter' not in ('all','low','uncounted','inactive') then raise exception 'POS_INVENTORY_INVALID';end if;
 if p_query->'afterId'<>'null'::jsonb then cursor_id:=public.pos_inventory_uuid(p_query->'afterId');end if;
 search:=lower(p_query->>'search');v_filter:=p_query->>'filter';
 with source as materialized(select * from public.pos_stock_items where organization_id=org and branch_id=p_branch limit 1001),
 matches as materialized(select * from source where (search='' or strpos(lower(name),search)>0 or strpos(lower(coalesce(sku,'')),search)>0)
  and (v_filter='all' or (v_filter='low' and active and on_hand_milli<=reorder_level_milli) or (v_filter='uncounted' and active and on_hand_milli is null) or (v_filter='inactive' and not active))),
 page as materialized(select * from matches where cursor_id is null or id>cursor_id order by id limit 51)
 select (select count(*) from source),jsonb_build_object('status','ready','branchId',p_branch,'asOf',clock_timestamp(),
 'counts',jsonb_build_object('totalItems',(select count(*) from source),'activeItems',(select count(*) from source where active),'inactiveItems',(select count(*) from source where not active),'lowStockItems',(select count(*) from source where active and on_hand_milli<=reorder_level_milli),'uncountedItems',(select count(*) from source where active and on_hand_milli is null)),
 'matchingItems',(select count(*) from matches),'items',coalesce((select jsonb_agg(public.pos_stock_item_snapshot(p::public.pos_stock_items) order by p.id) from (select * from page order by id limit 50) p),'[]'::jsonb),
 'nextCursor',case when (select count(*) from page)>50 then (select id from page order by id offset 49 limit 1) else null end)
 into total,answer;
 if total>1000 then raise exception 'POS_INVENTORY_CAPACITY';end if;
 return answer;
end $$;

create function public.pos_inventory_history(p_branch uuid,p_item uuid,p_before_revision integer default null) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare org uuid;answer jsonb;
begin
 org:=public.pos_inventory_authority(p_branch);
 if p_item is null or (p_before_revision is not null and p_before_revision not between 2 and 2147483646) then raise exception 'POS_INVENTORY_INVALID';end if;
 with item as materialized(select * from public.pos_stock_items where organization_id=org and branch_id=p_branch and id=p_item),
 page as materialized(select m.* from public.pos_stock_movements m where m.organization_id=org and m.branch_id=p_branch and m.item_id=p_item and (p_before_revision is null or m.revision<p_before_revision) order by m.revision desc limit 51)
 select jsonb_build_object('status','ready','branchId',p_branch,'asOf',clock_timestamp(),'item',public.pos_stock_item_snapshot(i::public.pos_stock_items),
 'entries',coalesce((select jsonb_agg(public.pos_stock_movement_snapshot(m::public.pos_stock_movements) order by m.revision desc) from (select * from page order by revision desc limit 50) m),'[]'::jsonb),
 'nextBeforeRevision',case when (select count(*) from page)>50 then (select revision from page order by revision desc offset 49 limit 1) else null end)
 into answer from item i;
 if answer is null then raise exception 'POS_INVENTORY_NOT_FOUND';end if;
 return answer;
end $$;

create function public.pos_manage_inventory(p_command jsonb,p_binding text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare org uuid;branch uuid;request uuid;device uuid;item_id uuid;kind text;bound jsonb;
 old public.pos_inventory_commands;before_row public.pos_stock_items;after_row public.pos_stock_items;m public.pos_stock_movements;
 item jsonb;answer jsonb;expected integer;quantity bigint;balance bigint;delta bigint;stamp timestamptz;actor_name text;
begin
 perform public.pos_inventory_validate(p_command);
 branch:=(p_command->>'branchId')::uuid;request:=(p_command->>'id')::uuid;device:=(p_command->>'deviceId')::uuid;kind:=p_command->>'type';
 org:=public.pos_inventory_authority(branch);
 perform pg_advisory_xact_lock(hashtextextended(request::text,38));
 -- All stock writers serialize branch quota/SKU decisions before device/item rows.
 perform pg_advisory_xact_lock(hashtextextended(branch::text,39));
 bound:=public.pos_inventory_device(branch,device,p_binding,false);
 if (bound->>'organizationId')::uuid<>org then raise exception 'POS_DEVICE_INVALID';end if;
 select * into old from public.pos_inventory_commands where id=request;
 if found then
  if old.actor_id<>auth.uid() or old.organization_id<>org or old.branch_id<>branch or old.device_id<>device or old.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;
  return old.result||jsonb_build_object('replayed',true);
 end if;
 expected:=(p_command->>'expectedRevision')::integer;
 item:=p_command->'item';item_id:=case when kind='item.save' then (item->>'id')::uuid else (p_command->>'itemId')::uuid end;
 perform pg_advisory_xact_lock(hashtextextended(item_id::text,40));
 select * into before_row from public.pos_stock_items where id=item_id for update;
 if found then
  if before_row.organization_id<>org or before_row.branch_id<>branch then raise exception 'POS_ACCESS_DENIED';end if;
  if before_row.revision<>expected then raise exception 'POS_INVENTORY_CONFLICT';end if;
  if before_row.revision=2147483646 then raise exception 'POS_INVENTORY_CAPACITY';end if;
 elsif kind<>'item.save' or expected<>0 then raise exception 'POS_INVENTORY_CONFLICT';end if;
 stamp:=clock_timestamp();
 if kind='item.save' then
  if before_row.id is not null and before_row.unit<>item->>'unit' then raise exception 'POS_INVENTORY_UNIT_IMMUTABLE';end if;
  if item->'sku'<>'null'::jsonb and exists(select 1 from public.pos_stock_items s where s.branch_id=branch and s.sku=item->>'sku' and s.id<>item_id) then raise exception 'POS_INVENTORY_SKU_CONFLICT';end if;
  if before_row.id is null then
   if (select count(*) from (select id from public.pos_stock_items where branch_id=branch limit 1000) q)>=1000 then raise exception 'POS_INVENTORY_CAPACITY';end if;
   insert into public.pos_stock_items(id,organization_id,branch_id,name,sku,unit,reorder_level_milli,active,revision,on_hand_milli,movement_count,created_at,updated_at)
   values(item_id,org,branch,item->>'name',item->>'sku',item->>'unit',(item->>'reorderLevelMilli')::bigint,(item->>'active')::boolean,1,null,0,stamp,stamp) returning * into after_row;
  else
   update public.pos_stock_items set name=item->>'name',sku=item->>'sku',reorder_level_milli=(item->>'reorderLevelMilli')::bigint,active=(item->>'active')::boolean,revision=revision+1,updated_at=greatest(stamp,before_row.updated_at) where id=item_id returning * into after_row;
  end if;
 else
  if not before_row.active then raise exception 'POS_INVENTORY_INACTIVE';end if;
  quantity:=(p_command->>'quantityMilli')::bigint;
  if before_row.unit='piece' and quantity%1000<>0 then raise exception 'POS_INVENTORY_INVALID';end if;
  if before_row.on_hand_milli is null and kind<>'stock.count' then raise exception 'POS_INVENTORY_COUNT_REQUIRED';end if;
  balance:=case kind when 'stock.count' then quantity when 'stock.waste' then before_row.on_hand_milli-quantity else before_row.on_hand_milli+quantity end;
  if balance<0 then raise exception 'POS_INVENTORY_INSUFFICIENT';end if;
  if balance>1000000000000 then raise exception 'POS_INVENTORY_CAPACITY';end if;
  delta:=case when before_row.on_hand_milli is null then null else balance-before_row.on_hand_milli end;
  update public.pos_stock_items set on_hand_milli=balance,revision=revision+1,movement_count=movement_count+1,updated_at=greatest(stamp,before_row.updated_at) where id=item_id returning * into after_row;
  select coalesce(display_name,case role when 'owner' then 'Owner' else 'Manager' end) into actor_name from public.pos_staff where organization_id=org and user_id=auth.uid();
  m.id:=request;m.organization_id:=org;m.branch_id:=branch;m.item_id:=item_id;m.type:=kind;m.quantity_milli:=quantity;m.before_milli:=before_row.on_hand_milli;m.delta_milli:=delta;m.after_milli:=balance;
  m.reason:=p_command->>'reason';m.reference:=p_command->>'reference';m.actor_id:=auth.uid();m.device_id:=device;m.actor_name:=actor_name;m.device_name:=bound->>'deviceName';m.recorded_at:=stamp;m.revision:=after_row.revision;
 end if;
 answer:=jsonb_build_object('status','applied','requestId',request,'replayed',false,'item',public.pos_stock_item_snapshot(after_row),'movement',case when kind='item.save' then null else public.pos_stock_movement_snapshot(m) end);
 insert into public.pos_inventory_commands(id,organization_id,branch_id,actor_id,device_id,item_id,kind,payload,before_item,result,status,created_at)
 values(request,org,branch,auth.uid(),device,item_id,kind,p_command,case when before_row.id is null then null else public.pos_stock_item_snapshot(before_row) end,answer,'applied',stamp);
 if kind<>'item.save' then insert into public.pos_stock_movements select m.*;end if;
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
 values(org,branch,auth.uid(),'inventory.'||kind,item_id,jsonb_build_object('requestId',request,'reason',p_command->>'reason','before',case when before_row.id is null then null else public.pos_stock_item_snapshot(before_row) end,'after',public.pos_stock_item_snapshot(after_row)));
 return answer;
end $$;

-- Historical request lookup/cancellation has no current stock-read authority and
-- never recalculates a committed result from a later item projection. A cancelled
-- request permanently defeats every delayed write of the same exact command.
create function public.pos_inventory_request(p_mode text,p_command jsonb,p_binding text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare branch uuid;device uuid;request uuid;item_id uuid;bound jsonb;old public.pos_inventory_commands;answer jsonb;
begin
 if p_mode is null or p_mode not in ('lookup','cancel') then raise exception 'POS_INVENTORY_INVALID';end if;
 perform public.pos_inventory_validate(p_command);
 branch:=(p_command->>'branchId')::uuid;device:=(p_command->>'deviceId')::uuid;request:=(p_command->>'id')::uuid;
 perform pg_advisory_xact_lock(hashtextextended(request::text,38));
 bound:=public.pos_inventory_device(branch,device,p_binding,true);
 select * into old from public.pos_inventory_commands where id=request;
 if found then
  if old.actor_id<>auth.uid() or old.branch_id<>branch or old.device_id<>device or old.organization_id<>(bound->>'organizationId')::uuid or old.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;
  return old.result||jsonb_build_object('replayed',true);
 end if;
 if p_mode='lookup' then return jsonb_build_object('status','not_found','requestId',request);end if;
 item_id:=case when p_command->>'type'='item.save' then (p_command->'item'->>'id')::uuid else (p_command->>'itemId')::uuid end;
 answer:=jsonb_build_object('status','cancelled','requestId',request,'replayed',false);
 insert into public.pos_inventory_commands(id,organization_id,branch_id,actor_id,device_id,item_id,kind,payload,result,status)
 values(request,(bound->>'organizationId')::uuid,branch,auth.uid(),device,item_id,p_command->>'type',p_command,answer,'cancelled');
 return answer;
end $$;

revoke all on function public.pos_stock_identity_guard(),public.pos_inventory_uuid(jsonb),public.pos_inventory_integer(jsonb,bigint,bigint),public.pos_inventory_validate(jsonb),public.pos_inventory_authority(uuid),public.pos_inventory_device(uuid,uuid,text,boolean),public.pos_stock_item_snapshot(public.pos_stock_items),public.pos_stock_movement_snapshot(public.pos_stock_movements),public.pos_inventory(uuid,jsonb),public.pos_inventory_history(uuid,uuid,integer),public.pos_manage_inventory(jsonb,text),public.pos_inventory_request(text,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.pos_inventory(uuid,jsonb),public.pos_inventory_history(uuid,uuid,integer),public.pos_manage_inventory(jsonb,text),public.pos_inventory_request(text,jsonb,text) to authenticated;
