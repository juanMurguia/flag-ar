"use client";

import { useState, type RefObject } from "react";
import type { PairScene } from "@/lib/flag/scene";
import { PRESETS, freeRect, saveBlob } from "@/lib/flag/downloads";
import Icon from "./Icon";

export function shareText(name: string, order: number) {
  return `${name} ya flamea en flag.ar 🇦🇷 Bandera #${order}. Izá la tuya. #FlagAR`;
}

export function xIntent(text: string, url: string) {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
}

/** LinkedIn's feed composer takes prefilled text (the old share-offsite URL ignores it). */
export function linkedInIntent(text: string, url: string) {
  return `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(`${text} ${url}`)}`;
}

export function ShareButtons({ name, order, url }: { name: string; order: number; url: string }) {
  const [copied, setCopied] = useState(false);
  const text = shareText(name, order);
  return (
    <div className="share">
      <a className="text-link" href={xIntent(text, url)} target="_blank" rel="noopener noreferrer">X</a>
      <a className="text-link" href={linkedInIntent(text, url)} target="_blank" rel="noopener noreferrer">LinkedIn</a>
      <button
        className="text-link" type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            // Clipboard blocked: the link is visible next to the button anyway.
          }
        }}
      >
        <span className="swap" key={String(copied)}>{copied ? "Copiado" : "Link"}</span>
      </button>
    </div>
  );
}

/** Downloads: rendered offscreen at full size from the live scene, with a small flag.ar watermark. */
export function Downloads({ scene, slug }: { scene: RefObject<PairScene | null>; slug: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(id: string, job: (s: PairScene) => Promise<void>) {
    const s = scene.current;
    if (!s || busy) return;
    setBusy(id);
    setError(null);
    try {
      await job(s);
    } catch (e) {
      setError((e as Error).message || "No se pudo generar el archivo.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="downloads">
      <p className="downloads-title">Descargas</p>
      <div className="downloads-grid">
        {PRESETS.map((p) => (
          <button
            key={p.id} type="button" className="btn ghost dl" disabled={!!busy} aria-busy={busy === p.id}
            onClick={() => run(p.id, async (s) => saveBlob(await s.poster(p.w, p.h, freeRect(p)), `flagar-${slug}-${p.id}.jpg`))}
          >
            {busy === p.id ? <span className="spinner" aria-hidden="true" /> : <Icon name="download" size={15} />}
            <span>{p.label}</span>
            <small>{p.w}×{p.h}</small>
          </button>
        ))}
        <button
          type="button" className="btn ghost dl" disabled={!!busy} aria-busy={busy === "video"}
          onClick={() => run("video", async (s) => {
            const { blob, ext } = await s.recordLoop();
            saveBlob(blob, `flagar-${slug}.${ext}`);
          })}
        >
          {busy === "video" ? <span className="spinner" aria-hidden="true" /> : <Icon name="video" size={15} />}
          <span>{busy === "video" ? "Grabando 4 s…" : "Video en loop"}</span>
          <small>4 s</small>
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
