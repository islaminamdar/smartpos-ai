-- Per-branch barcode / PLU lookup for keyboard-wedge scanners. A menu revision stays the
-- authority for price and availability; the barcode only selects that current item.
alter table public.pos_products add column barcode text;
alter table public.pos_products add constraint pos_products_barcode_format
  check (barcode is null or barcode ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');
create unique index pos_products_branch_barcode_unique
  on public.pos_products(branch_id, lower(barcode)) where barcode is not null;

-- Keep the historical catalogue command implementation private. The new wrapper accepts a
-- barcode while preserving exact command recovery, manager/device checks and media validation.
alter function public.pos_manage_catalogue(jsonb,text) rename to pos_manage_catalogue_before_barcode;
revoke all on function public.pos_manage_catalogue_before_barcode(jsonb,text) from public,anon,authenticated,service_role;

create function public.pos_manage_catalogue(p_command jsonb,p_binding text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare
  branch uuid; request uuid; product jsonb; legacy jsonb; saved public.pos_catalogue_commands%rowtype;
  barcode_value text; prior_barcode text; saved_product uuid; result jsonb;
begin
  if jsonb_typeof(p_command) is distinct from 'object' then raise exception 'POS_INVALID_COMMAND'; end if;
  branch := (p_command->>'branchId')::uuid;
  request := (p_command->>'id')::uuid;
  product := p_command->'product';
  if branch is null or request is null or jsonb_typeof(product) is distinct from 'object' then
    raise exception 'POS_INVALID_COMMAND';
  end if;

  -- Authorise before reading an idempotent result. This prevents an old command ID becoming a
  -- catalogue disclosure channel.
  perform public.pos_lock_staff_authority(branch);
  perform public.pos_staff_manager(branch,p_binding);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(request::text,8));

  select * into saved from public.pos_catalogue_commands where id=request;
  if found then
    if saved.branch_id <> branch or saved.actor_id <> auth.uid() or saved.payload <> p_command then
      raise exception 'POS_IDEMPOTENCY_CONFLICT';
    end if;
    saved_product := (saved.payload->'product'->>'id')::uuid;
    select barcode into barcode_value from public.pos_products where id=saved_product and branch_id=branch;
    return jsonb_set(saved.result, '{product,barcode}', to_jsonb(barcode_value), true)
      || jsonb_build_object('replayed',true);
  end if;

  if (select count(*) from jsonb_object_keys(p_command)) <> 6
    or not p_command ?& array['id','branchId','deviceId','expectedRevision','reason','product']
    or (select count(*) from jsonb_object_keys(product)) not in (8,9)
    or not product ?& array['id','name','category','imageUrl','unit','unitPriceFils','taxRateBps','active']
    or product - array['id','name','category','imageUrl','unit','unitPriceFils','taxRateBps','active','barcode'] <> '{}'::jsonb then
    raise exception 'POS_INVALID_COMMAND';
  end if;
  if product ? 'barcode' and product->'barcode' <> 'null'::jsonb then
    if jsonb_typeof(product->'barcode') is distinct from 'string'
      or length(trim(product->>'barcode')) not between 1 and 64
      or trim(product->>'barcode') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' then
      raise exception 'POS_INVALID_COMMAND';
    end if;
    barcode_value := lower(trim(product->>'barcode'));
  else
    barcode_value := null;
  end if;

  -- The earlier function is the established financial/menu authority. It validates every other
  -- field and atomically writes the command ledger. Strip only the new non-financial selector.
  legacy := jsonb_set(p_command, '{product}', product - 'barcode');
  result := public.pos_manage_catalogue_before_barcode(legacy,p_binding);
  saved_product := (product->>'id')::uuid;
  select barcode into prior_barcode from public.pos_products where id=saved_product and branch_id=branch for update;
  update public.pos_products set barcode=barcode_value where id=saved_product and branch_id=branch;
  result := jsonb_set(result, '{product,barcode}', to_jsonb(barcode_value), true);
  update public.pos_catalogue_commands set payload=p_command,result=result where id=request;
  insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
  select organization_id,branch_id,auth.uid(),'catalogue.barcode_updated',id,
    jsonb_build_object('beforeBarcode',prior_barcode,'barcode',barcode_value,'requestId',request)
  from public.pos_products where id=saved_product and branch_id=branch;
  return result;
exception
  when unique_violation then raise exception 'POS_BARCODE_CONFLICT';
  when invalid_text_representation or numeric_value_out_of_range then raise exception 'POS_INVALID_COMMAND';
end $$;
revoke all on function public.pos_manage_catalogue(jsonb,text) from public,anon;
grant execute on function public.pos_manage_catalogue(jsonb,text) to authenticated;
