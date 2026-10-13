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
import { SKY_GOLD, SKY_LOW, SUN_GLOW_GLSL } from "./sunsetSky";

export const CLOUD_TOP = 1.2;
export const CLOUD_BOTTOM = -7;

export interface CloudLook {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  fogDensity: number;
}

const SHADE_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyLow;
uniform vec3 uSkyGold;
uniform float uFogDensity;
${SUN_GLOW_GLSL}

// Haze color seen along direction rd: the sky's own color at the horizon (sunsetSky.ts, h = 0), so the far
// sea fades into the sky. A darker haze drew a flat band under the sky with a hard edge at the horizon.
vec3 hazeColor(vec3 rd) {
  float s = max(dot(rd, uSunDir), 0.0);
  vec3 c = mix(uSkyLow, uSkyGold, pow(s, 2.5) * 0.75);
  c += uSunColor * sunGlow(s);
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

// Wind carries the clouds toward +x, the way the flags fly. The noise is sampled at p - drift, so the
// pattern moves with +drift.
// Half the first speed: a slow, heavy sea reads as vast; a fast one reads as small and near.
vec2 drift() { return vec2(uTime * 0.6, uTime * 0.06); }

// Macro shape: dome surface height in [0, 1] at world xz. Four texture reads: it runs several times per
// march step, so it is the cost that matters most.
// Variety: puffs at three scales (the big one rotated, so the texture grid does not line up) and a
// region field that raises banks in some places and lowers them in others.
// No domain warp and no steep valleys: the noise is 8-bit, and a warp scaled up by 100+ m turns its
// quantization steps into terraces (contour rings), and steep walls defeat the march.
float cloudH(vec2 p) {
  p -= drift();
  float region = nRegion(p / 900.0);
  // Small puffs lag the big ones a little, so the shapes change as they travel instead of sliding as one.
  vec2 lag = drift() * 0.15;
  float big = nPuffBig(NROT * p / 210.0 + vec2(0.13, 0.71));
  float mid = nPuffBig(p / 95.0 + vec2(0.52, 0.29));
  float small = nPuffSmall((p + lag) / 46.0 + vec2(0.41, 0.07));
  float h = big * 0.5 + mid * 0.3 + small * 0.26 * (0.5 + 0.5 * max(big, mid));
  h = clamp(h * (0.72 + 0.5 * region), 0.0, 1.0);
  return 1.0 - pow(1.0 - h, 1.6);
}

float surfY(vec2 p) { return mix(uBottom, uTop, cloudH(p)); }

// Density: solid inside the domes; in the top skin, eroded by 3D billow noise into soft cauliflower
// edges and wisps. Above the dome surface there is nothing, so grazing rays do not cross a fog layer.
float density(vec3 p, float surf, float detail) {
  float inside = (surf - p.y) / uSkin;           // 0 at the dome surface, 1 at the bottom of the skin
  if (inside <= 0.0) return 0.0;
  if (inside >= 1.0 || detail < 0.5) return 1.0;
  // Billows rise slowly while they travel: the edges boil instead of holding still.
  // Rise relative to the dome surface, not in world y: a pattern rising through a near-flat dome top shows
  // as edges racing sideways (speed = rise / slope), against the wind too, and the sea seems to shake.
  vec3 q = vec3(p.x - drift().x, (p.y - surf) - uTime * 0.08, p.z - drift().y);
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
  // Grazing rays at the far edge of the plane: haze only. Write far depth too: a shader that writes
  // gl_FragDepth on one path leaves it undefined on the others, and that strip then hid the flags.
  if (rd.y > -0.0005) { gl_FragColor = vec4(hazeColor(rd), 1.0); gl_FragDepth = 1.0; return; }

  vec3 L = uSunDir;
  float slope = 1.3;
  float horiz = sqrt(max(1.0 - rd.y * rd.y, 0.0));
  float stepScale = 72.0 / float(STEPS);
  float t = 0.0;
  vec3 acc = vec3(0.0);
  float T = 1.0;
  float tDepth = -1.0;
  float tPrev = 0.0;      // last sample above the surface
  bool hit = false;
  // Per-pixel jitter of the step phase: fixed steps through the skin draw contour rings; jitter turns
  // them into fine grain, which the film noise in the post pass hides.
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  for (int i = 0; i < STEPS; i++) {
    vec3 p = vWorld + rd * t;
    float dist = t0 + t;
    float detail = dist < 220.0 ? 1.0 : 0.0;
    float surf = surfY(p.xz);
    float above = p.y - surf;
    if (above > 0.05) {
      // Over the domes: leap toward the surface (conservative for the dome slopes), with a minimum stride
      // that grows with distance. The camera rides just over the tops, so its rays graze them: with a small
      // stride they ran out of steps a few dozen meters out, and the rest of the sea showed as a flat floor.
      tPrev = t;
      t += max(above / (-rd.y + slope * horiz), 0.5 + dist * 0.015);
      continue;
    }
    if (!hit) {
      // First time under the surface: the leap may have gone deep. Bisect back to the surface, so the
      // skin starts where the dome is, not where the stride happened to land.
      hit = true;
      float a0 = tPrev, a1 = t;
      for (int k = 0; k < 4; k++) {
        float m = 0.5 * (a0 + a1);
        vec3 q = vWorld + rd * m;
        if (q.y > surfY(q.xz)) a0 = m; else a1 = m;
      }
      t = a1 + jitter * max(0.25, dist * 0.006) * stepScale;
      p = vWorld + rd * t;
      dist = t0 + t;
      surf = surfY(p.xz);
      if (p.y > surf) continue;
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
      // Sky fill from above (cool), fading with depth.
      vec3 amb = mix(uMid, uDeep, clamp(depthIn / 6.0, 0.0, 1.0));
      // Backlit: the sun is low and ahead. Clouds toward it glow (forward scattering), most at their thin
      // tops; the rest of the sea stays in its own cool shade. That dark foreground is what frames the sky.
      float fwd = pow(max(dot(rd, L), 0.0), 5.0);
      float top = 1.0 - smoothstep(0.0, 1.6, depthIn);
      vec3 c = amb + uLit * sunT * (0.25 + 1.4 * fwd) * (0.35 + 0.65 * top) * (0.7 + 0.3 * powder);
      float a = 1.0 - exp(-d * 3.0 * dt);
      acc += T * a * c;
      T *= 1.0 - a;
      if (tDepth < 0.0 && T < 0.5) tDepth = t;
      if (T < 0.02) break;
    }
    t += dt;
  }
  // Ran out of steps: shade the rest like the backlit sea (dark; gold toward the sun, and only far away), so
  // the gaps between near billows stay in shadow instead of turning into a flat, bright floor.
  acc += T * (uMid + uLit * (0.06 + 0.9 * pow(max(dot(rd, L), 0.0), 5.0) * smoothstep(150.0, 600.0, t0 + t)));
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
    uSkyLow: { value: SKY_LOW },
    uSkyGold: { value: SKY_GOLD },
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
          // Soft lavender shade (light, as clouds read: dark ones look like a storm), amber on the tops toward the sun.
          uDeep: { value: new THREE.Vector3(0.16, 0.15, 0.24) },
          uMid: { value: new THREE.Vector3(0.42, 0.38, 0.48) },
          uLit: { value: new THREE.Vector3(1.5, 0.78, 0.32) },
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
