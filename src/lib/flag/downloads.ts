// Download presets. `free` is the part of the image the flags may use (fractions of width and height):
// each platform puts something on top of the picture, and the flags stay clear of it.

export interface Preset {
  id: string;
  label: string;
  w: number;
  h: number;
  free: [x0: number, y0: number, x1: number, y1: number];
}

export const PRESETS: Preset[] = [
  // X puts the profile photo over the bottom left of the header.
  { id: "x-header", label: "Header de X", w: 1500, h: 500, free: [0.26, 0.06, 0.97, 0.94] },
  // LinkedIn puts the profile photo over the bottom left of the banner, and it is taller there.
  { id: "linkedin", label: "Banner de LinkedIn", w: 1584, h: 396, free: [0.32, 0.06, 0.98, 0.94] },
  // Phone lock screen: clock on top, buttons at the bottom. Centered; narrow, so the flags stack on one pole.
  { id: "phone", label: "Wallpaper de celu", w: 1170, h: 2532, free: [0.08, 0.24, 0.92, 0.76] },
  { id: "desktop", label: "Wallpaper desktop 4K", w: 3840, h: 2160, free: [0.1, 0.12, 0.9, 0.88] },
  // Zoom: the person covers the middle and bottom. The flags fly above their head.
  { id: "zoom", label: "Fondo de Zoom", w: 1920, h: 1080, free: [0.08, 0.04, 0.92, 0.44] },
];

export function freeRect(p: Preset) {
  const [x0, y0, x1, y1] = p.free;
  return { x: x0 * p.w, y: y0 * p.h, w: (x1 - x0) * p.w, h: (y1 - y0) * p.h };
}

export function saveBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
