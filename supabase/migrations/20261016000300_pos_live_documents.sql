-- Online live pilot only. No merchant values, staff identities or credentials are seeded.
-- New profile versions are appended; paid fiscal snapshots are never regenerated from current data.
create table public.pos_merchant_profiles (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, branch_id uuid not null,
  legal_name text not null check (length(trim(legal_name)) between 1 and 200),
  branch_name text not null check (length(trim(branch_name)) between 1 and 120),
  address text not null check (length(trim(address)) between 1 and 400),
  phone text not null check (length(trim(phone)) between 1 and 30),
  trn text not null check (trn ~ '^[0-9]{15}$'), tax_registered boolean not null check (tax_registered),
  currency text not null default 'AED' check (currency='AED'),
  timezone text not null default 'Asia/Dubai' check (timezone='Asia/Dubai'),
  tax_inclusive boolean not null check (tax_inclusive),
  calculation_version text not null default 'line-v2' check (calculation_version='line-v2'),
  confirmed_by uuid not null references auth.users, confirmed_at timestamptz not null default now(),
  foreign key (organization_id,branch_id) references public.pos_branches(organization_id,id),
  unique (organization_id,branch_id,id)
);
create table public.pos_branch_receipt_config (
  branch_id uuid primary key, organization_id uuid not null, profile_id uuid not null,
  series_prefix text not null check (series_prefix ~ '^[A-Z0-9]{2,16}$'),
  live_enabled boolean not null default false,
  foreign key (organization_id,branch_id,profile_id) references public.pos_merchant_profiles(organization_id,branch_id,id),
  unique (organization_id,series_prefix)
);
create table public.pos_document_counters (
  branch_id uuid not null references public.pos_branch_receipt_config,
  kind text not null check (kind in ('tax_invoice','tax_credit_note')),
  last_number bigint not null default 0 check (last_number between 0 and 9999999999),
  primary key(branch_id,kind)
);
create table public.pos_documents (
  id uuid primary key, organization_id uuid not null, branch_id uuid not null,
  order_id uuid not null, actor_id uuid not null references auth.users,
  kind text not null check (kind in ('tax_invoice','tax_credit_note')),
  document_number text not null, issued_at timestamptz not null,
  request_payload jsonb not null, snapshot jsonb not null,
  foreign key (organization_id,branch_id,order_id) references public.pos_orders(organization_id,branch_id,id),
  unique(organization_id,document_number), unique(order_id,kind),
  check (snapshot->>'id'=id::text and snapshot->>'kind'=kind and snapshot->>'documentNumber'=document_number)
);
alter table public.pos_refunds add column credit_document_id uuid references public.pos_documents;

create function public.pos_preserve_document() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'POS_IMMUTABLE_DOCUMENT'; end; $$;
revoke all on function public.pos_preserve_document() from public,anon,authenticated;
create trigger pos_profiles_immutable before update or delete on public.pos_merchant_profiles for each row execute function public.pos_preserve_document();
create trigger pos_documents_immutable before update or delete on public.pos_documents for each row execute function public.pos_preserve_document();
create function public.pos_preserve_series() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'POS_IMMUTABLE_SERIES'; end if;
  if old.branch_id<>new.branch_id or old.organization_id<>new.organization_id or old.series_prefix<>new.series_prefix then raise exception 'POS_IMMUTABLE_SERIES'; end if;
  return new;
end; $$;
revoke all on function public.pos_preserve_series() from public,anon,authenticated;
create trigger pos_receipt_series_immutable before update or delete on public.pos_branch_receipt_config for each row execute function public.pos_preserve_series();

do $$ declare t text; begin
  foreach t in array array['pos_merchant_profiles','pos_branch_receipt_config','pos_documents'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy %I on public.%I for select to authenticated using(public.pos_can_access(organization_id,branch_id))',t||'_read',t);
  end loop;
end $$;
alter table public.pos_document_counters enable row level security;
revoke all on public.pos_document_counters from public,anon,authenticated;

create function public.pos_profile_snapshot(p public.pos_merchant_profiles) returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('id',p.id,'organizationId',p.organization_id,'branchId',p.branch_id,'legalName',p.legal_name,
    'branchName',p.branch_name,'address',p.address,'phone',p.phone,'trn',p.trn,'taxRegistered',p.tax_registered,
    'currency',p.currency,'timezone',p.timezone,'taxInclusive',p.tax_inclusive,'calculationVersion',p.calculation_version,
    'confirmedBy',p.confirmed_by,'confirmedAt',p.confirmed_at);
$$;
revoke all on function public.pos_profile_snapshot(public.pos_merchant_profiles) from public,anon,authenticated;
create function public.pos_allocate_document_number(p_branch uuid,p_kind text) returns text
language plpgsql security definer set search_path='' as $$
declare v_number bigint; v_prefix text;
begin
  select series_prefix into v_prefix from public.pos_branch_receipt_config where branch_id=p_branch;
  if v_prefix is null or p_kind not in ('tax_invoice','tax_credit_note') then raise exception 'POS_PROFILE_REQUIRED'; end if;
  insert into public.pos_document_counters(branch_id,kind) values(p_branch,p_kind) on conflict do nothing;
  update public.pos_document_counters set last_number=last_number+1 where branch_id=p_branch and kind=p_kind and last_number<9999999999 returning last_number into v_number;
  if v_number is null then raise exception 'POS_NUMBER_RANGE_EXHAUSTED'; end if;
  return v_prefix||case p_kind when 'tax_invoice' then '-INV-' else '-CN-' end||lpad(v_number::text,10,'0');
end; $$;
revoke all on function public.pos_allocate_document_number(uuid,text) from public,anon,authenticated;

-- Preserve pre-pilot foundation behavior for unconfigured branches, while preventing live bypass.
alter function public.pos_record_paid_order(jsonb) rename to pos_record_paid_order_foundation;
revoke all on function public.pos_record_paid_order_foundation(jsonb) from public,anon,authenticated;
create function public.pos_record_paid_order(p_order jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.pos_branch_receipt_config where branch_id=(p_order->>'branchId')::uuid and public.pos_can_access(organization_id,branch_id)) then raise exception 'POS_LIVE_CONTRACT_REQUIRED'; end if;
  return public.pos_record_paid_order_foundation(p_order);
end; $$;
revoke all on function public.pos_record_paid_order(jsonb) from public,anon;
grant execute on function public.pos_record_paid_order(jsonb) to authenticated;
alter function public.pos_execute_command(jsonb) rename to pos_execute_command_foundation;
revoke all on function public.pos_execute_command_foundation(jsonb) from public,anon,authenticated;
create function public.pos_execute_command(p_command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if p_command->>'type'<>'subscription.update' and exists(select 1 from public.pos_branch_receipt_config where branch_id=(p_command->>'branchId')::uuid and public.pos_can_access(organization_id,branch_id)) then raise exception 'POS_LIVE_CONTRACT_REQUIRED'; end if;
  return public.pos_execute_command_foundation(p_command);
end; $$;
revoke all on function public.pos_execute_command(jsonb) from public,anon;
grant execute on function public.pos_execute_command(jsonb) to authenticated;

create function public.pos_record_live_order(p_order jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=auth.uid(); v_id uuid; v_branch uuid; v_org uuid; v_profile public.pos_merchant_profiles%rowtype;
  v_config public.pos_branch_receipt_config%rowtype; v_old public.pos_documents%rowtype;
  v_result jsonb; v_receipt jsonb; v_lines jsonb; v_payments jsonb; v_customer jsonb; v_cash bigint; v_tendered bigint;
  v_document uuid:=gen_random_uuid(); v_number text; v_issued timestamptz; v_base jsonb;
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
  v_base:=p_order-array['profileId','cashTenderedFils','customer'];
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
revoke all on function public.pos_record_live_order(jsonb) from public,anon;
grant execute on function public.pos_record_live_order(jsonb) to authenticated;

create function public.pos_execute_live_command(p_command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=auth.uid(); v_id uuid; v_branch uuid; v_org uuid; v_device uuid; v_shift uuid; v_order_id uuid; v_role text;
  v_old public.pos_command_receipts%rowtype; v_shift_row public.pos_shifts%rowtype; v_invoice public.pos_documents%rowtype;
  v_result jsonb; v_credit jsonb; v_payment jsonb; v_reason text; v_expected bigint; v_cash bigint;
  v_document uuid:=gen_random_uuid(); v_number text; v_issued timestamptz;
begin
  if v_actor is null then raise exception 'POS_ACCESS_DENIED'; end if;
  if jsonb_typeof(p_command) is distinct from 'object' then raise exception 'POS_INVALID_COMMAND'; end if;
  v_id:=(p_command->>'id')::uuid; v_branch:=(p_command->>'branchId')::uuid;
  select organization_id into v_org from public.pos_branches where id=v_branch and active;
  if v_org is null or not public.pos_can_access(v_org,v_branch) then raise exception 'POS_ACCESS_DENIED'; end if;
  if coalesce(p_command->>'type','') not in ('shift.open','shift.close','cash.move','refund.full') then raise exception 'POS_INVALID_COMMAND'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_id::text,1));
  select * into v_old from public.pos_command_receipts where id=v_id;
  if found then
    if v_old.actor_id<>v_actor or v_old.organization_id<>v_org or v_old.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT'; end if;
    return v_old.result||jsonb_build_object('replayed',true);
  end if;
  perform 1 from public.pos_branch_receipt_config where branch_id=v_branch and organization_id=v_org and live_enabled for share;
  if not found then raise exception 'POS_PROFILE_REQUIRED'; end if;
  if p_command->>'type'<>'refund.full' then return public.pos_execute_command_foundation(p_command); end if;
  if not(p_command ?& array['id','type','branchId','deviceId','shiftId','orderId','reason'])
    or (p_command-array['id','type','branchId','deviceId','shiftId','orderId','reason'])<>'{}'::jsonb then raise exception 'POS_INVALID_COMMAND'; end if;
  select role into v_role from public.pos_staff where organization_id=v_org and user_id=v_actor and active;
  if v_role not in ('manager','owner') then raise exception 'POS_MANAGER_REQUIRED'; end if;
  v_device:=(p_command->>'deviceId')::uuid; v_shift:=(p_command->>'shiftId')::uuid; v_order_id:=(p_command->>'orderId')::uuid; v_reason:=trim(p_command->>'reason');
  if v_id is null or v_device is null or v_shift is null or v_order_id is null or jsonb_typeof(p_command->'reason') is distinct from 'string' or v_reason is null or length(v_reason) not between 1 and 240 then raise exception 'POS_INVALID_COMMAND'; end if;
  perform 1 from public.pos_devices where id=v_device and organization_id=v_org and branch_id=v_branch and active for update;
  if not found then raise exception 'POS_DEVICE_INVALID'; end if;
  select * into v_shift_row from public.pos_shifts where id=v_shift and device_id=v_device and organization_id=v_org and branch_id=v_branch for update;
  if not found or v_shift_row.opened_by<>v_actor then raise exception 'POS_SHIFT_INVALID'; end if;
  if v_shift_row.status<>'open' then raise exception 'POS_SHIFT_CLOSED'; end if;
  perform 1 from public.pos_orders where id=v_order_id and organization_id=v_org and branch_id=v_branch for update;
  if not found then raise exception 'POS_ORDER_UNAVAILABLE'; end if;
  select * into v_invoice from public.pos_documents where order_id=v_order_id and kind='tax_invoice' and organization_id=v_org and branch_id=v_branch;
  if not found then raise exception 'POS_LEGACY_RECEIPT_UNAVAILABLE'; end if;
  if exists(select 1 from public.pos_refunds where order_id=v_order_id) or exists(select 1 from public.pos_documents where order_id=v_order_id and kind='tax_credit_note') then raise exception 'POS_PRIOR_REFUND_EXISTS'; end if;
  select coalesce(sum(amount_fils),0) into v_cash from public.pos_payments where order_id=v_order_id and method='cash';
  select v_shift_row.opening_cash_fils
    + coalesce((select sum(p.amount_fils) from public.pos_payments p join public.pos_orders o on o.id=p.order_id where o.shift_id=v_shift and p.method='cash'),0)
    + coalesce((select sum(amount_fils) from public.pos_cash_movements where shift_id=v_shift),0)
    - coalesce((select sum(amount_fils) from public.pos_refunds where shift_id=v_shift and method='cash'),0) into v_expected;
  if v_cash>0 and v_cash>v_expected then raise exception 'POS_INSUFFICIENT_CASH'; end if;
  v_number:=public.pos_allocate_document_number(v_branch,'tax_credit_note'); v_issued:=clock_timestamp();
  v_credit:=(v_invoice.snapshot-array['cashTenderedFils','changeFils'])||jsonb_build_object('id',v_document,'kind','tax_credit_note','documentNumber',v_number,'issuedAt',v_issued,
    'deviceId',v_device,'shiftId',v_shift,'actorId',v_actor,'reason',v_reason,
    'originalInvoice',jsonb_build_object('documentId',v_invoice.id,'documentNumber',v_invoice.document_number,'issuedAt',v_invoice.issued_at,'totalFils',v_invoice.snapshot#>'{totals,grossFils}','taxFils',v_invoice.snapshot#>'{totals,taxFils}'),
    'adjustedTotals',jsonb_build_object('grossFils',0,'netFils',0,'taxFils',0));
  insert into public.pos_documents(id,organization_id,branch_id,order_id,actor_id,kind,document_number,issued_at,request_payload,snapshot)
    values(v_document,v_org,v_branch,v_order_id,v_actor,'tax_credit_note',v_number,v_issued,p_command,v_credit);
  for v_payment in select value from jsonb_array_elements(v_invoice.snapshot->'payments') loop
    insert into public.pos_refunds(id,organization_id,branch_id,order_id,device_id,shift_id,actor_id,method,amount_fils,reason,credit_document_id)
      values(gen_random_uuid(),v_org,v_branch,v_order_id,v_device,v_shift,v_actor,v_payment->>'method',(v_payment->>'amountFils')::integer,v_reason,v_document);
  end loop;
  v_result:=jsonb_build_object('status','applied','commandId',v_id,'replayed',false,'creditNote',v_credit);
  insert into public.pos_command_receipts(id,organization_id,branch_id,actor_id,command_type,payload,result) values(v_id,v_org,v_branch,v_actor,'refund.full',p_command,v_result);
  insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details) values(v_org,v_branch,v_actor,'refund.full',v_id,jsonb_build_object('documentId',v_document,'orderId',v_order_id,'reason',v_reason));
  return v_result;
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'POS_INVALID_COMMAND';
end; $$;
revoke all on function public.pos_execute_live_command(jsonb) from public,anon;
grant execute on function public.pos_execute_live_command(jsonb) to authenticated;
