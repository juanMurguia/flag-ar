-- Likes: any visitor can like a flag in the Hall of Fame, once per device, without an account.
-- More likes, a better seat: the hall orders approved flags by like_count, then by order_number.
--
-- A "voter" is a random id in an httpOnly cookie. The server stores only its salted hash, plus the
-- salted IP hash for abuse review. Rate limits per IP live in Redis, not here.

alter table public.startups
  add column like_count integer not null default 0 check (like_count >= 0);

create table public.startup_likes (
  startup_id uuid not null references public.startups (id) on delete cascade,
  voter_hash text not null check (voter_hash ~ '^[0-9a-f]{64}$'),
  ip_hash text not null,
  created_at timestamptz not null default now(),
  primary key (startup_id, voter_hash)
);

-- "Which flags did this device like?" on every Hall of Fame visit.
create index startup_likes_voter_idx on public.startup_likes (voter_hash);
-- The hall's seat order.
create index startups_salon_rank_idx on public.startups (like_count desc, order_number) where status = 'approved';

-- Same model as startups: the admin reads with aal2, every write goes through the server (service role).
grant select on public.startup_likes to authenticated;
grant all on public.startup_likes to service_role;
revoke all on public.startup_likes from anon;
revoke insert, update, delete, truncate on public.startup_likes from authenticated;

alter table public.startup_likes enable row level security;

create policy admin_read on public.startup_likes
  for select to authenticated using ((select public.is_admin()));
create policy admin_mfa on public.startup_likes
  as restrictive for all to authenticated
  using (((select auth.jwt()) ->> 'aal') = 'aal2');

-- Likes (p_like = true) or unlikes a flag for one voter. Idempotent: a second like changes nothing.
-- Only approved flags take likes. Returns the new count, or null when the flag is not in the hall.
create function public.like_startup_tx(p_id uuid, p_voter_hash text, p_ip_hash text, p_like boolean)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if not exists (select 1 from public.startups where id = p_id and status = 'approved') then
    return null;
  end if;
  if p_like then
    insert into public.startup_likes (startup_id, voter_hash, ip_hash)
    values (p_id, p_voter_hash, p_ip_hash)
    on conflict do nothing;
    if found then
      update public.startups set like_count = like_count + 1 where id = p_id returning like_count into v_count;
    end if;
  else
    delete from public.startup_likes where startup_id = p_id and voter_hash = p_voter_hash;
    if found then
      update public.startups set like_count = greatest(like_count - 1, 0) where id = p_id returning like_count into v_count;
    end if;
  end if;
  if v_count is null then
    select like_count into v_count from public.startups where id = p_id;
  end if;
  return v_count;
end $$;
revoke execute on function public.like_startup_tx(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.like_startup_tx(uuid, text, text, boolean) to service_role;
