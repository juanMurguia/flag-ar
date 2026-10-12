// Logo pixel helpers: brand color, light-mark check, solid background removal, trimming.
// No Three.js or DOM here, so unit tests cover them.

// ---------- Brand colors ----------

export type RGB = [number, number, number];

/**
 * Finds the logo's brand color in RGBA pixels. Skips transparent, near-white, near-black, and gray pixels.
 * Groups the rest into 24 hue bins weighted by saturation. Returns the mean color of the heaviest bin, or null.
 */
export function pickBrandColor(rgba: ArrayLike<number>): RGB | null {
  const BINS = 24;
  const weight = new Float64Array(BINS);
  const sum = Array.from({ length: BINS }, () => [0, 0, 0]);
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 200) continue;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const [h, s, l] = rgbToHsl([r, g, b]);
    if (s < 0.25 || l < 0.12 || l > 0.92) continue;
    const bin = Math.min(BINS - 1, Math.floor(h * BINS));
    weight[bin] += s;
    sum[bin][0] += r * s;
    sum[bin][1] += g * s;
    sum[bin][2] += b * s;
  }
  let best = -1;
  for (let k = 0; k < BINS; k++) if (weight[k] > 0 && (best < 0 || weight[k] > weight[best])) best = k;
  if (best < 0 || weight[best] < 4) return null; // a few stray pixels are not a brand color
  const w = weight[best];
  return [Math.round(sum[best][0] / w), Math.round(sum[best][1] / w), Math.round(sum[best][2] / w)];
}

/**
 * True when the logo is a light mark on transparency (for example, a white wordmark).
 * Such a logo vanishes on a light background: the cream patch on the Argentine flag, or the white startup flag.
 * An opaque image (a JPEG with a white box) is not light: the box is its own background.
 */
export function isLightLogo(rgba: ArrayLike<number>): boolean {
  let sum = 0, n = 0, clear = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) {
      clear++;
      continue;
    }
    sum += (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255;
    n++;
  }
  return n > 0 && clear / (n + clear) > 0.1 && sum / n > 0.82;
}

/**
 * Brand color to the accent stripe on the white startup flag, or null for a plain white flag.
 * Lightness is held in a mid range, so the stripe reads on white and never turns pastel or black.
 */
export function accentColor(brand: RGB | null): string | null {
  if (!brand) return null;
  const [h, s, l] = rgbToHsl(brand);
  const sat = Math.min(0.85, Math.max(0.45, s));
  const light = Math.min(0.55, Math.max(0.32, l));
  return hex(hslToRgb([h, sat, light]));
}

// ---------- Logo cleanup ----------
// An upload is a PNG with transparency, or an opaque image (JPEG, or PNG without alpha) with a
// solid box behind the mark. The white startup flag shows only the mark, so the box goes.
// The case is read from the pixels, not the file extension: an opaque PNG behaves like a JPEG.

/** RGB distance (0-441) at or below which a pixel is background. Covers JPEG noise. */
const BG_HARD = 38;
/** Up to this distance, a pixel next to the background is a soft edge: partly transparent. */
const BG_SOFT = 110;

/**
 * Makes a solid background transparent, in place. Returns true when it removed one.
 * The background is the border color, when the border is opaque and uniform.
 * Removal is a flood fill from the border, so the same color enclosed inside the mark stays.
 * Edge pixels get partial alpha, and the background tint is taken out of their color (no halo).
 */
export function removeSolidBackground(px: Uint8ClampedArray | number[], w: number, h: number): boolean {
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
  const opaque = border.filter((i) => px[i * 4 + 3] >= 200);
  if (opaque.length < border.length * 0.6) return false; // already transparent (a PNG with alpha)

  const median = (c: number) => opaque.map((i) => px[i * 4 + c]).sort((a, b) => a - b)[opaque.length >> 1];
  const bg: RGB = [median(0), median(1), median(2)];
  const dist = (i: number) => Math.hypot(px[i * 4] - bg[0], px[i * 4 + 1] - bg[1], px[i * 4 + 2] - bg[2]);
  const isBg = (i: number) => px[i * 4 + 3] >= 200 && dist(i) <= BG_HARD;
  const stack = border.filter(isBg);
  if (stack.length < border.length * 0.8) return false; // a photo, or a mark that runs off the edge

  const removed = new Uint8Array(w * h);
  for (const i of stack) removed[i] = 1;
  let count = stack.length;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i / w) | 0;
    for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (n < 0 || removed[n] || !isBg(n)) continue;
      removed[n] = 1;
      count++;
      stack.push(n);
    }
  }
  if (count > w * h * 0.97) return false; // one flat color: that box is the logo

  for (let i = 0; i < w * h; i++) {
    if (removed[i]) {
      px[i * 4 + 3] = 0;
      continue;
    }
    const x = i % w, y = (i / w) | 0;
    const touches = (x > 0 && removed[i - 1]) || (x < w - 1 && removed[i + 1])
      || (y > 0 && removed[i - w]) || (y < h - 1 && removed[i + w]);
    const d = dist(i);
    if (!touches || d >= BG_SOFT) continue;
    // Edge pixel = mark blended over the background. Undo the blend.
    const a = Math.max(0.05, (d - BG_HARD) / (BG_SOFT - BG_HARD));
    for (let c = 0; c < 3; c++) {
      px[i * 4 + c] = Math.max(0, Math.min(255, Math.round(bg[c] + (px[i * 4 + c] - bg[c]) / a)));
    }
    px[i * 4 + 3] = Math.round(px[i * 4 + 3] * a);
  }
  return true;
}

/** Bounding box of the visible pixels, or null when the image is empty. Used to trim padding. */
export function visibleBounds(px: ArrayLike<number>, w: number, h: number) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] <= 16) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Paints every pixel one color and keeps its alpha. Turns a white mark dark, so it shows on white cloth. */
export function recolor(px: Uint8ClampedArray | number[], rgb: RGB): void {
  for (let i = 0; i + 3 < px.length; i += 4) {
    px[i] = rgb[0];
    px[i + 1] = rgb[1];
    px[i + 2] = rgb[2];
  }
}

export function rgbToHsl([r, g, b]: RGB): RGB {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

export function hslToRgb([h, s, l]: RGB): RGB {
  if (s === 0) return [l * 255, l * 255, l * 255].map(Math.round) as RGB;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255)) as RGB;
}

export function hexToRgb(h: string): RGB {
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
}

function hex(rgb: RGB): string {
  return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
