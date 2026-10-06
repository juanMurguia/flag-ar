import { notFound, requireAdmin } from "@/lib/server/adminAuth";
import { alert } from "@/lib/server/alerts";
import { sameOrigin } from "@/lib/server/csrf";
import { rebuildManifest } from "@/lib/server/manifest";
import { BUCKET_PUBLIC, serviceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  if (!sameOrigin(req)) return notFound();
  const auth = await requireAdmin();
  if (!auth.ok) return notFound();

  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id || !UUID.test(id)) return Response.json({ message: "Bad id." }, { status: 400 });

  const db = serviceClient();
  const { data: imagePath, error } = await db.rpc("remove_logo_tx", { p_id: id, p_admin: auth.user.id });
  if (error) return Response.json({ message: error.message }, { status: 500 });
  if (!imagePath) return Response.json({ message: "This logo is not live." }, { status: 409 });

  // Rebuild first so the flag stops naming the file, then delete the file.
  try {
    await rebuildManifest();
  } catch (e) {
    await alert("manifest", `Manifest rebuild failed after removal: ${(e as Error).message}`, 900);
  }
  await db.storage.from(BUCKET_PUBLIC).remove([imagePath as string]);
  return Response.json({ message: "Removed." });
}
