-- Recipe/BOM foundation only. Recipes are versioned and immutable; this migration
-- deliberately creates no stock movement and never changes past orders, invoices,
-- returns, cash, tax or ingredient balances. A future explicitly commissioned sale
-- deduction module must snapshot this recipe version before it writes a movement.

create table public.pos_recipe_commands (
 id uuid primary key,
 organization_id uuid not null,
 branch_id uuid not null,
 actor_id uuid not null references auth.users,
 device_id uuid not null,
 product_id uuid not null,
 payload jsonb not null,
 result jsonb not null,
 status text not null check(status='applied'),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,branch_id,device_id) references public.pos_devices(organization_id,branch_id,id),
 foreign key(organization_id,branch_id,product_id) references public.pos_products(organization_id,branch_id,id),
 unique(organization_id,branch_id,id),
 check(result->>'status'=status), check(result->>'requestId'=id::text)
);

create table public.pos_recipe_versions (
 id uuid primary key,
 organization_id uuid not null,
 branch_id uuid not null,
 product_id uuid not null,
 revision integer not null check(revision between 1 and 2147483646),
 output_quantity_milli bigint not null check(output_quantity_milli between 1 and 1000000000000),
 note text check(note is null or (note=btrim(note) and length(note) between 1 and 240)),
 command_id uuid not null,
 created_at timestamptz not null,
 foreign key(organization_id,branch_id,product_id) references public.pos_products(organization_id,branch_id,id),
 foreign key(organization_id,branch_id,command_id) references public.pos_recipe_commands(organization_id,branch_id,id),
 unique(product_id,revision), unique(command_id)
);
create index pos_recipe_versions_current on public.pos_recipe_versions(branch_id,product_id,revision desc);

create table public.pos_recipe_ingredients (
 recipe_id uuid not null references public.pos_recipe_versions(id),
 stock_item_id uuid not null,
 quantity_milli bigint not null check(quantity_milli between 1 and 1000000000000),
 primary key(recipe_id,stock_item_id),
 foreign key(stock_item_id) references public.pos_stock_items(id)
);
create index pos_recipe_ingredients_stock on public.pos_recipe_ingredients(stock_item_id);

alter table public.pos_recipe_commands enable row level security;
alter table public.pos_recipe_versions enable row level security;
alter table public.pos_recipe_ingredients enable row level security;
revoke all on public.pos_recipe_commands,public.pos_recipe_versions,public.pos_recipe_ingredients from public,anon,authenticated,service_role;
create trigger pos_recipe_commands_immutable before update or delete on public.pos_recipe_commands for each row execute function public.pos_preserve_document();
create trigger pos_recipe_versions_immutable before update or delete on public.pos_recipe_versions for each row execute function public.pos_preserve_document();
create trigger pos_recipe_ingredients_immutable before update or delete on public.pos_recipe_ingredients for each row execute function public.pos_preserve_document();

create function public.pos_recipe_uuid(p jsonb) returns uuid language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p) is distinct from 'string' or p#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'POS_RECIPE_INVALID';end if;
 return (p#>>'{}')::uuid;
end $$;
create function public.pos_recipe_integer(p jsonb,p_min bigint,p_max bigint) returns bigint language plpgsql immutable set search_path='' as $$
declare n numeric;
begin
 if jsonb_typeof(p) is distinct from 'number' then raise exception 'POS_RECIPE_INVALID';end if;
 n:=(p#>>'{}')::numeric;
 if n<>trunc(n) or n<p_min or n>p_max then raise exception 'POS_RECIPE_INVALID';end if;
 return n::bigint;
end $$;
create function public.pos_recipe_validate(p jsonb) returns void language plpgsql immutable set search_path='' as $$
declare i jsonb; n integer:=0; ids uuid[]:='{}'; ingredient uuid; quantity bigint;
begin
 if jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>32768 or not p ?& array['id','branchId','deviceId','productId','outputQuantityMilli','note','ingredients'] or (p-array['id','branchId','deviceId','productId','outputQuantityMilli','note','ingredients'])<>'{}'::jsonb then raise exception 'POS_RECIPE_INVALID';end if;
 perform public.pos_recipe_uuid(p->'id'); perform public.pos_recipe_uuid(p->'branchId'); perform public.pos_recipe_uuid(p->'deviceId'); perform public.pos_recipe_uuid(p->'productId'); perform public.pos_recipe_integer(p->'outputQuantityMilli',1,1000000000000);
 if p->'note'<>'null'::jsonb and (jsonb_typeof(p->'note') is distinct from 'string' or length(p->>'note') not between 1 and 240 or p->>'note'<>btrim(p->>'note')) then raise exception 'POS_RECIPE_INVALID';end if;
 if jsonb_typeof(p->'ingredients') is distinct from 'array' or jsonb_array_length(p->'ingredients') not between 1 and 100 then raise exception 'POS_RECIPE_INVALID';end if;
 for i in select value from jsonb_array_elements(p->'ingredients') loop
  n:=n+1;
  if jsonb_typeof(i) is distinct from 'object' or not i ?& array['stockItemId','quantityMilli'] or (i-array['stockItemId','quantityMilli'])<>'{}'::jsonb then raise exception 'POS_RECIPE_INVALID';end if;
  ingredient:=public.pos_recipe_uuid(i->'stockItemId'); quantity:=public.pos_recipe_integer(i->'quantityMilli',1,1000000000000);
  if ingredient=any(ids) then raise exception 'POS_RECIPE_INVALID';end if; ids:=array_append(ids,ingredient);
 end loop;
end $$;

create function public.pos_recipe_snapshot(p public.pos_recipe_versions) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p.id,'productId',p.product_id,'revision',p.revision,'outputQuantityMilli',p.output_quantity_milli,'note',p.note,'createdAt',p.created_at,
 'ingredients',coalesce((select jsonb_agg(jsonb_build_object('stockItemId',i.stock_item_id,'name',s.name,'unit',s.unit,'quantityMilli',i.quantity_milli) order by s.name,i.stock_item_id)
 from public.pos_recipe_ingredients i join public.pos_stock_items s on s.id=i.stock_item_id where i.recipe_id=p.id),'[]'::jsonb))
$$;

create function public.pos_recipes(p_branch uuid) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare org uuid; answer jsonb;
begin
 org:=public.pos_inventory_authority(p_branch);
 with latest as materialized(select distinct on (r.product_id) r.* from public.pos_recipe_versions r where r.organization_id=org and r.branch_id=p_branch order by r.product_id,r.revision desc)
 select jsonb_build_object('status','ready','branchId',p_branch,'recipes',coalesce(jsonb_agg(jsonb_build_object('productId',p.id,'productName',p.name,'productUnit',p.unit,'recipe',public.pos_recipe_snapshot(r)) order by p.name,p.id),'[]'::jsonb)) into answer
 from public.pos_products p left join latest r on r.product_id=p.id where p.organization_id=org and p.branch_id=p_branch;
 return answer;
end $$;

create function public.pos_manage_recipe(p_command jsonb,p_binding text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare org uuid; branch uuid; request uuid; device uuid; product uuid; old public.pos_recipe_commands; current_revision integer; result jsonb; stamp timestamptz; recipe_id uuid; r public.pos_recipe_versions; i jsonb; stock public.pos_stock_items;
begin
 perform public.pos_recipe_validate(p_command);
 branch:=(p_command->>'branchId')::uuid; request:=(p_command->>'id')::uuid; device:=(p_command->>'deviceId')::uuid; product:=(p_command->>'productId')::uuid;
 org:=public.pos_inventory_authority(branch);
 perform public.pos_inventory_device(branch,device,p_binding,false);
 perform pg_advisory_xact_lock(hashtextextended(product::text,47));
 select * into old from public.pos_recipe_commands where id=request;
 if found then
  if old.organization_id<>org or old.branch_id<>branch or old.actor_id<>auth.uid() or old.device_id<>device or old.payload<>p_command then raise exception 'POS_RECIPE_IDEMPOTENCY_CONFLICT';end if;
  return old.result || jsonb_build_object('replayed',true);
 end if;
 perform 1 from public.pos_products where id=product and organization_id=org and branch_id=branch for share;
 if not found then raise exception 'POS_RECIPE_PRODUCT_NOT_FOUND';end if;
 for i in select value from jsonb_array_elements(p_command->'ingredients') loop
  select * into stock from public.pos_stock_items where id=(i->>'stockItemId')::uuid and organization_id=org and branch_id=branch and active for share;
  if not found then raise exception 'POS_RECIPE_STOCK_ITEM_NOT_FOUND';end if;
  if stock.unit='piece' and ((i->>'quantityMilli')::bigint%1000<>0) then raise exception 'POS_RECIPE_INVALID';end if;
 end loop;
 select coalesce(max(revision),0)+1 into current_revision from public.pos_recipe_versions where product_id=product;
 stamp:=clock_timestamp(); recipe_id:=gen_random_uuid();
 insert into public.pos_recipe_versions(id,organization_id,branch_id,product_id,revision,output_quantity_milli,note,command_id,created_at)
 values(recipe_id,org,branch,product,current_revision,(p_command->>'outputQuantityMilli')::bigint,p_command->>'note',request,stamp) returning * into r;
 for i in select value from jsonb_array_elements(p_command->'ingredients') loop
  insert into public.pos_recipe_ingredients(recipe_id,stock_item_id,quantity_milli) values(recipe_id,(i->>'stockItemId')::uuid,(i->>'quantityMilli')::bigint);
 end loop;
 result:=jsonb_build_object('status','applied','requestId',request,'replayed',false,'recipe',public.pos_recipe_snapshot(r));
 insert into public.pos_recipe_commands(id,organization_id,branch_id,actor_id,device_id,product_id,payload,result,status,created_at) values(request,org,branch,auth.uid(),device,product,p_command,result,'applied',stamp);
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details) values(org,branch,auth.uid(),'recipe.versioned',recipe_id,jsonb_build_object('requestId',request,'productId',product,'revision',current_revision,'ingredientCount',jsonb_array_length(p_command->'ingredients')));
 return result;
end $$;

revoke all on function public.pos_recipe_uuid(jsonb),public.pos_recipe_integer(jsonb,bigint,bigint),public.pos_recipe_validate(jsonb),public.pos_recipe_snapshot(public.pos_recipe_versions),public.pos_recipes(uuid),public.pos_manage_recipe(jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.pos_recipes(uuid),public.pos_manage_recipe(jsonb,text) to authenticated;
