"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import HoistPanel from "./HoistPanel";
import type { SalonFx, SalonScene } from "@/lib/flag/salon";
import { CATEGORIES, categoryLabel, type PublicStartup } from "@/lib/startups/model";
import { saveBlob } from "@/lib/flag/downloads";
import { Ambience } from "@/lib/flag/ambience";
import { xIntent } from "./Share";
import Icon from "./Icon";

const POLL_MS = 30_000;
const FX_KEY = "flagar-hq";

// One switch for visitors: they know "looks better" vs "runs smoother", not AO or bloom.
// God rays only in high quality: the sun is in view, low, and its rays warm the air around it.
const FX_HIGH: SalonFx = { ao: true, bloom: true, godRays: true, hd: true };
const FX_LOW: SalonFx = { ao: false, bloom: false, godRays: false, hd: false };
const SOUND_KEY = "flagar-sound";
const UI_IDLE_MS = 4000;

function savedHigh(): boolean | null {
  try {
    const v = localStorage.getItem(FX_KEY);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
}

/** Sound is on unless the visitor muted it before. */
function savedSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "0";
  } catch {
    return true;
  }
}

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
  // High quality: null until the scene picks its device default. A saved choice wins over the default.
  const [high, setHigh] = useState<boolean | null>(null);
  const highRef = useRef(high); // latest value, so fast repeated clicks never toggle from a stale state
  highRef.current = high;
  // Sound: wind and a low drone. Browsers allow audio only after a gesture, so it starts on the first
  // click, tap or key press anywhere (except the sound button itself, which decides on its own).
  const [sound, setSound] = useState(true);
  const soundRef = useRef(sound);
  const ambience = useRef<Ambience | null>(null);
  useEffect(() => {
    if (view !== "3d") return;
    const a = new Ambience();
    ambience.current = a;
    soundRef.current = savedSound();
    setSound(soundRef.current);
    const first = (e: Event) => {
      if ((e.target as Element | null)?.closest?.("[data-sound]")) return;
      window.removeEventListener("pointerdown", first);
      window.removeEventListener("keydown", first);
      if (soundRef.current) a.start();
    };
    // A hidden tab goes quiet, and comes back when the visitor returns.
    const vis = () => {
      if (!soundRef.current) return;
      if (document.hidden) a.stop();
      else if (navigator.userActivation?.hasBeenActive) a.start();
    };
    window.addEventListener("pointerdown", first);
    window.addEventListener("keydown", first);
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("pointerdown", first);
      window.removeEventListener("keydown", first);
      document.removeEventListener("visibilitychange", vis);
      a.dispose();
      ambience.current = null;
    };
  }, [view]);
  const [picked, setPicked] = useState<PublicStartup | null>(null);
  // The card keeps showing the last flag while it animates out after `picked` clears.
  const [shown, setShown] = useState<PublicStartup | null>(null);
  if (picked && picked !== shown) setShown(picked);
  const router = useRouter();

  // Hoisting happens here, in the hall: the camera flies to an empty pole and the sheet slides in beside it.
  // The URL becomes /izar (a real page on reload), so Back closes the sheet. "closing" keeps it mounted
  // while it slides out.
  const pathname = usePathname();
  const [hoist, setHoist] = useState<"open" | "closing" | "closed">("closed");
  const hoistSlot = useRef<number | undefined>(undefined);
  const instantClose = useRef(false);
  const openHoist = useCallback((slot?: number) => {
    const s = scene.current;
    if (!s) {
      router.push("/izar"); // no 3D (or not ready yet): the standalone page
      return;
    }
    hoistSlot.current = slot;
    setPicked(null);
    if (location.pathname === "/izar") s.claimSlot(slot); // already open: another empty pole takes the flag
    else history.pushState(null, "", "/izar");
  }, [router]);
  const openRef = useRef(openHoist);
  openRef.current = openHoist;
  // Keyboard closes (Escape) skip the exit animation: they repeat often and must feel instant.
  const closeHoist = useCallback((instant?: boolean) => {
    instantClose.current = !!instant;
    history.back();
  }, []);
  const hoistClosed = useCallback(() => setHoist((h) => (h === "closing" ? "closed" : h)), []);

  // The URL drives the sheet, so Back and Forward work like a page change.
  useEffect(() => {
    const s = scene.current;
    if (pathname === "/izar") {
      if (!s) return;
      if (hoist !== "open") {
        s.claimSlot(hoistSlot.current);
        setHoist("open");
      }
    } else if (hoist === "open") {
      s?.release(); // the world glides back while the sheet slides out
      setHoist(instantClose.current ? "closed" : "closing");
      instantClose.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    if (hoist !== "open") return;
    const title = document.title;
    document.title = "Izá tu bandera · flag.ar";
    return () => {
      document.title = title;
    };
  }, [hoist]);

  // Plain clicks open the sheet in place. Modified clicks (new tab) and the no-3D list follow the link.
  function onHoistLink(e: React.MouseEvent) {
    if (!scene.current || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openHoist();
  }

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
      const startHigh = savedHigh() ?? mod.defaultFx().ao;
      s = new mod.SalonScene(holder.current, {
        onSelect: (i) => setPicked(i === null ? null : listRef.current[i] ?? null),
        onPlaceholder: (slot) => openRef.current(slot),
        onFx: () => setHigh(false), // auto drop on a slow GPU: shown, not saved
      }, startHigh ? FX_HIGH : FX_LOW);
      setHigh(startHigh);
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

  function toggleQuality() {
    if (highRef.current === null) return;
    const next = !highRef.current;
    highRef.current = next;
    setHigh(next);
    scene.current?.setFx(next ? FX_HIGH : FX_LOW);
    try {
      localStorage.setItem(FX_KEY, next ? "1" : "0");
    } catch {}
  }

  function toggleSound() {
    const next = !soundRef.current;
    soundRef.current = next;
    setSound(next);
    if (next) ambience.current?.start();
    else ambience.current?.stop();
    try {
      localStorage.setItem(SOUND_KEY, next ? "1" : "0");
    } catch {}
  }

  async function wallpaper() {
    const s = scene.current;
    if (!s) return;
    saveBlob(await s.snapshot(3840, 2160), `flagar-salon${picked ? `-${picked.slug}` : ""}.jpg`);
  }

  const tweet = xIntent(
    `${query.trim()} todavía no flamea en el Salón de la Fama de las startups argentinas. ¿La izás? 🇦🇷 #FlagAR`,
    "https://flag.ar",
  );

  // Calm UI: in the 3D walk, the bar and the corner fade out after a few seconds without input, so the
  // view reads as a film still. Any pointer move, touch, wheel, or key brings them back. They stay while
  // the visitor is busy with them: a query typed, a card or the hoist sheet open, or focus inside.
  const [uiIdle, setUiIdle] = useState(false);
  const busy = view !== "3d" || !!query || !!picked || hoist !== "closed";
  useEffect(() => {
    if (busy) {
      setUiIdle(false);
      return;
    }
    let t = 0;
    const wake = () => {
      setUiIdle(false);
      clearTimeout(t);
      t = window.setTimeout(() => {
        if (!document.activeElement?.closest(".salon-bar, .salon-corner")) setUiIdle(true);
      }, UI_IDLE_MS);
    };
    const events = ["pointermove", "pointerdown", "wheel", "keydown"] as const;
    for (const e of events) window.addEventListener(e, wake, { passive: true });
    wake();
    return () => {
      clearTimeout(t);
      for (const e of events) window.removeEventListener(e, wake);
    };
  }, [busy]);

  return (
    <main className={`salon${view === "grid" ? " grid-mode" : ""}${hoist === "open" ? " hoisting" : ""}${uiIdle ? " ui-idle" : ""}`}>
      {view === "3d" && <div ref={holder} className="salon-holder" />}

      {/* One row: count, search, hoist. Every control is 28 px on a 4 px rhythm. */}
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

        {/* Empty hall: the hoist button grows into the invitation, so the row stays one line. */}
        {all.length === 0 && !q ? (
          <Link href="/izar" className="bar-cta" onClick={onHoistLink} aria-expanded={hoist === "open"}>
            <Icon name="plus" size={13} />
            <span>Izá la primera</span>
          </Link>
        ) : (
          <Link
            href="/izar" className="bar-btn" aria-label="Izá tu bandera" title="Izá tu bandera" onClick={onHoistLink}
            aria-expanded={hoist === "open"}
          >
            <Icon name="plus" size={14} />
          </Link>
        )}
      </header>

      {/* Quality lives apart from navigation: its own pill in the top-right corner. */}
      {high !== null && (
        <div className="salon-corner">
          <button
            type="button" className="bar-btn" data-sound aria-pressed={sound} onClick={toggleSound}
            aria-label="Sonido" title={sound ? "Silenciar" : "Activar sonido"}
          >
            <Icon name={sound ? "sound" : "mute"} size={14} />
          </button>
          <button
            type="button" className="bar-btn hd-btn" aria-pressed={high} onClick={toggleQuality}
            aria-label="Calidad HD" title={high ? "HD activado" : "HD apagado: más fluido"}
          >
            HD
          </button>
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

      {view === "3d" && hoist !== "closed" && (
        <HoistPanel scene={scene} webgl closing={hoist === "closing"} onClose={closeHoist} onClosed={hoistClosed} />
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
