"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { PairScene } from "@/lib/flag/scene";

/** Height of the corner links (Salón, Izá la tuya) plus a margin. The flags start below them. */
const TOP_UI = 64;

/** Creates the two-pole scene in `holder`. Three.js loads after the page, in its own chunk. */
export function usePairScene(holder: RefObject<HTMLDivElement | null>, onTogglePause: () => void) {
  const scene = useRef<PairScene | null>(null);
  const [webgl, setWebgl] = useState<boolean | null>(null);
  const toggle = useRef(onTogglePause);
  toggle.current = onTogglePause;

  useEffect(() => {
    let s: PairScene | null = null;
    let cancelled = false;
    (async () => {
      const mod = await import("@/lib/flag/scene");
      if (cancelled) return;
      if (!mod.supportsWebGL2() || !holder.current) {
        setWebgl(false);
        return;
      }
      s = new mod.PairScene(holder.current, { onTogglePause: () => toggle.current() });
      s.setInsetTop(TOP_UI);
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) s.setWind(0.3);
      scene.current = s;
      setWebgl(true);
    })();
    return () => {
      cancelled = true;
      s?.dispose();
      scene.current = null;
    };
  }, [holder]);

  return { scene, webgl };
}

/** Keeps the flags above the bottom UI: tells the scene how many pixels the dock covers. */
export function useDockInset(
  dock: RefObject<HTMLElement | null>, scene: RefObject<PairScene | null>, ready: boolean, key: unknown = null,
) {
  useEffect(() => {
    const bar = dock.current;
    if (!ready || !bar) return;
    const update = () => {
      // Hidden dock (phone with the hoist sheet open): the sheet sets the inset instead.
      if (bar.getClientRects().length === 0) return;
      scene.current?.setInsetBottom(window.innerHeight - bar.getBoundingClientRect().top + 8);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(bar);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
    // `key` re-measures when something else covered the screen (the hoist sheet) and went away.
  }, [dock, scene, ready, key]);
}

/** Loads an image URL for the second flag. Same origin (/files), so canvas reads stay clean. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("logo"));
    img.src = src;
  });
}
