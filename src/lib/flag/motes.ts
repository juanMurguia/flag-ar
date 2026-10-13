// Golden dust in the air: a few hundred specks that catch the low sun and drift downwind.
//
// One Points draw call. All motion is in the vertex shader: each speck rides the wind (+x, like the
// flags and the clouds), bobs on its own slow beat, and wraps inside a box centered on the camera, so
// there is always dust around the viewer wherever they walk, and none is ever created or destroyed.
import * as THREE from "three";

const BOX = new THREE.Vector3(36, 10, 60); // meters around the camera
const WIND = 0.7; // m/s, downwind (+x)
const SIZE = 200; // point size at 1 m, in CSS pixels

const VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime;
uniform vec3 uBox;
uniform float uSize;
varying float vAlpha;
void main() {
  // Base position in [0, box), drifted by the wind and a slow bob, wrapped around the camera.
  vec3 p = position;
  p.x += uTime * ${WIND.toFixed(2)} * (0.7 + 0.6 * aSeed);
  p.y += sin(uTime * (0.2 + 0.3 * aSeed) + aSeed * 40.0) * 0.6;
  p.z += sin(uTime * 0.13 + aSeed * 17.0) * 0.8;
  // The box sits a little above the eye: most of the air worth filling is above the cloud tops.
  vec3 center = cameraPosition + vec3(0.0, 3.0, 0.0);
  vec3 rel = mod(p - center + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 world = center + rel;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  gl_PointSize = uSize * (0.6 + 0.8 * aSeed) / max(dist, 0.5);
  // Twinkle as each speck turns; fade near the box edge so the wrap never pops, and very close up.
  float twinkle = 0.55 + 0.45 * sin(uTime * (1.0 + 2.0 * aSeed) + aSeed * 90.0);
  vec3 edge = abs(rel) / (uBox * 0.5);
  float fade = 1.0 - smoothstep(0.75, 1.0, max(max(edge.x, edge.y), edge.z));
  // Also fade out close to the camera and down into the cloud tops.
  vAlpha = twinkle * fade * smoothstep(1.0, 3.0, dist) * smoothstep(1.2, 2.2, world.y);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  float a = exp(-d * 4.0) * vAlpha; // soft round speck
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * a, 1.0);
}`;

export class Motes {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private time = { value: 0 };

  /** `count`: specks. `color`: HDR, added to the scene. */
  constructor(count: number, color: THREE.Color) {
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = Math.random() * BOX.x;
      pos[i * 3 + 1] = Math.random() * BOX.y;
      pos[i * 3 + 2] = Math.random() * BOX.z;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.time, uBox: { value: BOX }, uSize: { value: SIZE }, uColor: { value: color } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false; // the shader moves them; the bounding sphere would be wrong
  }

  /** Pixel size scale: call on resize, so specks keep their size across device pixel ratios. */
  setPixelRatio(dpr: number) {
    this.points.material.uniforms.uSize.value = SIZE * dpr;
  }

  update(seconds: number) {
    this.time.value = seconds;
  }

  dispose() {
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
