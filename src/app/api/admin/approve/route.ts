import sharp from "sharp";
import { notFound, requireAdmin } from "@/lib/server/adminAuth";
import { alert } from "@/lib/server/alerts";
import { sameOrigin } from "@/lib/server/csrf";
import { rebuildManifest } from "@/lib/server/manifest";
import { BUCKET_PENDING, BUCKET_PUBLIC, serviceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Decodes the quarantined file and writes a clean 512 px PNG. Metadata is dropped. */
async function reencode(input: Buffer): Promise<Buffer> {
  return sharp(input, { limitInputPixels: 4096 * 4096, failOn: "error", animated: false })
    .rotate()
    .resize(512, 512, { fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return notFound();
  const auth = await requireAdmin();
  if (!auth.ok) return notFound();

  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id || !UUID.test(id)) return Response.json({ message: "Bad id." }, { status: 400 });

  const db = serviceClient();
  const { data: row, error } = await db
    .from("logo_requests").select("id, status, file_path").eq("id", id).maybeSingle();
  if (error) return Response.json({ message: error.message }, { status: 500 });
  if (!row || row.status !== "pending" || !row.file_path) {
    return Response.json({ message: "This request is not pending." }, { status: 409 });
  }

  const { data: blob, error: dlErr } = await db.storage.from(BUCKET_PENDING).download(row.file_path);
  if (dlErr || !blob) return Response.json({ message: "Could not read the pending file." }, { status: 500 });

  let png: Buffer;
  try {
    png = await reencode(Buffer.from(await blob.arrayBuffer()));
  } catch {
    return Response.json({ message: "The image could not be decoded. Deny this request." }, { status: 422 });
  }

  // File first. If the write fails, the status does not change.
  const imagePath = `${id}.png`;
  const { error: upErr } = await db.storage.from(BUCKET_PUBLIC).upload(imagePath, png, {
    contentType: "image/png",
    cacheControl: "31536000", // names are unique, so the file never changes
    upsert: true,
  });
  if (upErr) return Response.json({ message: `Could not write the public file: ${upErr.message}` }, { status: 500 });

  // Status change and logos row in one transaction.
  const { data: done, error: txErr } = await db.rpc("approve_request_tx", {
    p_id: id, p_image_path: imagePath, p_admin: auth.user.id,
  });
  if (txErr || done !== true) {
    // A second approve (double click, two tabs) lands here after the first one won.
    // Delete the file only if the logo is not live, or the flag loses a live logo.
    const { data: live, error: liveErr } = await db.from("logos").select("id").eq("id", id).maybeSingle();
    if (!liveErr && !live) await db.storage.from(BUCKET_PUBLIC).remove([imagePath]);
    return Response.json({ message: txErr?.message || "This request is not pending." }, { status: 409 });
  }

  // The public copy is the re-encoded one. The quarantined original is no longer needed.
  await db.storage.from(BUCKET_PENDING).remove([row.file_path]);
  await db.from("logo_requests").update({ file_path: null }).eq("id", id);

  try {
    await rebuildManifest();
  } catch (e) {
    await alert("manifest", `Manifest rebuild failed after approval: ${(e as Error).message}`, 900);
    return Response.json({ message: "Approved. The manifest update failed; the hourly job retries it." });
  }
  return Response.json({ message: "Approved." });
}
