"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import HoistPanel from "./HoistPanel";
import type { SalonFx, SalonScene } from "@/lib/flag/salon";
import { CATEGORIES, bySeat, categoryLabel, seatsLine, type PublicStartup } from "@/lib/startups/model";
import { saveBlob } from "@/lib/flag/downloads";
import { Ambience } from "@/lib/flag/ambience";
import { ShareButtons, xIntent } from "./Share";
import Icon from "./Icon";
import { useLikes } from "./useLikes";

const SITE = (process.env.NEXT_PUBLIC_SITE_URL || "https://flag.ar").replace(/\/$/, "");

const POLL_MS = 30_000;
const FX_KEY = "flagar-hq";

// One switch for visitors: they know "looks better" vs "runs smoother", not AO or bloom.
// God rays only in high quality: the sun is in view, low, and its rays warm the air around it.
const FX_HIGH: SalonFx = { ao: true, bloom: true, godRays: true, hd: true, cinema: true };
const FX_LOW: SalonFx = { ao: false, bloom: false, godRays: false, hd: false, cinema: false };
const SOUND_KEY = "flagar-sound";
const HINT_KEY = "flagar-hint-seen";

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
  const { liked, likesOf, toggle: toggleLike } = useLikes();
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
  // The tour also stops at the empty poles: the slot the camera stands at, with its own small card.
  const [freePick, setFreePick] = useState<number | null>(null);
  // Phones and touch screens: shorter hint, the wallpaper at phone size.
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(max-width: 640px), (pointer: coarse)");
    const on = () => setTouch(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  // Hover label: what the flag under the mouse is. It follows the mouse through a ref, not state, so a
  // mouse move does not re-render the page.
  const [hovered, setHovered] = useState<{ kind: "startup" | "placeholder"; index: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const mouse = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const move = (e: PointerEvent) => {
      mouse.current = { x: e.clientX, y: e.clientY };
      if (tipRef.current) tipRef.current.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 18}px)`;
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, []);
  // First visit: one line on how the hall works, gone at the first click, tap, wheel, or key.
  const [hint, setHint] = useState(false);
  const [ready, setReady] = useState(false); // the 3D scene shows its first frames
  const [wallpaperBusy, setWallpaperBusy] = useState(false);
  useEffect(() => {
    let seen = true;
    try {
      seen = localStorage.getItem(HINT_KEY) === "1";
    } catch {}
    if (seen) return;
    setHint(true);
    const done = () => {
      setHint(false);
      try {
        localStorage.setItem(HINT_KEY, "1");
      } catch {}
    };
    const events = ["pointerdown", "wheel", "keydown"] as const;
    for (const e of events) window.addEventListener(e, done, { once: true, passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, done);
    };
  }, []);
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
    setFreePick(null);
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
          order: i + 1, status: "approved", featured: i % 97 === 3, likes: Math.max(0, 40 - i * 3), createdAt: d, approvedAt: d,
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

  const countLabel = `${all.length.toLocaleString("es-AR")} ${all.length === 1 ? "startup" : "startups"}`;
  const q = normalize(query.trim());
  const matches = useMemo(
    // By name or by category (its label, or its key: "ai", "saas"). The domain counts as part of the name.
    () => (q ? all.filter((s) => normalize(s.name).includes(q) || s.domain.includes(q) || s.category === q || normalize(categoryLabel(s.category) ?? "").includes(q)) : all),
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
        onSelect: (i) => {
          setPicked(i === null ? null : listRef.current[i] ?? null);
          if (i !== null) setFreePick(null);
        },
        onPlaceholder: (slot) => openRef.current(slot),
        onFx: () => setHigh(false), // auto drop on a slow GPU: shown, not saved
        onHover: (t) => setHovered(t),
        onReady: () => setReady(true),
      }, startHigh ? FX_HIGH : FX_LOW);
      setHigh(startHigh);
      s.setStartups(listRef.current);
      scene.current = s;
    });
    return () => {
      cancelled = true;
      s?.dispose();
      scene.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  const listRef = useRef(all);
  listRef.current = all;
  const layoutKey = all.map((s) => s.id).join(",");
  useEffect(() => {
    scene.current?.setStartups(listRef.current);
  }, [layoutKey]);

  // Flag by flag: the arrows (on screen, and ← → on the keyboard) visit every startup in seat order (front
  // to back, left and right in turn), then every empty pole. With one startup the tour still goes somewhere:
  // the empty poles are where the next ones fly. Without a stop picked, › starts at the first one.
  const navRef = useRef<number | null>(null);
  if (picked) {
    const i = all.findIndex((x) => x.id === picked.id);
    if (i >= 0) navRef.current = i;
  }
  const freeSlots = (view === "3d" && scene.current?.emptySlots()) || [];
  if (freePick !== null && freeSlots.includes(freePick)) navRef.current = all.length + freeSlots.indexOf(freePick);
  const stops = all.length + freeSlots.length;
  const step = useCallback((d: 1 | -1) => {
    const s = scene.current;
    if (!s) return;
    const n = listRef.current.length, free = s.emptySlots(), total = n + free.length;
    if (!total) return;
    const cur = navRef.current;
    const next = cur === null ? (d > 0 ? 0 : total - 1) : (cur + d + total) % total;
    navRef.current = next;
    if (next < n) {
      setFreePick(null);
      s.focus(next);
    } else {
      setPicked(null);
      setFreePick(free[next - n]);
      s.focusSlot(free[next - n]);
    }
  }, []);
  useEffect(() => {
    if (view !== "3d" || hoist !== "closed") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      step(e.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, hoist, step]);

  // Closing a flag's card (the × or Escape) also flies back to the opening view, so the visitor never ends
  // up stranded somewhere in the hall.
  const closeCard = useCallback(() => {
    setPicked(null);
    setFreePick(null);
    navRef.current = null;
    scene.current?.home();
  }, []);
  useEffect(() => {
    if (!picked && freePick === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement | null)?.closest?.("input, textarea, select")) closeCard();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picked, freePick, closeCard]);

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
  // Likes reorder the seats: the glow moves with its flags, the camera stays.
  useEffect(() => {
    const s = scene.current;
    if (view !== "3d" || !s || !q) return;
    const ids = new Set(matches.map((m) => m.id));
    s.setHighlight(all.flatMap((x, i) => (ids.has(x.id) ? [i] : [])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

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

  // The 4K wallpaper renders many frames and grades them on the CPU: it takes several seconds.
  async function wallpaper() {
    const s = scene.current;
    const i = shown ? listRef.current.findIndex((x) => x.id === shown.id) : -1;
    if (!s || !shown || i < 0 || wallpaperBusy) return;
    setWallpaperBusy(true);
    try {
      // Phones get a phone wallpaper: their own screen shape, and a fifth of the 4K render's memory.
      if (touch) saveBlob(await s.wallpaper(i, 1170, 2532), `wallpaper-celu-${shown.slug}.jpg`);
      else saveBlob(await s.wallpaper(i, 3840, 2160), `wallpaper-4k-${shown.slug}.jpg`);
    } finally {
      setWallpaperBusy(false);
    }
  }

  const tweet = xIntent(
    `${query.trim()} todavía no flamea en el Salón de la Fama de las startups argentinas. ¿La izás? 🇦🇷 #FlagAR`,
    "https://flag.ar",
  );

  return (
    <main className={`salon${view === "grid" ? " grid-mode" : ""}${view !== "grid" && !ready ? " loading" : ""}${hoist === "open" ? " hoisting" : ""}${shown || freePick !== null ? " card-open" : ""}`}>
      {view === "3d" && <div ref={holder} className="salon-holder" />}
      {/* Until the first frames are on screen: a plain cover in the scene's own colors and a spinner, nothing
          else. The chrome waits (.salon.loading), then drops in. The cover fades out with the canvas fade-in. */}
      {view !== "grid" && (
        <div className="salon-loader" data-state={ready ? "done" : "loading"} role="status" aria-hidden={ready}>
          <span className="salon-loader-ring" aria-hidden="true" />
          <span className="sr-only">Cargando</span>
        </div>
      )}

      {/* Just the search. The count lives in its placeholder; adding a startup lives in the bottom pill. */}
      <header className="salon-bar">
        <h1 className="sr-only" aria-live="polite">Salón de la Fama: {countLabel}</h1>
        <label className="search">
          <Icon name="search" size={13} />
          <input
            type="search" placeholder={touch ? `Buscar entre ${countLabel}` : `Buscá entre ${countLabel} por nombre o categoría`} value={query}
            onChange={(e) => setQuery(e.target.value)} aria-label="Buscar startup por nombre o categoría"
          />
        </label>
      </header>
      {view === "3d" && <p className="salon-seats">{seatsLine(all.length)}</p>}
      {view !== null && !q && hoist === "closed" && <Ranking list={all} likesOf={likesOf} onPick={go} />}

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
          <button type="button" className="bare-btn salon-card-close" onClick={closeCard} aria-label="Cerrar">
            <Icon name="close" size={13} />
          </button>
          {/* Keyed by flag: picking another one swaps the content in place while the card stays. */}
          <div className="salon-card-body" key={shown.id}>
            <p className="startup-trail">
              <span>Bandera #{shown.order}</span>
              {categoryLabel(shown.category) && <span>· {categoryLabel(shown.category)}</span>}
            </p>
            <h2 id="salon-card-name">{shown.name}</h2>
            <a className="salon-card-link" href={shown.link} target="_blank" rel="noopener noreferrer nofollow">
              {shown.domain.startsWith("x.com/") ? `@${shown.domain.slice(6)}` : shown.domain}
            </a>
            {/* Like and arrows share one row: the card holds the whole flag page now, so it saves height. */}
            <div className="salon-card-row">
              <button
                type="button" className="like-btn" aria-pressed={liked.has(shown.id)} onClick={() => toggleLike(shown)}
                aria-label={liked.has(shown.id) ? `Sacar like a ${shown.name}` : `Darle like a ${shown.name}`}
                title="Más likes, más cerca de la bandera argentina"
              >
                <Icon name="heart" size={13} />
                <span>{likesOf(shown).toLocaleString("es-AR")}</span>
              </button>
              {stops > 1 && <CardNav at={(all.findIndex((x) => x.id === shown.id) + 1) || null} of={stops} step={step} />}
            </div>
            <CardDetails startup={shown}>
              <button type="button" className="text-link" onClick={wallpaper} disabled={wallpaperBusy} aria-busy={wallpaperBusy}>
                {wallpaperBusy ? <>Generando… <span className="spinner" aria-hidden="true" style={{ display: "inline-block", verticalAlign: "-2px" }} /></> : <>{touch ? "Fondo de pantalla" : "Fondo 4K"} <Icon name="download" size={12} /></>}
              </button>
            </CardDetails>
          </div>
        </aside>
      )}

      {view === "3d" && freePick !== null && !shown && hoist === "closed" && (
        <aside className="salon-card" aria-labelledby="salon-free-name" data-state="open">
          <button type="button" className="bare-btn salon-card-close" onClick={closeCard} aria-label="Cerrar">
            <Icon name="close" size={13} />
          </button>
          <div className="salon-card-body" key={`free-${freePick}`}>
            <h2 id="salon-free-name">Mástil libre</h2>
            <p className="salon-card-text">Tu startup puede flamear acá, al lado de la bandera argentina.</p>
            {stops > 1 && <CardNav at={all.length + freeSlots.indexOf(freePick) + 1} of={stops} step={step} />}
            <div className="salon-card-actions">
              <button type="button" className="nav-cta" onClick={() => openHoist(freePick)}>Izar mi bandera acá</button>
            </div>
          </div>
        </aside>
      )}

      {view === "3d" && hovered && (
        <div
          ref={tipRef} className="salon-tip" aria-hidden="true"
          style={{ transform: `translate(${mouse.current.x + 14}px, ${mouse.current.y + 18}px)` }}
        >
          {/* The outer div follows the mouse; the inner badge re-mounts per flag, so each new one pops in. */}
          {hovered.kind === "placeholder" ? (
            <div key="placeholder" className="tip-badge">
              <span className="tip-swatch tip-swatch-empty"><Icon name="plus" size={11} /></span>
              <span className="tip-name">Izá tu bandera acá</span>
            </div>
          ) : (() => {
            const s = all[hovered.index];
            if (!s) return null;
            const cat = categoryLabel(s.category);
            return (
              <div key={s.id} className="tip-badge">
                <span className="tip-swatch" style={{ background: s.bgColor }}>
                  {s.logoUrl && <img src={s.logoUrl} alt="" />}
                </span>
                <span className="tip-name">{s.name}</span>
                {cat && <span className="tip-chip">{cat}</span>}
              </div>
            );
          })()}
        </div>
      )}

      {view === "3d" && hint && hoist === "closed" && (
        <p className="salon-hint" role="status">
          {touch ? "Tocá una bandera · Arrastrá para mirar" : "Tocá una bandera para verla · Arrastrá para mirar alrededor"}
        </p>
      )}

      {/* No flag picked: the tour starts here. With a card open, its own arrows take over. */}
      {view === "3d" && !shown && freePick === null && hoist === "closed" && (
        <nav className="salon-nav" aria-label="Recorrer las banderas">
          {all.length > 0 && (
            <>
              <button type="button" className="bar-btn" onClick={() => step(-1)} aria-label="Bandera anterior">
                <Icon name="prev" size={14} />
              </button>
              <button type="button" className="salon-nav-label" onClick={() => step(1)}>Recorrer las banderas</button>
              <button type="button" className="bar-btn" onClick={() => step(1)} aria-label="Bandera siguiente">
                <Icon name="next" size={14} />
              </button>
            </>
          )}
          {/* The hall holds only a few empty poles now: this is the main way in. Same sheet as the bar's +. */}
          <Link href="/izar" className="nav-cta" onClick={onHoistLink}>
            <svg className="nav-cta-sun" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="3.2" />
              <path d="M8 .8v2.4M8 12.8v2.4M.8 8h2.4M12.8 8h2.4M2.9 2.9l1.7 1.7M11.4 11.4l1.7 1.7M2.9 13.1l1.7-1.7M11.4 4.6l1.7-1.7" />
            </svg>
            <span>Agregar mi startup</span>
          </Link>
        </nav>
      )}

      {view === "3d" && hoist !== "closed" && (
        <HoistPanel
          scene={scene} webgl taken={all.length} closing={hoist === "closing"} onClose={closeHoist} onClosed={hoistClosed}
        />
      )}

      {view === "grid" && (
        <section className="salon-grid">
          <Cards list={matches} />
        </section>
      )}
    </main>
  );
}

const RANK_SIZE = 10;
const RANK_FOLDED = 3;

/** The flag's data that used to live on its own page: share links, the wallpaper, and a change request. */
function CardDetails({ startup, children }: { startup: PublicStartup; children: React.ReactNode }) {
  return (
    <>
      <ShareButtons name={startup.name} order={startup.order} url={`${SITE}/${startup.slug}`} />
      <div className="salon-card-actions">
        {children}
        <Link className="text-link" href={`/${startup.slug}/editar`} prefetch={false}>Pedir un cambio</Link>
      </div>
    </>
  );
}

/** Top 10 by likes, small, in a corner. The top 3 always show; "Ver más" unfolds the rest. */
/** The tour's arrows inside a card: previous, "2 / 4", next. */
function CardNav({ at, of, step }: { at: number | null; of: number; step: (d: 1 | -1) => void }) {
  return (
    <div className="salon-card-nav">
      <button type="button" className="bar-btn" onClick={() => step(-1)} aria-label="Anterior">
        <Icon name="prev" size={14} />
      </button>
      <span>{at ?? "–"} / {of}</span>
      <button type="button" className="bar-btn" onClick={() => step(1)} aria-label="Siguiente">
        <Icon name="next" size={14} />
      </button>
    </div>
  );
}

function Ranking({ list, likesOf, onPick }: {
  list: PublicStartup[]; likesOf: (s: PublicStartup) => number; onPick: (s: PublicStartup) => void;
}) {
  const [open, setOpen] = useState(false);
  // Same rule as the seats (bySeat), with the visitor's own likes already counted.
  const top = useMemo(
    () => list.map((s) => ({ s, likes: likesOf(s) }))
      .sort((a, b) => bySeat({ likes: a.likes, order: a.s.order }, { likes: b.likes, order: b.s.order }))
      .slice(0, RANK_SIZE),
    [list, likesOf],
  );
  if (!top.length) return null;
  const rows = open ? top : top.slice(0, RANK_FOLDED);
  return (
    <section className="ranking" aria-labelledby="ranking-title">
      <h2 id="ranking-title" className="ranking-title">Ranking</h2>
      <ol className="ranking-list">
        {rows.map(({ s, likes }, i) => (
          <li key={s.id}>
            <button type="button" onClick={() => onPick(s)} title={`Ir a ${s.name}`}>
              <span className="ranking-pos">#{i + 1}</span>
              <span className="ranking-name">{s.name}</span>
              <span className="ranking-likes">
                {likes.toLocaleString("es-AR")}
                <Icon name="heart" size={10} />
                <span className="sr-only">likes</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      {top.length > RANK_FOLDED && (
        <button type="button" className="ranking-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Ver menos" : "Ver más"}
        </button>
      )}
    </section>
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
