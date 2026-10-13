// Flag motion in the vertex shader. The cloth is a flat plane; the GPU bends it every frame.
// No CPU simulation: 1 flag or 1,000 flags cost the same on the main thread.
//
// Local space: the hoist edge (on the pole) is x = 0, the fly end is x = width.
// The top edge is y = 0, the bottom edge is y = -height.
//
// Every time frequency is a whole multiple of 2π / 4 s, so the motion repeats exactly every
// 4 seconds. That makes the 4 s video export a seamless loop. Wind changes amplitude, not speed,
// so the loop holds at any wind.
import * as THREE from "three";

export const LOOP_SECONDS = 4;

export const WAVE_GLSL = /* glsl */ `
uniform float uTime;
uniform float uWind;
uniform vec2 uSize;
#ifdef FLAG_INSTANCED
attribute float aPhase;
#else
uniform float uPhase;
#endif

#ifdef FLAG_GUSTS
// Simplex noise 3D (Ashima Arts, MIT).
vec4 snPerm(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = snPerm(snPerm(snPerm(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  vec3 ns = vec3(0.285714285714, -0.928571428571, 0.142857142857);
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = inversesqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
#endif

#ifndef FLAG_GUSTS
// Pair page: one flag up close, so it must read as heavy cloth, not a board.
// Every time term is a whole multiple of t, so the 4 s loop holds, gusts included.
vec3 flagDisplace(vec3 p, float phase) {
  float L = uSize.x, H = uSize.y;
  float u = clamp(p.x / L, 0.0, 1.0);   // 0 at the pole, 1 at the fly end
  float v = clamp(-p.y / H, 0.0, 1.0);  // 0 at the top, 1 at the bottom
  float w = clamp(uWind, 0.0, 2.0);
  float wn = min(w, 1.0);
  float t = uTime * 1.5707963 + phase;  // 2π / 4 s
  // Each flag gets its own wavelength and depth from its phase, so two flags never look cloned.
  float seed = sin(phase * 1.7 + 0.3);
  const float TAU = 6.2831853;

  // Gust: a swell that runs from the pole to the fly end, twice per loop.
  float gust = 1.0 + 0.24 * sin(t - 2.2 * u + 0.6 * seed) + 0.1 * sin(2.0 * t - 3.6 * u + 2.0);
  // Pinned at the pole, free at the fly end.
  float env = u * (0.4 + 0.6 * u);
  // Crest lines lean, and the lean changes over time: folds run diagonal, not straight down.
  float lean = 1.0 + 0.45 * sin(t + 2.5 * u);
  float k1 = TAU * (1.05 + 0.1 * seed);
  float k2 = TAU * (2.05 - 0.12 * seed);
  float z = 0.62 * sin(k1 * u - 2.0 * t + v * lean)
          + 0.34 * sin(k2 * u - 3.0 * t - v * 1.7 + 1.3)
          + 0.11 * sin(TAU * 3.6 * u - 5.0 * t + v * 2.9) * (0.3 + 0.7 * u);
  float amp = H * 0.19 * (1.0 + 0.12 * seed) * (0.3 + 0.7 * wn + 0.3 * max(w - 1.0, 0.0));
  z *= env * gust * amp;
  // The free edge snaps faster than the body of the cloth.
  z += H * 0.018 * smoothstep(0.82, 1.0, u) * sin(7.0 * t + v * 9.0 + seed) * wn * gust;
  // The hoist is held at two clips only: between them the cloth bellies downwind and breathes.
  float belly = sin(3.1415927 * v);
  float near = (1.0 - u) * (1.0 - u);
  z += H * 0.02 * belly * near * sin(2.0 * t + 0.5) * wn;
  float x = p.x + H * 0.025 * belly * near * (1.0 - u) * wn;

  // Cloth does not stretch: the deeper the folds, the shorter the flag looks.
  float slope = amp * gust * 0.62 * k1 / L;
  x -= u * L * 0.25 * slope * slope;
  // Calm air: the cloth hangs. The fly end drops and the flag gets narrower.
  float calm = clamp(1.0 - w, 0.0, 1.0);
  x *= 1.0 - 0.28 * calm * u;
  // Gravity, even in wind: the fly end sags, the bottom corner most, and less when a gust lifts it.
  float sag = 0.045 * (1.5 - 0.5 * gust) * (0.7 + 0.6 * v) + 0.55 * calm;
  float y = p.y - pow(u, 1.6) * H * sag;
  // A small lift and flutter along the free edge in strong wind.
  y += 0.02 * H * u * sin(3.0 * t + v * 4.0) * w;
  return vec3(x, y, z);
}
#else
// Pole position in world xz. Gust fronts are a field in world space, so neighbors feel the same gust.
vec2 flagOrigin() {
#ifdef USE_INSTANCING
  return (modelMatrix * instanceMatrix[3]).xz;
#else
  return modelMatrix[3].xz;
#endif
}

// Hall of Fame: many small flags seen face-on.
// No two flags share a rhythm: each has its own beat (from its phase), and gust fronts roll across the
// field downwind (+x), so a gust reaches one row of flags, then the next. In a lull the cloth droops.
vec3 flagDisplace(vec3 p, float phase) {
  float u = clamp(p.x / uSize.x, 0.0, 1.0);   // 0 at the pole, 1 at the fly end
  float v = clamp(-p.y / uSize.y, 0.0, 1.0);  // 0 at the top, 1 at the bottom
  vec2 o = flagOrigin();
  float front = snoise(vec3((o.x - uTime * 7.0) / 38.0, o.y / 30.0, uTime * 0.06));
  float w = clamp(uWind * (0.88 + 0.3 * front), 0.0, 2.0);
  float beat = 0.78 + 0.44 * fract(sin(phase * 91.7) * 4375.85);
  float t = uTime * 1.5707963 * beat + phase;
  float k = 6.2831853 / uSize.x;

  // Travelling waves from the pole outward. Amplitude grows toward the free edge.
  float z = 0.62 * sin(1.3 * k * p.x - 2.0 * t + v * 0.7)
          + 0.24 * sin(2.6 * k * p.x - 3.0 * t + v * 1.9)
          + 0.10 * sin(4.4 * k * p.x - 5.0 * t - v * 2.6) * w;
  float grow = u * (0.35 + 0.65 * u);
  z *= grow * uSize.y * 0.21 * (0.25 + 0.55 * min(w, 1.0) + 0.25 * max(w - 1.0, 0.0));

  // Calm air: the cloth hangs. The fly end drops and the flag gets narrower.
  float calm = clamp(1.0 - w, 0.0, 1.0);
  float x = p.x * (1.0 - 0.28 * calm * u);
  float y = p.y - u * u * uSize.y * 0.55 * calm;
  // A small lift and flutter along the free edge in strong wind.
  y += 0.03 * uSize.y * u * sin(3.0 * t + v * 4.0) * w;
  // Simplex ripples that travel downwind, and slow gusts that swell and calm each flag on its own
  // beat (the 4 s export loop does not apply here).
  float gust = 0.8 + 0.22 * sin(uTime * 0.37 + phase * 0.31) + 0.12 * sin(uTime * 1.13 + phase * 1.7);
  float rip = snoise(vec3(p.x / uSize.x * 2.2 - uTime * 1.1 * beat,p.y / uSize.y * 1.6, phase));
  // Deeper folds than the original pair wave: shallow waves read as flat boards face-on.
  z = (z * gust + rip * u * uSize.y * 0.07 * gust) * 2.2;
  // The fold pulls the free end a little toward the pole.
  x -= u * u * abs(z) * 0.35;
  return vec3(x, y, z);
}
#endif
`;

// Fold shading (pair page): the inside of a fold gets less sky and less sun, and sun behind the
// cloth shows through it. The hem is a double layer, so less light passes there.
const FOLD_VERTEX = /* glsl */ `
#ifdef FLAG_FOLD_AO
  vec3 fmx = flagDisplace(position - vec3(0.02 * uSize.x, 0.0, 0.0), fPhase);
  float fdx = 0.02 * uSize.x;
  // Curvature across the folds, scaled by the flag height so it does not depend on flag size.
  vFlagCurv = (fpx.z + fmx.z - 2.0 * fp0.z) / (fdx * fdx) * uSize.y;
#endif
`;

const FOLD_FRAGMENT = /* glsl */ `
#include <lights_fragment_end>
{
  // Front faces look at +z: a fold that curves away from the viewer is a valley on this side.
  float side = gl_FrontFacing ? 1.0 : -1.0;
  float valley = smoothstep(0.0, 2.2, vFlagCurv * side);
  float ao = 1.0 - 0.32 * valley;
  reflectedLight.indirectDiffuse *= ao;
  reflectedLight.directDiffuse *= mix(1.0, ao, 0.5);
#ifdef USE_MAP
  vec2 fuv = vMapUv;
  float edge = min(min(fuv.x, 1.0 - fuv.x) * 14.0, min(fuv.y, 1.0 - fuv.y) * 9.0);
  float hem = 1.0 - smoothstep(0.1, 0.16, edge);
#else
  float hem = 0.0;
#endif
  // Sun behind the cloth: light that comes through, strongest where the cloth faces away from it.
  vec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  float through = pow(max(dot(-normal, sunV), 0.0), 3.0);
  totalEmissiveRadiance += diffuseColor.rgb * uSunColor * uTranslucency * through * (1.0 - 0.65 * hem) * ao;
}
`;

const PHASE = /* glsl */ `
#ifdef FLAG_INSTANCED
  float fPhase = aPhase;
#else
  float fPhase = uPhase;
#endif
`;

const NORMAL = /* glsl */ `
${PHASE}
  vec3 fp0 = flagDisplace(position, fPhase);
  vec3 fpx = flagDisplace(position + vec3(0.02 * uSize.x, 0.0, 0.0), fPhase);
  vec3 fpy = flagDisplace(position - vec3(0.0, 0.02 * uSize.y, 0.0), fPhase);
  vec3 objectNormal = normalize(cross(fpx - fp0, fp0 - fpy));
${FOLD_VERTEX}
  #ifdef USE_TANGENT
    vec3 objectTangent = vec3(tangent.xyz);
  #endif
`;

const BEGIN = /* glsl */ `
#ifndef FLAG_HAS_NORMAL
${PHASE}
#endif
  vec3 transformed = flagDisplace(position, fPhase);
`;

export interface WaveUniforms {
  uTime: { value: number };
  uWind: { value: number };
  uSize: { value: THREE.Vector2 };
  uPhase: { value: number };
  [key: string]: { value: unknown };
}

export function waveUniforms(width: number, height: number, phase = 0): WaveUniforms {
  return {
    uTime: { value: 0 },
    uWind: { value: 1 },
    uSize: { value: new THREE.Vector2(width, height) },
    uPhase: { value: phase },
  };
}

/** Sun for the fold shading: direction toward the sun (world), its color, and how much passes the cloth. */
export interface FoldUniforms {
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uTranslucency: { value: number };
}

export function foldUniforms(sunDir: THREE.Vector3, sunColor: THREE.Color, translucency: number): FoldUniforms {
  return { uSunDir: { value: sunDir.clone().normalize() }, uSunColor: { value: sunColor }, uTranslucency: { value: translucency } };
}

/**
 * Adds the wave to a built-in material. The material keeps its lighting, shadows, and maps.
 * `fold`: also darken the inside of folds and let the sun show through (lit materials only).
 */
export function applyWave<M extends THREE.Material>(
  material: M, uniforms: WaveUniforms, instanced = false, gusts = false, fold: FoldUniforms | null = null,
): M {
  const hasNormal = !(material instanceof THREE.MeshDepthMaterial) && !(material instanceof THREE.MeshDistanceMaterial);
  const withFold = hasNormal && !!fold;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, withFold ? fold : {});
    const defs = `${instanced ? "#define FLAG_INSTANCED\n" : ""}${hasNormal ? "#define FLAG_HAS_NORMAL\n" : ""}${gusts ? "#define FLAG_GUSTS\n" : ""}${withFold ? "#define FLAG_FOLD_AO\nvarying float vFlagCurv;\n" : ""}`;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${defs}${WAVE_GLSL}`)
      .replace("#include <beginnormal_vertex>", hasNormal ? NORMAL : "#include <beginnormal_vertex>")
      .replace("#include <begin_vertex>", BEGIN);
    if (withFold) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying float vFlagCurv;\nuniform vec3 uSunDir;\nuniform vec3 uSunColor;\nuniform float uTranslucency;",
        )
        .replace("#include <lights_fragment_end>", FOLD_FRAGMENT);
    }
  };
  // One compiled program per variant, not per material.
  material.customProgramCacheKey = () => `flag-wave-${instanced ? "i" : "s"}${gusts ? "g" : ""}${withFold ? "f" : ""}`;
  return material;
}

/** Depth material for shadows, bent by the same wave. Without it the shadow would be a flat rectangle. */
export function waveDepthMaterial(uniforms: WaveUniforms, map?: THREE.Texture | null): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: map ?? null, alphaTest: map ? 0.5 : 0 });
  return applyWave(m, uniforms);
}

/** Plane in flag local space: hoist edge at x = 0, top edge at y = 0. */
export function flagGeometry(width: number, height: number, segX: number, segY: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(width, height, segX, segY);
  g.translate(width / 2, -height / 2, 0);
  return g;
}
