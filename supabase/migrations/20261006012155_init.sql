-- flag.ar: tables, RLS, functions, buckets.
-- Visitors never touch a table. They read manifest.json and logo files through flag.ar/files/*.

-- ---------- Types and tables ----------

create type public.logo_status as enum ('pending', 'approved', 'denied', 'removed');

create table public.logo_requests (
  id uuid primary key default gen_random_uuid(),
  website_url text not null check (length(website_url) <= 2048),
  domain text not null check (length(domain) <= 253),
  status public.logo_status not null default 'pending',
  file_hash text check (file_hash ~ '^[0-9a-f]{64}$'),
  -- Object name in logos-pending. Set to null once the file is deleted.
  file_path text,
  ip_hash text not null,
  deny_reason text check (length(deny_reason) <= 500),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users (id),
  removed_at timestamptz,
  removed_by uuid references auth.users (id)
);

create unique index one_live_request_per_domain
  on public.logo_requests (domain)
  where status in ('pending', 'approved');
create index logo_requests_status_created_idx on public.logo_requests (status, created_at);

create table public.logos (
  id uuid primary key references public.logo_requests (id),
  domain text not null,
  website_url text not null,
  image_path text not null,
  approved_at timestamptz not null default now()
);
create index logos_approved_at_idx on public.logos (approved_at);

create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create table public.settings (
  key text primary key,
  value jsonb not null
);
insert into public.settings (key, value) values
  ('uploads_enabled', 'true'),
  ('queue_cap', '200'),
  ('site_hourly_cap', '60');

create table public.blocklist (
  kind text not null check (kind in ('domain', 'file_hash')),
  value text not null,
  created_at timestamptz not null default now(),
  primary key (kind, value)
);

-- ---------- Grants ----------
-- anon: nothing. authenticated: read only, and RLS limits reads to the admin with aal2.
-- Writes go through security definer functions or the server's service role key.

-- Explicit grants: a project can have "expose new tables" turned off, so do not rely on defaults.
grant usage on schema public to authenticated, service_role;
grant select on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from authenticated;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke insert, update, delete, truncate on tables from authenticated;
alter default privileges in schema public revoke execute on functions from public, anon;

-- ---------- Helper ----------

create function public.is_admin() returns boolean
language sql security definer set search_path = '' stable as $$
  select exists (
    select 1 from public.admins where user_id = (select auth.uid())
  );
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create function public.is_admin_aal2() returns boolean
language sql security definer set search_path = '' stable as $$
  select public.is_admin() and coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2';
$$;
revoke execute on function public.is_admin_aal2() from public, anon;
grant execute on function public.is_admin_aal2() to authenticated;

-- ---------- Row Level Security ----------

alter table public.logo_requests enable row level security;
alter table public.logos enable row level security;
alter table public.admins enable row level security;
alter table public.settings enable row level security;
alter table public.blocklist enable row level security;

-- Admin read (permissive) + MFA (restrictive). Both must pass.
create policy admin_read on public.logo_requests
  for select to authenticated using ((select public.is_admin()));
create policy admin_mfa on public.logo_requests
  as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

create policy admin_read on public.logos
  for select to authenticated using ((select public.is_admin()));
create policy admin_mfa on public.logos
  as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

create policy admin_read on public.settings
  for select to authenticated using ((select public.is_admin()));
create policy admin_mfa on public.settings
  as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

create policy admin_read on public.blocklist
  for select to authenticated using ((select public.is_admin()));
create policy admin_mfa on public.blocklist
  as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

create policy self_read on public.admins
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------- Admin RPCs (admin JWT with aal2) ----------

create function public.deny_request(
  p_id uuid,
  p_reason text,
  p_block_domain boolean default false,
  p_block_hash boolean default false
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_domain text;
  v_hash text;
begin
  if not public.is_admin_aal2() then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  update public.logo_requests
     set status = 'denied',
         deny_reason = nullif(left(trim(p_reason), 500), ''),
         reviewed_at = now(),
         reviewed_by = (select auth.uid())
   where id = p_id and status = 'pending'
  returning domain, file_hash into v_domain, v_hash;

  if not found then
    raise exception 'request is not pending' using errcode = 'P0002';
  end if;

  if p_block_domain then
    insert into public.blocklist (kind, value) values ('domain', v_domain)
    on conflict do nothing;
  end if;
  if p_block_hash and v_hash is not null then
    insert into public.blocklist (kind, value) values ('file_hash', v_hash)
    on conflict do nothing;
  end if;
end $$;
revoke execute on function public.deny_request(uuid, text, boolean, boolean) from public, anon;
grant execute on function public.deny_request(uuid, text, boolean, boolean) to authenticated;

create function public.set_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin_aal2() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_key = 'uploads_enabled' and jsonb_typeof(p_value) <> 'boolean' then
    raise exception 'uploads_enabled must be a boolean';
  elsif p_key in ('queue_cap', 'site_hourly_cap')
        and (jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric < 0) then
    raise exception '% must be a number >= 0', p_key;
  elsif p_key not in ('uploads_enabled', 'queue_cap', 'site_hourly_cap') then
    raise exception 'unknown setting %', p_key;
  end if;
  update public.settings set value = p_value where key = p_key;
end $$;
revoke execute on function public.set_setting(text, jsonb) from public, anon;
grant execute on function public.set_setting(text, jsonb) to authenticated;

-- ---------- Server-only transactions (service role) ----------
-- The approve and remove routes check the admin session, then call these with the service key.

create function public.approve_request_tx(p_id uuid, p_image_path text, p_admin uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  r public.logo_requests;
begin
  update public.logo_requests
     set status = 'approved', reviewed_at = now(), reviewed_by = p_admin, deny_reason = null
   where id = p_id and status = 'pending'
  returning * into r;
  if not found then
    return false;
  end if;
  insert into public.logos (id, domain, website_url, image_path)
  values (r.id, r.domain, r.website_url, p_image_path);
  return true;
end $$;
revoke execute on function public.approve_request_tx(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.approve_request_tx(uuid, text, uuid) to service_role;

create function public.remove_logo_tx(p_id uuid, p_admin uuid)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_path text;
begin
  delete from public.logos where id = p_id returning image_path into v_path;
  if not found then
    return null;
  end if;
  update public.logo_requests
     set status = 'removed', removed_at = now(), removed_by = p_admin
   where id = p_id;
  return v_path;
end $$;
revoke execute on function public.remove_logo_tx(uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_logo_tx(uuid, uuid) to service_role;

-- ---------- Storage ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('logos-pending', 'logos-pending', false, 524288, array['image/png', 'image/jpeg', 'image/webp']),
  ('logos-public', 'logos-public', true, 524288, array['image/png', 'application/json'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Admin previews of pending files (signed links). No write policies: only the service role writes.
create policy admin_read_pending on storage.objects
  for select to authenticated
  using (
    bucket_id = 'logos-pending'
    and (select public.is_admin())
    and (select auth.jwt() ->> 'aal') = 'aal2'
  );
