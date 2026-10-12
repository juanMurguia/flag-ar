// The sea of clouds under the Hall of Fame. No ground: the poles rise out of it.
//
// One plane at the cloud tops. Its fragment shader ray-marches a volume shaped two ways:
// - Macro: a height field of cumulus domes (2D noise). Above it there is nothing, so grazing rays never
//   cross a thin fog layer (that reads as flat haze, not as clouds).
// - Micro: in the top 2.5 m skin, 3D billow noise (inverted Worley) erodes the domes into soft
//   cauliflower edges and wisps.
// Light: shadow from domes toward the sun, extinction with depth, cool sky fill in the shadows.
// It writes the depth where the cloud turns half-opaque, so the poles sink into it with correct occlusion.
// (A height-field surface alone looked like snow; a pure fbm volume looked like fog.)
//
// Quality: STEPS sets the march budget. The low tier uses fewer steps.
import * as THREE from "three";
import { billowTexture3D, NOISE_GLSL, noiseTexture } from "./noise";

export const CLOUD_TOP = 1.2;
export const CLOUD_BOTTOM = -7;

export interface CloudLook {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  horizon: THREE.Color;
  fogDensity: number;
}

const SHADE_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHorizon;
uniform float uFogDensity;

// Haze color seen along direction rd: horizon gold, brighter and whiter toward the sun.
vec3 hazeColor(vec3 rd) {
  float s = max(dot(rd, uSunDir), 0.0);
  vec3 c = uHorizon;
  c += uSunColor * (pow(s, 6.0) * 0.55 + pow(s, 60.0) * 1.6);
  return c;
}

vec3 applyHaze(vec3 col, vec3 rd, float dist) {
  float f = 1.0 - exp(-(dist * uFogDensity) * (dist * uFogDensity)); // same curve as FogExp2
  return mix(col, hazeColor(rd), clamp(f, 0.0, 1.0));
}
`;

const SEA_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const SEA_FRAG = /* glsl */ `
precision highp sampler3D;
uniform sampler2D uNoise;
uniform sampler3D uBillow;
uniform float uTime;
uniform float uTop;
uniform float uBottom;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uLit;
uniform float uSkin;    // meters of soft, eroded cloud over the dome surface
uniform mat4 projectionMatrix;
varying vec3 vWorld;
${NOISE_GLSL}
${SHADE_GLSL}

vec2 drift() { return vec2(uTime * 0.35, uTime * 0.08); }

// Macro shape: dome surface height in [0, 1] at world xz.
float cloudH(vec2 p) {
  p += drift();
  float region = nRegion(p / 1400.0);
  float big = nPuffBig(p / 150.0 + vec2(0.13, 0.71));
  float small = nPuffSmall(p / 48.0 + vec2(0.41, 0.07));
  float h = big * 0.62 + small * 0.30 * (0.6 + 0.4 * big);
  h = clamp(h * (0.85 + 0.3 * region), 0.0, 1.0);
  return 1.0 - pow(1.0 - h, 1.6);
}

float surfY(vec2 p) { return mix(uBottom, uTop, cloudH(p)); }

// Density: solid inside the domes; in the top skin, eroded by 3D billow noise into soft cauliflower
// edges and wisps. Above the dome surface there is nothing, so grazing rays do not cross a fog layer.
float density(vec3 p, float surf, float detail) {
  float inside = (surf - p.y) / uSkin;           // 0 at the dome surface, 1 at the bottom of the skin
  if (inside <= 0.0) return 0.0;
  if (inside >= 1.0 || detail < 0.5) return 1.0;
  vec3 q = vec3(p.x + drift().x, p.y, p.z + drift().y);
  vec4 a = texture(uBillow, q / 22.0);
  vec4 b = texture(uBillow, q / 7.0);
  float billow = a.r * 0.55 + b.g * 0.3 + b.b * 0.15;   // 0..1, high in the middle of each billow
  float d = inside * 1.8 - (1.0 - billow) * 1.25 * (1.0 - inside);
  return clamp(d * 2.0, 0.0, 1.0);
}

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);
  float t0 = length(vWorld - ro);
  if (rd.y > -0.0005) { gl_FragColor = vec4(hazeColor(rd), 1.0); return; }

  vec3 L = uSunDir;
  float slope = 1.3;
  float horiz = sqrt(max(1.0 - rd.y * rd.y, 0.0));
  float stepScale = 72.0 / float(STEPS);
  float t = 0.0;
  vec3 acc = vec3(0.0);
  float T = 1.0;
  float tDepth = -1.0;
  for (int i = 0; i < STEPS; i++) {
    vec3 p = vWorld + rd * t;
    float dist = t0 + t;
    float detail = dist < 220.0 ? 1.0 : 0.0;
    float surf = surfY(p.xz);
    float above = p.y - surf;
    if (above > 0.05) {
      // Over the domes: leap toward the surface (conservative for the dome slopes), with a minimum stride.
      t += max(above / (-rd.y + slope * horiz), 0.3 + dist * 0.003);
      continue;
    }
    float d = density(p, surf, detail);
    float dt = max(0.25, dist * 0.006) * stepScale;
    if (d > 0.001) {
      float depthIn = max(surf - p.y, 0.0);
      // Sun: shadow from domes standing toward the sun, and light lost going deeper into this one.
      vec3 lp = p + L * 4.0;
      float occl = max(surfY(lp.xz) - lp.y, 0.0);
      float sunT = exp(-occl * 0.9) * exp(-depthIn * 0.9);
      float powder = 1.0 - exp(-d * 2.5);                 // thin fringes scatter less back to us
      // Sky fill from above (cool), fading with depth. Warm sun on top. Values stay low: AgX flattens hot ones.
      vec3 amb = mix(uMid, uDeep, clamp(depthIn / 6.0, 0.0, 1.0));
      vec3 c = amb + uLit * sunT * (0.55 + 0.45 * powder);
      float a = 1.0 - exp(-d * 3.0 * dt);
      acc += T * a * c;
      T *= 1.0 - a;
      if (tDepth < 0.0 && T < 0.5) tDepth = t;
      if (T < 0.02) break;
    }
    t += dt;
  }
  acc += T * (uMid + uLit * 0.4);          // ran out of steps far away: haze covers it
  if (tDepth < 0.0) tDepth = t;
  vec3 pd = vWorld + rd * tDepth;
  float dist = t0 + tDepth;

  vec3 col = applyHaze(acc, rd, dist);
  vec4 clip = projectionMatrix * viewMatrix * vec4(pd, 1.0);
  gl_FragDepth = clamp((clip.z / clip.w) * 0.5 + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(col, 1.0);
}`;


function shadeUniforms(look: CloudLook) {
  return {
    uSunDir: { value: look.sunDir },
    uSunColor: { value: look.sunColor },
    uHorizon: { value: look.horizon },
    uFogDensity: { value: look.fogDensity },
  };
}

export class CloudSea {
  readonly group = new THREE.Group();
  sea: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private time = { value: 0 };

  constructor(look: CloudLook, steps: number) {
    this.sea = new THREE.Mesh(
      new THREE.PlaneGeometry(30000, 30000).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        uniforms: {
          uNoise: { value: noiseTexture() }, uBillow: { value: billowTexture3D() }, uSkin: { value: 2.5 },
          uTime: this.time, uTop: { value: CLOUD_TOP }, uBottom: { value: CLOUD_BOTTOM },
          // Cool sky fill in the shadows, warm sun on the tops. Kept low: AgX flattens bright values to pink.
          uDeep: { value: new THREE.Vector3(0.12, 0.12, 0.2) },
          uMid: { value: new THREE.Vector3(0.34, 0.32, 0.5) },
          uLit: { value: new THREE.Vector3(1.3, 0.95, 0.72) },
          ...shadeUniforms(look),
        },
        defines: { STEPS: steps },
        vertexShader: SEA_VERT,
        fragmentShader: SEA_FRAG,
      }),
    );
    this.sea.position.y = CLOUD_TOP;
    this.sea.frustumCulled = false;
    this.sea.renderOrder = -1;
    this.group.add(this.sea);
  }

  setSteps(steps: number) {
    this.sea.material.defines.STEPS = steps;
    this.sea.material.needsUpdate = true;
  }

  update(seconds: number, camera: THREE.Camera) {
    this.time.value = seconds;
    // The sea follows the camera in xz; the noise is in world space, so nothing slides.
    this.sea.position.x = camera.position.x;
    this.sea.position.z = camera.position.z;
  }

  dispose() {
    this.sea.geometry.dispose();
    this.sea.material.dispose();
  }
}
