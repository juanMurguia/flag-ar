-- Hourly job: pg_cron + pg_net call flag.ar/api/cron.
-- Vercel Hobby cron runs only once a day, so the hourly work starts here.
--
-- Before this job can work, create two Vault secrets by hand (never commit them):
--   select vault.create_secret('https://flag.ar/api/cron', 'cron_url');
--   select vault.create_secret('<same value as CRON_SECRET on Vercel>', 'cron_secret');

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.call_cron_endpoint() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'cron_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_url is null or v_secret is null then
    raise warning 'cron_url or cron_secret missing in Vault';
    return;
  end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end $$;
revoke execute on function public.call_cron_endpoint() from public, anon, authenticated;

select cron.schedule('flag-hourly', '7 * * * *', $$ select public.call_cron_endpoint(); $$);
