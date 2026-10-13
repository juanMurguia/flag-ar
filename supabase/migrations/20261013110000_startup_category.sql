-- What the startup does, from the fixed list in src/lib/startups/model.ts (CATEGORIES). The hoist form
-- asks for it and the Hall of Fame search matches on it. Null for flags carried over from v1.
alter table public.startups add column category text check (char_length(category) <= 40);
