-- A public URL is a branded entry point only. Staff membership and registered devices
-- remain the authority for sales, so a guessed slug never grants counter access.
create table public.pos_counter_portals (
  slug text primary key check (slug ~ '^[a-z0-9]$' or slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$') check (slug !~ '--'),
  organization_id uuid not null,
  branch_id uuid not null,
  display_name text not null check (length(trim(display_name)) between 1 and 120),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (organization_id, branch_id) references public.pos_branches(organization_id, id),
  unique (organization_id, branch_id)
);

alter table public.pos_counter_portals enable row level security;
revoke all on public.pos_counter_portals from public, anon, authenticated;

-- First live customer. Additional portals are added during customer onboarding.
insert into public.pos_counter_portals (slug, organization_id, branch_id, display_name)
values (
  'agsum',
  '8feaa1e9-c27d-44e7-94ae-60944c131c14',
  '79d4b844-1fd4-4cdf-a32f-db9329d75f3a',
  'Suleman Usman Mithaiwala'
);
