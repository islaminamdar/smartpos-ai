-- Server-authoritative, single-offer checkout. No merchant data is seeded.
-- Existing v1 invoices and credits remain immutable and replayable.
create table public.pos_offers (
 id uuid primary key, organization_id uuid not null, branch_id uuid not null,
 revision integer not null check(revision between 1 and 2147483647), definition jsonb not null,
 redemptions_used bigint not null default 0 check(redemptions_used between 0 and 1000000000),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id),
 unique(organization_id,branch_id,id),
 check(definition->>'id'=id::text and definition->>'branchId'=branch_id::text and (definition->>'revision')::integer=revision)
);
create table public.pos_offer_versions (
 offer_id uuid not null references public.pos_offers, revision integer not null, definition jsonb not null,
 actor_id uuid not null references auth.users, created_at timestamptz not null default now(),
 primary key(offer_id,revision)
);
create table public.pos_offer_commands (
 id uuid primary key, organization_id uuid not null, branch_id uuid not null, device_id uuid not null,
 actor_id uuid not null references auth.users, payload jsonb not null, result jsonb not null,
 created_at timestamptz not null default now(),
 foreign key(organization_id,branch_id,device_id) references public.pos_devices(organization_id,branch_id,id)
);
create table public.pos_offer_redemptions (
 order_id uuid primary key, organization_id uuid not null, branch_id uuid not null,
 offer_id uuid not null, offer_revision integer not null, actor_id uuid not null references auth.users,
 discount_fils integer not null check(discount_fils>0), redeemed_at timestamptz not null,
 foreign key(organization_id,branch_id,order_id) references public.pos_orders(organization_id,branch_id,id),
 foreign key(organization_id,branch_id,offer_id) references public.pos_offers(organization_id,branch_id,id),
 foreign key(offer_id,offer_revision) references public.pos_offer_versions(offer_id,revision)
);
do $$ declare t text; begin
 foreach t in array array['pos_offers','pos_offer_versions','pos_offer_commands','pos_offer_redemptions'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
 end loop;
 foreach t in array array['pos_offer_versions','pos_offer_commands','pos_offer_redemptions'] loop
  execute format('create trigger %I before update or delete on public.%I for each row execute function public.pos_preserve_document()',t||'_immutable',t);
 end loop;
end $$;
create index pos_offers_branch on public.pos_offers(branch_id);

create function public.pos_offer_integer(p jsonb,p_min bigint,p_max bigint) returns boolean
language sql immutable set search_path='' as $$
 select case when jsonb_typeof(p)='number' then (p#>>'{}')::numeric=trunc((p#>>'{}')::numeric) and (p#>>'{}')::numeric between p_min and p_max else false end
$$;
revoke all on function public.pos_offer_integer(jsonb,bigint,bigint) from public,anon,authenticated;

-- Validate all nested definition fields at the database boundary, including direct RPC calls.
create function public.pos_validate_offer(p jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare b jsonb; s jsonb; e jsonb; w jsonb; x jsonb; ids jsonb; cats jsonb; n integer; d integer; seen integer[]; result jsonb:=p;
begin
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'POS_INVALID_OFFER'; end if;
 if not p ?& array['id','name','active','benefit','schedule','minimumSpendFils','serviceTypes','managerOnly','coupon','totalRedemptionsLimit','perCustomerLimit']
  or p-array['id','name','active','benefit','schedule','minimumSpendFils','serviceTypes','managerOnly','coupon','totalRedemptionsLimit','perCustomerLimit']<>'{}'::jsonb
  or jsonb_typeof(p->'id') is distinct from 'string' or p->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  or jsonb_typeof(p->'name') is distinct from 'string' or length(trim(p->>'name')) not between 1 and 120
  or jsonb_typeof(p->'active') is distinct from 'boolean' or jsonb_typeof(p->'managerOnly') is distinct from 'boolean'
  or not public.pos_offer_integer(p->'minimumSpendFils',0,100000000)
  or (p->'coupon'<>'null'::jsonb and (jsonb_typeof(p->'coupon') is distinct from 'string' or p->>'coupon' !~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'))
  or (p->'totalRedemptionsLimit'<>'null'::jsonb and not public.pos_offer_integer(p->'totalRedemptionsLimit',1,1000000000)) then raise exception 'POS_INVALID_OFFER'; end if;
 -- Receipt free text is not a verified customer identity. This feature stays unavailable.
 if p->'perCustomerLimit' is distinct from 'null'::jsonb then raise exception 'POS_OFFER_CUSTOMER_UNSUPPORTED'; end if;
 if jsonb_typeof(p->'serviceTypes') is distinct from 'array' then raise exception 'POS_INVALID_OFFER'; end if;
 n:=jsonb_array_length(p->'serviceTypes');
 if n not between 1 and 3 or (select count(distinct value) from jsonb_array_elements(p->'serviceTypes'))<>n
  or exists(select 1 from jsonb_array_elements(p->'serviceTypes') v where jsonb_typeof(v) is distinct from 'string' or v#>>'{}' not in ('dine_in','takeaway','delivery')) then raise exception 'POS_INVALID_OFFER'; end if;
 s:=p->'schedule';
 if jsonb_typeof(s) is distinct from 'object' or not s ?& array['timezone','startsAt','endsAt','windows'] or s-array['timezone','startsAt','endsAt','windows']<>'{}'::jsonb or s->>'timezone' is distinct from 'Asia/Dubai' then raise exception 'POS_INVALID_OFFER'; end if;
 foreach e in array array[s->'startsAt',s->'endsAt'] loop
  if e<>'null'::jsonb then
   if jsonb_typeof(e) is distinct from 'string' or e#>>'{}' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$' or not isfinite((e#>>'{}')::timestamptz) then raise exception 'POS_INVALID_OFFER'; end if;
  end if;
 end loop;
 if s->'startsAt'<>'null'::jsonb and s->'endsAt'<>'null'::jsonb and (s->>'startsAt')::timestamptz >= (s->>'endsAt')::timestamptz then raise exception 'POS_INVALID_OFFER'; end if;
 if jsonb_typeof(s->'windows') is distinct from 'array' then raise exception 'POS_INVALID_OFFER'; end if;
 if jsonb_array_length(s->'windows')>14 then raise exception 'POS_INVALID_OFFER'; end if;
 for w in select value from jsonb_array_elements(s->'windows') loop
  if jsonb_typeof(w) is distinct from 'object' or not w ?& array['weekdays','startMinute','endMinute'] or w-array['weekdays','startMinute','endMinute']<>'{}'::jsonb
   or not public.pos_offer_integer(w->'startMinute',0,1439) or not public.pos_offer_integer(w->'endMinute',0,1440) or w->'startMinute'=w->'endMinute'
   or jsonb_typeof(w->'weekdays') is distinct from 'array' then raise exception 'POS_INVALID_OFFER'; end if;
  n:=jsonb_array_length(w->'weekdays');
  if n not between 1 and 7 or (select count(distinct value) from jsonb_array_elements(w->'weekdays'))<>n or exists(select 1 from jsonb_array_elements(w->'weekdays') v where not public.pos_offer_integer(v,1,7)) then raise exception 'POS_INVALID_OFFER'; end if;
 end loop;
 b:=p->'benefit';
 if jsonb_typeof(b) is distinct from 'object' or coalesce(b->>'kind','') not in ('percentage','fixed','buy_x_get_y','bundle') then raise exception 'POS_INVALID_OFFER'; end if;
 if b->>'kind'='percentage' then
  if not b ?& array['kind','basisPoints','maximumDiscountFils','eligibility'] or b-array['kind','basisPoints','maximumDiscountFils','eligibility']<>'{}'::jsonb
   or not public.pos_offer_integer(b->'basisPoints',1,10000) or (b->'maximumDiscountFils'<>'null'::jsonb and not public.pos_offer_integer(b->'maximumDiscountFils',1,100000000)) then raise exception 'POS_INVALID_OFFER'; end if;
 elsif b->>'kind'='fixed' then
  if not b ?& array['kind','amountFils','eligibility'] or b-array['kind','amountFils','eligibility']<>'{}'::jsonb or not public.pos_offer_integer(b->'amountFils',1,100000000) then raise exception 'POS_INVALID_OFFER'; end if;
 elsif b->>'kind'='buy_x_get_y' then
  if not b ?& array['kind','buyUnits','freeUnits','eligibility'] or b-array['kind','buyUnits','freeUnits','eligibility']<>'{}'::jsonb or not public.pos_offer_integer(b->'buyUnits',1,1000) or not public.pos_offer_integer(b->'freeUnits',1,1000) then raise exception 'POS_INVALID_OFFER'; end if;
 else
  if not b ?& array['kind','priceFils','components'] or b-array['kind','priceFils','components']<>'{}'::jsonb or not public.pos_offer_integer(b->'priceFils',1,100000000) or jsonb_typeof(b->'components') is distinct from 'array' then raise exception 'POS_INVALID_OFFER'; end if;
  n:=jsonb_array_length(b->'components'); if n not between 2 and 20 then raise exception 'POS_INVALID_OFFER'; end if;
  ids:='[]'::jsonb;
  for x in select value from jsonb_array_elements(b->'components') loop
   if jsonb_typeof(x) is distinct from 'object' or not x ?& array['productId','units'] or x-array['productId','units']<>'{}'::jsonb or not public.pos_offer_integer(x->'units',1,1000)
    or jsonb_typeof(x->'productId') is distinct from 'string' or x->>'productId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'POS_INVALID_OFFER'; end if;
   ids:=ids||jsonb_build_array(x||jsonb_build_object('productId',((x->>'productId')::uuid)::text));
  end loop;
  if (select count(distinct value->>'productId') from jsonb_array_elements(ids))<>n then raise exception 'POS_INVALID_OFFER'; end if;
  b:=jsonb_set(b,'{components}',ids);
 end if;
 if b->>'kind'<>'bundle' then
  e:=b->'eligibility';
  if jsonb_typeof(e) is distinct from 'object' or coalesce(e->>'scope','') not in ('all','products','categories') then raise exception 'POS_INVALID_OFFER'; end if;
  if e->>'scope'='all' then
   if e<>jsonb_build_object('scope','all') then raise exception 'POS_INVALID_OFFER'; end if;
  elsif e->>'scope'='products' then
   if not e ?& array['scope','productIds'] or e-array['scope','productIds']<>'{}'::jsonb or jsonb_typeof(e->'productIds') is distinct from 'array' then raise exception 'POS_INVALID_OFFER'; end if;
   n:=jsonb_array_length(e->'productIds'); if n not between 1 and 200 then raise exception 'POS_INVALID_OFFER'; end if;
   ids:='[]'::jsonb;
   for x in select value from jsonb_array_elements(e->'productIds') loop
    if jsonb_typeof(x) is distinct from 'string' or x#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'POS_INVALID_OFFER'; end if;
    ids:=ids||jsonb_build_array(((x#>>'{}')::uuid)::text);
   end loop;
   if (select count(distinct value) from jsonb_array_elements(ids))<>n then raise exception 'POS_INVALID_OFFER'; end if;
   e:=jsonb_set(e,'{productIds}',ids);
  else
   if not e ?& array['scope','categories'] or e-array['scope','categories']<>'{}'::jsonb or jsonb_typeof(e->'categories') is distinct from 'array' then raise exception 'POS_INVALID_OFFER'; end if;
   n:=jsonb_array_length(e->'categories'); if n not between 1 and 100 then raise exception 'POS_INVALID_OFFER'; end if;
   cats:='[]'::jsonb;
   for x in select value from jsonb_array_elements(e->'categories') loop
    if jsonb_typeof(x) is distinct from 'string' or length(trim(x#>>'{}')) not between 1 and 120 then raise exception 'POS_INVALID_OFFER'; end if;
    cats:=cats||jsonb_build_array(trim(x#>>'{}'));
   end loop;
   if (select count(distinct value) from jsonb_array_elements(cats))<>n then raise exception 'POS_INVALID_OFFER'; end if;
   e:=jsonb_set(e,'{categories}',cats);
  end if;
  b:=jsonb_set(b,'{eligibility}',e);
 end if;
 return result||jsonb_build_object('id',((p->>'id')::uuid)::text,'name',trim(p->>'name'),'benefit',b);
exception when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then raise exception 'POS_INVALID_OFFER';
end $$;
revoke all on function public.pos_validate_offer(jsonb) from public,anon,authenticated;

create function public.pos_offer_allocate(p_total bigint,p_weights bigint[],p_ids text[]) returns bigint[]
language plpgsql immutable set search_path='' as $$
declare result bigint[]:=array_fill(0::bigint,array[array_length(p_weights,1)]); denominator numeric; remaining bigint; r record; i integer;
begin
 select sum(w) into denominator from unnest(p_weights) w;
 if denominator=0 or p_total=0 then return result; end if;
 for i in 1..array_length(p_weights,1) loop result[i]:=floor(p_total::numeric*p_weights[i]/denominator)::bigint; end loop;
 select p_total-sum(v) into remaining from unnest(result) v;
 for r in select n from generate_subscripts(p_weights,1) n order by mod(p_total::numeric*p_weights[n],denominator) desc,p_ids[n] collate "C" loop
  exit when remaining<=0; result[r.n]:=result[r.n]+1; remaining:=remaining-1;
 end loop;
 return result;
end $$;
revoke all on function public.pos_offer_allocate(bigint,bigint[],text[]) from public,anon,authenticated;

-- Internal calculator: caller supplies only validated server catalogue and a private definition.
create function public.pos_calculate_offer(p_offer jsonb,p_lines jsonb,p_now timestamptz,p_role text,p_service text,p_coupon text,p_used bigint) returns jsonb
language plpgsql immutable set search_path='' as $$
declare
 b jsonb:=p_offer->'benefit'; s jsonb:=p_offer->'schedule'; e jsonb; w jsonb; l jsonb; c jsonb; r record;
 n integer:=jsonb_array_length(p_lines); i integer; j integer; idx integer; weekday integer; previous_day integer; minute integer; start_min integer; end_min integer; scheduled boolean;
 ids text[]:='{}'; prices bigint[]:='{}'; quantities bigint[]:='{}'; units text[]:='{}'; gross bigint[]:='{}'; weights bigint[]; discounts bigint[]; eligible_q bigint[]; reward_q bigint[]; bundle_q bigint[];
 subtotal bigint:=0; eligible_subtotal bigint:=0; saving bigint:=0; regular bigint:=0; applications bigint:=1; free_units bigint; count_units bigint; total_units bigint:=0; consumed bigint;
 total_tax bigint:=0; tax bigint; paid bigint; amounts jsonb:='[]'; local_time timestamp; matches boolean;
begin
 if p_role is null or p_role not in ('owner','manager','cashier') then return '{"eligible":false,"reason":"manager_required"}'; end if;
 if not (p_offer->>'active')::boolean then return '{"eligible":false,"reason":"inactive"}'; end if;
 if p_offer->'perCustomerLimit' is distinct from 'null'::jsonb then return '{"eligible":false,"reason":"customer_required"}'; end if;
 if (s->'startsAt'<>'null'::jsonb and p_now<(s->>'startsAt')::timestamptz) or (s->'endsAt'<>'null'::jsonb and p_now>=(s->>'endsAt')::timestamptz) then return '{"eligible":false,"reason":"outside_schedule"}'; end if;
 local_time:=p_now at time zone 'Asia/Dubai'; weekday:=extract(isodow from local_time); previous_day:=case weekday when 1 then 7 else weekday-1 end; minute:=extract(hour from local_time)*60+extract(minute from local_time);
 scheduled:=jsonb_array_length(s->'windows')=0;
 for w in select value from jsonb_array_elements(s->'windows') loop
  start_min:=(w->>'startMinute')::integer; end_min:=(w->>'endMinute')::integer;
  if (start_min<end_min and w->'weekdays' @> to_jsonb(weekday) and minute>=start_min and minute<end_min)
    or (start_min>end_min and ((w->'weekdays' @> to_jsonb(weekday) and minute>=start_min) or (w->'weekdays' @> to_jsonb(previous_day) and minute<end_min))) then scheduled:=true; end if;
 end loop;
 if not scheduled then return '{"eligible":false,"reason":"outside_schedule"}'; end if;
 if not (p_offer->'serviceTypes' ? p_service) then return '{"eligible":false,"reason":"service_type"}'; end if;
 if (p_offer->>'managerOnly')::boolean and p_role not in ('owner','manager') then return '{"eligible":false,"reason":"manager_required"}'; end if;
 if p_offer->'coupon'<>'null'::jsonb and (p_offer->>'coupon') is distinct from upper(trim(p_coupon)) then return '{"eligible":false,"reason":"coupon_required"}'; end if;
 for l in select value from jsonb_array_elements(p_lines) loop
  ids:=array_append(ids,l->>'productId'); prices:=array_append(prices,(l->>'unitPriceFils')::bigint); quantities:=array_append(quantities,(l->>'quantityMilli')::bigint); units:=array_append(units,l->>'unit');
  gross:=array_append(gross,round((l->>'unitPriceFils')::numeric*(l->>'quantityMilli')::numeric/1000)::bigint);
 end loop;
 select sum(v) into subtotal from unnest(gross) v;
 if subtotal<(p_offer->>'minimumSpendFils')::bigint then return '{"eligible":false,"reason":"minimum_spend"}'; end if;
 if p_offer->'totalRedemptionsLimit'<>'null'::jsonb and p_used>=(p_offer->>'totalRedemptionsLimit')::bigint then return '{"eligible":false,"reason":"usage_limit"}'; end if;
 weights:=array_fill(0::bigint,array[n]); discounts:=weights; eligible_q:=weights; reward_q:=weights; bundle_q:=weights;
 if b->>'kind'='bundle' then
  applications:=1000000;
  for c in select value from jsonb_array_elements(b->'components') loop
   idx:=array_position(ids,c->>'productId'); if idx is null then return '{"eligible":false,"reason":"bundle_incomplete"}'; end if;
   if units[idx]='kg' then return '{"eligible":false,"reason":"whole_units_required"}'; end if;
   applications:=least(applications,quantities[idx]/(1000*(c->>'units')::bigint));
  end loop;
  if applications=0 then return '{"eligible":false,"reason":"bundle_incomplete"}'; end if;
  for c in select value from jsonb_array_elements(b->'components') loop
   idx:=array_position(ids,c->>'productId'); consumed:=(c->>'units')::bigint*applications;
   weights[idx]:=consumed*prices[idx]; eligible_q[idx]:=quantities[idx]; bundle_q[idx]:=consumed*1000;
  end loop;
  select sum(v) into regular from unnest(weights) v;
  saving:=regular-(b->>'priceFils')::bigint*applications;
  if saving<=0 then return '{"eligible":false,"reason":"no_saving"}'; end if;
  discounts:=public.pos_offer_allocate(saving,weights,ids);
 else
  e:=b->'eligibility';
  for i in 1..n loop
   l:=p_lines->(i-1);
   matches:=(e->>'scope'='all') or (e->>'scope'='products' and e->'productIds' ? ids[i]) or (e->>'scope'='categories' and e->'categories' ? (l->>'category'));
   if matches then weights[i]:=gross[i]; eligible_q[i]:=quantities[i]; end if;
  end loop;
  select sum(v) into eligible_subtotal from unnest(weights) v;
  if eligible_subtotal=0 then return '{"eligible":false,"reason":"no_eligible_items"}'; end if;
  if b->>'kind'='buy_x_get_y' then
   for i in 1..n loop
    if eligible_q[i]>0 then
     if units[i]='kg' then return '{"eligible":false,"reason":"whole_units_required"}'; end if;
     total_units:=total_units+quantities[i]/1000;
    end if;
   end loop;
   applications:=total_units/((b->>'buyUnits')::bigint+(b->>'freeUnits')::bigint); free_units:=applications*(b->>'freeUnits')::bigint;
   for r in select k from generate_subscripts(prices,1) k where eligible_q[k]>0 order by prices[k],ids[k] collate "C" loop
    count_units:=least(free_units,quantities[r.k]/1000); discounts[r.k]:=count_units*prices[r.k]; reward_q[r.k]:=count_units*1000; free_units:=free_units-count_units;
   end loop;
  else
   if b->>'kind'='fixed' then saving:=least((b->>'amountFils')::bigint,eligible_subtotal);
   else saving:=least(round(eligible_subtotal::numeric*(b->>'basisPoints')::numeric/10000)::bigint,coalesce((b->>'maximumDiscountFils')::bigint,eligible_subtotal)); end if;
   discounts:=public.pos_offer_allocate(saving,weights,ids);
  end if;
 end if;
 select sum(v) into saving from unnest(discounts) v;
 if saving=0 then return '{"eligible":false,"reason":"no_saving"}'; end if;
 if saving=subtotal then return '{"eligible":false,"reason":"zero_total_requires_complimentary_flow"}'; end if;
 for i in 1..n loop
  l:=p_lines->(i-1); paid:=gross[i]-discounts[i]; tax:=round(paid::numeric*(l->>'taxRateBps')::numeric/(10000+(l->>'taxRateBps')::numeric)); total_tax:=total_tax+tax;
  amounts:=amounts||jsonb_build_array(jsonb_build_object('productId',ids[i],'eligibleQuantityMilli',eligible_q[i],'rewardQuantityMilli',reward_q[i],'bundleQuantityMilli',bundle_q[i],
   'beforeDiscountFils',gross[i],'discountFils',discounts[i],'grossFils',paid,'taxFils',tax,'netFils',paid-tax));
 end loop;
 return jsonb_build_object('eligible',true,'calculationVersion','offer-v1','offerId',p_offer->'id','offerRevision',p_offer->'revision','offerName',p_offer->'name','benefit',b,
  'appliedDefinition',(p_offer-'coupon')||jsonb_build_object('couponRequired',p_offer->'coupon'<>'null'::jsonb),'applications',applications,
  'beforeDiscountFils',subtotal,'discountFils',saving,'grossFils',subtotal-saving,'taxFils',total_tax,'netFils',subtotal-saving-total_tax,'lines',amounts);
end $$;
revoke all on function public.pos_calculate_offer(jsonb,jsonb,timestamptz,text,text,text,bigint) from public,anon,authenticated;

-- One product row per basket. The same routine supplies quote and commit calculations.
create function public.pos_offer_catalogue_lines(p_org uuid,p_branch uuid,p_lines jsonb,p_lock boolean) returns jsonb
language plpgsql set search_path='' as $$
declare l jsonb; p public.pos_products%rowtype; output jsonb:='[]'; seen uuid[]:='{}'; product_id uuid; total bigint:=0;
begin
 if jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'POS_INVALID_ORDER'; end if;
 if jsonb_array_length(p_lines) not between 1 and 200 then raise exception 'POS_INVALID_ORDER'; end if;
 for l in select value from jsonb_array_elements(p_lines) loop
  if jsonb_typeof(l) is distinct from 'object' then raise exception 'POS_INVALID_ORDER'; end if;
  if not l ?& array['productId','quantityMilli','expectedUnitPriceFils','expectedTaxRateBps','expectedRevision'] or l-array['productId','quantityMilli','expectedUnitPriceFils','expectedTaxRateBps','expectedRevision']<>'{}'::jsonb
   or jsonb_typeof(l->'productId') is distinct from 'string' or l->>'productId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   or not public.pos_offer_integer(l->'quantityMilli',1,1000000) or not public.pos_offer_integer(l->'expectedUnitPriceFils',1,100000000)
   or not public.pos_offer_integer(l->'expectedTaxRateBps',0,10000) or not public.pos_offer_integer(l->'expectedRevision',1,2147483647) then raise exception 'POS_INVALID_ORDER'; end if;
  product_id:=(l->>'productId')::uuid; if product_id=any(seen) then raise exception 'POS_INVALID_ORDER'; end if; seen:=array_append(seen,product_id);
 end loop;
 if p_lock then
  -- Acquired after device/shift and before the campaign row, in stable order.
  perform 1 from public.pos_products where id=any(seen) and organization_id=p_org and branch_id=p_branch order by id for share;
 end if;
 for l in select value from jsonb_array_elements(p_lines) loop
  select * into p from public.pos_products where id=(l->>'productId')::uuid and organization_id=p_org and branch_id=p_branch and active;
  if not found or p.unit_price_fils<=0 then raise exception 'POS_PRODUCT_UNAVAILABLE'; end if;
  if p.unit<>'kg' and (l->>'quantityMilli')::bigint%1000<>0 then raise exception 'POS_INVALID_ORDER'; end if;
  if p.revision<>(l->>'expectedRevision')::integer or p.unit_price_fils<>(l->>'expectedUnitPriceFils')::integer or p.tax_rate_bps<>(l->>'expectedTaxRateBps')::integer then raise exception 'POS_PRICE_CHANGED'; end if;
  total:=total+round(p.unit_price_fils::numeric*(l->>'quantityMilli')::numeric/1000)::bigint;
  if total>100000000 then raise exception 'POS_INVALID_ORDER'; end if;
  output:=output||jsonb_build_array(jsonb_build_object('productId',p.id,'name',p.name,'category',p.category,'unit',p.unit,'quantityMilli',l->'quantityMilli','unitPriceFils',p.unit_price_fils,'taxRateBps',p.tax_rate_bps));
 end loop;
 return output;
end $$;
revoke all on function public.pos_offer_catalogue_lines(uuid,uuid,jsonb,boolean) from public,anon,authenticated;

create function public.pos_manage_offer(p_command jsonb,p_binding text) returns jsonb
language plpgsql security definer set search_path='' as $$
<<offer_command>>
declare actor uuid:=auth.uid(); org uuid; branch uuid; request_id uuid; device jsonb; definition jsonb; offer_id uuid; expected integer;
 old_command public.pos_offer_commands%rowtype; old_offer public.pos_offers%rowtype; new_revision integer; result jsonb; product_id uuid; seen uuid[]:='{}'; x jsonb;
begin
 if actor is null then raise exception 'POS_ACCESS_DENIED'; end if;
 if jsonb_typeof(p_command) is distinct from 'object' then raise exception 'POS_INVALID_COMMAND'; end if;
 if not p_command ?& array['id','branchId','deviceId','expectedRevision','reason','offer'] or p_command-array['id','branchId','deviceId','expectedRevision','reason','offer']<>'{}'::jsonb
  or not public.pos_offer_integer(p_command->'expectedRevision',0,2147483646) or jsonb_typeof(p_command->'reason') is distinct from 'string' or length(trim(p_command->>'reason')) not between 1 and 240 then raise exception 'POS_INVALID_COMMAND'; end if;
 request_id:=(p_command->>'id')::uuid; branch:=(p_command->>'branchId')::uuid; expected:=(p_command->>'expectedRevision')::integer;
 if request_id is null or branch is null then raise exception 'POS_INVALID_COMMAND'; end if;
 device:=public.pos_bound_device(p_binding);
 if device is null or device->>'id' is distinct from p_command->>'deviceId' or device->>'branchId' is distinct from p_command->>'branchId' then raise exception 'POS_DEVICE_INVALID'; end if;
 select b.organization_id into org from public.pos_branches b where b.id=branch and b.active;
 if org is null or not exists(select 1 from public.pos_staff s where s.organization_id=org and s.user_id=actor and s.active and s.role in ('owner','manager') and (s.branch_id is null or s.branch_id=branch)) then raise exception 'POS_MANAGER_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(request_id::text,12));
 select * into old_command from public.pos_offer_commands c where c.id=request_id;
 if found then
  if old_command.organization_id<>org or old_command.branch_id<>branch or old_command.actor_id<>actor or old_command.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  return old_command.result||'{"replayed":true}'::jsonb;
 end if;
 definition:=public.pos_validate_offer(p_command->'offer'); offer_id:=(definition->>'id')::uuid;
 if not exists(select 1 from public.pos_branch_receipt_config c where c.organization_id=org and c.branch_id=branch) then raise exception 'POS_PROFILE_REQUIRED'; end if;
 perform 1 from public.pos_devices d where d.id=(device->>'id')::uuid and d.organization_id=org and d.branch_id=branch and d.active for share;
 if not found then raise exception 'POS_DEVICE_INVALID'; end if;
 -- Branch cap lock is only used by management, never by the sale writer.
 perform pg_advisory_xact_lock(hashtextextended(branch::text,13));
 if definition#>>'{benefit,kind}'='bundle' then
  select array_agg((value->>'productId')::uuid) into seen from jsonb_array_elements(definition#>'{benefit,components}');
 elsif definition#>>'{benefit,eligibility,scope}'='products' then
  select array_agg((value#>>'{}')::uuid) into seen from jsonb_array_elements(definition#>'{benefit,eligibility,productIds}');
 end if;
 foreach product_id in array (select coalesce(array_agg(v order by v),'{}'::uuid[]) from unnest(seen) v) loop
  perform 1 from public.pos_products p where p.id=product_id and p.organization_id=org and p.branch_id=branch for share;
  if not found then raise exception 'POS_PRODUCT_UNAVAILABLE'; end if;
 end loop;
 -- Serializes creation of a never-before-seen offer id across branches too.
 perform pg_advisory_xact_lock(hashtextextended(offer_id::text,14));
 select * into old_offer from public.pos_offers o where o.id=offer_id for update;
 if found then
  if old_offer.organization_id<>org or old_offer.branch_id<>branch then raise exception 'POS_ACCESS_DENIED'; end if;
  if old_offer.revision<>expected then raise exception 'POS_OFFER_CONFLICT'; end if;
  new_revision:=old_offer.revision+1;
 else
  if expected<>0 then raise exception 'POS_OFFER_CONFLICT'; end if;
  if (select count(*) from public.pos_offers o where o.branch_id=branch)>=200 then raise exception 'POS_OFFER_LIMIT_REACHED'; end if;
  new_revision:=1;
 end if;
 -- Recheck/hold the authorizing membership after any product/offer wait.
 perform 1 from public.pos_staff s where s.organization_id=org and s.user_id=actor and s.active and s.role in ('owner','manager') and (s.branch_id is null or s.branch_id=branch) for share;
 if not found then raise exception 'POS_MANAGER_REQUIRED'; end if;
 definition:=definition||jsonb_build_object('branchId',branch,'revision',new_revision);
 if old_offer.id is null then
  insert into public.pos_offers(id,organization_id,branch_id,revision,definition) values(offer_id,org,branch,new_revision,definition);
 else
  update public.pos_offers set revision=new_revision,definition=offer_command.definition,updated_at=clock_timestamp() where id=offer_id;
 end if;
 insert into public.pos_offer_versions(offer_id,revision,definition,actor_id) values(offer_id,new_revision,definition,actor);
 result:=jsonb_build_object('status','updated','requestId',request_id,'replayed',false,'offer',definition);
 insert into public.pos_offer_commands(id,organization_id,branch_id,device_id,actor_id,payload,result) values(request_id,org,branch,(device->>'id')::uuid,actor,p_command,result);
 -- Readable audit events intentionally contain no coupon or full definition.
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
  values(org,branch,actor,'offer.updated',offer_id,jsonb_build_object('requestId',request_id,'revision',new_revision,'reason',trim(p_command->>'reason'),'active',definition->'active'));
 return result;
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'POS_INVALID_COMMAND';
end $$;
revoke all on function public.pos_manage_offer(jsonb,text) from public,anon;
grant execute on function public.pos_manage_offer(jsonb,text) to authenticated;

create function public.pos_list_offers(p_branch uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare org uuid; result jsonb;
begin
 select b.organization_id into org from public.pos_branches b where b.id=p_branch and b.active;
 if auth.uid() is null or org is null or not exists(select 1 from public.pos_staff s where s.organization_id=org and s.user_id=auth.uid() and s.active and s.role in ('owner','manager') and (s.branch_id is null or s.branch_id=p_branch)) then raise exception 'POS_MANAGER_REQUIRED'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('offer',o.definition,'redemptionsUsed',o.redemptions_used) order by o.created_at,o.id),'[]') into result from public.pos_offers o where o.organization_id=org and o.branch_id=p_branch;
 return jsonb_build_object('status','ready','offers',result);
end $$;
revoke all on function public.pos_list_offers(uuid) from public,anon;
grant execute on function public.pos_list_offers(uuid) to authenticated;

create function public.pos_quote_offers(p_branch uuid,p_lines jsonb,p_service_type text,p_coupon text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid; role_name text; lines jsonb; evaluated timestamptz; offer public.pos_offers%rowtype; quote jsonb; quotes jsonb:='[]';
begin
 if auth.uid() is null then raise exception 'POS_ACCESS_DENIED'; end if;
 select b.organization_id into org from public.pos_branches b where b.id=p_branch and b.active;
 if org is null or not public.pos_can_access(org,p_branch) then raise exception 'POS_ACCESS_DENIED'; end if;
 select s.role into role_name from public.pos_staff s where s.organization_id=org and s.user_id=auth.uid() and s.active;
 if p_service_type is null or p_service_type not in ('dine_in','takeaway','delivery') or length(p_coupon)>32 then raise exception 'POS_INVALID_OFFER'; end if;
 lines:=public.pos_offer_catalogue_lines(org,p_branch,p_lines,false); evaluated:=clock_timestamp();
 for offer in select * from public.pos_offers o where o.organization_id=org and o.branch_id=p_branch order by o.id loop
  quote:=public.pos_calculate_offer(offer.definition,lines,evaluated,role_name,p_service_type,p_coupon,offer.redemptions_used);
  if (quote->>'eligible')::boolean then quotes:=quotes||jsonb_build_array(quote); end if;
 end loop;
 return jsonb_build_object('status','ready','branchId',p_branch,'evaluatedAt',evaluated,'quotes',quotes);
end $$;
revoke all on function public.pos_quote_offers(uuid,jsonb,text,text) from public,anon;
grant execute on function public.pos_quote_offers(uuid,jsonb,text,text) to authenticated;

-- Exact requests contain entered coupon codes. They are private, immutable and used only
-- for scoped replay/recovery; branch-readable financial rows contain a null placeholder.
create table public.pos_offer_sale_requests (
 order_id uuid primary key, organization_id uuid not null, branch_id uuid not null, device_id uuid not null,
 actor_id uuid not null references auth.users, request_payload jsonb not null,
 foreign key(organization_id,branch_id,order_id) references public.pos_orders(organization_id,branch_id,id),
 foreign key(organization_id,branch_id,device_id) references public.pos_devices(organization_id,branch_id,id)
);
alter table public.pos_offer_sale_requests enable row level security;
revoke all on public.pos_offer_sale_requests from public,anon,authenticated;
create trigger pos_offer_sale_requests_immutable before update or delete on public.pos_offer_sale_requests for each row execute function public.pos_preserve_document();

alter function public.pos_record_live_order_unbound(jsonb) rename to pos_record_live_order_v1;
revoke all on function public.pos_record_live_order_v1(jsonb) from public,anon,authenticated;
create function public.pos_record_live_order_unbound(p_order jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 actor uuid:=auth.uid(); org uuid; branch uuid; device uuid; shift uuid; request_id uuid; role_name text;
 old_document public.pos_documents%rowtype; original public.pos_offer_sale_requests%rowtype; shift_row public.pos_shifts%rowtype;
 config public.pos_branch_receipt_config%rowtype; profile public.pos_merchant_profiles%rowtype; offer public.pos_offers%rowtype;
 selection jsonb; catalogue jsonb; quote jsonb; l jsonb; allocation jsonb; payment jsonb; customer jsonb;
 lines jsonb:='[]'; public_request jsonb; payments jsonb; receipt jsonb; document uuid:=gen_random_uuid(); number text; evaluated timestamptz; issued timestamptz;
 total bigint; tax bigint; paid bigint:=0; cash bigint:=0; tendered bigint; i integer;
begin
 if not (p_order ? 'offerSelection') then return public.pos_record_live_order_v1(p_order); end if;
 if actor is null then raise exception 'POS_ACCESS_DENIED'; end if;
 if jsonb_typeof(p_order) is distinct from 'object' then raise exception 'POS_INVALID_ORDER'; end if;
 if not p_order ?& array['id','branchId','deviceId','shiftId','createdAt','serviceType','lines','payments','expectedTotalFils','profileId','cashTenderedFils','customer','offerSelection']
  or p_order-array['id','branchId','deviceId','shiftId','createdAt','serviceType','lines','payments','expectedTotalFils','profileId','cashTenderedFils','customer','offerSelection']<>'{}'::jsonb then raise exception 'POS_INVALID_ORDER'; end if;
 request_id:=(p_order->>'id')::uuid; branch:=(p_order->>'branchId')::uuid; device:=(p_order->>'deviceId')::uuid; shift:=(p_order->>'shiftId')::uuid;
 if request_id is null or branch is null or device is null or shift is null then raise exception 'POS_INVALID_ORDER'; end if;
 select b.organization_id into org from public.pos_branches b where b.id=branch and b.active;
 if org is null or not public.pos_can_access(org,branch) then raise exception 'POS_ACCESS_DENIED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(request_id::text,0));
 select * into old_document from public.pos_documents d where d.order_id=request_id and d.kind='tax_invoice';
 if found then
  select * into original from public.pos_offer_sale_requests r where r.order_id=request_id;
  if not found or original.actor_id<>actor or original.organization_id<>org or original.branch_id<>branch or original.device_id<>device or original.request_payload<>p_order then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
  return jsonb_build_object('status','synced','orderId',request_id,'totalFils',old_document.snapshot#>'{totals,grossFils}','taxFils',old_document.snapshot#>'{totals,taxFils}','replayed',true,'receipt',old_document.snapshot);
 end if;
 if exists(select 1 from public.pos_orders o where o.id=request_id) then raise exception 'POS_LEGACY_RECEIPT_UNAVAILABLE'; end if;
 if jsonb_typeof(p_order->'createdAt') is distinct from 'string' or (p_order->>'createdAt')::timestamptz is null or not isfinite((p_order->>'createdAt')::timestamptz) or (p_order->>'createdAt')::timestamptz>now()+interval '1 day'
  or coalesce(p_order->>'serviceType','') not in ('dine_in','takeaway','delivery') or not public.pos_offer_integer(p_order->'expectedTotalFils',1,100000000) or not public.pos_offer_integer(p_order->'cashTenderedFils',0,100000000) then raise exception 'POS_INVALID_ORDER'; end if;
 selection:=p_order->'offerSelection';
 if jsonb_typeof(selection) is distinct from 'object' then raise exception 'POS_INVALID_OFFER'; end if;
 if not selection ?& array['offerId','expectedRevision','couponCode','expectedDiscountFils'] or selection-array['offerId','expectedRevision','couponCode','expectedDiscountFils']<>'{}'::jsonb
  or jsonb_typeof(selection->'offerId') is distinct from 'string' or selection->>'offerId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  or not public.pos_offer_integer(selection->'expectedRevision',1,2147483647) or not public.pos_offer_integer(selection->'expectedDiscountFils',1,100000000)
  or (selection->'couponCode'<>'null'::jsonb and (jsonb_typeof(selection->'couponCode') is distinct from 'string' or length(selection->>'couponCode')>32)) then raise exception 'POS_INVALID_OFFER'; end if;
 customer:=p_order->'customer';
 if customer<>'null'::jsonb then
  if jsonb_typeof(customer) is distinct from 'object' or not customer ?& array['name','address','trn'] or customer-array['name','address','trn']<>'{}'::jsonb
   or jsonb_typeof(customer->'name') is distinct from 'string' or length(trim(customer->>'name')) not between 1 and 200
   or jsonb_typeof(customer->'address') is distinct from 'string' or length(trim(customer->>'address')) not between 1 and 400
   or (customer->'trn'<>'null'::jsonb and (jsonb_typeof(customer->'trn') is distinct from 'string' or customer->>'trn' !~ '^[0-9]{15}$')) then raise exception 'POS_INVALID_CUSTOMER'; end if;
 end if;
 if jsonb_typeof(p_order->'payments') is distinct from 'array' then raise exception 'POS_INVALID_ORDER'; end if;
 if jsonb_array_length(p_order->'payments') not between 1 and 2 or (select count(distinct value->>'method') from jsonb_array_elements(p_order->'payments'))<>jsonb_array_length(p_order->'payments') then raise exception 'POS_INVALID_ORDER'; end if;
 for payment in select value from jsonb_array_elements(p_order->'payments') loop
  if jsonb_typeof(payment) is distinct from 'object' or not payment ?& array['method','amountFils'] or payment-array['method','amountFils']<>'{}'::jsonb or coalesce(payment->>'method','') not in ('cash','card') or not public.pos_offer_integer(payment->'amountFils',1,100000000) then raise exception 'POS_INVALID_ORDER'; end if;
  paid:=paid+(payment->>'amountFils')::bigint;
  if payment->>'method'='cash' then cash:=(payment->>'amountFils')::bigint; end if;
 end loop;
 tendered:=(p_order->>'cashTenderedFils')::bigint;
 if tendered<cash or (cash=0 and tendered<>0) then raise exception 'POS_PAYMENT_MISMATCH'; end if;
 select * into config from public.pos_branch_receipt_config c where c.organization_id=org and c.branch_id=branch and c.live_enabled for share;
 if not found then raise exception 'POS_PROFILE_REQUIRED'; end if;
 if config.profile_id is distinct from (p_order->>'profileId')::uuid then raise exception 'POS_PROFILE_CHANGED'; end if;
 select * into profile from public.pos_merchant_profiles p where p.id=config.profile_id;
 perform 1 from public.pos_devices d where d.id=device and d.organization_id=org and d.branch_id=branch and d.active for share;
 if not found then raise exception 'POS_DEVICE_INVALID'; end if;
 select * into shift_row from public.pos_shifts s where s.id=shift and s.organization_id=org and s.branch_id=branch and s.device_id=device for update;
 if not found or shift_row.opened_by<>actor then raise exception 'POS_SHIFT_INVALID'; end if;
 if shift_row.status<>'open' then raise exception 'POS_SHIFT_CLOSED'; end if;
 catalogue:=public.pos_offer_catalogue_lines(org,branch,p_order->'lines',true);
 select * into offer from public.pos_offers o where o.id=(selection->>'offerId')::uuid and o.organization_id=org and o.branch_id=branch for update;
 if not found then raise exception 'POS_OFFER_UNAVAILABLE'; end if;
 if offer.revision<>(selection->>'expectedRevision')::integer then raise exception 'POS_OFFER_CHANGED'; end if;
 -- Permission can change while a cashier waits for stock/offer locks. Lock and
 -- recheck the current scoped membership before authorizing the financial write.
 select s.role into role_name from public.pos_staff s where s.organization_id=org and s.user_id=actor and s.active and (s.branch_id=branch or (s.branch_id is null and s.role in ('owner','manager'))) for share;
 if not found then raise exception 'POS_ACCESS_DENIED'; end if;
 evaluated:=clock_timestamp();
 quote:=public.pos_calculate_offer(offer.definition,catalogue,evaluated,role_name,p_order->>'serviceType',selection->>'couponCode',offer.redemptions_used);
 if not (quote->>'eligible')::boolean then raise exception 'POS_OFFER_INELIGIBLE:%',quote->>'reason'; end if;
 if (quote->>'discountFils')::bigint<>(selection->>'expectedDiscountFils')::bigint then raise exception 'POS_OFFER_CHANGED'; end if;
 total:=(quote->>'grossFils')::bigint; tax:=(quote->>'taxFils')::bigint;
 if total<>(p_order->>'expectedTotalFils')::bigint then raise exception 'POS_TOTAL_MISMATCH'; end if;
 if paid<>total then raise exception 'POS_PAYMENT_MISMATCH'; end if;
 if customer='null'::jsonb and total>1000000 then raise exception 'POS_FULL_INVOICE_REQUIRED'; end if;
 public_request:=jsonb_set(p_order,'{offerSelection,couponCode}','null'::jsonb);
 insert into public.pos_orders(id,organization_id,branch_id,device_id,shift_id,created_by,client_created_at,service_type,total_fils,tax_fils,request_payload)
  values(request_id,org,branch,device,shift,actor,(p_order->>'createdAt')::timestamptz,p_order->>'serviceType',total,tax,public_request);
 insert into public.pos_offer_sale_requests(order_id,organization_id,branch_id,device_id,actor_id,request_payload) values(request_id,org,branch,device,actor,p_order);
 for i in 0..jsonb_array_length(catalogue)-1 loop
  l:=catalogue->i; allocation:=quote->'lines'->i;
  insert into public.pos_order_lines(organization_id,branch_id,order_id,product_id,product_name,quantity_milli,unit_price_fils,tax_rate_bps,gross_fils,tax_fils)
   values(org,branch,request_id,(l->>'productId')::uuid,l->>'name',(l->>'quantityMilli')::integer,(l->>'unitPriceFils')::integer,(l->>'taxRateBps')::integer,(allocation->>'grossFils')::integer,(allocation->>'taxFils')::integer);
  lines:=lines||jsonb_build_array((l-'category')||allocation||jsonb_build_object('lineNumber',i+1));
 end loop;
 for payment in select value from jsonb_array_elements(p_order->'payments') loop
  insert into public.pos_payments(organization_id,branch_id,order_id,method,amount_fils) values(org,branch,request_id,payment->>'method',(payment->>'amountFils')::integer);
 end loop;
 select jsonb_agg(value order by value->>'method') into payments from jsonb_array_elements(p_order->'payments');
 update public.pos_offers set redemptions_used=redemptions_used+1 where id=offer.id;
 insert into public.pos_offer_redemptions(order_id,organization_id,branch_id,offer_id,offer_revision,actor_id,discount_fils,redeemed_at) values(request_id,org,branch,offer.id,offer.revision,actor,(quote->>'discountFils')::integer,evaluated);
 number:=public.pos_allocate_document_number(branch,'tax_invoice'); issued:=clock_timestamp();
 receipt:=jsonb_build_object('schemaVersion',2,'id',document,'kind','tax_invoice','documentNumber',number,'issuedAt',issued,
  'merchant',public.pos_profile_snapshot(profile),'orderId',request_id,'branchId',branch,'deviceId',device,'shiftId',shift,'actorId',actor,
  'serviceType',p_order->>'serviceType','customer',customer,'lines',lines,'appliedOffer',quote,
  'totals',jsonb_build_object('beforeDiscountFils',quote->'beforeDiscountFils','discountFils',quote->'discountFils','grossFils',total,'netFils',total-tax,'taxFils',tax),
  'payments',payments,'paymentSettlement','recorded','cashTenderedFils',tendered,'changeFils',tendered-cash);
 insert into public.pos_documents(id,organization_id,branch_id,order_id,actor_id,kind,document_number,issued_at,request_payload,snapshot) values(document,org,branch,request_id,actor,'tax_invoice',number,issued,public_request,receipt);
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details) values(org,branch,actor,'sale.synced',request_id,jsonb_build_object('deviceId',device,'totalFils',total,'offerId',offer.id,'offerRevision',offer.revision,'discountFils',quote->'discountFils'));
 return jsonb_build_object('status','synced','orderId',request_id,'totalFils',total,'taxFils',tax,'replayed',false,'receipt',receipt);
exception when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then raise exception 'POS_INVALID_ORDER';
end $$;
revoke all on function public.pos_record_live_order_unbound(jsonb) from public,anon,authenticated;

-- Recovery compares the exact private v2 request. Uncommitted cancellations and all
-- v1/command behavior stay with005, under the identical transaction advisory lock.
alter function public.pos_resolve_live_request(text,jsonb,text) rename to pos_resolve_live_request_v1;
revoke all on function public.pos_resolve_live_request_v1(text,jsonb,text) from public,anon,authenticated;
create function public.pos_resolve_live_request(p_kind text,p_request jsonb,p_binding text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid; request_id uuid; original public.pos_offer_sale_requests%rowtype; invoice public.pos_documents%rowtype;
begin
 if p_kind='sale' then
  org:=public.pos_recovery_scope(p_request,p_binding); request_id:=(p_request->>'id')::uuid;
  perform pg_advisory_xact_lock(hashtextextended(request_id::text,0));
  select * into original from public.pos_offer_sale_requests r where r.order_id=request_id;
  if found then
   if original.organization_id<>org or original.branch_id<>(p_request->>'branchId')::uuid or original.device_id<>(p_request->>'deviceId')::uuid or original.actor_id<>auth.uid() or original.request_payload<>p_request then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
   select * into invoice from public.pos_documents d where d.order_id=request_id and d.kind='tax_invoice';
   if not found then raise exception 'POS_LEGACY_RECEIPT_UNAVAILABLE'; end if;
   return jsonb_build_object('status','synced','orderId',request_id,'totalFils',invoice.snapshot#>'{totals,grossFils}','taxFils',invoice.snapshot#>'{totals,taxFils}','replayed',true,'receipt',invoice.snapshot);
  end if;
 end if;
 return public.pos_resolve_live_request_v1(p_kind,p_request,p_binding);
end $$;
revoke all on function public.pos_resolve_live_request(text,jsonb,text) from public,anon;
grant execute on function public.pos_resolve_live_request(text,jsonb,text) to authenticated;
