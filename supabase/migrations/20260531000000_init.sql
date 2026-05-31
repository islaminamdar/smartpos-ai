create extension if not exists "pgcrypto";

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  default_locale text not null default 'en',
  rtl boolean not null default false,
  whatsapp_phone_number_id text,
  whatsapp_access_token text,
  printnode_printer_id integer,
  stripe_customer_id text,
  subscription_status text not null default 'trial',
  trial_ends_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  role text not null check (role in ('owner','manager','staff')),
  full_name text,
  created_at timestamptz not null default now()
);
create index on users (tenant_id);

create table menu_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  sort_order int not null default 0
);
create index on menu_categories (tenant_id);

create table menu_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  category_id uuid references menu_categories(id) on delete set null,
  name text not null,
  name_translations jsonb not null default '{}',
  description text,
  price_aed numeric(10,2) not null,
  active boolean not null default true,
  aliases text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index on menu_items (tenant_id);
create index on menu_items using gin (aliases);

create table menu_modifiers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  item_id uuid not null references menu_items(id) on delete cascade,
  name text not null,
  options jsonb not null,
  required boolean not null default false
);
create index on menu_modifiers (tenant_id);

create type order_channel as enum ('voice','whatsapp','manual');
create type order_status as enum ('new','accepted','preparing','ready','served','cancelled');

create table orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  channel order_channel not null,
  status order_status not null default 'new',
  customer_name text,
  customer_phone text,
  table_label text,
  subtotal_aed numeric(10,2) not null default 0,
  total_aed numeric(10,2) not null default 0,
  raw_input text,
  parse_confidence numeric(4,3),
  created_at timestamptz not null default now()
);
create index on orders (tenant_id, created_at desc);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  menu_item_id uuid references menu_items(id) on delete set null,
  name_snapshot text not null,
  qty int not null check (qty > 0),
  unit_price_aed numeric(10,2) not null,
  modifiers_snapshot jsonb not null default '[]',
  notes text
);
create index on order_items (order_id);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  channel text not null check (channel in ('whatsapp','dashboard_chat')),
  external_id text,
  customer_name text,
  ai_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index on conversations (tenant_id, created_at desc);
create unique index on conversations (tenant_id, channel, external_id);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound')),
  author text not null check (author in ('customer','ai','owner','system')),
  body text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on messages (conversation_id, created_at);

create table printers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  printnode_id integer not null,
  label text not null,
  active boolean not null default true
);

create table ai_usage (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric(10,5) not null default 0,
  created_at timestamptz not null default now()
);
create index on ai_usage (tenant_id, created_at desc);
