"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import HoistPanel from "./HoistPanel";
import type { Layout, SalonFx, SalonScene } from "@/lib/flag/salon";
import { CATEGORIES, bySeat, categoryLabel, seatsLine, type PublicStartup } from "@/lib/startups/model";
import { saveBlob } from "@/lib/flag/downloads";
import { Ambience } from "@/lib/flag/ambience";
import { shareText, xIntent } from "./Share";
import Icon from "./Icon";
import { useLikes } from "./useLikes";
import { toast } from "./Toast";

const SITE = (process.env.NEXT_PUBLIC_SITE_URL || "https://flag.ar").replace(/\/$/, "");

/** HTML for the startup's rank badge: works on a website and in a GitHub README. */
function badgeHtml(s: PublicStartup) {
  const alt = `${s.name} en el ranking de flag.ar`.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<a href="${SITE}/${s.slug}"><img src="${SITE}/${s.slug}/badge.svg" alt="${alt}" height="28"></a>`;
}

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

/** Sound is off unless the visitor turned it on before. */
function savedSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === "1";
  } catch {
    return false;
  }
}

function normalize(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Home, the Hall of Fame: a 3D walk (a plain list without WebGL2). An open card puts its flag in the URL
 * (/<slug>), and /<slug> opens the hall on that flag, so every flag has a link to share. `fallback` stands in
 * for the plain list on /<slug> without WebGL2.
 */
export default function SalonApp({ initial, focusSlug, fallback }: {
  initial: PublicStartup[]; focusSlug?: string; fallback?: React.ReactNode;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const scene = useRef<SalonScene | null>(null);
  const [fetched, setAll] = useState(initial);
  const { liked, likesOf, toggle: toggleLike } = useLikes();
  // Seat order with the visitor's own likes counted: a like moves the flag toward the front row at once.
  const all = useMemo(
    () => [...fetched].sort((a, b) => bySeat({ likes: likesOf(a), order: a.order }, { likes: likesOf(b), order: b.order })),
    [fetched, likesOf],
  );
  const [view, setView] = useState<"3d" | "grid" | null>(null);
  // 3D layout: the hall, or every flag in one row sized by its likes.
  const [layout, setLayout] = useState<Layout>("hall");
  // The row can show one category only. Null shows every flag.
  const [catFilter, setCatFilter] = useState<string | null>(null);
  const catFilterRef = useRef(catFilter);
  catFilterRef.current = catFilter;
  // The picker lists only the categories that have a flag.
  const filterCats = useMemo(() => CATEGORIES.filter((c) => all.some((s) => s.category === c.key)), [all]);
  const [query, setQuery] = useState("");
  // High quality: null until the scene picks its device default. A saved choice wins over the default.
  const [high, setHigh] = useState<boolean | null>(null);
  const highRef = useRef(high); // latest value, so fast repeated clicks never toggle from a stale state
  highRef.current = high;
  // Sound: wind and a low drone. Browsers allow audio only after a gesture, so it starts on the first
  // click, tap or key press anywhere (except the sound button itself, which decides on its own).
  const [sound, setSound] = useState(false);
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
    setLayout("hall"); // the hoist happens in the hall: claimSlot leaves the row view
    setCatFilter(null);
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

  // The open card's flag lives in the URL, so the address bar always holds a link to share. Replace, not
  // push: the tour visits many flags, and Back should leave the hall, not step through each one. /izar owns
  // the URL while the sheet is open. On /<slug>, the URL waits until the hall has flown to that flag.
  const focused = useRef(!focusSlug);
  useEffect(() => {
    if (view !== "3d" || !focused.current || location.pathname === "/izar") return;
    const path = picked ? `/${picked.slug}` : "/";
    if (location.pathname !== path) history.replaceState(null, "", path + location.search);
  }, [picked, view, pathname]);

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

  // /<slug>: once the hall is on screen, fly to that flag. Its card opens on arrival.
  useEffect(() => {
    if (!ready || focused.current) return;
    focused.current = true;
    const i = listRef.current.findIndex((x) => x.slug === focusSlug);
    if (i >= 0) scene.current?.focus(i);
  }, [ready, focusSlug]);

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
  // A category row tours only its own flags, and counts them on its own.
  const tour = useMemo(() => (catFilter ? all.filter((s) => s.category === catFilter) : all), [all, catFilter]);
  const stops = tour.length + freeSlots.length;
  const step = useCallback((d: 1 | -1) => {
    const s = scene.current;
    if (!s) return;
    const list = listRef.current, n = list.length, free = s.emptySlots(), total = n + free.length;
    const cat = catFilterRef.current;
    const inTour = (i: number) => i >= n || cat === null || list[i].category === cat;
    if (!total || (!free.length && !list.some((_, i) => inTour(i)))) return;
    let next = navRef.current === null ? (d > 0 ? 0 : total - 1) : (navRef.current + d + total) % total;
    while (!inTour(next)) next = (next + d + total) % total;
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

  function toggleLayout() {
    const next = layout === "hall" ? "row" : "hall";
    setLayout(next);
    setPicked(null);
    setFreePick(null);
    navRef.current = null;
    scene.current?.setLayout(next, catFilter); // the category filter carries over
  }

  function pickCatFilter(cat: string | null) {
    setCatFilter(cat);
    setPicked(null);
    setFreePick(null);
    navRef.current = null;
    scene.current?.setLayout(layout, cat);
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

  async function copyBadge() {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(badgeHtml(shown));
      toast("Insignia copiada. Pegala en tu web o en tu README.");
    } catch {
      window.open(`/${shown.slug}/badge.svg`, "_blank", "noopener"); // clipboard blocked: show the badge itself
    }
  }

  const tweet = xIntent(
    `${query.trim()} todavía no flamea en el Salón de la Fama de las startups argentinas. ¿La izás? 🇦🇷 #FlagAR`,
    "https://flag.ar",
  );

  if (view === "grid" && fallback) return fallback;

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
          {filterCats.length > 1 && (
            <CategoryMenu list={all} cats={filterCats} value={catFilter} onPick={pickCatFilter} />
          )}
          <button
            type="button" className="bar-btn hd-btn" aria-pressed={layout === "row"} onClick={toggleLayout}
            aria-label="Ver en fila" title={layout === "row" ? "Volver al salón" : "Todas en fila, de más a menos likes"}
          >
            Fila
          </button>
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
          <button type="button" className="bare-btn salon-card-close" onClick={closeCard} aria-label="Cerrar" aria-keyshortcuts="Escape">
            <kbd className="key" aria-hidden="true">Esc</kbd>
            <Icon name="close" size={13} />
          </button>
          {stops > 1 && <CardArrow dir={-1} step={step} />}
          {/* Keyed by flag: picking another one swaps the content in place while the card stays. */}
          <div className="salon-card-body" key={shown.id}>
            <p className="startup-trail">
              <span>Bandera #{shown.order}</span>
              {categoryLabel(shown.category) && <span>· {categoryLabel(shown.category)}</span>}
            </p>
            {/* The form asks for one link: the name is that link. */}
            <h2 id="salon-card-name">
              <a className="salon-card-name" href={shown.link} target="_blank" rel="noopener noreferrer nofollow">
                {shown.name} <Icon name="external" size={14} />
              </a>
            </h2>
            <Summary slug={shown.slug} />
            {/* Like, position and actions share one row: the card is wide, not tall. */}
            <div className="salon-card-row">
              <button
                type="button" className="like-btn" aria-pressed={liked.has(shown.id)} onClick={() => toggleLike(shown)}
                aria-label={liked.has(shown.id) ? `Sacar like a ${shown.name}` : `Darle like a ${shown.name}`}
                title="Más likes, más cerca de la bandera argentina"
              >
                <Icon name="heart" size={13} />
                <span>{likesOf(shown).toLocaleString("es-AR")}</span>
              </button>
              {stops > 1 && <span className="salon-card-count">{(tour.findIndex((x) => x.id === shown.id) + 1) || "–"} / {stops}</span>}
              <div className="salon-card-actions">
                <a
                  className="text-link" href={xIntent(shareText(shown.name, shown.order), `${SITE}/${shown.slug}`)}
                  target="_blank" rel="noopener noreferrer"
                >
                  Compartir en X <Icon name="external" size={12} />
                </a>
                <button type="button" className="text-link" onClick={wallpaper} disabled={wallpaperBusy} aria-busy={wallpaperBusy}>
                  {wallpaperBusy ? <>Generando… <span className="spinner" aria-hidden="true" style={{ display: "inline-block", verticalAlign: "-2px" }} /></> : <>{touch ? "Fondo de pantalla" : "Fondo 4K"} <Icon name="download" size={12} /></>}
                </button>
                <button
                  type="button" className="text-link" onClick={copyBadge}
                  title="Tu puesto en vivo, para tu web o tu README"
                >
                  Insignia <Icon name="copy" size={12} />
                </button>
              </div>
            </div>
          </div>
          {stops > 1 && <CardArrow dir={1} step={step} />}
        </aside>
      )}

      {view === "3d" && freePick !== null && !shown && hoist === "closed" && (
        <aside className="salon-card" aria-labelledby="salon-free-name" data-state="open">
          <button type="button" className="bare-btn salon-card-close" onClick={closeCard} aria-label="Cerrar" aria-keyshortcuts="Escape">
            <kbd className="key" aria-hidden="true">Esc</kbd>
            <Icon name="close" size={13} />
          </button>
          {stops > 1 && <CardArrow dir={-1} step={step} />}
          <div className="salon-card-body" key={`free-${freePick}`}>
            <h2 id="salon-free-name">Mástil libre</h2>
            <p className="salon-card-text">Tu startup puede flamear acá, al lado de la bandera argentina.</p>
            <div className="salon-card-row">
              {stops > 1 && <span className="salon-card-count">{all.length + freeSlots.indexOf(freePick) + 1} / {stops}</span>}
              <div className="salon-card-actions">
                <button type="button" className="nav-cta" onClick={() => openHoist(freePick)}>Izar mi bandera acá</button>
              </div>
            </div>
          </div>
          {stops > 1 && <CardArrow dir={1} step={step} />}
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
                {/* The row compares by likes: its label says the rank and the count. */}
                {layout === "row" && (
                  <span className="tip-chip tip-likes">
                    #{(tour.findIndex((x) => x.id === s.id) + 1) || hovered.index + 1} ·{likesOf(s).toLocaleString("es-AR")} <Icon name="heart" size={10} />
                    <span className="sr-only">likes</span>
                  </span>
                )}
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
              <button type="button" className="salon-nav-label" onClick={() => step(1)} aria-keyshortcuts="ArrowLeft ArrowRight">
                Recorrer las banderas
                <kbd className="key" aria-hidden="true">←</kbd>
                <kbd className="key" aria-hidden="true">→</kbd>
              </button>
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

const RANK_FOLDED = 3;

/** The tour's arrows inside a card: previous, "2 / 4", next. */
/** One arrow per card edge: back on the left, forward on the right. */
function CardArrow({ dir, step }: { dir: 1 | -1; step: (d: 1 | -1) => void }) {
  return (
    <button
      type="button" className="bar-btn salon-card-arrow" onClick={() => step(dir)}
      aria-label={dir < 0 ? "Anterior" : "Siguiente"}
    >
      <Icon name={dir < 0 ? "prev" : "next"} size={16} />
    </button>
  );
}

/** Fetched summaries, kept for the visit: stepping back to a flag shows its line at once. */
const summaries = new Map<string, string | null>();

/** What the startup does, in its own site's words. Nothing shows until it arrives, or when the site has none. */
function Summary({ slug }: { slug: string }) {
  const [text, setText] = useState<string | null>(() => summaries.get(slug) ?? null);
  useEffect(() => {
    if (summaries.has(slug)) return;
    const ctrl = new AbortController();
    fetch(`/api/summary/${encodeURIComponent(slug)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : { summary: null }))
      .then((d: { summary: string | null }) => { summaries.set(slug, d.summary); setText(d.summary); })
      .catch(() => {});
    return () => ctrl.abort();
  }, [slug]);
  if (!text) return null;
  return <p className="salon-card-text salon-card-summary">{text}</p>;
}

/** Gold, silver and bronze stand in for #1, #2 and #3. */
const MEDALS = ["🥇", "🥈", "🥉"];

/** Every startup by likes, small, in a corner. The top 3 always show; "Ver más" unfolds the rest. */
function Ranking({ list, likesOf, onPick }: {
  list: PublicStartup[]; likesOf: (s: PublicStartup) => number; onPick: (s: PublicStartup) => void;
}) {
  const [open, setOpen] = useState(false);
  // Same rule as the seats (bySeat), with the visitor's own likes already counted.
  const top = useMemo(
    () => list.map((s) => ({ s, likes: likesOf(s) }))
      .sort((a, b) => bySeat({ likes: a.likes, order: a.s.order }, { likes: b.likes, order: b.s.order })),
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
              <span className="ranking-pos">
                {i < MEDALS.length
                  ? <><span aria-hidden="true">{MEDALS[i]}</span><span className="sr-only">#{i + 1}</span></>
                  : `#${i + 1}`}
              </span>
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

/**
 * Category filter: a chip in the corner pill with the short name ("SaaS", not "SaaS / Software B2B"), and a
 * glass list under it, like the ranking: name and flag count, a check on the current one. Works in the hall
 * and in the row. Escape, a pick, or a click outside closes it.
 */
function CategoryMenu({ list, cats, value, onPick }: {
  list: PublicStartup[]; cats: readonly { key: string; label: string }[]; value: string | null; onPick: (cat: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); // Escape closes the menu, not the flag card under it
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>(".cat-chip")?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const count = (key: string | null) => (key === null ? list.length : list.filter((s) => s.category === key).length);
  const rows = [{ key: null, label: "Todas" }, ...cats];
  return (
    <div className="cat-menu" ref={root}>
      <button
        type="button" className="bar-btn hd-btn cat-chip" aria-pressed={value !== null} aria-expanded={open} aria-haspopup="true"
        aria-label={`Categoría: ${value ? categoryLabel(value) : "todas"}`} onClick={() => setOpen(!open)}
      >
        {/* Phones show the funnel alone: the top row has no room for a name beside the search. */}
        <span className="cat-chip-label">{value ? categoryLabel(value)?.split(" / ")[0] : "Todas"}</span>
        <Icon name="down" size={11} />
        <Icon name="filter" size={14} />
      </button>
      {/* The list lives outside the corner pill: glass inside glass only blurs the pill, not the scene. */}
      {open && root.current?.closest(".salon") && createPortal(
        <div className="cat-list" role="group" aria-label="Categoría" ref={menu}>
          {rows.map((c) => (
            <button
              key={c.key ?? "all"} type="button" aria-pressed={value === c.key} autoFocus={value === c.key}
              onClick={() => { onPick(c.key); setOpen(false); }}
            >
              <span className="cat-name">{c.label}</span>
              <span className="cat-count">{count(c.key)}</span>
              <span className="cat-check">{value === c.key && <Icon name="check" size={11} />}</span>
            </button>
          ))}
        </div>,
        root.current.closest(".salon")!,
      )}
    </div>
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
