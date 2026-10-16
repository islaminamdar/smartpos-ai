-- Candidate raw evidence custody only. No invoice, acknowledgement, cancellation,
-- manager resolution, new authority or enabled feature is produced by this migration.
-- The trusted service MUST first verify the enrolled signature, exact canonical bytes,
-- complete historical schema and snapshot arithmetic. PostgreSQL jsonb cannot represent
-- U+0000; decoded evidence therefore remains JSON text inside the original ASCII envelope.
lock table public.pos_offline_intent_claims,public.pos_offline_receipts,public.pos_orders,public.pos_documents,public.pos_request_cancellations in share row exclusive mode;
alter table public.pos_offline_intent_claims drop constraint pos_offline_intent_claims_claim_type_check;
alter table public.pos_offline_intent_claims add constraint pos_offline_intent_claims_claim_type_check check(claim_type in ('historical_receipt','frozen_intent','quarantined_evidence'));
create table public.pos_offline_raw_evidence (
 id uuid primary key default gen_random_uuid(),authority_id uuid not null references public.pos_offline_authorities,
 key_epoch uuid not null references public.pos_offline_key_epochs,organization_id uuid not null,branch_id uuid not null,
 device_id uuid not null,actor_id uuid not null,shift_id uuid not null,
 payment_intent_id uuid not null,order_id uuid not null,document_id uuid not null,freeze_id uuid,
 kind text not null check(kind in ('freeze','issuance')),reason text not null check(reason='unsupported_text'),
 payload_sha256 text not null check(payload_sha256 ~ '^[a-f0-9]{64}$'),envelope jsonb not null,
 claimed boolean not null,created_at timestamptz not null default clock_timestamp(),
 unique(authority_id,payload_sha256),check((kind='freeze')=(freeze_id is not null))
);
create index pos_offline_raw_epoch on public.pos_offline_raw_evidence(key_epoch);
create index pos_offline_raw_intent on public.pos_offline_raw_evidence(payment_intent_id);
create index pos_offline_raw_order on public.pos_offline_raw_evidence(order_id);
create index pos_offline_raw_document on public.pos_offline_raw_evidence(document_id);
alter table public.pos_offline_raw_evidence enable row level security;
revoke all on public.pos_offline_raw_evidence from public,anon,authenticated,service_role;
create trigger pos_offline_raw_evidence_immutable before update or delete on public.pos_offline_raw_evidence for each row execute function public.pos_preserve_document();

-- json preserves escaped NUL without trying to materialize a PostgreSQL text NUL.
-- Read only a unique named member. Never cast the entire payload/document/customer to jsonb.
create function public.pos_offline_raw_field(p json,p_key text) returns json language plpgsql immutable set search_path='' as $$
declare raw bytea:=convert_to(p::text,'UTF8');n integer:=octet_length(raw);i integer:=1;start_n integer;key_n text;result json;count_n integer:=0;depth_n integer;inside_string boolean;escaped boolean;ch integer;
begin
 if json_typeof(p) is distinct from 'object' or n>1048576 or get_byte(raw,0)<>123 or get_byte(raw,n-1)<>125 then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;
 -- PostgreSQL json_each/json->> decode ALL nested strings and also fail on NUL.
 -- Slice an already JSON-validated UTF-8 object by structural ASCII bytes instead.
 -- No decoded customer string, surrogate or unsafe key enters a PostgreSQL text value.
 while i<n-1 loop
  if get_byte(raw,i)<>34 then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;
  start_n:=i;i:=i+1;escaped:=false;
  while i<n loop
   ch:=get_byte(raw,i);
   if escaped then escaped:=false;elsif ch=92 then escaped:=true;elsif ch=34 then exit;end if;i:=i+1;
  end loop;
  if i>=n then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;
  key_n:=(convert_from(substring(raw from start_n+1 for i-start_n+1),'UTF8')::json)#>>'{}';
  if key_n !~ '^[A-Za-z][A-Za-z0-9]*$' then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;
  i:=i+1;if get_byte(raw,i)<>58 then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;
  i:=i+1;start_n:=i;depth_n:=0;inside_string:=false;escaped:=false;
  while i<n loop
   ch:=get_byte(raw,i);
   if inside_string then
    if escaped then escaped:=false;elsif ch=92 then escaped:=true;elsif ch=34 then inside_string:=false;end if;
   elsif ch=34 then inside_string:=true;
   elsif ch in (123,91) then depth_n:=depth_n+1;
   elsif ch in (125,93) then if depth_n=0 then exit;else depth_n:=depth_n-1;end if;
   elsif ch=44 and depth_n=0 then exit;
   end if;i:=i+1;
  end loop;
  if key_n=p_key then count_n:=count_n+1;result:=convert_from(substring(raw from start_n+1 for i-start_n),'UTF8')::json;end if;
  if i>=n then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;
  if get_byte(raw,i)=125 then if i<>n-1 then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;exit;end if;
  i:=i+1;
 end loop;
 if count_n<>1 then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;return result;
end $$;
create function public.pos_offline_raw_string(p json,p_key text) returns text language plpgsql immutable set search_path='' as $$
declare v json:=public.pos_offline_raw_field(p,p_key);s text;begin
 if json_typeof(v) is distinct from 'string' then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;
 s:=v#>>'{}';return s;
end $$;
create function public.pos_offline_raw_uuid(p json,p_key text) returns uuid language plpgsql immutable set search_path='' as $$
begin return public.pos_offline_uuid(to_jsonb(public.pos_offline_raw_string(p,p_key)));end $$;
create function public.pos_offline_raw_payload(p_envelope jsonb) returns json language plpgsql immutable set search_path='' as $$
declare raw text;p json;begin
 if not coalesce(public.pos_offline_exact_fields(p_envelope,array['format','alg','keyId','payloadBase64Url','signatureBase64Url']),false)
 or p_envelope->>'format' is distinct from 'pos-signed-v1' or p_envelope->>'alg' is distinct from 'ECDSA-P256-SHA256-DER'
 or jsonb_typeof(p_envelope->'keyId') is distinct from 'string' or coalesce(p_envelope->>'keyId','') !~ '^[a-f0-9]{64}$'
 or jsonb_typeof(p_envelope->'signatureBase64Url') is distinct from 'string' or coalesce(p_envelope->>'signatureBase64Url','') !~ '^[A-Za-z0-9_-]{1,96}$'
 or jsonb_typeof(p_envelope->'payloadBase64Url') is distinct from 'string' then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;
 raw:=convert_from(public.pos_offline_bytes(p_envelope->>'payloadBase64Url'),'UTF8');p:=raw::json;
 if json_typeof(p) is distinct from 'object' then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;
 -- An odd final backslash before u0000 denotes a decoded NUL. An escaped literal
 -- backslash followed by the six printed characters does not qualify for this path.
 if raw !~ $pattern$(^|[^\\])(\\\\)*\\u0000$pattern$ then raise exception 'POS_OFFLINE_UNSUPPORTED_TEXT_REQUIRED';end if;
 return p;
end $$;

create function public.pos_offline_retain_unsupported(p_authority uuid,p_envelope jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare p json:=public.pos_offline_raw_payload(p_envelope);d json;req json;g public.pos_offline_authorities;e public.pos_offline_key_epochs;b public.pos_offline_signed_bundles;
 evidence public.pos_offline_raw_evidence;kind_n text:=public.pos_offline_raw_string(p,'kind');v_order uuid;v_document uuid;v_intent uuid:=public.pos_offline_raw_uuid(p,'paymentIntentId');v_freeze uuid;
 h text:=encode(sha256(public.pos_offline_bytes(p_envelope->>'payloadBase64Url')),'hex');owns_claim boolean:=false;
begin
 if public.pos_offline_raw_uuid(p,'authorityId') is distinct from p_authority or public.pos_offline_raw_field(p,'schemaVersion')::text<>'1' then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;
 if kind_n='offline-payment-freeze' then
  v_order:=public.pos_offline_raw_uuid(p,'orderId');v_document:=public.pos_offline_raw_uuid(p,'documentId');v_freeze:=public.pos_offline_raw_uuid(p,'freezeId');
 elsif kind_n='offline-sale' then
  v_order:=public.pos_offline_raw_uuid(p,'id');d:=public.pos_offline_raw_field(p,'document');v_document:=public.pos_offline_raw_uuid(d,'id');
  if public.pos_offline_raw_uuid(d,'orderId')<>v_order or public.pos_offline_raw_field(d,'schemaVersion')::text<>'1' or public.pos_offline_raw_string(d,'kind')<>'tax_invoice' then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;
 else raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;
 select * into g from public.pos_offline_authorities where id=p_authority;if not found then raise exception 'POS_OFFLINE_AUTHORITY_UNKNOWN';end if;
 perform pg_advisory_xact_lock(hashtextextended(v_intent::text,31));
 perform pg_advisory_xact_lock(hashtextextended(v_order::text,0));
 perform 1 from public.pos_devices where id=g.device_id for update;
 perform 1 from public.pos_shifts where id=g.shift_id for update;
 select * into e from public.pos_offline_key_epochs where id=g.key_epoch for update;
 select * into g from public.pos_offline_authorities where id=p_authority for update;
 perform pg_advisory_xact_lock(hashtextextended(v_document::text,32));
 select * into b from public.pos_offline_signed_bundles where authority_id=g.id;
 if b.authority_id is null or p_envelope->>'keyId' is distinct from e.device_key_sha256
 or public.pos_offline_raw_string(p,'authoritySha256') is distinct from b.authority_sha256 or public.pos_offline_raw_string(p,'snapshotSha256') is distinct from b.snapshot_sha256 then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;
 if kind_n='offline-payment-freeze' then
  if public.pos_offline_raw_uuid(p,'organizationId')<>g.organization_id or public.pos_offline_raw_uuid(p,'branchId')<>g.branch_id or public.pos_offline_raw_uuid(p,'deviceId')<>g.device_id or public.pos_offline_raw_uuid(p,'actorId')<>g.actor_id or public.pos_offline_raw_uuid(p,'shiftId')<>g.shift_id or public.pos_offline_raw_uuid(p,'keyEpoch')<>e.id or public.pos_offline_raw_string(p,'deviceKeySha256')<>e.device_key_sha256
  or public.pos_offline_raw_string(p,'declaration')<>'local-intent-unissued-and-permanently-frozen' then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;
  req:=public.pos_offline_raw_field(p,'request');
  if public.pos_offline_raw_uuid(req,'authorityId')<>g.id or public.pos_offline_raw_string(p,'requestSha256')<>encode(sha256(convert_to(req::text,'UTF8')),'hex') then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;
 else
  if public.pos_offline_raw_uuid(d,'branchId')<>g.branch_id or public.pos_offline_raw_uuid(d,'deviceId')<>g.device_id or public.pos_offline_raw_uuid(d,'actorId')<>g.actor_id or public.pos_offline_raw_uuid(d,'shiftId')<>g.shift_id then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;
  req:=public.pos_offline_raw_field(d,'merchant');
  if public.pos_offline_raw_uuid(req,'organizationId')<>g.organization_id or public.pos_offline_raw_uuid(req,'branchId')<>g.branch_id then raise exception 'POS_OFFLINE_INVALID_RAW_EVIDENCE';end if;
 end if;
 select * into evidence from public.pos_offline_raw_evidence where authority_id=g.id and payload_sha256=h;
 if found then return jsonb_build_object('status','reconciliation_required','exceptionId',evidence.id,'code','unsupported_text');end if;
 -- Existing financial/claim identities always win. A collision retains only incoming
 -- evidence and its own scope hold; it never discloses or rewrites another receipt.
 if not exists(select 1 from public.pos_offline_intent_claims c where c.payment_intent_id=v_intent or c.order_id=v_order or c.document_id=v_document)
 and not exists(select 1 from public.pos_orders o where o.id=v_order)
 and not exists(select 1 from public.pos_documents x where x.id=v_document or x.order_id=v_order)
 and not exists(select 1 from public.pos_request_cancellations x where x.kind='sale' and x.request_id=v_order) then
  begin
   insert into public.pos_offline_intent_claims(payment_intent_id,order_id,document_id,authority_id,key_epoch,organization_id,branch_id,claim_type,payload_sha256)
   values(v_intent,v_order,v_document,g.id,e.id,g.organization_id,g.branch_id,'quarantined_evidence',h);
   owns_claim:=true;
  exception when unique_violation then owns_claim:=false;end;
 end if;
 insert into public.pos_offline_raw_evidence(authority_id,key_epoch,organization_id,branch_id,device_id,actor_id,shift_id,payment_intent_id,order_id,document_id,freeze_id,kind,reason,payload_sha256,envelope,claimed)
 values(g.id,e.id,g.organization_id,g.branch_id,g.device_id,g.actor_id,g.shift_id,v_intent,v_order,v_document,v_freeze,case kind_n when 'offline-payment-freeze' then 'freeze' else 'issuance' end,'unsupported_text',h,p_envelope,owns_claim) returning * into evidence;
 return jsonb_build_object('status','reconciliation_required','exceptionId',evidence.id,'code','unsupported_text');
end $$;

-- Existing SQL018 close/seal/renewal guards call this helper. Exact original seal
-- retries remain recoverable; new completion never silently clears raw evidence.
create or replace function public.pos_offline_payment_hold(p_epoch uuid) returns boolean language sql volatile security definer set search_path='' as $$
 select exists(select 1 from public.pos_offline_payment_freezes f join public.pos_offline_authorities g on g.id=f.authority_id where g.key_epoch=p_epoch)
 or exists(select 1 from public.pos_offline_payment_conflicts c join public.pos_offline_authorities g on g.id=c.authority_id where g.key_epoch=p_epoch)
 or exists(select 1 from public.pos_offline_raw_evidence r where r.key_epoch=p_epoch)
$$;

-- Ordinary writes must also respect unclaimed identities of incoming own-branch
-- evidence. A conflicting proof never changes a foreign claim or its authority hold.
create or replace function public.pos_offline_guard_claimed_identity() returns trigger language plpgsql security definer set search_path='' as $$
declare c public.pos_offline_intent_claims;r public.pos_offline_receipts;begin
 if tg_table_name='pos_documents' then
  perform pg_advisory_xact_lock(hashtextextended(new.id::text,32));
  if exists(select 1 from public.pos_offline_intent_claims where claim_type in ('frozen_intent','quarantined_evidence') and (order_id=new.order_id or document_id=new.id)) then raise exception 'POS_OFFLINE_PAYMENT_HOLD';end if;
  if exists(select 1 from public.pos_offline_raw_evidence x where x.organization_id=new.organization_id and x.branch_id=new.branch_id and (x.document_id=new.id or (new.kind='tax_invoice' and x.order_id=new.order_id))) then raise exception 'POS_OFFLINE_PAYMENT_HOLD';end if;
  select * into c from public.pos_offline_intent_claims where document_id=new.id;
  if found then
   select * into r from public.pos_offline_receipts where document_id=new.id;
   if r.issuance_id is null or c.claim_type<>'historical_receipt' or new.order_id<>c.order_id or new.organization_id<>c.organization_id or new.branch_id<>c.branch_id or new.kind<>'tax_invoice' or new.snapshot<>public.pos_offline_payload(r.envelope)->'document' or new.request_payload<>public.pos_offline_payload(r.envelope) then raise exception 'POS_OFFLINE_CLAIM_COLLISION';end if;
  end if;
 elsif tg_table_name='pos_orders' then
  perform pg_advisory_xact_lock(hashtextextended(new.id::text,0));
  if exists(select 1 from public.pos_offline_raw_evidence x where x.organization_id=new.organization_id and x.branch_id=new.branch_id and x.order_id=new.id) then raise exception 'POS_OFFLINE_PAYMENT_HOLD';end if;
  select * into c from public.pos_offline_intent_claims where order_id=new.id;
  if found then
   select * into r from public.pos_offline_receipts where issuance_id=new.id;
   if c.claim_type<>'historical_receipt' or r.issuance_id is null or new.organization_id<>c.organization_id or new.branch_id<>c.branch_id or new.request_payload<>public.pos_offline_payload(r.envelope) then raise exception 'POS_OFFLINE_CLAIM_COLLISION';end if;
  end if;
 else
  if new.kind='sale' then
   perform pg_advisory_xact_lock(hashtextextended(new.request_id::text,0));
   if exists(select 1 from public.pos_offline_raw_evidence x where x.organization_id=new.organization_id and x.branch_id=new.branch_id and x.order_id=new.request_id) then raise exception 'POS_OFFLINE_PAYMENT_HOLD';end if;
   if exists(select 1 from public.pos_offline_intent_claims where order_id=new.request_id) then raise exception 'POS_OFFLINE_CLAIM_COLLISION';end if;
  end if;
 end if;return new;
end $$;

alter function public.pos_offline_import(uuid,jsonb,jsonb) rename to pos_offline_import_before_raw_evidence;
revoke all on function public.pos_offline_import_before_raw_evidence(uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
create function public.pos_offline_import(p_authority uuid,p_envelope jsonb,p_ack_envelope jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare p jsonb:=public.pos_offline_payload(p_envelope);g public.pos_offline_authorities;
 v_intent uuid:=(p->>'paymentIntentId')::uuid;v_order uuid:=(p->>'id')::uuid;v_document uuid:=(p#>>'{document,id}')::uuid;
 h text:=encode(sha256(public.pos_offline_bytes(p_envelope->>'payloadBase64Url')),'hex');begin
 select * into g from public.pos_offline_authorities where id=p_authority;if not found then raise exception 'POS_OFFLINE_AUTHORITY_UNKNOWN';end if;
 perform pg_advisory_xact_lock(hashtextextended(v_intent::text,31));perform pg_advisory_xact_lock(hashtextextended(v_order::text,0));
 perform 1 from public.pos_devices where id=g.device_id for update;perform 1 from public.pos_shifts where id=g.shift_id for update;
 perform 1 from public.pos_offline_key_epochs where id=g.key_epoch for update;select * into g from public.pos_offline_authorities where id=p_authority for update;
 perform pg_advisory_xact_lock(hashtextextended(v_document::text,32));
 -- A later contradictory raw proof must not destroy exact receipt/first-ACK recovery.
 if exists(select 1 from public.pos_offline_receipts r where r.authority_id=g.id and r.key_epoch=g.key_epoch and r.payment_intent_id=v_intent and r.issuance_id=v_order and r.document_id=v_document and r.payload_sha256=h) then
  return public.pos_offline_import_before_raw_evidence(p_authority,p_envelope,p_ack_envelope);
 end if;
 if exists(select 1 from public.pos_offline_intent_claims c where c.claim_type='quarantined_evidence' and (c.payment_intent_id=v_intent or c.order_id=v_order or c.document_id=v_document))
 or exists(select 1 from public.pos_offline_raw_evidence r where r.authority_id=g.id and (r.payment_intent_id=v_intent or r.order_id=v_order or r.document_id=v_document)) then
  if p_envelope->>'keyId' is distinct from (select device_key_sha256 from public.pos_offline_key_epochs where id=g.key_epoch) then raise exception 'POS_OFFLINE_INVALID_PROOF';end if;
  return public.pos_offline_exception(g.id,'collision',p_envelope);
 end if;
 return public.pos_offline_import_before_raw_evidence(p_authority,p_envelope,p_ack_envelope);
end $$;

alter function public.pos_offline_payment_freeze(jsonb) rename to pos_offline_payment_freeze_before_raw_evidence;
revoke all on function public.pos_offline_payment_freeze_before_raw_evidence(jsonb) from public,anon,authenticated,service_role;
create function public.pos_offline_payment_freeze(p_envelope jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare p jsonb:=public.pos_offline_payload(p_envelope);g public.pos_offline_authorities;
 v_authority uuid:=public.pos_offline_uuid(p->'authorityId');v_intent uuid:=public.pos_offline_uuid(p->'paymentIntentId');v_order uuid:=public.pos_offline_uuid(p->'orderId');v_document uuid:=public.pos_offline_uuid(p->'documentId');v_freeze uuid:=public.pos_offline_uuid(p->'freezeId');
 h text:=encode(sha256(public.pos_offline_bytes(p_envelope->>'payloadBase64Url')),'hex');event uuid;begin
 select * into g from public.pos_offline_authorities where id=v_authority;if not found then raise exception 'POS_OFFLINE_AUTHORITY_UNKNOWN';end if;
 perform pg_advisory_xact_lock(hashtextextended(v_intent::text,31));perform pg_advisory_xact_lock(hashtextextended(v_order::text,0));
 perform 1 from public.pos_devices where id=g.device_id for update;perform 1 from public.pos_shifts where id=g.shift_id for update;
 perform 1 from public.pos_offline_key_epochs where id=g.key_epoch for update;select * into g from public.pos_offline_authorities where id=v_authority for update;
 perform pg_advisory_xact_lock(hashtextextended(v_document::text,32));
 if exists(select 1 from public.pos_offline_raw_evidence r where r.authority_id=g.id and (r.payment_intent_id=v_intent or r.order_id=v_order or r.document_id=v_document)) then
  if p_envelope->>'keyId' is distinct from (select device_key_sha256 from public.pos_offline_key_epochs where id=g.key_epoch) then raise exception 'POS_OFFLINE_INVALID_PROOF';end if;
  event:=public.pos_offline_payment_conflict(g.id,v_freeze,v_intent,'identity',p_envelope);
  return jsonb_build_object('status','conflict','conflictId',event,'code','identity','freezeId',v_freeze,'freezeSha256',h,'authorityId',g.id);
 end if;
 return public.pos_offline_payment_freeze_before_raw_evidence(p_envelope);
end $$;

do $$declare f regprocedure;begin
 foreach f in array array['public.pos_offline_raw_field(json,text)'::regprocedure,'public.pos_offline_raw_string(json,text)'::regprocedure,'public.pos_offline_raw_uuid(json,text)'::regprocedure,'public.pos_offline_raw_payload(jsonb)'::regprocedure,'public.pos_offline_retain_unsupported(uuid,jsonb)'::regprocedure,'public.pos_offline_payment_hold(uuid)'::regprocedure,'public.pos_offline_guard_claimed_identity()'::regprocedure,'public.pos_offline_import(uuid,jsonb,jsonb)'::regprocedure,'public.pos_offline_payment_freeze(jsonb)'::regprocedure] loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 end loop;
end $$;
grant execute on function public.pos_offline_retain_unsupported(uuid,jsonb),public.pos_offline_import(uuid,jsonb,jsonb),public.pos_offline_payment_freeze(jsonb) to service_role;
