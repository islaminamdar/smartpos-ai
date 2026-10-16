-- Separate USD PayPal domain. Existing AED pos_subscriptions and financial records are untouched.
create function public.pos_paypal_can_manage(p_branch uuid,p_actor uuid default auth.uid()) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.pos_staff s join public.pos_branches b on b.organization_id=s.organization_id
 where b.id=p_branch and b.active and s.user_id=p_actor and s.active and s.role in ('owner','manager') and (s.branch_id is null or s.branch_id=b.id));
$$;
revoke all on function public.pos_paypal_can_manage(uuid,uuid) from public,anon;
grant execute on function public.pos_paypal_can_manage(uuid,uuid) to authenticated,service_role;
create table public.pos_paypal_subscriptions (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, branch_id uuid not null,
 environment text not null check(environment in ('sandbox','live')), actor_id uuid not null references auth.users,
 client_request_id uuid not null, provider_id text, plan_id text not null check(plan_id ~ '^P-[A-Z0-9]{24}$'),
 price_cents integer not null default 10000 check(price_cents=10000), currency text not null default 'USD' check(currency='USD'),
 interval_unit text not null default 'MONTH' check(interval_unit='MONTH'), status text not null default 'CREATING' check(status in ('CREATING','APPROVAL_PENDING','APPROVED','ACTIVE','SUSPENDED','CANCELLED','EXPIRED')),
 approval_url text, next_billing_time timestamptz, last_payment_at timestamptz, last_payment_cents bigint,
 outstanding_cents bigint not null default 0 check(outstanding_cents>=0), failed_payments integer not null default 0,
 created_at timestamptz not null default now(), checked_at timestamptz, transactions_checked_through timestamptz,
 price_review_required boolean not null default false,
 lease_token uuid, lease_until timestamptz,
 foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id),
 unique(environment,provider_id), unique(environment,actor_id,client_request_id),
 check(provider_id is null or provider_id ~ '^I-[A-Z0-9]{6,30}$')
);
create unique index pos_paypal_one_current on public.pos_paypal_subscriptions(branch_id,environment) where status not in ('CANCELLED','EXPIRED');
create table public.pos_paypal_transactions (
 environment text not null, provider_transaction_id text not null, subscription_id uuid not null references public.pos_paypal_subscriptions,
 status text not null, amount_cents bigint not null check(amount_cents>=0), currency text not null check(currency='USD'),
 occurred_at timestamptz not null, checked_at timestamptz not null default now(), primary key(environment,provider_transaction_id)
);
create table public.pos_paypal_events (
 environment text not null, event_id text not null, digest text not null, subscription_id uuid not null references public.pos_paypal_subscriptions,
 processed_at timestamptz, received_at timestamptz not null default now(), primary key(environment,event_id)
);
create table public.pos_paypal_audit (
 id bigint generated always as identity primary key, subscription_id uuid not null references public.pos_paypal_subscriptions,
 action text not null, actor_id uuid, provider_status text, recorded_at timestamptz not null default now()
);
alter table public.pos_paypal_subscriptions enable row level security;
alter table public.pos_paypal_transactions enable row level security;
alter table public.pos_paypal_events enable row level security;
alter table public.pos_paypal_audit enable row level security;
revoke all on public.pos_paypal_subscriptions,public.pos_paypal_transactions,public.pos_paypal_events,public.pos_paypal_audit from public,anon,authenticated;
revoke all on sequence public.pos_paypal_audit_id_seq from public,anon,authenticated;
grant select on public.pos_paypal_subscriptions,public.pos_paypal_transactions to authenticated;
grant select on public.pos_paypal_subscriptions,public.pos_paypal_transactions to service_role;
create policy pos_paypal_subscription_read on public.pos_paypal_subscriptions for select to authenticated using(public.pos_paypal_can_manage(branch_id));
create policy pos_paypal_transaction_read on public.pos_paypal_transactions for select to authenticated using(exists(select 1 from public.pos_paypal_subscriptions s where s.id=subscription_id and public.pos_paypal_can_manage(s.branch_id)));

create function public.pos_paypal_begin(p_branch uuid,p_actor uuid,p_environment text,p_plan text,p_request uuid,p_lease uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row public.pos_paypal_subscriptions%rowtype; v_org uuid;
begin
 if not public.pos_paypal_can_manage(p_branch,p_actor) then raise exception 'PAYPAL_ACCESS_DENIED'; end if;
 if p_environment not in ('sandbox','live') or p_plan !~ '^P-[A-Z0-9]{24}$' or p_request is null or p_lease is null then raise exception 'PAYPAL_INVALID_REQUEST'; end if;
 select organization_id into v_org from public.pos_branches where id=p_branch for update;
 select * into v_row from public.pos_paypal_subscriptions where environment=p_environment and actor_id=p_actor and client_request_id=p_request for update;
 if found and v_row.branch_id<>p_branch then raise exception 'PAYPAL_IDEMPOTENCY_CONFLICT'; end if;
 if v_row.id is null then
  select * into v_row from public.pos_paypal_subscriptions where branch_id=p_branch and environment=p_environment and status not in ('CANCELLED','EXPIRED') for update;
 end if;
 if v_row.id is null then
  insert into public.pos_paypal_subscriptions(organization_id,branch_id,environment,actor_id,client_request_id,plan_id)
   values(v_org,p_branch,p_environment,p_actor,p_request,p_plan) returning * into v_row;
  insert into public.pos_paypal_audit(subscription_id,action,actor_id) values(v_row.id,'checkout_requested',p_actor);
 end if;
 if v_row.plan_id<>p_plan then raise exception 'PAYPAL_PLAN_CHANGED'; end if;
 if v_row.lease_until>now() then raise exception 'PAYPAL_BUSY'; end if;
 -- Never blindly repeat an uncertain create after the provider's 72-hour key retention.
 if v_row.provider_id is null and v_row.created_at<now()-interval '70 hours' then raise exception 'PAYPAL_MANUAL_RECONCILIATION_REQUIRED'; end if;
 update public.pos_paypal_subscriptions set lease_token=p_lease,lease_until=now()+interval '90 seconds' where id=v_row.id returning * into v_row;
 return to_jsonb(v_row);
end $$;
revoke all on function public.pos_paypal_begin(uuid,uuid,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.pos_paypal_begin(uuid,uuid,text,text,uuid,uuid) to service_role;

create function public.pos_paypal_reserve(p_id uuid,p_actor uuid,p_environment text,p_lease uuid,p_event text default null,p_digest text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row public.pos_paypal_subscriptions%rowtype; v_event public.pos_paypal_events%rowtype;
begin
 select * into v_row from public.pos_paypal_subscriptions where id=p_id and environment=p_environment for update;
 if not found or (p_actor is not null and not public.pos_paypal_can_manage(v_row.branch_id,p_actor)) then raise exception 'PAYPAL_ACCESS_DENIED'; end if;
 if p_actor is null and (p_event is null or p_digest is null) then raise exception 'PAYPAL_ACCESS_DENIED'; end if;
 if p_lease is null then raise exception 'PAYPAL_INVALID_REQUEST'; end if;
 if p_event is not null then
  if length(p_event) not between 1 and 100 or p_digest !~ '^[a-f0-9]{64}$' then raise exception 'PAYPAL_INVALID_REQUEST'; end if;
  insert into public.pos_paypal_events(environment,event_id,digest,subscription_id) values(p_environment,p_event,p_digest,p_id) on conflict do nothing;
  select * into v_event from public.pos_paypal_events where environment=p_environment and event_id=p_event for update;
  if v_event.digest<>p_digest or v_event.subscription_id<>p_id then raise exception 'PAYPAL_EVENT_CONFLICT'; end if;
  if v_event.processed_at is not null then return jsonb_build_object('duplicate',true); end if;
 end if;
 if v_row.lease_until>now() then raise exception 'PAYPAL_BUSY'; end if;
 update public.pos_paypal_subscriptions set lease_token=p_lease,lease_until=now()+interval '90 seconds' where id=p_id returning * into v_row;
 return to_jsonb(v_row);
end $$;
revoke all on function public.pos_paypal_reserve(uuid,uuid,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.pos_paypal_reserve(uuid,uuid,text,uuid,text,text) to service_role;

create function public.pos_paypal_apply(p_id uuid,p_lease uuid,p_snapshot jsonb,p_transactions jsonb,p_through timestamptz,p_event text default null,p_complete boolean default true)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row public.pos_paypal_subscriptions%rowtype; v_tx jsonb; v_owner uuid; v_status text;
begin
 select * into v_row from public.pos_paypal_subscriptions where id=p_id for update;
 if not found or p_lease is null or v_row.lease_token is null or v_row.lease_until is null or v_row.lease_token is distinct from p_lease or v_row.lease_until<now() then raise exception 'PAYPAL_LEASE_LOST'; end if;
 if p_snapshot->>'checkoutId' is distinct from p_id::text or p_snapshot->>'planId' is distinct from v_row.plan_id
  or p_snapshot->>'providerId' is null or p_snapshot->>'providerId' !~ '^I-[A-Z0-9]{6,30}$' or (v_row.provider_id is not null and v_row.provider_id<>p_snapshot->>'providerId') then raise exception 'PAYPAL_SUBSCRIPTION_MISMATCH'; end if;
 v_status:=p_snapshot->>'status';
 if v_status not in ('APPROVAL_PENDING','APPROVED','ACTIVE','SUSPENDED','CANCELLED','EXPIRED') or v_status is null then raise exception 'PAYPAL_INVALID_STATUS'; end if;
 if v_row.status in ('CANCELLED','EXPIRED') and v_status<>v_row.status then raise exception 'PAYPAL_TERMINAL_STATE_CONFLICT'; end if;
 if jsonb_typeof(p_transactions) is distinct from 'array' or jsonb_array_length(p_transactions)>1000 then raise exception 'PAYPAL_INVALID_TRANSACTIONS'; end if;
 for v_tx in select value from jsonb_array_elements(p_transactions) loop
  if v_tx->>'id' !~ '^[A-Z0-9-]{5,64}$' or v_tx->>'currency' is distinct from 'USD' or v_tx->>'status' !~ '^[A-Z_]{3,40}$' or (v_tx->>'amountCents')::bigint<0 then raise exception 'PAYPAL_INVALID_TRANSACTIONS'; end if;
  select subscription_id into v_owner from public.pos_paypal_transactions where environment=v_row.environment and provider_transaction_id=v_tx->>'id';
  if found and v_owner<>p_id then raise exception 'PAYPAL_TRANSACTION_CONFLICT'; end if;
  insert into public.pos_paypal_transactions(environment,provider_transaction_id,subscription_id,status,amount_cents,currency,occurred_at)
   values(v_row.environment,v_tx->>'id',p_id,v_tx->>'status',(v_tx->>'amountCents')::bigint,'USD',(v_tx->>'time')::timestamptz)
   on conflict(environment,provider_transaction_id) do update set status=excluded.status,amount_cents=excluded.amount_cents,checked_at=now() where public.pos_paypal_transactions.subscription_id=excluded.subscription_id;
  if not found then raise exception 'PAYPAL_TRANSACTION_CONFLICT'; end if;
 end loop;
 update public.pos_paypal_subscriptions set provider_id=p_snapshot->>'providerId',status=v_status,
  price_review_required=coalesce((p_snapshot->>'priceReviewRequired')::boolean,false),
  approval_url=p_snapshot->>'approvalUrl',next_billing_time=(p_snapshot->>'nextBillingTime')::timestamptz,
  last_payment_at=(p_snapshot->>'lastPaymentAt')::timestamptz,last_payment_cents=(p_snapshot->>'lastPaymentCents')::bigint,
  outstanding_cents=coalesce((p_snapshot->>'outstandingCents')::bigint,0),failed_payments=coalesce((p_snapshot->>'failedPayments')::integer,0),
  transactions_checked_through=greatest(transactions_checked_through,p_through),checked_at=now(),lease_token=null,lease_until=null where id=p_id;
 if p_event is not null and p_complete then update public.pos_paypal_events set processed_at=now() where environment=v_row.environment and event_id=p_event and subscription_id=p_id; end if;
 insert into public.pos_paypal_audit(subscription_id,action,provider_status) values(p_id,case when p_event is null then 'provider_reconciled' else 'webhook_reconciled' end,v_status);
 return jsonb_build_object('status','reconciled','subscriptionId',p_id,'providerStatus',v_status,'reconciliationPending',not p_complete);
end $$;
revoke all on function public.pos_paypal_apply(uuid,uuid,jsonb,jsonb,timestamptz,text,boolean) from public,anon,authenticated;
grant execute on function public.pos_paypal_apply(uuid,uuid,jsonb,jsonb,timestamptz,text,boolean) to service_role;
create function public.pos_paypal_release(p_id uuid,p_lease uuid) returns void language sql security definer set search_path='' as $$
 update public.pos_paypal_subscriptions set lease_token=null,lease_until=null where id=p_id and lease_token=p_lease;
$$;
revoke all on function public.pos_paypal_release(uuid,uuid) from public,anon,authenticated;
grant execute on function public.pos_paypal_release(uuid,uuid) to service_role;
