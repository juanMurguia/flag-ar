// Ethereal backdrop: not a literal sky. A dome that wraps the flag in soft dusk colors, with no horizon and
// no ground. A small aura of warm light always sits behind the flag, as seen from the camera. A sun, fixed in
// the world, is the light source: the scene lights point from it. Faint veils of mist drift across the dome.
import * as THREE from "three";

/** CSS gradient shown while WebGL loads, and on the no-WebGL page. Matches the dome at the default view. */
export const SUNSET_CSS =
  "radial-gradient(ellipse at 50% 55%, #fff1d6 0%, #f6c78f 14%, #d99aa6 34%, #6f62a3 62%, #2a2b62 100%)";

/** Sun direction in world space: up and to the right of the flag in the default view. */
export const SUN_DIR = new THREE.Vector3(0.5, 0.2, -1).normalize();

const DOME_RADIUS = 600;

// ---------- Noise ----------

/** Tileable 256² value noise (32 cells) in the red channel. The shader sums octaves of it. */
function noiseTexture(): THREE.DataTexture {
  const S = 256, C = 32;
  const hash = (x: number, y: number) => {
    let n = Math.imul(((x % C) + C) % C, 374761393) + Math.imul(((y % C) + C) % C, 668265263) + 982451653 * 7;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const fx = (x / S) * C, fy = (y / S) * C;
      const xi = Math.floor(fx), yi = Math.floor(fy);
      const xf = fx - xi, yf = fy - yi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
      const k = (y * S + x) * 4;
      data[k] = Math.round((a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 255);
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ---------- Dome ----------

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const DOME_FRAG = /* glsl */ `
uniform vec3 auraDir;
uniform vec3 sunDir;
uniform sampler2D noiseTex;
uniform float time;
varying vec3 vDir;

#define PI 3.14159265

vec3 lin(float r, float g, float b) { return pow(vec3(r, g, b), vec3(2.2)); }

float n1(vec2 p) { return texture2D(noiseTex, p).r; }

const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);

float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * n1(p);
    p = ROT * p * 2.03 + 0.17;
    a *= 0.5;
  }
  return s;
}

// Mist on the sphere with no seams: three planar projections, blended by the direction.
float mist(vec3 d, float t) {
  vec3 w = pow(abs(d), vec3(4.0));
  w /= w.x + w.y + w.z;
  return fbm(d.yz * 0.9 + vec2(t, 0.31)) * w.x
       + fbm(d.xz * 0.9 + vec2(0.57, t * 0.7)) * w.y
       + fbm(d.xy * 0.9 + vec2(-t, 0.83)) * w.z;
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec3 d = normalize(vDir);
  float y = d.y;

  // Base: a soft vertical gradient that never meets a horizon. Indigo above, warm light in the
  // middle band, lilac haze below. Nothing goes dark.
  vec3 col = lin(0.98, 0.80, 0.62);
  col = mix(col, lin(0.85, 0.60, 0.66), smoothstep(0.02, 0.22, y));
  col = mix(col, lin(0.42, 0.38, 0.66), smoothstep(0.18, 0.5, y));
  col = mix(col, lin(0.15, 0.16, 0.38), smoothstep(0.45, 1.0, y));
  vec3 below = mix(lin(0.90, 0.66, 0.70), lin(0.58, 0.48, 0.74), smoothstep(-0.05, -0.4, y));
  below = mix(below, lin(0.36, 0.32, 0.60), smoothstep(-0.4, -1.0, y));
  col = mix(col, below, smoothstep(0.02, -0.12, y));

  // Away from the aura the space cools to lavender; toward it, it warms.
  float ca = dot(d, auraDir);
  float a = acos(clamp(ca, -1.0, 1.0));
  col *= mix(vec3(0.42, 0.42, 0.72), vec3(1.0), smoothstep(-0.4, 0.95, ca));

  // Veils of mist, drifting slowly. Warm near the aura, pale lilac far from it.
  float m = smoothstep(0.42, 0.72, mist(d, time * 0.004));
  vec3 veil = mix(lin(0.80, 0.78, 0.98), lin(1.0, 0.86, 0.70), smoothstep(0.0, 0.9, ca));
  col = mix(col, col * 0.6 + veil * 0.55, m * 0.45);

  // Aura: a small white-gold core, a golden halo, and a rose bloom, held close to the flag.
  vec3 aura = lin(1.0, 0.96, 0.88) * exp(-a * a * 80.0) * 0.7
            + lin(1.0, 0.78, 0.48) * exp(-a * 7.0) * 0.5
            + lin(0.95, 0.58, 0.68) * exp(-a * 3.0) * 0.18;
  col += aura * (1.0 - m * 0.3); // the mist veils the light a little

  // The sun: the light source of the scene, fixed in the world. A bright disk, a hot corona, and a
  // warm glow that spreads into the space around it.
  float s = acos(clamp(dot(d, sunDir), -1.0, 1.0));
  vec3 sun = lin(1.0, 0.84, 0.60) * exp(-s * 2.2) * 0.35
           + lin(1.0, 0.80, 0.52) * exp(-s * 9.0) * 0.8
           + lin(1.0, 0.93, 0.78) * exp(-s * 28.0) * 1.6
           + lin(1.0, 0.98, 0.92) * exp(-s * 90.0) * 2.5;
  sun += vec3(4.0) * (1.0 - smoothstep(0.006, 0.012, s)); // soft-edged disk, burned out like in a photo
  col += sun * (1.0 - m * 0.25);

  // Gentle filmic shoulder, then sRGB. Dither: no banding in the gradients.
  col = 1.0 - exp(-col * 1.0);
  vec3 outc = pow(col, vec3(1.0 / 2.2));
  outc += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(outc, 1.0);
}`;

export interface SkyDome extends THREE.Mesh {
  material: THREE.ShaderMaterial;
}

export function buildSkyDome(renderer: THREE.WebGLRenderer): SkyDome {
  const noise = noiseTexture();
  noise.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      auraDir: { value: new THREE.Vector3(0, 0, -1) },
      sunDir: { value: SUN_DIR.clone() },
      noiseTex: { value: noise },
      time: { value: 0 },
    },
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 48, 24), mat) as SkyDome;
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  return dome;
}

/** Points the aura from the camera through the flag, so it always glows behind it. */
export function setAuraFrom(dome: SkyDome, camera: THREE.Camera) {
  (dome.material.uniforms.auraDir.value as THREE.Vector3).copy(camera.position).negate().normalize();
}

export function disposeSkyDome(dome: SkyDome) {
  dome.geometry.dispose();
  (dome.material.uniforms.noiseTex.value as THREE.Texture).dispose();
  dome.material.dispose();
}

/** Advances the mist drift. Seconds; it stops with the wind. */
export function setSkyTime(dome: SkyDome, seconds: number) {
  dome.material.uniforms.time.value = seconds;
}
