# Argentine Startups Flag — Product and Technical Spec

Oct 5, 2026 · @Juan Cruz

## Overview

The product is one full-screen web page. It shows a very large 3D Argentine flag that waves in the wind. Startups add their logo and website link to the flag. The admin approves each upload before it goes public.

- **Visitors** rotate the flag, zoom, and tap a logo to see the brand.
- **Brand owners** upload a logo, then isolate it ("show only this logo") and download a PNG with only their logo.
- **The admin** (one person) approves or denies each upload in a protected panel. This stops fake and abusive uploads.

The goal is a minimal, intuitive page with ultra-realistic cloth. The page must be easy to screenshot and share.

A working prototype exists (Three.js, one HTML file). It stores logos only in each visitor's browser. This spec builds the whole backend on Supabase: Auth, Postgres, Storage, and scheduled jobs. Next.js on Vercel runs all server code.

## Goals and non-goals

**Goals**

- One page, one flag, no other screens for visitors.
- Upload takes under 30 seconds: one logo file and one link. No login and no email.
- Every public logo is approved by the admin first.
- Real cloth motion, fabric texture, and soft shadows at 60 fps on a current laptop.
- A brand owner can export a PNG that shows only their logo.
- Only the admin can reach the admin panel. The site stays online under heavy traffic or attack.

**Non-goals (version 1)**

- User accounts for brand owners.
- Paid or featured placements.
- Editing a logo after approval. The owner submits a new request instead.
- Native mobile apps.

## User flows

**Visitor**

1. Opens the page. The flag fills the screen and waves.
2. Drags to rotate. Scrolls or pinches to zoom.
3. Taps a logo. A card shows the brand name and link.
4. Taps "Visit site" to open the brand website.

**Brand owner**

1. Taps "Add your logo".
2. Drops a logo file and types the website link.
3. Taps "Add to flag". The page says: "Sent for review. We show it after approval."
4. After approval, finds the logo on the flag. Taps it, then "Show only this logo".
5. Taps "Download PNG" to save an image with only their logo.

**Admin**

1. Opens the admin route and signs in.
2. Sees the queue of pending uploads, newest first.
3. Opens one request. Checks the logo, the link, and the domain.
4. Approves or denies. A denial can include a reason.
5. An approved logo appears on the public flag within seconds.

## Flag rendering

The flag is one cloth mesh with a woven fabric texture. It has no pole. The values below match the current prototype and are the starting point for version 1.

| Area | Spec |
| --- | --- |
| Library | Three.js (WebGL). React Three Fiber is optional in the Next.js app. |
| Flag shape | Ratio 14:9. Three equal bands: light blue `#74ACDF`, white, light blue. Sun of May in `#F6B40E` at the center. |
| Cloth | Verlet simulation on a 65 × 43 point grid. Fixed 60 Hz step. 10 constraint passes per step. Structural, shear, and bend links. |
| Held edge | The left edge is pinned. It floats and flutters a little. No pole is drawn. |
| Wind | Gusts that change over time, plus waves along the flag. The visitor sets strength with a slider (0 to 2). |
| Fabric | Plain weave. 4 px thread pitch on a 2800 × 1800 px texture. Normal map and darkening between threads. Hem and stitch lines on all edges. |
| Material | Physical material. Roughness 0.9. Fabric sheen. Back side shows the mirrored texture. |
| Light | Soft studio environment map. One key light with 2048 px shadows. One weak back light so the reverse side is not black. |
| Tone | ACES filmic tone mapping. Exposure 1.08. |
| Camera | Field of view 32°. Distance fits the flag to any screen, portrait or landscape. |
| Controls | Drag to rotate. Wheel or pinch to zoom (0.45× to 1.5×). Double-click resets the view. |
| Capacity | 40 logo patches. They fill outward from the sun. Open question: what happens after 40. |

**Logo patches.** Each logo sits on a white sewn patch with a stitched border. The fabric weave shows over the patch. The logo keeps its aspect ratio.

**Performance rules.** The page must build the fabric texture after the first frame, so the flag shows at once. On a slow device, the app lowers the cloth grid first, then the shadow size.

## Cloth physics and Three.js logic

The prototype already runs this logic. This section records it so the Next.js port matches it. The prototype uses Three.js r128. Pin the version in the port.

**Scene setup**

| Part | Rule |
| --- | --- |
| Renderer | WebGL with antialiasing. Transparent background. Pixel ratio capped at 2. sRGB output. ACES filmic tone mapping. Soft shadow maps. |
| Camera | Perspective, 32° field of view. Distance is the larger of two fits: flag width × 1.1 and flag height × 1.55. Zoom multiplies the distance. |
| Lights | Environment map built from a gradient sky and two soft boxes. One key light with a 2048 px shadow map. One weak back light. |
| Meshes | One plane (64 × 42 segments, 14 × 9 units), drawn twice: a front side and a back side. The back side uses the mirrored texture, so logos read correctly from behind. |
| Material | Physical material. Roughness 0.9. No metal. Fabric sheen. |

**Cloth simulation (Verlet).** Every vertex is one particle. Each particle keeps a position and a previous position.

| Item | Rule |
| --- | --- |
| Grid | 65 × 43 particles |
| Time step | Fixed 60 Hz. At most 2 steps per frame. Extra time is dropped. |
| Move | `new = pos + (pos − prev) × 0.986 + force × step²`, with step = 1/60 s |
| Gravity | −8 on Y |
| Gust | `0.78 + 0.22 sin(0.37 t) + 0.12 sin(0.91 t + 1.3)` |
| Wind on X | `W × gust × (18 + 6 sin(0.7 t + 0.5 y0))` |
| Wind on Z | `W × gust × ramp × (24 sin(0.8 x0 − 2.8 t + 0.35 y0) + 9 sin(1.1 t + 0.6 y0) + 6 sin(2.1 x0 − 4.3 t + 1.3 y0))` |
| Ramp | Column number ÷ column count. Waves grow away from the held edge. |
| W | Wind slider, 0 to 2, default 1 |
| Held edge | The left column is pinned and has no pole. Each frame its Y offset is `0.05 sin(0.8 t + 0.02 row)` and its Z offset is `0.14 sin(1.15 t + 0.045 row) × (0.4 + 0.6 W)`. |
| Links | Structural (neighbors), shear (diagonals), and bend (two apart). 10 passes per step. They run from the held edge outward. A link with one pinned end moves only the free end. |
| Start | 80 warm-up steps before the first frame |

`x0` and `y0` are the particle's rest position (column and row times the spacing).

```js
// Pseudo-code for one step. t = time in seconds.
function step(t) {
  const gust = 0.78 + 0.22*sin(t*0.37) + 0.12*sin(t*0.91 + 1.3);
  for (const p of particles) {
    if (p.pinned) { holdEdge(p, t); continue; }
    const fx = W * gust * (18 + 6*sin(t*0.7 + p.y0*0.5));
    const fy = -8;
    const fz = W * gust * p.ramp * (
      24*sin(p.x0*0.8 - t*2.8 + p.y0*0.35) +
       9*sin(t*1.1 + p.y0*0.6) +
       6*sin(p.x0*2.1 - t*4.3 + p.y0*1.3));
    const next = p.pos + (p.pos - p.prev)*0.986 + vec(fx, fy, fz)/3600;
    p.prev = p.pos; p.pos = next;
  }
  for (let i = 0; i < 10; i++)
    for (const link of links) relax(link); // move the free ends until the length is the rest length
}
```

**Mesh update.** After the steps, copy the particle positions into the geometry. Recompute the vertex normals and the bounding sphere each frame. Picking needs the bounding sphere.

**Textures**

- The color map is a 2800 × 1800 canvas. The layout uses 1400 × 900 units at 2× scale: three bands, the sun, a hem, stitch lines, and the logo patches.
- The app builds the weave after the first frame. It is a plain weave with a 4 px thread pitch, plus small random noise. It makes two images: a gray overlay that multiplies over the color map, and a normal map.
- Anisotropic filtering is set to the GPU maximum.

**Interaction**

- Drag changes a target yaw and pitch. Pitch is limited to ±0.7 rad. The real angles ease toward the target by 12% each frame. The rotation applies to the whole flag.
- Wheel or two-finger pinch zooms from 0.45× to 1.5×. Double-click resets the view.
- A tap with less than 6 px of movement selects a logo. More movement counts as a drag.
- Picking casts a ray from the pointer. The hit point (UV) maps to layout units. A logo is hit when the point is within 62 units of its patch center.
- The flag has 40 patch slots on a 9 × 5 grid. Slots within 200 units of the sun are skipped. Slots are sorted by distance from the sun, so logos fill outward.
- Solo mode redraws the texture with only the selected logo on a large patch under the sun. PNG export renders at 2400 px wide with the same camera, then restores the screen size.

**Port notes.** Keep the simulation in one module with no framework code. Plain Three.js and React Three Fiber can both call it. If a step takes more than 6 ms on a mid-range phone, lower the grid first (for example 48 × 32), then the pass count.

## Logo upload and brand actions

**Upload form.** Two fields: logo file and website link. No login and no email. The browser turns any image (PNG, JPG, WebP, or SVG) into a PNG of at most 512 px before it sends anything.

**Upload steps.** One request carries the logo and the link. The browser never talks to Supabase to upload.

1. The browser sends one request to `flag.ar/api/upload`. It holds the PNG file, the link, and an hCaptcha token. The Vercel Firewall and its rate-limit rule answer first.
2. The upload route (a Next.js route handler on Vercel) runs the cheap checks (see Abuse and rate-limit protection): size, file signature, hCaptcha, the per-IP limit, and the uploads switch. A request that fails any check never reaches Supabase.
3. The route saves a SHA-256 hash of the file. It rejects blocked domains and blocked hashes.
4. The route writes the file to the private bucket `logos-pending` with the service role key. It creates the request row with status `pending`. If the row fails, the route deletes the file.
5. The page says: "Sent for review. We show it after approval."

| Rule | Value |
| --- | --- |
| File types | PNG, JPEG, WebP. The upload route checks the file signature. The bucket enforces the types too. |
| File size | 512 KiB maximum. The route and the bucket both enforce it. A 512 px PNG from the browser is far smaller. |
| Image processing | The browser makes a 512 px PNG. The admin step re-encodes it again before it goes public. |
| SVG | The server does not accept SVG. The browser converts it to PNG first. |
| Link | Must be an `http` or `https` address with a real domain. The route adds `https://` if missing. |
| Duplicates | One live request per domain. A unique index enforces it. The file hash finds repeat images. |
| Limits | 10 uploads per IP address per hour. More limits are in the abuse section. |
| After send | Status is `pending`. The logo is not public. |

**Show only this logo.** The visitor taps a logo, then "Show only this logo". The page hides all other logos. The chosen logo moves to a large patch under the sun. "Show all logos" reverses it.

**Download PNG.** The page renders the flag at 2400 px wide with the same angle and zoom the visitor sees. Only the chosen logo shows. The visitor can pick a transparent background. The file name is `argentina-<domain>.png`.

**Remove a logo.** A brand owner who wants a logo removed sends a request. The admin deletes it in the panel. The public page has no delete button.

## Moderation and admin panel

The admin panel is a protected route for one person: the owner. Every upload stays `pending` until the owner decides. Only an approved logo reaches the public flag.

&#91;embedded content: approval flow · 5 steps, 1 decision\]

A request passes the upload checks and waits in a private bucket. The owner approves or denies it. A denied request never reaches the public table.

- The owner can remove a live logo at any time.
- A decision is final in version 1. A sender who wants a change submits a new request.
- The panel lists a denied request with its reason, so the owner can see past decisions.
- Screens, routes, and security rules are in the sections below.

## Supabase data model

All data lives in one Supabase project. Visitors never read or write a table. They read one public file (`manifest.json`) and the logo images from Storage. Private data (IP hashes, pending files) never shares a table or bucket with public data.

| Object | Kind | Access |
| --- | --- | --- |
| `logo_requests` | Table | Admin only (RLS and MFA level 2) |
| `logos` | Table | Admin only. The public reads the manifest, not the table. |
| `admins` | Table | A user reads only their own row |
| `settings` | Table | Admin only. Holds the uploads switch and the caps. |
| `blocklist` | Table | Admin only. Blocked domains and file hashes. |
| `logos-pending` | Private bucket. 512 KiB. PNG, JPEG, WebP. | Admin reads. Only the server writes, with the service role key. |
| `logos-public` | Public bucket | Vercel's CDN reads and caches it. Only the server writes. Holds logo PNGs and `manifest.json`. |

Status values: `pending`, `approved`, `denied`, `removed`. A file that fails a check is rejected at the door and is never stored.

```sql
create type logo_status as enum
  ('pending','approved','denied','removed');

create table public.logo_requests (
  id uuid primary key default gen_random_uuid(),
  website_url text not null,
  domain text not null,
  status logo_status not null default 'pending',
  file_hash text,
  ip_hash text not null,
  deny_reason text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id)
);

create unique index one_live_request_per_domain
  on public.logo_requests (domain)
  where status in ('pending','approved');
create index on public.logo_requests (status, created_at);

create table public.logos (
  id uuid primary key references public.logo_requests(id),
  domain text not null,
  website_url text not null,
  image_path text not null,
  approved_at timestamptz not null default now()
);

create table public.admins (
  user_id uuid primary key references auth.users(id)
);

create table public.settings (
  key text primary key,
  value jsonb not null
);
insert into public.settings values
  ('uploads_enabled', 'true'),
  ('queue_cap', '200'),
  ('site_hourly_cap', '60');

create table public.blocklist (
  kind text not null check (kind in ('domain','file_hash')),
  value text not null,
  primary key (kind, value)
);

create function public.is_admin() returns boolean
language sql security definer set search_path = '' stable as $$
  select exists (
    select 1 from public.admins where user_id = (select auth.uid())
  );
$$;
```

**Manifest.** After each approval or removal, the server writes `manifest.json` to `logos-public`. The file lists every live logo: id, domain, link, and image path. The flag page reads only this file and the images it names, through `flag.ar/files/*`.

Slot position on the flag follows `approved_at` order. The first approved logo takes the slot nearest the sun.

## Security

Only the owner can reach the admin panel. Supabase Auth, Postgres policies, and the Next.js server routes each enforce this. Each works alone, so one mistake does not open the panel.

1. **Auth settings.** Turn off public sign-ups. Create the owner user by hand in the dashboard, with a long random password and no email. Enroll a TOTP factor. Do not use magic links or password reset. The app sends no emails. Turn on CAPTCHA (hCaptcha) for sign-in.
2. **Database policies.** Row Level Security is on for every table. The `anon` role has no table access at all. Admin policies are `restrictive`. They need the MFA claim `aal2` in the JWT and `is_admin()`.
3. **Server code.** All server code runs on Vercel. Admin routes check the session with `getUser()`, then `is_admin()`, then the `aal2` claim. The service role key lives only in Vercel environment variables. Supabase Edge Functions are not used.
4. **Admin app.** Next.js middleware (with `@supabase/ssr`) checks the session on the server. Anyone else gets a plain 404. Admin pages send `noindex`. A Vercel Firewall rule allows `/admin*` only from Argentina or your own IP address.

**Keys.** The flag page ships no Supabase key. The admin app uses the publishable key. The service role key lives only in Vercel environment variables and is used only in server code. Secrets that scheduled jobs need sit in Supabase Vault.

| Risk | Control |
| --- | --- |
| Private data leak | Tables have no `anon` access. Pending files sit in a private bucket. Admin previews use signed links that expire in 60 seconds. The app stores only salted hashes of IP addresses. |
| Malicious file | The bucket allows 3 image types and 512 KiB. The upload route checks the file signature. The admin step re-encodes the image with `sharp`. The flag shows only the re-encoded copy. |
| Unsafe links | Allow only `http` and `https`. Block localhost, IP-address hosts, and URL shorteners. Open links with `noopener noreferrer nofollow`. The card always shows the real domain. |
| Fake brand | The admin sees the logo, link, and domain before approval. |
| Script injection | Strict Content Security Policy on the site. Render all user text as plain text. |
| Stolen admin session | MFA level 2 on every admin policy and route. Short JWT lifetime. Sign-out ends the session. |
| Exposed project address | The public page calls only `flag.ar`. Visitors never see the Supabase project URL. The admin app does call Supabase, with a signed-in session. |
| Direct database access | Apps use the Data API, not direct connections. Keep the database password out of every repository. Check if your plan includes Network Restrictions. |
| Audit | Each decision stores `reviewed_by`, `reviewed_at`, and `deny_reason`. |

## Abuse and rate-limit protection

Senders have no account, so identity cannot stop abuse. Layers stop it instead. The Free plan has small quotas, so the first rule is: keep floods away from Supabase. Vercel answers all public traffic on `flag.ar`. Supabase sees only requests that passed every cheap check.

| Layer | Control | Stops |
| --- | --- | --- |
| 1. Vercel Firewall | DDoS mitigation is always on, and blocked traffic is free. Add one rate-limit rule for `/api/upload` as a coarse guard. Add one rule that allows `/admin*` only from Argentina or your own IP address. Hobby allows 3 custom rules, and only 1 of them can be a rate-limit rule. | Volume attacks and scanners |
| 2. Cache | The flag page and `flag.ar/files/*` are served from Vercel's CDN. Files come from the public bucket with long cache headers. Image names are unique. | Read floods. Protects the Supabase egress quota. |
| 3. Early reject | The upload route checks method, `Origin`, and `Content-Length` first. It rejects a body over 512 KiB before it reads it. | Junk and cross-site requests |
| 4. Rate limit | Upstash Redis sliding window, called from the route. 10 uploads per IP address per hour. Keys use a salted hash of the IP address. Reply `429` with `Retry-After`. | Repeat senders and small botnets |
| 5. Bot check | hCaptcha token, verified in the route, used once. A hidden honeypot field. Reject forms sent in under 3 seconds. | Scripts and headless browsers |
| 6. Cheap rules | Check the file signature. Read the uploads switch and the queue cap. Reject IP-address links and URL shorteners. | Bad files and low-effort fakes |
| 7. Database rules | The route rejects blocked domains and blocked hashes. The unique index rejects a second live request for a domain. | Repeat fakes |
| 8. Quarantine | The file lands in a private bucket. The logo stays `pending`. Image decoding happens only for an approved logo, in the admin step. | Image bombs and abusive content |
| 9. Cleanup | An hourly job (`pg_cron` and `pg_net` call `/api/cron`) deletes the files of denied requests. | Storage bloat |

**Starting limits.** Tune them after launch.

| Limit | Value |
| --- | --- |
| Uploads per IP address | 10 per hour |
| Uploads per network (IPv4 /24, IPv6 /64) | 30 per hour |
| Uploads site-wide | 60 per hour |
| Pending queue | 200 requests |
| Other public calls per IP address | 60 per minute |
| Failed admin sign-ins | 5 per 10 minutes per IP address |
| File size | 512 KiB |

**Circuit breakers.** If the site-wide limit or the queue cap is reached, uploads pause. The form says: "Uploads are paused. Try again later." The flag page keeps working. The owner gets an alert.

**Kill switch.** An "Uploads on/off" switch in the admin header pauses all uploads at once. It reads a database setting, so it works without a deploy.

**Admin route.** A Vercel Firewall rule allows `/admin*` only from Argentina or your own IP address. Supabase sign-in (password and TOTP, with hCaptcha) is the next step. The app (with Upstash) and Supabase Auth rate limit failed attempts.

**Fail safe.** The flag page needs only static files. The cached manifest and images keep loading while the database is busy. The upload form shows the pause message if uploads fail.

**Free plan limits.** Supabase Free and Vercel Hobby have no overage billing. A flood can use up the quotas below, and the provider then limits the project. The design keeps floods away from both.

| Limit | Value | What the design does |
| --- | --- | --- |
| Supabase Edge Function calls | 500,000 per month | Not used. All server code runs on Vercel. |
| Supabase file storage | 1 GB | Bucket limit is 512 KiB per file. Queue cap is 200. The hourly job deletes denied files. |
| Supabase egress | 5 GB, plus 5 GB cached | Vercel's CDN caches public files. Approved logos are re-encoded 512 px PNG files. |
| Supabase database | 500 MB | Rows are small. Old denied requests are removed. |
| Supabase inactivity pause | After 1 week | A daily Vercel cron job calls `/api/cron`, which queries the database. |
| Supabase backups | None | Keep migrations in Git. Export `logos` and `blocklist` with the CLI each month. |
| Vercel Hobby use | Personal, non-commercial only | Confirm that `flag.ar` fits. If not, use Pro. |
| Vercel Hobby cron | 1 run per day per job | Hourly work runs from `pg_cron` and `pg_net`, which call `/api/cron`. |
| Vercel Firewall on Hobby | 3 custom rules, 1 rate-limit rule | One rule limits `/api/upload`. One rule guards `/admin*`. One rule is spare. |

Alerts go to Slack, not email. The upload route and `/api/cron` send them for a full queue, 429 spikes, and failed database calls.

**Limit of this design.** No setup can promise zero downtime. A very large attack needs the edge provider's own mitigation. This design keeps the origin cheap to protect.

## Supabase API surface

| Endpoint | Access | Job |
| --- | --- | --- |
| File `flag.ar/files/manifest.json` | Public. Cached by Vercel's CDN. | List of live logos. |
| Files `flag.ar/files/<id>.png` | Public. Cached. | Re-encoded logos, from `logos-public`. |
| `POST /api/upload` | Public. Firewall rule, rate limit, hCaptcha, file checks. | Stores the file in `logos-pending`. Creates the `pending` row. |
| `POST /api/admin/approve` | Admin session, `aal2`, `is_admin()` | Re-encodes the image with `sharp`. Writes it to `logos-public`. Inserts the `logos` row. Rebuilds the manifest. |
| `POST /api/admin/remove` | Same as approve | Deletes the public file and the row. Rebuilds the manifest. |
| `/api/cron` | Secret header only | Deletes files of denied requests. Checks the database. Sends Slack alerts. Called hourly by `pg_cron` and daily by Vercel Cron. |
| RPC `deny_request(id, reason, block_domain, block_hash)` | Admin JWT, `aal2` | Sets `denied`. Adds optional block-list entries. |
| RPC `set_setting(key, value)` | Admin JWT, `aal2` | Uploads switch and caps. |
| Queue reads | Admin JWT, `aal2`, RLS | The admin app selects from `logo_requests` with the admin's own session. |

An approval is one server call. If the file write fails, the status does not change. The browser never holds the service role key.

**Admin panel screens.** The queue is one list with a filter: Pending, Approved, Denied. A row shows a logo thumbnail, domain, and age. A click opens a side panel with the full logo on both a white and a dark background and the link (not clickable until the admin chooses "Open link in new tab"). Two buttons: Approve and Deny. A deny can also add the domain and the image to a block list. Both boxes are off by default. A switch in the header pauses all uploads. Keyboard shortcuts: `A` approves, `D` denies, arrow keys move.

**Database policies.** Every admin policy is `restrictive` and needs the `aal2` claim. A restrictive policy must pass together with the permissive one.

```sql
alter table public.logo_requests enable row level security;
alter table public.logos enable row level security;
alter table public.admins enable row level security;
alter table public.settings enable row level security;
alter table public.blocklist enable row level security;

revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon;

-- Repeat this pair for logo_requests, logos, settings, and blocklist.
create policy admin_read on public.logo_requests
  for select to authenticated using (public.is_admin());
create policy admin_mfa on public.logo_requests
  as restrictive for all to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2');

create policy self_read on public.admins
  for select to authenticated using (user_id = (select auth.uid()));

-- Admin previews of pending files.
create policy admin_read_pending on storage.objects
  for select to authenticated
  using (bucket_id = 'logos-pending' and public.is_admin()
         and (select auth.jwt()->>'aal') = 'aal2');

create function public.deny_request(
  p_id uuid, p_reason text,
  p_block_domain boolean default false,
  p_block_hash boolean default false
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() or (select auth.jwt()->>'aal') <> 'aal2' then
    raise exception 'not allowed';
  end if;
  update public.logo_requests
    set status = 'denied', deny_reason = p_reason,
        reviewed_at = now(), reviewed_by = (select auth.uid())
    where id = p_id and status = 'pending';
  if p_block_domain then
    insert into public.blocklist
      select 'domain', domain from public.logo_requests where id = p_id
      on conflict do nothing;
  end if;
  if p_block_hash then
    insert into public.blocklist
      select 'file_hash', file_hash from public.logo_requests
      where id = p_id and file_hash is not null
      on conflict do nothing;
  end if;
end $$;
revoke execute on function public.deny_request(uuid, text, boolean, boolean)
  from public, anon;
grant execute on function public.deny_request(uuid, text, boolean, boolean)
  to authenticated;
```

No client can insert into a table. Only the Next.js server, with the service role key, creates requests. Treat this SQL as a starting point: test every policy with the Supabase CLI before launch.

## Architecture and stack

Supabase is the backend: Postgres, Auth, and Storage. Next.js on Vercel is the only server code, and it takes all public traffic on `flag.ar`. The flag page is a static page. Three.js draws the flag in the browser.

&#91;embedded content: system architecture · 3 zones, 7 parts\]

Visitors talk only to `flag.ar`. Vercel serves cached files from Supabase Storage and runs the upload route. Only valid uploads reach Supabase. The admin app signs in with Supabase Auth and calls Supabase with its own session. The proposed stack:

| Layer | Choice |
| --- | --- |
| Domain and hosting | `flag.ar` on Vercel (Hobby plan). Firewall, CDN, and DDoS mitigation included. |
| Flag page | Static page with Three.js |
| Server code | Next.js route handlers on Vercel. `sharp` for images. |
| Admin app | Next.js with `@supabase/ssr` |
| Database | Supabase Postgres with RLS (Free plan) |
| Files | Supabase Storage: one public and one private bucket |
| Sign-in | Supabase Auth: password and TOTP, public sign-up off, no emails |
| Schedules | `pg_cron` and `pg_net` hourly. Vercel Cron daily. Both call `/api/cron`. |
| Rate limits | Upstash Redis, called from the upload route |
| Bot check | hCaptcha |
| Alerts | Slack message from the server |
| Tooling | Supabase CLI for migrations, local tests, and deploys |

## Quality targets

| Area | Target |
| --- | --- |
| Frame rate | 60 fps on a current laptop. At least 30 fps on a mid-range phone. |
| First view | Flag visible in under 2 seconds on a 4G connection. Fabric detail may arrive up to 1.5 seconds later. |
| Logo loading | Each public logo is a 512 px PNG. Load them after the first frame. |
| Browsers | Latest Chrome, Edge, Firefox, and Safari. iOS Safari 16 or newer. WebGL2 required. |
| No WebGL | Show a still image of the flag and the brand list. |
| Screens | Phone portrait and landscape, tablet, desktop. The flag fits any size. |
| Keyboard | Every control works with the keyboard. Focus is always visible. |
| Screen readers | A hidden text list of all brands with links sits under the canvas. |
| Motion | If the visitor asks for reduced motion, the wind starts at low strength. |
| Theme | Light only. There is no dark mode. The page sets its color scheme to light. |
| Contrast | Text meets WCAG AA. |

## Milestones and open questions

The work has four phases. No dates are set yet.

| Phase | Scope | Done when |
| --- | --- | --- |
| 1. Port | Move the prototype into a static page on Vercel at `flag.ar`. Keep the flag, solo mode, and PNG export. The page reads a sample `manifest.json`. | The flag looks and runs like the prototype. |
| 2. Supabase backend | Migrations for tables, RLS, buckets, and policies. `POST /api/upload` with Upstash limits and hCaptcha. Firewall rules. Cache headers for `flag.ar/files/*`. | A visitor can send a request and it shows as `pending`. A flood test gets `429` replies. |
| 3. Admin | Admin app: password and TOTP sign-in, queue, `deny_request`, approve and remove routes with `sharp`, manifest writer, uploads switch. Firewall rule for `/admin*`. | The owner approves a request and the logo shows on the public flag. A non-admin gets a 404. |
| 4. Hardening | `/api/cron` with hourly cleanup, daily keep-alive, and Slack alerts. Load tests. Content Security Policy. Brand list for screen readers. No-WebGL fallback. Monthly manual backup. | All quality targets and abuse limits pass tests on three real devices. |

**Open questions**

- [ ] Does NIC Argentina let you point `flag.ar` to Vercel (DNS records or Vercel name servers)? Check before phase 1.
- [ ] Vercel Hobby is for personal, non-commercial use. Does `flag.ar` fit? If not, you need Pro.
- [ ] Does Vercel's CDN serve `flag.ar/files/*` from cache without calling Supabase? Test this in phase 2.
- [ ] Are the site-wide cap (60 per hour) and the queue cap (200 pending) right?
- [ ] Alerts go to Slack, since you want no emails. Is Slack right?
- [ ] When traffic grows, do you accept an upgrade to Pro on Supabase or Vercel?

## Sources

Supabase and Vercel documentation, read Oct 5, 2026. I did not check Network Restrictions on the Supabase Free plan or how Vercel's CDN caches proxied files. Verify them before you commit to the design.

- [Supabase pricing](https://supabase.com/pricing): Free plan limits, pause after 1 week, no automatic backups
- [Supabase production checklist](https://supabase.com/docs/guides/deployment/going-into-prod): auth rate limits, abuse prevention, CAPTCHA
- [Supabase multi-factor authentication](https://supabase.com/docs/guides/auth/auth-mfa): `aal2` and restrictive RLS policies
- [Supabase scheduled jobs](https://supabase.com/docs/guides/functions/schedule-functions): `pg_cron`, `pg_net`, Vault
- [Vercel DDoS mitigation](https://vercel.com/docs/vercel-firewall/ddos-mitigation): on all plans, blocked traffic not billed
- [Vercel WAF rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting): Hobby limits
- [Vercel cron jobs](https://vercel.com/docs/cron-jobs/usage-and-pricing): Hobby runs once per day
- [Vercel pricing](https://vercel.com/pricing): Hobby is for personal, non-commercial use
