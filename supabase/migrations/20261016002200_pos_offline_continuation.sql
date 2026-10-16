-- Read-only continuation eligibility. Current authenticated actor and cookie-bound
-- device are supplied by the trusted service, never by the request body.
create function public.pos_offline_continuation_context(p_actor uuid,p_device uuid,p_authority uuid,p_seal_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.pos_offline_authorities;e public.pos_offline_key_epochs;
 s public.pos_shifts;b public.pos_offline_signed_bundles;next_shift uuid;seal jsonb;
begin
 if p_seal_hash is null or p_seal_hash !~ '^[a-f0-9]{64}$' then raise exception 'POS_OFFLINE_CONTINUATION_INVALID';end if;
 select * into g from public.pos_offline_authorities where id=p_authority and actor_id=p_actor and device_id=p_device;
 if not found then raise exception 'POS_ACCESS_DENIED';end if;
 perform public.pos_offline_actor(p_actor,g.branch_id,false);
 -- Match financial mutation ordering. Device lock also serializes opening/closing a
 -- drawer; no other open shift may be silently adopted by this transition.
 perform 1 from public.pos_devices where id=g.device_id and organization_id=g.organization_id and branch_id=g.branch_id and active for update;
 if not found then raise exception 'POS_DEVICE_INVALID';end if;
 select * into s from public.pos_shifts where id=g.shift_id and device_id=g.device_id and branch_id=g.branch_id and organization_id=g.organization_id and opened_by=p_actor for update;
 if not found then raise exception 'POS_SHIFT_INVALID';end if;
 select * into e from public.pos_offline_key_epochs where id=g.key_epoch and device_id=g.device_id and branch_id=g.branch_id and organization_id=g.organization_id for update;
 if not found or e.blocked then raise exception 'POS_OFFLINE_KEY_UNAVAILABLE';end if;
 select * into g from public.pos_offline_authorities where id=p_authority for update;
 if not exists(select 1 from public.pos_offline_branch_policy where branch_id=g.branch_id and enabled) then raise exception 'POS_OFFLINE_DISABLED';end if;
 if not exists(select 1 from public.pos_branch_receipt_config where branch_id=g.branch_id and organization_id=g.organization_id and live_enabled) then raise exception 'POS_PROFILE_REQUIRED';end if;
 if g.sealed_at is null or g.seal_evidence is null or encode(pg_catalog.sha256(public.pos_offline_bytes(g.seal_evidence->>'payloadBase64Url')),'hex') is distinct from p_seal_hash then raise exception 'POS_OFFLINE_SEAL_REQUIRED';end if;
 seal:=public.pos_offline_payload(g.seal_evidence);
 if (seal->>'finalSequence')::bigint is distinct from e.last_sequence or seal->>'finalEventSha256' is distinct from e.last_event_sha256
  or exists(select 1 from public.pos_offline_authorities a where a.key_epoch=e.id and (a.authority->'invoiceRange'->>'first')::bigint>(g.authority->'invoiceRange'->>'first')::bigint)
 then raise exception 'POS_OFFLINE_CHAIN_INCOMPLETE';end if;
 if exists(select 1 from public.pos_offline_authorities where key_epoch=e.id and sealed_at is null) then raise exception 'POS_OFFLINE_UNSEALED_AUTHORITY';end if;
 if public.pos_offline_payment_hold(e.id) then raise exception 'POS_OFFLINE_PAYMENT_HOLD';end if;
 if exists(select 1 from public.pos_offline_exceptions x join public.pos_offline_authorities a on a.id=x.authority_id where a.key_epoch=e.id and not exists(select 1 from public.pos_offline_exception_resolutions r where r.exception_id=x.id)) then raise exception 'POS_OFFLINE_CHAIN_INCOMPLETE';end if;
 if exists(select 1 from public.pos_shifts where device_id=g.device_id and status='open' and id<>g.shift_id) then raise exception 'POS_SHIFT_INVALID';end if;
 if s.status='open' then next_shift:=s.id;
 elsif s.status='closed' and s.closed_at is not null then next_shift:=null;
 else raise exception 'POS_SHIFT_INVALID';end if;
 select * into b from public.pos_offline_signed_bundles where authority_id=g.id;
 if not found then raise exception 'POS_OFFLINE_BUNDLE_UNAVAILABLE';end if;
 return jsonb_build_object('actorId',g.actor_id,'organizationId',g.organization_id,'branchId',g.branch_id,
  'deviceId',g.device_id,'shiftId',g.shift_id,'keyEpoch',g.key_epoch,'deviceKeySha256',e.device_key_sha256,
  'nextShiftId',next_shift,'snapshotEnvelope',b.snapshot_envelope,'authorityEnvelope',b.authority_envelope,
  'sealEnvelope',g.seal_evidence,'publicKeySpki',e.public_key_spki);
end $$;
revoke all on function public.pos_offline_continuation_context(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.pos_offline_continuation_context(uuid,uuid,uuid,text) to service_role;
