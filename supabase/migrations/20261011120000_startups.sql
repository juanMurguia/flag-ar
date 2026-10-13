-- flag.ar v2: one flag per startup, on its own pole beside the Argentine flag.
-- The Argentine flag carries nothing. Each startup has its own page (flag.ar/<slug>) and a place
-- in the Hall of Fame (/salon) once approved.
--
-- Visitors never touch a table. Pages read through the server (service role) and Vercel's cache.
-- The old logo_requests / logos tables stay for history. Their approved rows move to startups below.

create type public.startup_status as enum ('pending', 'approved', 'rejected');

create table public.startups (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'),
  name text not null check (char_length(name) between 1 and 60),
  city text check (char_length(city) <= 60),
  link text not null check (length(link) <= 2048),
  -- Identity key for "one flag per domain": a bare domain ("pampa.com.ar") or "x.com/<handle>".
  domain text not null check (length(domain) <= 300),
  -- Object name in logos-public. Null after the logo is taken down.
  logo_path text,
  bg_color text not null check (bg_color ~ '^#[0-9a-f]{6}$'),
  -- Shown to the founder at once ("Your flag is #N"). Rejected rows leave gaps; numbers never repeat.
  order_number bigint generated always as identity unique,
  status public.startup_status not null default 'pending',
  featured boolean not null default false,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  updated_at timestamptz,
  -- Bumped each time an admin applies a change request; names the versioned logo file.
  edit_version integer not null default 0,
  ip_hash text not null,
  file_hash text check (file_hash ~ '^[0-9a-f]{64}$'),
  rights_confirmed_at timestamptz not null,
  -- Highest unsafe class score from the automatic check. Null until the check runs.
  nsfw_score real,
  report_count integer not null default 0,
  reject_reason text check (char_length(reject_reason) <= 500),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users (id)
);

create unique index one_startup_per_domain on public.startups (domain) where status <> 'rejected';
create index startups_status_approved_idx on public.startups (status, approved_at desc);
create index startups_status_created_idx on public.startups (status, created_at);
create index startups_reviewed_by_idx on public.startups (reviewed_by);

create table public.startup_reports (
  startup_id uuid not null references public.startups (id) on delete cascade,
  ip_hash text not null,
  reason text check (char_length(reason) <= 300),
  created_at timestamptz not null default now(),
  primary key (startup_id, ip_hash)
);

-- ---------- Grants and RLS (same model as init: admin reads with aal2, writes go through the server) ----------

grant select on public.startups, public.startup_reports to authenticated;
grant all on public.startups, public.startup_reports to service_role;
revoke all on public.startups, public.startup_reports from anon;
revoke insert, update, delete, truncate on public.startups, public.startup_reports from authenticated;

alter table public.startups enable row level security;
alter table public.startup_reports enable row level security;

create policy admin_read on public.startups
  for select to authenticated using ((select public.is_admin()));
create policy admin_mfa on public.startups
  as restrictive for all to authenticated
  using (((select auth.jwt()) ->> 'aal') = 'aal2');

create policy admin_read on public.startup_reports
  for select to authenticated using ((select public.is_admin()));
create policy admin_mfa on public.startup_reports
  as restrictive for all to authenticated
  using (((select auth.jwt()) ->> 'aal') = 'aal2');

-- ---------- Server-only functions (service role) ----------

-- One report per IP per startup. Returns the new count. At 3 distinct reports an approved flag
-- leaves the Hall of Fame (back to pending) until an admin looks at it.
create function public.report_startup_tx(p_id uuid, p_ip_hash text, p_reason text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  insert into public.startup_reports (startup_id, ip_hash, reason)
  values (p_id, p_ip_hash, nullif(left(trim(p_reason), 300), ''))
  on conflict do nothing;
  if not found then
    select report_count into v_count from public.startups where id = p_id;
    return coalesce(v_count, 0);
  end if;
  update public.startups
     set report_count = report_count + 1,
         status = case when report_count + 1 >= 3 and status = 'approved' then 'pending' else status end
   where id = p_id
  returning report_count into v_count;
  return coalesce(v_count, 0);
end $$;
revoke execute on function public.report_startup_tx(uuid, text, text) from public, anon, authenticated;
grant execute on function public.report_startup_tx(uuid, text, text) to service_role;

-- ---------- Storage: logos are up to 1024 px now (the startup flag prints the logo large) ----------

update storage.buckets set file_size_limit = 1048576 where id = 'logos-public';

-- ---------- Carry over the approved logos from v1 ----------

insert into public.startups (
  id, slug, name, link, domain, logo_path, bg_color, status, created_at, approved_at,
  ip_hash, rights_confirmed_at, reviewed_at, reviewed_by
)
select
  l.id,
  left(regexp_replace(regexp_replace(lower(split_part(l.domain, '.', 1)), '[^a-z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'), 40)
    || '-' || left(replace(l.id::text, '-', ''), 6),
  initcap(split_part(l.domain, '.', 1)),
  l.website_url,
  l.domain,
  l.image_path,
  '#ffffff',
  'approved',
  r.created_at,
  l.approved_at,
  r.ip_hash,
  l.approved_at,
  r.reviewed_at,
  r.reviewed_by
from public.logos l
join public.logo_requests r on r.id = l.id
on conflict do nothing;
