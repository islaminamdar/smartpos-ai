-- Keep sale/refund device and shift locking in the same order.
-- Request replay, cancellation wrappers and financial calculations are unchanged.
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
  -- All financial paths acquire device before shift. Refunds take an exclusive
  -- device lock, so taking shift first would invert their order and permit deadlock.
  perform 1 from public.pos_devices where id=(p_order->>'deviceId')::uuid and organization_id=v_org and branch_id=v_branch and active for share;
  if not found then raise exception 'POS_DEVICE_INVALID'; end if;
  perform 1 from public.pos_shifts where id=(p_order->>'shiftId')::uuid and organization_id=v_org and branch_id=v_branch and device_id=(p_order->>'deviceId')::uuid and opened_by=v_actor for update;
  if jsonb_typeof(p_order->'lines') is distinct from 'array' then raise exception 'POS_INVALID_ORDER'; end if;
  -- Lock products in stable identity order; the request and receipt keep their
  -- existing line order. The foundation reuses these locks during its own checks.
  for v_line in select value from jsonb_array_elements(p_order->'lines') order by (value->>'productId')::uuid loop
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
