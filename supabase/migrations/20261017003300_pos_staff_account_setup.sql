-- Recipient-only account setup. No user is auto-confirmed and no membership is granted here.
create table public.pos_staff_setup_attempts (
 invitation_id uuid primary key references public.pos_staff_invitations(id),
 attempt_id uuid not null unique, requested_at timestamptz not null,
 expires_at timestamptz not null, completion_claimed_at timestamptz, auth_user_id uuid references auth.users(id),
 code_hash text check (code_hash is null or code_hash ~ '^[a-f0-9]{64}$')
);
alter table public.pos_staff_setup_attempts enable row level security;
revoke all on public.pos_staff_setup_attempts from public,anon,authenticated;

create function public.pos_staff_setup_context(p_token_hash text,p_email text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i public.pos_staff_invitations%rowtype; inviter public.pos_staff%rowtype;
 u auth.users%rowtype; a public.pos_staff_setup_attempts%rowtype;
begin
 if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' or p_email is null then raise exception 'POS_INVITATION_UNAVAILABLE'; end if;
 select * into i from public.pos_staff_invitations where token_hash=p_token_hash;
 if not found or i.email<>p_email or i.status<>'pending' or i.expires_at<=clock_timestamp() then raise exception 'POS_INVITATION_UNAVAILABLE'; end if;
 select * into inviter from public.pos_staff s where s.organization_id=i.organization_id and s.user_id=i.invited_by and s.active;
 if not found or (inviter.branch_id is not null and inviter.branch_id<>i.management_branch_id)
  or not public.pos_staff_scope_allowed(inviter,i.management_branch_id,i.role,i.branch_id)
  or not exists(select 1 from public.pos_branches b where b.id=i.management_branch_id and b.active)
  or (i.branch_id is not null and not exists(select 1 from public.pos_branches b where b.id=i.branch_id and b.active))
 then raise exception 'POS_INVITATION_UNAVAILABLE'; end if;
 select * into u from auth.users where lower(email)=i.email;
 select * into a from public.pos_staff_setup_attempts where invitation_id=i.id;
 return jsonb_build_object('invitationId',i.id,'email',i.email,'existingConfirmed',u.email_confirmed_at is not null,
  'attemptId',a.attempt_id,'setupUserId',a.auth_user_id,'codeHash',a.code_hash,'setupExpiresAt',a.expires_at);
end $$;
revoke all on function public.pos_staff_setup_context(text,text) from public,anon,authenticated;
grant execute on function public.pos_staff_setup_context(text,text) to service_role;

create function public.pos_staff_setup_claim(p_token_hash text,p_email text,p_attempt uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare context jsonb; i uuid;
begin
 context:=public.pos_staff_setup_context(p_token_hash,p_email); i:=(context->>'invitationId')::uuid;
 perform pg_advisory_xact_lock(hashtextextended(i::text,33));
 if p_attempt is null then raise exception 'POS_INVITATION_UNAVAILABLE'; end if;
 if exists(select 1 from public.pos_staff_setup_attempts where invitation_id=i and (requested_at>clock_timestamp()-interval '60 seconds' or completion_claimed_at>clock_timestamp()-interval '2 minutes')) then raise exception 'POS_SETUP_RATE_LIMITED'; end if;
 insert into public.pos_staff_setup_attempts(invitation_id,attempt_id,requested_at,expires_at)
 values(i,p_attempt,clock_timestamp(),clock_timestamp()+interval '10 minutes')
 on conflict(invitation_id) do update set attempt_id=excluded.attempt_id,requested_at=excluded.requested_at,
 expires_at=excluded.expires_at,auth_user_id=null,code_hash=null,completion_claimed_at=null;
 return context;
end $$;
revoke all on function public.pos_staff_setup_claim(text,text,uuid) from public,anon,authenticated;
grant execute on function public.pos_staff_setup_claim(text,text,uuid) to service_role;

create function public.pos_staff_setup_bind(p_token_hash text,p_email text,p_attempt uuid,p_user uuid,p_code_hash text) returns boolean
language plpgsql security definer set search_path='' as $$
declare context jsonb; i uuid;
begin
 context:=public.pos_staff_setup_context(p_token_hash,p_email); i:=(context->>'invitationId')::uuid;
 if p_user is null or p_code_hash is null or p_code_hash !~ '^[a-f0-9]{64}$'
  or not exists(select 1 from auth.users where id=p_user and lower(email)=p_email and email_confirmed_at is null)
 then raise exception 'POS_INVITATION_UNAVAILABLE'; end if;
 update public.pos_staff_setup_attempts set auth_user_id=p_user,code_hash=p_code_hash
 where invitation_id=i and attempt_id=p_attempt and expires_at>clock_timestamp() and auth_user_id is null;
 if not found then raise exception 'POS_INVITATION_UNAVAILABLE'; end if;
 return true;
end $$;
revoke all on function public.pos_staff_setup_bind(text,text,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.pos_staff_setup_bind(text,text,uuid,uuid,text) to service_role;

-- Never rely on Auth OTP verification alone to serialize competing password writes.
-- A correct attempt is consumed before contacting Auth. Uncertain outcomes are not retried automatically.
create function public.pos_staff_setup_consume(p_token_hash text,p_email text,p_attempt uuid,p_code_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare context jsonb; i uuid; a public.pos_staff_setup_attempts%rowtype;
begin
 context:=public.pos_staff_setup_context(p_token_hash,p_email); i:=(context->>'invitationId')::uuid;
 perform pg_advisory_xact_lock(hashtextextended(i::text,33));
 select * into a from public.pos_staff_setup_attempts where invitation_id=i for update;
 context:=public.pos_staff_setup_context(p_token_hash,p_email);
 if not found or a.attempt_id is distinct from p_attempt or p_code_hash is null or a.code_hash is distinct from p_code_hash
  or a.auth_user_id is null or a.expires_at<=clock_timestamp() or a.completion_claimed_at is not null
  or not exists(select 1 from auth.users where id=a.auth_user_id and lower(email)=p_email and email_confirmed_at is null)
 then raise exception 'POS_SETUP_CODE_INVALID'; end if;
 update public.pos_staff_setup_attempts set completion_claimed_at=clock_timestamp() where invitation_id=i;
 return context;
end $$;
revoke all on function public.pos_staff_setup_consume(text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.pos_staff_setup_consume(text,text,uuid,text) to service_role;
