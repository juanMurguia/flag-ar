import { describe, expect, it } from "vitest";
import { Cloth } from "@/lib/flag/cloth";
import { HIT_RADIUS, MAX_LOGOS, SOLO_PATCH, SUN, hitLogo, patchSlots, uvToLayout } from "@/lib/flag/layout";

describe("patchSlots", () => {
  const slots = patchSlots();
  it("has 40 slots, none within 200 units of the sun", () => {
    expect(slots).toHaveLength(MAX_LOGOS);
    for (const s of slots) expect(Math.hypot(s.x - SUN.x, s.y - SUN.y)).toBeGreaterThanOrEqual(200);
  });
  it("fills outward from the sun", () => {
    const d = slots.map((s) => Math.hypot(s.x - SUN.x, s.y - SUN.y));
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThanOrEqual(d[i - 1]);
  });
});

describe("picking", () => {
  it("maps UV to layout units", () => {
    expect(uvToLayout(0.5, 0.5)).toEqual({ x: 700, y: 450 });
    expect(uvToLayout(0, 1)).toEqual({ x: 0, y: 0 });
  });
  it("hits a patch within 62 units, misses outside", () => {
    const s = patchSlots()[3];
    expect(hitLogo({ x: s.x + HIT_RADIUS - 1, y: s.y }, 10, null)).toBe(3);
    expect(hitLogo({ x: s.x + HIT_RADIUS + 1, y: s.y }, 10, null)).toBe(-1);
    expect(hitLogo(s, 3, null)).toBe(-1); // slot 3 is empty when only 3 logos exist
  });
  it("in solo mode hits only the large patch", () => {
    expect(hitLogo({ x: SOLO_PATCH.x, y: SOLO_PATCH.y }, 10, 7)).toBe(7);
    expect(hitLogo(patchSlots()[0], 10, 7)).toBe(-1);
  });
});

describe("Cloth", () => {
  it("stays stable and bounded over 20 simulated seconds at max wind", () => {
    const c = new Cloth();
    c.wind = 2;
    for (let i = 0; i < 1200; i++) c.step();
    let maxAbs = 0;
    for (const v of c.pos) {
      expect(Number.isFinite(v)).toBe(true);
      maxAbs = Math.max(maxAbs, Math.abs(v));
    }
    expect(maxAbs).toBeLessThan(20);
  });
  it("keeps the held edge near its rest x", () => {
    const c = new Cloth();
    for (let i = 0; i < 300; i++) c.step();
    for (let r = 0; r < c.rows; r++) expect(c.pos[r * c.cols * 3]).toBeCloseTo(-7, 5);
  });
  it("extends downwind (positive x) rather than hanging", () => {
    const c = new Cloth();
    for (let i = 0; i < 300; i++) c.step();
    const tip = c.pos[(21 * c.cols + c.cols - 1) * 3];
    expect(tip).toBeGreaterThan(4);
  });
  it("runs a step in reasonable time", () => {
    const c = new Cloth();
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) c.step();
    const ms = (performance.now() - t0) / 60;
    expect(ms).toBeLessThan(30); // loose: CI machines vary
  });
});
