import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { alert } from "./alerts";
import { checkNsfw } from "./nsfw";
import { invalidate } from "./startups";
import { BUCKET_PUBLIC, serviceClient } from "./supabase";

export const LOGO_MAX_BYTES = 1024 * 1024;
const LOGO_SIDE = 1024;

/**
 * Decodes the upload and writes a clean PNG: metadata dropped, empty border trimmed, at most 1024 px.
 * The browser already removed the background and trimmed; the server does it again because
 * a client can send anything. Throws when the file is not a decodable image.
 */
export async function reencodeLogo(input: Uint8Array): Promise<{ png: Buffer; hash: string }> {
  const png = await sharp(input, { limitInputPixels: 4096 * 4096, failOn: "error", animated: false })
    .rotate()
    .ensureAlpha()
    .trim({ threshold: 1 })
    .resize(LOGO_SIDE, LOGO_SIDE, { fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { png, hash: createHash("sha256").update(png).digest("hex") };
}

/** Public object name. The version in the name lets the CDN cache each file forever. */
export function logoPath(id: string, version: number) {
  return `s/${id}-${version}.png`;
}

export async function storeLogo(path: string, png: Buffer) {
  const { error } = await serviceClient().storage.from(BUCKET_PUBLIC).upload(path, png, {
    contentType: "image/png",
    cacheControl: "31536000",
    upsert: false,
  });
  if (error) throw new Error(`storage: ${error.message}`);
}

/**
 * Runs the NSFW model on a stored logo. An unsafe logo is taken down at once:
 * status rejected, file deleted, page gone. Runs after the response, so errors only alert.
 */
export async function moderateLogo(id: string, slug: string, path: string, png: Buffer) {
  const db = serviceClient();
  try {
    const r = await checkNsfw(png);
    if (!r.unsafe) {
      await db.from("startups").update({ nsfw_score: r.score }).eq("id", id);
      return;
    }
    await db.from("startups").update({
      nsfw_score: r.score, status: "rejected", logo_path: null,
      reject_reason: "Filtro automático NSFW", reviewed_at: new Date().toISOString(),
    }).eq("id", id);
    await db.storage.from(BUCKET_PUBLIC).remove([path]);
    invalidate(slug);
    await alert(`nsfw:${id}`, `NSFW filter took down /${slug} (score ${r.score.toFixed(2)}).`, 60);
  } catch (e) {
    console.error("[nsfw]", e);
    await alert("nsfw-failed", `NSFW check failed: ${(e as Error).message}. The cron job retries.`, 900);
  }
}
