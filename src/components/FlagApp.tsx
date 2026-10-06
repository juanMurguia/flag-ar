"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Manifest, ManifestLogo } from "@/lib/flag/layout";
import { MAX_LOGOS } from "@/lib/flag/layout";
import UploadDialog from "./UploadDialog";
import StillFlag from "./StillFlag";
import Icon from "./Icon";

const FILES_BASE = process.env.NEXT_PUBLIC_FILES_BASE || "/files";

type SceneHandle = import("@/lib/flag/scene").FlagScene;

export default function FlagApp() {
  const holder = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  const [logos, setLogos] = useState<ManifestLogo[]>([]);
  const [webgl, setWebgl] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [solo, setSolo] = useState(false);
  const [wind, setWind] = useState(1);
  const [paused, setPaused] = useState(false);
  const [frame, setFrame] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Scene
  useEffect(() => {
    let scene: SceneHandle | null = null;
    let cancelled = false;
    (async () => {
      const mod = await import("@/lib/flag/scene");
      if (cancelled) return;
      if (!mod.supportsWebGL2() || !holder.current) {
        setWebgl(false);
        return;
      }
      setWebgl(true);
      scene = new mod.FlagScene(holder.current, {
        onSelect: (i) => setSelected(i),
        onTogglePause: () => togglePauseRef.current(),
      });
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        scene.setWind(0.3);
        setWind(0.3);
      }
      sceneRef.current = scene;
    })();
    return () => {
      cancelled = true;
      scene?.dispose();
      sceneRef.current = null;
    };
  }, []);

  // Manifest
  useEffect(() => {
    fetch(`${FILES_BASE}/manifest.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : null))
      .then((m) => setLogos(Array.isArray(m?.logos) ? m!.logos : []))
      .catch(() => setLogos([]));
  }, []);

  useEffect(() => {
    // Logos load after the first frame.
    const id = requestAnimationFrame(() => sceneRef.current?.setLogos(logos.slice(0, MAX_LOGOS), FILES_BASE));
    return () => cancelAnimationFrame(id);
  }, [logos, webgl]);

  useEffect(() => {
    sceneRef.current?.setSolo(solo && selected !== null ? selected : null);
  }, [solo, selected]);

  const close = useCallback(() => {
    setSelected(null);
    setSolo(false);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !uploadOpen) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, uploadOpen]);

  // Keep the flag clear of the toolbar: tell the scene how much of the bottom it covers.
  useEffect(() => {
    const bar = toolbar.current;
    if (!webgl || !bar) return;
    const update = () => {
      const top = bar.getBoundingClientRect().top;
      sceneRef.current?.setInsetBottom(window.innerHeight - top + 8);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(bar);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [webgl]);

  const logo = selected !== null ? logos[selected] : null;

  // Pause freezes the cloth. While paused, the slider moves through the last 6 seconds of frames.
  const togglePause = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (scene.paused) {
      scene.play();
      setPaused(false);
    } else {
      const last = scene.pause();
      setFrameCount(scene.frameCount);
      setFrame(last);
      setPaused(true);
    }
  }, []);
  const togglePauseRef = useRef(togglePause);
  togglePauseRef.current = togglePause;

  /** Saves exactly what the screen shows, with the flag.ar watermark. */
  async function capture() {
    if (!sceneRef.current) return;
    setBusy(true);
    try {
      const blob = await sceneRef.current.capture();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = solo && logo ? `argentina-${logo.domain}.png` : "flag-ar.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="stage">
      <h1 className="sr-only">Argentine Startups Flag</h1>
      <div ref={holder} className="flag-holder" />
      {webgl === false && <StillFlag logos={logos} filesBase={FILES_BASE} />}

      {logo && (
        <section className="card" aria-label={`Brand: ${logo.domain}`}>
          <p className="card-domain">{logo.domain}</p>
          <div className="card-actions">
            <a
              className="btn primary icon" href={logo.url} target="_blank" rel="noopener noreferrer nofollow"
              aria-label={`Visit ${logo.domain}`} title="Visit site"
            >
              <Icon name="external" />
            </a>
            {webgl && selected !== null && selected < MAX_LOGOS && (
              <button className={`btn labeled${solo ? " on" : ""}`} onClick={() => setSolo((v) => !v)}>
                <Icon name={solo ? "grid" : "focus"} size={16} />
                {solo ? "Show all logos" : "Show only this logo"}
              </button>
            )}
            <button className="btn ghost icon" onClick={close} aria-label="Close" title="Close">
              <Icon name="close" />
            </button>
          </div>
        </section>
      )}

      <div className="toolbar" ref={toolbar}>
        {webgl && (
          <button
            className="btn icon" onClick={togglePause} aria-pressed={paused}
            aria-label={paused ? "Play wind" : "Pause wind"} title={paused ? "Play (Space)" : "Pause (Space)"}
          >
            <Icon name={paused ? "play" : "pause"} />
          </button>
        )}
        {webgl && !paused && (
          <label className="slider" title="Wind strength">
            <Icon name="wind" size={15} />
            <input
              type="range" min={0} max={2} step={0.05} value={wind} aria-label="Wind strength"
              onChange={(e) => {
                const w = Number(e.target.value);
                setWind(w);
                sceneRef.current?.setWind(w);
              }}
            />
          </label>
        )}
        {webgl && paused && (
          <label className="slider" title="Pick a frame">
            <Icon name="frames" size={15} />
            <input
              type="range" min={0} max={Math.max(0, frameCount - 1)} step={1} value={frame}
              aria-label="Frame" aria-valuetext={`Frame ${frame + 1} of ${frameCount}`}
              onChange={(e) => {
                const i = Number(e.target.value);
                setFrame(i);
                sceneRef.current?.showFrame(i);
              }}
            />
          </label>
        )}
        {webgl && (
          <button
            className="btn ghost icon" onClick={() => sceneRef.current?.resetView()}
            aria-label="Reset view" title="Reset view"
          >
            <Icon name="reset" />
          </button>
        )}
        {webgl && (
          <button
            className="btn ghost icon" onClick={capture} disabled={busy} aria-busy={busy}
            aria-label="Download screenshot" title="Download screenshot"
          >
            <Icon name="camera" />
          </button>
        )}
        <button
          className="btn primary icon" onClick={() => setUploadOpen(true)}
          aria-label="Add your logo" title="Add your logo"
        >
          <Icon name="plus" />
        </button>
      </div>

      {/* Brand list for screen readers and keyboard users. Shown on focus. */}
      <nav className="brand-list" aria-label="Brands on the flag">
        <ul>
          {logos.map((l, i) => (
            <li key={l.id}>
              <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" onFocus={() => setSelected(i)}>
                {l.domain}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {uploadOpen && <UploadDialog onClose={() => setUploadOpen(false)} />}
    </main>
  );
}
