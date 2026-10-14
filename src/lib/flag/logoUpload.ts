// Logo upload, in the browser: decode (PNG, JPG, WebP, SVG), remove the background, trim, pick the
// default flag color, and export the PNG the server stores. The server re-encodes it again.
import { rgbToHex } from "@/lib/startups/model";
import { solidBorderColor } from "./startup";
import { prepareLogo, type LogoImage } from "./texture";

export const ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml";
const SVG_SIDE = 1024; // an SVG has no pixels: rasterize it at this size
const MAX_BYTES = 1024 * 1024;
const ML_TIMEOUT_MS = 45_000;

export interface PreparedLogo {
  logo: HTMLCanvasElement;
  bg: string; // default flag color
  png: Blob; // what gets uploaded
  removal: "ml" | "solid" | "none";
}

export async function decodeImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) {
      // An SVG without width and height: give it a square box.
      img.width = SVG_SIDE;
      img.height = SVG_SIDE;
    }
    return img;
  } finally {
    // Safe after decode(): the pixels are in the element.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Draws any image to a canvas. SVGs are scaled up so they are sharp on the flag. */
function rasterize(img: HTMLImageElement, isSvg: boolean): HTMLCanvasElement {
  const w0 = img.naturalWidth || SVG_SIDE, h0 = img.naturalHeight || SVG_SIDE;
  const k = isSvg ? SVG_SIDE / Math.max(w0, h0) : Math.min(1, 2048 / Math.max(w0, h0));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w0 * k));
  c.height = Math.max(1, Math.round(h0 * k));
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/** True when the border is mostly transparent: the logo has no background to remove. */
function hasTransparentBorder(c: HTMLCanvasElement): boolean {
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const { width: w, height: h } = c;
  const top = ctx.getImageData(0, 0, w, 1).data, bottom = ctx.getImageData(0, h - 1, w, 1).data;
  const left = ctx.getImageData(0, 0, 1, h).data, right = ctx.getImageData(w - 1, 0, 1, h).data;
  let clear = 0, n = 0;
  for (const row of [top, bottom, left, right]) {
    for (let i = 3; i < row.length; i += 4) {
      n++;
      if (row[i] < 32) clear++;
    }
  }
  return clear / n > 0.6;
}

/**
 * Background removal with @imgly/background-removal (ONNX model, runs on the device).
 * The model files (about 40 MB, cached by the browser) come from IMG.LY's CDN on first use.
 * Loaded only when a logo needs it, so the page itself stays light.
 */
async function removeWithModel(c: HTMLCanvasElement): Promise<LogoImage> {
  const { removeBackground } = await import("@imgly/background-removal");
  const input = await new Promise<Blob>((r, j) => c.toBlob((b) => (b ? r(b) : j(new Error("encode"))), "image/png"));
  const run = removeBackground(input, { model: "isnet_quint8", output: { format: "image/png" } });
  const timeout = new Promise<never>((_, j) => setTimeout(() => j(new Error("timeout")), ML_TIMEOUT_MS));
  return decodeImage(await Promise.race([run, timeout]));
}

async function toPng(c: HTMLCanvasElement): Promise<Blob> {
  let canvas = c;
  for (let attempt = 0; attempt < 4; attempt++) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("encode");
    if (blob.size <= MAX_BYTES) return blob;
    const next = document.createElement("canvas");
    next.width = Math.round(canvas.width * 0.75);
    next.height = Math.round(canvas.height * 0.75);
    next.getContext("2d")!.drawImage(canvas, 0, 0, next.width, next.height);
    canvas = next;
  }
  throw new Error("too big");
}

/**
 * Full pipeline. `removeBg` false keeps the image as is (a logo the model would damage).
 * When the model fails or times out, a flat background is still removed by flood fill.
 */
export async function prepareUpload(file: File, removeBg: boolean, onStage?: (s: string) => void): Promise<PreparedLogo> {
  const isSvg = file.type === "image/svg+xml";
  const img = await decodeImage(file);
  const base = rasterize(img, isSvg);
  let source: LogoImage = base;
  let removal: PreparedLogo["removal"] = "none";
  if (removeBg && !hasTransparentBorder(base)) {
    onStage?.("Quitando el fondo…");
    try {
      source = await removeWithModel(base);
      removal = "ml";
    } catch (e) {
      console.warn("[logo] background model failed, using flat removal", e);
      removal = "solid";
    }
  }
  onStage?.("Recortando…");
  // Read the box color from the original pixels: after removal, only the mark is left.
  const box = solidBorderColor(base.getContext("2d")!.getImageData(0, 0, base.width, base.height).data, base.width, base.height);
  const { logo, bg } = prepareLogo(source, removal === "solid", box && rgbToHex(box));
  return { logo, bg, png: await toPng(logo), removal };
}
