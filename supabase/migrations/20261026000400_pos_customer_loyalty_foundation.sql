-- Consent-aware customer and loyalty foundation. This is deliberately points-only:
-- it does not create stored money, credit, a wallet, offers, messaging or automatic
-- marketing. A customer must explicitly be selected by a future counter flow before
-- an invoice can earn points.
create table public.pos_customers (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null, branch_id uuid not null,
 full_name text not null check (length(btrim(full_name)) between 1 and 160),
 phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
 active boolean not null default true,
 marketing_consent boolean not null default false,
 marketing_consent_at timestamptz,
 marketing_consent_source text check (marketing_consent_source is null or length(btrim(marketing_consent_source)) between 1 and 80),
 created_by uuid not null references auth.users, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key (organization_id,branch_id) references public.pos_branches(organization_id,id),
 unique (organization_id,branch_id,phone_e164),
 check ((marketing_consent and marketing_consent_at is not null and marketing_consent_source is not null) or (not marketing_consent and marketing_consent_at is null and marketing_consent_source is null))
);
create index pos_customers_branch_name_idx on public.pos_customers(branch_id, lower(full_name));

create table public.pos_loyalty_programs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, branch_id uuid not null unique,
 active boolean not null default false,
 -- Points are not money. A branch owner must deliberately activate and configure a rate.
 points_per_aed integer not null default 1 check (points_per_aed between 1 and 1000),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key (organization_id,branch_id) references public.pos_branches(organization_id,id)
);

create table public.pos_loyalty_ledger (
 id bigint generated always as identity primary key,
 organization_id uuid not null, branch_id uuid not null, customer_id uuid not null,
 document_id uuid not null references public.pos_documents(id),
 source_document_id uuid references public.pos_documents(id),
 points integer not null check (points between -100000000 and 100000000 and points <> 0),
 kind text not null check (kind in ('invoice_earned','credit_reversal')),
 created_at timestamptz not null default now(),
 foreign key (organization_id,branch_id) references public.pos_branches(organization_id, id),
 foreign key (customer_id) references public.pos_customers(id),
 unique (document_id),
 check ((kind='invoice_earned' and points>0 and source_document_id is null) or (kind='credit_reversal' and points<0 and source_document_id is not null))
);
create index pos_loyalty_ledger_customer_idx on public.pos_loyalty_ledger(customer_id,created_at desc);

alter table public.pos_customers enable row level security;
alter table public.pos_loyalty_programs enable row level security;
alter table public.pos_loyalty_ledger enable row level security;
revoke all on public.pos_customers,public.pos_loyalty_programs,public.pos_loyalty_ledger from public,anon,authenticated;
grant select on public.pos_customers,public.pos_loyalty_programs,public.pos_loyalty_ledger to authenticated;
create policy pos_customers_read on public.pos_customers for select to authenticated using (public.pos_can_access(organization_id,branch_id));
create policy pos_loyalty_programs_read on public.pos_loyalty_programs for select to authenticated using (public.pos_can_access(organization_id,branch_id));
create policy pos_loyalty_ledger_read on public.pos_loyalty_ledger for select to authenticated using (public.pos_can_access(organization_id,branch_id));

create function public.pos_customer_touch_updated_at() returns trigger language plpgsql security definer set search_path='' as $$
begin new.updated_at:=clock_timestamp(); return new; end $$;
revoke all on function public.pos_customer_touch_updated_at() from public,anon,authenticated;
create trigger pos_customers_touch_updated_at before update on public.pos_customers for each row execute function public.pos_customer_touch_updated_at();
create trigger pos_loyalty_programs_touch_updated_at before update on public.pos_loyalty_programs for each row execute function public.pos_customer_touch_updated_at();

-- Prevent direct alteration of the append-only points record. Corrections happen by
-- a future, separately audited document flow rather than rewriting history.
create function public.pos_loyalty_ledger_immutable() returns trigger language plpgsql security definer set search_path='' as $$
begin raise exception 'POS_LOYALTY_LEDGER_IMMUTABLE'; end $$;
revoke all on function public.pos_loyalty_ledger_immutable() from public,anon,authenticated;
create trigger pos_loyalty_ledger_no_update before update or delete on public.pos_loyalty_ledger for each row execute function public.pos_loyalty_ledger_immutable();

create function public.pos_loyalty_capture_document() returns trigger language plpgsql security definer set search_path='' as $$
declare v_customer uuid; v_program public.pos_loyalty_programs%rowtype; v_points bigint; v_invoice uuid; v_invoice_ledger public.pos_loyalty_ledger%rowtype;
begin
 -- Existing and offline signed receipts are untouched. Only a future online counter
 -- schema may include customer.loyaltyCustomerId after explicit staff selection.
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
   select * into v_invoice_ledger from public.pos_loyalty_ledger where document_id=v_invoice and kind='invoice_earned' for share;
   if not found then return new; end if;
   select * into v_program from public.pos_loyalty_programs where organization_id=new.organization_id and branch_id=new.branch_id for share;
   if not found then raise exception 'POS_LOYALTY_PROGRAM_UNAVAILABLE'; end if;
   v_points:=((new.snapshot#>>'{totals,netFils}')::bigint*v_program.points_per_aed)/100;
   if v_points>0 then insert into public.pos_loyalty_ledger(organization_id,branch_id,customer_id,document_id,source_document_id,points,kind) values(new.organization_id,new.branch_id,v_invoice_ledger.customer_id,new.id,v_invoice,-v_points::integer,'credit_reversal'); end if;
 end if;
 return new;
end $$;
revoke all on function public.pos_loyalty_capture_document() from public,anon,authenticated;
create trigger pos_documents_capture_loyalty after insert on public.pos_documents for each row execute function public.pos_loyalty_capture_document();

-- Staff can create a customer only after capturing a phone number. Marketing consent is
-- false unless explicitly supplied with a human-readable source. The function does not
-- expose any cross-branch records.
create function public.pos_upsert_customer(p_branch uuid,p_full_name text,p_phone_e164 text,p_marketing_consent boolean default false,p_consent_source text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_org uuid; v_customer public.pos_customers;
begin
 if auth.uid() is null then raise exception 'POS_CUSTOMER_ACCESS_DENIED'; end if;
 select organization_id into v_org from public.pos_branches where id=p_branch and active;
 if v_org is null or not public.pos_can_access(v_org,p_branch) then raise exception 'POS_CUSTOMER_ACCESS_DENIED'; end if;
 if length(btrim(coalesce(p_full_name,''))) not between 1 and 160 or coalesce(p_phone_e164,'') !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'POS_CUSTOMER_INVALID'; end if;
 if p_marketing_consent and length(btrim(coalesce(p_consent_source,''))) not between 1 and 80 then raise exception 'POS_CUSTOMER_CONSENT_SOURCE_REQUIRED'; end if;
 insert into public.pos_customers(organization_id,branch_id,full_name,phone_e164,marketing_consent,marketing_consent_at,marketing_consent_source,created_by)
 values(v_org,p_branch,btrim(p_full_name),p_phone_e164,p_marketing_consent,case when p_marketing_consent then clock_timestamp() else null end,case when p_marketing_consent then btrim(p_consent_source) else null end,auth.uid())
 on conflict(organization_id,branch_id,phone_e164) do update set full_name=excluded.full_name,marketing_consent=excluded.marketing_consent,marketing_consent_at=excluded.marketing_consent_at,marketing_consent_source=excluded.marketing_consent_source
 returning * into v_customer;
 return jsonb_build_object('id',v_customer.id,'fullName',v_customer.full_name,'phoneE164',v_customer.phone_e164,'marketingConsent',v_customer.marketing_consent,'marketingConsentAt',v_customer.marketing_consent_at);
end $$;
revoke all on function public.pos_upsert_customer(uuid,text,text,boolean,text) from public,anon;
grant execute on function public.pos_upsert_customer(uuid,text,text,boolean,text) to authenticated;
