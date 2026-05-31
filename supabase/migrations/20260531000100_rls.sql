create or replace function current_tenant_id() returns uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from users where id = auth.uid()
$$;

alter table tenants enable row level security;
alter table users enable row level security;
alter table menu_categories enable row level security;
alter table menu_items enable row level security;
alter table menu_modifiers enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table printers enable row level security;
alter table ai_usage enable row level security;

create policy tenants_self_read on tenants for select using (id = current_tenant_id());
create policy users_same_tenant on users for select using (tenant_id = current_tenant_id());

create policy menu_categories_rw on menu_categories for all
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());

create policy menu_items_rw on menu_items for all
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());

create policy menu_modifiers_rw on menu_modifiers for all
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());

create policy orders_rw on orders for all
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());

create policy order_items_rw on order_items for all
  using (exists (select 1 from orders o where o.id = order_items.order_id and o.tenant_id = current_tenant_id()))
  with check (exists (select 1 from orders o where o.id = order_items.order_id and o.tenant_id = current_tenant_id()));

create policy conversations_rw on conversations for all
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());

create policy messages_rw on messages for all
  using (exists (select 1 from conversations c where c.id = messages.conversation_id and c.tenant_id = current_tenant_id()))
  with check (exists (select 1 from conversations c where c.id = messages.conversation_id and c.tenant_id = current_tenant_id()));

create policy printers_rw on printers for all
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());

create policy ai_usage_read on ai_usage for select using (tenant_id = current_tenant_id());
