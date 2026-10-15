-- Isolated POS foundation. No live tenant/customer seed data and no legacy-table mutations.
create table public.pos_organizations (
  id uuid primary key default gen_random_uuid(), legal_name text not null,
  created_at timestamptz not null default now()
);
create table public.pos_branches (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.pos_organizations,
  name text not null, currency text not null default 'AED' check (currency = 'AED'),
  timezone text not null default 'Asia/Dubai', active boolean not null default true,
  unique (organization_id,id)
);
create table public.pos_staff (
  organization_id uuid not null references public.pos_organizations,
  user_id uuid not null references auth.users, branch_id uuid,
  role text not null check (role in ('owner','manager','cashier')), active boolean not null default true,
  primary key (organization_id,user_id),
  foreign key (organization_id,branch_id) references public.pos_branches(organization_id,id),
  check (role <> 'cashier' or branch_id is not null)
);
create table public.pos_devices (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, branch_id uuid not null,
  name text not null, active boolean not null default true,
  foreign key (organization_id,branch_id) references public.pos_branches(organization_id,id),
  unique (organization_id,branch_id,id)
);
create table public.pos_products (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, branch_id uuid not null,
  name text not null, category text not null, image_url text,
  unit text not null default 'piece' check (unit in ('piece','kg','pack')),
  unit_price_fils integer not null check (unit_price_fils between 0 and 100000000),
  tax_rate_bps integer not null default 0 check (tax_rate_bps between 0 and 10000),
  active boolean not null default true,
  foreign key (organization_id,branch_id) references public.pos_branches(organization_id,id),
  unique (organization_id,branch_id,id)
);
create table public.pos_shifts (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, branch_id uuid not null,
  device_id uuid not null, opened_by uuid not null references auth.users,
  status text not null default 'open' check (status in ('open','closed')),
  opening_cash_fils integer not null check (opening_cash_fils >= 0),
  opened_at timestamptz not null default now(), closed_at timestamptz,
  foreign key (organization_id,branch_id,device_id) references public.pos_devices(organization_id,branch_id,id),
  unique (organization_id,branch_id,device_id,id),
  check ((status = 'open' and closed_at is null) or (status = 'closed' and closed_at is not null))
);
create unique index pos_one_open_shift_per_device on public.pos_shifts(device_id) where status = 'open';
create table public.pos_orders (
  id uuid primary key, organization_id uuid not null, branch_id uuid not null, device_id uuid not null,
  shift_id uuid not null, created_by uuid not null references auth.users,
  client_created_at timestamptz not null, received_at timestamptz not null default now(),
  service_type text not null check (service_type in ('dine_in','takeaway','delivery')),
  total_fils integer not null check (total_fils > 0), tax_fils integer not null check (tax_fils >= 0),
  request_payload jsonb not null,
  foreign key (organization_id,branch_id,device_id,shift_id) references public.pos_shifts(organization_id,branch_id,device_id,id),
  unique (organization_id,branch_id,id)
);
create table public.pos_order_lines (
  id bigint generated always as identity primary key, organization_id uuid not null, branch_id uuid not null,
  order_id uuid not null, product_id uuid not null, product_name text not null,
  quantity_milli integer not null check (quantity_milli between 1 and 1000000),
  unit_price_fils integer not null, tax_rate_bps integer not null, gross_fils integer not null, tax_fils integer not null,
  foreign key (organization_id,branch_id,order_id) references public.pos_orders(organization_id,branch_id,id),
  foreign key (organization_id,branch_id,product_id) references public.pos_products(organization_id,branch_id,id)
);
create table public.pos_payments (
  id bigint generated always as identity primary key, organization_id uuid not null, branch_id uuid not null,
  order_id uuid not null, method text not null check (method in ('cash','card','other')),
  amount_fils integer not null check (amount_fils > 0),
  foreign key (organization_id,branch_id,order_id) references public.pos_orders(organization_id,branch_id,id)
);
create table public.pos_audit_events (
  id bigint generated always as identity primary key, organization_id uuid not null, branch_id uuid not null,
  actor_id uuid not null references auth.users, event_type text not null, entity_id uuid not null,
  recorded_at timestamptz not null default now(), details jsonb not null default '{}',
  foreign key (organization_id,branch_id) references public.pos_branches(organization_id,id)
);
create table public.pos_subscriptions (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, branch_id uuid not null unique,
  price_fils integer not null default 10000 check (price_fils = 10000),
  billing_period text not null default 'monthly' check (billing_period = 'monthly'),
  collection_method text not null default 'manual' check (collection_method = 'manual'),
  status text not null default 'trial' check (status in ('trial','active','past_due','cancelled')),
  paid_through date, updated_at timestamptz not null default now(),
  foreign key (organization_id,branch_id) references public.pos_branches(organization_id,id)
);

revoke all on sequence public.pos_order_lines_id_seq, public.pos_payments_id_seq, public.pos_audit_events_id_seq from public, anon, authenticated;

create function public.pos_can_access(p_organization uuid, p_branch uuid default null)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.pos_staff s where s.user_id = auth.uid()
    and s.organization_id = p_organization and s.active
    and (p_branch is null or s.branch_id = p_branch or (s.branch_id is null and s.role in ('owner','manager'))));
$$;
revoke all on function public.pos_can_access(uuid,uuid) from public, anon;
grant execute on function public.pos_can_access(uuid,uuid) to authenticated;

alter table public.pos_organizations enable row level security;
alter table public.pos_staff enable row level security;
create policy pos_org_read on public.pos_organizations for select to authenticated using (public.pos_can_access(id));
create policy pos_staff_self_read on public.pos_staff for select to authenticated using (user_id = auth.uid());
-- Clients have SELECT only. All sales writes use the atomic function below.
revoke all on public.pos_organizations, public.pos_staff from public, anon, authenticated;
grant select on public.pos_organizations, public.pos_staff to authenticated;
do $$
declare t text;
begin
  foreach t in array array['pos_branches','pos_devices','pos_products','pos_shifts','pos_orders','pos_order_lines','pos_payments','pos_audit_events','pos_subscriptions'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy %I on public.%I for select to authenticated using (public.pos_can_access(organization_id,%I))',
      t || '_read',t,case when t = 'pos_branches' then 'id' else 'branch_id' end);
  end loop;
end $$;

create function public.pos_record_paid_order(p_order jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid(); v_org uuid; v_branch uuid; v_device uuid; v_shift uuid; v_id uuid;
  v_old public.pos_orders%rowtype; v_product public.pos_products%rowtype; v_shift_row public.pos_shifts%rowtype;
  v_line jsonb; v_payment jsonb; v_qty integer; v_gross bigint; v_tax bigint;
  v_total bigint := 0; v_tax_total bigint := 0; v_paid bigint := 0; v_lines jsonb := '[]'::jsonb;
begin
  if v_user is null then raise exception 'POS_ACCESS_DENIED'; end if;
  if jsonb_typeof(p_order) is distinct from 'object'
    or not (p_order ?& array['id','branchId','deviceId','shiftId','createdAt','serviceType','lines','payments','expectedTotalFils'])
    or (p_order - array['id','branchId','deviceId','shiftId','createdAt','serviceType','lines','payments','expectedTotalFils']) <> '{}'::jsonb
    or jsonb_typeof(p_order->'lines') is distinct from 'array'
    or jsonb_typeof(p_order->'payments') is distinct from 'array'
    then raise exception 'POS_INVALID_ORDER'; end if;
  if jsonb_array_length(p_order->'lines') not between 1 and 200
    or jsonb_array_length(p_order->'payments') not between 1 and 10
    or coalesce(p_order->>'serviceType','') not in ('dine_in','takeaway','delivery')
    or coalesce(p_order->>'expectedTotalFils','') !~ '^[0-9]{1,9}$'
    then raise exception 'POS_INVALID_ORDER'; end if;
  v_id := (p_order->>'id')::uuid; v_branch := (p_order->>'branchId')::uuid;
  v_device := (p_order->>'deviceId')::uuid; v_shift := (p_order->>'shiftId')::uuid;
  if v_id is null or v_branch is null or v_device is null or v_shift is null
    or (p_order->>'createdAt')::timestamptz is null
    or (p_order->>'createdAt')::timestamptz > now() + interval '1 day'
    then raise exception 'POS_INVALID_ORDER'; end if;
  select organization_id into v_org from public.pos_branches where id = v_branch and active;
  if v_org is null or not public.pos_can_access(v_org,v_branch) then raise exception 'POS_ACCESS_DENIED'; end if;
  -- A transaction-scoped lock serializes concurrent retries of one client-generated UUID.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_id::text, 0));
  select * into v_old from public.pos_orders where id = v_id;
  if found then
    if v_old.organization_id <> v_org or v_old.branch_id <> v_branch or v_old.created_by <> v_user
      or v_old.request_payload <> p_order then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('status','synced','orderId',v_id,'totalFils',v_old.total_fils,'taxFils',v_old.tax_fils,'replayed',true);
  end if;
  perform 1 from public.pos_devices where id = v_device and organization_id = v_org and branch_id = v_branch and active for share;
  if not found then raise exception 'POS_DEVICE_INVALID'; end if;
  select * into v_shift_row from public.pos_shifts where id = v_shift and organization_id = v_org and branch_id = v_branch and device_id = v_device for update;
  if not found or v_shift_row.opened_by <> v_user then raise exception 'POS_SHIFT_INVALID'; end if;
  if v_shift_row.status <> 'open' then raise exception 'POS_SHIFT_CLOSED'; end if;
  -- Offline receipts can arrive after subscription expiry. Retaining financial history must never depend on collection state.
  for v_line in select value from jsonb_array_elements(p_order->'lines') loop
    if jsonb_typeof(v_line) is distinct from 'object'
      or not (v_line ?& array['productId','quantityMilli','expectedUnitPriceFils','expectedTaxRateBps'])
      or (v_line - array['productId','quantityMilli','expectedUnitPriceFils','expectedTaxRateBps']) <> '{}'::jsonb
      or coalesce(v_line->>'quantityMilli','') !~ '^[0-9]{1,7}$'
      or coalesce(v_line->>'expectedUnitPriceFils','') !~ '^[0-9]{1,9}$'
      or coalesce(v_line->>'expectedTaxRateBps','') !~ '^[0-9]{1,5}$'
      then raise exception 'POS_INVALID_ORDER'; end if;
    v_qty := (v_line->>'quantityMilli')::integer;
    if v_qty not between 1 and 1000000 then raise exception 'POS_INVALID_ORDER'; end if;
    select * into v_product from public.pos_products where id = (v_line->>'productId')::uuid and organization_id = v_org and branch_id = v_branch and active for share;
    if not found then raise exception 'POS_PRODUCT_UNAVAILABLE'; end if;
    if v_product.unit <> 'kg' and v_qty % 1000 <> 0 then raise exception 'POS_INVALID_ORDER'; end if;
    if v_product.unit_price_fils <> (v_line->>'expectedUnitPriceFils')::integer or v_product.tax_rate_bps <> (v_line->>'expectedTaxRateBps')::integer then raise exception 'POS_PRICE_CHANGED'; end if;
    v_gross := round(v_product.unit_price_fils::numeric * v_qty / 1000);
    v_tax := round(v_gross::numeric * v_product.tax_rate_bps / (10000 + v_product.tax_rate_bps));
    v_total := v_total + v_gross; v_tax_total := v_tax_total + v_tax;
    if v_total > 100000000 then raise exception 'POS_INVALID_ORDER'; end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('product_id',v_product.id,'name',v_product.name,'quantity',v_qty,'price',v_product.unit_price_fils,'rate',v_product.tax_rate_bps,'gross',v_gross,'tax',v_tax));
  end loop;
  if v_total <= 0 or v_total <> (p_order->>'expectedTotalFils')::bigint then raise exception 'POS_TOTAL_MISMATCH'; end if;
  for v_payment in select value from jsonb_array_elements(p_order->'payments') loop
    if jsonb_typeof(v_payment) is distinct from 'object'
      or not (v_payment ?& array['method','amountFils'])
      or (v_payment - array['method','amountFils']) <> '{}'::jsonb
      or coalesce(v_payment->>'method','') not in ('cash','card','other')
      or coalesce(v_payment->>'amountFils','') !~ '^[0-9]{1,9}$'
      then raise exception 'POS_INVALID_ORDER'; end if;
    if (v_payment->>'amountFils')::bigint not between 1 and 100000000 then raise exception 'POS_INVALID_ORDER'; end if;
    v_paid := v_paid + (v_payment->>'amountFils')::bigint;
  end loop;
  if v_paid <> v_total then raise exception 'POS_PAYMENT_MISMATCH'; end if;
  insert into public.pos_orders(id,organization_id,branch_id,device_id,shift_id,created_by,client_created_at,service_type,total_fils,tax_fils,request_payload)
    values(v_id,v_org,v_branch,v_device,v_shift,v_user,(p_order->>'createdAt')::timestamptz,p_order->>'serviceType',v_total,v_tax_total,p_order);
  for v_line in select value from jsonb_array_elements(v_lines) loop
    insert into public.pos_order_lines(organization_id,branch_id,order_id,product_id,product_name,quantity_milli,unit_price_fils,tax_rate_bps,gross_fils,tax_fils)
      values(v_org,v_branch,v_id,(v_line->>'product_id')::uuid,v_line->>'name',(v_line->>'quantity')::integer,(v_line->>'price')::integer,(v_line->>'rate')::integer,(v_line->>'gross')::integer,(v_line->>'tax')::integer);
  end loop;
  for v_payment in select value from jsonb_array_elements(p_order->'payments') loop
    insert into public.pos_payments(organization_id,branch_id,order_id,method,amount_fils) values(v_org,v_branch,v_id,v_payment->>'method',(v_payment->>'amountFils')::integer);
  end loop;
  insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details) values(v_org,v_branch,v_user,'sale.synced',v_id,jsonb_build_object('deviceId',v_device,'totalFils',v_total));
  return jsonb_build_object('status','synced','orderId',v_id,'totalFils',v_total,'taxFils',v_tax_total,'replayed',false);
exception when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
  raise exception 'POS_INVALID_ORDER';
end;
$$;
revoke all on function public.pos_record_paid_order(jsonb) from public, anon;
grant execute on function public.pos_record_paid_order(jsonb) to authenticated;
