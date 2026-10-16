-- Bounded immutable public menu media. The trusted service decodes/re-encodes images
-- with Sharp before registration; SQL validates the normalized blob envelope only.
create table public.pos_menu_media (
 id uuid primary key, organization_id uuid not null, branch_id uuid not null,
 actor_id uuid not null references auth.users, device_id uuid not null,
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 width integer not null check(width between 1 and 1200), height integer not null check(height between 1 and 1200),
 bytes bytea not null check(octet_length(bytes) between 12 and 262144),
 created_at timestamptz not null default clock_timestamp(),
 unique(branch_id,sha256),
 foreign key(organization_id,branch_id,device_id) references public.pos_devices(organization_id,branch_id,id)
);
create index pos_menu_media_branch_created on public.pos_menu_media(branch_id,created_at);
create table public.pos_menu_media_admissions (
 actor_id uuid not null references auth.users, branch_id uuid not null references public.pos_branches,
 window_start timestamptz not null, attempts integer not null check(attempts between 1 and 30),
 primary key(actor_id,branch_id)
);
alter table public.pos_menu_media enable row level security;
alter table public.pos_menu_media_admissions enable row level security;
revoke all on public.pos_menu_media,public.pos_menu_media_admissions from public,anon,authenticated,service_role;
create trigger pos_menu_media_immutable before update or delete on public.pos_menu_media for each row execute function public.pos_preserve_document();

create function public.pos_menu_media_authority(p_actor uuid,p_branch uuid,p_device uuid,p_binding text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare org uuid;
begin
 if p_actor is null or p_branch is null or p_device is null then raise exception 'POS_ACCESS_DENIED';end if;
 select organization_id into org from public.pos_branches where id=p_branch and active;
 if org is null then raise exception 'POS_ACCESS_DENIED';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(org::text||':'||p_actor::text,15));
 perform 1 from public.pos_branches where id=p_branch and organization_id=org and active for share;
 if not found then raise exception 'POS_ACCESS_DENIED';end if;
 if not exists(select 1 from public.pos_staff where organization_id=org and user_id=p_actor and active and role in ('owner','manager') and (branch_id is null or branch_id=p_branch)) then raise exception 'POS_MANAGER_REQUIRED';end if;
 -- Direct device/binding revocation is serialized too. Staff edits hold gate15.
 perform 1 from public.pos_devices where id=p_device and organization_id=org and branch_id=p_branch and active for share;
 if not found then raise exception 'POS_DEVICE_INVALID';end if;
 if p_binding is null or p_binding !~ '^[a-f0-9]{64}$' then raise exception 'POS_DEVICE_INVALID';end if;
 perform 1 from public.pos_device_bindings where token_hash=p_binding and user_id=p_actor and organization_id=org and branch_id=p_branch and device_id=p_device and revoked_at is null for share;
 if not found then raise exception 'POS_DEVICE_INVALID';end if;
 return jsonb_build_object('organizationId',org,'branchId',p_branch,'deviceId',p_device,'actorId',p_actor);
end $$;

-- Admission is intentionally writable: call once before expensive decoding. It is
-- a fixed UTC quarter-hour budget, with a single row per authorized actor/branch.
create function public.pos_menu_media_context(p_actor uuid,p_branch uuid,p_device uuid,p_binding text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare context jsonb;stamp timestamptz;v_count integer;
begin
 context:=public.pos_menu_media_authority(p_actor,p_branch,p_device,p_binding);
 stamp:=to_timestamp(floor(extract(epoch from clock_timestamp())/900)*900);
 insert into public.pos_menu_media_admissions as a(actor_id,branch_id,window_start,attempts) values(p_actor,p_branch,stamp,1)
 on conflict(actor_id,branch_id) do update set window_start=excluded.window_start,
 attempts=case when a.window_start=excluded.window_start then a.attempts+1 else 1 end
 where a.window_start<>excluded.window_start or a.attempts<30
 returning attempts into v_count;
 if v_count is null then raise exception 'POS_MEDIA_RATE_LIMIT';end if;
 return context;
end $$;

create function public.pos_menu_media_result(p public.pos_menu_media,p_replayed boolean) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('status','ready','image',jsonb_build_object('id',p.id,'branchId',p.branch_id,'imageUrl','/pos-assets/menu/upload_'||replace(p.id::text,'-','')||'.webp','sha256',p.sha256,'width',p.width,'height',p.height,'byteLength',octet_length(p.bytes)),'replayed',p_replayed)
$$;

create function public.pos_menu_media_register(p_actor uuid,p_branch uuid,p_device uuid,p_binding text,p_media jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare context jsonb;v_id uuid;v_bytes bytea;v_sha text;v_width integer;v_height integer;stamp timestamptz;r public.pos_menu_media;
begin
 context:=public.pos_menu_media_authority(p_actor,p_branch,p_device,p_binding);
 if p_media is null or jsonb_typeof(p_media) is distinct from 'object' or octet_length(p_media::text)>351000 then raise exception 'POS_MEDIA_INVALID';end if;
 if (select count(*) from jsonb_object_keys(p_media))<>6 or not p_media ?& array['id','sha256','base64','width','height','byteLength'] then raise exception 'POS_MEDIA_INVALID';end if;
 if jsonb_typeof(p_media->'id') is distinct from 'string' or p_media->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 or jsonb_typeof(p_media->'sha256') is distinct from 'string' or p_media->>'sha256' !~ '^[a-f0-9]{64}$'
 or jsonb_typeof(p_media->'base64') is distinct from 'string' or length(p_media->>'base64') not between 16 and 349528 or p_media->>'base64' !~ '^[A-Za-z0-9+/]+={0,2}$'
 or jsonb_typeof(p_media->'width') is distinct from 'number' or (p_media->>'width')::numeric not between 1 and 1200 or (p_media->>'width')::numeric<>trunc((p_media->>'width')::numeric)
 or jsonb_typeof(p_media->'height') is distinct from 'number' or (p_media->>'height')::numeric not between 1 and 1200 or (p_media->>'height')::numeric<>trunc((p_media->>'height')::numeric)
 or jsonb_typeof(p_media->'byteLength') is distinct from 'number' or (p_media->>'byteLength')::numeric not between 12 and 262144 or (p_media->>'byteLength')::numeric<>trunc((p_media->>'byteLength')::numeric)
 then raise exception 'POS_MEDIA_INVALID';end if;
 begin v_bytes:=decode(p_media->>'base64','base64');exception when others then raise exception 'POS_MEDIA_INVALID';end;
 if octet_length(v_bytes) not between 12 and 262144 or replace(encode(v_bytes,'base64'),E'\n','')<>p_media->>'base64'
 or octet_length(v_bytes)<>(p_media->>'byteLength')::integer or encode(sha256(v_bytes),'hex')<>p_media->>'sha256'
 or substring(v_bytes from 1 for 4)<>decode('52494646','hex') or substring(v_bytes from 9 for 4)<>decode('57454250','hex') then raise exception 'POS_MEDIA_INVALID';end if;
 if get_byte(v_bytes,4)::bigint+256::bigint*get_byte(v_bytes,5)+65536::bigint*get_byte(v_bytes,6)+16777216::bigint*get_byte(v_bytes,7)<>octet_length(v_bytes)-8 then raise exception 'POS_MEDIA_INVALID';end if;
 v_id:=(p_media->>'id')::uuid;v_sha:=p_media->>'sha256';v_width:=(p_media->>'width')::integer;v_height:=(p_media->>'height')::integer;
 -- Identity lock precedes branch quota lock; IDs cannot move to another branch.
 perform pg_advisory_xact_lock(hashtextextended(v_id::text,37));
 perform pg_advisory_xact_lock(hashtextextended(p_branch::text,35));
 select * into r from public.pos_menu_media where id=v_id;
 if found then
  if r.branch_id<>p_branch or r.sha256<>v_sha or r.width<>v_width or r.height<>v_height or r.bytes<>v_bytes then raise exception 'POS_MEDIA_CONFLICT';end if;
  return public.pos_menu_media_result(r,true);
 end if;
 select * into r from public.pos_menu_media where branch_id=p_branch and sha256=v_sha;
 if found then
  if r.bytes<>v_bytes or r.width<>v_width or r.height<>v_height then raise exception 'POS_MEDIA_CONFLICT';end if;
  return public.pos_menu_media_result(r,true);
 end if;
 stamp:=clock_timestamp();
 if (select count(*) from public.pos_menu_media where branch_id=p_branch)>=512 then raise exception 'POS_MEDIA_CAPACITY';end if;
 if (select count(*) from public.pos_menu_media where branch_id=p_branch and created_at>=date_trunc('day',stamp at time zone 'UTC') at time zone 'UTC')>=100 then raise exception 'POS_MEDIA_DAILY_LIMIT';end if;
 insert into public.pos_menu_media(id,organization_id,branch_id,actor_id,device_id,sha256,width,height,bytes,created_at)
 values(v_id,(context->>'organizationId')::uuid,p_branch,p_actor,p_device,v_sha,v_width,v_height,v_bytes,stamp) returning * into r;
 return public.pos_menu_media_result(r,false);
end $$;

create function public.pos_menu_media_read(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',id,'sha256',sha256,'base64',replace(encode(bytes,'base64'),E'\n',''),'width',width,'height',height,'byteLength',octet_length(bytes)) from public.pos_menu_media where id=p_id
$$;

-- Original catalogue command ledger remains authoritative for exact retries.
alter function public.pos_manage_catalogue(jsonb,text) rename to pos_manage_catalogue_before_media;
revoke all on function public.pos_manage_catalogue_before_media(jsonb,text) from public,anon,authenticated,service_role;
create function public.pos_manage_catalogue(p_command jsonb,p_binding text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare branch uuid;request uuid;image text;
begin
 branch:=(p_command->>'branchId')::uuid;request:=(p_command->>'id')::uuid;
 perform public.pos_lock_staff_authority(branch);
 perform public.pos_staff_manager(branch,p_binding);
 perform pg_advisory_xact_lock(hashtextextended(request::text,8));
 if exists(select 1 from public.pos_catalogue_commands where id=request) then return public.pos_manage_catalogue_before_media(p_command,p_binding);end if;
 image:=p_command->'product'->>'imageUrl';
 if lower(image) like '/pos-assets/menu/upload\_%' escape '\' then
  if image !~ '^/pos-assets/menu/upload_[0-9a-f]{32}\.webp$' then raise exception 'POS_MEDIA_INVALID';end if;
  if not exists(select 1 from public.pos_menu_media where branch_id=branch and replace(id::text,'-','')=substring(image from 25 for 32)) then raise exception 'POS_MEDIA_SCOPE';end if;
 end if;
 return public.pos_manage_catalogue_before_media(p_command,p_binding);
end $$;
revoke all on function public.pos_manage_catalogue(jsonb,text) from public,anon;
grant execute on function public.pos_manage_catalogue(jsonb,text) to authenticated;
revoke all on function public.pos_menu_media_authority(uuid,uuid,uuid,text),public.pos_menu_media_context(uuid,uuid,uuid,text),public.pos_menu_media_result(public.pos_menu_media,boolean),public.pos_menu_media_register(uuid,uuid,uuid,text,jsonb),public.pos_menu_media_read(uuid) from public,anon,authenticated,service_role;
grant execute on function public.pos_menu_media_context(uuid,uuid,uuid,text),public.pos_menu_media_register(uuid,uuid,uuid,text,jsonb),public.pos_menu_media_read(uuid) to service_role;
