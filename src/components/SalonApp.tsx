"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SalonScene } from "@/lib/flag/salon";
import { CATEGORIES, categoryLabel, type PublicStartup } from "@/lib/startups/model";
import { saveBlob } from "@/lib/flag/downloads";
import { xIntent } from "./Share";
import Icon from "./Icon";

const POLL_MS = 30_000;

function normalize(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Home, the Hall of Fame: a 3D walk (a plain list without WebGL2). Clicking a flag opens its pair page. */
export default function SalonApp({ initial }: { initial: PublicStartup[] }) {
  const holder = useRef<HTMLDivElement>(null);
  const scene = useRef<SalonScene | null>(null);
  const [all, setAll] = useState(initial);
  const [view, setView] = useState<"3d" | "grid" | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<PublicStartup | null>(null);
  // The card keeps showing the last flag while it animates out after `picked` clears.
  const [shown, setShown] = useState<PublicStartup | null>(null);
  if (picked && picked !== shown) setShown(picked);
  const router = useRouter();

  // Fallback: unmount the closing card even if animationend never fires.
  useEffect(() => {
    if (picked || !shown) return;
    const t = setTimeout(() => setShown(null), 400);
    return () => clearTimeout(t);
  }, [picked, shown]);

  // Always the 3D walk. Without WebGL2 the scene cannot run, so a plain list of links stands in.
  useEffect(() => {
    let webgl = false;
    try {
      webgl = !!document.createElement("canvas").getContext("webgl2");
    } catch {
      webgl = false;
    }
    setView(webgl ? "3d" : "grid");
  }, []);

  // Dev only: /?demo=2000 fills the avenue with sample logos, to test the 3D cost at scale.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const n = Number(new URLSearchParams(location.search).get("demo"));
    if (!n) return;
    fetch("/sample/manifest.json").then((r) => r.json()).then((m: { logos: { id: string; image: string; name?: string; domain: string; location?: string }[] }) => {
      const colors = ["#5b3fa8", "#b02a6e", "#1f8a5b", "#c8322b", "#2f5fc4", "#d9a020", "#e0601e", "#1e8f99", "#ffffff", "#0b1f3a"];
      setAll(Array.from({ length: n }, (_, i) => {
        const l = m.logos[i % m.logos.length];
        const d = new Date(Date.now() - (n - i) * 3_600_000).toISOString();
        return {
          id: `demo-${i}`, slug: `demo-${i}`, name: `${l.name ?? l.domain} ${i + 1}`, city: null, category: CATEGORIES[i % (CATEGORIES.length - 1)].key,
          link: `https://${l.domain}`, domain: `${i}.${l.domain}`, logoUrl: `/sample/${l.image}`, bgColor: colors[i % colors.length],
          order: i + 1, status: "approved", featured: i % 97 === 3, createdAt: d, approvedAt: d,
        } satisfies PublicStartup;
      }));
    });
  }, []);

  // Live counter: the list refreshes from the CDN-cached endpoint.
  useEffect(() => {
    if (new URLSearchParams(location.search).has("demo")) return;
    const t = setInterval(() => {
      fetch("/api/salon").then((r) => (r.ok ? r.json() : null)).then((d) => d?.startups && setAll(d.startups)).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
  }, []);

  const q = normalize(query.trim());
  const matches = useMemo(
    () => (q ? all.filter((s) => normalize(s.name).includes(q) || s.domain.includes(q) || normalize(categoryLabel(s.category) ?? "").includes(q)) : all),
    [all, q],
  );

  // 3D scene: built once, fed the whole list. Search highlights; it never moves flags around.
  useEffect(() => {
    if (view !== "3d" || !holder.current) return;
    let s: SalonScene | null = null;
    let cancelled = false;
    import("@/lib/flag/salon").then((mod) => {
      if (cancelled || !holder.current) return;
      s = new mod.SalonScene(holder.current, {
        onSelect: (i) => setPicked(i === null ? null : listRef.current[i] ?? null),
        onPlaceholder: () => router.push("/izar"),
      });
      s.setStartups(listRef.current);
      scene.current = s;
    });
    return () => {
      cancelled = true;
      s?.dispose();
      scene.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  const listRef = useRef(all);
  listRef.current = all;
  const layoutKey = all.map((s) => s.id).join(",");
  useEffect(() => {
    scene.current?.setStartups(listRef.current);
  }, [layoutKey]);

  // Search results fly to the flag in 3D (its card opens on arrival). The fallback list opens the page.
  function go(s: PublicStartup) {
    const i = all.findIndex((x) => x.id === s.id);
    if (view === "3d" && i >= 0) scene.current?.focus(i);
    else router.push(`/${s.slug}`);
  }

  // Search in 3D: one match flies straight to it; several glow, and the camera flies to the nearest.
  // No query: nothing glows.
  const matchKey = matches.map((s) => s.id).join(",");
  useEffect(() => {
    const s = scene.current;
    if (view !== "3d" || !s) return;
    if (!q) {
      s.setHighlight([]);
      return;
    }
    const ids = new Set(matches.map((m) => m.id));
    const indices = all.flatMap((x, i) => (ids.has(x.id) ? [i] : []));
    if (indices.length === 1) s.focus(indices[0]);
    else if (indices.length > 1) s.focusAny(indices);
    else s.setHighlight([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey, view]);

  async function wallpaper() {
    const s = scene.current;
    if (!s) return;
    saveBlob(await s.snapshot(3840, 2160), `flagar-salon${picked ? `-${picked.slug}` : ""}.jpg`);
  }

  const tweet = xIntent(
    `${query.trim()} todavía no flamea en el Salón de la Fama de las startups argentinas. ¿La izás? 🇦🇷 #FlagAR`,
    "https://flag.ar",
  );

  return (
    <main className={`salon${view === "grid" ? " grid-mode" : ""}`}>
      {view === "3d" && <div ref={holder} className="salon-holder" />}

      <header className="salon-bar">
        <h1 className="salon-count" aria-live="polite">
          <strong>{all.length.toLocaleString("es-AR")}</strong> startups
        </h1>
        <label className="search">
          <Icon name="search" size={13} />
          <input
            type="search" placeholder="Buscar" value={query} onChange={(e) => setQuery(e.target.value)}
            aria-label="Buscar startup"
          />
        </label>
        <Link href="/izar" className="bare-btn" aria-label="Izá tu bandera" title="Izá tu bandera">
          <Icon name="plus" size={15} />
        </Link>
      </header>

      {/* Empty hall: one quiet invitation instead of a field of ads. */}
      {all.length === 0 && !q && (
        <div className="salon-empty" role="status">
          <p>Todavía no flamea ninguna. Sé la primera startup en izar su bandera.</p>
          <Link href="/izar" className="btn primary">Izar bandera</Link>
        </div>
      )}

      {q && matches.length === 0 && (
        <div className="empty-search" role="status">
          <p>Todavía no flamea.</p>
          <a className="text-link" href={tweet} target="_blank" rel="noopener noreferrer">Avisale</a>
        </div>
      )}

      {q && matches.length > 1 && view === "3d" && (
        <ul className="results">
          {matches.slice(0, 8).map((s) => (
            <li key={s.id}><button type="button" onClick={() => go(s)}>{s.name}</button></li>
          ))}
        </ul>
      )}

      {view === "3d" && shown && (
        <aside
          className="salon-card" aria-labelledby="salon-card-name" data-state={picked ? "open" : "closing"}
          onAnimationEnd={(e) => { if (!picked && e.target === e.currentTarget) setShown(null); }}
        >
          <button type="button" className="bare-btn salon-card-close" onClick={() => setPicked(null)} aria-label="Cerrar">
            <Icon name="close" size={13} />
          </button>
          {/* Keyed by flag: picking another one swaps the content in place while the card stays. */}
          <div className="salon-card-body" key={shown.id}>
            <h2 id="salon-card-name">{shown.name}</h2>
            <a className="salon-card-link" href={shown.link} target="_blank" rel="noopener noreferrer">{shown.domain}</a>
            <div className="salon-card-actions">
              <Link className="text-link" href={`/${shown.slug}`}>Ver bandera</Link>
              <button type="button" className="text-link" onClick={wallpaper}>Fondo 4K</button>
            </div>
          </div>
        </aside>
      )}

      {view === "grid" && (
        <section className="salon-grid">
          <Cards list={matches} />
        </section>
      )}
    </main>
  );
}

// Real links: crawlers follow them and visitors can open a flag in a new tab.
function Cards({ list }: { list: PublicStartup[] }) {
  return (
    <ul className="cards">
      {list.map((s, i) => (
        <li key={s.id} style={{ "--i": i } as React.CSSProperties}>
          <Link className="card" href={`/${s.slug}`} prefetch={false}>
            <span className="mini-flag" style={{ background: s.bgColor }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {s.logoUrl && <img src={s.logoUrl} alt="" loading="lazy" decoding="async" />}
            </span>
            <span className="card-name">{s.name}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
