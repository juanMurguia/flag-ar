// Canvas drawing for the flag: bands, Sun of May, hem, stitches, logo patches, weave.
import {
  COLORS, LAYOUT_H, LAYOUT_W, PATCH_SIZE, SOLO_PATCH, SUN, TEX_SCALE, patchSlots,
} from "./layout";
import {
  accentColor, hexToRgb, isLightLogo, pickBrandColor, recolor, removeSolidBackground, visibleBounds,
} from "./startup";

export type LogoImage = CanvasImageSource & { width: number; height: number };

const PATCH_LIGHT = "#FBFBF8";
const PATCH_DARK = "#1F2433";

// One pixel read per logo. The texture redraws often, the answer never changes.
const lightCache = new WeakMap<object, boolean>();
function needsDarkPatch(img: LogoImage): boolean {
  let v = lightCache.get(img);
  if (v === undefined) {
    try {
      const size = 48;
      const c = createCanvas(size, size);
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      // Stretch to fill: only alpha and lightness matter here, not the shape.
      ctx.drawImage(img, 0, 0, size, size);
      v = isLightLogo(ctx.getImageData(0, 0, size, size).data);
    } catch {
      v = false;
    }
    lightCache.set(img, v);
  }
  return v;
}

export interface DrawOptions {
  logos: (LogoImage | null)[]; // in slot order; null = still loading
  soloIndex: number | null;
  weave?: HTMLCanvasElement | null; // gray overlay, multiplied over the colors
}

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export function drawFlag(canvas: HTMLCanvasElement, opts: DrawOptions): void {
  const ctx = canvas.getContext("2d")!;
  const s = canvas.width / LAYOUT_W;
  ctx.save();
  ctx.setTransform(s, 0, 0, s, 0, 0);

  const band = LAYOUT_H / 3;
  ctx.fillStyle = COLORS.blue;
  ctx.fillRect(0, 0, LAYOUT_W, band);
  ctx.fillStyle = COLORS.white;
  ctx.fillRect(0, band, LAYOUT_W, band);
  ctx.fillStyle = COLORS.blue;
  ctx.fillRect(0, band * 2, LAYOUT_W, LAYOUT_H - band * 2);

  drawSun(ctx, SUN.x, SUN.y, 125);
  drawHem(ctx);

  if (opts.soloIndex !== null) {
    const img = opts.logos[opts.soloIndex] ?? null;
    drawPatch(ctx, SOLO_PATCH.x, SOLO_PATCH.y, SOLO_PATCH.w, SOLO_PATCH.h, img);
  } else {
    const slots = patchSlots();
    opts.logos.slice(0, slots.length).forEach((img, i) => {
      drawPatch(ctx, slots[i].x, slots[i].y, PATCH_SIZE, PATCH_SIZE, img);
    });
  }
  ctx.restore();

  if (opts.weave) {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(opts.weave, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
}

export interface StartupFlagOptions {
  logo: LogoImage | null; // null = still loading
  accent: string | null; // brand color stripe at the hoist; null = plain white flag
  weave?: HTMLCanvasElement | null;
}

/** Accent stripe width at the hoist, in layout units. */
export const STARTUP_ACCENT = 72;
const STARTUP_CLOTH = "#FAFAF7"; // white, a touch warm, so it reads as cloth and not as a blank screen
const STARTUP_INK = "#1F2433"; // for a light mark that would vanish on white

/**
 * A startup's flag: white cloth, the logo printed in the middle, and a brand color stripe at the hoist.
 * The logo is printed straight on the cloth, with no panel, so it must be a clean mark (see prepareLogo).
 */
export function drawStartupFlag(canvas: HTMLCanvasElement, opts: StartupFlagOptions): void {
  const ctx = canvas.getContext("2d")!;
  const s = canvas.width / LAYOUT_W;
  ctx.save();
  ctx.setTransform(s, 0, 0, s, 0, 0);

  ctx.fillStyle = STARTUP_CLOTH;
  ctx.fillRect(0, 0, LAYOUT_W, LAYOUT_H);
  const left = opts.accent ? STARTUP_ACCENT : 0;
  if (opts.accent) {
    ctx.fillStyle = opts.accent;
    ctx.fillRect(0, 0, STARTUP_ACCENT, LAYOUT_H);
  }
  drawHem(ctx);

  const img = opts.logo;
  if (img && img.width > 0 && img.height > 0) {
    // Fit inside a box that leaves wide margins: the cloth folds most near the edges.
    const boxW = (LAYOUT_W - left) * 0.52, boxH = LAYOUT_H * 0.42;
    const k = Math.min(boxW / img.width, boxH / img.height);
    const dw = img.width * k, dh = img.height * k;
    const cx = left + (LAYOUT_W - left) / 2;
    ctx.drawImage(img, cx - dw / 2, LAYOUT_H / 2 - dh / 2, dw, dh);
  }
  ctx.restore();

  if (opts.weave) {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(opts.weave, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
}

/** Longest side of the cleaned logo, in pixels. The flag prints it at about 1600 px at most. */
const LOGO_MAX = 1024;

/**
 * Cleans an uploaded logo for the white flag and finds its accent color:
 * 1. A solid box behind the mark (JPEG, opaque PNG) becomes transparent.
 * 2. A light mark (a white wordmark) is repainted dark, or it would vanish on white.
 * 3. Empty padding is trimmed, so every logo prints at the same visual size.
 * When the pixels cannot be read (cross-origin image without CORS), returns the image as is.
 */
export function prepareLogo(img: LogoImage): { logo: LogoImage; accent: string | null } {
  try {
    const k = Math.min(1, LOGO_MAX / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
    const c = createCanvas(w, h);
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;

    removeSolidBackground(px, w, h);
    const accent = accentColor(pickBrandColor(px));
    if (isLightLogo(px)) recolor(px, hexToRgb(accent ?? STARTUP_INK));
    ctx.putImageData(data, 0, 0);

    const b = visibleBounds(px, w, h);
    if (!b) return { logo: img, accent };
    const out = createCanvas(b.w, b.h);
    out.getContext("2d")!.drawImage(c, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    return { logo: out, accent };
  } catch {
    return { logo: img, accent: null }; // tainted canvas
  }
}

function drawSun(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number) {
  const r0 = R * 0.42;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = COLORS.sun;
  ctx.strokeStyle = COLORS.sunLine;
  ctx.lineWidth = 1.2;
  ctx.lineJoin = "round";
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2 - Math.PI / 2;
    ctx.save();
    ctx.rotate(a);
    ctx.beginPath();
    if (k % 2 === 0) {
      // Straight ray
      ctx.moveTo(r0 - 2, -6.5);
      ctx.lineTo(R, 0);
      ctx.lineTo(r0 - 2, 6.5);
    } else {
      // Wavy (flaming) ray
      const len = R * 0.92 - r0;
      const pts = 18;
      const left: [number, number][] = [];
      const right: [number, number][] = [];
      for (let i = 0; i <= pts; i++) {
        const t = i / pts;
        const x = r0 - 2 + t * len;
        const off = Math.sin(t * Math.PI * 3) * 3.2 * (1 - t * 0.4);
        const hw = 5.5 * (1 - t) + 0.3;
        left.push([x, off - hw]);
        right.push([x, off + hw]);
      }
      ctx.moveTo(left[0][0], left[0][1]);
      for (const p of left) ctx.lineTo(p[0], p[1]);
      for (const p of right.reverse()) ctx.lineTo(p[0], p[1]);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Face
  ctx.beginPath();
  ctx.arc(0, 0, r0, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.lineWidth = 1.3;
  ctx.lineCap = "round";
  const f = r0 / 52;
  // Brows
  for (const sx of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(sx * 26 * f, -14 * f);
    ctx.quadraticCurveTo(sx * 17 * f, -21 * f, sx * 6 * f, -15 * f);
    ctx.stroke();
    // Eye
    ctx.beginPath();
    ctx.ellipse(sx * 15 * f, -8 * f, 6 * f, 3 * f, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx * 15 * f, -8 * f, 1.8 * f, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.sunLine;
    ctx.fill();
    ctx.fillStyle = COLORS.sun;
    // Cheek
    ctx.beginPath();
    ctx.arc(sx * 21 * f, 9 * f, 4 * f, 0.3, Math.PI - 0.3);
    ctx.stroke();
  }
  // Nose
  ctx.beginPath();
  ctx.moveTo(-1 * f, -10 * f);
  ctx.quadraticCurveTo(-3 * f, 4 * f, -6 * f, 7 * f);
  ctx.quadraticCurveTo(0, 10 * f, 6 * f, 7 * f);
  ctx.stroke();
  // Mouth
  ctx.beginPath();
  ctx.moveTo(-11 * f, 19 * f);
  ctx.quadraticCurveTo(0, 15 * f, 11 * f, 19 * f);
  ctx.moveTo(-8 * f, 20 * f);
  ctx.quadraticCurveTo(0, 26 * f, 8 * f, 20 * f);
  ctx.stroke();
  ctx.restore();
}

function drawHem(ctx: CanvasRenderingContext2D) {
  // Folded hem: a slightly darker strip along every edge.
  const hem = 14;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.05)";
  ctx.fillRect(0, 0, LAYOUT_W, hem);
  ctx.fillRect(0, LAYOUT_H - hem, LAYOUT_W, hem);
  ctx.fillRect(0, hem, hem, LAYOUT_H - hem * 2);
  ctx.fillRect(LAYOUT_W - hem, hem, hem, LAYOUT_H - hem * 2);
  ctx.strokeStyle = "rgba(0,0,0,0.10)";
  ctx.lineWidth = 0.8;
  ctx.strokeRect(hem, hem, LAYOUT_W - hem * 2, LAYOUT_H - hem * 2);
  // Stitch line inside the hem
  ctx.setLineDash([5, 3.5]);
  ctx.strokeStyle = "rgba(40,40,60,0.28)";
  ctx.lineWidth = 1;
  ctx.strokeRect(hem / 2, hem / 2, LAYOUT_W - hem, LAYOUT_H - hem);
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPatch(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number, img: LogoImage | null, radius = 9,
) {
  const x = cx - w / 2, y = cy - h / 2;
  const inset = Math.max(6, radius * 0.6);
  const dark = !!img && img.width > 0 && needsDarkPatch(img);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.22)";
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = dark ? PATCH_DARK : PATCH_LIGHT;
  roundRect(ctx, x, y, w, h, radius);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = dark ? "rgba(255,255,255,0.3)" : "rgba(60,60,70,0.35)";
  ctx.lineWidth = 0.9;
  roundRect(ctx, x + inset, y + inset, w - inset * 2, h - inset * 2, radius * 0.55);
  ctx.stroke();
  ctx.restore();

  if (img && img.width > 0 && img.height > 0) {
    // Keep the logo's aspect ratio inside the patch.
    const box = Math.min(w, h) * 0.74;
    const boxW = w - (Math.min(w, h) - box);
    const k = Math.min(boxW / img.width, box / img.height);
    const dw = img.width * k, dh = img.height * k;
    ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
  }
}

// ---------- Weave ----------

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plain weave, 4 px thread pitch. Builds a 512 px tile, then fills full-size canvases.
 * Returns a gray overlay (multiply) and a tangent-space normal map.
 */
export function buildWeave(width = LAYOUT_W * TEX_SCALE, height = LAYOUT_H * TEX_SCALE) {
  const T = 512;
  const PITCH = 4;
  const rand = mulberry32(1816);
  const threadW = new Float32Array(T / PITCH).map(() => 0.85 + rand() * 0.3); // warp variation
  const threadH = new Float32Array(T / PITCH).map(() => 0.85 + rand() * 0.3); // weft variation
  const height2 = new Float32Array(T * T);
  for (let y = 0; y < T; y++) {
    const j = Math.floor(y / PITCH);
    const fy = (y % PITCH + 0.5) / PITCH;
    for (let x = 0; x < T; x++) {
      const i = Math.floor(x / PITCH);
      const fx = (x % PITCH + 0.5) / PITCH;
      const warpUp = (i + j) % 2 === 0;
      // Thread profile: round across the thread, dips toward the crossing ends.
      const h = warpUp
        ? Math.sin(Math.PI * fx) * (0.75 + 0.25 * Math.sin(Math.PI * fy)) * threadW[i]
        : Math.sin(Math.PI * fy) * (0.75 + 0.25 * Math.sin(Math.PI * fx)) * threadH[j];
      height2[y * T + x] = h + (rand() - 0.5) * 0.08;
    }
  }

  const overlayTile = createCanvas(T, T);
  const normalTile = createCanvas(T, T);
  const o = overlayTile.getContext("2d")!.createImageData(T, T);
  const nm = normalTile.getContext("2d")!.createImageData(T, T);
  const strength = 2.2;
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const k = y * T + x;
      const h = height2[k];
      const g = Math.round(255 * Math.min(1, 0.8 + 0.2 * h));
      o.data[k * 4] = g;
      o.data[k * 4 + 1] = g;
      o.data[k * 4 + 2] = g;
      o.data[k * 4 + 3] = 255;
      const hl = height2[y * T + ((x - 1 + T) % T)];
      const hr = height2[y * T + ((x + 1) % T)];
      const hu = height2[((y - 1 + T) % T) * T + x];
      const hd = height2[((y + 1) % T) * T + x];
      // Canvas y points down; tangent-space y points up (texture flipY).
      let nx = (hl - hr) * strength, ny = (hd - hu) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      nm.data[k * 4] = Math.round((nx * 0.5 + 0.5) * 255);
      nm.data[k * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      nm.data[k * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      nm.data[k * 4 + 3] = 255;
    }
  }
  overlayTile.getContext("2d")!.putImageData(o, 0, 0);
  normalTile.getContext("2d")!.putImageData(nm, 0, 0);

  const fill = (tile: HTMLCanvasElement) => {
    const c = createCanvas(width, height);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = ctx.createPattern(tile, "repeat")!;
    ctx.fillRect(0, 0, width, height);
    return c;
  };
  return { overlay: fill(overlayTile), normal: fill(normalTile) };
}
