-- Historical device custody reader. The trusted service verifies the enrolled device's
-- query signature before calling this RPC. Never a manager decision or selling grant.
-- Earlier migrations remain unchanged. Only exact existing scope/evidence is returned.
create function public.pos_offline_payment_native_read(p_authority uuid,p_epoch uuid,p_device uuid,p_freeze uuid,p_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.pos_offline_authorities;f public.pos_offline_payment_freezes;d public.pos_offline_payment_decisions;
 s public.pos_offline_payment_result_signatures;proof jsonb;p jsonb;state_n text;
begin
 if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'POS_OFFLINE_CASE_UNKNOWN';end if;
 select * into g from public.pos_offline_authorities where id=p_authority and key_epoch=p_epoch and device_id=p_device;
 if not found then raise exception 'POS_OFFLINE_CASE_UNKNOWN';end if;
 select * into f from public.pos_offline_payment_freezes where id=p_freeze and authority_id=g.id and payload_sha256=p_hash;
 if not found then
  -- Raw unsupported text and rejected duplicate identities retain their first proof.
  -- Only a conflict status may result; no decoded customer data or terminal decision.
  select envelope into proof from public.pos_offline_raw_evidence where authority_id=g.id and key_epoch=p_epoch
   and device_id=p_device and kind='freeze' and freeze_id=p_freeze and payload_sha256=p_hash;
  if proof is null then
   select evidence into proof from public.pos_offline_payment_conflicts where authority_id=g.id and freeze_id=p_freeze
    and payload_sha256=p_hash order by created_at,id limit 1;
  end if;
  if proof is null then raise exception 'POS_OFFLINE_CASE_UNKNOWN';end if;
  return jsonb_build_object('state','conflict','freezeEnvelope',proof,'decisionRequest',null,'resolution',null,'resolutionEnvelope',null,'managerActorId',null);
 end if;
 p:=public.pos_offline_payload(f.proof_envelope);
 -- Same order as decisions/import/attachment. Reads see either side of a completed
 -- transaction, never a partially committed decision or a missed concurrent conflict.
 perform pg_advisory_xact_lock(hashtextextended(f.payment_intent_id::text,31));
 perform pg_advisory_xact_lock(hashtextextended(p->>'orderId',0));
 perform 1 from public.pos_devices where id=g.device_id for update;
 perform 1 from public.pos_shifts where id=g.shift_id for update;
 perform 1 from public.pos_offline_key_epochs where id=g.key_epoch for update;
 perform 1 from public.pos_offline_authorities where id=g.id for update;
 perform pg_advisory_xact_lock(hashtextextended(p->>'documentId',32));
 perform 1 from public.pos_offline_payment_freezes where id=f.id for update;
 if public.pos_offline_payment_obstacle(f.id) is not null then
  return jsonb_build_object('state','conflict','freezeEnvelope',f.proof_envelope,'decisionRequest',null,'resolution',null,'resolutionEnvelope',null,'managerActorId',null);
 end if;
 select x.* into d from public.pos_offline_payment_decisions x where x.freeze_id=f.id;
 select x.* into s from public.pos_offline_payment_result_signatures x where x.resolution_id=d.id;
 state_n:=case when d.id is not null and s.resolution_id is not null then 'resolved' else 'pending' end;
 return jsonb_build_object('state',state_n,'freezeEnvelope',f.proof_envelope,'decisionRequest',d.request_payload,
  'resolution',d.resolution,'resolutionEnvelope',s.envelope,'managerActorId',d.actor_id);
end $$;
revoke all on function public.pos_offline_payment_native_read(uuid,uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.pos_offline_payment_native_read(uuid,uuid,uuid,uuid,text) to service_role;
