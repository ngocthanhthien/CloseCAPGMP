-- Migration: Username login for User-role accounts (Admin keeps real email).
-- Safe to execute on existing Supabase projects.
--
-- Supabase Auth only signs in by email/phone, so a "username" account is stored with a
-- synthetic, never-mailed address (<username>@<project-ref>.users.internal) as its
-- auth.users.email. The human never sees or types that address — only the username. This
-- column is purely a display/lookup label; the real identity and password are still a
-- normal Supabase Auth account, so per-person accountability in gmp_audit is unchanged.
begin;

alter table public.gmp_members add column if not exists username text;

-- Case-insensitive uniqueness; NULLs (Admin accounts that keep using a real email) are
-- unrestricted since a partial index only covers non-null values.
create unique index if not exists gmp_members_username_idx
  on public.gmp_members (lower(username)) where username is not null;

commit;
