-- Fixes from the Supabase advisors.

-- auth.jwt() inside a sub-select runs once per query, not once per row.
alter policy admin_mfa on public.logo_requests using (((select auth.jwt()) ->> 'aal') = 'aal2');
alter policy admin_mfa on public.logos using (((select auth.jwt()) ->> 'aal') = 'aal2');
alter policy admin_mfa on public.settings using (((select auth.jwt()) ->> 'aal') = 'aal2');
alter policy admin_mfa on public.blocklist using (((select auth.jwt()) ->> 'aal') = 'aal2');

-- Covering indexes for the foreign keys to auth.users.
create index if not exists logo_requests_reviewed_by_idx on public.logo_requests (reviewed_by);
create index if not exists logo_requests_removed_by_idx on public.logo_requests (removed_by);

-- The project's auto-RLS event trigger function is not an API endpoint.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'rls_auto_enable') then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
