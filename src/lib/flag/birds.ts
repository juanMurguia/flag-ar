// Far birds: a few loose flocks crossing the sky, dark against the low sun.
//
// One InstancedMesh, all motion in the vertex shader. Each bird is a flat "m" silhouette facing the camera
// (a billboard): far birds read as that shape, not as 3D bodies, and a horizontal wing seen edge-on from
// below is under a pixel tall. The wings bend at the elbow and flap on the bird's own beat; every few
// seconds the bird glides with its wings held still. A flock shares one heading and speed; each bird
// drifts a little around its slot, so the flock breathes instead of flying as a rigid formation. Positions
// wrap inside a box centered on the camera, so flocks keep crossing wherever the visitor walks, and they
// fade out near the box edge and with haze. Layout is random per visit, so the sky is never the same twice.
import * as THREE from "three";

const BOX = new THREE.Vector2(1600, 3000); // meters around the camera, in x and z: narrow in x, so a crossing flock is in view often
const WING = 1.2; // half wingspan, m
const MIN_DIST = 420; // past this, birds scale with distance, so they keep a readable size on screen

const VERT = /* glsl */ `
attribute vec3 aStart;    // world position at time 0
attribute vec3 aVel;      // m/s, the flock heading
attribute vec2 aBeat;     // flap rate (rad/s), phase
uniform float uTime;
uniform vec2 uBox;
varying float vFade;
void main() {
  // position.x: span, -1 (left tip) to 1 (right tip). position.y: -1 or 1, the two edges of the wing.
  float sp = abs(position.x);
  float glide = smoothstep(0.2, 0.6, sin(uTime * 0.35 + aBeat.y * 3.0)); // 1 = gliding
  float flap = sin(uTime * aBeat.x + aBeat.y) * (1.0 - glide) + 0.25 * glide;
  // Wing line: up from the body to the elbow, then the forearm swings with the flap: the "m" shape.
  float elbow = 0.18 + 0.12 * flap;
  float yc = sp < 0.5 ? sp * 2.0 * elbow : elbow + (sp - 0.5) * 2.0 * (0.55 * flap - 0.05);
  float thick = mix(0.16, 0.05, sp);
  vec2 local = vec2(position.x, yc + position.y * thick) * ${WING.toFixed(2)};

  // Drift inside the flock, and a slow rise and fall, so the flock breathes.
  vec3 drift = vec3(sin(uTime * 0.21 + aBeat.y * 5.0), sin(uTime * 0.33 + aBeat.y * 2.0) * 0.6, cos(uTime * 0.17 + aBeat.y * 4.0)) * 4.0;
  vec3 p = aStart + aVel * uTime + drift;
  // Wrap around the camera in x and z.
  vec2 rel = mod(p.xz - cameraPosition.xz + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 center = vec3(cameraPosition.x + rel.x, p.y, cameraPosition.z + rel.y);
  vec2 edge = abs(rel) / (uBox * 0.5);
  vFade = 1.0 - smoothstep(0.7, 1.0, max(edge.x, edge.y));
  // Billboard: span along the camera's right vector, height along world up.
  vec3 right = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
  float dist = length(center - cameraPosition);
  vec2 sized = local * max(1.0, dist / ${MIN_DIST.toFixed(1)});
  vec3 world = center + right * sized.x + vec3(0.0, sized.y, 0.0);
  vFade *= exp(-max(dist - 250.0, 0.0) * 0.0011); // far birds sink into the haze
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uInk;
uniform vec3 uHaze;
varying float vFade;
void main() {
  if (vFade < 0.02) discard;
  gl_FragColor = vec4(mix(uHaze, uInk, vFade), 1.0);
}`;

/** One bird: a strip along the span, x from -1 to 1 at five joints, y = -1 / 1 for the wing edges. */
function birdGeometry() {
  const xs = [-1, -0.5, 0, 0.5, 1];
  const pos: number[] = [], idx: number[] = [];
  for (const x of xs) pos.push(x, -1, 0, x, 1, 0);
  for (let i = 0; i < xs.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export class Birds {
  readonly mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private time = { value: 0 };

  /**
   * `viewZ`: the camera z of the start view (flocks start in front of it). `ink`: silhouette color;
   * `haze`: what far birds fade into (the horizon). HDR, before exposure.
   */
  constructor(flocks: number, viewZ: number, ink: THREE.Color, haze: THREE.Color) {
    const starts: number[] = [], vels: number[] = [], beats: number[] = [];
    for (let f = 0; f < flocks; f++) {
      // A flock: 600-1000 m down the corridor (in the start view), 50-180 m up, crossing the view sideways at
      // 9-15 m/s, 3-6 birds in a loose V. Far and few: a detail you notice, not a swarm.
      const cx = (Math.random() - 0.5) * BOX.x, cz = viewZ - 600 - Math.random() * 400;
      const cy = 50 + Math.random() * 130;
      const heading = (Math.random() < 0.5 ? 0 : Math.PI) + (Math.random() - 0.5) * 0.7;
      const speed = 9 + Math.random() * 6;
      const vx = Math.cos(heading) * speed, vz = Math.sin(heading) * speed;
      const n = 3 + Math.floor(Math.random() * 4);
      const rate = 7 + Math.random() * 3;
      for (let b = 0; b < n; b++) {
        // Loose V: each bird back and to one side of the one ahead, with jitter.
        const side = b % 2 ? 1 : -1, rank = Math.ceil(b / 2);
        const back = rank * (5 + Math.random() * 3), lateral = side * rank * (4 + Math.random() * 3);
        const bx = cx - Math.cos(heading) * back - Math.sin(heading) * lateral;
        const bz = cz - Math.sin(heading) * back + Math.cos(heading) * lateral;
        starts.push(bx, cy + (Math.random() - 0.5) * 6, bz);
        vels.push(vx, 0, vz);
        beats.push(rate * (0.9 + Math.random() * 0.2), Math.random() * Math.PI * 2);
      }
    }
    const count = beats.length / 2;
    const geo = birdGeometry();
    geo.setAttribute("aStart", new THREE.InstancedBufferAttribute(new Float32Array(starts), 3));
    geo.setAttribute("aVel", new THREE.InstancedBufferAttribute(new Float32Array(vels), 3));
    geo.setAttribute("aBeat", new THREE.InstancedBufferAttribute(new Float32Array(beats), 2));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.time, uBox: { value: BOX }, uInk: { value: ink }, uHaze: { value: haze } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.frustumCulled = false; // the shader moves them; the bounding sphere would be wrong
  }

  update(seconds: number) {
    this.time.value = seconds;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
