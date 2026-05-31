-- Idempotent demo tenant seed. Only inserts if 'Demo Café' doesn't exist.
do $$
declare demo uuid;
begin
  if not exists (select 1 from tenants where name = 'Demo Café') then
    insert into tenants (name, default_locale) values ('Demo Café', 'en') returning id into demo;
    insert into menu_categories (tenant_id, name, sort_order) values
      (demo, 'Drinks', 0), (demo, 'Mains', 1);
    insert into menu_items (tenant_id, category_id, name, aliases, price_aed)
    select demo, c.id, x.name, x.aliases, x.price
    from menu_categories c
    join (values
      ('Drinks', 'Karak Tea', ARRAY['karak','chai','tea']::text[], 5),
      ('Drinks', 'Mineral Water', ARRAY['water','moya']::text[], 2),
      ('Mains', 'Chicken Biryani', ARRAY['biryani']::text[], 25),
      ('Mains', 'Cheese Manakish', ARRAY['manakish','cheese manaeesh']::text[], 15)
    ) x(category, name, aliases, price) on c.name = x.category and c.tenant_id = demo;
  end if;
end$$;
