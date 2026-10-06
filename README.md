# flag.ar — Argentine Startups Flag

One full-screen page with a 3D Argentine flag. Startups add their logo. The owner approves each one.

- Flag page: static Next.js page, Three.js r128 (pinned), Verlet cloth.
- Server: Next.js route handlers on Vercel. No Supabase Edge Functions.
- Backend: Supabase Postgres, Auth (password + TOTP), Storage.
- Abuse control: Vercel Firewall, Upstash Redis rate limits, hCaptcha.

The spec is in `Argentine Startups Flag — Product and Technical Spec.md`.

## Layout

| Path | What it does |
| --- | --- |
| `src/lib/flag/cloth.ts` | Cloth simulation. No framework code. |
| `src/lib/flag/layout.ts` | Layout units, patch slots, picking math, manifest types. |
| `src/lib/flag/texture.ts` | Canvas drawing: bands, sun, hem, patches, weave. |
| `src/lib/flag/scene.ts` | Three.js scene, controls, picking, quality tuning, PNG export. |
| `src/components/` | Flag page UI, upload dialog, hCaptcha, no-WebGL fallback. |
| `src/app/api/upload` | Public upload route. All cheap checks run before Supabase. |
| `src/app/api/admin/*` | Login (password step), approve (re-encode with `sharp`), remove. |
| `src/app/api/cron` | Hourly cleanup, keep-alive, manifest rebuild, Slack alerts. |
| `src/app/admin` | Admin panel and sign-in. |
| `src/proxy.ts` | Admin gate (Next.js 16 "proxy", formerly middleware). Plain 404 for everyone else. |
| `supabase/migrations` | Tables, RLS, functions, buckets, `pg_cron` job. |
| `supabase/tests` | pgTAP policy tests. |

## Run locally (no Supabase)

```sh
npm install
npm run sample          # writes 20 placeholder logos to public/sample
cp .env.example .env.local
# In .env.local set NEXT_PUBLIC_FILES_BASE=/sample, IP_HASH_SALT and CRON_SECRET to any string.
npm run dev
```

Add `?debug` to the URL in dev to get `window.__flag` in the console.

Tests: `npm test` (unit), `npm run lint` (types), `npx supabase test db` (policies, needs Docker).

## Set up production

Do these steps in order.

1. **Supabase project.** Create it in `sa-east-1` (São Paulo). Link and push:
   `npx supabase link --project-ref <ref>` then `npx supabase db push`.
2. **Auth settings (dashboard).**
   - Turn off sign-ups. Turn off email confirmations, magic links, and password recovery emails.
   - Attack Protection: turn on CAPTCHA, provider hCaptcha, with your hCaptcha secret.
   - JWT expiry: 900 seconds.
   - MFA: TOTP on (enroll and verify).
3. **Owner user.** Authentication > Users > Add user. Use a long random password. Check "Auto confirm".
   Then add the row: `insert into public.admins (user_id) values ('<user id>');`
4. **First sign-in.** Open `/admin/login`. After the password, the page shows a QR code. Scan it and enter
   the code. From then on, every sign-in needs the TOTP code.
5. **Vault secrets** for the hourly job (SQL editor):
   ```sql
   select vault.create_secret('https://flag.ar/api/cron', 'cron_url');
   select vault.create_secret('<CRON_SECRET>', 'cron_secret');
   ```
6. **Upstash.** Create a Redis database (region close to `gru1`). Copy the REST URL and token.
7. **hCaptcha.** Create a site for `flag.ar`. Copy the site key and secret.
8. **Vercel.** Import the repo. Set every variable from `.env.example`. Add the domain `flag.ar`.
   Region is `gru1` (see `vercel.json`). The daily cron is in `vercel.json`.
9. **Vercel Firewall** (dashboard, 3 custom rules on Hobby):
   - Rate limit: path equals `/api/upload`, method POST, 20 requests per 60 s per IP, action deny.
     This is a coarse guard. The route enforces the real limits.
   - Admin geo rule: path starts with `/admin` or `/api/admin`, and country is not `AR` and IP is not
     `<your IP>`: deny.
   - Spare.
10. **Slack.** Create an incoming webhook and set `SLACK_WEBHOOK_URL`.
11. **Check.** `curl -I https://flag.ar/files/manifest.json` twice. The second reply must show
    `x-vercel-cache: HIT`. This answers the spec's open question about the CDN.

## Monthly backup

Supabase Free has no backups. Once a month:

```sh
npx supabase db dump --data-only -f backup-$(date +%Y-%m).sql --schema public
```

Keep `logos` and `blocklist`. Copy the `logos-public` bucket if you need the images.

## Limits

| Limit | Value | Where |
| --- | --- | --- |
| Uploads per IP | 10 per hour | `api/upload` (Upstash) |
| Uploads per network (/24, /64) | 30 per hour | `api/upload` (Upstash) |
| Uploads site-wide | `settings.site_hourly_cap` (60) | `api/upload` (Upstash) |
| Pending queue | `settings.queue_cap` (200) | `api/upload` |
| Failed admin sign-ins | 5 per 10 minutes per IP | `api/admin/login` (Upstash) and Supabase Auth |
| File size | 512 KiB | route and bucket |
