-- Include manager-recorded bank-transfer refunds in branch financial reports.
-- Read-only manager reporting from issued fiscal snapshots. Does not depend on migration010.
create index if not exists pos_documents_branch_issued_report on public.pos_documents(branch_id,issued_at);
create or replace function public.pos_branch_report(p_branch uuid,p_start date,p_end date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_org uuid; v_name text; v_timezone text; v_from timestamptz; v_until timestamptz; v_count bigint; v_products bigint; v_legacy bigint; v_result jsonb;
begin
 if v_actor is null then raise exception 'POS_REPORT_ACCESS_DENIED'; end if;
 select b.organization_id,b.name into v_org,v_name from public.pos_branches b
 where b.id=p_branch and exists(select 1 from public.pos_staff s where s.organization_id=b.organization_id and s.user_id=v_actor and s.active and s.role in ('owner','manager') and (s.branch_id is null or s.branch_id=b.id));
 if not found then raise exception 'POS_REPORT_ACCESS_DENIED'; end if;
 if p_start is null or p_end is null or p_end<p_start or p_end-p_start>92 or p_start<date '2000-01-01' or p_end>date '2100-12-31' then raise exception 'POS_REPORT_INVALID_RANGE'; end if;
 select p.timezone into v_timezone from public.pos_branch_receipt_config c join public.pos_merchant_profiles p on p.id=c.profile_id and p.organization_id=c.organization_id and p.branch_id=c.branch_id where c.branch_id=p_branch and c.organization_id=v_org;
 if v_timezone is distinct from 'Asia/Dubai' then raise exception 'POS_REPORT_PROFILE_REQUIRED'; end if;
 v_from:=p_start::timestamp at time zone v_timezone; v_until:=(p_end+1)::timestamp at time zone v_timezone;
 select count(*) into v_count from public.pos_documents where branch_id=p_branch and organization_id=v_org and issued_at>=v_from and issued_at<v_until;
 if v_count>50000 then raise exception 'POS_REPORT_TOO_LARGE'; end if;
 if exists(select 1 from public.pos_documents d where d.branch_id=p_branch and d.organization_id=v_org and d.issued_at>=v_from and d.issued_at<v_until and (
  jsonb_typeof(d.snapshot->'totals'->'grossFils') is distinct from 'number' or jsonb_typeof(d.snapshot->'totals'->'netFils') is distinct from 'number' or jsonb_typeof(d.snapshot->'totals'->'taxFils') is distinct from 'number'
  or jsonb_typeof(d.snapshot->'lines') is distinct from 'array' or jsonb_typeof(d.snapshot->'payments') is distinct from 'array'
 )) then raise exception 'POS_REPORT_INVALID_DATA'; end if;
 select count(*) into v_products from (select distinct l->>'productId',l->>'name',l->>'unit' from public.pos_documents d cross join lateral jsonb_array_elements(d.snapshot->'lines') l where d.branch_id=p_branch and d.organization_id=v_org and d.issued_at>=v_from and d.issued_at<v_until) q;
 if v_products>5000 then raise exception 'POS_REPORT_TOO_LARGE'; end if;
 select count(*) into v_legacy from public.pos_orders o where o.branch_id=p_branch and o.organization_id=v_org and o.received_at>=v_from and o.received_at<v_until and not exists(select 1 from public.pos_documents d where d.order_id=o.id and d.kind='tax_invoice');
 with docs as materialized (
  select d.kind,(d.issued_at at time zone v_timezone)::date as day,d.snapshot,
   case d.kind when 'tax_invoice' then 1 else -1 end as sign,
   (d.snapshot->'totals'->>'grossFils')::bigint as gross,(d.snapshot->'totals'->>'netFils')::bigint as net,(d.snapshot->'totals'->>'taxFils')::bigint as tax
  from public.pos_documents d where d.branch_id=p_branch and d.organization_id=v_org and d.issued_at>=v_from and d.issued_at<v_until
 ), lines as materialized (
  select d.sign,l->>'productId' as product_id,l->>'name' as name,l->>'unit' as unit,(l->>'quantityMilli')::bigint as quantity,
   (l->>'taxRateBps')::integer as rate,(l->>'grossFils')::bigint as gross,(l->>'netFils')::bigint as net,(l->>'taxFils')::bigint as tax
  from docs d cross join lateral jsonb_array_elements(d.snapshot->'lines') l
 ), payments as materialized (
  select d.sign,p->>'method' as method,(p->>'amountFils')::bigint as amount from docs d cross join lateral jsonb_array_elements(d.snapshot->'payments') p
 ), totals as (
  select jsonb_build_object('invoiceCount',count(*) filter(where sign=1),'creditNoteCount',count(*) filter(where sign=-1),
   'salesGrossFils',coalesce(sum(gross) filter(where sign=1),0),'refundGrossFils',coalesce(sum(gross) filter(where sign=-1),0),'netGrossFils',coalesce(sum(sign*gross),0),'netExVatFils',coalesce(sum(sign*net),0),'vatFils',coalesce(sum(sign*tax),0)) as value from docs
 ), daily as (
  select days.day,jsonb_build_object('date',days.day::date,'invoiceCount',count(d.sign) filter(where d.sign=1),'creditNoteCount',count(d.sign) filter(where d.sign=-1),
   'salesGrossFils',coalesce(sum(d.gross) filter(where d.sign=1),0),'refundGrossFils',coalesce(sum(d.gross) filter(where d.sign=-1),0),'netGrossFils',coalesce(sum(d.sign*d.gross),0),'netExVatFils',coalesce(sum(d.sign*d.net),0),'vatFils',coalesce(sum(d.sign*d.tax),0)) as value
  from generate_series(p_start::timestamp,p_end::timestamp,interval '1 day') days(day) left join docs d on d.day=days.day::date group by days.day
 ), tender as (
  select methods.method,jsonb_build_object('method',methods.method,'salesFils',coalesce(sum(p.amount) filter(where p.sign=1),0),'refundsFils',coalesce(sum(p.amount) filter(where p.sign=-1),0),'netFils',coalesce(sum(p.sign*p.amount),0)) as value
  from (values ('bank_transfer'),('cash'),('card')) methods(method) left join payments p on p.method=methods.method group by methods.method
 ), vat as (
  select rate,jsonb_build_object('taxRateBps',rate,'salesGrossFils',coalesce(sum(gross) filter(where sign=1),0),'refundGrossFils',coalesce(sum(gross) filter(where sign=-1),0),'netGrossFils',sum(sign*gross),'netExVatFils',sum(sign*net),'vatFils',sum(sign*tax)) as value from lines group by rate
 ), products as (
  select product_id,name,unit,jsonb_build_object('productId',product_id,'name',name,'unit',unit,
   'soldQuantityMilli',coalesce(sum(quantity) filter(where sign=1),0),'refundedQuantityMilli',coalesce(sum(quantity) filter(where sign=-1),0),'netQuantityMilli',sum(sign*quantity),
   'salesGrossFils',coalesce(sum(gross) filter(where sign=1),0),'refundGrossFils',coalesce(sum(gross) filter(where sign=-1),0),'netGrossFils',sum(sign*gross),'netExVatFils',sum(sign*net),'vatFils',sum(sign*tax)) as value from lines group by product_id,name,unit
 )
 select jsonb_build_object('status','ready','branchId',p_branch,'branchName',v_name,'currency','AED','timezone',v_timezone,'startDate',p_start,'endDate',p_end,'generatedAt',statement_timestamp(),
  'basis','issued_fiscal_documents','documentCount',v_count,'legacyOrdersExcluded',v_legacy,
  'summary',(select value from totals),'days',coalesce((select jsonb_agg(value order by day) from daily),'[]'::jsonb),
  'payments',coalesce((select jsonb_agg(value order by method) from tender),'[]'::jsonb),'vatRates',coalesce((select jsonb_agg(value order by rate) from vat),'[]'::jsonb),
  'products',coalesce((select jsonb_agg(value order by name,product_id,unit) from products),'[]'::jsonb)) into v_result;
 return v_result;
end $$;
revoke all on function public.pos_branch_report(uuid,date,date) from public,anon;
grant execute on function public.pos_branch_report(uuid,date,date) to authenticated;
