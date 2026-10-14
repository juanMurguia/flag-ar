// Golden-hour sky for the Hall of Fame: a painted gradient sky (deep blue zenith, gold toward the low
// sun), two layers of high clouds, a bright sun disc in view (the bloom and god-ray source), and a PMREM
// environment built from the same sky, so the metal poles reflect it.
//
// Painted, not physical: the Preetham model (three's Sky.js) reads grey with a low sun, and tone mapping
// greys it further. A hand-set gradient gives the complementary blue and gold of a golden-hour photo.
import * as THREE from "three";
import { NOISE_GLSL, noiseTexture } from "./noise";

const SKY_RADIUS = 18000;
const DOME_RADIUS = 12000;
const SUN_DISTANCE = 9000;

// Sky colors at the horizon. The cloud sea uses them for its far haze, so the sea meets the sky with no seam.
export const SKY_LOW = new THREE.Color(1.0, 0.78, 0.55);
export const SKY_GOLD = new THREE.Color(1.9, 1.0, 0.42);

/**
 * The sun as the sky draws it, in units of uSunColor, for s = dot(view, sun). The sky, the cloud haze and
 * the light through the flags share it, so nothing in front of the sun can shine brighter than the sun.
 */
export const SUN_GLOW_GLSL = /* glsl */ `
float sunGlow(float s) { return pow(s, 8.0) * 0.25 + pow(s, 40.0) * 0.8 + pow(s, 400.0) * 1.2; }`;

/** Unit vector toward the sun, from elevation and azimuth in degrees. Azimuth 0 = straight down -z. */
export function sunDirection(elevationDeg: number, azimuthDeg: number) {
  const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
  const theta = THREE.MathUtils.degToRad(azimuthDeg);
  return new THREE.Vector3(Math.sin(phi) * Math.sin(theta), Math.cos(phi), -Math.sin(phi) * Math.cos(theta));
}

const SKY_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  gl_Position.z = gl_Position.w; // on the far plane, behind everything
}`;

// HDR values, before exposure and tone mapping.
const SKY_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uUpper;
uniform vec3 uLow;
uniform vec3 uGold;
${SUN_GLOW_GLSL}
varying vec3 vWorld;
void main() {
  vec3 d = normalize(vWorld - cameraPosition);
  float h = max(d.y, 0.0);
  float s = max(dot(d, uSunDir), 0.0);
  // Vertical gradient: warm haze at the horizon, clear blue above, deep blue at the zenith.
  vec3 col = mix(uLow, uUpper, smoothstep(0.0, 0.3, h));
  col = mix(col, uZenith, smoothstep(0.3, 1.0, h));
  // The low sky turns gold toward the sun.
  col = mix(col, uGold, pow(s, 2.5) * 0.75 * (1.0 - smoothstep(0.0, 0.45, h)));
  // The sun has no disc: a hot core that falls off smoothly into a halo, then a wide warm glow. A drawn
  // disc reads as a sticker; a burnt-out core with no edge reads as a sun. The core stays moderate: brighter,
  // it clips to a flat circle and bloom spreads that circle into a disc again. The lens glare (post.ts) does the rest.
  col += uSunColor * sunGlow(s);
  gl_FragColor = vec4(col, 1.0);
}`;

function makeSky(sunDir: THREE.Vector3, sunColor: THREE.Color) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: sunDir },
        uSunColor: { value: sunColor },
        uZenith: { value: new THREE.Color(0.06, 0.16, 0.42) },
        uUpper: { value: new THREE.Color(0.22, 0.42, 0.72) },
        uLow: { value: SKY_LOW },
        uGold: { value: SKY_GOLD },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
}

const DOME_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  gl_Position.z = gl_Position.w * 0.99999; // just in front of the sky box
}`;

// High clouds on two virtual planes: altocumulus patches (mackerel sky) up high, a looser band of
// heavier clouds lower down that crowds the horizon. Lit gold toward the sun, rose and violet away from it.
const DOME_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHorizon;
uniform float uTime;
uniform vec4 uDeck0; // height, scale, threshold, seed
uniform vec4 uDeck1;
uniform float uDetail;
varying vec3 vWorld;
${NOISE_GLSL}

float cloudShape(vec2 q, float seed) {
  vec2 warp = vec2(fbm4(q * 0.35 + seed), fbm4(q * 0.35 + 5.2 + seed)) - 0.5;
  q += warp * 0.12;
  float clumps = nPuffSmall(q) * 0.5 + nPuffSmall(q * 2.3 + 0.37) * 0.22 + nPuffBig(q * 0.33 + seed) * 0.4;
  float shape = clumps + (fbm4(q * 1.7) - 0.5) * uDetail + (nPuffSmall(q * 5.1 + 0.6) - 0.5) * 0.12;
  // Two region scales: dense banks, broken patches, and open sky, instead of one even sheet.
  float mask = smoothstep(0.25, 0.65, nRegion(q * 0.045 + seed * 0.3)) * smoothstep(0.15, 0.6, nRegion(NROT * q * 0.13 + 0.61));
  return shape * (0.4 + 0.85 * mask);
}

// One cloud deck on a virtual plane. Returns (density, thickness, light).
vec3 deck(vec3 d, vec4 P) {
  float t = P.x / max(d.y, 0.015);
  // Downwind (+x), like the flags and the sea. The lower deck runs a little faster than the high one.
  vec2 p = cameraPosition.xz + d.xz * t - vec2(uTime * 1.5, uTime * 0.2) * (1.0 + 0.15 * P.w) + P.w * 913.0;
  vec2 q = p / P.y;
  float shape = cloudShape(q, P.w);
  float dens = smoothstep(P.z, P.z + 0.06, shape);
  if (dens <= 0.0) return vec3(0.0);
  float thick = smoothstep(P.z + 0.02, P.z + 0.22, shape);
  // Light: march a short step toward the sun in the deck plane. More cloud that way = in shadow.
  vec2 toSun = normalize(uSunDir.xz + 1e-4) * 0.05;
  float ahead = cloudShape(q + toSun, P.w) + cloudShape(q + toSun * 2.0, P.w);
  float light = exp(-max(ahead * 0.5 - P.z, 0.0) * 6.0);
  return vec3(dens, thick, light);
}

void main() {
  vec3 d = normalize(vWorld - cameraPosition);
  if (d.y < 0.0) discard;
  float s = max(dot(d, uSunDir), 0.0);
  float near = pow(s, 4.0);    // wide warm zone around the sun
  float edge = pow(s, 24.0);   // close to the sun: silver-gold rims
  float elev = d.y;

  vec3 outCol = vec3(0.0);
  float outA = 0.0;
  for (int k = 0; k < 2; k++) {
    // k = 0: high mackerel deck. k = 1: lower, heavier clouds that crowd the horizon.
    vec3 c = deck(d, k == 0 ? uDeck0 : uDeck1);
    // Clear, glowing sky around the sun, as in a real sunset photo: the clouds thin out there.
    c.x *= 1.0 - smoothstep(0.82, 0.985, s) * 0.85;
    if (c.x <= 0.001) continue;
    // Shadow side: dusky mauve overhead, warm rust toward the horizon. Lit side: amber to gold.
    vec3 shade = mix(vec3(0.56, 0.36, 0.42), vec3(0.9, 0.5, 0.36), smoothstep(0.35, 0.03, elev) * 0.7 + near * 0.6);
    vec3 lit = mix(vec3(2.1, 1.3, 0.7), vec3(2.4, 1.7, 1.0), near);
    vec3 col = mix(shade, lit, c.z * (0.7 + 0.3 * (1.0 - c.y)));
    // Silver-gold rims on thin edges near the sun.
    col += uSunColor * edge * (1.0 - c.y) * 2.5;
    // Far clouds melt into the horizon haze.
    col = mix(uHorizon * 1.15 + uSunColor * near * 0.6, col, smoothstep(0.0, 0.14, elev));
    float a = c.x * smoothstep(0.0, 0.04, elev) * (k == 1 ? 0.9 : 0.96);
    outCol = mix(outCol, col, a);
    outA = a + outA * (1.0 - a);
  }
  if (outA < 0.002) discard;
  gl_FragColor = vec4(outCol / max(outA, 1e-3), outA);
}`;

export interface SunsetLook {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  horizon: THREE.Color;
}

export class SunsetSky {
  readonly group = new THREE.Group();
  readonly sun: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  /**
   * God-ray source. Kept out of the scene graph and much dimmer than the visible sun: the effect adds
   * its rays before tone mapping, and a source as bright as the bloom sun turns into a pink disk.
   */
  readonly raySun: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  dome: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private time = { value: 0 };

  constructor(private look: SunsetLook) {
    this.sky = makeSky(look.sunDir, look.sunColor);
    this.sky.scale.setScalar(SKY_RADIUS);
    this.sky.frustumCulled = false;
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(DOME_RADIUS, 64, 32),
      new THREE.ShaderMaterial({
        uniforms: {
          uNoise: { value: noiseTexture() },
          uSunDir: { value: look.sunDir },
          uSunColor: { value: look.sunColor },
          uHorizon: { value: look.horizon },
          uTime: this.time,
          uDeck0: { value: new THREE.Vector4(2500, 7000, 0.9, 0) }, // high thresholds: scattered clouds over open blue
          uDeck1: { value: new THREE.Vector4(1100, 9000, 0.88, 3.7) },
          uDetail: { value: 0.15 },
        },
        vertexShader: DOME_VERT,
        fragmentShader: DOME_FRAG,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -5;
    const sunMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.9, 0.7).multiplyScalar(14), fog: false });
    this.sun = new THREE.Mesh(new THREE.SphereGeometry(125, 24, 12), sunMat);
    this.sun.frustumCulled = false;
    this.sun.visible = false; // never drawn: the sky glow and the lens glare make the sun (see SKY_FRAG)
    const rayMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1, 0.7, 0.35).multiplyScalar(1.4), fog: false, transparent: true, depthWrite: false,
    });
    this.raySun = new THREE.Mesh(new THREE.SphereGeometry(260, 24, 12), rayMat);
    this.raySun.frustumCulled = false;
    this.group.add(this.sky, this.dome, this.sun);
  }

  update(seconds: number, camera: THREE.Camera) {
    this.time.value = seconds;
    this.sky.position.copy(camera.position);
    this.dome.position.copy(camera.position);
    this.sun.position.copy(this.look.sunDir).multiplyScalar(SUN_DISTANCE).add(camera.position);
    this.raySun.position.copy(this.sun.position);
  }

  /** Environment for reflections: the same sky, plus a dusky cloud floor below the horizon (the sea is backlit). */
  environment(renderer: THREE.WebGLRenderer): THREE.Texture {
    const env = new THREE.Scene();
    const sky = makeSky(this.look.sunDir, this.look.sunColor);
    // No far-plane trick here: on the cube camera's far plane the sky clipped away, and the poles reflected black.
    sky.material.vertexShader = SKY_VERT.replace("gl_Position.z = gl_Position.w;", "");
    sky.scale.setScalar(90);
    env.add(sky);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(80, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 0.27, 0.36), side: THREE.DoubleSide }),
    );
    floor.position.y = -3;
    env.add(floor);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const tex = pmrem.fromScene(env, 0.02, 0.1, 200).texture;
    pmrem.dispose();
    sky.geometry.dispose();
    sky.material.dispose();
    floor.geometry.dispose();
    floor.material.dispose();
    return tex;
  }

  dispose() {
    this.raySun.geometry.dispose();
    this.raySun.material.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}
