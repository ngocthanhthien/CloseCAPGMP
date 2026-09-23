-- Migration: Data & Egress Control — cross-device daily traffic accounting.
-- Soft/Hard/Extra/Unlock limits themselves live in SETTINGS (synced via the existing
-- gmp_save_record RPC, which already requires Admin for any p_kind='settings' write — no
-- new privileged RPC needed for that part). This migration only adds the lightweight,
-- shared "how many bytes did the app move today" counter each device reports into.
-- Safe to execute on existing Supabase projects.
begin;

create table if not exists public.gmp_traffic_daily (
  date text not null,           -- 'YYYY-MM-DD', local calendar day
  device text not null,
  bytes bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (date, device)
);
create index if not exists gmp_traffic_daily_date_idx on public.gmp_traffic_daily(date);

alter table public.gmp_traffic_daily enable row level security;
revoke all on public.gmp_traffic_daily from anon, authenticated;
grant select on public.gmp_traffic_daily to authenticated;
drop policy if exists members_read on public.gmp_traffic_daily;
create policy members_read on public.gmp_traffic_daily for select to authenticated
  using (exists(select 1 from public.gmp_members where user_id=(select auth.uid()) and not coalesce(disabled,false)));

-- No direct write policy — same "write only through RPC" pattern as gmp_records. Any
-- approved member (not just Admin) may report their own device's usage: this is a
-- self-reported estimate, not a sensitive action, unlike editing the Soft/Hard limits
-- themselves (those go through gmp_save_record, which already requires Admin).
create or replace function public.gmp_report_traffic(p_date text, p_device text, p_bytes bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.gmp_members where user_id=auth.uid() and not coalesce(disabled,false)) then
    raise exception 'GMP_FORBIDDEN: approved membership required' using errcode='42501';
  end if;
  if p_date is null or p_date !~ '^\d{4}-\d{2}-\d{2}$'
    or p_device is null or length(p_device)=0
    or p_bytes is null or p_bytes<0 then
    raise exception 'GMP_INVALID: bad traffic report';
  end if;
  -- greatest(): the client reports its own cumulative total for the day, not a delta, so a
  -- retried or out-of-order call can never move the counter backwards.
  insert into public.gmp_traffic_daily(date,device,bytes,updated_at)
    values(p_date, left(p_device,100), p_bytes, now())
  on conflict(date,device) do update
    set bytes = greatest(public.gmp_traffic_daily.bytes, excluded.bytes), updated_at = now();
end; $$;
revoke all on function public.gmp_report_traffic(text,text,bigint) from public,anon;
grant execute on function public.gmp_report_traffic(text,text,bigint) to authenticated;

-- Same retention pattern as 20260916_audit_retention.sql (pg_cron already enabled by that
-- migration — no need to re-enable the extension here).
select cron.schedule(
  'gmp_purge_old_traffic',
  '30 3 * * *',
  $$delete from public.gmp_traffic_daily where date < to_char(now() - interval '14 days','YYYY-MM-DD')$$
);

commit;
