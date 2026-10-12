-- What each startup does, picked from a fixed list in the app (src/lib/startups/model.ts, CATEGORIES).
-- The column stores the stable key ("fintech"), never the label, so labels can change without a backfill.
-- The check only validates the shape: adding a category to the list needs no migration.
-- Nullable: flags hoisted before this column existed have no category.
--
-- The hoist form no longer asks for a city. The city column stays for existing rows.

alter table public.startups
  add column category text check (category ~ '^[a-z0-9-]{1,30}$');
