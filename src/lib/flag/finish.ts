// Print finish for downloaded wallpapers. The render alone reads as a screenshot; this makes it read as a
// frame of film shot through a real lens. In order, on the averaged render:
//
//   lens:    chromatic aberration (red and blue split toward the corners, the middle stays sharp)
//   film:    halation (a red-orange glow bleeds around the brightest edges, as light scatters in the film base)
//            diffusion (a soft, wide bloom of the whole image, like a mist filter: the highlights breathe)
//            anamorphic streak (a thin horizontal flare through the sun, as a cinema lens draws it)
//   grade:   vibrance, an S-curve, teal shadows, gold highlights, a little less color in the deepest shadows
//   light:   a warm leak from the sun's side of the frame
//   print:   an elliptical vignette and a midtone-weighted film grain
//
// All of it runs on the CPU, once, on a 2D canvas: no frame budget, and no shader state to restore.
// The grain also dithers the sky gradient, so a JPEG shows no banding.

export interface FinishOptions {
  /** Where the sun is in the frame, 0..1 from the top left. The light leak and the halation tint follow it. */
  sun?: { x: number; y: number };
  /** How dark the corners go, 0..1. */
  vignette?: number;
  /** Grain strength in 8-bit levels at mid-grey. */
  grain?: number;
  /** Red/blue split at the corners, as a fraction of the half-diagonal. */
  aberration?: number;
  /** Halation strength and the brightness (0..1) where it starts. */
  halation?: number;
  halationThreshold?: number;
  /** Mist-filter diffusion strength, 0..1. */
  diffusion?: number;
  /** S-curve contrast, 0..1. */
  contrast?: number;
  /** Split-tone strength, 0..1. */
  tone?: number;
  /** Warm light leak strength, 0..1. */
  leak?: number;
  /** Saturation boost for the muted colors, 0..1. */
  vibrance?: number;
  /** Anamorphic lens streak through the brightest highlights, 0..1. */
  streak?: number;
}

export const FINISH_DEFAULTS: Required<Omit<FinishOptions, "sun">> = {
  vignette: 0.3,
  grain: 4.5,
  aberration: 0.0016,
  // Tuned at 1:1 on the backlit Argentine flag: more leak, halation or streak than this blows its white
  // stripe to flat cream and turns its blue milky; more tone pushes the celeste toward teal.
  halation: 0.28,
  halationThreshold: 0.8,
  diffusion: 0.1,
  contrast: 0.5,
  tone: 0.5,
  leak: 0.08,
  vibrance: 0.25,
  streak: 0.14,
};

/** Applies the finish in place to a 2D canvas of `w` x `h`. */
export function applyFinish(ctx: CanvasRenderingContext2D, w: number, h: number, opts: FinishOptions = {}) {
  const o = { ...FINISH_DEFAULTS, ...opts };
  const sun = opts.sun ?? { x: 0.5, y: 0.35 };

  // Blurred layers, built small and read back at full size with bilinear sampling.
  const mist = blurred(ctx.canvas, w, h, 48, null);
  const halo = blurred(ctx.canvas, w, h, 160, o.halationThreshold);
  // Anamorphic streak: a thin horizontal line through the sun's core, as bright as the sun shows in the frame
  // (a sun hidden behind a flag throws a weaker one).
  const sunHot = Math.min(1, (halo.at(sun.x, sun.y, 0) + halo.at(sun.x, sun.y, 1)) * 1.5);
  const streakK = o.streak * sunHot;
  const thin = 1 / (0.0035 * h), soft = 1 / (0.022 * h), far = 1 / (0.42 * w);

  const img = ctx.getImageData(0, 0, w, h);
  const src = img.data.slice();
  const d = img.data;
  const noise = grainField(w, h);

  const cx = w / 2, cy = h / 2;
  const invDiag = 1 / Math.hypot(cx, cy);
  const ab = o.aberration * Math.hypot(cx, cy); // pixels at the corner
  const sx = sun.x * w, sy = sun.y * h;
  const leakR = 1 / (0.75 * Math.hypot(w, h));
  const aspect = w / h;

  for (let y = 0; y < h; y++) {
    const ny = (y - cy) * invDiag;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const nx = (x - cx) * invDiag;
      const r2 = nx * nx + ny * ny; // 0 in the middle, 1 at the corners

      // Lens: red pushed out, blue pulled in, growing with the square of the distance from the middle.
      const k = ab * r2;
      let r: number, g: number, b: number;
      if (k > 0.05) {
        const len = Math.sqrt(r2) / invDiag || 1;
        const ux = (x - cx) / len, uy = (y - cy) / len;
        r = sample(src, w, h, x + ux * k, y + uy * k, 0);
        g = src[p + 1];
        b = sample(src, w, h, x - ux * k, y - uy * k, 2);
      } else {
        r = src[p]; g = src[p + 1]; b = src[p + 2];
      }
      r /= 255; g /= 255; b /= 255;

      // Film: mist (screen blend, so it lifts without clipping) and halation (added, tinted red-orange).
      const u = x / w, v = y / h;
      const m = o.diffusion;
      if (m > 0) {
        const mr = mist.at(u, v, 0), mg = mist.at(u, v, 1), mb = mist.at(u, v, 2);
        r = 1 - (1 - r) * (1 - mr * m);
        g = 1 - (1 - g) * (1 - mg * m);
        b = 1 - (1 - b) * (1 - mb * m);
      }
      if (streakK > 0) {
        const dy = y - sy, ex = Math.exp(-Math.abs(x - sx) * far);
        const t1 = dy * thin, t2 = dy * soft;
        const s = (Math.exp(-t1 * t1) + 0.25 * Math.exp(-t2 * t2)) * ex * streakK;
        r += s * 1.0;
        g += s * 0.72;
        b += s * 0.5;
      }
      if (o.halation > 0) {
        const hl = halo.at(u, v, 0) * 0.5 + halo.at(u, v, 1) * 0.5;
        r += hl * o.halation * 1.0;
        g += hl * o.halation * 0.36;
        b += hl * o.halation * 0.12;
      }

      // Grade: a soft shoulder first, so the light added above rolls off instead of clipping a backlit cloth
      // to flat cream. Then an S-curve per channel, then split-tone by luminance.
      const c = o.contrast;
      r = shoulder(r); g = shoulder(g); b = shoulder(b);
      r += c * (r * r * (3 - 2 * r) - r);
      g += c * (g * g * (3 - 2 * g) - g);
      b += c * (b * b * (3 - 2 * b) - b);
      // Vibrance: lifts the muted colors more than the vivid ones, so skin-like golds do not go neon.
      if (o.vibrance > 0) {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const l0 = r * 0.2126 + g * 0.7152 + b * 0.0722;
        const k = 1 + o.vibrance * (1 - (mx - mn));
        r = l0 + (r - l0) * k; g = l0 + (g - l0) * k; b = l0 + (b - l0) * k;
      }
      const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
      const sh = (1 - lum) * (1 - lum) * o.tone, hi = lum * lum * o.tone;
      r += -0.035 * sh + 0.045 * hi;
      g += 0.01 * sh + 0.018 * hi;
      b += 0.045 * sh - 0.05 * hi;
      // Deep shadows lose a little color, as film does.
      const desat = Math.max(0, 0.25 - lum) * 1.2;
      r += (lum - r) * desat; g += (lum - g) * desat; b += (lum - b) * desat;

      // Light leak: warm glow from the sun's side, falling off over most of the frame.
      if (o.leak > 0) {
        const dx = (x - sx) * leakR, dy = (y - sy) * leakR * aspect * 0.6;
        const l = Math.exp(-(dx * dx + dy * dy) * 6) * o.leak;
        r = 1 - (1 - r) * (1 - l * 1.0);
        g = 1 - (1 - g) * (1 - l * 0.62);
        b = 1 - (1 - b) * (1 - l * 0.32);
      }

      // Vignette: smooth, starts well out from the middle so the flags stay clear.
      const vk = Math.max(0, (r2 - 0.18) / 0.82);
      const vig = 1 - o.vignette * vk * vk * (3 - 2 * vk);
      r *= vig; g *= vig * 0.995; b *= vig * 0.985 + 0.012 * (1 - vig);

      // Grain: monochrome, strongest in the midtones.
      const lum2 = r * 0.299 + g * 0.587 + b * 0.114;
      const n = (noise.at(x, y) * o.grain * (0.35 + 2.6 * lum2 * (1 - lum2))) / 255;
      d[p] = (r + n) * 255 + 0.5;
      d[p + 1] = (g + n) * 255 + 0.5;
      d[p + 2] = (b + n) * 255 + 0.5;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Linear up to 0.75, then an exponential roll-off that reaches 1 only at infinity. */
function shoulder(x: number) {
  if (x < 0) return 0;
  if (x <= 0.75) return x;
  return 0.75 + 0.25 * (1 - Math.exp(-(x - 0.75) / 0.25));
}

/** Bilinear read of one channel. */
function sample(d: Uint8ClampedArray, w: number, h: number, x: number, y: number, ch: number) {
  x = Math.min(w - 1.001, Math.max(0, x));
  y = Math.min(h - 1.001, Math.max(0, y));
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const i = (y0 * w + x0) * 4 + ch, j = i + w * 4;
  return (d[i] * (1 - fx) + d[i + 4] * fx) * (1 - fy) + (d[j] * (1 - fx) + d[j + 4] * fx) * fy;
}

/**
 * A blurred copy of `src`, kept small: `radius` is the blur in output pixels. Halving the image step by step
 * with smoothing is a box blur each time; a few steps make it close to gaussian. With `threshold`, only the
 * part of each pixel above it survives (the highlights), before the blur.
 */
function blurred(src: CanvasImageSource, w: number, h: number, radius: number, threshold: number | null) {
  const steps = Math.max(1, Math.round(Math.log2(radius)));
  let cw = w, ch = h;
  let cur: HTMLCanvasElement | null = null;
  for (let i = 0; i < steps; i++) {
    cw = Math.max(2, Math.round(cw / 2));
    ch = Math.max(2, Math.round(ch / 2));
    const c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    const x = c.getContext("2d", { willReadFrequently: true })!;
    x.imageSmoothingQuality = "high";
    x.drawImage(cur ?? src, 0, 0, cw, ch);
    if (i === 1 && threshold !== null) {
      const im = x.getImageData(0, 0, cw, ch);
      // Keep the share of each pixel over the threshold, rescaled so the brightest white keeps full strength.
      const t = threshold * 255;
      for (let k = 0; k < im.data.length; k += 4) {
        const l = Math.max(im.data[k], im.data[k + 1], im.data[k + 2]);
        const f = l > t ? (l - t) / (255 - t) : 0;
        im.data[k] *= f; im.data[k + 1] *= f; im.data[k + 2] *= f;
      }
      x.putImageData(im, 0, 0);
    }
    cur = c;
  }
  // One more pass: a 3x3 tent at the smallest size smooths the box steps away.
  const data = cur!.getContext("2d")!.getImageData(0, 0, cw, ch).data;
  const sm = new Float32Array(cw * ch * 3);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0, wt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(ch - 1, Math.max(0, y + dy));
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(cw - 1, Math.max(0, x + dx));
            const k = (2 - Math.abs(dx)) * (2 - Math.abs(dy));
            acc += data[(yy * cw + xx) * 4 + c] * k;
            wt += k;
          }
        }
        sm[(y * cw + x) * 3 + c] = acc / wt / 255;
      }
    }
  }
  return {
    /** Bilinear read at (u, v) in 0..1, channel 0..2. */
    at(u: number, v: number, c: number) {
      const x = Math.min(cw - 1.001, Math.max(0, u * cw - 0.5));
      const y = Math.min(ch - 1.001, Math.max(0, v * ch - 0.5));
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const i = (y0 * cw + x0) * 3 + c, j = i + cw * 3;
      return (sm[i] * (1 - fx) + sm[i + 3] * fx) * (1 - fy) + (sm[j] * (1 - fx) + sm[j + 3] * fx) * fy;
    },
  };
}

/**
 * Zero-mean grain, about unit spread. Its size grows with the image, so a 4K wallpaper does not get a dust
 * of single pixels.
 */
function grainField(w: number, h: number) {
  const cell = Math.max(1, Math.round(Math.max(w, h) / 2400)); // 1 px up to ~2.4K, 2 px at 4K
  const nw = Math.ceil(w / cell), nh = Math.ceil(h / cell);
  const noise = new Float32Array(nw * nh);
  let s = 0x9e3779b9 ^ (w * 73856093) ^ (h * 19349663);
  const rand = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  // Sum of three uniforms: close enough to a gaussian.
  for (let i = 0; i < noise.length; i++) noise[i] = (rand() + rand() + rand() - 1.5) * 2;
  return { at: (x: number, y: number) => noise[((y / cell) | 0) * nw + ((x / cell) | 0)] };
}

/**
 * Averages frames into one image: supersampling without a bigger drawing buffer. Each `add` reads one
 * rendered frame (call it in the same task as the render: WebGL drops the buffer after). A 16-bit sum
 * keeps it exact for up to 257 frames.
 */
export class FrameAverage {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  private sum: Uint16Array;
  private n = 0;

  constructor(readonly w: number, readonly h: number) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
    this.sum = new Uint16Array(w * h * 4);
  }

  add(src: CanvasImageSource) {
    this.ctx.drawImage(src, 0, 0, this.w, this.h);
    const d = this.ctx.getImageData(0, 0, this.w, this.h).data;
    for (let i = 0; i < d.length; i++) this.sum[i] += d[i];
    this.n++;
  }

  /** Writes the average into `canvas` and returns its context. */
  resolve(): CanvasRenderingContext2D {
    const img = this.ctx.createImageData(this.w, this.h);
    const d = img.data, inv = 1 / Math.max(1, this.n);
    for (let i = 0; i < d.length; i++) d[i] = this.sum[i] * inv + 0.5;
    this.ctx.putImageData(img, 0, 0);
    return this.ctx;
  }
}

export function canvasToBlob(c: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("No se pudo generar la imagen."))), type, quality),
  );
}
