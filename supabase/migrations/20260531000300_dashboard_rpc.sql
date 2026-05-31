create or replace view v_orders_summary as
  select tenant_id, date_trunc('day', created_at) as day, count(*) as orders, sum(total_aed) as revenue
  from orders
  where status not in ('cancelled')
  group by 1, 2;

create or replace view v_top_items as
  select o.tenant_id, oi.name_snapshot as item, sum(oi.qty) as qty, sum(oi.qty * oi.unit_price_aed) as revenue,
         date_trunc('day', o.created_at) as day
  from orders o
  join order_items oi on oi.order_id = o.id
  where o.status not in ('cancelled')
  group by 1, 2, 5;

create or replace view v_recent_complaints as
  select c.tenant_id, m.body, m.created_at
  from messages m
  join conversations c on c.id = m.conversation_id
  where m.direction = 'inbound' and m.body ~* '\m(complaint|cold|late|wrong|refund|bad|terrible)\M'
  order by m.created_at desc;

alter view v_orders_summary set (security_invoker = on);
alter view v_top_items set (security_invoker = on);
alter view v_recent_complaints set (security_invoker = on);

create or replace function ai_query(sql text) returns jsonb
language plpgsql security invoker as $$
declare result jsonb;
begin
  if sql !~* '^\s*select\s' then raise exception 'Only SELECT statements allowed'; end if;
  if sql ~* '\b(insert|update|delete|drop|alter|create|grant|truncate)\b' then raise exception 'Mutations blocked'; end if;
  if sql !~* '\b(v_orders_summary|v_top_items|v_recent_complaints)\b' then raise exception 'Only views v_orders_summary / v_top_items / v_recent_complaints allowed'; end if;
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s limit 200) t', sql) into result;
  return result;
end;
$$;
