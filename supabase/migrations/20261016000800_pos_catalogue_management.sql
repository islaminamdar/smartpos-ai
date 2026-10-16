-- Manager catalogue changes are versioned and auditable; receipts retain their own snapshots.
alter table public.pos_products add column revision integer not null default 1 check(revision > 0);
create table public.pos_catalogue_commands (
 id uuid primary key, organization_id uuid not null, branch_id uuid not null, actor_id uuid not null references auth.users,
 device_id uuid not null, payload jsonb not null, result jsonb not null, created_at timestamptz not null default now(),
 foreign key(organization_id,branch_id,device_id) references public.pos_devices(organization_id,branch_id,id)
);
alter table public.pos_catalogue_commands enable row level security;
revoke all on public.pos_catalogue_commands from public,anon,authenticated;

create function public.pos_manage_catalogue(p_command jsonb,p_binding text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 v_actor uuid:=auth.uid(); v_id uuid; v_branch uuid; v_org uuid; v_device jsonb; v_item jsonb;
 v_product_id uuid; v_before public.pos_products%rowtype; v_after public.pos_products%rowtype;
 v_old public.pos_catalogue_commands%rowtype; v_revision integer; v_price integer; v_active boolean; v_result jsonb;
begin
 if v_actor is null or jsonb_typeof(p_command) is distinct from 'object' then raise exception 'POS_ACCESS_DENIED'; end if;
 if (select count(*) from jsonb_object_keys(p_command))<>6 or not p_command ?& array['id','branchId','deviceId','expectedRevision','reason','product'] then raise exception 'POS_INVALID_COMMAND'; end if;
 v_id:=(p_command->>'id')::uuid; v_branch:=(p_command->>'branchId')::uuid;
 if v_id is null or v_branch is null then raise exception 'POS_INVALID_COMMAND'; end if;
 v_device:=public.pos_bound_device(p_binding);
 if v_device is null or v_device->>'id' is distinct from p_command->>'deviceId' or v_device->>'branchId' is distinct from p_command->>'branchId' then raise exception 'POS_DEVICE_INVALID'; end if;
 select organization_id into v_org from public.pos_branches where id=v_branch and active;
 if v_org is null or not public.pos_can_access(v_org,v_branch) or not exists(select 1 from public.pos_staff where organization_id=v_org and user_id=v_actor and active and role in ('owner','manager') and (branch_id is null or branch_id=v_branch)) then raise exception 'POS_ACCESS_DENIED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_id::text,8));
 select * into v_old from public.pos_catalogue_commands where id=v_id;
 if found then
   if v_old.actor_id<>v_actor or v_old.branch_id<>v_branch or v_old.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
   return v_old.result || '{"replayed":true}'::jsonb;
 end if;
 v_item:=p_command->'product';
 if jsonb_typeof(v_item) is distinct from 'object' then raise exception 'POS_INVALID_COMMAND'; end if;
 if (select count(*) from jsonb_object_keys(v_item))<>8 or not v_item ?& array['id','name','category','imageUrl','unit','unitPriceFils','taxRateBps','active'] then raise exception 'POS_INVALID_COMMAND'; end if;
 if jsonb_typeof(p_command->'reason') is distinct from 'string' or length(trim(p_command->>'reason')) not between 1 and 240
   or jsonb_typeof(v_item->'name') is distinct from 'string' or length(trim(v_item->>'name')) not between 1 and 200
   or jsonb_typeof(v_item->'category') is distinct from 'string' or length(trim(v_item->>'category')) not between 1 and 120
   or (v_item->>'unit') not in ('piece','pack','kg') or jsonb_typeof(v_item->'unit') is distinct from 'string'
   or jsonb_typeof(v_item->'active') is distinct from 'boolean'
   or (v_item->'imageUrl'<>'null'::jsonb and (jsonb_typeof(v_item->'imageUrl') is distinct from 'string' or v_item->>'imageUrl' !~ '^/pos-assets/menu/[A-Za-z0-9_-]+\.webp$'))
   or jsonb_typeof(v_item->'unitPriceFils') is distinct from 'number' or (v_item->>'unitPriceFils')::numeric <> trunc((v_item->>'unitPriceFils')::numeric)
   or (v_item->>'unitPriceFils')::numeric not between 0 and 100000000
   or jsonb_typeof(v_item->'taxRateBps') is distinct from 'number' or (v_item->>'taxRateBps')::numeric<>500
   or jsonb_typeof(p_command->'expectedRevision') is distinct from 'number' or (p_command->>'expectedRevision')::numeric<>trunc((p_command->>'expectedRevision')::numeric)
   or (p_command->>'expectedRevision')::numeric not between 0 and 2147483646 then raise exception 'POS_INVALID_COMMAND'; end if;
 v_product_id:=(v_item->>'id')::uuid; v_revision:=(p_command->>'expectedRevision')::integer;
 v_price:=(v_item->>'unitPriceFils')::integer; v_active:=(v_item->>'active')::boolean;
 if v_product_id is null or (v_active and v_price=0) then raise exception 'POS_INVALID_COMMAND'; end if;
 if not exists(select 1 from public.pos_branch_receipt_config c join public.pos_merchant_profiles p on p.id=c.profile_id where c.branch_id=v_branch and p.tax_registered and p.tax_inclusive) then raise exception 'POS_PROFILE_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_product_id::text,9));
 select * into v_before from public.pos_products where id=v_product_id for update;
 if found then
   if v_before.organization_id<>v_org or v_before.branch_id<>v_branch then raise exception 'POS_ACCESS_DENIED'; end if;
   if v_before.revision<>v_revision then raise exception 'POS_CATALOGUE_CONFLICT'; end if;
   update public.pos_products set name=trim(v_item->>'name'),category=trim(v_item->>'category'),image_url=v_item->>'imageUrl',unit=v_item->>'unit',
     unit_price_fils=v_price,tax_rate_bps=500,active=v_active,revision=revision+1 where id=v_product_id returning * into v_after;
 else
   if v_revision<>0 then raise exception 'POS_CATALOGUE_CONFLICT'; end if;
   insert into public.pos_products(id,organization_id,branch_id,name,category,image_url,unit,unit_price_fils,tax_rate_bps,active)
   values(v_product_id,v_org,v_branch,trim(v_item->>'name'),trim(v_item->>'category'),v_item->>'imageUrl',v_item->>'unit',v_price,500,v_active) returning * into v_after;
 end if;
 v_result:=jsonb_build_object('status','updated','requestId',v_id,'replayed',false,'product',jsonb_build_object('id',v_after.id,'branchId',v_branch,'name',v_after.name,'category',v_after.category,'imageUrl',v_after.image_url,'unit',v_after.unit,'unitPriceFils',v_after.unit_price_fils,'taxRateBps',v_after.tax_rate_bps,'active',v_after.active,'revision',v_after.revision));
 insert into public.pos_catalogue_commands(id,organization_id,branch_id,actor_id,device_id,payload,result) values(v_id,v_org,v_branch,v_actor,(v_device->>'id')::uuid,p_command,v_result);
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details) values(v_org,v_branch,v_actor,'catalogue.updated',v_product_id,jsonb_build_object('reason',trim(p_command->>'reason'),'before',case when v_before.id is null then null else to_jsonb(v_before) end,'after',to_jsonb(v_after),'requestId',v_id));
 return v_result;
end $$;
revoke all on function public.pos_manage_catalogue(jsonb,text) from public,anon;
grant execute on function public.pos_manage_catalogue(jsonb,text) to authenticated;

-- Extend the existing immutable invoice writer. Its private ACL remains unchanged.
create or replace function public.pos_record_live_order_unbound(p_order jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=auth.uid(); v_id uuid; v_branch uuid; v_org uuid; v_profile public.pos_merchant_profiles%rowtype;
  v_config public.pos_branch_receipt_config%rowtype; v_old public.pos_documents%rowtype;
  v_result jsonb; v_receipt jsonb; v_lines jsonb; v_payments jsonb; v_customer jsonb; v_cash bigint; v_tendered bigint;
  v_line jsonb; v_product public.pos_products%rowtype; v_document uuid:=gen_random_uuid(); v_number text; v_issued timestamptz; v_base jsonb;
begin
  if v_actor is null then raise exception 'POS_ACCESS_DENIED'; end if;
  if jsonb_typeof(p_order) is distinct from 'object'
    or not(p_order ?& array['id','branchId','deviceId','shiftId','createdAt','serviceType','lines','payments','expectedTotalFils','profileId','cashTenderedFils','customer'])
    or (p_order-array['id','branchId','deviceId','shiftId','createdAt','serviceType','lines','payments','expectedTotalFils','profileId','cashTenderedFils','customer'])<>'{}'::jsonb
    then raise exception 'POS_INVALID_ORDER'; end if;
  v_id:=(p_order->>'id')::uuid; v_branch:=(p_order->>'branchId')::uuid;
  select organization_id into v_org from public.pos_branches where id=v_branch and active;
  if v_org is null or not public.pos_can_access(v_org,v_branch) then raise exception 'POS_ACCESS_DENIED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_id::text,0));
  select * into v_old from public.pos_documents where order_id=v_id and kind='tax_invoice';
  if found then
    if v_old.organization_id<>v_org or v_old.branch_id<>v_branch or v_old.actor_id<>v_actor or v_old.request_payload<>p_order then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('status','synced','orderId',v_id,'totalFils',v_old.snapshot#>'{totals,grossFils}','taxFils',v_old.snapshot#>'{totals,taxFils}','replayed',true,'receipt',v_old.snapshot);
  end if;
  if exists(select 1 from public.pos_orders where id=v_id) then raise exception 'POS_LEGACY_RECEIPT_UNAVAILABLE'; end if;
  select * into v_config from public.pos_branch_receipt_config where branch_id=v_branch and organization_id=v_org and live_enabled for share;
  if not found then raise exception 'POS_PROFILE_REQUIRED'; end if;
  if v_config.profile_id is distinct from (p_order->>'profileId')::uuid then raise exception 'POS_PROFILE_CHANGED'; end if;
  select * into v_profile from public.pos_merchant_profiles where id=v_config.profile_id;
  if jsonb_typeof(p_order->'cashTenderedFils') is distinct from 'number' or coalesce(p_order->>'cashTenderedFils','')!~'^[0-9]{1,9}$' or (p_order->>'cashTenderedFils')::bigint>100000000 then raise exception 'POS_INVALID_ORDER'; end if;
  v_tendered:=(p_order->>'cashTenderedFils')::bigint; v_customer:=p_order->'customer';
  if v_customer<>'null'::jsonb then
    if jsonb_typeof(v_customer) is distinct from 'object' or not(v_customer ?& array['name','address','trn']) or (v_customer-array['name','address','trn'])<>'{}'::jsonb
      or jsonb_typeof(v_customer->'name') is distinct from 'string' or length(trim(v_customer->>'name')) not between 1 and 200
      or jsonb_typeof(v_customer->'address') is distinct from 'string' or length(trim(v_customer->>'address')) not between 1 and 400
      or (v_customer->'trn'<>'null'::jsonb and (jsonb_typeof(v_customer->'trn') is distinct from 'string' or v_customer->>'trn'!~'^[0-9]{15}$')) then raise exception 'POS_INVALID_CUSTOMER'; end if;
  end if;
  if jsonb_typeof(p_order->'payments') is distinct from 'array' or jsonb_array_length(p_order->'payments') not between 1 and 2 then raise exception 'POS_INVALID_ORDER'; end if;
  if exists(select 1 from jsonb_array_elements(p_order->'payments') p where coalesce(p->>'method','') not in ('cash','card'))
    or (select count(distinct p->>'method') from jsonb_array_elements(p_order->'payments') p)<>jsonb_array_length(p_order->'payments') then raise exception 'POS_INVALID_ORDER'; end if;
  -- Serialize with shifts before product locks, matching the foundation lock order.
  perform 1 from public.pos_shifts where id=(p_order->>'shiftId')::uuid and organization_id=v_org and branch_id=v_branch and device_id=(p_order->>'deviceId')::uuid and opened_by=v_actor for update;
  if jsonb_typeof(p_order->'lines') is distinct from 'array' then raise exception 'POS_INVALID_ORDER'; end if;
  for v_line in select value from jsonb_array_elements(p_order->'lines') loop
    select * into v_product from public.pos_products where id=(v_line->>'productId')::uuid and organization_id=v_org and branch_id=v_branch and active for share;
    if not found then raise exception 'POS_PRODUCT_UNAVAILABLE'; end if;
    if v_line ? 'expectedRevision' then
      if jsonb_typeof(v_line->'expectedRevision') is distinct from 'number' or coalesce(v_line->>'expectedRevision','') !~ '^[0-9]{1,10}$' then raise exception 'POS_INVALID_ORDER'; end if;
      if (v_line->>'expectedRevision')::bigint<>v_product.revision then raise exception 'POS_PRICE_CHANGED'; end if;
    elsif v_product.revision<>1 then
      -- Old clients may retry immutable paid receipts above. A new sale of an edited
      -- item needs a fresh menu, including unit/name/availability, not just its price.
      raise exception 'POS_PRICE_CHANGED';
    end if;
  end loop;
  v_base:=p_order-array['profileId','cashTenderedFils','customer'];
  v_base:=jsonb_set(v_base,'{lines}',(select coalesce(jsonb_agg(value-'expectedRevision'),'[]'::jsonb) from jsonb_array_elements(p_order->'lines')));
  v_result:=public.pos_record_paid_order_foundation(v_base);
  if v_customer='null'::jsonb and (v_result->>'totalFils')::bigint>1000000 then raise exception 'POS_FULL_INVOICE_REQUIRED'; end if;
  select coalesce(sum(amount_fils),0) into v_cash from public.pos_payments where order_id=v_id and method='cash';
  if v_tendered<v_cash or (v_cash=0 and v_tendered<>0) then raise exception 'POS_PAYMENT_MISMATCH'; end if;
  select jsonb_agg(jsonb_build_object('lineNumber',line_number,'productId',product_id,'name',product_name,'unit',unit,
    'quantityMilli',quantity_milli,'unitPriceFils',unit_price_fils,'taxRateBps',tax_rate_bps,'grossFils',gross_fils,'netFils',gross_fils-tax_fils,'taxFils',tax_fils) order by line_number)
    into v_lines from (select row_number() over(order by l.id) line_number,l.*,p.unit from public.pos_order_lines l join public.pos_products p on p.id=l.product_id where l.order_id=v_id) x;
  select jsonb_agg(jsonb_build_object('method',method,'amountFils',amount_fils) order by method) into v_payments from public.pos_payments where order_id=v_id;
  v_number:=public.pos_allocate_document_number(v_branch,'tax_invoice'); v_issued:=clock_timestamp();
  v_receipt:=jsonb_build_object('schemaVersion',1,'id',v_document,'kind','tax_invoice','documentNumber',v_number,'issuedAt',v_issued,
    'merchant',public.pos_profile_snapshot(v_profile),'orderId',v_id,'branchId',v_branch,'deviceId',p_order->>'deviceId','shiftId',p_order->>'shiftId','actorId',v_actor,
    'serviceType',p_order->>'serviceType','customer',v_customer,'lines',v_lines,
    'totals',jsonb_build_object('grossFils',v_result->'totalFils','netFils',(v_result->>'totalFils')::bigint-(v_result->>'taxFils')::bigint,'taxFils',v_result->'taxFils'),
    'payments',v_payments,'paymentSettlement','recorded','cashTenderedFils',v_tendered,'changeFils',v_tendered-v_cash);
  insert into public.pos_documents(id,organization_id,branch_id,order_id,actor_id,kind,document_number,issued_at,request_payload,snapshot)
    values(v_document,v_org,v_branch,v_id,v_actor,'tax_invoice',v_number,v_issued,p_order,v_receipt);
  return v_result||jsonb_build_object('receipt',v_receipt);
exception when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then raise exception 'POS_INVALID_ORDER';
end; $$;
revoke all on function public.pos_record_live_order_unbound(jsonb) from public,anon,authenticated;
