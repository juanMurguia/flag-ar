// Flag layout in "layout units": 1400 × 900, drawn at 2× on a 2800 × 1800 canvas.

export const LAYOUT_W = 1400;
export const LAYOUT_H = 900;
export const TEX_SCALE = 2;
export const SUN = { x: 700, y: 450 };
export const MAX_LOGOS = 40;
export const PATCH_SIZE = 118;
export const HIT_RADIUS = 62;
export const SOLO_PATCH = { x: 700, y: 742, w: 300, h: 210 };

export const COLORS = {
  blue: "#74ACDF",
  white: "#FFFFFF",
  sun: "#F6B40E",
  sunLine: "#85340A",
};

export interface ManifestLogo {
  id: string;
  domain: string;
  url: string;
  image: string; // file name inside /files/
}

export interface Manifest {
  version: number;
  updated_at: string;
  logos: ManifestLogo[];
}

export interface Slot {
  x: number;
  y: number;
}

/** 40 patch slots on a 9 × 5 grid. Slots within 200 units of the sun are skipped. Nearest first. */
export function patchSlots(): Slot[] {
  const cols = 9, rows = 5;
  const slots: Slot[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = ((i + 0.5) * LAYOUT_W) / cols;
      const y = ((j + 0.5) * LAYOUT_H) / rows;
      if (Math.hypot(x - SUN.x, y - SUN.y) < 200) continue;
      slots.push({ x, y });
    }
  }
  const d = (s: Slot) => Math.hypot(s.x - SUN.x, s.y - SUN.y);
  // Stable tie-break (top-left first) so the order never changes between builds.
  return slots.sort((a, b) => d(a) - d(b) || a.y - b.y || a.x - b.x).slice(0, MAX_LOGOS);
}

/** UV hit point to layout units. */
export function uvToLayout(u: number, v: number): Slot {
  return { x: u * LAYOUT_W, y: (1 - v) * LAYOUT_H };
}

/** Index of the logo hit at a layout point, or -1. */
export function hitLogo(p: Slot, count: number, soloIndex: number | null): number {
  if (soloIndex !== null) {
    const s = SOLO_PATCH;
    return Math.abs(p.x - s.x) <= s.w / 2 && Math.abs(p.y - s.y) <= s.h / 2 ? soloIndex : -1;
  }
  const slots = patchSlots();
  for (let i = 0; i < Math.min(count, slots.length); i++) {
    if (Math.hypot(p.x - slots[i].x, p.y - slots[i].y) <= HIT_RADIUS) return i;
  }
  return -1;
}
