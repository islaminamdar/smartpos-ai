-- Candidate manager attestation ledger ONLY. No processor action, invoice, payment,
-- refund, cash movement, cancellation, replacement document or device delivery is claimed.
-- The trusted server reauthenticates the manager in this HTTP request and supplies
-- p_confirmed_at. This service-only RPC never accepts a client claim of reauthentication.
create table public.pos_offline_payment_resolution_policy (
 branch_id uuid primary key references public.pos_branches,enabled boolean not null default false
);
create table public.pos_offline_payment_decisions (
 id uuid primary key default gen_random_uuid(),freeze_id uuid not null unique references public.pos_offline_payment_freezes,
 request_id uuid not null unique,actor_id uuid not null references auth.users,authority_id uuid not null references public.pos_offline_authorities,
 request_payload jsonb not null,request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 decision text not null check(decision in ('funds_returned','payment_voided')),evidence jsonb not null,
 confirmed_at timestamptz not null,accepted_at timestamptz not null,resolution jsonb not null,
 resolution_sha256 text not null check(resolution_sha256 ~ '^[a-f0-9]{64}$')
);
create table public.pos_offline_payment_result_signatures (
 resolution_id uuid primary key references public.pos_offline_payment_decisions,
 payload_sha256 text not null check(payload_sha256 ~ '^[a-f0-9]{64}$'),envelope jsonb not null,
 attached_at timestamptz not null default clock_timestamp()
);
create index pos_offline_payment_decisions_authority on public.pos_offline_payment_decisions(authority_id);
do $$declare t text;begin
 foreach t in array array['pos_offline_payment_resolution_policy','pos_offline_payment_decisions','pos_offline_payment_result_signatures'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 end loop;
 foreach t in array array['pos_offline_payment_decisions','pos_offline_payment_result_signatures'] loop
 execute format('create trigger %I before update or delete on public.%I for each row execute function public.pos_preserve_document()',t||'_immutable',t);
 end loop;
end $$;

-- Recompute the original native quote from its immutable snapshot. This helper does
-- not consult current prices, current cashier membership or selling permission expiry.
create function public.pos_offline_payment_quote(p_freeze uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare f public.pos_offline_payment_freezes;g public.pos_offline_authorities;p jsonb;req jsonb;line jsonb;product jsonb;
 lines jsonb:='[]';payments jsonb:='[]';gross bigint:=0;tax bigint:=0;n integer:=0;quantity bigint;line_gross bigint;line_tax bigint;card bigint;cash bigint;
begin
 select * into f from public.pos_offline_payment_freezes where id=p_freeze;if not found then raise exception 'POS_OFFLINE_CASE_UNKNOWN';end if;
 select * into g from public.pos_offline_authorities where id=f.authority_id;
 p:=public.pos_offline_validate_payment_freeze(f.proof_envelope,g.id);req:=p->'request';
 if req is distinct from f.request_payload or encode(sha256(public.pos_offline_bytes(f.proof_envelope->>'payloadBase64Url')),'hex')<>f.payload_sha256 then raise exception 'POS_OFFLINE_INVALID_PAYMENT_CASE';end if;
 for line in select value from jsonb_array_elements(req->'lines') loop
  n:=n+1;select value into product from jsonb_array_elements(g.snapshot->'products') where value->>'id'=line->>'productId';quantity:=(line->>'quantityMilli')::bigint;
  line_gross:=((product->>'unitPriceFils')::bigint*quantity+500)/1000;
  line_tax:=(line_gross*(product->>'taxRateBps')::bigint*2+10000+(product->>'taxRateBps')::bigint)/(2*(10000+(product->>'taxRateBps')::bigint));
  gross:=gross+line_gross;tax:=tax+line_tax;
  lines:=lines||jsonb_build_array(jsonb_build_object('lineNumber',n,'productId',line->'productId','name',product->'name','unit',product->'unit','quantityMilli',quantity,'unitPriceFils',product->'unitPriceFils','taxRateBps',product->'taxRateBps','grossFils',line_gross,'netFils',line_gross-line_tax,'taxFils',line_tax));
 end loop;
 card:=(req->>'recordedCardFils')::bigint;cash:=gross-card;
 if cash>0 then payments:=payments||jsonb_build_array(jsonb_build_object('method','cash','amountFils',cash));end if;
 if card>0 then payments:=payments||jsonb_build_array(jsonb_build_object('method','card','amountFils',card));end if;
 return jsonb_build_object('calculationVersion','offline-line-v1','lines',lines,'totals',jsonb_build_object('grossFils',gross,'netFils',gross-tax,'taxFils',tax),'payments',payments,'cashTenderedFils',req->'cashTenderedFils','changeFils',(req->>'cashTenderedFils')::bigint-cash,'requiresBuyerDetails',gross>1000000);
end $$;

-- A code is an unresolved custody obstacle, not a manager-editable status. Decisions
-- never delete claims/conflicts/raw records or transform them into cancellation rows.
create function public.pos_offline_payment_obstacle(p_freeze uuid) returns text language plpgsql volatile security definer set search_path='' as $$
declare f public.pos_offline_payment_freezes;g public.pos_offline_authorities;c public.pos_offline_intent_claims;p jsonb;begin
 select * into f from public.pos_offline_payment_freezes where id=p_freeze;if not found then return 'case_unknown';end if;
 select * into g from public.pos_offline_authorities where id=f.authority_id;
 if exists(select 1 from public.pos_offline_raw_evidence where key_epoch=g.key_epoch) then return 'unsupported_text';end if;
 if exists(select 1 from public.pos_offline_payment_conflicts x join public.pos_offline_authorities a on a.id=x.authority_id where a.key_epoch=g.key_epoch)
 or exists(select 1 from public.pos_offline_exceptions x join public.pos_offline_authorities a on a.id=x.authority_id where a.key_epoch=g.key_epoch and not exists(select 1 from public.pos_offline_exception_resolutions z where z.exception_id=x.id)) then return 'conflict';end if;
 p:=public.pos_offline_payload(f.proof_envelope);select * into c from public.pos_offline_intent_claims where payment_intent_id=f.payment_intent_id;
 if c.payment_intent_id is null or c.claim_type<>'frozen_intent' or c.authority_id<>g.id or c.key_epoch<>g.key_epoch or c.organization_id<>g.organization_id or c.branch_id<>g.branch_id or c.order_id::text is distinct from p->>'orderId' or c.document_id::text is distinct from p->>'documentId' or c.payload_sha256<>f.payload_sha256 then return 'identity';end if;
 if exists(select 1 from public.pos_offline_receipts r where r.payment_intent_id=c.payment_intent_id or r.issuance_id=c.order_id or r.document_id=c.document_id)
 or exists(select 1 from public.pos_orders o where o.id=c.order_id)
 or exists(select 1 from public.pos_documents d where d.id=c.document_id or d.order_id=c.order_id)
 or exists(select 1 from public.pos_request_cancellations x where x.kind='sale' and x.request_id=c.order_id) then return 'identity';end if;
 return null;
end $$;

create function public.pos_offline_payment_decide(p_actor uuid,p_request jsonb,p_confirmed_at timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare f public.pos_offline_payment_freezes;g public.pos_offline_authorities;d public.pos_offline_payment_decisions;s public.pos_offline_payment_result_signatures;
 v_request uuid;v_freeze uuid;h text;p jsonb;quote jsonb;leg jsonb;planned jsonb;observed timestamptz;completed timestamptz;accepted timestamptz;resolution jsonb;resolution_id uuid:=gen_random_uuid();method_n text;cash bigint;code text;
begin
 if not coalesce(public.pos_offline_exact_fields(p_request,array['requestId','freezeId','freezeSha256','decision','reason','evidence','cashDrawerShiftId']),false) then raise exception 'POS_OFFLINE_DECISION_INVALID';end if;
 v_request:=public.pos_offline_uuid(p_request->'requestId');v_freeze:=public.pos_offline_uuid(p_request->'freezeId');
 if jsonb_typeof(p_request->'freezeSha256') is distinct from 'string' or p_request->>'freezeSha256' !~ '^[a-f0-9]{64}$' or coalesce(p_request->>'decision','') not in ('funds_returned','payment_voided') then raise exception 'POS_OFFLINE_DECISION_INVALID';end if;
 if octet_length(public.pos_offline_canonical(p_request))>16384 then raise exception 'POS_OFFLINE_DECISION_INVALID';end if;
 h:=encode(sha256(convert_to(public.pos_offline_canonical(p_request),'UTF8')),'hex');
 select * into f from public.pos_offline_payment_freezes where id=v_freeze;if not found then raise exception 'POS_ACCESS_DENIED';end if;
 select * into g from public.pos_offline_authorities where id=f.authority_id;
 perform public.pos_offline_actor(p_actor,g.branch_id,true); -- holds authority15 BEFORE any financial lock.
 -- Namespace33 is reserved for manager request identity across every case/branch.
 perform pg_advisory_xact_lock(hashtextextended(v_request::text,33));
 select * into d from public.pos_offline_payment_decisions where request_id=v_request;
 if found then
  if d.actor_id<>p_actor or d.freeze_id<>v_freeze or d.request_payload<>p_request or d.request_sha256<>h then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;
  select x.* into s from public.pos_offline_payment_result_signatures x where x.resolution_id=d.id;
  return jsonb_build_object('resolution',d.resolution,'resolutionEnvelope',s.envelope,'replayed',true);
 end if;
 p:=public.pos_offline_payload(f.proof_envelope);
 perform pg_advisory_xact_lock(hashtextextended(f.payment_intent_id::text,31));perform pg_advisory_xact_lock(hashtextextended(p->>'orderId',0));
 perform 1 from public.pos_devices where id=g.device_id for update;perform 1 from public.pos_shifts where id=g.shift_id for update;
 perform 1 from public.pos_offline_key_epochs where id=g.key_epoch for update;select * into g from public.pos_offline_authorities where id=g.id for update;
 perform pg_advisory_xact_lock(hashtextextended(p->>'documentId',32));select * into f from public.pos_offline_payment_freezes where id=v_freeze for update;
 if exists(select 1 from public.pos_offline_payment_decisions where freeze_id=f.id) then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;
 accepted:=clock_timestamp();
 if p_confirmed_at is null or not isfinite(p_confirmed_at) or p_confirmed_at>accepted or p_confirmed_at<accepted-interval '120 seconds' then raise exception 'POS_OFFLINE_CONFIRMATION_REQUIRED';end if;
 perform 1 from public.pos_offline_payment_resolution_policy where branch_id=g.branch_id and enabled for share;
 if not found then raise exception 'POS_OFFLINE_RESOLUTION_DISABLED';end if;
 if p_request->>'freezeSha256' is distinct from f.payload_sha256 then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;
 code:=public.pos_offline_payment_obstacle(f.id);if code is not null then raise exception 'POS_OFFLINE_PAYMENT_CONFLICT';end if;
 quote:=public.pos_offline_payment_quote(f.id);cash:=(quote#>>'{totals,grossFils}')::bigint-(f.request_payload->>'recordedCardFils')::bigint;
 perform public.pos_offline_payment_text(p_request->'reason',240);
 if jsonb_typeof(p_request->'evidence') is distinct from 'array' or jsonb_array_length(p_request->'evidence')<>jsonb_array_length(quote->'payments') then raise exception 'POS_OFFLINE_DECISION_INVALID';end if;
 if p_request->>'decision'='payment_voided' and (cash<>0 or jsonb_array_length(quote->'payments')<>1) then raise exception 'POS_OFFLINE_DECISION_INVALID';end if;
 if cash>0 then
  if public.pos_offline_uuid(p_request->'cashDrawerShiftId')<>g.shift_id or not exists(select 1 from public.pos_shifts where id=g.shift_id and status='open') then raise exception 'POS_OFFLINE_DRAWER_INVALID';end if;
 elsif p_request->'cashDrawerShiftId' is distinct from 'null'::jsonb then raise exception 'POS_OFFLINE_DRAWER_INVALID';end if;
 for leg,planned in select a.value,b.value from jsonb_array_elements(p_request->'evidence') with ordinality a(value,n) join jsonb_array_elements(quote->'payments') with ordinality b(value,n) using(n) loop
  if not coalesce(public.pos_offline_exact_fields(leg,array['method','amountFils','paymentObservedAt','completedAt','reference','note']),false) or leg->>'method' is distinct from planned->>'method' or public.pos_offline_integer(leg->'amountFils',1,100000000)<>(planned->>'amountFils')::bigint then raise exception 'POS_OFFLINE_DECISION_INVALID';end if;
  observed:=public.pos_offline_instant(leg->'paymentObservedAt');completed:=public.pos_offline_instant(leg->'completedAt');
  -- Native intent time is diagnostic and can be wrong. Do not backdate or silently
  -- modify either attested time to fit it. These are manager assertions, not processor proof.
  if observed>completed or completed>accepted then raise exception 'POS_OFFLINE_DECISION_INVALID';end if;
  perform public.pos_offline_payment_text(leg->'reference',120);perform public.pos_offline_payment_text(leg->'note',400);
 end loop;
 accepted:=date_trunc('milliseconds',accepted);
 resolution:=jsonb_build_object('kind','offline-payment-resolution','schemaVersion',1,'purpose','reconciliation-only','resolutionId',resolution_id,'requestId',v_request,'freezeId',f.id,'freezeSha256',f.payload_sha256,'paymentIntentId',f.payment_intent_id,'requestSha256',p->'requestSha256','orderId',p->'orderId','documentId',p->'documentId','organizationId',g.organization_id,'branchId',g.branch_id,'deviceId',g.device_id,'actorId',g.actor_id,'shiftId',g.shift_id,'keyEpoch',g.key_epoch,'authorityId',g.id,'authoritySha256',p->'authoritySha256','snapshotSha256',p->'snapshotSha256','managerActorId',p_actor,'decision',p_request->'decision','evidenceSha256',encode(sha256(convert_to(public.pos_offline_canonical(p_request->'evidence'),'UTF8')),'hex'),'resolvedAt',to_char(accepted at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'replacement',null);
 insert into public.pos_offline_payment_decisions(id,freeze_id,request_id,actor_id,authority_id,request_payload,request_sha256,decision,evidence,confirmed_at,accepted_at,resolution,resolution_sha256)
 values(resolution_id,f.id,v_request,p_actor,g.id,p_request,h,p_request->>'decision',p_request->'evidence',p_confirmed_at,accepted,resolution,encode(sha256(convert_to(public.pos_offline_canonical(resolution),'UTF8')),'hex'));
 return jsonb_build_object('resolution',resolution,'resolutionEnvelope',null,'replayed',false);
end $$;

create function public.pos_offline_payment_attach(p_resolution uuid,p_envelope jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.pos_offline_payment_decisions;f public.pos_offline_payment_freezes;g public.pos_offline_authorities;s public.pos_offline_payment_result_signatures;p jsonb;h text;begin
 select * into d from public.pos_offline_payment_decisions where id=p_resolution;if not found then raise exception 'POS_OFFLINE_RESOLUTION_UNKNOWN';end if;
 select * into f from public.pos_offline_payment_freezes where id=d.freeze_id;select * into g from public.pos_offline_authorities where id=d.authority_id;
 p:=public.pos_offline_payload(f.proof_envelope);
 perform pg_advisory_xact_lock(hashtextextended(f.payment_intent_id::text,31));perform pg_advisory_xact_lock(hashtextextended(p->>'orderId',0));
 perform 1 from public.pos_devices where id=g.device_id for update;perform 1 from public.pos_shifts where id=g.shift_id for update;
 perform 1 from public.pos_offline_key_epochs where id=g.key_epoch for update;perform 1 from public.pos_offline_authorities where id=g.id for update;
 perform pg_advisory_xact_lock(hashtextextended(p->>'documentId',32));perform 1 from public.pos_offline_payment_freezes where id=f.id for update;
 select * into d from public.pos_offline_payment_decisions where id=p_resolution for update;
 p:=public.pos_offline_payload(p_envelope);h:=encode(sha256(public.pos_offline_bytes(p_envelope->>'payloadBase64Url')),'hex');
 if p is distinct from d.resolution or h<>d.resolution_sha256 or convert_from(public.pos_offline_bytes(p_envelope->>'payloadBase64Url'),'UTF8')<>public.pos_offline_canonical(d.resolution) then raise exception 'POS_OFFLINE_RESOLUTION_CHANGED';end if;
 -- Signature verification uses current pinned server keys in the trusted service,
 -- allowing legitimate rotation. SQL binds exact immutable payload bytes, not key name.
 insert into public.pos_offline_payment_result_signatures(resolution_id,payload_sha256,envelope) values(d.id,h,p_envelope) on conflict(resolution_id) do nothing;
 select x.* into s from public.pos_offline_payment_result_signatures x where x.resolution_id=d.id;
 return jsonb_build_object('resolution',d.resolution,'resolutionEnvelope',s.envelope);
end $$;

create or replace function public.pos_offline_payment_hold(p_epoch uuid) returns boolean language sql volatile security definer set search_path='' as $$
 select exists(select 1 from public.pos_offline_payment_freezes f join public.pos_offline_authorities g on g.id=f.authority_id where g.key_epoch=p_epoch
 and not exists(select 1 from public.pos_offline_payment_decisions d join public.pos_offline_payment_result_signatures s on s.resolution_id=d.id where d.freeze_id=f.id))
 or exists(select 1 from public.pos_offline_payment_conflicts c join public.pos_offline_authorities g on g.id=c.authority_id where g.key_epoch=p_epoch)
 or exists(select 1 from public.pos_offline_raw_evidence r where r.key_epoch=p_epoch)
$$;

create function public.pos_offline_payment_summary(p_kind text,p_case uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare f public.pos_offline_payment_freezes;r public.pos_offline_raw_evidence;g public.pos_offline_authorities;d public.pos_offline_payment_decisions;
 p jsonb;state_n text;gross bigint;card bigint;stamp timestamptz;freeze_id uuid;freeze_hash text;intent_id uuid;order_id uuid;document_id uuid;device_name text;
begin
 if p_kind='freeze' then
  select * into f from public.pos_offline_payment_freezes where id=p_case;if not found then return null;end if;
  select * into g from public.pos_offline_authorities where id=f.authority_id;select x.* into d from public.pos_offline_payment_decisions x where x.freeze_id=f.id;
  p:=public.pos_offline_payload(f.proof_envelope);stamp:=f.registered_at;freeze_id:=f.id;freeze_hash:=f.payload_sha256;intent_id:=f.payment_intent_id;order_id:=(p->>'orderId')::uuid;document_id:=(p->>'documentId')::uuid;
  gross:=(f.request_payload->>'presentedTotalFils')::bigint;card:=(f.request_payload->>'recordedCardFils')::bigint;
  if public.pos_offline_payment_obstacle(f.id) is not null then state_n:='conflict';
  elsif d.id is null then state_n:='pending';
  elsif exists(select 1 from public.pos_offline_payment_result_signatures where resolution_id=d.id) then state_n:='resolved';else state_n:='delivery_pending';end if;
 elsif p_kind='raw' then
  select * into r from public.pos_offline_raw_evidence where id=p_case;if not found then return null;end if;
  select * into g from public.pos_offline_authorities where id=r.authority_id;stamp:=r.created_at;freeze_id:=r.freeze_id;freeze_hash:=case when r.kind='freeze' then r.payload_sha256 else null end;
  intent_id:=r.payment_intent_id;order_id:=r.order_id;document_id:=r.document_id;state_n:='unsupported_text';
 else raise exception 'POS_OFFLINE_CASE_KIND_INVALID';end if;
 select name into device_name from public.pos_devices where id=g.device_id;
 return jsonb_build_object('caseId',p_case,'caseKind',p_kind,'freezeId',freeze_id,'freezeSha256',freeze_hash,'authorityId',g.id,'paymentIntentId',intent_id,'orderId',order_id,'documentId',document_id,'branchId',g.branch_id,'deviceId',g.device_id,'deviceName',device_name,'actorId',g.actor_id,'shiftId',g.shift_id,'recordedAt',to_char(stamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'state',state_n,'grossFils',gross,'cashFils',gross-card,'cardFils',card,'decision',d.decision,'resolutionId',d.id);
end $$;

create function public.pos_offline_payment_list(p_actor uuid,p_branch uuid,p_cursor jsonb default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare item record;items jsonb:='[]';summary jsonb;cursor_time timestamptz;cursor_id uuid;cursor_kind text;last_cursor jsonb;next_cursor jsonb;n integer:=0;stamp text;
begin
 perform public.pos_offline_actor(p_actor,p_branch,true);
 if p_cursor is not null and p_cursor<>'null'::jsonb then
  if not coalesce(public.pos_offline_exact_fields(p_cursor,array['recordedAt','caseId','caseKind']),false) then raise exception 'POS_OFFLINE_CURSOR_INVALID';end if;
  stamp:=p_cursor->>'recordedAt';cursor_kind:=p_cursor->>'caseKind';cursor_id:=public.pos_offline_uuid(p_cursor->'caseId');
  if jsonb_typeof(p_cursor->'recordedAt') is distinct from 'string' or stamp !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' or coalesce(cursor_kind,'') not in ('freeze','raw') then raise exception 'POS_OFFLINE_CURSOR_INVALID';end if;
  cursor_time:=stamp::timestamptz;if to_char(cursor_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')<>stamp then raise exception 'POS_OFFLINE_CURSOR_INVALID';end if;
 end if;
 for item in
  select x.id,x.kind,x.stamp from (
   select f.id,'freeze'::text kind,f.registered_at stamp from public.pos_offline_payment_freezes f join public.pos_offline_authorities g on g.id=f.authority_id where g.branch_id=p_branch
   union all select r.id,'raw'::text,r.created_at from public.pos_offline_raw_evidence r where r.branch_id=p_branch
  ) x where cursor_time is null or (x.stamp,x.id,x.kind)<(cursor_time,cursor_id,cursor_kind) order by x.stamp desc,x.id desc,x.kind desc limit 51
 loop
  n:=n+1;if n=51 then next_cursor:=last_cursor;exit;end if;
  summary:=public.pos_offline_payment_summary(item.kind,item.id);items:=items||jsonb_build_array(summary);
  last_cursor:=jsonb_build_object('recordedAt',summary->'recordedAt','caseId',item.id,'caseKind',item.kind);
 end loop;
 return jsonb_build_object('cases',items,'nextCursor',next_cursor);
end $$;

create function public.pos_offline_payment_detail(p_actor uuid,p_branch uuid,p_case uuid,p_kind text) returns jsonb language plpgsql security definer set search_path='' as $$
declare summary jsonb;f public.pos_offline_payment_freezes;g public.pos_offline_authorities;d public.pos_offline_payment_decisions;s public.pos_offline_payment_result_signatures;
 quote jsonb;conflicts jsonb;truncated boolean;policy_on boolean;shift_open boolean;hold_code text;
begin
 perform public.pos_offline_actor(p_actor,p_branch,true);
 if p_kind='freeze' then select a.* into g from public.pos_offline_payment_freezes x join public.pos_offline_authorities a on a.id=x.authority_id where x.id=p_case and a.branch_id=p_branch;
 elsif p_kind='raw' then select a.* into g from public.pos_offline_raw_evidence x join public.pos_offline_authorities a on a.id=x.authority_id where x.id=p_case and a.branch_id=p_branch;
 else raise exception 'POS_OFFLINE_CASE_KIND_INVALID';end if;
 if g.id is null then raise exception 'POS_OFFLINE_CASE_UNKNOWN';end if;
 summary:=public.pos_offline_payment_summary(p_kind,p_case);
 policy_on:=exists(select 1 from public.pos_offline_payment_resolution_policy where branch_id=p_branch and enabled);
 shift_open:=exists(select 1 from public.pos_shifts where id=g.shift_id and status='open');
 if p_kind='freeze' then
  select * into f from public.pos_offline_payment_freezes where id=p_case;select x.* into d from public.pos_offline_payment_decisions x where x.freeze_id=f.id;
  select x.* into s from public.pos_offline_payment_result_signatures x where x.resolution_id=d.id;
  hold_code:=public.pos_offline_payment_obstacle(f.id);
  begin quote:=public.pos_offline_payment_quote(f.id);exception when others then hold_code:='invalid_evidence';end;
  if hold_code is null and d.id is not null then hold_code:='decision_recorded';end if;
  if hold_code is null and (f.request_payload->>'presentedTotalFils')::bigint>(f.request_payload->>'recordedCardFils')::bigint and not shift_open then hold_code:='original_shift_closed';end if;
  if hold_code is null and not policy_on then hold_code:='resolution_disabled';end if;
 else hold_code:='unsupported_text';end if;
 with all_conflicts as (
  select x.id,x.code,x.payload_sha256,x.created_at from public.pos_offline_payment_conflicts x join public.pos_offline_authorities a on a.id=x.authority_id where a.key_epoch=g.key_epoch
  union all select x.id,'unsupported_text',x.payload_sha256,x.created_at from public.pos_offline_raw_evidence x where x.key_epoch=g.key_epoch
  union all select x.id,x.code,x.payload_sha256,x.created_at from public.pos_offline_exceptions x join public.pos_offline_authorities a on a.id=x.authority_id where a.key_epoch=g.key_epoch and not exists(select 1 from public.pos_offline_exception_resolutions z where z.exception_id=x.id)
 ), page as (select * from all_conflicts order by created_at desc,id desc limit 50)
 select coalesce((select jsonb_agg(jsonb_build_object('conflictId',id,'code',code,'payloadSha256',payload_sha256,'createdAt',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by created_at desc,id desc) from page),'[]'::jsonb),(select count(*)>50 from all_conflicts) into conflicts,truncated;
 return jsonb_build_object('summary',summary,'freezeEnvelope',f.proof_envelope,'request',f.request_payload,'quote',quote,'conflicts',conflicts,'conflictsTruncated',truncated,'decisionRequest',d.request_payload,'resolution',d.resolution,'resolutionEnvelope',s.envelope,'capabilities',jsonb_build_object('policyEnabled',policy_on,'originalShiftOpen',shift_open,'canDecide',hold_code is null,'holdCode',hold_code));
end $$;

-- Independent authenticated-manager request budgets. No role lookup or role oracle;
-- the server calls only after getUser and separately limits password confirmation.
create table public.pos_offline_manager_windows (
 kind text not null check(kind in ('actor','source')),bucket text not null,window_started timestamptz not null,count integer not null check(count between 1 and 1000000),primary key(kind,bucket)
);
alter table public.pos_offline_manager_windows enable row level security;
revoke all on public.pos_offline_manager_windows from public,anon,authenticated,service_role;
create function public.pos_offline_manager_limit(p_actor uuid,p_source text) returns boolean language plpgsql security definer set search_path='' as $$
declare stamp timestamptz:=date_trunc('minute',clock_timestamp());n integer;begin
 if p_actor is null or p_source is null or p_source !~ '^[a-f0-9]{64}$' then return false;end if;
 insert into public.pos_offline_manager_windows(kind,bucket,window_started,count) values('actor',p_actor::text,stamp,1)
 on conflict(kind,bucket) do update set window_started=excluded.window_started,count=case when pos_offline_manager_windows.window_started=excluded.window_started then least(pos_offline_manager_windows.count+1,1000000) else 1 end returning count into n;
 if n>60 then return false;end if;
 insert into public.pos_offline_manager_windows(kind,bucket,window_started,count) values('source',p_source,stamp,1)
 on conflict(kind,bucket) do update set window_started=excluded.window_started,count=case when pos_offline_manager_windows.window_started=excluded.window_started then least(pos_offline_manager_windows.count+1,1000000) else 1 end returning count into n;
 delete from public.pos_offline_manager_windows where ctid in (select ctid from public.pos_offline_manager_windows where window_started<stamp-interval '2 minutes' limit 100 for update skip locked);
 return n<=120;
end $$;

do $$declare f regprocedure;begin
 foreach f in array array['public.pos_offline_payment_quote(uuid)'::regprocedure,'public.pos_offline_payment_obstacle(uuid)'::regprocedure,'public.pos_offline_payment_decide(uuid,jsonb,timestamp with time zone)'::regprocedure,'public.pos_offline_payment_attach(uuid,jsonb)'::regprocedure,'public.pos_offline_payment_hold(uuid)'::regprocedure,'public.pos_offline_payment_summary(text,uuid)'::regprocedure,'public.pos_offline_payment_list(uuid,uuid,jsonb)'::regprocedure,'public.pos_offline_payment_detail(uuid,uuid,uuid,text)'::regprocedure,'public.pos_offline_manager_limit(uuid,text)'::regprocedure] loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 end loop;
end $$;
grant execute on function public.pos_offline_payment_decide(uuid,jsonb,timestamptz),public.pos_offline_payment_attach(uuid,jsonb),public.pos_offline_payment_list(uuid,uuid,jsonb),public.pos_offline_payment_detail(uuid,uuid,uuid,text),public.pos_offline_manager_limit(uuid,text) to service_role;
