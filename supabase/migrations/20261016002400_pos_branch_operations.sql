-- Manager operations snapshot, candidate only. No financial writes or feature enablement.
-- Every source is branch scoped and capped before materialization. Exceeding a cap
-- fails the entire response; list limits never define an aggregate's completeness.
create index pos_operations_shifts on public.pos_shifts(branch_id,status,closed_at,opened_at,id);
create index pos_operations_authorities on public.pos_offline_authorities(branch_id,id);
create index pos_operations_epochs on public.pos_offline_key_epochs(branch_id,id);
create index pos_operations_raw on public.pos_offline_raw_evidence(branch_id,id);
create index pos_operations_exceptions on public.pos_offline_exceptions(authority_id,id);
create index pos_operations_legacy_orders on public.pos_orders(branch_id,received_at);

create function public.pos_branch_operations(p_branch uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare org uuid;branch_name text;as_of timestamptz:=statement_timestamp();business_day date;
 window_start timestamptz;answer jsonb;oversized boolean;invalid_data boolean;number_value jsonb;
begin
 -- VOLATILE is deliberate: after waiting for a staff mutation, the next statement
 -- must see the committed revocation rather than the caller's pre-lock snapshot.
 org:=public.pos_lock_staff_authority(p_branch);
 select b.name into branch_name from public.pos_branches b
 where b.id=p_branch and b.organization_id=org and b.active
 and exists(select 1 from public.pos_staff s where s.organization_id=org and s.user_id=auth.uid()
 and s.active and s.role in ('owner','manager') and (s.branch_id is null or s.branch_id=p_branch));
 if not found then raise exception 'POS_OPERATIONS_ACCESS_DENIED';end if;
 business_day:=(as_of at time zone 'Asia/Dubai')::date;
 window_start:=(business_day-29)::timestamp at time zone 'Asia/Dubai';
 -- This single statement supplies every data section. Stable SQL011 runs inside
 -- its snapshot; no volatile custody helper or request finalizer is invoked.
 with
 opened as materialized(select id,device_id,opened_by,opened_at,opening_cash_fils from public.pos_shifts where branch_id=p_branch and organization_id=org and status='open' limit 50001),
 closed as materialized(select id,device_id,opened_by,opened_at,closed_at,counted_cash_fils,expected_cash_fils,cash_difference_fils from public.pos_shifts where branch_id=p_branch and organization_id=org and status='closed' and closed_at>=window_start and closed_at<as_of limit 50001),
 tabs as materialized(select id,label,service_type,table_id,created_at,updated_at,subtotal_fils from public.pos_open_tabs where branch_id=p_branch and organization_id=org and status='open' limit 50001),
 paid_kitchen as materialized(select status from public.pos_kitchen_tickets where branch_id=p_branch and organization_id=org and status in ('queued','preparing','ready') limit 50001),
 tab_kitchen_source as materialized(select id,event_sequence,acknowledged_sequence from public.pos_tab_kitchen_tickets where branch_id=p_branch and organization_id=org limit 50001),
 tab_kitchen as materialized(select t.id,t.event_sequence,t.acknowledged_sequence from tab_kitchen_source t where
 (t.event_sequence>t.acknowledged_sequence or exists(select 1 from public.pos_tab_kitchen_batches b where b.ticket_id=t.id and b.stage in ('queued','preparing','ready') and b.quantity_milli>0)) limit 50001),
 batches as materialized(select b.id,b.stage from tab_kitchen t join public.pos_tab_kitchen_batches b on b.ticket_id=t.id where b.stage in ('queued','preparing','ready') and b.quantity_milli>0 limit 50001),
 authorities as materialized(select id,key_epoch,sealed_at from public.pos_offline_authorities where branch_id=p_branch and organization_id=org limit 50001),
 epochs as materialized(select id,blocked from public.pos_offline_key_epochs where branch_id=p_branch and organization_id=org limit 50001),
 exceptions as materialized(select x.id from authorities a join public.pos_offline_exceptions x on x.authority_id=a.id where not exists(select 1 from public.pos_offline_exception_resolutions r where r.exception_id=x.id) limit 50001),
 freezes as materialized(select f.id from authorities a join public.pos_offline_payment_freezes f on f.authority_id=a.id where not exists(select 1 from public.pos_offline_payment_decisions d join public.pos_offline_payment_result_signatures s on s.resolution_id=d.id where d.freeze_id=f.id) limit 50001),
 conflicts as materialized(select c.id from authorities a join public.pos_offline_payment_conflicts c on c.authority_id=a.id limit 50001),
 raw_evidence as materialized(select id from public.pos_offline_raw_evidence where branch_id=p_branch and organization_id=org limit 50001),
 counts as materialized(select
 (select count(*) from opened) n_open,(select count(*) from closed) n_closed,(select count(*) from tabs) n_tabs,
 (select count(*) from tab_kitchen_source) n_tab_source,(select count(*) from paid_kitchen) n_paid,(select count(*) from tab_kitchen) n_tab_kitchen,(select count(*) from batches) n_batches,
 (select count(*) from authorities) n_authorities,(select count(*) from epochs) n_epochs,(select count(*) from exceptions) n_exceptions,
 (select count(*) from freezes) n_freezes,(select count(*) from conflicts) n_conflicts,(select count(*) from raw_evidence) n_raw),
 bounded as materialized(select *,greatest(n_open,n_closed,n_tabs,n_tab_source,n_paid,n_tab_kitchen,n_batches,n_authorities,n_epochs,n_exceptions,n_freezes,n_conflicts,n_raw)>50000 too_large from counts),
 report as materialized(select case when not too_large then public.pos_branch_report(p_branch,business_day,business_day) else '{}'::jsonb end value from bounded)
 select b.too_large,exists(select 1 from closed where (counted_cash_fils is not null and (counted_cash_fils<0 or abs(counted_cash_fils::numeric)>9007199254740991)) or (expected_cash_fils is not null and abs(expected_cash_fils::numeric)>9007199254740991) or (cash_difference_fils is not null and abs(cash_difference_fils::numeric)>9007199254740991) or (counted_cash_fils is not null and expected_cash_fils is not null and cash_difference_fils is not null and cash_difference_fils::numeric<>counted_cash_fils::numeric-expected_cash_fils::numeric)),jsonb_build_object(
 'schemaVersion',1,'status','ready','branchId',p_branch,'branchName',branch_name,'currency','AED','timezone','Asia/Dubai','businessDate',business_day,'generatedAt',as_of,'basis','server_recorded','offlineDeviceCoverage','unknown',
 'sales',jsonb_build_object('documentCount',r.value->'documentCount','legacyOrdersExcluded',r.value->'legacyOrdersExcluded','summary',r.value->'summary','payments',r.value->'payments'),
 'openShifts',jsonb_build_object('totalCount',b.n_open,'limit',20,'truncated',b.n_open>20,'items',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'deviceId',s.device_id,'deviceName',d.name,'openedBy',s.opened_by,'staffName',st.display_name,'openedAt',s.opened_at,'openingCashFils',s.opening_cash_fils) order by s.opened_at,s.id) from (select * from opened order by opened_at,id limit 20) s join public.pos_devices d on d.id=s.device_id and d.branch_id=p_branch and d.organization_id=org left join public.pos_staff st on st.organization_id=org and st.user_id=s.opened_by),'[]'::jsonb)),
 'closedShifts',jsonb_build_object('windowStart',window_start,'windowEnd',as_of,'totalCount',b.n_closed,'incompleteCount',(select count(*) from closed where counted_cash_fils is null or expected_cash_fils is null or cash_difference_fils is null),'discrepancyCount',(select count(*) from closed where cash_difference_fils<>0 and counted_cash_fils is not null and expected_cash_fils is not null),'netDifferenceFils',(select case when count(*) filter(where counted_cash_fils is null or expected_cash_fils is null or cash_difference_fils is null)>0 then null else coalesce(sum(cash_difference_fils),0) end from closed),'limit',20,'truncated',b.n_closed>20,'items',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'deviceId',s.device_id,'deviceName',d.name,'openedBy',s.opened_by,'staffName',st.display_name,'openedAt',s.opened_at,'closedAt',s.closed_at,'countedCashFils',s.counted_cash_fils,'expectedCashFils',s.expected_cash_fils,'cashDifferenceFils',s.cash_difference_fils) order by s.closed_at desc,s.id desc) from (select * from closed order by closed_at desc,id desc limit 20) s join public.pos_devices d on d.id=s.device_id and d.branch_id=p_branch and d.organization_id=org left join public.pos_staff st on st.organization_id=org and st.user_id=s.opened_by),'[]'::jsonb)),
 'unpaidOrders',jsonb_build_object('totalCount',b.n_tabs,'totalFils',(select coalesce(sum(subtotal_fils),0) from tabs),'oldestCreatedAt',(select min(created_at) from tabs),'limit',20,'truncated',b.n_tabs>20,'items',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'label',t.label,'serviceType',t.service_type,'tableName',d.name,'createdAt',t.created_at,'updatedAt',t.updated_at,'totalFils',t.subtotal_fils) order by t.created_at,t.id) from (select * from tabs order by created_at,id limit 20) t left join public.pos_dining_tables d on d.id=t.table_id and d.branch_id=p_branch and d.organization_id=org),'[]'::jsonb)),
 'kitchen',jsonb_build_object('paidTickets',jsonb_build_object('queued',(select count(*) from paid_kitchen where status='queued'),'preparing',(select count(*) from paid_kitchen where status='preparing'),'ready',(select count(*) from paid_kitchen where status='ready')),'tabTickets',jsonb_build_object('activeCount',b.n_tab_kitchen,'withUnacknowledgedChanges',(select count(*) from tab_kitchen where event_sequence>acknowledged_sequence)),'tabBatches',jsonb_build_object('queued',(select count(*) from batches where stage='queued'),'preparing',(select count(*) from batches where stage='preparing'),'ready',(select count(*) from batches where stage='ready'))),
 'offlineCustody',jsonb_build_object('unsealedAuthorities',(select count(*) from authorities where sealed_at is null),'unresolvedUploadExceptions',b.n_exceptions,'pendingPaymentFreezes',b.n_freezes,'conflictRecords',b.n_conflicts,'unsupportedEvidenceRecords',b.n_raw,'blockedDeviceEpochs',(select count(*) from epochs where blocked))
 ) into oversized,invalid_data,answer from bounded b cross join report r;
 if oversized then raise exception 'POS_OPERATIONS_TOO_LARGE';end if;
 if invalid_data then raise exception 'POS_OPERATIONS_INVALID_DATA';end if;
 if (answer->'sales'->>'legacyOrdersExcluded')::numeric>50000 then raise exception 'POS_OPERATIONS_TOO_LARGE';end if;
 -- JSON numeric output must survive exact integer parsing in the web client.
 for number_value in select value from jsonb_path_query(answer,'$.** ? (@.type() == "number")') value loop
 if (number_value::text)::numeric<>trunc((number_value::text)::numeric) or abs((number_value::text)::numeric)>9007199254740991 then raise exception 'POS_OPERATIONS_INVALID_DATA';end if;
 end loop;
 return answer;
end $$;
revoke all on function public.pos_branch_operations(uuid) from public,anon,authenticated,service_role;
grant execute on function public.pos_branch_operations(uuid) to authenticated;
