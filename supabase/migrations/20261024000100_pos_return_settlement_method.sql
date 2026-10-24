-- Version 4 return settlement: a manager selects cash or bank transfer. Bank transfer is
-- recorded as refunded but never changes the POS drawer. Existing v1-v3 documents remain valid.
alter table public.pos_refunds drop constraint if exists pos_refunds_method_check;
alter table public.pos_refunds add constraint pos_refunds_method_check check (method in ('cash','card','other','bank_transfer'));

create or replace function public.pos_return_state_locked(p_org uuid,p_branch uuid,p_order uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare inv public.pos_documents;credit public.pos_documents;v jsonb;l jsonb;r jsonb;a jsonb;
 quantities bigint[];n integer;i integer;j integer;revision integer:=0;previous_line integer;
 before_q bigint;after_q bigint;dn bigint;dt bigint;dd bigint;total_n bigint:=0;total_t bigint:=0;total_d bigint:=0;
 returned_n bigint:=0;returned_t bigint:=0;returned_d bigint:=0;credit_n bigint;credit_t bigint;credit_d bigint;
 returned jsonb:='[]';remaining jsonb;payments jsonb;actual jsonb;all_returned boolean;
begin
 select * into inv from public.pos_documents where order_id=p_order and kind='tax_invoice' and organization_id=p_org and branch_id=p_branch;
 if not found or inv.snapshot->>'schemaVersion' not in ('1','2') then raise exception 'POS_RETURN_UNAVAILABLE';end if;
 v:=inv.snapshot;n:=jsonb_array_length(v->'lines');if n not between 1 and 200 then raise exception 'POS_RETURN_UNAVAILABLE';end if;quantities:=array_fill(0::bigint,array[n]);
 for i in 1..n loop
  l:=v->'lines'->(i-1);
  if public.pos_return_integer(l->'lineNumber',1,200)<>i or l->>'unit' not in ('piece','pack','kg')
   or (l->>'unit'<>'kg' and public.pos_return_integer(l->'quantityMilli',1,1000000)%1000<>0) then raise exception 'POS_RETURN_UNAVAILABLE';end if;
  a:=public.pos_return_delta(l,0,public.pos_return_integer(l->'quantityMilli',1,1000000));
  if a->'grossFils' is distinct from l->'grossFils' or (v->>'schemaVersion'='2' and (a->'beforeDiscountFils' is distinct from l->'beforeDiscountFils' or a->'discountFils' is distinct from l->'discountFils')) then raise exception 'POS_RETURN_UNAVAILABLE';end if;
  total_n:=total_n+(a->>'netFils')::bigint;total_t:=total_t+(a->>'taxFils')::bigint;total_d:=total_d+(a->>'discountFils')::bigint;
 end loop;
 if total_n+total_t not between 1 and 100000000 or (v#>>'{totals,grossFils}')::bigint<>total_n+total_t
  or (v#>>'{totals,netFils}')::bigint<>total_n or (v#>>'{totals,taxFils}')::bigint<>total_t
  or (v->>'schemaVersion'='2' and ((v#>>'{totals,discountFils}')::bigint<>total_d or (v#>>'{totals,beforeDiscountFils}')::bigint<>total_n+total_t+total_d)) then raise exception 'POS_RETURN_UNAVAILABLE';end if;
 select coalesce(jsonb_agg(p order by p->>'method'),'[]') into actual from jsonb_array_elements(v->'payments') p;
 select coalesce(jsonb_agg(p order by p->>'method'),'[]') into payments from jsonb_array_elements(public.pos_return_payments(v,total_n+total_t)) p;
 if actual<>payments then raise exception 'POS_RETURN_UNAVAILABLE';end if;
 if exists(select 1 from public.pos_refunds f left join public.pos_documents d on d.id=f.credit_document_id and d.order_id=f.order_id and d.kind='tax_credit_note' and d.organization_id=f.organization_id and d.branch_id=f.branch_id where f.order_id=p_order and d.id is null) then raise exception 'POS_RETURN_UNAVAILABLE';end if;
 for credit in select * from public.pos_documents where order_id=p_order and kind='tax_credit_note' order by coalesce((snapshot->>'returnRevision')::integer,0),id loop
  revision:=revision+1;if revision>=2147483647 or credit.organization_id<>p_org or credit.branch_id<>p_branch then raise exception 'POS_RETURN_UNAVAILABLE';end if;
  remaining:=public.pos_return_amounts(total_n-returned_n,total_t-returned_t,total_d-returned_d);
  if credit.snapshot#>>'{originalInvoice,documentId}' is distinct from inv.id::text then raise exception 'POS_RETURN_UNAVAILABLE';end if;
  if credit.snapshot->>'schemaVersion' in ('1','2') then
   if revision<>1 or credit.snapshot->'lines' is distinct from v->'lines' or credit.snapshot->'totals' is distinct from v->'totals' then raise exception 'POS_RETURN_UNAVAILABLE';end if;
   for i in 1..n loop quantities[i]:=(v->'lines'->(i-1)->>'quantityMilli')::bigint;end loop;
   credit_n:=total_n;credit_t:=total_t;credit_d:=total_d;
  elsif credit.snapshot->>'schemaVersion' in ('3','4') then
   if public.pos_return_integer(credit.snapshot->'returnRevision',1,2147483646)<>revision or credit.snapshot->'previousAdjustedTotals' is distinct from remaining then raise exception 'POS_RETURN_UNAVAILABLE';end if;
   credit_n:=0;credit_t:=0;credit_d:=0;j:=0;previous_line:=0;
   for r in select value from jsonb_array_elements(credit.snapshot->'lines') loop
    j:=j+1;i:=public.pos_return_integer(r->'originalLineNumber',1,n)::integer;l:=v->'lines'->(i-1);
    before_q:=public.pos_return_integer(r->'returnedBeforeQuantityMilli',0,1000000);after_q:=public.pos_return_integer(r->'returnedAfterQuantityMilli',1,1000000);
    if i<=previous_line or public.pos_return_integer(r->'lineNumber',1,200)<>j or r->'originalLine' is distinct from l or before_q<>quantities[i]
     or after_q-before_q<>public.pos_return_integer(r->'quantityMilli',1,1000000) or (l->>'unit'<>'kg' and (after_q-before_q)%1000<>0) then raise exception 'POS_RETURN_UNAVAILABLE';end if;
    a:=public.pos_return_delta(l,before_q,after_q);
    if (select jsonb_object_agg(k,r->k) from unnest(array['netFils','taxFils','grossFils','beforeDiscountFils','discountFils']) k) is distinct from a then raise exception 'POS_RETURN_UNAVAILABLE';end if;
    quantities[i]:=after_q;previous_line:=i;credit_n:=credit_n+(a->>'netFils')::bigint;credit_t:=credit_t+(a->>'taxFils')::bigint;credit_d:=credit_d+(a->>'discountFils')::bigint;
   end loop;
   if j not between 1 and 200 or credit.snapshot->'totals' is distinct from public.pos_return_amounts(credit_n,credit_t,credit_d) then raise exception 'POS_RETURN_UNAVAILABLE';end if;
  else raise exception 'POS_RETURN_UNAVAILABLE';end if;
  -- Legacy credits retain tender allocation from their original invoice. Version 4 records
  -- the manager-selected refund route. In both cases the immutable snapshot must match the ledger.
  if credit.snapshot->>'schemaVersion' in ('1','2','3') then
   select coalesce(jsonb_agg(jsonb_build_object('method',method,'amountFils',amount) order by method),'[]') into payments from (
    select method,sum(amount) amount from (
     select p->>'method' method,(p->>'amountFils')::bigint amount from jsonb_array_elements(public.pos_return_payments(v,returned_n+returned_t+credit_n+credit_t)) p
     union all select p->>'method',-(p->>'amountFils')::bigint from jsonb_array_elements(public.pos_return_payments(v,returned_n+returned_t)) p
    ) x group by method having sum(amount)>0
   ) x;
  else
   select coalesce(jsonb_agg(p order by p->>'method'),'[]') into payments from jsonb_array_elements(credit.snapshot->'payments') p;
   if (credit_n+credit_t=0 and jsonb_array_length(payments)<>0)
    or (credit_n+credit_t>0 and (jsonb_array_length(payments)<>1 or payments->0->>'method' not in ('cash','bank_transfer')
      or public.pos_return_integer(payments->0->'amountFils',1,100000000)<>credit_n+credit_t)) then raise exception 'POS_RETURN_UNAVAILABLE';end if;
  end if;
  select coalesce(jsonb_agg(p order by p->>'method'),'[]') into actual from jsonb_array_elements(credit.snapshot->'payments') p;
  if actual<>payments then raise exception 'POS_RETURN_UNAVAILABLE';end if;
  select coalesce(jsonb_agg(jsonb_build_object('method',method,'amountFils',amount_fils) order by method),'[]') into actual from public.pos_refunds where credit_document_id=credit.id and order_id=p_order and organization_id=p_org and branch_id=p_branch;
  if actual<>payments then raise exception 'POS_RETURN_UNAVAILABLE';end if;
  returned_n:=returned_n+credit_n;returned_t:=returned_t+credit_t;returned_d:=returned_d+credit_d;
  all_returned:=true;for i in 1..n loop if quantities[i]<>(v->'lines'->(i-1)->>'quantityMilli')::bigint then all_returned:=false;end if;end loop;
  if credit.snapshot->>'schemaVersion' in ('3','4') and (credit.snapshot->'adjustedTotals' is distinct from public.pos_return_amounts(total_n-returned_n,total_t-returned_t,total_d-returned_d) or credit.snapshot->'fullyReturned' is distinct from to_jsonb(all_returned)) then raise exception 'POS_RETURN_UNAVAILABLE';end if;
 end loop;
 all_returned:=true;for i in 1..n loop
  returned:=returned||jsonb_build_array(jsonb_build_object('lineNumber',i,'quantityMilli',quantities[i]));if quantities[i]<>(v->'lines'->(i-1)->>'quantityMilli')::bigint then all_returned:=false;end if;
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('method',method,'amountFils',amount) order by method),'[]') into payments from (
  select method,sum(amount_fils) amount from public.pos_refunds where organization_id=p_org and branch_id=p_branch and order_id=p_order group by method
 ) q;
 return jsonb_build_object('schemaVersion',1,'invoice',v,'revision',revision,'returned',returned,'refundedPayments',payments,
  'adjustedTotals',public.pos_return_amounts(total_n-returned_n,total_t-returned_t,total_d-returned_d),'fullyReturned',all_returned);
exception when invalid_text_representation or numeric_value_out_of_range or division_by_zero or null_value_not_allowed then raise exception 'POS_RETURN_UNAVAILABLE';
end $$;


create or replace function public.pos_preview_return(p_request jsonb,p_binding text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid;branch uuid;device uuid;shift uuid;ord uuid;invoice uuid;rev bigint;state jsonb;v jsonb;selection jsonb;l jsonb;allocation jsonb;line jsonb;
 lines jsonb:='[]';payments jsonb;result jsonb;reason text;refund_method text;i integer;j integer:=0;prior_i integer:=0;q bigint;before_q bigint;after_q bigint;
 total_n bigint:=0;total_t bigint:=0;total_d bigint:=0;all_returned boolean:=true;remaining jsonb;expected bigint;cash bigint;returned_before bigint;
begin
 if jsonb_typeof(p_request) is distinct from 'object' or not(p_request ?& array['branchId','deviceId','shiftId','orderId','invoiceId','expectedRevision','lines','reason','refundMethod'])
  or p_request-array['branchId','deviceId','shiftId','orderId','invoiceId','expectedRevision','lines','reason','refundMethod']<>'{}' then raise exception 'POS_INVALID_COMMAND';end if;
 branch:=public.pos_return_uuid(p_request->'branchId');device:=public.pos_return_uuid(p_request->'deviceId');shift:=public.pos_return_uuid(p_request->'shiftId');ord:=public.pos_return_uuid(p_request->'orderId');invoice:=public.pos_return_uuid(p_request->'invoiceId');rev:=public.pos_return_integer(p_request->'expectedRevision',0,2147483645);
 reason:=p_request->>'reason';if jsonb_typeof(p_request->'reason') is distinct from 'string' or reason<>btrim(reason) or length(reason) not between 1 and 240 then raise exception 'POS_INVALID_COMMAND';end if;
 refund_method:=p_request->>'refundMethod';if jsonb_typeof(p_request->'refundMethod') is distinct from 'string' or refund_method not in ('cash','bank_transfer') then raise exception 'POS_INVALID_COMMAND';end if;
 if jsonb_typeof(p_request->'lines') is distinct from 'array' or jsonb_array_length(p_request->'lines') not between 1 and 200 then raise exception 'POS_RETURN_QUANTITY';end if;
 org:=public.pos_return_context(branch,device,ord,shift,p_binding);state:=public.pos_return_state_locked(org,branch,ord);v:=state->'invoice';
 if v->>'id'<>invoice::text or (state->>'revision')::bigint<>rev then raise exception 'POS_RETURN_STALE';end if;
 for selection in select value from jsonb_array_elements(p_request->'lines') loop
  if jsonb_typeof(selection) is distinct from 'object' or not(selection ?& array['lineNumber','quantityMilli']) or selection-array['lineNumber','quantityMilli']<>'{}' then raise exception 'POS_RETURN_QUANTITY';end if;
  begin i:=public.pos_return_integer(selection->'lineNumber',1,jsonb_array_length(v->'lines'))::integer;q:=public.pos_return_integer(selection->'quantityMilli',1,1000000);exception when raise_exception then raise exception 'POS_RETURN_QUANTITY';end;
  if i<=prior_i then raise exception 'POS_RETURN_QUANTITY';end if;prior_i:=i;j:=j+1;l:=v->'lines'->(i-1);before_q:=(state->'returned'->(i-1)->>'quantityMilli')::bigint;after_q:=before_q+q;
  if (l->>'unit'<>'kg' and q%1000<>0) or after_q>(l->>'quantityMilli')::bigint then raise exception 'POS_RETURN_QUANTITY';end if;
  allocation:=public.pos_return_delta(l,before_q,after_q);
  line:=jsonb_build_object('lineNumber',j,'originalLineNumber',i,'productId',l->'productId','name',l->'name','unit',l->'unit','unitPriceFils',l->'unitPriceFils','taxRateBps',l->'taxRateBps','quantityMilli',q,
   'returnedBeforeQuantityMilli',before_q,'returnedAfterQuantityMilli',after_q,'originalLine',l)||allocation;
  lines:=lines||jsonb_build_array(line);total_n:=total_n+(allocation->>'netFils')::bigint;total_t:=total_t+(allocation->>'taxFils')::bigint;total_d:=total_d+(allocation->>'discountFils')::bigint;
 end loop;
 for i in 1..jsonb_array_length(v->'lines') loop
  select coalesce(sum((s->>'quantityMilli')::bigint),0) into q from jsonb_array_elements(p_request->'lines') s where (s->>'lineNumber')::integer=i;
  if (state->'returned'->(i-1)->>'quantityMilli')::bigint+q<>(v->'lines'->(i-1)->>'quantityMilli')::bigint then all_returned:=false;end if;
 end loop;
 remaining:=state->'adjustedTotals';
 payments:=case when total_n+total_t=0 then '[]'::jsonb else jsonb_build_array(jsonb_build_object('method',refund_method,'amountFils',total_n+total_t)) end;
 cash:=case when refund_method='cash' then total_n+total_t else 0 end;
 select s.opening_cash_fils+coalesce((select sum(p.amount_fils) from public.pos_payments p join public.pos_orders o on o.id=p.order_id where o.shift_id=shift and p.method='cash'),0)
  +coalesce((select sum(amount_fils) from public.pos_cash_movements where shift_id=shift),0)-coalesce((select sum(amount_fils) from public.pos_refunds where shift_id=shift and method='cash'),0)
  into expected from public.pos_shifts s where s.id=shift;
 if cash>0 and cash>expected then raise exception 'POS_INSUFFICIENT_CASH';end if;
 result:=jsonb_build_object('schemaVersion',1,'branchId',branch,'deviceId',device,'shiftId',shift,'orderId',ord,'invoiceId',invoice,'expectedRevision',rev,'reason',reason,'lines',lines,
  'previousAdjustedTotals',remaining,'totals',public.pos_return_amounts(total_n,total_t,total_d),
  'adjustedTotals',public.pos_return_amounts((remaining->>'netFils')::bigint-total_n,(remaining->>'taxFils')::bigint-total_t,(remaining->>'discountFils')::bigint-total_d),'payments',payments,'fullyReturned',all_returned);
 return result||jsonb_build_object('quoteHash',encode(sha256(convert_to(public.pos_offline_canonical(result),'UTF8')),'hex'));
end $$;


create or replace function public.pos_execute_live_command(p_command jsonb,p_binding text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid;request uuid;branch uuid;preview jsonb;state jsonb;inv jsonb;credit jsonb;result jsonb;p jsonb;prior public.pos_command_receipts;
 document uuid:=gen_random_uuid();number text;issued timestamptz;payload jsonb;
begin
 if p_command->>'type' is distinct from 'refund.items' then return public.pos_execute_live_command_before_item_returns_bound(p_command,p_binding);end if;
 if jsonb_typeof(p_command) is distinct from 'object' or not(p_command ?& array['id','type','branchId','deviceId','shiftId','orderId','invoiceId','expectedRevision','lines','reason','refundMethod','quoteHash'])
  or p_command-array['id','type','branchId','deviceId','shiftId','orderId','invoiceId','expectedRevision','lines','reason','refundMethod','quoteHash']<>'{}' then raise exception 'POS_INVALID_COMMAND';end if;
 request:=public.pos_return_uuid(p_command->'id');branch:=public.pos_return_uuid(p_command->'branchId');org:=public.pos_lock_staff_authority(branch);
 perform public.pos_recovery_scope(p_command,p_binding);
 perform pg_advisory_xact_lock(hashtextextended(request::text,1));perform public.pos_assert_not_cancelled('command',p_command,org);
 select * into prior from public.pos_command_receipts where id=request;
 if found then
  if prior.actor_id<>auth.uid() or prior.organization_id<>org or prior.branch_id<>branch or prior.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;
  return prior.result||jsonb_build_object('replayed',true);
 end if;
 if jsonb_typeof(p_command->'quoteHash') is distinct from 'string' or p_command->>'quoteHash'!~'^[a-f0-9]{64}$' then raise exception 'POS_INVALID_COMMAND';end if;
 payload:=p_command-array['id','type','quoteHash'];preview:=public.pos_preview_return(payload,p_binding);
 if preview->>'quoteHash'<>p_command->>'quoteHash' then raise exception 'POS_RETURN_STALE';end if;
 state:=public.pos_return_state_locked(org,branch,(p_command->>'orderId')::uuid);inv:=state->'invoice';number:=public.pos_allocate_document_number(branch,'tax_credit_note');issued:=clock_timestamp();
 credit:=jsonb_build_object('schemaVersion',4,'id',document,'kind','tax_credit_note','documentNumber',number,'issuedAt',issued,'merchant',inv->'merchant','orderId',inv->'orderId','branchId',branch,
  'deviceId',p_command->'deviceId','shiftId',p_command->'shiftId','actorId',auth.uid(),'serviceType',inv->'serviceType','customer',inv->'customer','reason',preview->'reason','lines',preview->'lines',
  'totals',preview->'totals','payments',preview->'payments','paymentSettlement','recorded','originalOffer',coalesce(inv->'appliedOffer','null'),
  'originalInvoice',jsonb_build_object('documentId',inv->'id','documentNumber',inv->'documentNumber','issuedAt',inv->'issuedAt','schemaVersion',inv->'schemaVersion','totalFils',inv#>'{totals,grossFils}',
   'taxFils',inv#>'{totals,taxFils}','netFils',inv#>'{totals,netFils}','beforeDiscountFils',coalesce(inv#>'{totals,beforeDiscountFils}',inv#>'{totals,grossFils}'),'discountFils',coalesce(inv#>'{totals,discountFils}','0')),
  'previousAdjustedTotals',preview->'previousAdjustedTotals','adjustedTotals',preview->'adjustedTotals','returnRevision',(state->>'revision')::integer+1,'fullyReturned',preview->'fullyReturned','quoteHash',preview->'quoteHash');
 insert into public.pos_documents(id,organization_id,branch_id,order_id,actor_id,kind,document_number,issued_at,request_payload,snapshot)
 values(document,org,branch,(p_command->>'orderId')::uuid,auth.uid(),'tax_credit_note',number,issued,p_command,credit);
 for p in select value from jsonb_array_elements(preview->'payments') loop
  insert into public.pos_refunds(id,organization_id,branch_id,order_id,device_id,shift_id,actor_id,method,amount_fils,reason,credit_document_id)
  values(gen_random_uuid(),org,branch,(p_command->>'orderId')::uuid,(p_command->>'deviceId')::uuid,(p_command->>'shiftId')::uuid,auth.uid(),p->>'method',(p->>'amountFils')::integer,p_command->>'reason',document);
 end loop;
 result:=jsonb_build_object('status','applied','commandId',request,'replayed',false,'creditNote',credit);
 insert into public.pos_command_receipts(id,organization_id,branch_id,actor_id,command_type,payload,result) values(request,org,branch,auth.uid(),'refund.items',p_command,result);
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details) values(org,branch,auth.uid(),'refund.items',request,jsonb_build_object('documentId',document,'orderId',inv->'orderId','reason',p_command->'reason','returnRevision',credit->'returnRevision','quoteHash',preview->'quoteHash'));
 return result;
end $$;

