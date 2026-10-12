// Flagpole: brushed aluminium shaft (tapered, with wear), a satin gilt ball finial over the truck
// (the pulley housing), and optional snap rings.
// Local space: the top of the shaft is y = 0. The shaft runs down to y = -length.
import * as THREE from "three";
import { createCanvas } from "./texture";

export const POLE_RADIUS = 0.16;
export const FINIAL_RADIUS = 0.42;
/** Shaft radius at the foot, as a multiple of the radius at the top. */
const TAPER = 1.35;

let shared: { metal: THREE.MeshStandardMaterial; gold: THREE.MeshStandardMaterial; ring: THREE.TorusGeometry; ball: THREE.SphereGeometry } | null = null;
function parts() {
  shared ??= {
    metal: brushedAluminium(),
    // Satin, weathered gilt: a soft glow, not a mirror ball.
    gold: new THREE.MeshStandardMaterial({ color: 0xb89a62, metalness: 1, roughness: 0.52, envMapIntensity: 0.75 }),
    ring: new THREE.TorusGeometry(POLE_RADIUS * 1.35, 0.035, 8, 20),
    ball: new THREE.SphereGeometry(FINIAL_RADIUS, 32, 20),
  };
  return shared;
}

/**
 * Brushed aluminium. Fine streaks run along the shaft (texture v), so reflections stretch along it;
 * slow blotches and a dirtier foot break the perfect CG gradient. Two gray maps: roughness and tone.
 */
function brushedAluminium(): THREE.MeshStandardMaterial {
  const W = 64, H = 1024;
  const rough = createCanvas(W, H), tone = createCanvas(W, H);
  const ri = rough.getContext("2d")!.createImageData(W, H);
  const ti = tone.getContext("2d")!.createImageData(W, H);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Streaks: one random value per column, smeared along the length.
  const col = Array.from({ length: W }, () => rand());
  const blot = Array.from({ length: 24 }, () => rand());
  for (let y = 0; y < H; y++) {
    const s = (y / H) * (blot.length - 1);
    const i = Math.floor(s), f = s - i;
    const b = blot[i] * (1 - f) + blot[Math.min(i + 1, blot.length - 1)] * f;
    const foot = Math.max(0, (y / H - 0.75) / 0.25); // the bottom quarter sees rain and hands
    for (let x = 0; x < W; x++) {
      const streak = col[x] * 0.6 + rand() * 0.4;
      const k = (y * W + x) * 4;
      const r = Math.min(255, 150 + streak * 40 + b * 30 + foot * 40); // × base roughness: about 0.6 to 1
      const t = 255 - b * 16 - foot * 26 - streak * 8;
      ri.data.set([r, r, r, 255], k);
      ti.data.set([t, t, t, 255], k);
    }
  }
  rough.getContext("2d")!.putImageData(ri, 0, 0);
  tone.getContext("2d")!.putImageData(ti, 0, 0);
  const tex = (c: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.set(3, 1);
    t.anisotropy = 8;
    return t;
  };
  const map = tex(tone);
  map.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({
    // Slightly cool base: the sunset sky it reflects is pink, and real aluminium reads gray, not rose.
    color: 0xc4c9d1, metalness: 0.85, roughness: 0.5, roughnessMap: tex(rough), map, envMapIntensity: 0.7,
  });
}

/** One pole. `clips` are the y values (local) of the rings that hold the flag. */
export function buildPole(length: number, clips: number[], radius = POLE_RADIUS): THREE.Group {
  const p = parts();
  const g = new THREE.Group();
  const k = radius / POLE_RADIUS;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * TAPER, length, 28, 1, true), p.metal);
  shaft.position.y = -length / 2;
  shaft.castShadow = true;
  shaft.receiveShadow = true;
  // Truck: the pulley housing under the ball. The halyard runs through it.
  const truck = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.25, radius * 1.4, 0.34, 24), p.metal);
  truck.position.y = 0.12;
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.7, radius * 1.1, 0.14, 20), p.gold);
  collar.position.y = 0.34;
  const ball = new THREE.Mesh(p.ball, p.gold);
  ball.scale.setScalar(k);
  ball.position.y = 0.38 + FINIAL_RADIUS * 0.92 * k;
  ball.castShadow = true;
  g.add(shaft, truck, collar, ball);
  for (const y of clips) {
    const ring = new THREE.Mesh(p.ring, p.metal);
    ring.rotation.x = Math.PI / 2;
    ring.scale.setScalar(k);
    ring.position.y = y;
    g.add(ring);
  }
  return g;
}

/** Shaft radius at a depth below the top (local y ≤ 0), for things that sit on its surface. */
export function poleRadiusAt(y: number, length: number, radius = POLE_RADIUS): number {
  return radius * (1 + (TAPER - 1) * Math.min(1, Math.max(0, -y / length)));
}

/** Shared pole materials, for the instanced poles in the Hall of Fame. */
export function poleMaterials() {
  const p = parts();
  return { metal: p.metal, gold: p.gold };
}

export function disposePole(g: THREE.Group) {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh && o.geometry instanceof THREE.CylinderGeometry) o.geometry.dispose();
  });
  g.parent?.remove(g);
}
