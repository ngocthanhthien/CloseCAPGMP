-- Run once in the SQL Editor of a NEW Supabase project.
begin;

create table public.gmp_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role text not null check (role in ('admin','user'))
);
alter table public.gmp_members enable row level security;
revoke all on public.gmp_members from anon, authenticated;
grant select on public.gmp_members to authenticated;
create policy own_membership on public.gmp_members for select to authenticated
  using (user_id = (select auth.uid()));

create table public.gmp_records (
  kind text not null check (kind in ('finding','settings')),
  id text not null check (id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  record_key text generated always as (kind || ':' || id) stored unique,
  data jsonb not null,
  revision bigint not null default 1,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (kind,id)
);
alter table public.gmp_records enable row level security;
revoke all on public.gmp_records from anon, authenticated;
grant select on public.gmp_records to authenticated;
create policy members_read on public.gmp_records for select to authenticated
  using (exists(select 1 from public.gmp_members where user_id=(select auth.uid())));

create table public.gmp_audit (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  actor_id uuid not null,
  actor_name text not null,
  device text not null,
  action text not null,
  detail text not null,
  area text not null
);
alter table public.gmp_audit enable row level security;
revoke all on public.gmp_audit from anon, authenticated;
grant select on public.gmp_audit to authenticated;
create policy members_read_audit on public.gmp_audit for select to authenticated
  using (exists(select 1 from public.gmp_members where user_id=(select auth.uid())));

-- No direct writes. This function authenticates every caller, validates role and
-- expected revision, then writes the finding + audit entry in one transaction.
create or replace function public.gmp_save_record(
  p_kind text, p_id text, p_data jsonb, p_deleted boolean,
  p_revision bigint, p_device text
) returns public.gmp_records
language plpgsql security definer set search_path = '' as $$
declare
  actor public.gmp_members;
  previous public.gmp_records;
  result public.gmp_records;
  old_actions jsonb;
  item jsonb;
  old_item jsonb;
  img text;
  is_admin boolean;
begin
  select * into actor from public.gmp_members where user_id=auth.uid();
  if not found then raise exception 'GMP_FORBIDDEN: approved membership required' using errcode='42501'; end if;
  is_admin := actor.role='admin';
  if p_kind is null or p_kind not in ('finding','settings') or p_id is null or p_id !~ '^[a-zA-Z0-9_-]{1,100}$'
    or p_revision is null or p_revision<0 or p_deleted is null or p_data is null then
    raise exception 'GMP_INVALID: invalid record';
  end if;
  -- Per-record transaction lock also serializes simultaneous first inserts.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_kind||':'||p_id,0));
  select * into previous from public.gmp_records where kind=p_kind and id=p_id for update;
  if coalesce(previous.revision,0) <> p_revision then
    raise exception 'GMP_CONFLICT: record changed on another device' using errcode='40001';
  end if;
  if (p_deleted or p_kind='settings' or coalesce(previous.deleted,false)) and not is_admin then
    raise exception 'GMP_FORBIDDEN: administrator required' using errcode='42501';
  end if;
  if p_kind='settings' then
    if p_id<>'main' or p_deleted or jsonb_typeof(p_data)<>'object'
      or jsonb_typeof(p_data->'target') is distinct from 'number'
      or (p_data->>'target')::numeric not between 0 and 100
      or jsonb_typeof(p_data->'company') is distinct from 'string' then
      raise exception 'GMP_INVALID: settings';
    end if;
  elsif not p_deleted then
    if jsonb_typeof(p_data) is distinct from 'object' or p_data->>'id' is distinct from p_id
      or coalesce(length(btrim(p_data->>'issue')),0)=0
      or coalesce(length(btrim(p_data->>'area')),0)=0
      or coalesce(p_data->>'date','') !~ '^\d{4}-\d{2}-\d{2}$'
      or jsonb_typeof(p_data->'actions') is distinct from 'array' then
      raise exception 'GMP_INVALID: finding';
    end if;
    if jsonb_typeof(p_data->'issue') is distinct from 'string'
      or jsonb_typeof(p_data->'area') is distinct from 'string'
      or jsonb_typeof(p_data->'date') is distinct from 'string'
      or exists(select 1 from jsonb_each(p_data) e where e.key in ('loc','owner','reason') and jsonb_typeof(e.value) not in ('string','null')) then
      raise exception 'GMP_INVALID: finding text fields';
    end if;
    old_actions:=coalesce(previous.data->'actions','[]'::jsonb);
    -- Keep historical multi-action findings. Never add more to an existing one.
    -- Admin imports may contain historical multi-action findings on first insert.
    if (previous.id is not null and jsonb_array_length(p_data->'actions') > greatest(1,jsonb_array_length(old_actions)))
      or (previous.id is null and not is_admin and jsonb_array_length(p_data->'actions')>1) then
      raise exception 'GMP_INVALID: at most one new action';
    end if;
    if not is_admin and previous.id is not null
      and (p_data - array['actions','updatedAt']) is distinct from (previous.data - array['actions','updatedAt']) then
      raise exception 'GMP_FORBIDDEN: only admin edits finding fields' using errcode='42501';
    end if;
    if (select count(*) from jsonb_array_elements(p_data->'actions')) <>
       (select count(distinct x->>'id') from jsonb_array_elements(p_data->'actions') x) then
      raise exception 'GMP_INVALID: duplicate action id';
    end if;
    if not is_admin then
      -- Users cannot remove or alter actions that QA is reviewing or has closed.
      for old_item in select value from jsonb_array_elements(old_actions) loop
        if old_item->>'status' in ('Pending','Closed') and not exists(
          select 1 from jsonb_array_elements(p_data->'actions') x where x=old_item
        ) then raise exception 'GMP_FORBIDDEN: reviewed action is locked' using errcode='42501'; end if;
      end loop;
    end if;
    for item in select value from jsonb_array_elements(p_data->'actions') loop
      if jsonb_typeof(item) is distinct from 'object' or coalesce(item->>'id','') !~ '^[a-zA-Z0-9_-]{1,100}$'
        or coalesce(item->>'status','') not in ('Open','Pending','Closed') then
        raise exception 'GMP_INVALID: action';
      end if;
      if exists(select 1 from jsonb_each(item) e where e.key in ('action','pic','due','confirmedBy','rejectReason') and jsonb_typeof(e.value) not in ('string','null')) then
        raise exception 'GMP_INVALID: action text fields';
      end if;
      select value into old_item from jsonb_array_elements(old_actions) where value->>'id'=item->>'id';
      if not is_admin then
        if old_item is null then
          if item->>'status'='Closed' or coalesce(item->>'confirmedBy','')<>''
            or coalesce(item->>'confirmEvidence','')<>'' or coalesce(item->>'confirmedAt','')<>''
            or coalesce(item->>'rejectReason','')<>'' then
            raise exception 'GMP_FORBIDDEN: confirmation requires admin' using errcode='42501';
          end if;
        elsif (item-array['action','pic','due','evidence','status']) is distinct from
              (old_item-array['action','pic','due','evidence','status'])
              or (item->>'status'='Closed' and old_item->>'status'<>'Closed') then
          raise exception 'GMP_FORBIDDEN: confirmation requires admin' using errcode='42501';
        end if;
        if item->>'status'='Pending' and coalesce(item->>'evidence','')='' then
          raise exception 'GMP_INVALID: evidence required';
        end if;
      end if;
    end loop;
    -- Existing UI/report templates insert image URLs into HTML. Accept only inert
    -- embedded raster images, not remote URLs, SVGs, or attribute injection.
    for img in
      select p_data->>'findingImg'
      union all select value->>'evidence' from jsonb_array_elements(p_data->'actions')
      union all select value->>'confirmEvidence' from jsonb_array_elements(p_data->'actions')
    loop
      if coalesce(img,'')<>'' and img !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=[:space:]]+$' then
        raise exception 'GMP_INVALID: embedded raster image required';
      end if;
    end loop;
    if octet_length(p_data::text)>20000000 then raise exception 'GMP_INVALID: finding exceeds 20 MB'; end if;
  end if;
  insert into public.gmp_records(kind,id,data,revision,deleted,updated_at)
    values(p_kind,p_id,case when p_deleted then coalesce(previous.data,'{}'::jsonb) else p_data end,p_revision+1,p_deleted,now())
    on conflict(kind,id) do update set data=excluded.data,revision=excluded.revision,deleted=excluded.deleted,updated_at=excluded.updated_at
    returning * into result;
  insert into public.gmp_audit(actor_id,actor_name,device,action,detail,area)
    values(actor.user_id,actor.display_name,left(coalesce(p_device,''),100),
      case when p_deleted then 'Xoá Finding' when previous.id is null then 'Tạo '||p_kind else 'Cập nhật '||p_kind end,
      p_id||' · '||left(coalesce(result.data->>'issue','Cài đặt'),200),coalesce(result.data->>'area',''));
  return result;
end;
$$;
revoke all on function public.gmp_save_record(text,text,jsonb,boolean,bigint,text) from public,anon;
grant execute on function public.gmp_save_record(text,text,jsonb,boolean,bigint,text) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('gmp-mediasave','gmp-mediasave',false,20971520,array['image/jpeg','image/png','image/webp','image/heic','image/heif']);
create policy gmp_media_read on storage.objects for select to authenticated
  using(bucket_id='gmp-mediasave' and exists(select 1 from public.gmp_members where user_id=(select auth.uid())));
create policy gmp_media_insert on storage.objects for insert to authenticated
  with check(bucket_id='gmp-mediasave' and (storage.foldername(name))[1]=(select auth.uid())::text
    and exists(select 1 from public.gmp_members where user_id=(select auth.uid())));
-- No public access, overwrites, or deletion through the browser.
commit;
