-- Migration: Auto-purge Data Input Log (gmp_audit) older than 1 week.
-- Safe to execute on existing Supabase projects. Requires pg_cron (bundled with Supabase Postgres).
begin;

-- Speeds up both the "100 most recent" read in cloud.js and the daily purge below.
create index if not exists gmp_audit_ts_idx on public.gmp_audit(ts desc);

create extension if not exists pg_cron with schema extensions;

-- Runs as the job owner (postgres), which bypasses RLS — gmp_audit intentionally has no
-- client-facing delete policy so the audit trail can't be altered from the browser.
select cron.schedule(
  'gmp_purge_old_audit',
  '0 3 * * *', -- daily 03:00 UTC (~10:00 sáng giờ Việt Nam)
  $$delete from public.gmp_audit where ts < now() - interval '7 days'$$
);

commit;
