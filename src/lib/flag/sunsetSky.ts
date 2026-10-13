// Sunset sky for the Hall of Fame: Preetham sky (three's Sky.js), two layers of high clouds lit gold and
// rose, a bright sun mesh (the god-ray source), and a PMREM environment built from the same sky, so the
// metal poles reflect gold.
import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { NOISE_GLSL, noiseTexture } from "./noise";

export const SKY_PARAMS = { turbidity: 10, rayleigh: 3, mieCoefficient: 0.005, mieDirectionalG: 0.9 };
const SKY_SCALE = 18000;
const DOME_RADIUS = 12000;
const SUN_DISTANCE = 9000;

/** Unit vector toward the sun, from elevation and azimuth in degrees. Azimuth 0 = straight down -z. */
export function sunDirection(elevationDeg: number, azimuthDeg: number) {
  const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
  const theta = THREE.MathUtils.degToRad(azimuthDeg);
  return new THREE.Vector3(Math.sin(phi) * Math.sin(theta), Math.cos(phi), -Math.sin(phi) * Math.cos(theta));
}

function makeSky(sunDir: THREE.Vector3, exposure: number, haze?: { horizon: THREE.Color; sunColor: THREE.Color }) {
  const sky = new Sky();
  const u = sky.material.uniforms;
  u.turbidity.value = SKY_PARAMS.turbidity;
  u.rayleigh.value = SKY_PARAMS.rayleigh;
  u.mieCoefficient.value = SKY_PARAMS.mieCoefficient;
  u.mieDirectionalG.value = SKY_PARAMS.mieDirectionalG;
  u.sunPosition.value.copy(sunDir);
  // Sky.js has no exposure control; scale its output so it sits with the rest of the scene. The output is
  // capped under the bloom threshold: the Mie peak around the sun is huge and would bloom into a big disk.
  // The sun mesh, not the sky, carries the bloom and the god rays.
  u.uExposure = { value: exposure };
  // The low sky melts into the same haze as the far cloud sea. Preetham alone is a cool grey there, and
  // that grey band showed between the pink sky and the warm cloud horizon. Strength 0 turns the blend off.
  u.uHorizon = { value: haze?.horizon ?? new THREE.Color() };
  u.uSunColor = { value: haze?.sunColor ?? new THREE.Color() };
  u.uHazeStrength = { value: haze ? 1 : 0 };
  sky.material.fragmentShader = sky.material.fragmentShader
    .replace("uniform vec3 up;", "uniform vec3 up;\nuniform float uExposure;\nuniform vec3 uHorizon;\nuniform vec3 uSunColor;\nuniform float uHazeStrength;")
    // No solar disc here: at this elevation it turns red and blooms pink. The sun mesh draws the disc.
    .replace("L0 += ( vSunE * 19000.0 * Fex ) * sundisk;", "L0 += 0.0 * sundisk;")
    // A warm tint and a wide golden glow around the sun: the Preetham model alone reads pale and cool.
    .replace("vec3 retColor =", "texColor += vec3(0.30, 0.17, 0.07) * (pow(max(cosTheta, 0.0), 8.0) * 0.012 + pow(max(cosTheta, 0.0), 120.0) * 0.12 + pow(max(cosTheta, 0.0), 30.0) * 0.05);\nvec3 retColor =")
    .replace("gl_FragColor = vec4( retColor, 1.0 );", "vec3 skyOut = retColor * vec3(1.1, 0.92, 0.95) * uExposure;\nskyOut *= min(1.0, 2.6 / max(max(skyOut.r, skyOut.g), max(skyOut.b, 1e-4)));\nfloat hs = max(dot(direction, vSunDirection), 0.0);\nvec3 haze = uHorizon + uSunColor * (pow(hs, 6.0) * 0.55 + pow(hs, 60.0) * 1.6);\nskyOut = mix(skyOut, haze, uHazeStrength * (1.0 - smoothstep(0.0, 0.16, direction.y)));\ngl_FragColor = vec4( skyOut, 1.0 );");
  sky.material.needsUpdate = true;
  return sky;
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
    // Shadow side: dusky violet overhead, warm rust toward the horizon. Lit side: gold to cream.
    vec3 shade = mix(vec3(0.5, 0.32, 0.5), vec3(0.85, 0.45, 0.42), smoothstep(0.35, 0.03, elev) * 0.7 + near * 0.6);
    vec3 lit = mix(vec3(1.9, 1.05, 0.82), vec3(2.4, 1.7, 1.2), near);
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
  sky: Sky;
  dome: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private time = { value: 0 };

  constructor(private look: SunsetLook, exposure = 1) {
    this.sky = makeSky(look.sunDir, exposure, look);
    this.sky.scale.setScalar(SKY_SCALE);
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
          uDeck0: { value: new THREE.Vector4(2500, 7000, 0.53, 0) },
          uDeck1: { value: new THREE.Vector4(1100, 9000, 0.6, 3.7) },
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
    this.sun.visible = false; // the sun is never drawn: it sits behind the viewer and only lights the scene
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

  /** Sunset environment for reflections: the same sky, plus a warm cloud floor below the horizon. */
  environment(renderer: THREE.WebGLRenderer): THREE.Texture {
    const env = new THREE.Scene();
    const sky = makeSky(this.look.sunDir, 1);
    sky.scale.setScalar(90);
    env.add(sky);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(80, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0xe8b8a0).multiplyScalar(0.9), side: THREE.DoubleSide }),
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
