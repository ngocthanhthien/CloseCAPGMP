-- Migration: Admin User Management & Account Status Support
-- Safe to execute on existing Supabase projects.
begin;

-- 1. Bổ sung cột disabled vào bảng gmp_members nếu chưa có
alter table public.gmp_members add column if not exists disabled boolean not null default false;

-- 2. Cập nhật chính sách RLS cho gmp_records (chặn người dùng bị vô hiệu hóa)
drop policy if exists members_read on public.gmp_records;
create policy members_read on public.gmp_records for select to authenticated
  using (exists(select 1 from public.gmp_members where user_id=(select auth.uid()) and not coalesce(disabled, false)));

-- 3. Cập nhật chính sách RLS cho gmp_audit (chặn người dùng bị vô hiệu hóa)
drop policy if exists members_read_audit on public.gmp_audit;
create policy members_read_audit on public.gmp_audit for select to authenticated
  using (exists(select 1 from public.gmp_members where user_id=(select auth.uid()) and not coalesce(disabled, false)));

-- 4. Cập nhật Storage policies cho gmp-mediasave
drop policy if exists gmp_media_read on storage.objects;
create policy gmp_media_read on storage.objects for select to authenticated
  using(bucket_id='gmp-mediasave' and exists(select 1 from public.gmp_members where user_id=(select auth.uid()) and not coalesce(disabled, false)));

drop policy if exists gmp_media_insert on storage.objects;
create policy gmp_media_insert on storage.objects for insert to authenticated
  with check(bucket_id='gmp-mediasave' and (storage.foldername(name))[1]=(select auth.uid())::text
    and exists(select 1 from public.gmp_members where user_id=(select auth.uid()) and not coalesce(disabled, false)));

-- 5. Cập nhật hàm RPC gmp_save_record để kiểm tra trạng thái disabled
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
  if not found or coalesce(actor.disabled, false) then
    raise exception 'GMP_FORBIDDEN: approved membership required' using errcode='42501';
  end if;
  is_admin := actor.role='admin';
  if p_kind is null or p_kind not in ('finding','settings') or p_id is null or p_id !~ '^[a-zA-Z0-9_-]{1,100}$'
    or p_revision is null or p_revision<0 or p_deleted is null or p_data is null then
    raise exception 'GMP_INVALID: invalid record';
  end if;
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

commit;
