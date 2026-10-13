-- Change requests for a flag. Founders cannot edit a flag themselves: they send the change they want
-- (name, category, color, and optionally a new logo), and an admin applies it or discards it.
-- A request holds the full proposed state, so applying it is one copy; the startup row stays untouched
-- until then.

create table public.edit_requests (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid not null references public.startups (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  category text check (char_length(category) <= 40),
  bg_color text not null check (bg_color ~ '^#[0-9a-f]{6}$'),
  -- Object name in logos-public for the proposed logo, under r/. Null when the logo stays the same.
  logo_path text,
  file_hash text check (file_hash ~ '^[0-9a-f]{64}$'),
  note text check (char_length(note) <= 500),
  ip_hash text not null,
  created_at timestamptz not null default now()
);

create index edit_requests_startup_idx on public.edit_requests (startup_id);
create index edit_requests_created_idx on public.edit_requests (created_at);

comment on column public.startups.edit_version is
  'Bumped each time an admin applies a change request; names the versioned logo file.';

-- Same model as startups: the admin reads with aal2, every write goes through the server (service role).
grant select on public.edit_requests to authenticated;
grant all on public.edit_requests to service_role;
revoke all on public.edit_requests from anon;
revoke insert, update, delete, truncate on public.edit_requests from authenticated;

alter table public.edit_requests enable row level security;

create policy admin_read on public.edit_requests
  for select to authenticated using ((select public.is_admin()));
create policy admin_mfa on public.edit_requests
  as restrictive for all to authenticated
  using (((select auth.jwt()) ->> 'aal') = 'aal2');
