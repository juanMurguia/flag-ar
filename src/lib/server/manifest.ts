import "server-only";
import type { Manifest } from "@/lib/flag/layout";
import { BUCKET_PUBLIC, serviceClient } from "./supabase";

/**
 * Rebuilds manifest.json from the logos table. Slot order follows approved_at:
 * the first approved logo takes the slot nearest the sun.
 * It reads the whole table each time, so a later call always fixes an earlier stale write.
 */
export async function rebuildManifest(): Promise<Manifest> {
  const db = serviceClient();
  const { data, error } = await db
    .from("logos")
    .select("id, domain, website_url, image_path, approved_at")
    .order("approved_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw new Error(`manifest read failed: ${error.message}`);

  const manifest: Manifest = {
    version: 1,
    updated_at: new Date().toISOString(),
    logos: (data ?? []).map((r) => ({
      id: r.id as string,
      domain: r.domain as string,
      url: r.website_url as string,
      image: r.image_path as string,
    })),
  };
  const { error: upErr } = await db.storage
    .from(BUCKET_PUBLIC)
    .upload("manifest.json", JSON.stringify(manifest), {
      contentType: "application/json",
      upsert: true,
      cacheControl: "30", // short: an approval shows on the flag within seconds
    });
  if (upErr) throw new Error(`manifest write failed: ${upErr.message}`);
  return manifest;
}
