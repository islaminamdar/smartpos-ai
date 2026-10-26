-- Close customer/loyalty privacy and immutable-points gaps in the initial foundation.
-- Existing fiscal documents remain unchanged. This migration narrows access and
-- corrects future loyalty reversal allocation.
revoke select on public.pos_customers, public.pos_loyalty_ledger from authenticated;
drop policy if exists pos_customers_read on public.pos_customers;
drop policy if exists pos_loyalty_ledger_read on public.pos_loyalty_ledger;

-- Preserve the original counter-facing signature. Customer registration is manager-only
-- until an audited counter workflow exists. An ordinary upsert cannot alter a saved
-- marketing decision. Consent changes require a separate manager-only workflow.
create or replace function public.pos_upsert_customer(p_branch uuid,p_full_name text,p_phone_e164 text,p_marketing_consent boolean default false,p_consent_source text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_org uuid; v_customer public.pos_customers; v_manager boolean; v_exists boolean;
begin
 if auth.uid() is null then raise exception 'POS_CUSTOMER_ACCESS_DENIED'; end if;
 v_org:=public.pos_lock_staff_authority(p_branch);
 if length(btrim(coalesce(p_full_name,''))) not between 1 and 160 or coalesce(p_phone_e164,'') !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'POS_CUSTOMER_INVALID'; end if;
 select exists(select 1 from public.pos_staff s where s.organization_id=v_org and s.user_id=auth.uid() and s.active and s.role in ('owner','manager') and (s.branch_id is null or s.branch_id=p_branch)) into v_manager;
 if not v_manager then raise exception 'POS_CUSTOMER_MANAGER_REQUIRED'; end if;
 select exists(select 1 from public.pos_customers c where c.organization_id=v_org and c.branch_id=p_branch and c.phone_e164=p_phone_e164) into v_exists;
 if v_exists and (p_marketing_consent or p_consent_source is not null) then
   raise exception 'POS_CUSTOMER_CONSENT_CHANGE_REQUIRES_WORKFLOW';
 end if;
 if p_marketing_consent and length(btrim(coalesce(p_consent_source,''))) not between 1 and 80 then raise exception 'POS_CUSTOMER_CONSENT_SOURCE_REQUIRED'; end if;
 if not p_marketing_consent and p_consent_source is not null then raise exception 'POS_CUSTOMER_INVALID'; end if;
 insert into public.pos_customers(organization_id,branch_id,full_name,phone_e164,marketing_consent,marketing_consent_at,marketing_consent_source,created_by)
 values(v_org,p_branch,btrim(p_full_name),p_phone_e164,p_marketing_consent,case when p_marketing_consent then clock_timestamp() else null end,case when p_marketing_consent then btrim(p_consent_source) else null end,auth.uid())
 on conflict(organization_id,branch_id,phone_e164) do update set full_name=excluded.full_name
 returning * into v_customer;
 return jsonb_build_object('id',v_customer.id);
end $$;
revoke all on function public.pos_upsert_customer(uuid,text,text,boolean,text) from public,anon;
grant execute on function public.pos_upsert_customer(uuid,text,text,boolean,text) to authenticated;

-- Credit notes reverse a deterministic share of the immutable original earned points.
-- The active programme rate is deliberately never consulted for a historic reversal.
create or replace function public.pos_loyalty_capture_document() returns trigger language plpgsql security definer set search_path='' as $$
declare v_customer uuid; v_program public.pos_loyalty_programs%rowtype; v_points bigint; v_invoice uuid; v_invoice_ledger public.pos_loyalty_ledger%rowtype;
 v_original_net bigint; v_cumulative_credit_net bigint; v_reversed bigint; v_target bigint;
begin
 if new.kind='tax_invoice' then
   if jsonb_typeof(new.snapshot->'customer') is distinct from 'object' or jsonb_typeof(new.snapshot->'customer'->'loyaltyCustomerId') is distinct from 'string' then return new; end if;
   begin v_customer:=(new.snapshot->'customer'->>'loyaltyCustomerId')::uuid; exception when invalid_text_representation then raise exception 'POS_LOYALTY_CUSTOMER_INVALID'; end;
   select * into v_program from public.pos_loyalty_programs where organization_id=new.organization_id and branch_id=new.branch_id and active for share;
   if not found then return new; end if;
   perform 1 from public.pos_customers where id=v_customer and organization_id=new.organization_id and branch_id=new.branch_id and active;
   if not found then raise exception 'POS_LOYALTY_CUSTOMER_INVALID'; end if;
   v_points:=((new.snapshot#>>'{totals,netFils}')::bigint*v_program.points_per_aed)/100;
   if v_points>0 then insert into public.pos_loyalty_ledger(organization_id,branch_id,customer_id,document_id,points,kind) values(new.organization_id,new.branch_id,v_customer,new.id,v_points::integer,'invoice_earned'); end if;
 elsif new.kind='tax_credit_note' then
   begin v_invoice:=(new.snapshot#>>'{originalInvoice,documentId}')::uuid; exception when invalid_text_representation then return new; end;
   -- Serialize every credit against one source invoice, including future writers.
   perform pg_advisory_xact_lock(hashtextextended(v_invoice::text,52));
   select * into v_invoice_ledger from public.pos_loyalty_ledger where document_id=v_invoice and kind='invoice_earned' and organization_id=new.organization_id and branch_id=new.branch_id for share;
   if not found then return new; end if;
   select (snapshot#>>'{totals,netFils}')::bigint into v_original_net from public.pos_documents where id=v_invoice and kind='tax_invoice' and organization_id=new.organization_id and branch_id=new.branch_id;
   if coalesce(v_original_net,0)<=0 then raise exception 'POS_LOYALTY_ORIGINAL_INVALID'; end if;
   select coalesce(sum((snapshot#>>'{totals,netFils}')::bigint),0) into v_cumulative_credit_net from public.pos_documents
    where kind='tax_credit_note' and organization_id=new.organization_id and branch_id=new.branch_id and snapshot#>>'{originalInvoice,documentId}'=v_invoice::text;
   select coalesce(sum(-points),0) into v_reversed from public.pos_loyalty_ledger where source_document_id=v_invoice and kind='credit_reversal';
   v_target:=least(v_invoice_ledger.points::bigint,(v_invoice_ledger.points::bigint*v_cumulative_credit_net)/v_original_net);
   v_points:=v_target-v_reversed;
   if v_points>0 then insert into public.pos_loyalty_ledger(organization_id,branch_id,customer_id,document_id,source_document_id,points,kind) values(new.organization_id,new.branch_id,v_invoice_ledger.customer_id,new.id,v_invoice,-v_points::integer,'credit_reversal'); end if;
 end if;
 return new;
end $$;
revoke all on function public.pos_loyalty_capture_document() from public,anon,authenticated;
