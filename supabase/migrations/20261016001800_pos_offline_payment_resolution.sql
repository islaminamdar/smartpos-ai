-- Candidate foundation ONLY: no manager decision, invoice replacement, HTTP route or live enablement.
-- The service MUST verify enrolled-device signatures before these service-role RPCs.
-- SQL independently validates canonical bytes, historical scope/arithmetic and custody uniqueness.
lock table public.pos_offline_receipts,public.pos_orders,public.pos_documents,public.pos_request_cancellations in share row exclusive mode;

create table public.pos_offline_intent_claims (
 payment_intent_id uuid primary key,order_id uuid not null unique,document_id uuid not null unique,
 authority_id uuid not null references public.pos_offline_authorities,key_epoch uuid not null references public.pos_offline_key_epochs,
 organization_id uuid not null,branch_id uuid not null,claim_type text not null check(claim_type in ('historical_receipt','frozen_intent')),
 payload_sha256 text not null check(payload_sha256 ~ '^[a-f0-9]{64}$'),created_at timestamptz not null default clock_timestamp()
);
create table public.pos_offline_payment_freezes (
 id uuid primary key,payment_intent_id uuid not null unique references public.pos_offline_intent_claims,
 authority_id uuid not null references public.pos_offline_authorities,payload_sha256 text not null check(payload_sha256 ~ '^[a-f0-9]{64}$'),
 proof_envelope jsonb not null,request_payload jsonb not null,registered_at timestamptz not null default clock_timestamp()
);
create table public.pos_offline_payment_conflicts (
 id uuid primary key default gen_random_uuid(),authority_id uuid not null references public.pos_offline_authorities,
 freeze_id uuid,payment_intent_id uuid,code text not null check(code in ('identity','already_issued','invalid_request','scope','canonical','calculation','payment','intent_frozen','storage_conflict','closed_state')),
 payload_sha256 text not null check(payload_sha256 ~ '^[a-f0-9]{64}$'),evidence jsonb not null,created_at timestamptz not null default clock_timestamp(),
 unique(authority_id,code,payload_sha256)
);
create index pos_offline_payment_freezes_authority on public.pos_offline_payment_freezes(authority_id);
create index pos_offline_payment_conflicts_authority on public.pos_offline_payment_conflicts(authority_id);
create index pos_offline_payment_conflicts_freeze on public.pos_offline_payment_conflicts(authority_id,freeze_id);
do $$declare t text;begin
 foreach t in array array['pos_offline_intent_claims','pos_offline_payment_freezes','pos_offline_payment_conflicts'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 execute format('create trigger %I before update or delete on public.%I for each row execute function public.pos_preserve_document()',t||'_immutable',t);
 end loop;
end $$;

-- All financial protocol object keys are ASCII. Sorting ASCII keys in C order exactly
-- matches native/JS UTF-16 key order; Unicode VALUES are retained without normalization.
create function public.pos_offline_canonical(p jsonb,p_depth integer default 0) returns text language plpgsql immutable set search_path='' as $$
declare value text;begin
 if p is null or p_depth>32 then raise exception 'canonical';end if;
 case jsonb_typeof(p)
 when 'object' then
  if exists(select 1 from jsonb_object_keys(p) k where k !~ '^[A-Za-z][A-Za-z0-9]*$') then raise exception 'canonical';end if;
  select '{'||coalesce(string_agg(to_jsonb(k)::text||':'||public.pos_offline_canonical(v,p_depth+1),',' order by k collate "C"),'')||'}' into value from jsonb_each(p) x(k,v);
 when 'array' then
  select '['||coalesce(string_agg(public.pos_offline_canonical(v,p_depth+1),',' order by n),'')||']' into value from jsonb_array_elements(p) with ordinality x(v,n);
 when 'number' then
  value:=p::text;if value !~ '^(0|[1-9][0-9]*|-[1-9][0-9]*)$' or abs(value::numeric)>9007199254740991 then raise exception 'canonical';end if;
 when 'string','boolean','null' then value:=p::text;
 else raise exception 'canonical';end case;
 if octet_length(value)>1048576 then raise exception 'canonical';end if;return value;
end $$;
create function public.pos_offline_exact_fields(p jsonb,fields text[]) returns boolean language sql immutable set search_path='' as $$
 select jsonb_typeof(p)='object' and p ?& fields and (p-fields)='{}'::jsonb
$$;
create function public.pos_offline_integer(p jsonb,minimum bigint,maximum bigint) returns bigint language plpgsql immutable set search_path='' as $$
declare n bigint;begin
 if jsonb_typeof(p) is distinct from 'number' or p::text !~ '^(0|[1-9][0-9]*)$' then raise exception 'invalid_request';end if;
 n:=(p::text)::bigint;if n<minimum or n>maximum then raise exception 'invalid_request';end if;return n;
end $$;
create function public.pos_offline_uuid(p jsonb) returns uuid language plpgsql immutable set search_path='' as $$
declare s text:=p#>>'{}';begin
 if jsonb_typeof(p) is distinct from 'string' or s !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'invalid_request';end if;return s::uuid;
end $$;
create function public.pos_offline_instant(p jsonb) returns timestamptz language plpgsql immutable set search_path='' as $$
declare s text:=p#>>'{}';stamp timestamptz;begin
 if jsonb_typeof(p) is distinct from 'string' or s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then raise exception 'invalid_request';end if;
 stamp:=s::timestamptz;if to_char(stamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>s then raise exception 'invalid_request';end if;return stamp;
end $$;
create function public.pos_offline_payment_text(p jsonb,maximum integer) returns text language plpgsql immutable set search_path='' as $$
declare s text:=p#>>'{}';units integer;trims text:=E'\t\n\f\r '||chr(11)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279);begin
 if jsonb_typeof(p) is distinct from 'string' or s='' or btrim(s,trims)<>s then raise exception 'invalid_request';end if;
 select coalesce(sum(case when ascii(substr(s,n,1))>65535 then 2 else 1 end),0) into units from generate_series(1,length(s)) n;
 if units>maximum then raise exception 'invalid_request';end if;return s;
end $$;

-- Backfill is atomic with guard installation. Do not normalize or repair prior receipts.
do $$begin
 if exists(select 1 from public.pos_offline_receipts r left join public.pos_orders o on o.id=r.issuance_id left join public.pos_documents d on d.id=r.document_id left join public.pos_offline_authorities g on g.id=r.authority_id
 where o.id is null or d.id is null or g.id is null or o.organization_id<>r.organization_id or o.branch_id<>r.branch_id or d.order_id<>r.issuance_id or d.organization_id<>r.organization_id or d.branch_id<>r.branch_id or d.document_number<>r.document_number or d.kind<>'tax_invoice' or g.key_epoch<>r.key_epoch
 or public.pos_offline_payload(r.envelope)->>'id' is distinct from r.issuance_id::text or public.pos_offline_payload(r.envelope)->>'paymentIntentId' is distinct from r.payment_intent_id::text or public.pos_offline_payload(r.envelope)->'document' is distinct from d.snapshot
 or encode(sha256(public.pos_offline_bytes(r.envelope->>'payloadBase64Url')),'hex')<>r.payload_sha256) then raise exception 'POS_OFFLINE_CLAIM_BACKFILL_INVALID';end if;
 insert into public.pos_offline_intent_claims(payment_intent_id,order_id,document_id,authority_id,key_epoch,organization_id,branch_id,claim_type,payload_sha256)
 select payment_intent_id,issuance_id,document_id,authority_id,key_epoch,organization_id,branch_id,'historical_receipt',payload_sha256 from public.pos_offline_receipts;
end $$;

create function public.pos_offline_payment_hold(p_epoch uuid) returns boolean language sql volatile security definer set search_path='' as $$
 select exists(select 1 from public.pos_offline_payment_freezes f join public.pos_offline_authorities g on g.id=f.authority_id where g.key_epoch=p_epoch)
 or exists(select 1 from public.pos_offline_payment_conflicts c join public.pos_offline_authorities g on g.id=c.authority_id where g.key_epoch=p_epoch)
$$;
create function public.pos_offline_payment_conflict(p_authority uuid,p_freeze uuid,p_intent uuid,p_code text,p_envelope jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare h text:=encode(sha256(public.pos_offline_bytes(p_envelope->>'payloadBase64Url')),'hex');event uuid;begin
 insert into public.pos_offline_payment_conflicts(authority_id,freeze_id,payment_intent_id,code,payload_sha256,evidence) values(p_authority,p_freeze,p_intent,p_code,h,p_envelope)
 on conflict(authority_id,code,payload_sha256) do nothing returning id into event;
 if event is null then select id into event from public.pos_offline_payment_conflicts where authority_id=p_authority and code=p_code and payload_sha256=h;end if;return event;
end $$;

-- Unique claim insertion is inside SQL017 import's financial subtransaction. A failure
-- rolls it back together with receipts/orders/payments; it cannot leave a ghost claim.
create function public.pos_offline_claim_receipt() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.document_id::text,32));
 insert into public.pos_offline_intent_claims(payment_intent_id,order_id,document_id,authority_id,key_epoch,organization_id,branch_id,claim_type,payload_sha256)
 values(new.payment_intent_id,new.issuance_id,new.document_id,new.authority_id,new.key_epoch,new.organization_id,new.branch_id,'historical_receipt',new.payload_sha256);
 return new;
end $$;
create trigger pos_offline_receipt_claim before insert on public.pos_offline_receipts for each row execute function public.pos_offline_claim_receipt();
create function public.pos_offline_guard_claimed_identity() returns trigger language plpgsql security definer set search_path='' as $$
declare c public.pos_offline_intent_claims;r public.pos_offline_receipts;begin
 if tg_table_name='pos_documents' then
  perform pg_advisory_xact_lock(hashtextextended(new.id::text,32));
  if exists(select 1 from public.pos_offline_intent_claims where claim_type='frozen_intent' and (order_id=new.order_id or document_id=new.id)) then raise exception 'POS_OFFLINE_PAYMENT_HOLD';end if;
  select * into c from public.pos_offline_intent_claims where document_id=new.id;
  if found then
   select * into r from public.pos_offline_receipts where document_id=new.id;
   if r.issuance_id is null or c.claim_type<>'historical_receipt' or new.order_id<>c.order_id or new.organization_id<>c.organization_id or new.branch_id<>c.branch_id or new.kind<>'tax_invoice' or new.snapshot<>public.pos_offline_payload(r.envelope)->'document' or new.request_payload<>public.pos_offline_payload(r.envelope) then raise exception 'POS_OFFLINE_CLAIM_COLLISION';end if;
  end if;
 elsif tg_table_name='pos_orders' then
  perform pg_advisory_xact_lock(hashtextextended(new.id::text,0));
  select * into c from public.pos_offline_intent_claims where order_id=new.id;
  if found then
   select * into r from public.pos_offline_receipts where issuance_id=new.id;
   if c.claim_type<>'historical_receipt' or r.issuance_id is null or new.organization_id<>c.organization_id or new.branch_id<>c.branch_id or new.request_payload<>public.pos_offline_payload(r.envelope) then raise exception 'POS_OFFLINE_CLAIM_COLLISION';end if;
  end if;
 else
  if new.kind='sale' then
   perform pg_advisory_xact_lock(hashtextextended(new.request_id::text,0));
   if exists(select 1 from public.pos_offline_intent_claims where order_id=new.request_id) then raise exception 'POS_OFFLINE_CLAIM_COLLISION';end if;
  end if;
 end if;return new;
end $$;
create trigger pos_offline_claim_order_guard before insert on public.pos_orders for each row execute function public.pos_offline_guard_claimed_identity();
create trigger pos_offline_claim_document_guard before insert on public.pos_documents for each row execute function public.pos_offline_guard_claimed_identity();
create trigger pos_offline_claim_cancel_guard before insert on public.pos_request_cancellations for each row execute function public.pos_offline_guard_claimed_identity();

create function public.pos_offline_validate_payment_freeze(p_envelope jsonb,p_authority uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare p jsonb:=public.pos_offline_payload(p_envelope);g public.pos_offline_authorities;e public.pos_offline_key_epochs;b public.pos_offline_signed_bundles;
 req jsonb;head jsonb;obs jsonb;line jsonb;product jsonb;field text;quantity bigint;gross bigint:=0;tax bigint:=0;line_gross bigint;line_tax bigint;cash bigint;card bigint;presented bigint;sequence_n bigint;
begin
 select * into g from public.pos_offline_authorities where id=p_authority;select * into e from public.pos_offline_key_epochs where id=g.key_epoch;select * into b from public.pos_offline_signed_bundles where authority_id=g.id;
 if g.id is null or e.id is null or b.authority_id is null then raise exception 'scope';end if;
 if public.pos_offline_canonical(p)<>convert_from(public.pos_offline_bytes(p_envelope->>'payloadBase64Url'),'UTF8') then raise exception 'canonical';end if;
 if not coalesce(public.pos_offline_exact_fields(p,array['kind','schemaVersion','freezeId','paymentIntentId','orderId','documentId','organizationId','branchId','deviceId','actorId','shiftId','keyEpoch','deviceKeySha256','authorityId','authoritySha256','snapshotSha256','requestSha256','request','intentCreatedAt','chainHead','observation','declaration']),false)
 or p->>'kind' is distinct from 'offline-payment-freeze' or p->'schemaVersion' is distinct from '1'::jsonb or p->>'declaration' is distinct from 'local-intent-unissued-and-permanently-frozen' then raise exception 'invalid_request';end if;
 foreach field in array array['freezeId','paymentIntentId','orderId','documentId','organizationId','branchId','deviceId','actorId','shiftId','keyEpoch','authorityId'] loop perform public.pos_offline_uuid(p->field);end loop;
 foreach field in array array['deviceKeySha256','authoritySha256','snapshotSha256','requestSha256'] loop if jsonb_typeof(p->field) is distinct from 'string' or p->>field !~ '^[a-f0-9]{64}$' then raise exception 'invalid_request';end if;end loop;
 if p->>'authorityId' is distinct from g.id::text or p->>'organizationId' is distinct from g.organization_id::text or p->>'branchId' is distinct from g.branch_id::text or p->>'deviceId' is distinct from g.device_id::text or p->>'actorId' is distinct from g.actor_id::text or p->>'shiftId' is distinct from g.shift_id::text or p->>'keyEpoch' is distinct from e.id::text or p->>'deviceKeySha256' is distinct from e.device_key_sha256 or p_envelope->>'keyId' is distinct from e.device_key_sha256 or p->>'authoritySha256' is distinct from b.authority_sha256 or p->>'snapshotSha256' is distinct from b.snapshot_sha256 then raise exception 'scope';end if;
 perform public.pos_offline_instant(p->'intentCreatedAt'); -- Evidence only: no clock/expiry gate.
 head:=p->'chainHead';if not coalesce(public.pos_offline_exact_fields(head,array['sequence','eventSha256']),false) then raise exception 'invalid_request';end if;
 sequence_n:=public.pos_offline_integer(head->'sequence',0,9007199254740991);
 if (sequence_n=0 and head->'eventSha256' is distinct from 'null'::jsonb) or (sequence_n>0 and (jsonb_typeof(head->'eventSha256') is distinct from 'string' or head->>'eventSha256' !~ '^[a-f0-9]{64}$')) then raise exception 'invalid_request';end if;
 obs:=p->'observation';if obs<>'null'::jsonb then
  if not coalesce(public.pos_offline_exact_fields(obs,array['bootId','elapsedRealtimeMs','wallTimeMs']),false) then raise exception 'invalid_request';end if;
  perform public.pos_offline_uuid(obs->'bootId');perform public.pos_offline_integer(obs->'elapsedRealtimeMs',0,9007199254740991);perform public.pos_offline_integer(obs->'wallTimeMs',0,253402300799999);
 end if;
 req:=p->'request';if not coalesce(public.pos_offline_exact_fields(req,array['authorityId','serviceType','customer','lines','cashTenderedFils','recordedCardFils','presentedTotalFils']),false) or req->>'authorityId' is distinct from g.id::text or coalesce(req->>'serviceType','') not in ('dine_in','takeaway','delivery') then raise exception 'invalid_request';end if;
 if octet_length(public.pos_offline_canonical(req))>131072 or encode(sha256(convert_to(public.pos_offline_canonical(req),'UTF8')),'hex') is distinct from p->>'requestSha256' then raise exception 'canonical';end if;
 if req->'customer'<>'null'::jsonb then
  if not coalesce(public.pos_offline_exact_fields(req->'customer',array['name','address','trn']),false) then raise exception 'invalid_request';end if;
  perform public.pos_offline_payment_text(req#>'{customer,name}',200);perform public.pos_offline_payment_text(req#>'{customer,address}',400);
  if req#>'{customer,trn}'<>'null'::jsonb and (jsonb_typeof(req#>'{customer,trn}') is distinct from 'string' or req#>>'{customer,trn}' !~ '^[0-9]{15}$') then raise exception 'invalid_request';end if;
 end if;
 cash:=public.pos_offline_integer(req->'cashTenderedFils',0,100000000);card:=public.pos_offline_integer(req->'recordedCardFils',0,100000000);presented:=public.pos_offline_integer(req->'presentedTotalFils',1,100000000);
 if jsonb_typeof(req->'lines') is distinct from 'array' or jsonb_array_length(req->'lines') not between 1 and 200 or (select count(distinct x->>'productId') from jsonb_array_elements(req->'lines') x)<>jsonb_array_length(req->'lines') then raise exception 'calculation';end if;
 for line in select value from jsonb_array_elements(req->'lines') loop
  if not coalesce(public.pos_offline_exact_fields(line,array['productId','quantityMilli']),false) then raise exception 'invalid_request';end if;
  perform public.pos_offline_uuid(line->'productId');quantity:=public.pos_offline_integer(line->'quantityMilli',1,1000000);
  select value into product from jsonb_array_elements(g.snapshot->'products') where value->>'id'=line->>'productId';
  if product is null or (product->>'unit'<>'kg' and quantity%1000<>0) then raise exception 'calculation';end if;
  line_gross:=((product->>'unitPriceFils')::bigint*quantity+500)/1000;
  line_tax:=(line_gross*(product->>'taxRateBps')::bigint*2+10000+(product->>'taxRateBps')::bigint)/(2*(10000+(product->>'taxRateBps')::bigint));
  if line_gross>100000000 then raise exception 'calculation';end if;gross:=gross+line_gross;tax:=tax+line_tax;
 end loop;
 if gross<>presented or gross not between 1 and 100000000 or gross>(g.authority->>'maxInvoiceTotalFils')::bigint or gross>(g.authority->>'maxGrossFils')::bigint or (gross>1000000 and req->'customer'='null'::jsonb) then raise exception 'calculation';end if;
 if card>gross or cash<gross-card or (card=gross and cash<>0) or (card>0 and not(g.authority#>>'{permissions,recordedCard}')::boolean) or (gross>card and not(g.authority#>>'{permissions,cash}')::boolean) or (card>0 and card<gross and not(g.authority#>>'{permissions,mixedTender}')::boolean) then raise exception 'payment';end if;
 return p;
end $$;

create function public.pos_offline_payment_freeze(p_envelope jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare p jsonb:=public.pos_offline_payload(p_envelope);g public.pos_offline_authorities;e public.pos_offline_key_epochs;
 f public.pos_offline_payment_freezes;c public.pos_offline_intent_claims;r public.pos_offline_receipts;
 v_authority uuid:=public.pos_offline_uuid(p->'authorityId');v_freeze uuid:=public.pos_offline_uuid(p->'freezeId');v_intent uuid:=public.pos_offline_uuid(p->'paymentIntentId');v_order uuid:=public.pos_offline_uuid(p->'orderId');v_document uuid:=public.pos_offline_uuid(p->'documentId');
 h text:=encode(sha256(public.pos_offline_bytes(p_envelope->>'payloadBase64Url')),'hex');event uuid;code text;req jsonb;doc jsonb;matched boolean:=false;has_conflicts boolean;
begin
 select * into g from public.pos_offline_authorities where id=v_authority;if not found then raise exception 'POS_OFFLINE_AUTHORITY_UNKNOWN';end if;
 perform pg_advisory_xact_lock(hashtextextended(v_intent::text,31));
 perform pg_advisory_xact_lock(hashtextextended(v_order::text,0));
 perform 1 from public.pos_devices where id=g.device_id for update;
 perform 1 from public.pos_shifts where id=g.shift_id for update;
 select * into e from public.pos_offline_key_epochs where id=g.key_epoch for update;
 select * into g from public.pos_offline_authorities where id=v_authority for update;
 perform pg_advisory_xact_lock(hashtextextended(v_document::text,32));
 -- A service must authenticate this very stored key before calling. Do not quarantine
 -- a target authority for evidence that even names a different signer.
 if p_envelope->>'keyId' is distinct from e.device_key_sha256 then raise exception 'POS_OFFLINE_INVALID_PROOF';end if;
 begin
  p:=public.pos_offline_validate_payment_freeze(p_envelope,g.id);
 exception when others then
  code:=case when sqlerrm in ('scope','canonical','calculation','payment') then sqlerrm else 'invalid_request' end;
  event:=public.pos_offline_payment_conflict(g.id,v_freeze,v_intent,code,p_envelope);
  return jsonb_build_object('status','conflict','conflictId',event,'code',code,'freezeId',v_freeze,'freezeSha256',h,'authorityId',g.id);
 end;
 select * into f from public.pos_offline_payment_freezes where id=v_freeze;
 if found then
  if f.authority_id=g.id and f.payment_intent_id=v_intent and f.payload_sha256=h then
   has_conflicts:=exists(select 1 from public.pos_offline_payment_conflicts x where x.authority_id=g.id);
   return jsonb_build_object('status','registered','freezeId',f.id,'freezeSha256',f.payload_sha256,'paymentIntentId',f.payment_intent_id,'authorityId',f.authority_id,'replayed',true,'hasConflicts',has_conflicts);
  end if;
  event:=public.pos_offline_payment_conflict(g.id,v_freeze,v_intent,'identity',p_envelope);
  return jsonb_build_object('status','conflict','conflictId',event,'code','identity','freezeId',v_freeze,'freezeSha256',h,'authorityId',g.id);
 end if;
 -- Query every matching identity; never disclose a receipt merely because one ID matched.
 for c in select * from public.pos_offline_intent_claims x where x.payment_intent_id=v_intent or x.order_id=v_order or x.document_id=v_document loop
  if c.claim_type<>'historical_receipt' or c.authority_id<>g.id or c.key_epoch<>e.id or c.organization_id<>g.organization_id or c.branch_id<>g.branch_id or c.payment_intent_id<>v_intent or c.order_id<>v_order or c.document_id<>v_document then
   event:=public.pos_offline_payment_conflict(g.id,v_freeze,v_intent,'identity',p_envelope);
   return jsonb_build_object('status','conflict','conflictId',event,'code','identity','freezeId',v_freeze,'freezeSha256',h,'authorityId',g.id);
  end if;
  select * into r from public.pos_offline_receipts where issuance_id=c.order_id;
  if r.issuance_id is null or r.authority_id<>g.id or r.payment_intent_id<>v_intent or r.document_id<>v_document or r.payload_sha256<>c.payload_sha256 then raise exception 'POS_OFFLINE_STORAGE_UNAVAILABLE';end if;
  doc:=public.pos_offline_payload(r.envelope)->'document';
  req:=jsonb_build_object('authorityId',g.id,'serviceType',doc->'serviceType','customer',doc->'customer','lines',(select jsonb_agg(jsonb_build_object('productId',x->'productId','quantityMilli',x->'quantityMilli') order by n) from jsonb_array_elements(doc->'lines') with ordinality t(x,n)),'cashTenderedFils',doc->'cashTenderedFils','recordedCardFils',coalesce((select sum((x->>'amountFils')::bigint) from jsonb_array_elements(doc->'payments') x where x->>'method'='card'),0),'presentedTotalFils',doc#>'{totals,grossFils}');
  if req<>p->'request' or public.pos_offline_payload(r.envelope)->>'authoritySha256' is distinct from p->>'authoritySha256' or public.pos_offline_payload(r.envelope)->>'snapshotSha256' is distinct from p->>'snapshotSha256' then
   event:=public.pos_offline_payment_conflict(g.id,v_freeze,v_intent,'identity',p_envelope);
   return jsonb_build_object('status','conflict','conflictId',event,'code','identity','freezeId',v_freeze,'freezeSha256',h,'authorityId',g.id);
  end if;matched:=true;
 end loop;
 if matched then
  event:=public.pos_offline_payment_conflict(g.id,v_freeze,v_intent,'already_issued',p_envelope);
  return jsonb_build_object('status','already_issued','freezeId',v_freeze,'freezeSha256',h,'authorityId',g.id,'conflictId',event,'issuanceEnvelope',r.envelope,'receipt',doc,'acknowledgement',r.acknowledgement);
 end if;
 if exists(select 1 from public.pos_orders where id=v_order) or exists(select 1 from public.pos_documents where id=v_document or order_id=v_order) or exists(select 1 from public.pos_request_cancellations where kind='sale' and request_id=v_order) then
  event:=public.pos_offline_payment_conflict(g.id,v_freeze,v_intent,'identity',p_envelope);
  return jsonb_build_object('status','conflict','conflictId',event,'code','identity','freezeId',v_freeze,'freezeSha256',h,'authorityId',g.id);
 end if;
 begin
  insert into public.pos_offline_intent_claims(payment_intent_id,order_id,document_id,authority_id,key_epoch,organization_id,branch_id,claim_type,payload_sha256)
  values(v_intent,v_order,v_document,g.id,e.id,g.organization_id,g.branch_id,'frozen_intent',h);
  insert into public.pos_offline_payment_freezes(id,payment_intent_id,authority_id,payload_sha256,proof_envelope,request_payload) values(v_freeze,v_intent,g.id,h,p_envelope,p->'request');
 exception when unique_violation then
  event:=public.pos_offline_payment_conflict(g.id,v_freeze,v_intent,'identity',p_envelope);
  return jsonb_build_object('status','conflict','conflictId',event,'code','identity','freezeId',v_freeze,'freezeSha256',h,'authorityId',g.id);
 end;
 if g.sealed_at is not null or exists(select 1 from public.pos_shifts where id=g.shift_id and status<>'open') then
  perform public.pos_offline_payment_conflict(g.id,v_freeze,v_intent,'closed_state',p_envelope);
 end if;
 has_conflicts:=exists(select 1 from public.pos_offline_payment_conflicts x where x.authority_id=g.id);
 return jsonb_build_object('status','registered','freezeId',v_freeze,'freezeSha256',h,'paymentIntentId',v_intent,'authorityId',g.id,'replayed',false,'hasConflicts',has_conflicts);
end $$;

create function public.pos_offline_payment_case(p_authority uuid,p_freeze uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('freezeId',f.id,'freezeSha256',f.payload_sha256,'paymentIntentId',f.payment_intent_id,'authorityId',f.authority_id,'proofEnvelope',f.proof_envelope,
 'registeredAt',to_char(f.registered_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'conflictsTruncated',(select count(*)>50 from public.pos_offline_payment_conflicts x where x.authority_id=f.authority_id),
 'conflicts',coalesce((select jsonb_agg(jsonb_build_object('conflictId',c.id,'code',c.code,'payloadSha256',c.payload_sha256,'createdAt',to_char(c.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by c.created_at desc,c.id desc)
 from (select x.* from public.pos_offline_payment_conflicts x where x.authority_id=f.authority_id order by x.created_at desc,x.id desc limit 50) c),'[]'::jsonb))
 from public.pos_offline_payment_freezes f where f.id=p_freeze and f.authority_id=p_authority
$$;

alter function public.pos_offline_import(uuid,jsonb,jsonb) rename to pos_offline_import_before_payment_freeze;
revoke all on function public.pos_offline_import_before_payment_freeze(uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
create function public.pos_offline_import(p_authority uuid,p_envelope jsonb,p_ack_envelope jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare p jsonb:=public.pos_offline_payload(p_envelope);g public.pos_offline_authorities;c public.pos_offline_intent_claims;f public.pos_offline_payment_freezes;result jsonb;
 v_intent uuid:=(p->>'paymentIntentId')::uuid;v_order uuid:=(p->>'id')::uuid;v_document uuid:=(p#>>'{document,id}')::uuid;begin
 select * into g from public.pos_offline_authorities where id=p_authority;if not found then raise exception 'POS_OFFLINE_AUTHORITY_UNKNOWN';end if;
 perform pg_advisory_xact_lock(hashtextextended(v_intent::text,31));
 perform pg_advisory_xact_lock(hashtextextended(v_order::text,0));
 perform 1 from public.pos_devices where id=g.device_id for update;
 perform 1 from public.pos_shifts where id=g.shift_id for update;
 perform 1 from public.pos_offline_key_epochs where id=g.key_epoch for update;
 select * into g from public.pos_offline_authorities where id=p_authority for update;
 perform pg_advisory_xact_lock(hashtextextended(v_document::text,32));
 for c in select * from public.pos_offline_intent_claims x where x.payment_intent_id=v_intent or x.order_id=v_order or x.document_id=v_document loop
  if c.claim_type='frozen_intent' then
   select * into f from public.pos_offline_payment_freezes where payment_intent_id=c.payment_intent_id;
   -- Hold only the authority whose stored key authenticated this upload. Never return
   -- another authority's evidence through a global identity collision.
   if p_envelope->>'keyId' is distinct from (select device_key_sha256 from public.pos_offline_key_epochs where id=g.key_epoch) then raise exception 'POS_OFFLINE_INVALID_PROOF';end if;
   perform public.pos_offline_payment_conflict(g.id,case when f.authority_id=g.id then f.id else null end,v_intent,'intent_frozen',p_envelope);
   return public.pos_offline_exception(g.id,'collision',p_envelope);
  end if;
 end loop;
 -- SQL017 owns exact-receipt replay and every financial check/write. The new trigger
 -- creates the global claim inside its existing rollback-protected receipt insertion.
 return public.pos_offline_import_before_payment_freeze(p_authority,p_envelope,p_ack_envelope);
end $$;

alter function public.pos_offline_seal(uuid,bigint,text,jsonb) rename to pos_offline_seal_before_payment_freeze;
revoke all on function public.pos_offline_seal_before_payment_freeze(uuid,bigint,text,jsonb) from public,anon,authenticated,service_role;
create function public.pos_offline_seal(p_authority uuid,p_final_sequence bigint,p_final_hash text,p_signed_evidence jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.pos_offline_authorities;begin
 select * into g from public.pos_offline_authorities where id=p_authority;if not found then raise exception 'POS_OFFLINE_AUTHORITY_UNKNOWN';end if;
 perform 1 from public.pos_devices where id=g.device_id for update;perform 1 from public.pos_shifts where id=g.shift_id for update;
 perform 1 from public.pos_offline_key_epochs where id=g.key_epoch for update;select * into g from public.pos_offline_authorities where id=p_authority for update;
 if g.sealed_at is null and public.pos_offline_payment_hold(g.key_epoch) then raise exception 'POS_OFFLINE_PAYMENT_HOLD';end if;
 return public.pos_offline_seal_before_payment_freeze(p_authority,p_final_sequence,p_final_hash,p_signed_evidence);
end $$;
create function public.pos_offline_guard_payment_renewal() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if public.pos_offline_payment_hold(new.key_epoch) then raise exception 'POS_OFFLINE_PAYMENT_HOLD';end if;return new;
end $$;
create trigger pos_offline_payment_renewal_guard before insert on public.pos_offline_authorities for each row execute function public.pos_offline_guard_payment_renewal();
create or replace function public.pos_offline_guard_shift_close() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status='closed' and old.status<>'closed' then
  if exists(select 1 from public.pos_offline_authorities g where g.shift_id=new.id and public.pos_offline_payment_hold(g.key_epoch)) then raise exception 'POS_OFFLINE_PAYMENT_HOLD';end if;
  if exists(select 1 from public.pos_offline_authorities where shift_id=new.id and sealed_at is null) or exists(select 1 from public.pos_offline_exceptions x join public.pos_offline_authorities g on g.id=x.authority_id where g.shift_id=new.id and not exists(select 1 from public.pos_offline_exception_resolutions z where z.exception_id=x.id)) then raise exception 'POS_OFFLINE_CHAIN_INCOMPLETE';end if;
 end if;return new;
end $$;

do $$declare f regprocedure;begin
 foreach f in array array[
 'public.pos_offline_canonical(jsonb,integer)'::regprocedure,'public.pos_offline_exact_fields(jsonb,text[])'::regprocedure,'public.pos_offline_integer(jsonb,bigint,bigint)'::regprocedure,'public.pos_offline_uuid(jsonb)'::regprocedure,'public.pos_offline_instant(jsonb)'::regprocedure,'public.pos_offline_payment_text(jsonb,integer)'::regprocedure,
 'public.pos_offline_payment_hold(uuid)'::regprocedure,'public.pos_offline_payment_conflict(uuid,uuid,uuid,text,jsonb)'::regprocedure,'public.pos_offline_claim_receipt()'::regprocedure,'public.pos_offline_guard_claimed_identity()'::regprocedure,'public.pos_offline_validate_payment_freeze(jsonb,uuid)'::regprocedure,'public.pos_offline_payment_freeze(jsonb)'::regprocedure,'public.pos_offline_payment_case(uuid,uuid)'::regprocedure,'public.pos_offline_import(uuid,jsonb,jsonb)'::regprocedure,'public.pos_offline_seal(uuid,bigint,text,jsonb)'::regprocedure,'public.pos_offline_guard_payment_renewal()'::regprocedure,'public.pos_offline_guard_shift_close()'::regprocedure] loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 end loop;
end $$;
grant execute on function public.pos_offline_payment_freeze(jsonb),public.pos_offline_payment_case(uuid,uuid),public.pos_offline_import(uuid,jsonb,jsonb),public.pos_offline_seal(uuid,bigint,text,jsonb) to service_role;
