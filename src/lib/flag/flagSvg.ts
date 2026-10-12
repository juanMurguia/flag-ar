// The Argentine flag as SVG, for places without WebGL or canvas: the Open Graph image and the grid view.
// Same geometry as the canvas drawing: bands, and a Sun of May with 16 straight and 16 wavy rays.
import { COLORS, LAYOUT_H, LAYOUT_W } from "./texture";

function sunPath(cx: number, cy: number, R: number): string {
  const r0 = R * 0.42;
  const parts: string[] = [];
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2 - Math.PI / 2;
    const rot = (x: number, y: number) =>
      `${(cx + x * Math.cos(a) - y * Math.sin(a)).toFixed(1)},${(cy + x * Math.sin(a) + y * Math.cos(a)).toFixed(1)}`;
    if (k % 2 === 0) {
      parts.push(`M${rot(r0 - 2, -6.5)}L${rot(R, 0)}L${rot(r0 - 2, 6.5)}Z`);
    } else {
      const len = R * 0.92 - r0, pts = 18;
      const left: string[] = [], right: string[] = [];
      for (let i = 0; i <= pts; i++) {
        const t = i / pts;
        const x = r0 - 2 + t * len;
        const off = Math.sin(t * Math.PI * 3) * 3.2 * (1 - t * 0.4);
        const hw = 5.5 * (1 - t) + 0.3;
        left.push(rot(x, off - hw));
        right.push(rot(x, off + hw));
      }
      parts.push(`M${left.join("L")}L${right.reverse().join("L")}Z`);
    }
  }
  return parts.join("");
}

export function argentineFlagSvg(): string {
  const band = LAYOUT_H / 3, cx = LAYOUT_W / 2, cy = LAYOUT_H / 2, R = band * 0.42, r0 = R * 0.42;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LAYOUT_W} ${LAYOUT_H}" width="${LAYOUT_W}" height="${LAYOUT_H}">`
    + `<rect width="${LAYOUT_W}" height="${LAYOUT_H}" fill="${COLORS.blue}"/>`
    + `<rect y="${band}" width="${LAYOUT_W}" height="${band}" fill="${COLORS.white}"/>`
    + `<path d="${sunPath(cx, cy, R)}" fill="${COLORS.sun}" stroke="${COLORS.sunLine}" stroke-width="1.2" stroke-linejoin="round"/>`
    + `<circle cx="${cx}" cy="${cy}" r="${r0}" fill="${COLORS.sun}" stroke="${COLORS.sunLine}" stroke-width="1.6"/>`
    + `</svg>`;
}

export function argentineFlagDataUrl(): string {
  return `data:image/svg+xml;base64,${typeof btoa === "function" ? btoa(argentineFlagSvg()) : Buffer.from(argentineFlagSvg()).toString("base64")}`;
}
