"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { categoryLabel, type PublicStartup } from "@/lib/startups/model";
import { prepareLogo } from "@/lib/flag/texture";
import { Downloads, ShareButtons } from "./Share";
import Toolbar, { usePause } from "./Toolbar";
import { loadImage, useDockInset, usePairScene } from "./usePairScene";
import Icon from "./Icon";

const SITE = (process.env.NEXT_PUBLIC_SITE_URL || "https://flag.ar").replace(/\/$/, "");

/** flag.ar/<slug>: both poles, the startup's data, share, downloads, a change request, and report. */
export default function StartupView({ startup }: { startup: PublicStartup }) {
  const holder = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const togglePauseRef = useRef<() => void>(() => {});
  const { scene, webgl } = usePairScene(holder, () => togglePauseRef.current());
  const { paused, togglePause } = usePause(scene);
  togglePauseRef.current = togglePause;
  const [panel, setPanel] = useState<"none" | "downloads" | "report">("none");
  useDockInset(dock, scene, !!webgl);
  const url = `${SITE}/${startup.slug}`;

  // Hoist the startup flag once its logo is in, so it never rises blank.
  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    let cancelled = false;
    const show = (logo: HTMLCanvasElement | null) => {
      if (cancelled) return;
      s.setStartup(logo, startup.bgColor, startup.name);
      s.hoistTo(1, 2);
    };
    if (!startup.logoUrl) show(null);
    else loadImage(startup.logoUrl).then((img) => show(prepareLogo(img).logo)).catch(() => show(null));
    return () => {
      cancelled = true;
    };
  }, [scene, webgl, startup]);

  return (
    <main className="stage">
      <div ref={holder} className="flag-holder" />
      <Link className="corner-link" href="/" aria-label="Salón de la Fama" title="Salón de la Fama"><Icon name="hall" size={15} /></Link>
      <Link className="corner-link right" href="/izar" aria-label="Izá la tuya" title="Izá la tuya"><Icon name="plus" size={15} /></Link>

      <div className="dock open" ref={dock}>
        <section className="startup" aria-labelledby="startup-name">
          <div className="startup-id">
            <p className="startup-trail">
              <span>Bandera #{startup.order}</span>
              {categoryLabel(startup.category) && <span>· {categoryLabel(startup.category)}</span>}
              {startup.status === "pending" && <span className="pill">En revisión para el salón</span>}
            </p>
            <h1 id="startup-name" className="startup-name">{startup.name}</h1>
            <div className="startup-links">
              <a className="startup-cta" href={startup.link} target="_blank" rel="noopener noreferrer nofollow">
                {startup.domain.startsWith("x.com/") ? `@${startup.domain.slice(6)}` : startup.domain}
              </a>
            </div>
          </div>
          <div className="startup-side">
            <ShareButtons name={startup.name} order={startup.order} url={url} />
            <p className="startup-actions">
              {webgl && (
                <button
                  type="button" className="linklike" aria-expanded={panel === "downloads"}
                  onClick={() => setPanel(panel === "downloads" ? "none" : "downloads")}
                >Descargas</button>
              )}
              <Link className="linklike" href={`/${startup.slug}/editar`} prefetch={false}>Pedir un cambio</Link>
              <button
                type="button" className="linklike" aria-expanded={panel === "report"}
                onClick={() => setPanel(panel === "report" ? "none" : "report")}
              >Reportar</button>
            </p>
          </div>
          {panel !== "none" && (
            <div className="reveal" key={panel}>
              {panel === "downloads" && <Downloads scene={scene} slug={startup.slug} />}
              {panel === "report" && <ReportForm id={startup.id} />}
            </div>
          )}
        </section>
        <Toolbar scene={scene} webgl={webgl} paused={paused} togglePause={togglePause} fileName={`flagar-${startup.slug}.png`} />
      </div>
    </main>
  );
}

export function ReportForm({ id }: { id: string }) {
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mini-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const res = await fetch("/api/startups/report", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, reason }),
        }).catch(() => null);
        const body = (await res?.json().catch(() => ({}))) as { message?: string } | undefined;
        setMsg(body?.message ?? "Error de red.");
        setBusy(false);
      }}
    >
      <label className="field">
        <span>¿Qué está mal? (opcional)</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Logo ajeno, contenido ofensivo…" />
      </label>
      <button className="btn" disabled={busy || !!msg}>Reportar</button>
      {msg && <p role="status">{msg}</p>}
    </form>
  );
}
