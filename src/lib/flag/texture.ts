// Canvas drawing for the flags: the Argentine flag (official colors, Sun of May), the startup flag
// (logo centered on a color), the hem, and the fabric weave.
import { dominantColor, defaultBackground } from "@/lib/startups/model";
import { removeSolidBackground, visibleBounds } from "./startup";

export type LogoImage = CanvasImageSource & { width: number; height: number };

/** Flag proportions 14:9 (Argentine law 2.1:1.35 rounded). Layout units; canvases scale them. */
export const LAYOUT_W = 1400;
export const LAYOUT_H = 900;
export const FLAG_ASPECT = LAYOUT_W / LAYOUT_H;

export const COLORS = {
  blue: "#74ACDF", // celeste oficial
  white: "#FFFFFF",
  sun: "#F6B40E",
  sunLine: "#85340A",
};

/** Free border around the logo on the startup flag, per side. */
export const LOGO_MARGIN = 0.2;

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function withLayout(canvas: HTMLCanvasElement, draw: (ctx: CanvasRenderingContext2D) => void) {
  const ctx = canvas.getContext("2d")!;
  ctx.save();
  ctx.setTransform(canvas.width / LAYOUT_W, 0, 0, canvas.height / LAYOUT_H, 0, 0);
  draw(ctx);
  ctx.restore();
}

function applyWeave(canvas: HTMLCanvasElement, weave?: HTMLCanvasElement | null) {
  if (!weave) return;
  const ctx = canvas.getContext("2d")!;
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.drawImage(weave, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

/** The Argentine flag, clean: three bands and the Sun of May. Nothing else is ever drawn on it. */
export function drawArgentineFlag(canvas: HTMLCanvasElement, weave?: HTMLCanvasElement | null): void {
  withLayout(canvas, (ctx) => {
    const band = LAYOUT_H / 3;
    ctx.fillStyle = COLORS.blue;
    ctx.fillRect(0, 0, LAYOUT_W, band);
    ctx.fillStyle = COLORS.white;
    ctx.fillRect(0, band, LAYOUT_W, band);
    ctx.fillStyle = COLORS.blue;
    ctx.fillRect(0, band * 2, LAYOUT_W, LAYOUT_H - band * 2);
    // Sun diameter is 5/6 of the white band.
    drawSun(ctx, LAYOUT_W / 2, LAYOUT_H / 2, band * 0.42);
    drawHem(ctx);
  });
  applyWeave(canvas, weave);
}

export interface StartupFlagOptions {
  logo: LogoImage | null; // null = still loading, or no logo yet (preview)
  bg: string;
  weave?: HTMLCanvasElement | null;
}

/** A startup's flag: one color, the logo centered with a 20% margin on every side. */
export function drawStartupFlag(canvas: HTMLCanvasElement, opts: StartupFlagOptions): void {
  withLayout(canvas, (ctx) => {
    ctx.fillStyle = opts.bg;
    ctx.fillRect(0, 0, LAYOUT_W, LAYOUT_H);
    drawHem(ctx);
  });
  const img = opts.logo;
  if (img && img.width > 0 && img.height > 0) {
    // In canvas pixels, so the logo keeps its own aspect ratio.
    const ctx = canvas.getContext("2d")!;
    const boxW = canvas.width * (1 - 2 * LOGO_MARGIN), boxH = canvas.height * (1 - 2 * LOGO_MARGIN);
    const k = Math.min(boxW / img.width, boxH / img.height);
    const dw = img.width * k, dh = img.height * k;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  }
  applyWeave(canvas, opts.weave);
}

/** Longest side of a prepared logo, in pixels. */
export const LOGO_MAX = 1024;

/**
 * Cleans a logo that already lost its background: trims the empty border.
 * Also returns the default flag color (dominant color inverted, or white).
 * `solidFallback`: when the ML step did not run, removes a flat background box by flood fill.
 */
export function prepareLogo(img: LogoImage, solidFallback = false): { logo: HTMLCanvasElement; bg: string } {
  const k = Math.min(1, LOGO_MAX / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  if (solidFallback) {
    removeSolidBackground(data.data, w, h);
    ctx.putImageData(data, 0, 0);
  }
  const bg = defaultBackground(dominantColor(data.data));
  const b = visibleBounds(data.data, w, h);
  if (!b) return { logo: c, bg };
  const out = createCanvas(b.w, b.h);
  out.getContext("2d")!.drawImage(c, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  return { logo: out, bg };
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
  // Folded hem: a double layer of cloth along every edge. Darker (denser), with a soft fold line inside.
  const hem = 16;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.07)";
  ctx.fillRect(0, 0, LAYOUT_W, hem);
  ctx.fillRect(0, LAYOUT_H - hem, LAYOUT_W, hem);
  ctx.fillRect(0, hem, hem, LAYOUT_H - hem * 2);
  ctx.fillRect(LAYOUT_W - hem, hem, hem, LAYOUT_H - hem * 2);
  // The fold of the cloth casts a thin soft line where the hem ends.
  ctx.strokeStyle = "rgba(0,0,0,0.12)";
  ctx.lineWidth = 1.6;
  ctx.strokeRect(hem + 0.8, hem + 0.8, LAYOUT_W - hem * 2 - 1.6, LAYOUT_H - hem * 2 - 1.6);
  // Two stitch lines, as a sewing machine leaves them.
  ctx.setLineDash([5, 3.5]);
  ctx.strokeStyle = "rgba(40,40,60,0.22)";
  ctx.lineWidth = 1;
  ctx.strokeRect(hem * 0.35, hem * 0.35, LAYOUT_W - hem * 0.7, LAYOUT_H - hem * 0.7);
  ctx.strokeRect(hem * 0.75, hem * 0.75, LAYOUT_W - hem * 1.5, LAYOUT_H - hem * 1.5);
  ctx.restore();
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
export function buildWeave(width: number, height: number) {
  const T = 512;
  const PITCH = 4;
  const rand = mulberry32(1816);
  const threadW = new Float32Array(T / PITCH).map(() => 0.96 + rand() * 0.08); // warp variation: small, or mipmaps turn it into stripes
  const threadH = new Float32Array(T / PITCH).map(() => 0.96 + rand() * 0.08); // weft variation
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
  const strength = 1.6;
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const k = y * T + x;
      const h = height2[k];
      const g = Math.round(255 * Math.min(1, 0.92 + 0.08 * h));
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
