-- Candidate-only station workflow. No branch admission is enabled by this migration.
-- New request namespace46; existing15 actor,21 dispatch request,20 tab serialization.
-- No workflow operation acquires station configuration44 after a financial/ticket lock.
create table public.pos_kitchen_station_policy(
 branch_id uuid primary key,organization_id uuid not null,enabled boolean not null default false,
 foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id));
alter table public.pos_tab_kitchen_tickets add constraint pos_station_tab_tenant_identity unique(organization_id,branch_id,id);
create table public.pos_kitchen_station_roots(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,branch_id uuid not null,family text not null check(family in ('paid','tab')),
 order_id uuid unique references public.pos_kitchen_tickets(order_id),ticket_id uuid unique references public.pos_tab_kitchen_tickets,
 check((family='paid' and order_id is not null and ticket_id is null) or (family='tab' and ticket_id is not null and order_id is null)),
 foreign key(organization_id,branch_id) references public.pos_branches(organization_id,id),
 foreign key(organization_id,branch_id,order_id) references public.pos_orders(organization_id,branch_id,id),
 foreign key(organization_id,branch_id,ticket_id) references public.pos_tab_kitchen_tickets(organization_id,branch_id,id));
create table public.pos_kitchen_station_generations(
 root_id uuid not null references public.pos_kitchen_station_roots,generation integer not null check(generation>0),
 state text not null check(state in ('open','cancelled')),payment text not null check(payment in ('unpaid','paid','refunded')),
 order_id uuid references public.pos_orders,invoice_id uuid references public.pos_documents,invoice_number text,metadata jsonb not null,
 primary key(root_id,generation),check((payment='unpaid')=(invoice_id is null)),check((invoice_id is null)=(order_id is null)),check((invoice_id is null)=(invoice_number is null)));
create table public.pos_kitchen_station_work(
 id uuid primary key default gen_random_uuid(),root_id uuid not null,generation integer not null,
 station_key text not null,station_id uuid references public.pos_kitchen_stations,station_name text not null,
 revision integer not null default 1 check(revision>0),notice_sequence integer not null default 0 check(notice_sequence>=0),
 paid_stage text check(paid_stage in ('queued','preparing','ready','served','cancelled')),
 issued_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 foreign key(root_id,generation) references public.pos_kitchen_station_generations,
 unique(root_id,generation,station_key),unique(root_id,generation,id),check((station_id is null and station_key='general' and station_name='General') or (station_id is not null and station_key=station_id::text)));
create table public.pos_kitchen_station_product_ownership(
 root_id uuid not null,generation integer not null,product_id uuid not null references public.pos_products,work_id uuid not null references public.pos_kitchen_station_work,
 primary key(root_id,generation,product_id),foreign key(root_id,generation) references public.pos_kitchen_station_generations,
 foreign key(root_id,generation,work_id) references public.pos_kitchen_station_work(root_id,generation,id));
create table public.pos_kitchen_station_batch_ownership(
 batch_id uuid primary key references public.pos_tab_kitchen_batches,work_id uuid not null references public.pos_kitchen_station_work);
create index pos_station_batch_work on public.pos_kitchen_station_batch_ownership(work_id,batch_id);
create table public.pos_kitchen_station_invoice_lines(
 invoice_id uuid not null references public.pos_documents,line_number integer not null check(line_number between 1 and 200),work_id uuid not null references public.pos_kitchen_station_work,
 line jsonb not null,primary key(invoice_id,line_number));
create index pos_station_invoice_work on public.pos_kitchen_station_invoice_lines(work_id);
create table public.pos_kitchen_station_notices(
 id uuid primary key default gen_random_uuid(),work_id uuid not null references public.pos_kitchen_station_work,sequence integer not null check(sequence>0),
 kind text not null check(kind in ('dispatch','reopen','void','return','cancel')),source_key text not null,source jsonb not null,detail jsonb not null,reason text,created_at timestamptz not null,
 unique(work_id,sequence),unique(work_id,source_key));
create table public.pos_kitchen_station_notice_acknowledgements(
 notice_id uuid primary key references public.pos_kitchen_station_notices,actor_id uuid not null references auth.users,device_id uuid not null references public.pos_devices,
 acknowledged_at timestamptz not null default clock_timestamp());
create table public.pos_kitchen_station_work_commands(
 id uuid primary key,organization_id uuid not null,branch_id uuid not null,actor_id uuid not null references auth.users,device_id uuid not null,
 payload jsonb not null,result jsonb not null,status text not null check(status in ('updated','cancelled')),created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,branch_id,device_id) references public.pos_devices(organization_id,branch_id,id));
-- Trusted invocation context: no caller-controlled GUC; removed before dispatch returns.
create table public.pos_kitchen_station_dispatch_context(
 transaction_id bigint primary key,request_id uuid not null,tab_id uuid not null,organization_id uuid not null,branch_id uuid not null,
 enabled boolean not null,configuration_revision integer not null,routes jsonb not null);
do $$declare t text;begin
 foreach t in array array['pos_kitchen_station_policy','pos_kitchen_station_roots','pos_kitchen_station_generations','pos_kitchen_station_work','pos_kitchen_station_product_ownership','pos_kitchen_station_batch_ownership','pos_kitchen_station_invoice_lines','pos_kitchen_station_notices','pos_kitchen_station_notice_acknowledgements','pos_kitchen_station_work_commands','pos_kitchen_station_dispatch_context'] loop
  execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 end loop;
 foreach t in array array['pos_kitchen_station_roots','pos_kitchen_station_product_ownership','pos_kitchen_station_batch_ownership','pos_kitchen_station_invoice_lines','pos_kitchen_station_notices','pos_kitchen_station_notice_acknowledgements','pos_kitchen_station_work_commands'] loop
  execute format('create trigger %I before update or delete on public.%I for each row execute function public.pos_preserve_document()',t||'_immutable',t);
 end loop;
end $$;
create function public.pos_station_time(p timestamptz) returns text language sql immutable set search_path='' as $$select to_char(p at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')$$;
create function public.pos_station_work_guard() returns trigger language plpgsql set search_path='' as $$begin
 if tg_op='DELETE' or row(new.id,new.root_id,new.generation,new.station_key,new.station_id,new.station_name,new.issued_at) is distinct from row(old.id,old.root_id,old.generation,old.station_key,old.station_id,old.station_name,old.issued_at) then raise exception 'POS_IMMUTABLE_DOCUMENT';end if;return new;
end $$;
create trigger pos_station_work_identity before update or delete on public.pos_kitchen_station_work for each row execute function public.pos_station_work_guard();
create function public.pos_station_work_for(p_root uuid,p_generation integer,p_station uuid,p_name text,p_paid boolean) returns uuid language plpgsql set search_path='' as $$
declare target uuid;begin
 select id into target from public.pos_kitchen_station_work where root_id=p_root and generation=p_generation and station_key=coalesce(p_station::text,'general');
 if target is null then insert into public.pos_kitchen_station_work(root_id,generation,station_key,station_id,station_name,paid_stage) values(p_root,p_generation,coalesce(p_station::text,'general'),p_station,p_name,case when p_paid then 'queued' else null end) returning id into target;end if;
 return target;
end $$;
create function public.pos_station_pending(p_work uuid) returns integer language sql stable set search_path='' as $$
 select count(*)::integer from public.pos_kitchen_station_notices n where n.work_id=p_work and not exists(select 1 from public.pos_kitchen_station_notice_acknowledgements a where a.notice_id=n.id)
$$;
create function public.pos_station_stages(p_work uuid) returns jsonb language sql stable set search_path='' as $$
 with quantities as (
  select b.product_id,b.name,b.unit,b.stage,b.quantity_milli::bigint quantity from public.pos_kitchen_station_batch_ownership x join public.pos_tab_kitchen_batches b on b.id=x.batch_id where x.work_id=p_work and b.quantity_milli>0
  union all
  select (l.line->>'productId')::uuid,l.line->>'name',l.line->>'unit',w.paid_stage,(l.line->>'quantityMilli')::bigint from public.pos_kitchen_station_invoice_lines l join public.pos_kitchen_station_work w on w.id=l.work_id join public.pos_kitchen_station_roots r on r.id=w.root_id where l.work_id=p_work and r.family='paid' and w.paid_stage<>'cancelled'),
 grouped as(select product_id,name,unit,stage,sum(quantity) quantity from quantities group by product_id,name,unit,stage)
 select jsonb_object_agg(s,coalesce((select jsonb_agg(jsonb_build_object('productId',g.product_id,'name',g.name,'unit',g.unit,'quantityMilli',g.quantity) order by g.product_id,g.name,g.unit) from grouped g where g.stage=s),'[]'::jsonb)) from unnest(array['queued','preparing','ready','served']) s
$$;
create function public.pos_station_work_snapshot(p public.pos_kitchen_station_work) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p.id,'branchId',r.branch_id,'family',r.family,'stationId',p.station_id,'stationName',p.station_name,'generation',p.generation,'revision',p.revision,
 'orderId',g.order_id,'tabId',t.tab_id,'ticketId',r.ticket_id,'invoiceId',g.invoice_id,'invoiceNumber',g.invoice_number,'payment',g.payment,'state',g.state,'metadata',g.metadata,
 'stages',public.pos_station_stages(p.id),'pendingNoticeCount',public.pos_station_pending(p.id),'issuedAt',public.pos_station_time(p.issued_at),'updatedAt',public.pos_station_time(p.updated_at))
 from public.pos_kitchen_station_roots r join public.pos_kitchen_station_generations g on g.root_id=r.id and g.generation=p.generation left join public.pos_tab_kitchen_tickets t on t.id=r.ticket_id where r.id=p.root_id
$$;
create function public.pos_station_notice_snapshot(p public.pos_kitchen_station_notices) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p.id,'workId',p.work_id,'sequence',p.sequence,'kind',p.kind,'createdAt',public.pos_station_time(p.created_at),'reason',p.reason,'source',p.source,'detail',p.detail,
 'acknowledgedAt',(select public.pos_station_time(a.acknowledged_at) from public.pos_kitchen_station_notice_acknowledgements a where a.notice_id=p.id))
$$;
create function public.pos_station_notice(p_work uuid,p_kind text,p_key text,p_source jsonb,p_detail jsonb,p_reason text,p_time timestamptz) returns void language plpgsql set search_path='' as $$
declare seq integer;begin
 if exists(select 1 from public.pos_kitchen_station_notices where work_id=p_work and source_key=p_key) then return;end if;
 update public.pos_kitchen_station_work set notice_sequence=notice_sequence+1,revision=revision+1,updated_at=greatest(updated_at,p_time) where id=p_work returning notice_sequence into seq;
 if seq is null then raise exception 'POS_KITCHEN_STATION_UNAVAILABLE';end if;
 insert into public.pos_kitchen_station_notices(work_id,sequence,kind,source_key,source,detail,reason,created_at) values(p_work,seq,p_kind,p_key,p_source,p_detail,p_reason,p_time);
end $$;

create function public.pos_station_ticket_project() returns trigger language plpgsql security definer set search_path='' as $$
declare rid uuid;wid uuid;routes jsonb;l jsonb;ctx public.pos_kitchen_station_dispatch_context;begin
 if tg_table_name='pos_tab_kitchen_tickets' then
  select * into ctx from public.pos_kitchen_station_dispatch_context where transaction_id=txid_current() and tab_id=new.tab_id and organization_id=new.organization_id and branch_id=new.branch_id and enabled;
  if not found then return new;end if;
  insert into public.pos_kitchen_station_roots(organization_id,branch_id,family,ticket_id) values(new.organization_id,new.branch_id,'tab',new.id) returning id into rid;
  insert into public.pos_kitchen_station_generations(root_id,generation,state,payment,metadata) values(rid,new.generation,'open','unpaid',new.metadata);
  return new;
 end if;
 if tg_op='UPDATE' then
  if new.status='cancelled' and old.status<>'cancelled' then
   select id into rid from public.pos_kitchen_station_roots where order_id=new.order_id;
   if rid is not null then
    update public.pos_kitchen_station_generations set state='cancelled',payment='refunded' where root_id=rid;
    update public.pos_kitchen_station_work set paid_stage='cancelled',revision=revision+1,updated_at=greatest(updated_at,new.updated_at) where root_id=rid;
   end if;
  end if;return new;
 end if;
 if not exists(select 1 from public.pos_kitchen_station_policy where branch_id=new.branch_id and organization_id=new.organization_id and enabled) then return new;end if;
 -- One SQL snapshot for every product on this invoice, never one query per line.
 select jsonb_agg(x.line||jsonb_build_object('stationId',r.station_id,'stationName',coalesce(s.name,'General')) order by x.ord) into routes
 from jsonb_array_elements(new.lines) with ordinality x(line,ord)
 left join public.pos_kitchen_product_routes r on r.product_id=(x.line->>'productId')::uuid and r.organization_id=new.organization_id and r.branch_id=new.branch_id
 left join public.pos_kitchen_stations s on s.id=r.station_id;
 insert into public.pos_kitchen_station_roots(organization_id,branch_id,family,order_id) values(new.organization_id,new.branch_id,'paid',new.order_id) returning id into rid;
 insert into public.pos_kitchen_station_generations(root_id,generation,state,payment,order_id,invoice_id,invoice_number,metadata)
 values(rid,1,'open','paid',new.order_id,new.invoice_id,new.invoice_number,jsonb_build_object('label',null,'serviceType',new.service_type,'tableId',null,'tableName',null,'guestCount',null,'note',null));
 for l in select value from jsonb_array_elements(routes) loop
  wid:=public.pos_station_work_for(rid,1,(l->>'stationId')::uuid,l->>'stationName',true);
  insert into public.pos_kitchen_station_invoice_lines(invoice_id,line_number,work_id,line) values(new.invoice_id,(l->>'lineNumber')::integer,wid,l-array['stationId','stationName']);
 end loop;
 return new;
end $$;
create trigger pos_station_paid_projection after insert or update on public.pos_kitchen_tickets for each row execute function public.pos_station_ticket_project();
create trigger pos_station_tab_projection after insert on public.pos_tab_kitchen_tickets for each row execute function public.pos_station_ticket_project();

create function public.pos_station_batch_project() returns trigger language plpgsql security definer set search_path='' as $$
declare root public.pos_kitchen_station_roots;ticket public.pos_tab_kitchen_tickets;ctx public.pos_kitchen_station_dispatch_context;wid uuid;assignment jsonb;begin
 select * into root from public.pos_kitchen_station_roots where ticket_id=new.ticket_id;if not found then return new;end if;
 select * into ticket from public.pos_tab_kitchen_tickets where id=new.ticket_id;
 -- Reopen inserts batches BEFORE the parent generation advances. NEW is authoritative.
 insert into public.pos_kitchen_station_generations(root_id,generation,state,payment,metadata) values(root.id,new.generation,'open','unpaid',ticket.metadata) on conflict do nothing;
 select work_id into wid from public.pos_kitchen_station_product_ownership where root_id=root.id and generation=new.generation and product_id=new.product_id;
 if wid is null then
  select * into ctx from public.pos_kitchen_station_dispatch_context where transaction_id=txid_current() and tab_id=ticket.tab_id and organization_id=root.organization_id and branch_id=root.branch_id;
  if not found then raise exception 'POS_KITCHEN_STATION_CONTEXT';end if;
  select value into assignment from jsonb_array_elements(ctx.routes) where value->>'productId'=new.product_id::text;
  if assignment is null then raise exception 'POS_KITCHEN_STATION_CONTEXT';end if;
  wid:=public.pos_station_work_for(root.id,new.generation,(assignment->>'stationId')::uuid,assignment->>'stationName',false);
  insert into public.pos_kitchen_station_product_ownership(root_id,generation,product_id,work_id) values(root.id,new.generation,new.product_id,wid);
 end if;
 insert into public.pos_kitchen_station_batch_ownership(batch_id,work_id) values(new.id,wid);return new;
end $$;
create trigger pos_station_batch_projection after insert on public.pos_tab_kitchen_batches for each row execute function public.pos_station_batch_project();
create function public.pos_station_filter_lines(p_lines jsonb,p_work uuid) returns jsonb language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(l order by l->>'productId',l->>'stage'),'[]'::jsonb) from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) l
 where exists(select 1 from public.pos_kitchen_station_product_ownership o where o.work_id=p_work and o.product_id=(l->>'productId')::uuid)
$$;
create function public.pos_station_event_project() returns trigger language plpgsql security definer set search_path='' as $$
declare root public.pos_kitchen_station_roots;w public.pos_kitchen_station_work;gen integer;kind text;before_lines jsonb;after_lines jsonb;adds jsonb;withdraws jsonb;meta_before jsonb;meta_after jsonb;stamp timestamptz;begin
 select * into root from public.pos_kitchen_station_roots where ticket_id=new.ticket_id;if not found then return new;end if;
 gen:=(new.event->>'generation')::integer;kind:=new.event->>'kind';stamp:=(new.event->>'createdAt')::timestamptz;
 meta_before:=new.event#>'{before,metadata}';meta_after:=new.event#>'{after,metadata}';
 update public.pos_kitchen_station_generations set metadata=meta_after,state=case when kind in ('void','refund') then 'cancelled' else 'open' end,
 payment=case when kind='refund' then 'refunded' else payment end where root_id=root.id and generation=gen;
 -- The corresponding credit hook owns refund notices; do not create two obligations.
 if kind='refund' then
  update public.pos_kitchen_station_work set revision=revision+1,updated_at=greatest(updated_at,stamp) where root_id=root.id and generation=gen;
  return new;
 end if;
 for w in select * from public.pos_kitchen_station_work where root_id=root.id and generation=gen order by id loop
  before_lines:=public.pos_station_filter_lines(new.event#>'{before,lines}',w.id);after_lines:=public.pos_station_filter_lines(new.event#>'{after,lines}',w.id);
  adds:=public.pos_station_filter_lines(new.event->'additions',w.id);withdraws:=public.pos_station_filter_lines(new.event->'withdrawals',w.id);
  if adds<>'[]'::jsonb or withdraws<>'[]'::jsonb or before_lines<>after_lines or meta_before is distinct from meta_after or kind in ('void','reopen') then
   perform public.pos_station_notice(w.id,kind,'event:'||new.ticket_id::text||':'||new.sequence::text,
    jsonb_build_object('ticketId',new.ticket_id,'eventSequence',new.sequence,'tabRevision',new.event->'tabRevision'),
    jsonb_build_object('metadataBefore',meta_before,'metadataAfter',meta_after,'beforeLines',before_lines,'afterLines',after_lines,'additions',adds,'withdrawals',withdraws),new.event->>'reason',stamp);
  end if;
 end loop;return new;
end $$;
create trigger pos_station_event_projection after insert on public.pos_tab_kitchen_events for each row execute function public.pos_station_event_project();

create function public.pos_station_credit_project(p public.pos_documents) returns void language plpgsql set search_path='' as $$
declare invoice uuid;wid uuid;lines jsonb;cancel_lines jsonb;full_return boolean;invoice_number text;begin
 if p.kind<>'tax_credit_note' then return;end if;
 -- Imported native invoices never create preparation or station notice obligations.
 if exists(select 1 from public.pos_offline_receipts where issuance_id=p.order_id and organization_id=p.organization_id and branch_id=p.branch_id) then return;end if;
 select id,document_number into invoice,invoice_number from public.pos_documents where order_id=p.order_id and kind='tax_invoice';
 if invoice is null then return;end if;
 -- SQL030 inserts its return notice before locking the preparation parent.
 -- Acquire that parent now, before any child revision/notice writes, preserving
 -- order -> ticket -> work against concurrent scoped stage/ACK commands.
 perform 1 from public.pos_kitchen_tickets where order_id=p.order_id for update;
 perform 1 from public.pos_tab_kitchen_tickets t join public.pos_tab_kitchen_payments payment on payment.ticket_id=t.id where payment.order_id=p.order_id for update of t;
 full_return:=case when p.snapshot->>'schemaVersion'='3' then (p.snapshot->>'fullyReturned')::boolean else true end;
 for wid in select distinct work_id from public.pos_kitchen_station_invoice_lines where invoice_id=invoice loop
  if p.snapshot->>'schemaVersion'='3' then
   select jsonb_agg(jsonb_build_object('originalLineNumber',l->'originalLineNumber','productId',l->'productId','name',l->'name','unit',l->'unit','quantityMilli',l->'quantityMilli',
    'remainingQuantityMilli',(l#>>'{originalLine,quantityMilli}')::bigint-(l->>'returnedAfterQuantityMilli')::bigint) order by (l->>'originalLineNumber')::integer) into lines
   from jsonb_array_elements(p.snapshot->'lines') l join public.pos_kitchen_station_invoice_lines m on m.invoice_id=invoice and m.line_number=(l->>'originalLineNumber')::integer and m.work_id=wid;
  else
   select jsonb_agg(jsonb_build_object('originalLineNumber',m.line_number,'productId',m.line->'productId','name',m.line->'name','unit',m.line->'unit','quantityMilli',m.line->'quantityMilli','remainingQuantityMilli',0) order by m.line_number)
   into lines from public.pos_kitchen_station_invoice_lines m where m.invoice_id=invoice and m.work_id=wid;
  end if;
  if lines is not null then perform public.pos_station_notice(wid,'return','credit:'||p.id::text,
   jsonb_build_object('invoiceId',invoice,'invoiceNumber',invoice_number,'creditNoteId',p.id,'creditNumber',p.document_number,'fullyReturned',full_return),jsonb_build_object('lines',lines),p.snapshot->>'reason',p.issued_at);
  elsif full_return then
   -- A previously returned line can still be in preparation. Final cancellation
   -- needs its own honest obligation, never a fabricated credit-note quantity.
   select jsonb_agg(jsonb_build_object('productId',product_id,'name',name,'unit',unit,'quantityMilli',quantity) order by product_id,name,unit) into cancel_lines
   from (select v->>'productId' product_id,v->>'name' name,v->>'unit' unit,sum((v->>'quantityMilli')::bigint) quantity
    from jsonb_each(public.pos_station_stages(wid)) stages cross join lateral jsonb_array_elements(stages.value) v
    group by v->>'productId',v->>'name',v->>'unit') remaining;
   if cancel_lines is not null then perform public.pos_station_notice(wid,'cancel','cancel:'||p.id::text,
    jsonb_build_object('invoiceId',invoice,'invoiceNumber',invoice_number,'creditNoteId',p.id,'creditNumber',p.document_number,'fullyReturned',true),jsonb_build_object('lines',cancel_lines),p.snapshot->>'reason',p.issued_at);end if;
  end if;
 end loop;
end $$;
create function public.pos_station_return_project() returns trigger language plpgsql security definer set search_path='' as $$
declare doc public.pos_documents;begin select * into doc from public.pos_documents where id=new.id;perform public.pos_station_credit_project(doc);return new;end $$;
create trigger pos_station_return_projection after insert on public.pos_kitchen_return_notices for each row execute function public.pos_station_return_project();
create function public.pos_station_document_project() returns trigger language plpgsql security definer set search_path='' as $$
declare root public.pos_kitchen_station_roots;ticket public.pos_tab_kitchen_tickets;l jsonb;wid uuid;begin
 if exists(select 1 from public.pos_offline_receipts where issuance_id=new.order_id and organization_id=new.organization_id and branch_id=new.branch_id) then return new;end if;
 if new.kind='tax_credit_note' then perform public.pos_station_credit_project(new);return new;end if;
 select r.* into root from public.pos_tab_kitchen_payments p join public.pos_kitchen_station_roots r on r.ticket_id=p.ticket_id where p.order_id=new.order_id;
 if not found then return new;end if;
 select * into ticket from public.pos_tab_kitchen_tickets where id=root.ticket_id;
 update public.pos_kitchen_station_generations set payment='paid',order_id=new.order_id,invoice_id=new.id,invoice_number=new.document_number where root_id=root.id and generation=ticket.generation;
 for l in select value from jsonb_array_elements(new.snapshot->'lines') loop
  select work_id into wid from public.pos_kitchen_station_product_ownership where root_id=root.id and generation=ticket.generation and product_id=(l->>'productId')::uuid;
  if wid is null then raise exception 'POS_KITCHEN_STATION_CONTEXT';end if;
  insert into public.pos_kitchen_station_invoice_lines(invoice_id,line_number,work_id,line) values(new.id,(l->>'lineNumber')::integer,wid,
   jsonb_build_object('lineNumber',l->'lineNumber','productId',l->'productId','name',l->'name','unit',l->'unit','quantityMilli',l->'quantityMilli'));
 end loop;
 update public.pos_kitchen_station_work set revision=revision+1,updated_at=greatest(updated_at,new.issued_at) where root_id=root.id and generation=ticket.generation;
 return new;
end $$;
-- PostgreSQL runs same-kind triggers alphabetically: this follows pos_documents_kitchen.
create trigger pos_documents_station_workflow after insert on public.pos_documents for each row execute function public.pos_station_document_project();

alter function public.pos_execute_tab_kitchen_command(jsonb,text) rename to pos_execute_tab_kitchen_before_station_workflow;
revoke all on function public.pos_execute_tab_kitchen_before_station_workflow(jsonb,text) from public,anon,authenticated,service_role;
create function public.pos_execute_tab_kitchen_command(p_command jsonb,p_binding text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare org uuid;branch uuid;device uuid;request uuid;tab public.pos_open_tabs;answer jsonb;begin
 perform public.pos_validate_tab_kitchen_command(p_command);branch:=(p_command->>'branchId')::uuid;device:=(p_command->>'deviceId')::uuid;request:=(p_command->>'id')::uuid;
 org:=public.pos_station_actor_gate(branch);perform pg_advisory_xact_lock(hashtextextended(request::text,21));
 -- Exact committed legacy requests remain byte-compatible, including recovery.
 if exists(select 1 from public.pos_tab_kitchen_commands where id=request) or exists(select 1 from public.pos_tab_kitchen_request_cancellations where request_id=request) then return public.pos_execute_tab_kitchen_before_station_workflow(p_command,p_binding);end if;
 perform public.pos_station_current_actor(org,branch,false);perform public.pos_station_device(org,branch,device,p_binding,false);
 if p_command->>'type'<>'dispatch' then
  if exists(select 1 from public.pos_kitchen_station_roots where ticket_id=(p_command->>'ticketId')::uuid and organization_id=org and branch_id=branch) then raise exception 'POS_KITCHEN_STATION_REQUIRED';end if;
  return public.pos_execute_tab_kitchen_before_station_workflow(p_command,p_binding);
 end if;
 perform pg_advisory_xact_lock(hashtextextended(branch::text,20));
 select * into tab from public.pos_open_tabs where id=(p_command->>'tabId')::uuid and organization_id=org and branch_id=branch for update;
 if not found then raise exception 'POS_TAB_NOT_FOUND';end if;
 -- Snapshot ALL candidate products, policy and configuration revision in ONE statement.
 -- No config44 lock after tab/product/ticket: manager edits cannot create a lock cycle.
 insert into public.pos_kitchen_station_dispatch_context(transaction_id,request_id,tab_id,organization_id,branch_id,enabled,configuration_revision,routes)
 select txid_current(),request,tab.id,org,branch,coalesce((select enabled from public.pos_kitchen_station_policy where branch_id=branch),false),
 coalesce((select revision from public.pos_kitchen_station_config where branch_id=branch),0),
 coalesce((select jsonb_agg(jsonb_build_object('productId',l->'productId','stationId',r.station_id,'stationName',coalesce(s.name,'General')) order by l->>'productId')
  from jsonb_array_elements(tab.lines) l left join public.pos_kitchen_product_routes r on r.product_id=(l->>'productId')::uuid and r.organization_id=org and r.branch_id=branch left join public.pos_kitchen_stations s on s.id=r.station_id),'[]'::jsonb);
 answer:=public.pos_execute_tab_kitchen_before_station_workflow(p_command,p_binding);
 delete from public.pos_kitchen_station_dispatch_context where transaction_id=txid_current() and request_id=request;
 return answer;
end $$;
alter function public.pos_transition_kitchen(jsonb,text) rename to pos_transition_kitchen_before_station_workflow;
revoke all on function public.pos_transition_kitchen_before_station_workflow(jsonb,text) from public,anon,authenticated,service_role;
create function public.pos_transition_kitchen(p_command jsonb,p_binding text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare org uuid;begin
 perform public.pos_validate_kitchen_command(p_command);org:=public.pos_station_actor_gate((p_command->>'branchId')::uuid);
 perform pg_advisory_xact_lock(hashtextextended(p_command->>'id',18));
 if not exists(select 1 from public.pos_kitchen_commands where id=(p_command->>'id')::uuid) and exists(select 1 from public.pos_kitchen_station_roots where order_id=(p_command->>'orderId')::uuid and organization_id=org and branch_id=(p_command->>'branchId')::uuid) then
  perform public.pos_station_current_actor(org,(p_command->>'branchId')::uuid,false);perform public.pos_station_device(org,(p_command->>'branchId')::uuid,(p_command->>'deviceId')::uuid,p_binding,false);
  raise exception 'POS_KITCHEN_STATION_REQUIRED';end if;
 return public.pos_transition_kitchen_before_station_workflow(p_command,p_binding);
end $$;
alter function public.pos_acknowledge_kitchen_return(uuid,uuid,uuid,text) rename to pos_acknowledge_kitchen_return_before_station_workflow;
revoke all on function public.pos_acknowledge_kitchen_return_before_station_workflow(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.pos_acknowledge_kitchen_return(p_branch uuid,p_device uuid,p_notice uuid,p_binding text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare org uuid;begin
 org:=public.pos_station_actor_gate(p_branch);perform public.pos_station_current_actor(org,p_branch,false);perform public.pos_station_device(org,p_branch,p_device,p_binding,false);
 if exists(select 1 from public.pos_kitchen_station_notices n join public.pos_kitchen_station_work w on w.id=n.work_id join public.pos_kitchen_station_roots r on r.id=w.root_id where n.source_key='credit:'||p_notice::text and r.organization_id=org and r.branch_id=p_branch)
 and not exists(select 1 from public.pos_kitchen_return_acknowledgements where notice_id=p_notice) then raise exception 'POS_KITCHEN_STATION_REQUIRED';end if;
 return public.pos_acknowledge_kitchen_return_before_station_workflow(p_branch,p_device,p_notice,p_binding);
end $$;
create or replace function public.pos_guard_kitchen_return_stage() returns trigger language plpgsql security definer set search_path='' as $$
declare target_order uuid;wid uuid;begin
 if tg_table_name='pos_kitchen_tickets' then
  if new.status=old.status or new.status='cancelled' then return new;end if;
  -- Routed parent is only an aggregate. Legacy public mutations are guarded above.
  if exists(select 1 from public.pos_kitchen_station_roots where order_id=new.order_id) then return new;end if;
  target_order:=new.order_id;
 else
  if new.stage=old.stage or new.stage='cancelled' then return new;end if;
  select work_id into wid from public.pos_kitchen_station_batch_ownership where batch_id=new.id;
  if wid is not null then
   if public.pos_station_pending(wid)>0 then raise exception 'POS_STATION_WORK_NOTICE_PENDING';end if;
   return new;
  end if;
  select paid_order_id into target_order from public.pos_tab_kitchen_tickets where id=new.ticket_id;
 end if;
 if exists(select 1 from public.pos_kitchen_return_notices n where n.order_id=target_order and not exists(select 1 from public.pos_kitchen_return_acknowledgements a where a.notice_id=n.id)) then raise exception 'POS_KITCHEN_RETURN_PENDING';end if;
 return new;
end $$;

create function public.pos_station_work_uuid(p jsonb) returns uuid language plpgsql immutable set search_path='' as $$begin return public.pos_station_uuid(p);exception when raise_exception then raise exception 'POS_STATION_WORK_INVALID';end $$;
create function public.pos_station_work_integer(p jsonb,p_min bigint,p_max bigint) returns boolean language sql immutable set search_path='' as $$
 select case when jsonb_typeof(p)='number' then (p#>>'{}')::numeric=trunc((p#>>'{}')::numeric) and (p#>>'{}')::numeric between p_min and p_max else false end
$$;
create function public.pos_station_work_validate(p jsonb) returns void language plpgsql immutable set search_path='' as $$
declare keys text[];begin
 if jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>4096 then raise exception 'POS_STATION_WORK_INVALID';end if;
 keys:=array['id','branchId','deviceId','workId','expectedRevision','type'];
 if p->>'type'='stage' then keys:=keys||array['from','to','reason'];elsif p->>'type'='notice.ack' then keys:=keys||array['noticeId'];else raise exception 'POS_STATION_WORK_INVALID';end if;
 if not p ?& keys or p-keys<>'{}'::jsonb then raise exception 'POS_STATION_WORK_INVALID';end if;
 perform public.pos_station_work_uuid(p->'id');perform public.pos_station_work_uuid(p->'branchId');perform public.pos_station_work_uuid(p->'deviceId');perform public.pos_station_work_uuid(p->'workId');
 if not public.pos_station_work_integer(p->'expectedRevision',1,2147483646) then raise exception 'POS_STATION_WORK_INVALID';end if;
 if p->>'type'='notice.ack' then perform public.pos_station_work_uuid(p->'noticeId');
 else
  if coalesce(p->>'from','') not in ('queued','preparing','ready','served') or coalesce(p->>'to','') not in ('queued','preparing','ready','served') then raise exception 'POS_STATION_WORK_INVALID';end if;
  if p->'reason'<>'null'::jsonb and (jsonb_typeof(p->'reason') is distinct from 'string' or length(p->>'reason') not between 1 and 240 or p->>'reason'<>public.pos_station_trim(p->>'reason') or p->>'reason' ~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) then raise exception 'POS_STATION_WORK_INVALID';end if;
 end if;
end $$;
create function public.pos_list_kitchen_station_work(p_branch uuid,p_device uuid,p_binding text,p_query jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare org uuid;actor_role text;selection text;view_name text;at_time timestamptz;after_id uuid;answer jsonb;begin
 org:=public.pos_station_actor_gate(p_branch);actor_role:=public.pos_station_current_actor(org,p_branch,false);perform public.pos_station_device(org,p_branch,p_device,p_binding,false);
 if jsonb_typeof(p_query) is distinct from 'object' or not p_query ?& array['station','view','cursor'] or p_query-array['station','view','cursor']<>'{}'::jsonb or jsonb_typeof(p_query->'station') is distinct from 'string' or p_query->>'view' not in ('active','history') or jsonb_typeof(p_query->'view') is distinct from 'string' then raise exception 'POS_STATION_WORK_INVALID';end if;
 selection:=p_query->>'station';view_name:=p_query->>'view';if selection not in ('all','general') then perform public.pos_station_work_uuid(p_query->'station');end if;
 if p_query->'cursor'<>'null'::jsonb then
  if jsonb_typeof(p_query->'cursor') is distinct from 'object' or not (p_query->'cursor') ?& array['at','id'] or (p_query->'cursor')-array['at','id']<>'{}'::jsonb or jsonb_typeof(p_query#>'{cursor,at}') is distinct from 'string' or p_query#>>'{cursor,at}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' then raise exception 'POS_STATION_WORK_INVALID';end if;
  at_time:=(p_query#>>'{cursor,at}')::timestamptz;after_id:=public.pos_station_work_uuid(p_query#>'{cursor,id}');if not isfinite(at_time) then raise exception 'POS_STATION_WORK_INVALID';end if;
 end if;
 with snapshots as materialized(select w.*,public.pos_station_work_snapshot(w) snapshot from public.pos_kitchen_station_work w join public.pos_kitchen_station_roots r on r.id=w.root_id where r.organization_id=org and r.branch_id=p_branch),
 scoped as materialized(select *,((snapshot->>'pendingNoticeCount')::integer>0 or snapshot#>'{stages,queued}'<>'[]'::jsonb or snapshot#>'{stages,preparing}'<>'[]'::jsonb or snapshot#>'{stages,ready}'<>'[]'::jsonb) actionable from snapshots),
 matches as materialized(select *,case when view_name='active' then issued_at else updated_at end sort_time from scoped where (selection='all' or station_key=selection) and actionable=(view_name='active')),
 page as materialized(select * from matches where at_time is null or (view_name='active' and (sort_time,id)>(at_time,after_id)) or (view_name='history' and (sort_time,id)<(at_time,after_id))
 order by case when view_name='active' then sort_time end asc,case when view_name='active' then id end asc,case when view_name='history' then sort_time end desc,case when view_name='history' then id end desc limit 101),
 shown as materialized(select * from page order by case when view_name='active' then sort_time end asc,case when view_name='active' then id end asc,case when view_name='history' then sort_time end desc,case when view_name='history' then id end desc limit 100),
 selectors as(select null::uuid station_id,'general'::text station_key,'General'::text name,true active union all select id,id::text,name,active from public.pos_kitchen_stations where organization_id=org and branch_id=p_branch)
 select jsonb_build_object('status','ready','organizationId',org,'branchId',p_branch,'actorRole',actor_role,'generatedAt',public.pos_station_time(clock_timestamp()),
 'items',coalesce((select jsonb_agg(snapshot order by case when view_name='active' then sort_time end asc,case when view_name='active' then id end asc,case when view_name='history' then sort_time end desc,case when view_name='history' then id end desc) from shown),'[]'::jsonb),
 'matchingCount',(select count(*) from matches),'attentionCount',(select count(*) from scoped where (snapshot->>'pendingNoticeCount')::integer>0),
 'nextCursor',case when (select count(*) from page)>100 then (select jsonb_build_object('at',public.pos_station_time(sort_time),'id',id) from shown order by case when view_name='active' then sort_time end desc,case when view_name='active' then id end desc,case when view_name='history' then sort_time end asc,case when view_name='history' then id end asc limit 1) else null end,
 'stations',(select jsonb_agg(jsonb_build_object('stationId',s.station_id,'name',s.name,'active',s.active,'activeCount',(select count(*) from scoped w where w.station_key=s.station_key and w.actionable),'pendingNoticeCount',coalesce((select sum((snapshot->>'pendingNoticeCount')::integer) from scoped w where w.station_key=s.station_key),0)) order by s.station_id nulls first) from selectors s)) into answer;
 if (answer->>'matchingCount')::bigint>2147483647 or (answer->>'attentionCount')::bigint>2147483647 then raise exception 'POS_KITCHEN_LIMIT';end if;return answer;
exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then raise exception 'POS_STATION_WORK_INVALID';end $$;
create function public.pos_get_kitchen_station_work(p_branch uuid,p_device uuid,p_binding text,p_work uuid,p_query jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare org uuid;actor_role text;answer jsonb;begin
 org:=public.pos_station_actor_gate(p_branch);actor_role:=public.pos_station_current_actor(org,p_branch,false);perform public.pos_station_device(org,p_branch,p_device,p_binding,false);
 if jsonb_typeof(p_query) is distinct from 'object' or not p_query ?& array['noticeView','afterSequence'] or p_query-array['noticeView','afterSequence']<>'{}'::jsonb or jsonb_typeof(p_query->'noticeView') is distinct from 'string' or p_query->>'noticeView' not in ('pending','all') or not public.pos_station_work_integer(p_query->'afterSequence',0,2147483647) then raise exception 'POS_STATION_WORK_INVALID';end if;
 with item as materialized(select w.* from public.pos_kitchen_station_work w join public.pos_kitchen_station_roots r on r.id=w.root_id where w.id=p_work and r.organization_id=org and r.branch_id=p_branch),
 notices as materialized(select n.* from public.pos_kitchen_station_notices n join item w on w.id=n.work_id where p_query->>'noticeView'='all' or not exists(select 1 from public.pos_kitchen_station_notice_acknowledgements a where a.notice_id=n.id)),
 page as materialized(select * from notices where sequence>(p_query->>'afterSequence')::integer order by sequence limit 51),shown as materialized(select * from page order by sequence limit 50)
 select jsonb_build_object('status','ready','organizationId',org,'branchId',p_branch,'actorRole',actor_role,'work',public.pos_station_work_snapshot(w),
 'notices',coalesce((select jsonb_agg(public.pos_station_notice_snapshot(n) order by n.sequence) from shown n),'[]'::jsonb),'noticeCount',(select count(*) from notices),'nextAfterSequence',case when (select count(*) from page)>50 then (select max(sequence) from shown) else null end) into answer from item w;
 if answer is null then raise exception 'POS_STATION_WORK_NOT_FOUND';end if;return answer;
end $$;

create function public.pos_execute_kitchen_station_work_command(p_command jsonb,p_binding text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare org uuid;branch uuid;device uuid;request uuid;role_name text;prior public.pos_kitchen_station_work_commands;w public.pos_kitchen_station_work;root public.pos_kitchen_station_roots;
 gen public.pos_kitchen_station_generations;notice public.pos_kitchen_station_notices;ticket public.pos_tab_kitchen_tickets;answer jsonb;ack_id uuid;old_rank integer;new_rank integer;affected integer;aggregate_stage text;stamp timestamptz:=clock_timestamp();through_sequence integer;begin
 perform public.pos_station_work_validate(p_command);branch:=(p_command->>'branchId')::uuid;device:=(p_command->>'deviceId')::uuid;request:=(p_command->>'id')::uuid;
 org:=public.pos_station_actor_gate(branch);perform pg_advisory_xact_lock(hashtextextended(request::text,46));
 role_name:=public.pos_station_current_actor(org,branch,false);perform public.pos_station_device(org,branch,device,p_binding,false);
 select * into prior from public.pos_kitchen_station_work_commands where id=request;
 if found then
  if prior.organization_id<>org or prior.branch_id<>branch or prior.actor_id<>auth.uid() or prior.device_id<>device or prior.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;
  if prior.status='cancelled' then raise exception 'POS_REQUEST_CANCELLED';end if;return prior.result||'{"replayed":true}'::jsonb;
 end if;
 select r.* into root from public.pos_kitchen_station_roots r join public.pos_kitchen_station_work x on x.root_id=r.id where x.id=(p_command->>'workId')::uuid and r.organization_id=org and r.branch_id=branch;
 if not found then raise exception 'POS_STATION_WORK_NOT_FOUND';end if;
 if root.family='paid' then
  perform 1 from public.pos_orders where id=root.order_id for update;
  perform 1 from public.pos_kitchen_tickets where order_id=root.order_id for update;
 else
  -- Never acquire order/tab/config/shift after this ticket: refund owns order first.
  select * into ticket from public.pos_tab_kitchen_tickets where id=root.ticket_id for update;
 end if;
 select * into w from public.pos_kitchen_station_work where id=(p_command->>'workId')::uuid for update;
 if w.revision<>(p_command->>'expectedRevision')::integer then raise exception 'POS_STATION_WORK_CONFLICT';end if;
 if w.revision=2147483647 then raise exception 'POS_KITCHEN_LIMIT';end if;
 select * into gen from public.pos_kitchen_station_generations where root_id=root.id and generation=w.generation;
 if p_command->>'type'='stage' then
  if gen.state='cancelled' then raise exception 'POS_STATION_WORK_CLOSED';end if;
  if public.pos_station_pending(w.id)>0 then raise exception 'POS_STATION_WORK_NOTICE_PENDING';end if;
  old_rank:=array_position(array['queued','preparing','ready','served'],p_command->>'from');new_rank:=array_position(array['queued','preparing','ready','served'],p_command->>'to');
  if new_rank=old_rank-1 then
   if role_name not in ('owner','manager') then raise exception 'POS_MANAGER_REQUIRED';end if;
   if p_command->'reason'='null'::jsonb then raise exception 'POS_KITCHEN_REASON_REQUIRED';end if;
  elsif new_rank<>old_rank+1 then raise exception 'POS_KITCHEN_TRANSITION_INVALID';end if;
  if root.family='paid' then
   if w.paid_stage<>p_command->>'from' then raise exception 'POS_STATION_WORK_NO_CHANGES';end if;
   update public.pos_kitchen_station_work set paid_stage=p_command->>'to' where id=w.id;
   select (array['queued','preparing','ready','served'])[min(array_position(array['queued','preparing','ready','served'],paid_stage))] into aggregate_stage from public.pos_kitchen_station_work where root_id=root.id and paid_stage<>'cancelled';
   update public.pos_kitchen_tickets set status=aggregate_stage,revision=revision+1,updated_at=greatest(updated_at,stamp) where order_id=root.order_id;
  else
   update public.pos_tab_kitchen_batches b set stage=p_command->>'to' from public.pos_kitchen_station_batch_ownership x where x.batch_id=b.id and x.work_id=w.id and b.quantity_milli>0 and b.stage=p_command->>'from';get diagnostics affected=row_count;
   if affected=0 then raise exception 'POS_STATION_WORK_NO_CHANGES';end if;
   update public.pos_tab_kitchen_tickets set revision=revision+1,updated_at=greatest(updated_at,stamp) where id=root.ticket_id;
  end if;
 else
  select * into notice from public.pos_kitchen_station_notices where id=(p_command->>'noticeId')::uuid and work_id=w.id;
  if not found then raise exception 'POS_STATION_WORK_NOT_FOUND';end if;
  if exists(select 1 from public.pos_kitchen_station_notice_acknowledgements where notice_id=notice.id) then raise exception 'POS_STATION_WORK_NO_CHANGES';end if;
  insert into public.pos_kitchen_station_notice_acknowledgements(notice_id,actor_id,device_id,acknowledged_at) values(notice.id,auth.uid(),device,stamp);ack_id:=notice.id;
  if notice.kind in ('return','cancel') and not exists(select 1 from public.pos_kitchen_station_notices n where n.kind in ('return','cancel') and n.source->>'creditNoteId'=notice.source->>'creditNoteId' and not exists(select 1 from public.pos_kitchen_station_notice_acknowledgements a where a.notice_id=n.id)) then
   insert into public.pos_kitchen_return_acknowledgements(notice_id,actor_id,device_id,acknowledged_at)
   select (notice.source->>'creditNoteId')::uuid,auth.uid(),device,stamp where exists(select 1 from public.pos_kitchen_return_notices where id=(notice.source->>'creditNoteId')::uuid) on conflict do nothing;
  end if;
  if root.family='tab' then
   select coalesce(min((n.source->>'eventSequence')::integer)-1,ticket.event_sequence) into through_sequence from public.pos_kitchen_station_notices n join public.pos_kitchen_station_work x on x.id=n.work_id where x.root_id=root.id and n.kind not in ('return','cancel') and not exists(select 1 from public.pos_kitchen_station_notice_acknowledgements a where a.notice_id=n.id);
   update public.pos_tab_kitchen_tickets set acknowledged_sequence=greatest(acknowledged_sequence,through_sequence),revision=revision+1,updated_at=greatest(updated_at,stamp) where id=root.ticket_id;
  end if;
 end if;
 update public.pos_kitchen_station_work set revision=revision+1,updated_at=greatest(updated_at,stamp) where id=w.id returning * into w;
 answer:=jsonb_build_object('status','updated','requestId',request,'branchId',branch,'replayed',false,'work',public.pos_station_work_snapshot(w),'acknowledgedNoticeId',ack_id);
 insert into public.pos_kitchen_station_work_commands(id,organization_id,branch_id,actor_id,device_id,payload,result,status) values(request,org,branch,auth.uid(),device,p_command,answer,'updated');
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details) values(org,branch,auth.uid(),'kitchen.station.'||(p_command->>'type'),w.id,jsonb_build_object('requestId',request,'command',p_command,'revision',w.revision));
 return answer;
exception when numeric_value_out_of_range then raise exception 'POS_KITCHEN_LIMIT';end $$;
create function public.pos_resolve_kitchen_station_work_request(p_command jsonb,p_binding text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare org uuid;branch uuid;device uuid;request uuid;prior public.pos_kitchen_station_work_commands;answer jsonb;begin
 perform public.pos_station_work_validate(p_command);branch:=(p_command->>'branchId')::uuid;device:=(p_command->>'deviceId')::uuid;request:=(p_command->>'id')::uuid;
 org:=public.pos_station_actor_gate(branch);perform pg_advisory_xact_lock(hashtextextended(request::text,46));
 select * into prior from public.pos_kitchen_station_work_commands where id=request;
 if found then
  if prior.organization_id<>org or prior.branch_id<>branch or prior.actor_id<>auth.uid() or prior.device_id<>device or prior.payload<>p_command then raise exception 'POS_IDEMPOTENCY_CONFLICT';end if;
  perform public.pos_station_recovery_device(org,branch,device,p_binding,false);return prior.result||'{"replayed":true}'::jsonb;
 end if;
 perform public.pos_station_current_actor(org,branch,false);perform public.pos_station_recovery_device(org,branch,device,p_binding,true);
 answer:=jsonb_build_object('status','cancelled','requestId',request,'branchId',branch,'workId',p_command->'workId','replayed',false);
 insert into public.pos_kitchen_station_work_commands(id,organization_id,branch_id,actor_id,device_id,payload,result,status) values(request,org,branch,auth.uid(),device,p_command,answer,'cancelled');
 insert into public.pos_audit_events(organization_id,branch_id,actor_id,event_type,entity_id,details) values(org,branch,auth.uid(),'kitchen.station.request_cancelled',request,jsonb_build_object('workId',p_command->'workId','deviceId',device));return answer;
end $$;

-- Exclude routed work BEFORE legacy paging and counting; never filter a page afterward.
create or replace function public.pos_list_kitchen(p_branch uuid,p_binding text,p_cursor jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid; bound jsonb; role_name text; after_time timestamptz; after_order uuid; active_items jsonb; terminal_items jsonb;
 counts jsonb; total bigint; terminal_count bigint; next_cursor jsonb; page_rows integer;
begin
 org:=public.pos_lock_staff_authority(p_branch); bound:=public.pos_bound_device(p_binding);
 if bound is null or bound->>'branchId' is distinct from p_branch::text then raise exception 'POS_DEVICE_INVALID'; end if;
 select s.role into role_name from public.pos_staff s where s.organization_id=org and s.user_id=auth.uid() and s.active;
 if p_cursor is not null then
  if jsonb_typeof(p_cursor) is distinct from 'object' or not p_cursor ?& array['issuedAt','orderId'] or p_cursor-array['issuedAt','orderId']<>'{}'::jsonb
   or jsonb_typeof(p_cursor->'issuedAt') is distinct from 'string' or jsonb_typeof(p_cursor->'orderId') is distinct from 'string'
  then raise exception 'POS_INVALID_KITCHEN_CURSOR'; end if;
  after_time:=(p_cursor->>'issuedAt')::timestamptz; after_order:=(p_cursor->>'orderId')::uuid;
  if not isfinite(after_time) then raise exception 'POS_INVALID_KITCHEN_CURSOR'; end if;
 end if;
 -- One statement snapshot keeps page/count metadata internally consistent while other devices work.
 with active as not materialized(select * from public.pos_kitchen_tickets t where t.organization_id=org and t.branch_id=p_branch and not exists(select 1 from public.pos_kitchen_station_roots r where r.order_id=t.order_id) and t.status in ('queued','preparing','ready')),
 page as materialized(select * from active t where after_time is null or (t.issued_at,t.order_id)>(after_time,after_order) order by t.issued_at,t.order_id limit 101),
 shown as materialized(select * from page order by issued_at,order_id limit 100),
 terminal as materialized(select * from public.pos_kitchen_tickets t where t.organization_id=org and t.branch_id=p_branch and not exists(select 1 from public.pos_kitchen_station_roots r where r.order_id=t.order_id) and t.status in ('served','cancelled') order by updated_at desc,order_id desc limit 51),
 recent as materialized(select * from terminal order by updated_at desc,order_id desc limit 50)
 select (select coalesce(jsonb_agg(public.pos_kitchen_snapshot(s) order by s.issued_at,s.order_id),'[]') from shown s),
 (select coalesce(jsonb_agg(public.pos_kitchen_snapshot(r) order by r.updated_at desc,r.order_id desc),'[]') from recent r),
 (select count(*) from active),(select count(*) from terminal),(select count(*) from page),
 (select jsonb_build_object('queued',count(*) filter(where status='queued'),'preparing',count(*) filter(where status='preparing'),'ready',count(*) filter(where status='ready')) from active),
 (select jsonb_build_object('issuedAt',issued_at,'orderId',order_id) from shown order by issued_at desc,order_id desc limit 1)
 into active_items,terminal_items,total,terminal_count,page_rows,counts,next_cursor;
 if total>2147483647 then raise exception 'POS_KITCHEN_LIMIT'; end if;
 return jsonb_build_object('status','ready','organizationId',org,'branchId',p_branch,'actorRole',role_name,'generatedAt',clock_timestamp(),
 'activeTickets',active_items,'terminalTickets',terminal_items,'activeCount',total,'activeCounts',counts,
 'activeNextCursor',case when page_rows>100 then next_cursor else null end,'terminalTruncated',terminal_count>50);
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then raise exception 'POS_INVALID_KITCHEN_CURSOR';
end $$;
create or replace function public.pos_list_tab_kitchen(p_branch uuid,p_binding text,p_cursor jsonb default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid; role_name text; after_time timestamptz; after_id uuid; result jsonb;
begin
 org:=public.pos_tab_scope(p_branch,p_binding);select role into role_name from public.pos_staff where organization_id=org and user_id=auth.uid();
 if p_cursor is not null then
 if jsonb_typeof(p_cursor) is distinct from 'object' or not p_cursor ?& array['issuedAt','id'] or p_cursor-array['issuedAt','id']<>'{}'::jsonb or jsonb_typeof(p_cursor->'issuedAt') is distinct from 'string' or jsonb_typeof(p_cursor->'id') is distinct from 'string' then raise exception 'POS_INVALID_TAB_KITCHEN_CURSOR';end if;
 after_time:=(p_cursor->>'issuedAt')::timestamptz;after_id:=(p_cursor->>'id')::uuid;if not isfinite(after_time) then raise exception 'POS_INVALID_TAB_KITCHEN_CURSOR';end if;
 end if;
 with scoped as materialized(select t.id,t.issued_at,t.updated_at,t.event_sequence,t.acknowledged_sequence,t.event_sequence>t.acknowledged_sequence or exists(select 1 from public.pos_tab_kitchen_batches b where b.ticket_id=t.id and b.stage in ('queued','preparing','ready') and b.quantity_milli>0) actionable from public.pos_tab_kitchen_tickets t where t.organization_id=org and t.branch_id=p_branch and not exists(select 1 from public.pos_kitchen_station_roots r where r.ticket_id=t.id)),
 active as not materialized(select * from scoped where actionable),page as materialized(select * from active where after_time is null or (issued_at,id)>(after_time,after_id) order by issued_at,id limit 101),shown as materialized(select * from page order by issued_at,id limit 100),
 closed as materialized(select * from scoped where not actionable order by updated_at desc,id desc limit 51),recent as materialized(select * from closed order by updated_at desc,id desc limit 50)
 select jsonb_build_object('status','ready','organizationId',org,'branchId',p_branch,'actorRole',role_name,'generatedAt',clock_timestamp(),
 'activeTickets',(select coalesce(jsonb_agg(public.pos_tab_kitchen_snapshot(t) order by t.issued_at,t.id),'[]') from public.pos_tab_kitchen_tickets t join shown s on s.id=t.id),
 'terminalTickets',(select coalesce(jsonb_agg(public.pos_tab_kitchen_snapshot(t) order by t.updated_at desc,t.id desc),'[]') from public.pos_tab_kitchen_tickets t join recent r on r.id=t.id),
 'activeCount',(select count(*) from active),'pendingCount',(select count(*) from active where event_sequence>acknowledged_sequence),
 'activeNextCursor',case when (select count(*) from page)>100 then(select jsonb_build_object('issuedAt',issued_at,'id',id) from shown order by issued_at desc,id desc limit 1) else null end,'terminalTruncated',(select count(*)>50 from closed)) into result;
 if (result->>'activeCount')::bigint>2147483647 then raise exception 'POS_KITCHEN_LIMIT';end if;
 return result;
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then raise exception 'POS_INVALID_TAB_KITCHEN_CURSOR';end $$;
create or replace function public.pos_list_kitchen_returns(p_branch uuid,p_binding text,p_cursor jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid; bound jsonb; after_time timestamptz; after_id uuid; result jsonb; total bigint;
begin
 org:=public.pos_lock_staff_authority(p_branch);bound:=public.pos_bound_device(p_binding);
 if bound is null or bound->>'branchId' is distinct from p_branch::text then raise exception 'POS_DEVICE_INVALID';end if;
 if p_cursor is not null then
  if jsonb_typeof(p_cursor) is distinct from 'object' or not p_cursor ?& array['issuedAt','id'] or p_cursor-array['issuedAt','id']<>'{}'::jsonb or jsonb_typeof(p_cursor->'issuedAt') is distinct from 'string' or jsonb_typeof(p_cursor->'id') is distinct from 'string' then raise exception 'POS_INVALID_KITCHEN_CURSOR';end if;
  after_time:=(p_cursor->>'issuedAt')::timestamptz;after_id:=(p_cursor->>'id')::uuid;
  if not isfinite(after_time) then raise exception 'POS_INVALID_KITCHEN_CURSOR';end if;
 end if;
 with pending as materialized(select n.* from public.pos_kitchen_return_notices n where n.organization_id=org and n.branch_id=p_branch and not exists(select 1 from public.pos_kitchen_station_notices sn where sn.source_key='credit:'||n.id::text) and not exists(select 1 from public.pos_kitchen_return_acknowledgements a where a.notice_id=n.id)),
 page as materialized(select * from pending n where after_time is null or (n.issued_at,n.id)>(after_time,after_id) order by n.issued_at,n.id limit 51),
 shown as materialized(select * from page order by issued_at,id limit 50)
 select (select count(*) from pending),jsonb_build_object('status','ready','branchId',p_branch,'pendingCount',(select count(*) from pending),
 'notices',(select coalesce(jsonb_agg(snapshot order by issued_at,id),'[]'::jsonb) from shown),
 'nextCursor',case when (select count(*) from page)>50 then (select jsonb_build_object('issuedAt',issued_at,'id',id) from shown order by issued_at desc,id desc limit 1) else null end)
 into total,result;
 if total>50000 then raise exception 'POS_KITCHEN_LIMIT';end if;return result;
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then raise exception 'POS_INVALID_KITCHEN_CURSOR';
end $$;

-- Explicit private ACLs including service_role; all triggers execute under their owner.
do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (
 'pos_station_time','pos_station_work_guard','pos_station_work_for','pos_station_pending','pos_station_stages','pos_station_work_snapshot','pos_station_notice_snapshot','pos_station_notice','pos_station_ticket_project','pos_station_batch_project','pos_station_filter_lines','pos_station_event_project','pos_station_credit_project','pos_station_return_project','pos_station_document_project','pos_station_work_uuid','pos_station_work_integer','pos_station_work_validate',
 'pos_list_kitchen_station_work','pos_get_kitchen_station_work','pos_execute_kitchen_station_work_command','pos_resolve_kitchen_station_work_request',
 'pos_execute_tab_kitchen_command','pos_transition_kitchen','pos_acknowledge_kitchen_return','pos_guard_kitchen_return_stage') loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
grant execute on function public.pos_list_kitchen_station_work(uuid,uuid,text,jsonb),public.pos_get_kitchen_station_work(uuid,uuid,text,uuid,jsonb),public.pos_execute_kitchen_station_work_command(jsonb,text),public.pos_resolve_kitchen_station_work_request(jsonb,text),public.pos_execute_tab_kitchen_command(jsonb,text),public.pos_transition_kitchen(jsonb,text),public.pos_acknowledge_kitchen_return(uuid,uuid,uuid,text) to authenticated;
