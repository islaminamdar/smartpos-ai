-- All financial RPCs already lock their shift before inserting financial rows.
-- The trigger also takes that lock, so concurrent withdrawals/refunds cannot both
-- spend the same cash. Idempotent command replays never reach this insert trigger.
create function public.pos_require_available_cash() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_opening bigint; v_expected bigint;
begin
  if new.amount_fils>=0 then return new; end if;
  select opening_cash_fils into v_opening from public.pos_shifts
    where id=new.shift_id and organization_id=new.organization_id and branch_id=new.branch_id and device_id=new.device_id
    for update;
  if not found then raise exception 'POS_SHIFT_INVALID'; end if;
  select v_opening
    + coalesce((select sum(p.amount_fils) from public.pos_payments p join public.pos_orders o on o.id=p.order_id where o.shift_id=new.shift_id and p.method='cash'),0)
    + coalesce((select sum(amount_fils) from public.pos_cash_movements where shift_id=new.shift_id),0)
    - coalesce((select sum(amount_fils) from public.pos_refunds where shift_id=new.shift_id and method='cash'),0)
    into v_expected;
  if v_expected+new.amount_fils<0 then raise exception 'POS_INSUFFICIENT_CASH'; end if;
  return new;
end; $$;
revoke all on function public.pos_require_available_cash() from public,anon,authenticated;
create trigger pos_cash_out_balance before insert on public.pos_cash_movements
  for each row execute function public.pos_require_available_cash();
