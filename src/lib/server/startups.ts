import "server-only";
import { revalidateTag, unstable_cache } from "next/cache";
import type { PublicStartup, StartupStatus } from "@/lib/startups/model";
import { serviceClient } from "./supabase";

export const FILES_PATH = "/files";
const COLUMNS =
  "id, slug, name, city, category, link, domain, logo_path, bg_color, order_number, status, featured, created_at, approved_at";
/** The Hall of Fame list is cut here. Past this, the payload and the scene need paging. */
export const SALON_MAX = 5000;

interface Row {
  id: string; slug: string; name: string; city: string | null; category: string | null; link: string; domain: string;
  logo_path: string | null; bg_color: string; order_number: number; status: StartupStatus;
  featured: boolean; created_at: string; approved_at: string | null;
}

export function toPublic(r: Row): PublicStartup {
  return {
    id: r.id, slug: r.slug, name: r.name, city: r.city, category: r.category, link: r.link, domain: r.domain,
    logoUrl: r.logo_path ? `${FILES_PATH}/${r.logo_path}` : null,
    bgColor: r.bg_color, order: Number(r.order_number), status: r.status, featured: r.featured,
    createdAt: r.created_at, approvedAt: r.approved_at,
  };
}

export const tagFor = (slug: string) => `startup:${slug}`;
export const SALON_TAG = "salon";

/**
 * One startup by slug, pending or approved. A new flag is visible on its own URL at once;
 * a rejected one is gone. Cached until an edit or a review invalidates its tag.
 */
export function getStartup(slug: string): Promise<PublicStartup | null> {
  return unstable_cache(
    async () => {
      const { data, error } = await serviceClient()
        .from("startups").select(COLUMNS).eq("slug", slug).neq("status", "rejected").maybeSingle();
      if (error) throw new Error(`startup read: ${error.message}`);
      return data ? toPublic(data as Row) : null;
    },
    ["startup", slug],
    { tags: [tagFor(slug)], revalidate: 3600 },
  )();
}

/** Every approved startup, oldest first (by order number). Feeds the Hall of Fame. */
export const listApproved = unstable_cache(
  async (): Promise<PublicStartup[]> => {
    const { data, error } = await serviceClient()
      .from("startups").select(COLUMNS).eq("status", "approved")
      .order("order_number", { ascending: true }).limit(SALON_MAX);
    if (error) throw new Error(`salon read: ${error.message}`);
    return (data as Row[]).map(toPublic);
  },
  ["salon-list"],
  { tags: [SALON_TAG], revalidate: 300 },
);

/** Call after any change to a startup. Pages refresh on their next visit. */
export function invalidate(slug: string) {
  revalidateTag(tagFor(slug), { expire: 0 });
  revalidateTag(SALON_TAG, "max");
}
