// Procedural noise, drawn once on the CPU into a small tileable texture. The cloud shaders sum octaves of it.
// Nothing is downloaded: the texture is 256² and builds in a few milliseconds.
//
// Channels:
//   R: value noise, 32 cells          (fbm detail)
//   G: puffs, 8 cells                 (big cumulus domes: inverted Worley, spherical caps)
//   B: puffs, 16 cells, other seed    (smaller domes)
//   A: value noise, 4 cells           (regional variation)
import * as THREE from "three";

const S = 256;

function hash(x: number, y: number, seed: number) {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 982451653);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(cells: number, seed: number, out: Float32Array) {
  const wrap = (v: number) => ((v % cells) + cells) % cells;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const fx = (x / S) * cells, fy = (y / S) * cells;
      const xi = Math.floor(fx), yi = Math.floor(fy);
      const xf = fx - xi, yf = fy - yi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = hash(wrap(xi), wrap(yi), seed), b = hash(wrap(xi + 1), wrap(yi), seed);
      const c = hash(wrap(xi), wrap(yi + 1), seed), d = hash(wrap(xi + 1), wrap(yi + 1), seed);
      out[y * S + x] = a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    }
  }
}

/** Spherical caps around jittered points: the round tops of cumulus clouds. */
function puffs(cells: number, seed: number, out: Float32Array) {
  const wrap = (v: number) => ((v % cells) + cells) % cells;
  const pts: number[] = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const r = 0.55 + 0.45 * hash(i, j, seed + 2);
      pts.push(i + 0.15 + 0.7 * hash(i, j, seed), j + 0.15 + 0.7 * hash(i, j, seed + 1), r);
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const fx = (x / S) * cells, fy = (y / S) * cells;
      const xi = Math.floor(fx), yi = Math.floor(fy);
      let best = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = xi + dx, cy = yi + dy;
          const k = (wrap(cy) * cells + wrap(cx)) * 3;
          const px = cx - wrap(cx) + pts[k], py = cy - wrap(cy) + pts[k + 1], r = pts[k + 2] * 0.95;
          const d2 = ((fx - px) ** 2 + (fy - py) ** 2) / (r * r);
          if (d2 < 1) {
            // Rounded top, soft foot: no vertical walls where two domes meet.
            const k = 1 - d2, foot = Math.min(1, k / 0.25);
            best = Math.max(best, Math.pow(k, 0.6) * foot * foot * (3 - 2 * foot) * (0.6 + 0.4 * r));
          }
        }
      }
      out[y * S + x] = best;
    }
  }
}

let cached: THREE.DataTexture | null = null;

/** Shared 256² RGBA noise texture. Repeat wrapping, mipmapped. */
export function noiseTexture(): THREE.DataTexture {
  if (cached) return cached;
  const r = new Float32Array(S * S), g = new Float32Array(S * S), b = new Float32Array(S * S), a = new Float32Array(S * S);
  valueNoise(32, 11, r);
  puffs(8, 23, g);
  puffs(16, 41, b);
  valueNoise(4, 57, a);
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    data[i * 4] = Math.round(r[i] * 255);
    data[i * 4 + 1] = Math.round(g[i] * 255);
    data[i * 4 + 2] = Math.round(b[i] * 255);
    data[i * 4 + 3] = Math.round(a[i] * 255);
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}

/** GLSL helpers that read the noise texture. Needs `uniform sampler2D uNoise;`. */
export const NOISE_GLSL = /* glsl */ `
float nVal(vec2 p) { return texture2D(uNoise, p).r; }
float nPuffBig(vec2 p) { return texture2D(uNoise, p).g; }
float nPuffSmall(vec2 p) { return texture2D(uNoise, p).b; }
float nRegion(vec2 p) { return texture2D(uNoise, p).a; }
const mat2 NROT = mat2(0.8, 0.6, -0.6, 0.8);
float fbm4(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * nVal(p); p = NROT * p * 2.03 + 0.17; a *= 0.5; }
  return s / 0.9375;
}
`;


let cachedBillow: THREE.Data3DTexture | null = null;

/**
 * Tileable 3D noise for cloud edges, 32³ RGBA:
 *   R: inverted Worley (round billows, the "cauliflower" look of cumulus), 4 cells per tile
 *   G: inverted Worley, 8 cells per tile
 *   B: value noise, 8 cells per tile (soft breakup)
 * 128 KB, built once (about 30 ms).
 */
export function billowTexture3D(): THREE.Data3DTexture {
  if (cachedBillow) return cachedBillow;
  const N = 32;
  const data = new Uint8Array(N * N * N * 4);
  const worley = (cells: number, seed: number) => {
    const pts = new Float32Array(cells * cells * cells * 3);
    for (let i = 0; i < cells * cells * cells; i++) {
      pts[i * 3] = hash(i, 1, seed); pts[i * 3 + 1] = hash(i, 2, seed); pts[i * 3 + 2] = hash(i, 3, seed);
    }
    const wrap = (v: number) => ((v % cells) + cells) % cells;
    return (x: number, y: number, z: number) => {
      const fx = (x / N) * cells, fy = (y / N) * cells, fz = (z / N) * cells;
      const xi = Math.floor(fx), yi = Math.floor(fy), zi = Math.floor(fz);
      let best = 9;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx, cy = yi + dy, cz = zi + dz;
        const k = ((wrap(cz) * cells + wrap(cy)) * cells + wrap(cx)) * 3;
        const ddx = cx + pts[k] - fx, ddy = cy + pts[k + 1] - fy, ddz = cz + pts[k + 2] - fz;
        best = Math.min(best, ddx * ddx + ddy * ddy + ddz * ddz);
      }
      return Math.max(0, 1 - Math.sqrt(best) * 1.15);
    };
  };
  const w4 = worley(4, 5), w8 = worley(8, 9);
  const vc = 8;
  const vwrap = (v: number) => ((v % vc) + vc) % vc;
  const lattice = (x: number, y: number, z: number) => hash(vwrap(x) + vwrap(z) * 64, vwrap(y), 13);
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const k = ((z * N + y) * N + x) * 4;
        data[k] = Math.round(w4(x, y, z) * 255);
        data[k + 1] = Math.round(w8(x, y, z) * 255);
        const fx = (x / N) * vc, fy = (y / N) * vc, fz = (z / N) * vc;
        const xi = Math.floor(fx), yi = Math.floor(fy), zi = Math.floor(fz);
        const u = fx - xi, v = fy - yi, w = fz - zi;
        const s = (a: number) => a * a * (3 - 2 * a);
        let val = 0;
        for (let c = 0; c < 8; c++) {
          const ox = c & 1, oy = (c >> 1) & 1, oz = (c >> 2) & 1;
          const wgt = (ox ? s(u) : 1 - s(u)) * (oy ? s(v) : 1 - s(v)) * (oz ? s(w) : 1 - s(w));
          val += wgt * lattice(xi + ox, yi + oy, zi + oz);
        }
        data[k + 2] = Math.round(val * 255);
        data[k + 3] = 255;
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  cachedBillow = tex;
  return tex;
}
