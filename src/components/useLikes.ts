"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicStartup } from "@/lib/startups/model";

// The hall list comes from a CDN cache that lags up to a few minutes. The visitor's own likes show at once:
// the count the server returned wins over the cached one for a while, then the cache has caught up.
const OVERRIDE_MS = 5 * 60_000;

/** This device's likes, and a like toggle with an instant count. */
export function useLikes() {
  const [liked, setLiked] = useState<Set<string>>(() => new Set());
  const [overrides, setOverrides] = useState<Map<string, { likes: number; at: number }>>(() => new Map());
  const busy = useRef(new Set<string>());

  useEffect(() => {
    fetch("/api/likes", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { liked?: string[] } | null) => d?.liked && setLiked(new Set(d.liked)))
      .catch(() => {});
  }, []);

  const likesOf = useCallback((s: PublicStartup) => {
    const o = overrides.get(s.id);
    return o && Date.now() - o.at < OVERRIDE_MS ? o.likes : s.likes;
  }, [overrides]);

  const setCount = (id: string, likes: number) =>
    setOverrides((m) => new Map(m).set(id, { likes, at: Date.now() }));
  const setMine = (id: string, on: boolean) =>
    setLiked((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  /** Optimistic: the heart and the count change at once; a refused request puts both back. */
  const toggle = useCallback(async (s: PublicStartup) => {
    if (busy.current.has(s.id)) return;
    busy.current.add(s.id);
    const was = liked.has(s.id);
    const before = likesOf(s);
    setMine(s.id, !was);
    setCount(s.id, Math.max(0, before + (was ? -1 : 1)));
    try {
      const r = await fetch("/api/likes", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: s.id, like: !was }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const d = (await r.json()) as { likes: number; liked: boolean };
      setMine(s.id, d.liked);
      setCount(s.id, d.likes);
    } catch {
      setMine(s.id, was);
      setCount(s.id, before);
    } finally {
      busy.current.delete(s.id);
    }
  }, [liked, likesOf]);

  return { liked, likesOf, toggle };
}
