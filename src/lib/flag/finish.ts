// Print finish for downloaded wallpapers: a soft vignette and a fine film grain.
// The render alone reads as a screenshot; this makes it read as a photograph.
// The grain also dithers the sky gradient, so a JPEG shows no banding.

export interface FinishOptions {
  /** How dark the corners go, 0..1. */
  vignette?: number;
  /** Grain strength in 8-bit levels at mid-grey. */
  grain?: number;
}

/** Applies the finish in place to a 2D canvas of `w` x `h`. */
export function applyFinish(ctx: CanvasRenderingContext2D, w: number, h: number, opts: FinishOptions = {}) {
  // On top of the post chain's own vignette, which a 4K still makes too faint to see.
  const { vignette = 0.26, grain = 4 } = opts;
  drawVignette(ctx, w, h, vignette);
  addGrain(ctx, w, h, grain);
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

/** An elliptical vignette that follows the frame's shape. It starts well out from the middle, so the flags stay clear. */
function drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number, strength: number) {
  if (strength <= 0) return;
  const r = Math.hypot(w, h) / 2;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(w / (2 * r), h / (2 * r)); // circle to ellipse
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.42);
  // Many stops on a smooth curve: two stops give a visible ring.
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const k = Math.max(0, (t - 0.45) / 0.55);
    g.addColorStop(t, `rgba(10,12,20,${(strength * k * k * (3 - 2 * k)).toFixed(4)})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(-r * 1.5, -r * 1.5, r * 3, r * 3);
  ctx.restore();
}

/**
 * Monochrome grain, strongest in the midtones like film: the clean highlights and the deep shadows keep less of it.
 * The grain size grows with the image, so a 4K wallpaper does not get a dust of single pixels.
 */
function addGrain(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number) {
  if (amount <= 0) return;
  const cell = Math.max(1, Math.round(Math.max(w, h) / 2400)); // 1 px up to ~2.4K, 2 px at 4K
  const nw = Math.ceil(w / cell), nh = Math.ceil(h / cell);
  const noise = new Float32Array(nw * nh);
  let s = 0x9e3779b9 ^ (w * 73856093) ^ (h * 19349663);
  const rand = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  // Sum of three uniforms: close enough to a gaussian, zero mean, unit-ish spread.
  for (let i = 0; i < noise.length; i++) noise[i] = (rand() + rand() + rand() - 1.5) * 2;

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const row = ((y / cell) | 0) * nw;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const lum = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) / 255;
      const n = noise[row + ((x / cell) | 0)] * amount * (0.35 + 2.6 * lum * (1 - lum));
      d[p] += n;
      d[p + 1] += n;
      d[p + 2] += n;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export function canvasToBlob(c: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("No se pudo generar la imagen."))), type, quality),
  );
}
