-- Policy tests. Run with: npx supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

-- Fixtures: one admin, one other signed-in user, one pending request.
insert into auth.users (id, email, aud, role)
values
  ('00000000-0000-0000-0000-00000000000a', 'owner@test.local', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000b', 'other@test.local', 'authenticated', 'authenticated');
insert into public.admins (user_id) values ('00000000-0000-0000-0000-00000000000a');
insert into public.logo_requests (id, website_url, domain, ip_hash, file_hash, file_path)
values ('11111111-1111-1111-1111-111111111111', 'https://acme.com/', 'acme.com', 'x',
        repeat('a', 64), '11111111-1111-1111-1111-111111111111.png');

-- ---------- anon ----------
set local role anon;
select throws_ok($$ select * from public.logo_requests $$, '42501', null, 'anon cannot read logo_requests');
select throws_ok($$ select * from public.logos $$, '42501', null, 'anon cannot read logos');
select throws_ok($$ select * from public.settings $$, '42501', null, 'anon cannot read settings');
select throws_ok($$ select public.deny_request('11111111-1111-1111-1111-111111111111', 'x') $$,
  '42501', null, 'anon cannot call deny_request');
reset role;

-- ---------- admin at aal1 ----------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal1"}', true);
select is((select count(*) from public.logo_requests), 0::bigint, 'admin at aal1 sees no requests');
select throws_ok($$ select public.deny_request('11111111-1111-1111-1111-111111111111', 'x') $$,
  '42501', null, 'admin at aal1 cannot deny');
select throws_ok($$ select public.set_setting('uploads_enabled', 'false') $$,
  '42501', null, 'admin at aal1 cannot change settings');

-- ---------- other user at aal2 ----------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","aal":"aal2"}', true);
select is((select count(*) from public.logo_requests), 0::bigint, 'non-admin sees no requests');
select is(public.is_admin(), false, 'non-admin is not admin');
select throws_ok($$ select public.deny_request('11111111-1111-1111-1111-111111111111', 'x') $$,
  '42501', null, 'non-admin cannot deny');

-- ---------- admin at aal2 ----------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal2"}', true);
select is((select count(*) from public.logo_requests), 1::bigint, 'admin at aal2 sees requests');
select throws_ok($$ insert into public.logo_requests (website_url, domain, ip_hash) values ('https://x.com', 'x.com', 'y') $$,
  '42501', null, 'admin cannot insert directly');
select throws_ok($$ select public.approve_request_tx('11111111-1111-1111-1111-111111111111', 'a.png', auth.uid()) $$,
  '42501', null, 'admin JWT cannot call the service-only approve function');
select lives_ok($$ select public.deny_request('11111111-1111-1111-1111-111111111111', 'fake', true, true) $$,
  'admin at aal2 can deny');
select is((select status::text from public.logo_requests where id = '11111111-1111-1111-1111-111111111111'),
  'denied', 'request is denied');
select is((select count(*) from public.blocklist), 2::bigint, 'domain and hash are blocked');
reset role;

select * from finish();
rollback;
