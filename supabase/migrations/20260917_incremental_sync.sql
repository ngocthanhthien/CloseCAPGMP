-- Migration: index to support incremental sync (client fetches only records changed
-- since its last successful sync, instead of re-reading the whole table every poll).
-- Safe to execute on existing Supabase projects.
begin;

create index if not exists gmp_records_updated_at_idx on public.gmp_records(updated_at);

commit;
