// Rock for the Hall of Fame: a crag under each pole that breaks through the cloud tops (the poles stand on
// something), and far spires out in the sea that give the scene its scale.
//
// Shapes are displaced icosphere meshes (value-noise fbm with a ridged term), welded so they shade smooth,
// with a tiling stone normal map for the grain. Vertex colors darken the crevices and warm the upward faces
// (dust and dry lichen). The cloud sea writes its own depth, so every rock sinks into the clouds on its own.
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { SKY_GOLD, SKY_LOW, SUN_GLOW_GLSL } from "./sunsetSky";
import { createCanvas } from "./texture";

function hash3(x: number, y: number, z: number) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

function valueNoise(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

function fbm(x: number, y: number, z: number, octaves = 5) {
  let a = 0.5, f = 1, s = 0;
  for (let i = 0; i < octaves; i++) {
    s += a * (valueNoise(x * f, y * f, z * f) - 0.5);
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}

/** Sharp crests: rock breaks along edges, it does not bulge like a blob. */
function ridged(x: number, y: number, z: number) {
  let a = 0.5, f = 1, s = 0;
  for (let i = 0; i < 4; i++) {
    s += a * (1 - Math.abs(valueNoise(x * f, y * f, z * f) * 2 - 1));
    f *= 2.1;
    a *= 0.5;
  }
  return s;
}

interface RockShape {
  seed: number;
  scale: THREE.Vector3;
  /** 0..1: how much the rock narrows toward the top (spires). */
  taper?: number;
  /** Local y over which the top is planed down to a ledge (islands under the poles). Unit sphere space. */
  flatTop?: number;
  /** Stretch of the lower half: rock that runs deep into the clouds never shows its underside in a gap. */
  sink?: number;
  detail?: number;
}

const STONE = new THREE.Color(0.47, 0.41, 0.37);
const CREVICE = new THREE.Color(0.17, 0.14, 0.13);
const DUST = new THREE.Color(0.7, 0.6, 0.5);

function rockGeometry({ seed, scale, taper = 0, flatTop, sink = 1, detail = 5 }: RockShape): THREE.BufferGeometry {
  let geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  geo.deleteAttribute("normal");
  geo.deleteAttribute("uv");
  geo = mergeVertices(geo);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const cavity = new Float32Array(pos.count);
  const n = new THREE.Vector3();
  const o = seed * 17.31;
  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(pos, i).normalize();
    const big = fbm(n.x * 1.4 + o, n.y * 1.4, n.z * 1.4 - o, 4);
    const crest = ridged(n.x * 3.2 - o, n.y * 3.2 + o, n.z * 3.2);
    const grain = fbm(n.x * 9 + o, n.y * 9, n.z * 9, 3);
    const r = 1 + big * 0.4 + (crest - 0.5) * 0.42 + grain * 0.1;
    cavity[i] = crest;
    let x = n.x * r, y = n.y * r, z = n.z * r;
    const k = 1 - taper * THREE.MathUtils.clamp((y + 1) / 2, 0, 1);
    x *= k;
    z *= k;
    if (flatTop !== undefined && y > flatTop) y = flatTop + (y - flatTop) * 0.18;
    if (y < 0) {
      y *= sink;
      // Wider as it goes down, like the roots of a peak.
      x *= 1 + (sink - 1) * 0.25 * Math.min(1, -y / sink);
      z *= 1 + (sink - 1) * 0.25 * Math.min(1, -y / sink);
    }
    pos.setXYZ(i, x * scale.x, y * scale.y, z * scale.z);
  }
  geo.computeVertexNormals();
  const nor = geo.getAttribute("normal") as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    c.copy(CREVICE).lerp(STONE, THREE.MathUtils.smoothstep(cavity[i], 0.25, 0.7));
    c.lerp(DUST, THREE.MathUtils.smoothstep(nor.getY(i), 0.55, 0.95) * 0.55);
    // A few warmer, iron-stained streaks.
    c.multiplyScalar(0.9 + 0.2 * hash3(Math.round(pos.getY(i) * 3), seed, 1));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geo;
}

let stoneNormal: THREE.CanvasTexture | null = null;

/** Tileable stone grain, 256², drawn once: pits and fine cracks, seen up close only. */
function stoneNormalMap(): THREE.CanvasTexture {
  if (stoneNormal) return stoneNormal;
  const S = 256;
  const h = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // Periodic noise: sample on a torus, so the tile repeats without a seam.
      const a = (x / S) * Math.PI * 2, b = (y / S) * Math.PI * 2;
      const px = Math.cos(a) * 2.5, pz = Math.sin(a) * 2.5, py = Math.cos(b) * 2.5, pw = Math.sin(b) * 2.5;
      h[y * S + x] = fbm(px + pw * 0.7, py, pz - pw * 0.4, 5) + 0.35 * ridged(px * 2, py * 2 + pw, pz * 2);
    }
  }
  const c = createCanvas(S, S);
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(S, S);
  const at = (x: number, y: number) => h[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * 3, dy = (at(x, y + 1) - at(x, y - 1)) * 3;
      const len = Math.hypot(dx, dy, 1);
      const k = (y * S + x) * 4;
      img.data[k] = ((dx / len) * 0.5 + 0.5) * 255;
      img.data[k + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      img.data[k + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  stoneNormal = new THREE.CanvasTexture(c);
  stoneNormal.wrapS = stoneNormal.wrapT = THREE.RepeatWrapping;
  stoneNormal.colorSpace = THREE.NoColorSpace;
  return stoneNormal;
}

/**
 * Stone with world-space planar UVs for the grain (icospheres have no usable UVs once displaced): the
 * normal map is sampled on the two vertical planes and blended by the normal, a cheap triplanar.
 */
export function stoneMaterial(look: { sunDir: THREE.Vector3; sunColor: THREE.Color; fogDensity: number }): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.9, metalness: 0,
    normalMap: stoneNormalMap(), normalScale: new THREE.Vector2(0.9, 0.9),
  });
  const uniforms = {
    uSunDir: { value: look.sunDir }, uSunColor: { value: look.sunColor }, uFogDensity: { value: look.fogDensity },
    uSkyLow: { value: SKY_LOW }, uSkyGold: { value: SKY_GOLD },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vStoneW;\nvarying vec3 vStoneN;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvStoneW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvStoneN = normalize(mat3(modelMatrix) * objectNormal);");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vStoneW;
varying vec3 vStoneN;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyLow;
uniform vec3 uSkyGold;
uniform float uFogDensity;
${SUN_GLOW_GLSL}`,
      )
      .replace(
        "#include <aomap_fragment>",
        `#include <aomap_fragment>
{
  // Backlit rock: its outline and the crests turned to the sun catch a warm rim, as stone does at sunset.
  vec3 toEye = normalize(vViewPosition);
  vec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  float against = pow(max(dot(toEye, -sunV), 0.0), 3.0);
  totalEmissiveRadiance += uSunColor * diffuseColor.rgb * 2.2 * against * pow(1.0 - abs(dot(normal, toEye)), 3.0);
}`,
      )
      .replace(
        "#include <fog_fragment>",
        `{
  // The cloud sea's own haze (cloudSea.ts), not the flat scene fog: far rock fades into the sky's colors.
  vec3 rd = normalize(vStoneW - cameraPosition);
  float s = max(dot(rd, uSunDir), 0.0);
  vec3 haze = mix(uSkyLow, uSkyGold, pow(s, 2.5) * 0.75) + uSunColor * sunGlow(s);
  // No mist band at the foot: the cloud sea writes depth, so the clouds hide the rock where they pass over it.
  // A mist painted by height showed as a white skirt even where no cloud stood in front of the rock.
  float d = length(vStoneW - cameraPosition) * uFogDensity;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, haze, 1.0 - exp(-d * d));
}`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `{
  vec3 bw = abs(vStoneN); bw /= (bw.x + bw.y + bw.z);
  vec3 tx = texture2D(normalMap, vStoneW.zy * 0.45).xyz * 2.0 - 1.0;
  vec3 ty = texture2D(normalMap, vStoneW.xz * 0.45).xyz * 2.0 - 1.0;
  vec3 tz = texture2D(normalMap, vStoneW.xy * 0.45).xyz * 2.0 - 1.0;
  // Each projection's tangent xy runs along its plane's two world axes.
  vec3 pert = vec3(0.0, tx.y, tx.x) * bw.x + vec3(ty.x, 0.0, ty.y) * bw.y + vec3(tz.x, tz.y, 0.0) * bw.z;
  normal = normalize(mat3(viewMatrix) * normalize(normalize(vStoneN) + pert * normalScale.x));
}`,
      );
  };
  mat.customProgramCacheKey = () => "stone-triplanar";
  return mat;
}

/**
 * The crag under a pole: a rough island whose planed top stands `top` m up, `radius` m wide, with a cast
 * concrete plinth and a steel flange where the pole goes in. Local origin at the pole's foot on the plinth.
 */
export function poleIsland(mat: THREE.Material, plinthMat: THREE.Material, radius: number, top: number, seed: number, poleRadius: number) {
  const g = new THREE.Group();
  // A peak with its summit planed off: narrow ledge on top, slopes that widen down into the clouds.
  const sy = radius * 3;
  const geo = rockGeometry({ seed, scale: new THREE.Vector3(radius * 2.2, sy, radius * 2), flatTop: 0.7, taper: 0.5, sink: 3, detail: 5 });
  const rock = new THREE.Mesh(geo, mat);
  // The planed top of the unit shape sits near y = 0.74 (flatTop plus a little relief): put it at `top`.
  rock.position.y = top - sy * 0.74;
  rock.rotation.y = seed * 1.7;
  rock.castShadow = rock.receiveShadow = true;
  const plinthH = 0.28;
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(poleRadius * 4.2, poleRadius * 4.8, plinthH + 0.4, 24), plinthMat);
  plinth.position.y = top + plinthH / 2 - 0.2;
  plinth.castShadow = plinth.receiveShadow = true;
  g.add(rock, plinth);
  g.userData.foot = top + plinthH;
  return g;
}

/**
 * Far spires out in the sea, off to both sides of the corridor (never in front of the sun), from a hundred
 * meters to over a kilometer away. The fog turns them into amber silhouettes with distance: that falloff is
 * what tells the eye how big the place is.
 */
export function farCrags(mat: THREE.Material, origin: THREE.Vector3): THREE.Group {
  const g = new THREE.Group();
  const spots = [
    [-0.85, 260, 26], [0.95, 320, 30], [-0.3, 520, 46], [0.33, 610, 52],
    [-1.05, 700, 60], [0.72, 820, 74], [-0.6, 1050, 90], [1.15, 1200, 96], [-1.2, 1400, 120], [0.22, 1500, 110],
  ];
  spots.forEach(([angle, dist, h], k) => {
    const r = h * (0.45 + 0.2 * hash3(k, 3, 9));
    const geo = rockGeometry({ seed: 20 + k, scale: new THREE.Vector3(r, h, r * 0.8), taper: 0.3, detail: dist > 600 ? 3 : 4 });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(origin.x + Math.sin(angle) * dist, -h * 0.35, origin.z - Math.cos(angle) * dist);
    m.rotation.y = k * 2.3;
    g.add(m);
    // A smaller companion beside some spires: rock comes in groups, not one stone each.
    if (k % 3 !== 2) {
      const s = 0.45 + 0.2 * hash3(k, 7, 1);
      const m2 = new THREE.Mesh(geo, mat);
      m2.scale.setScalar(s);
      m2.position.copy(m.position).add(new THREE.Vector3(r * 1.6 * (k % 2 ? 1 : -1), -h * 0.2, r * 0.8));
      m2.rotation.y = k;
      g.add(m2);
    }
  });
  return g;
}
