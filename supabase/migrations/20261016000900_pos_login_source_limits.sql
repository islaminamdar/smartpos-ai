-- Remove the globally exhaustible login budget. Preserve existing account windows.
-- Public login requires a server-validated source key, not a browser-selected identity.
-- Temporary rollback compatibility: old releases retain account-only throttling, never a global bucket.
create or replace function public.pos_login_attempt(p_key text) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_account integer;
begin
 if p_key is null or p_key !~ '^[a-f0-9]{64}$' then return false; end if;
 insert into public.pos_login_windows values (p_key,now(),1)
 on conflict(key) do update set
  window_started=case when public.pos_login_windows.window_started<now()-interval '15 minutes' then now() else public.pos_login_windows.window_started end,
  attempts=case when public.pos_login_windows.window_started<now()-interval '15 minutes' then 1 else least(public.pos_login_windows.attempts+1,11) end returning attempts into v_account;
 delete from public.pos_login_windows where window_started<now()-interval '1 day';
 return v_account<=10;
end $$;
revoke all on function public.pos_login_attempt(text) from public,anon,authenticated;
grant execute on function public.pos_login_attempt(text) to service_role;
create function public.pos_login_attempt(p_key text,p_source text) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_source integer;
begin
 if p_key is null or p_source is null or p_key !~ '^[a-f0-9]{64}$' or p_source !~ '^[a-f0-9]{64}$' then return false; end if;
 insert into public.pos_login_windows values ('source:'||p_source,now(),1)
 on conflict(key) do update set
  window_started=case when public.pos_login_windows.window_started<now()-interval '1 minute' then now() else public.pos_login_windows.window_started end,
  attempts=case when public.pos_login_windows.window_started<now()-interval '1 minute' then 1 else least(public.pos_login_windows.attempts+1,61) end returning attempts into v_source;
 if v_source>60 then return false; end if;
 return public.pos_login_attempt(p_key);
end $$;
revoke all on function public.pos_login_attempt(text,text) from public,anon,authenticated;
grant execute on function public.pos_login_attempt(text,text) to service_role;
-- Historical global row is obsolete; deleting only this throttle counter does not touch sessions or records.
delete from public.pos_login_windows where key='global';
