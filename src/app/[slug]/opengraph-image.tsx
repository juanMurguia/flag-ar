import { ImageResponse } from "next/og";
import sharp from "sharp";
import { argentineFlagDataUrl } from "@/lib/flag/flagSvg";
import { getStartup } from "@/lib/server/startups";
import { BUCKET_PUBLIC, serviceClient } from "@/lib/server/supabase";
import { isValidSlug } from "@/lib/startups/model";

export const alt = "La bandera de la startup al lado de la bandera argentina";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
// Cached like the page: rebuilt at most hourly, or when an edit invalidates the startup's tag.
export const revalidate = 3600;

// No pages at build time; each one renders on its first visit, then stays cached (ISR).
export async function generateStaticParams() {
  return [];
}

const FLAG_W = 430, FLAG_H = Math.round((430 * 9) / 14);

/** Logo as a small PNG data URL. Read from storage directly: no request back to our own domain. */
async function logoDataUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data } = await serviceClient().storage.from(BUCKET_PUBLIC).download(path);
  if (!data) return null;
  const png = await sharp(Buffer.from(await data.arrayBuffer()))
    .resize(400, 400, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

function Pole({ height }: { height: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 18 }}>
      <div style={{ width: 18, height: 18, borderRadius: 9, background: "linear-gradient(135deg, #f5d27a, #b8871f)" }} />
      <div style={{ width: 7, height, background: "linear-gradient(90deg, #8d929c, #eef0f3, #9aa0aa)" }} />
    </div>
  );
}

function Flag({ children, bg, shadow }: { children?: React.ReactNode; bg?: string; shadow?: boolean }) {
  return (
    <div
      style={{
        display: "flex", width: FLAG_W, height: FLAG_H, background: bg ?? "transparent", alignItems: "center",
        justifyContent: "center", borderRadius: 4, marginTop: 6,
        boxShadow: shadow ? "0 18px 40px rgba(30, 16, 50, 0.35)" : undefined,
      }}
    >
      {children}
    </div>
  );
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = isValidSlug(slug) ? await getStartup(slug) : null;
  const logo = s ? await logoDataUrl(s.logoUrl?.replace(/^\/files\//, "") ?? null).catch(() => null) : null;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center",
          background: "radial-gradient(ellipse at 50% 45%, #fff1d6 0%, #f6c78f 18%, #d99aa6 42%, #6f62a3 75%, #2a2b62 100%)",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 44, marginTop: 52 }}>
          {/* Startup on the observer's left, a little lower. Argentina on the right, higher. */}
          <div style={{ display: "flex", marginTop: 34 }}>
            <Pole height={360} />
            <Flag bg={s?.bgColor ?? "#ffffff"} shadow>
              {logo && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logo} alt="" style={{ maxWidth: FLAG_W * 0.6, maxHeight: FLAG_H * 0.6, objectFit: "contain" }} />
              )}
            </Flag>
          </div>
          <div style={{ display: "flex" }}>
            <Pole height={394} />
            <Flag shadow>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={argentineFlagDataUrl()} alt="" width={FLAG_W} height={FLAG_H} />
            </Flag>
          </div>
        </div>
        <div
          style={{
            position: "absolute", bottom: 34, left: 0, right: 0, display: "flex", justifyContent: "center",
            alignItems: "baseline", gap: 18, color: "#fff4e4",
          }}
        >
          <span style={{ fontSize: 54, fontWeight: 800, letterSpacing: -1 }}>{s?.name ?? "flag.ar"}</span>
          {s && <span style={{ fontSize: 30, opacity: 0.85 }}>Bandera #{s.order}</span>}
          <span style={{ fontSize: 26, opacity: 0.7 }}>flag.ar</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
