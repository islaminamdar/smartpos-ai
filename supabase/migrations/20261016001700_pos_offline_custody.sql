-- Disabled-by-default native offline custody. Cryptographic verification belongs to the
-- trusted server; these RPCs are service_role ONLY. No client-supplied trusted JSON RPC.
-- Never import browser training data. No existing branch is enabled by this migration.
create table public.pos_offline_branch_policy (
 branch_id uuid primary key references public.pos_branches, enabled boolean not null default false,
 max_count integer not null default 100 check(max_count between 1 and 1000),
 max_lifetime_seconds integer not null default 28800 check(max_lifetime_seconds between 60 and 86400),
 max_invoice_total_fils bigint not null default 1000000 check(max_invoice_total_fils between 1 and 100000000),
 max_gross_fils bigint not null default 10000000 check(max_gross_fils between 1 and 100000000000)
);
create table public.pos_offline_key_epochs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null,branch_id uuid not null,device_id uuid not null unique,
 public_key_spki text not null,device_key_sha256 text not null unique check(device_key_sha256 ~ '^[a-f0-9]{64}$'),
 enrolled_by uuid not null references auth.users,request_id uuid not null unique,request_payload jsonb not null,
 created_at timestamptz not null default clock_timestamp(),blocked boolean not null default false,
 last_sequence bigint not null default 0 check(last_sequence between 0 and 9007199254740991),last_event_sha256 text,
 foreign key(organization_id,branch_id,device_id) references public.pos_devices(organization_id,branch_id,id),
 check((last_sequence=0 and last_event_sha256 is null) or (last_sequence>0 and last_event_sha256 ~ '^[a-f0-9]{64}$'))
);
create table public.pos_offline_authorities (
 id uuid primary key,organization_id uuid not null,branch_id uuid not null,device_id uuid not null,
 key_epoch uuid not null references public.pos_offline_key_epochs,actor_id uuid not null references auth.users,shift_id uuid not null,
 request_payload jsonb not null,snapshot jsonb not null,authority jsonb not null,
 base_sequence bigint not null,base_event_sha256 text,invoice_count integer not null default 0 check(invoice_count between 0 and 1000),
 gross_fils bigint not null default 0 check(gross_fils between 0 and 100000000000),
 sealed_at timestamptz,seal_evidence jsonb,
 foreign key(organization_id,branch_id,device_id,shift_id) references public.pos_shifts(organization_id,branch_id,device_id,id),
 check((sealed_at is null)=(seal_evidence is null))
);
create unique index pos_offline_one_unsealed_authority on public.pos_offline_authorities(key_epoch) where sealed_at is null;
create table public.pos_offline_signed_bundles (
 authority_id uuid primary key references public.pos_offline_authorities,
 snapshot_envelope jsonb not null,authority_envelope jsonb not null,
 snapshot_sha256 text not null check(snapshot_sha256 ~ '^[a-f0-9]{64}$'),authority_sha256 text not null check(authority_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default clock_timestamp()
);
create table public.pos_offline_receipts (
 issuance_id uuid primary key,authority_id uuid not null references public.pos_offline_authorities,key_epoch uuid not null references public.pos_offline_key_epochs,
 organization_id uuid not null,branch_id uuid not null,document_id uuid not null unique,document_number text not null,
 payment_intent_id uuid not null unique,device_sequence bigint not null,payload_sha256 text not null check(payload_sha256 ~ '^[a-f0-9]{64}$'),
 envelope jsonb not null,acknowledgement jsonb not null,received_at timestamptz not null default clock_timestamp(),
 unique(key_epoch,device_sequence),unique(organization_id,document_number),
 foreign key(organization_id,branch_id,issuance_id) references public.pos_orders(organization_id,branch_id,id) deferrable initially deferred,
 foreign key(document_id) references public.pos_documents(id) deferrable initially deferred
);
create table public.pos_offline_exceptions (
 id uuid primary key default gen_random_uuid(),authority_id uuid not null references public.pos_offline_authorities,
 code text not null,evidence jsonb not null,payload_sha256 text not null check(payload_sha256 ~ '^[a-f0-9]{64}$'),created_at timestamptz not null default clock_timestamp(),
 unique(authority_id,code,payload_sha256)
);
create table public.pos_offline_exception_resolutions (
 exception_id uuid primary key references public.pos_offline_exceptions,issuance_id uuid not null references public.pos_offline_receipts,
 resolved_at timestamptz not null default clock_timestamp()
);
do $$declare t text;begin
 foreach t in array array['pos_offline_branch_policy','pos_offline_key_epochs','pos_offline_authorities','pos_offline_signed_bundles','pos_offline_receipts','pos_offline_exceptions','pos_offline_exception_resolutions'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 end loop;
 foreach t in array array['pos_offline_signed_bundles','pos_offline_receipts','pos_offline_exceptions','pos_offline_exception_resolutions'] loop
 execute format('create trigger %I before update or delete on public.%I for each row execute function public.pos_preserve_document()',t||'_immutable',t);
 end loop;
end $$;

-- Decode only. The service MUST verify canonical bytes, schema and trusted signature
-- before RPC. SQL hashes exact decoded bytes independently to bind custody identities.
create function public.pos_offline_bytes(p text) returns bytea language plpgsql immutable set search_path='' as $$
declare b bytea;begin
 if p is null or length(p)>1398102 or p !~ '^[A-Za-z0-9_-]+$' or length(p)%4=1 then raise exception 'POS_OFFLINE_INVALID_ENVELOPE';end if;
 b:=decode(translate(p,'-_','+/')||repeat('=',(4-length(p)%4)%4),'base64');
 if rtrim(translate(replace(encode(b,'base64'),E'\n',''),'+/','-_'),'=')<>p or octet_length(b)>1048576 then raise exception 'POS_OFFLINE_INVALID_ENVELOPE';end if;
 return b;
end $$;
create function public.pos_offline_payload(p jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p) is distinct from 'object' or not p ?& array['format','alg','keyId','payloadBase64Url','signatureBase64Url'] or (p-array['format','alg','keyId','payloadBase64Url','signatureBase64Url'])<>'{}'::jsonb
 or p->>'format' is distinct from 'pos-signed-v1' or p->>'alg' is distinct from 'ECDSA-P256-SHA256-DER' or coalesce(p->>'keyId','') !~ '^[A-Za-z0-9._-]{1,120}$'
 or coalesce(p->>'signatureBase64Url','') !~ '^[A-Za-z0-9_-]{1,96}$' then raise exception 'POS_OFFLINE_INVALID_ENVELOPE';end if;
 return convert_from(public.pos_offline_bytes(p->>'payloadBase64Url'),'UTF8')::jsonb;
end $$;
create function public.pos_offline_actor(p_actor uuid,p_branch uuid,p_manager boolean default false) returns uuid language plpgsql security definer set search_path='' as $$
declare org uuid;begin
 select organization_id into org from public.pos_branches where id=p_branch and active;
 if org is null or p_actor is null then raise exception 'POS_ACCESS_DENIED';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(org::text||':'||p_actor::text,15));
 if not exists(select 1 from public.pos_staff where organization_id=org and user_id=p_actor and active and (branch_id=p_branch or (branch_id is null and role in ('owner','manager'))) and (not p_manager or role in ('owner','manager'))) then raise exception 'POS_ACCESS_DENIED';end if;
 return org;
end $$;
create function public.pos_offline_enroll(p_actor uuid,p_request jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid;e public.pos_offline_key_epochs;proof jsonb;branch uuid:=(p_request->>'branchId')::uuid;device uuid:=(p_request->>'deviceId')::uuid;request uuid:=(p_request->>'requestId')::uuid;
begin
 org:=public.pos_offline_actor(p_actor,branch,true);
 if not p_request ?& array['requestId','branchId','deviceId','publicKeySpki','deviceKeySha256','proof'] or (p_request-array['requestId','branchId','deviceId','publicKeySpki','deviceKeySha256','proof'])<>'{}'::jsonb or request is null then raise exception 'POS_OFFLINE_INVALID_REQUEST';end if;
 proof:=public.pos_offline_payload(p_request->'proof');
 if proof->>'kind' is distinct from 'offline-enrollment' or proof->>'schemaVersion' is distinct from '1' or proof->>'requestId' is distinct from request::text or proof->>'actorId' is distinct from p_actor::text or proof->>'branchId' is distinct from branch::text or proof->>'deviceId' is distinct from device::text or proof->>'deviceKeySha256' is distinct from p_request->>'deviceKeySha256'
 or encode(sha256(public.pos_offline_bytes(p_request->>'publicKeySpki')),'hex') is distinct from p_request->>'deviceKeySha256' or p_request#>>'{proof,keyId}' is distinct from p_request->>'deviceKeySha256' then raise exception 'POS_OFFLINE_INVALID_PROOF';end if;
 perform pg_advisory_xact_lock(hashtextextended(request::text,17));
 select * into e from public.pos_offline_key_epochs where request_id=request;
 if found then
 if e.enrolled_by<>p_actor or e.request_payload-'proof'<>p_request-'proof' or public.pos_offline_payload(e.request_payload->'proof')<>proof then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;
 return jsonb_build_object('keyEpoch',e.id,'deviceId',e.device_id,'deviceKeySha256',e.device_key_sha256,'publicKeySpki',e.public_key_spki);
 end if;
 if not exists(select 1 from public.pos_offline_branch_policy where branch_id=branch and enabled) then raise exception 'POS_OFFLINE_DISABLED';end if;
 if (proof->>'issuedAt')::timestamptz < clock_timestamp()-interval '300 seconds' or (proof->>'issuedAt')::timestamptz>clock_timestamp()+interval '30 seconds' or proof->>'issuedAt' is null then raise exception 'POS_OFFLINE_PROOF_EXPIRED';end if;
 perform 1 from public.pos_devices where id=device and organization_id=org and branch_id=branch and active for update;
 if not found then raise exception 'POS_DEVICE_INVALID';end if;
 if exists(select 1 from public.pos_offline_key_epochs where device_id=device or device_key_sha256=p_request->>'deviceKeySha256') then raise exception 'POS_OFFLINE_KEY_ALREADY_BOUND';end if;
 insert into public.pos_offline_key_epochs(organization_id,branch_id,device_id,public_key_spki,device_key_sha256,enrolled_by,request_id,request_payload)
 values(org,branch,device,p_request->>'publicKeySpki',p_request->>'deviceKeySha256',p_actor,request,p_request) returning * into e;
 return jsonb_build_object('keyEpoch',e.id,'deviceId',e.device_id,'deviceKeySha256',e.device_key_sha256,'publicKeySpki',e.public_key_spki);
end $$;

create function public.pos_offline_reserve(p_actor uuid,p_request jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid;branch uuid:=(p_request->>'branchId')::uuid;device uuid:=(p_request->>'deviceId')::uuid;shift uuid:=(p_request->>'shiftId')::uuid;request uuid:=(p_request->>'requestId')::uuid;
 policy public.pos_offline_branch_policy;e public.pos_offline_key_epochs;g public.pos_offline_authorities;c public.pos_branch_receipt_config;profile public.pos_merchant_profiles;
 count_n integer;life integer;max_invoice bigint;max_gross bigint;last_n bigint;created timestamptz;stamp text;snapshot jsonb;authority jsonb;products jsonb;
begin
 org:=public.pos_offline_actor(p_actor,branch);
 if not p_request ?& array['requestId','branchId','deviceId','shiftId','count','lifetimeSeconds','maxInvoiceTotalFils','maxGrossFils','permissions'] or (p_request-array['requestId','branchId','deviceId','shiftId','count','lifetimeSeconds','maxInvoiceTotalFils','maxGrossFils','permissions'])<>'{}'::jsonb or request is null then raise exception 'POS_OFFLINE_INVALID_REQUEST';end if;
 perform pg_advisory_xact_lock(hashtextextended(request::text,17));
 select * into g from public.pos_offline_authorities where id=request;
 if found then
 if g.actor_id<>p_actor or g.request_payload<>p_request then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;
 return jsonb_build_object('snapshot',g.snapshot,'authority',g.authority);
 end if;
 select * into policy from public.pos_offline_branch_policy where branch_id=branch and enabled for share;
 if not found then raise exception 'POS_OFFLINE_DISABLED';end if;
 count_n:=(p_request->>'count')::integer;life:=(p_request->>'lifetimeSeconds')::integer;max_invoice:=(p_request->>'maxInvoiceTotalFils')::bigint;max_gross:=(p_request->>'maxGrossFils')::bigint;
 if count_n is null or count_n not between 1 and policy.max_count or life is null or life not between 60 and policy.max_lifetime_seconds or max_invoice is null or max_invoice not between 1 and policy.max_invoice_total_fils or max_gross is null or max_gross not between 1 and least(policy.max_gross_fils,count_n::bigint*max_invoice)
 or jsonb_typeof(p_request#>'{permissions,cash}') is distinct from 'boolean' or jsonb_typeof(p_request#>'{permissions,recordedCard}') is distinct from 'boolean' or jsonb_typeof(p_request#>'{permissions,mixedTender}') is distinct from 'boolean' or ((p_request->'permissions')-array['cash','recordedCard','mixedTender'])<>'{}'::jsonb
 or not((p_request#>>'{permissions,cash}')::boolean or (p_request#>>'{permissions,recordedCard}')::boolean) or ((p_request#>>'{permissions,mixedTender}')::boolean and not((p_request#>>'{permissions,cash}')::boolean and (p_request#>>'{permissions,recordedCard}')::boolean)) then raise exception 'POS_OFFLINE_POLICY_LIMIT';end if;
 select * into c from public.pos_branch_receipt_config where branch_id=branch and organization_id=org and live_enabled for share;
 if not found then raise exception 'POS_PROFILE_REQUIRED';end if;
 perform 1 from public.pos_devices where id=device and organization_id=org and branch_id=branch and active for share;
 if not found then raise exception 'POS_DEVICE_INVALID';end if;
 perform 1 from public.pos_shifts where id=shift and device_id=device and organization_id=org and branch_id=branch and opened_by=p_actor and status='open' for update;
 if not found then raise exception 'POS_SHIFT_INVALID';end if;
 select * into e from public.pos_offline_key_epochs where device_id=device and organization_id=org and branch_id=branch for update;
 if not found or e.blocked then raise exception 'POS_OFFLINE_KEY_UNAVAILABLE';end if;
 if exists(select 1 from public.pos_offline_authorities where key_epoch=e.id and sealed_at is null) then raise exception 'POS_OFFLINE_UNSEALED_AUTHORITY';end if;
 select * into profile from public.pos_merchant_profiles where id=c.profile_id;
 -- One MVCC statement captures the entire available catalogue consistently. Later edits
 -- cannot change this frozen payload; import never joins current price/availability.
 select jsonb_agg(jsonb_build_object('id',id,'name',name,'category',category,'unit',unit,'unitPriceFils',unit_price_fils,'taxRateBps',tax_rate_bps,'revision',revision) order by id) into products from public.pos_products where organization_id=org and branch_id=branch and active and unit_price_fils>0;
 if products is null or jsonb_array_length(products)>2000 then raise exception 'POS_OFFLINE_CATALOGUE_LIMIT';end if;
 created:=date_trunc('milliseconds',clock_timestamp());stamp:=to_char(created at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 snapshot:=jsonb_build_object('kind','offline-snapshot','schemaVersion',1,'id',gen_random_uuid(),'organizationId',org,'branchId',branch,'createdAt',stamp,'profile',public.pos_profile_snapshot(profile),'products',products,'calculationVersion','offline-line-v1','offers','[]'::jsonb);
 insert into public.pos_document_counters(branch_id,kind) values(branch,'tax_invoice') on conflict do nothing;
 update public.pos_document_counters set last_number=last_number+count_n where branch_id=branch and kind='tax_invoice' and last_number<=9999999999-count_n returning last_number into last_n;
 if last_n is null then raise exception 'POS_NUMBER_RANGE_EXHAUSTED';end if;
 authority:=jsonb_build_object('kind','offline-authority','schemaVersion',1,'id',request,'organizationId',org,'branchId',branch,'deviceId',device,'actorId',p_actor,'deviceKeySha256',e.device_key_sha256,'keyEpoch',e.id,'shiftId',shift,'snapshotId',snapshot->>'id','snapshotSha256',null,'issuedAt',stamp,'notBefore',stamp,'expiresAt',to_char((created+make_interval(secs=>life)) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'invoiceRange',jsonb_build_object('prefix',c.series_prefix,'first',last_n-count_n+1,'last',last_n),'maxInvoiceTotalFils',max_invoice,'maxGrossFils',max_gross,'permissions',p_request->'permissions','policy',jsonb_build_object('refunds','online-only','sharedTabs','online-only','offers','online-only'));
 insert into public.pos_offline_authorities(id,organization_id,branch_id,device_id,key_epoch,actor_id,shift_id,request_payload,snapshot,authority,base_sequence,base_event_sha256) values(request,org,branch,device,e.id,p_actor,shift,p_request,snapshot,authority,e.last_sequence,e.last_event_sha256);
 return jsonb_build_object('snapshot',snapshot,'authority',authority);
end $$;

create function public.pos_offline_authority(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('snapshot',g.snapshot,'authority',case when b.authority_id is null then g.authority else public.pos_offline_payload(b.authority_envelope) end,'snapshotEnvelope',b.snapshot_envelope,'authorityEnvelope',b.authority_envelope,'snapshotSha256',b.snapshot_sha256,'authoritySha256',b.authority_sha256,'publicKeySpki',e.public_key_spki,'keyEpoch',e.id,'deviceId',e.device_id)
 from public.pos_offline_authorities g join public.pos_offline_key_epochs e on e.id=g.key_epoch left join public.pos_offline_signed_bundles b on b.authority_id=g.id where g.id=p_id;
$$;
create function public.pos_offline_attach(p_authority uuid,p_snapshot_envelope jsonb,p_authority_envelope jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.pos_offline_authorities;b public.pos_offline_signed_bundles;s jsonb;a jsonb;sh text;ah text;
begin
 select * into g from public.pos_offline_authorities where id=p_authority for update;
 if not found then raise exception 'POS_OFFLINE_AUTHORITY_UNKNOWN';end if;
 s:=public.pos_offline_payload(p_snapshot_envelope);a:=public.pos_offline_payload(p_authority_envelope);
 sh:=encode(sha256(public.pos_offline_bytes(p_snapshot_envelope->>'payloadBase64Url')),'hex');ah:=encode(sha256(public.pos_offline_bytes(p_authority_envelope->>'payloadBase64Url')),'hex');
 if s<>g.snapshot or a<>jsonb_set(g.authority,'{snapshotSha256}',to_jsonb(sh)) then raise exception 'POS_OFFLINE_BUNDLE_CHANGED';end if;
 select * into b from public.pos_offline_signed_bundles where authority_id=g.id;
 if found then
 if b.snapshot_sha256<>sh or b.authority_sha256<>ah then raise exception 'POS_OFFLINE_BUNDLE_CHANGED';end if;
 else
 insert into public.pos_offline_signed_bundles(authority_id,snapshot_envelope,authority_envelope,snapshot_sha256,authority_sha256) values(g.id,p_snapshot_envelope,p_authority_envelope,sh,ah);
 end if;
 return public.pos_offline_authority(g.id);
end $$;

-- A protocol anomaly is committed custody of evidence, NOT permission to charge again.
create function public.pos_offline_exception(p_authority uuid,p_code text,p_evidence jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare event uuid;h text:=encode(sha256(public.pos_offline_bytes(p_evidence->>'payloadBase64Url')),'hex');begin
 insert into public.pos_offline_exceptions(authority_id,code,evidence,payload_sha256) values(p_authority,p_code,p_evidence,h) on conflict(authority_id,code,payload_sha256) do nothing returning id into event;
 if event is null then select id into event from public.pos_offline_exceptions where authority_id=p_authority and code=p_code and payload_sha256=h;end if;
 update public.pos_offline_key_epochs set blocked=true where id=(select key_epoch from public.pos_offline_authorities where id=p_authority);
 return jsonb_build_object('status','reconciliation_required','exceptionId',event,'code',p_code);
end $$;

create function public.pos_offline_import(p_authority uuid,p_envelope jsonb,p_ack_envelope jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.pos_offline_authorities;e public.pos_offline_key_epochs;b public.pos_offline_signed_bundles;r public.pos_offline_receipts;original_receipt public.pos_offline_receipts;
 p jsonb;d jsonb;ack jsonb;h text;line jsonb;product jsonb;payment jsonb;sequence_n bigint;gross bigint:=0;tax bigint:=0;line_gross bigint;line_tax bigint;quantity bigint;cash bigint:=0;paid bigint:=0;count_lines integer:=0;number_n bigint;error_code text;
begin
 select * into g from public.pos_offline_authorities where id=p_authority;
 if not found then raise exception 'POS_OFFLINE_AUTHORITY_UNKNOWN';end if;
 p:=public.pos_offline_payload(p_envelope);d:=p->'document';ack:=public.pos_offline_payload(p_ack_envelope);h:=encode(sha256(public.pos_offline_bytes(p_envelope->>'payloadBase64Url')),'hex');
 -- Same request lock as online issuance; then existing financial device/shift order.
 perform pg_advisory_xact_lock(hashtextextended(p->>'id',0));
 perform 1 from public.pos_devices where id=g.device_id for update;
 perform 1 from public.pos_shifts where id=g.shift_id for update;
 select * into e from public.pos_offline_key_epochs where id=g.key_epoch for update;
 select * into g from public.pos_offline_authorities where id=p_authority for update;
 select * into b from public.pos_offline_signed_bundles where authority_id=g.id;
 if not found then return public.pos_offline_exception(g.id,'bundle',p_envelope);end if;
 -- Any identity match must be the same receipt. These constraints are also unique
 -- indexes, so concurrent cross-device collisions cannot bypass the preflight.
 for r in select * from public.pos_offline_receipts where issuance_id=(p->>'id')::uuid or payment_intent_id=(p->>'paymentIntentId')::uuid or document_id=(d->>'id')::uuid or (organization_id=g.organization_id and document_number=d->>'documentNumber') or (key_epoch=e.id and device_sequence=(p->>'deviceSequence')::bigint) loop
 if r.issuance_id<>(p->>'id')::uuid or r.payment_intent_id<>(p->>'paymentIntentId')::uuid or r.document_id<>(d->>'id')::uuid or r.document_number<>d->>'documentNumber' or r.authority_id<>g.id or r.key_epoch<>e.id or r.device_sequence<>(p->>'deviceSequence')::bigint or r.payload_sha256<>h then return public.pos_offline_exception(g.id,'collision',p_envelope);end if;
 original_receipt:=r;
 end loop;
 if original_receipt.issuance_id is not null then
 if e.last_sequence<(p->>'deviceSequence')::bigint or g.invoice_count<1 or g.gross_fils<(d#>>'{totals,grossFils}')::bigint or (e.last_sequence=(p->>'deviceSequence')::bigint and e.last_event_sha256<>h) then return public.pos_offline_exception(g.id,'state',p_envelope);end if;
 return jsonb_build_object('status','accepted','acknowledgement',original_receipt.acknowledgement,'receipt',d,'replayed',true);
 end if;
 if exists(select 1 from public.pos_request_cancellations where kind='sale' and request_id=(p->>'id')::uuid) or exists(select 1 from public.pos_orders where id=(p->>'id')::uuid) or exists(select 1 from public.pos_documents where id=(d->>'id')::uuid or (organization_id=g.organization_id and document_number=d->>'documentNumber')) then return public.pos_offline_exception(g.id,'collision',p_envelope);end if;
 -- Trust boundary defense in depth: signed root-validated JSON is re-bound here,
 -- and all arithmetic is independently recomputed from the frozen SQL snapshot.
 begin
 sequence_n:=(p->>'deviceSequence')::bigint;
 if g.sealed_at is not null then raise exception 'sealed';end if;
 if e.last_sequence<>g.base_sequence+g.invoice_count or (g.invoice_count=0 and g.gross_fils<>0) or (g.invoice_count>0 and g.gross_fils<g.invoice_count) then raise exception 'state';end if;
 if p->>'kind' is distinct from 'offline-sale' or p->>'schemaVersion' is distinct from '1' or p->>'id' is distinct from d->>'orderId' or p->>'authorityId' is distinct from g.id::text or p->>'authoritySha256' is distinct from b.authority_sha256 or p->>'snapshotSha256' is distinct from b.snapshot_sha256 or p_envelope->>'keyId' is distinct from e.device_key_sha256 then raise exception 'scope';end if;
 if d->>'schemaVersion' is distinct from '1' or d->>'kind' is distinct from 'tax_invoice' or d->>'actorId' is distinct from g.actor_id::text or d->>'deviceId' is distinct from g.device_id::text or d->>'shiftId' is distinct from g.shift_id::text or d->>'branchId' is distinct from g.branch_id::text or d->'merchant' is distinct from g.snapshot->'profile' or d->>'paymentSettlement' is distinct from 'recorded' then raise exception 'scope';end if;
 if d->>'issuedAt' is distinct from p#>>'{clock,estimatedServerAt}' or (d->>'issuedAt')::timestamptz<(g.authority->>'notBefore')::timestamptz or (d->>'issuedAt')::timestamptz>=(g.authority->>'expiresAt')::timestamptz then raise exception 'time';end if;
 if sequence_n is null or sequence_n<>e.last_sequence+1 or p->>'previousEventSha256' is distinct from e.last_event_sha256 then raise exception 'chain';end if;
 if d->>'documentNumber' !~ ('^'||(g.authority#>>'{invoiceRange,prefix}')||'-INV-[0-9]{10}$') then raise exception 'number';end if;
 number_n:=right(d->>'documentNumber',10)::bigint;
 if number_n not between (g.authority#>>'{invoiceRange,first}')::bigint and (g.authority#>>'{invoiceRange,last}')::bigint then raise exception 'number';end if;
 if jsonb_typeof(d->'lines') is distinct from 'array' or jsonb_array_length(d->'lines') not between 1 and 200 or (select count(distinct x->>'productId') from jsonb_array_elements(d->'lines') x)<>jsonb_array_length(d->'lines') then raise exception 'calculation';end if;
 for line in select value from jsonb_array_elements(d->'lines') loop
 count_lines:=count_lines+1;select x into product from jsonb_array_elements(g.snapshot->'products') x where x->>'id'=line->>'productId';
 if product is null or line->>'name' is distinct from product->>'name' or line->>'unit' is distinct from product->>'unit' or line->>'unitPriceFils' is distinct from product->>'unitPriceFils' or line->>'taxRateBps' is distinct from product->>'taxRateBps' or (line->>'lineNumber')::integer<>count_lines then raise exception 'calculation';end if;
 quantity:=(line->>'quantityMilli')::bigint;
 if quantity is null or quantity not between 1 and 1000000 or (product->>'unit'<>'kg' and quantity%1000<>0) then raise exception 'calculation';end if;
 line_gross:=((product->>'unitPriceFils')::bigint*quantity+500)/1000;
 line_tax:=(line_gross*(product->>'taxRateBps')::bigint*2+10000+(product->>'taxRateBps')::bigint)/(2*(10000+(product->>'taxRateBps')::bigint));
 if (line->>'grossFils')::bigint is distinct from line_gross or (line->>'taxFils')::bigint is distinct from line_tax or (line->>'netFils')::bigint is distinct from line_gross-line_tax then raise exception 'calculation';end if;
 gross:=gross+line_gross;tax:=tax+line_tax;
 end loop;
 if gross not between 1 and (g.authority->>'maxInvoiceTotalFils')::bigint or (d#>>'{totals,grossFils}')::bigint is distinct from gross or (d#>>'{totals,taxFils}')::bigint is distinct from tax or (d#>>'{totals,netFils}')::bigint is distinct from gross-tax or (gross>1000000 and d->'customer'='null'::jsonb) then raise exception 'calculation';end if;
 if g.gross_fils+gross>(g.authority->>'maxGrossFils')::bigint or g.invoice_count+1>(g.authority#>>'{invoiceRange,last}')::bigint-(g.authority#>>'{invoiceRange,first}')::bigint+1 then raise exception 'budget';end if;
 if jsonb_typeof(d->'payments') is distinct from 'array' or jsonb_array_length(d->'payments') not between 1 and 2 or (select count(distinct x->>'method') from jsonb_array_elements(d->'payments') x)<>jsonb_array_length(d->'payments') or (jsonb_array_length(d->'payments')=2 and not(g.authority#>>'{permissions,mixedTender}')::boolean) then raise exception 'payment';end if;
 for payment in select value from jsonb_array_elements(d->'payments') loop
 if payment->>'method'='cash' and (g.authority#>>'{permissions,cash}')::boolean then cash:=(payment->>'amountFils')::bigint;
 elsif payment->>'method'='card' and (g.authority#>>'{permissions,recordedCard}')::boolean then null;else raise exception 'payment';end if;
 if (payment->>'amountFils')::bigint not between 1 and 100000000 then raise exception 'payment';end if;
 paid:=paid+(payment->>'amountFils')::bigint;
 end loop;
 if paid<>gross or (d->>'cashTenderedFils')::bigint<cash or (cash=0 and (d->>'cashTenderedFils')::bigint<>0) or (d->>'changeFils')::bigint is distinct from (d->>'cashTenderedFils')::bigint-cash then raise exception 'payment';end if;
 if ack->>'kind' is distinct from 'offline-ack' or ack->>'schemaVersion' is distinct from '1' or ack->>'issuanceId' is distinct from p->>'id' or ack->>'payloadSha256' is distinct from h or ack->>'authorityId' is distinct from g.id::text or ack->>'keyEpoch' is distinct from e.id::text or (ack->>'deviceSequence')::bigint is distinct from sequence_n or (ack->>'id')::uuid is null or (ack->>'receivedAt')::timestamptz is null then raise exception 'ack';end if;
 -- Provenance precedes fiscal document INSERT, so the kitchen trigger can suppress
 -- already prepared offline work using private immutable custody, never a caller flag.
 insert into public.pos_offline_receipts(issuance_id,authority_id,key_epoch,organization_id,branch_id,document_id,document_number,payment_intent_id,device_sequence,payload_sha256,envelope,acknowledgement)
 values((p->>'id')::uuid,g.id,e.id,g.organization_id,g.branch_id,(d->>'id')::uuid,d->>'documentNumber',(p->>'paymentIntentId')::uuid,sequence_n,h,p_envelope,p_ack_envelope);
 insert into public.pos_orders(id,organization_id,branch_id,device_id,shift_id,created_by,client_created_at,service_type,total_fils,tax_fils,request_payload)
 values((p->>'id')::uuid,g.organization_id,g.branch_id,g.device_id,g.shift_id,g.actor_id,(d->>'issuedAt')::timestamptz,d->>'serviceType',gross,tax,p);
 for line in select value from jsonb_array_elements(d->'lines') loop
 insert into public.pos_order_lines(organization_id,branch_id,order_id,product_id,product_name,quantity_milli,unit_price_fils,tax_rate_bps,gross_fils,tax_fils)
 values(g.organization_id,g.branch_id,(p->>'id')::uuid,(line->>'productId')::uuid,line->>'name',(line->>'quantityMilli')::integer,(line->>'unitPriceFils')::integer,(line->>'taxRateBps')::integer,(line->>'grossFils')::integer,(line->>'taxFils')::integer);
 end loop;
 for payment in select value from jsonb_array_elements(d->'payments') loop
 insert into public.pos_payments(organization_id,branch_id,order_id,method,amount_fils) values(g.organization_id,g.branch_id,(p->>'id')::uuid,payment->>'method',(payment->>'amountFils')::integer);
 end loop;
 insert into public.pos_documents(id,organization_id,branch_id,order_id,actor_id,kind,document_number,issued_at,request_payload,snapshot)
 values((d->>'id')::uuid,g.organization_id,g.branch_id,(p->>'id')::uuid,g.actor_id,'tax_invoice',d->>'documentNumber',(d->>'issuedAt')::timestamptz,p,d);
 insert into public.pos_offline_exception_resolutions(exception_id,issuance_id)
 select x.id,(p->>'id')::uuid from public.pos_offline_exceptions x where x.authority_id=g.id and x.code='chain' and x.payload_sha256=h
 and not exists(select 1 from public.pos_offline_exception_resolutions z where z.exception_id=x.id);
 update public.pos_offline_key_epochs set last_sequence=sequence_n,last_event_sha256=h,
 blocked=exists(select 1 from public.pos_offline_exceptions x join public.pos_offline_authorities a on a.id=x.authority_id where a.key_epoch=e.id and not exists(select 1 from public.pos_offline_exception_resolutions z where z.exception_id=x.id)) where id=e.id;
 update public.pos_offline_authorities set invoice_count=invoice_count+1,gross_fils=gross_fils+gross where id=g.id;
 return jsonb_build_object('status','accepted','acknowledgement',p_ack_envelope,'receipt',d,'replayed',false);
 exception when others then
 -- Subtransaction rolls back ALL partial financial/custody writes before evidence
 -- is retained. Unknown storage/constraint faults are not returned as a paid sale.
 error_code:=case when sqlerrm in ('sealed','scope','time','chain','number','calculation','budget','payment','ack','state') then sqlerrm else 'storage_conflict' end;
 return public.pos_offline_exception(g.id,error_code,p_envelope);
 end;
end $$;

create function public.pos_offline_seal(p_authority uuid,p_final_sequence bigint,p_final_hash text,p_signed_evidence jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.pos_offline_authorities;e public.pos_offline_key_epochs;p jsonb;begin
 select * into g from public.pos_offline_authorities where id=p_authority;
 if not found then raise exception 'POS_OFFLINE_AUTHORITY_UNKNOWN';end if;
 perform 1 from public.pos_devices where id=g.device_id for update;
 perform 1 from public.pos_shifts where id=g.shift_id for update;
 select * into e from public.pos_offline_key_epochs where id=g.key_epoch for update;
 select * into g from public.pos_offline_authorities where id=p_authority for update;
 p:=public.pos_offline_payload(p_signed_evidence);
 if p->>'kind' is distinct from 'offline-seal' or p->>'schemaVersion' is distinct from '1' or p->>'authorityId' is distinct from g.id::text or p->>'keyEpoch' is distinct from e.id::text or p->>'deviceId' is distinct from g.device_id::text or (p->>'finalSequence')::bigint is distinct from p_final_sequence or p->>'finalEventSha256' is distinct from p_final_hash or p_signed_evidence->>'keyId' is distinct from e.device_key_sha256 or (p->>'id')::uuid is null then raise exception 'POS_OFFLINE_INVALID_SEAL';end if;
 if g.sealed_at is not null then
 if public.pos_offline_payload(g.seal_evidence)<>p then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;
 elsif p_final_sequence is distinct from e.last_sequence or p_final_hash is distinct from e.last_event_sha256 or p_final_sequence<>g.base_sequence+g.invoice_count then raise exception 'POS_OFFLINE_CHAIN_INCOMPLETE';
 else update public.pos_offline_authorities set sealed_at=clock_timestamp(),seal_evidence=p_signed_evidence where id=g.id;end if;
 return jsonb_build_object('status','sealed','authorityId',g.id,'finalSequence',p_final_sequence,'finalEventSha256',p_final_hash);
end $$;

create function public.pos_offline_guard_shift_close() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status='closed' and old.status<>'closed' and (exists(select 1 from public.pos_offline_authorities where shift_id=new.id and sealed_at is null) or exists(select 1 from public.pos_offline_exceptions x join public.pos_offline_authorities g on g.id=x.authority_id where g.shift_id=new.id and not exists(select 1 from public.pos_offline_exception_resolutions z where z.exception_id=x.id))) then raise exception 'POS_OFFLINE_CHAIN_INCOMPLETE';end if;
 return new;
end $$;
create trigger pos_shift_offline_guard before update of status on public.pos_shifts for each row execute function public.pos_offline_guard_shift_close();
create function public.pos_offline_preserve_identity() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'POS_IMMUTABLE_OFFLINE_CUSTODY';end if;
 if tg_table_name='pos_offline_key_epochs' then
 if to_jsonb(old)-array['blocked','last_sequence','last_event_sha256']<>to_jsonb(new)-array['blocked','last_sequence','last_event_sha256'] then raise exception 'POS_IMMUTABLE_OFFLINE_CUSTODY';end if;
 else
 if to_jsonb(old)-array['invoice_count','gross_fils','sealed_at','seal_evidence']<>to_jsonb(new)-array['invoice_count','gross_fils','sealed_at','seal_evidence'] or (old.sealed_at is not null and to_jsonb(old)<>to_jsonb(new)) then raise exception 'POS_IMMUTABLE_OFFLINE_CUSTODY';end if;
 end if;
 return new;
end $$;
create trigger pos_offline_epoch_identity before update or delete on public.pos_offline_key_epochs for each row execute function public.pos_offline_preserve_identity();
create trigger pos_offline_authority_identity before update or delete on public.pos_offline_authorities for each row execute function public.pos_offline_preserve_identity();
create function public.pos_offline_preserve_ledger() returns trigger language plpgsql security definer set search_path='' as $$
declare order_id uuid;begin
 if tg_table_name='pos_orders' then order_id:=old.id;else order_id:=old.order_id;end if;
 if exists(select 1 from public.pos_offline_receipts r where r.issuance_id=order_id) then raise exception 'POS_IMMUTABLE_OFFLINE_CUSTODY';end if;
 if tg_op='DELETE' then return old;else return new;end if;
end $$;
create trigger pos_offline_orders_immutable before update or delete on public.pos_orders for each row execute function public.pos_offline_preserve_ledger();
create trigger pos_offline_lines_immutable before update or delete on public.pos_order_lines for each row execute function public.pos_offline_preserve_ledger();
create trigger pos_offline_payments_immutable before update or delete on public.pos_payments for each row execute function public.pos_offline_preserve_ledger();

-- Preserve online kitchen behavior, suppress only private immutable offline provenance.
create or replace function public.pos_project_kitchen_document() returns trigger language plpgsql security definer set search_path='' as $$
declare linked uuid; dispatched public.pos_tab_kitchen_tickets; previous public.pos_kitchen_tickets; kitchen_lines jsonb; changed_at timestamptz:=clock_timestamp();
begin
 if exists(select 1 from public.pos_offline_receipts r where r.issuance_id=new.order_id and r.organization_id=new.organization_id and r.branch_id=new.branch_id) then return new;end if;
 -- Every writer already owns this order (new invoice insert, refund FOR UPDATE).
 -- Taking it explicitly also preserves the invariant for privileged fixture/import paths.
 perform 1 from public.pos_orders o where o.id=new.order_id and o.organization_id=new.organization_id and o.branch_id=new.branch_id for update;
 if not found then raise exception 'POS_ORDER_UNAVAILABLE'; end if;
 select ticket_id into linked from public.pos_tab_kitchen_payments where order_id=new.order_id and organization_id=new.organization_id and branch_id=new.branch_id;
 if found then
  select * into dispatched from public.pos_tab_kitchen_tickets where id=linked for update;
  if new.kind='tax_invoice' then
   if dispatched.payment<>'unpaid' or dispatched.state<>'open' then raise exception 'POS_TAB_KITCHEN_CHANGED';end if;
   update public.pos_tab_kitchen_tickets set payment='paid',paid_order_id=new.order_id,invoice_id=new.id,invoice_number=new.document_number,paid_at=new.issued_at,revision=revision+1,updated_at=clock_timestamp() where id=linked;
   insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details) values(new.organization_id,new.branch_id,new.actor_id,'tab_kitchen.paid',linked,jsonb_build_object('orderId',new.order_id,'revision',dispatched.revision+1));
  else
   perform public.pos_cancel_tab_kitchen(linked,'refund',dispatched.dispatched_tab_revision,new.snapshot->>'reason',new.actor_id);
  end if;
  return new;
 end if;
 if new.kind='tax_invoice' then
  select jsonb_agg(jsonb_build_object('lineNumber',l->'lineNumber','productId',l->'productId','name',l->'name','unit',l->'unit','quantityMilli',l->'quantityMilli') order by ord)
  into kitchen_lines from jsonb_array_elements(new.snapshot->'lines') with ordinality x(l,ord);
  insert into public.pos_kitchen_tickets(order_id,organization_id,branch_id,invoice_id,invoice_number,issued_at,service_type,lines,updated_at)
  values(new.order_id,new.organization_id,new.branch_id,new.id,new.document_number,new.issued_at,new.snapshot->>'serviceType',kitchen_lines,changed_at);
  insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
  values(new.organization_id,new.branch_id,new.actor_id,'kitchen.queued',new.order_id,jsonb_build_object('invoiceId',new.id,'revision',1));
 else
  select * into previous from public.pos_kitchen_tickets t where t.order_id=new.order_id and t.organization_id=new.organization_id and t.branch_id=new.branch_id for update;
  if found then
   update public.pos_kitchen_tickets set status='cancelled',revision=revision+1,updated_at=changed_at,refunded_at=changed_at where order_id=new.order_id;
   insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details)
   values(new.organization_id,new.branch_id,new.actor_id,'kitchen.refunded',new.order_id,jsonb_build_object('creditNoteId',new.id,'previousStatus',previous.status,'previousRevision',previous.revision,'revision',previous.revision+1));
  end if;
 end if;
 return new;
end $$;

create table public.pos_offline_source_windows(source text primary key check(source ~ '^[a-f0-9]{64}$'),window_started timestamptz not null,attempts integer not null check(attempts between 1 and 601));
alter table public.pos_offline_source_windows enable row level security;
revoke all on public.pos_offline_source_windows from public,anon,authenticated,service_role;
create function public.pos_offline_limit(p_source text) returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;stamp timestamptz:=date_trunc('minute',clock_timestamp());begin
 if p_source is null or p_source !~ '^[a-f0-9]{64}$' then return false;end if;
 insert into public.pos_offline_source_windows(source,window_started,attempts) values(p_source,stamp,1)
 on conflict(source) do update set window_started=case when public.pos_offline_source_windows.window_started<stamp then stamp else public.pos_offline_source_windows.window_started end,
 attempts=case when public.pos_offline_source_windows.window_started<stamp then 1 else least(public.pos_offline_source_windows.attempts+1,601) end returning attempts into n;
 delete from public.pos_offline_source_windows where source in(select source from public.pos_offline_source_windows where window_started<stamp-interval '1 day' order by window_started limit 64 for update skip locked);
 return n<=600;
end $$;
-- Only verified device evidence reaches this RPC. Invalid signatures and unknown
-- authorities must be rejected before this boundary; never quarantine a guessed ID.
create function public.pos_offline_reject(p_authority uuid,p_envelope jsonb,p_code text) returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.pos_offline_authorities;e public.pos_offline_key_epochs;p jsonb;begin
 if p_code is distinct from 'invalid_historical_receipt' then raise exception 'POS_OFFLINE_INVALID_REQUEST';end if;
 select * into g from public.pos_offline_authorities where id=p_authority;
 if not found then raise exception 'POS_OFFLINE_AUTHORITY_UNKNOWN';end if;
 perform 1 from public.pos_devices where id=g.device_id for update;
 perform 1 from public.pos_shifts where id=g.shift_id for update;
 select * into e from public.pos_offline_key_epochs where id=g.key_epoch for update;
 perform 1 from public.pos_offline_authorities where id=g.id for update;
 p:=public.pos_offline_payload(p_envelope);
 if p_envelope->>'keyId' is distinct from e.device_key_sha256 then raise exception 'POS_OFFLINE_INVALID_PROOF';end if;
 return public.pos_offline_exception(g.id,p_code,p_envelope);
end $$;

do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pos_offline_%' loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
grant execute on function public.pos_offline_enroll(uuid,jsonb),public.pos_offline_reserve(uuid,jsonb),public.pos_offline_authority(uuid),public.pos_offline_attach(uuid,jsonb,jsonb),public.pos_offline_import(uuid,jsonb,jsonb),public.pos_offline_seal(uuid,bigint,text,jsonb) to service_role;
revoke all on function public.pos_project_kitchen_document() from public,anon,authenticated;

grant execute on function public.pos_offline_limit(text),public.pos_offline_reject(uuid,jsonb,text) to service_role;
