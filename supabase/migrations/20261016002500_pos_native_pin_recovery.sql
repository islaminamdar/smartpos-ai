-- Candidate same-actor native PIN recovery only. No financial/clock/authority reset.
-- The service verifies canonical P256 device/server signatures and the exact current
-- account password. These RPCs never accept an authenticated browser directly.
create table public.pos_native_pin_recoveries (
 request_id uuid primary key,organization_id uuid not null,branch_id uuid not null,device_id uuid not null,
 actor_id uuid not null references auth.users,key_epoch uuid not null references public.pos_offline_key_epochs,
 old_credential_sha256 text not null check(old_credential_sha256 ~ '^[a-f0-9]{64}$'),
 new_credential_sha256 text not null check(new_credential_sha256 ~ '^[a-f0-9]{64}$'),
 operation jsonb not null,proof_envelope jsonb not null,proof_sha256 text not null check(proof_sha256 ~ '^[a-f0-9]{64}$'),
 confirmed_at timestamptz not null,approved_at timestamptz not null,approval jsonb not null,
 approval_sha256 text not null check(approval_sha256 ~ '^[a-f0-9]{64}$'),
 unique(key_epoch,actor_id,old_credential_sha256),
 foreign key(organization_id,branch_id,device_id) references public.pos_devices(organization_id,branch_id,id),
 check(old_credential_sha256<>new_credential_sha256)
);
create table public.pos_native_pin_recovery_signatures (
 request_id uuid primary key references public.pos_native_pin_recoveries,
 envelope jsonb not null,payload_sha256 text not null check(payload_sha256 ~ '^[a-f0-9]{64}$'),
 attached_at timestamptz not null default clock_timestamp()
);
do $$declare t text;begin
 foreach t in array array['pos_native_pin_recoveries','pos_native_pin_recovery_signatures'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 execute format('create trigger %I before update or delete on public.%I for each row execute function public.pos_preserve_document()',t||'_immutable',t);
 end loop;
end $$;

create function public.pos_native_pin_recovery_context(p_epoch uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('organizationId',e.organization_id,'branchId',e.branch_id,'deviceId',e.device_id,
 'keyEpoch',e.id,'deviceKeySha256',e.device_key_sha256,'publicKeySpki',e.public_key_spki)
 from public.pos_offline_key_epochs e where e.id=p_epoch
$$;

-- Private parser checks exact canonical bytes and historical identity independently.
-- This does NOT verify ECDSA; callers must verify the registered device signature first.
create function public.pos_native_pin_recovery_proof(p_proof jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p jsonb;k text;e public.pos_offline_key_epochs;begin
 if p_proof is null or octet_length(p_proof::text)>8192 then raise exception 'POS_PIN_RECOVERY_INVALID_PROOF';end if;
 p:=public.pos_offline_payload(p_proof);
 if not public.pos_offline_exact_fields(p,array['kind','schemaVersion','requestId','organizationId','branchId','deviceId','actorId','keyEpoch','deviceKeySha256','oldCredentialSha256','newCredentialSha256','signedAt'])
 or p->>'kind' is distinct from 'native-pin-recovery' or p->'schemaVersion' is distinct from '1'::jsonb
 or convert_from(public.pos_offline_bytes(p_proof->>'payloadBase64Url'),'UTF8')<>public.pos_offline_canonical(p)
 then raise exception 'POS_PIN_RECOVERY_INVALID_PROOF';end if;
 foreach k in array array['requestId','organizationId','branchId','deviceId','actorId','keyEpoch'] loop perform public.pos_offline_uuid(p->k);end loop;
 foreach k in array array['deviceKeySha256','oldCredentialSha256','newCredentialSha256'] loop
 if jsonb_typeof(p->k) is distinct from 'string' or p->>k !~ '^[a-f0-9]{64}$' then raise exception 'POS_PIN_RECOVERY_INVALID_PROOF';end if;end loop;
 perform public.pos_offline_instant(p->'signedAt');
 if p->>'oldCredentialSha256'=p->>'newCredentialSha256' or p_proof->>'keyId' is distinct from p->>'deviceKeySha256' then raise exception 'POS_PIN_RECOVERY_INVALID_PROOF';end if;
 select * into e from public.pos_offline_key_epochs where id=(p->>'keyEpoch')::uuid;
 if not found or e.organization_id::text<>p->>'organizationId' or e.branch_id::text<>p->>'branchId' or e.device_id::text<>p->>'deviceId' or e.device_key_sha256<>p->>'deviceKeySha256' then raise exception 'POS_PIN_RECOVERY_CONTEXT_INVALID';end if;
 return p;
end $$;

create function public.pos_native_pin_recovery_lookup(p_proof jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare p jsonb;r public.pos_native_pin_recoveries;s public.pos_native_pin_recovery_signatures;begin
 p:=public.pos_native_pin_recovery_proof(p_proof);
 perform pg_advisory_xact_lock(hashtextextended(p->>'requestId',34));
 select * into r from public.pos_native_pin_recoveries where request_id=(p->>'requestId')::uuid;
 if not found then return null;end if;
 if r.operation is distinct from p-'signedAt' then raise exception 'POS_PIN_RECOVERY_CONFLICT';end if;
 select * into s from public.pos_native_pin_recovery_signatures where request_id=r.request_id;
 return jsonb_build_object('approval',r.approval,'approvalEnvelope',s.envelope);
end $$;

create function public.pos_native_pin_recovery_approve(p_actor uuid,p_binding text,p_proof jsonb,p_confirmed_at timestamptz) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare p jsonb;org uuid;branch uuid;device uuid;epoch uuid;v_request uuid;stamp timestamptz;proof_time timestamptz;
 e public.pos_offline_key_epochs;r public.pos_native_pin_recoveries;s public.pos_native_pin_recovery_signatures;approval jsonb;h text;
begin
 p:=public.pos_native_pin_recovery_proof(p_proof);
 if p_actor is null or p_actor::text is distinct from p->>'actorId' then raise exception 'POS_ACCESS_DENIED';end if;
 org:=(p->>'organizationId')::uuid;branch:=(p->>'branchId')::uuid;device:=(p->>'deviceId')::uuid;epoch:=(p->>'keyEpoch')::uuid;v_request:=(p->>'requestId')::uuid;
 -- Shared actor gate precedes the request and normal financial device/epoch order.
 perform pg_advisory_xact_lock_shared(hashtextextended(org::text||':'||p_actor::text,15));
 perform pg_advisory_xact_lock(hashtextextended(v_request::text,34));
 select * into r from public.pos_native_pin_recoveries where request_id=v_request;
 if found then
  if r.operation is distinct from p-'signedAt' then raise exception 'POS_PIN_RECOVERY_CONFLICT';end if;
  select * into s from public.pos_native_pin_recovery_signatures where request_id=v_request;
  return jsonb_build_object('approval',r.approval,'approvalEnvelope',s.envelope);
 end if;
 if not exists(select 1 from public.pos_branches where id=branch and organization_id=org and active)
 or not exists(select 1 from public.pos_staff where organization_id=org and user_id=p_actor and active and (branch_id=branch or (branch_id is null and role in ('owner','manager')))) then raise exception 'POS_ACCESS_DENIED';end if;
 perform 1 from public.pos_devices where id=device and organization_id=org and branch_id=branch and active for update;
 if not found then raise exception 'POS_DEVICE_INVALID';end if;
 -- Row lock closes a direct binding-revocation race; staff changes also hold gate15.
 if p_binding is null or p_binding !~ '^[a-f0-9]{64}$' then raise exception 'POS_DEVICE_INVALID';end if;
 perform 1 from public.pos_device_bindings where token_hash=p_binding and user_id=p_actor and organization_id=org and branch_id=branch and device_id=device and revoked_at is null for share;
 if not found then raise exception 'POS_DEVICE_INVALID';end if;
 select * into e from public.pos_offline_key_epochs where id=epoch and device_id=device for update;
 if not found then raise exception 'POS_PIN_RECOVERY_KEY_UNAVAILABLE';end if;
 -- A blocked epoch is a financial hold, not key revocation. Recovering local access
 -- preserves that hold and must remain possible for historical records.
 if exists(select 1 from public.pos_native_pin_recoveries where key_epoch=epoch and actor_id=p_actor and old_credential_sha256=p->>'oldCredentialSha256') then raise exception 'POS_PIN_RECOVERY_CONFLICT';end if;
 stamp:=clock_timestamp();proof_time:=public.pos_offline_instant(p->'signedAt');
 if p_confirmed_at is null or not isfinite(p_confirmed_at) or p_confirmed_at>stamp or p_confirmed_at<stamp-interval '120 seconds' then raise exception 'POS_PIN_RECOVERY_CONFIRMATION_REQUIRED';end if;
 -- This specific error is emitted only after absence and generation checks under locks.
 if proof_time<stamp-interval '300 seconds' or proof_time>stamp+interval '30 seconds' then raise exception 'POS_PIN_RECOVERY_PROOF_EXPIRED';end if;
 stamp:=date_trunc('milliseconds',stamp);h:=encode(sha256(public.pos_offline_bytes(p_proof->>'payloadBase64Url')),'hex');
 approval:=(p-array['kind','signedAt'])||jsonb_build_object('kind','native-pin-recovery-approval','proofSha256',h,'approvedAt',to_char(stamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 insert into public.pos_native_pin_recoveries(request_id,organization_id,branch_id,device_id,actor_id,key_epoch,old_credential_sha256,new_credential_sha256,operation,proof_envelope,proof_sha256,confirmed_at,approved_at,approval,approval_sha256)
 values(v_request,org,branch,device,p_actor,epoch,p->>'oldCredentialSha256',p->>'newCredentialSha256',p-'signedAt',p_proof,h,p_confirmed_at,stamp,approval,encode(sha256(convert_to(public.pos_offline_canonical(approval),'UTF8')),'hex'));
 return jsonb_build_object('approval',approval,'approvalEnvelope',null);
end $$;

create function public.pos_native_pin_recovery_attach(p_request uuid,p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare r public.pos_native_pin_recoveries;s public.pos_native_pin_recovery_signatures;p jsonb;h text;begin
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,34));
 select * into r from public.pos_native_pin_recoveries where request_id=p_request;
 if not found then raise exception 'POS_PIN_RECOVERY_UNKNOWN';end if;
 if p_envelope is null or octet_length(p_envelope::text)>8192 then raise exception 'POS_PIN_RECOVERY_APPROVAL_CHANGED';end if;
 p:=public.pos_offline_payload(p_envelope);h:=encode(sha256(public.pos_offline_bytes(p_envelope->>'payloadBase64Url')),'hex');
 if p is distinct from r.approval or h<>r.approval_sha256 or convert_from(public.pos_offline_bytes(p_envelope->>'payloadBase64Url'),'UTF8')<>public.pos_offline_canonical(r.approval) then raise exception 'POS_PIN_RECOVERY_APPROVAL_CHANGED';end if;
 -- Trusted service verifies a pinned server signature; rotation is allowed. Keep first DER.
 insert into public.pos_native_pin_recovery_signatures(request_id,envelope,payload_sha256) values(p_request,p_envelope,h) on conflict(request_id) do nothing;
 select * into s from public.pos_native_pin_recovery_signatures where request_id=p_request;
 return jsonb_build_object('approval',r.approval,'approvalEnvelope',s.envelope);
end $$;
revoke all on function public.pos_native_pin_recovery_proof(jsonb),public.pos_native_pin_recovery_context(uuid),public.pos_native_pin_recovery_lookup(jsonb),public.pos_native_pin_recovery_approve(uuid,text,jsonb,timestamptz),public.pos_native_pin_recovery_attach(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.pos_native_pin_recovery_context(uuid),public.pos_native_pin_recovery_lookup(jsonb),public.pos_native_pin_recovery_approve(uuid,text,jsonb,timestamptz),public.pos_native_pin_recovery_attach(uuid,jsonb) to service_role;
