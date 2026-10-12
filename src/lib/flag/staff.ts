// A flag on its pole: the cloth (bent by the vertex shader), its canvas texture, the pole, and the
// halyard (the rope that hoists the flag) with the two snap hooks that hold the hoist edge.
import * as THREE from "three";
import { POLE_RADIUS, buildPole, disposePole } from "./pole";
import { createCanvas } from "./texture";
import {
  applyWave, flagGeometry, waveDepthMaterial, waveUniforms, type FoldUniforms, type WaveUniforms,
} from "./wave";

export interface StaffOptions {
  width: number; // cloth width, world units
  height: number;
  poleLength: number; // from the finial down
  segments: [number, number]; // cloth mesh segments (fewer on phones)
  texture: [number, number]; // canvas size in pixels
  phase?: number; // wave phase, so neighbor flags do not move in step
  anisotropy?: number;
  poleRadius?: number;
  fold?: FoldUniforms; // sun for fold shading and light through the cloth
}

const ROPE_RADIUS = 0.032;
/** Snap hooks sit this far below the top and above the bottom corner of the hoist edge. */
const CLIP_INSET = 0.12;

/**
 * Halyard rope in the vertex shader. The mesh is a unit tube from y = 0 down to y = -1, scaled to
 * its length. A halyard is pulled taut: it bows a little downwind and sways with the same 4 s
 * loop as the cloth.
 */
const ROPE_GLSL = /* glsl */ `
uniform float uTime;
uniform float uWind;
uniform float uRopeLen;
uniform float uRopeSeed;
`;
const ROPE_BEGIN = /* glsl */ `
  vec3 transformed = vec3(position);
  float s = clamp(-position.y, 0.0, 1.0);  // 0 at the top end, 1 at the bottom end
  float bow = sin(3.1415927 * s);
  float w = clamp(uWind, 0.0, 2.0);
  float t = uTime * 1.5707963 + uRopeSeed;
  transformed.x += bow * min(0.16, uRopeLen * 0.006) * w * (1.0 + 0.25 * sin(2.0 * t));
  transformed.z += bow * min(0.14, uRopeLen * 0.004) * w * sin(2.0 * t + s * 2.5);
`;

interface Rope {
  mesh: THREE.Mesh;
  len: { value: number };
}

export class FlagStaff {
  readonly group = new THREE.Group();
  readonly cloth: THREE.Mesh;
  readonly canvas: HTMLCanvasElement;
  readonly uniforms: WaveUniforms;
  private pole: THREE.Group;
  private texture: THREE.CanvasTexture;
  private material: THREE.MeshPhysicalMaterial;
  private top: number; // cloth top when fully hoisted, local y
  private bottom: number; // cloth top when lowered
  private ropeX: number; // the halyard's line, local x
  private ropes: { up: Rope; down: Rope; back: Rope };
  private ropeMaterials: THREE.Material[] = [];
  private poleVisible = true;

  constructor(readonly opts: StaffOptions) {
    const { width, height, poleLength } = opts;
    const r = opts.poleRadius ?? POLE_RADIUS;
    this.top = -0.45;
    // Lowered = just below the frame, not the real foot of the pole: the hoist then fills the 2 s on screen.
    this.bottom = -Math.min(poleLength - 0.5, height * 1.9);
    this.pole = buildPole(poleLength, [], r);
    this.group.add(this.pole);

    this.canvas = createCanvas(opts.texture[0], opts.texture[1]);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = opts.anisotropy ?? 1;
    this.uniforms = waveUniforms(width, height, opts.phase ?? 0);
    // Polyester flag cloth: matte, a soft sheen at grazing angles, almost no specular highlight.
    this.material = applyWave(new THREE.MeshPhysicalMaterial({
      map: this.texture, side: THREE.DoubleSide, roughness: 0.82, metalness: 0, specularIntensity: 0.22,
      sheen: 0.55, sheenColor: new THREE.Color(0xfff1e6), sheenRoughness: 0.7,
    }), this.uniforms, false, false, opts.fold ?? null);

    // The halyard runs just off the pole, on the flag side. The hoist edge hangs from snap hooks on it.
    this.ropeX = r + ROPE_RADIUS + 0.03;
    const clipGap = 0.34;
    this.cloth = new THREE.Mesh(flagGeometry(width, height, opts.segments[0], opts.segments[1]), this.material);
    this.cloth.customDepthMaterial = waveDepthMaterial(this.uniforms);
    this.cloth.castShadow = true;
    this.cloth.receiveShadow = true;
    this.cloth.frustumCulled = false; // the shader moves vertices past the plane's bounds
    this.cloth.position.set(this.ropeX + clipGap, this.top, 0);

    // Snap hooks: an oval steel loop from the rope to the grommet at each corner of the hoist edge.
    const hookGeo = new THREE.TorusGeometry(0.1, 0.022, 8, 24);
    hookGeo.scale(clipGap / 0.2 / 1.0, 0.75, 1);
    const hookMat = new THREE.MeshStandardMaterial({ color: 0xaeb2b8, metalness: 1, roughness: 0.32 });
    const grommetGeo = new THREE.TorusGeometry(0.05, 0.018, 6, 16);
    const grommetMat = new THREE.MeshStandardMaterial({ color: 0x9c8a62, metalness: 1, roughness: 0.4 });
    for (const y of [-CLIP_INSET, -height + CLIP_INSET]) {
      const hook = new THREE.Mesh(hookGeo, hookMat);
      hook.position.set(-clipGap / 2, y, 0);
      hook.rotation.y = 0.5;
      hook.castShadow = true;
      const grommet = new THREE.Mesh(grommetGeo, grommetMat);
      grommet.position.set(0.06, y, 0.005);
      this.cloth.add(hook, grommet);
    }
    this.group.add(this.cloth);

    // Two lines down the pole: the working line (to the hooks and on below), and the return line.
    this.ropes = {
      up: this.rope(0.4),
      down: this.rope(1.7),
      back: this.rope(2.9),
    };
    this.ropes.back.mesh.position.set(this.ropeX - 0.02, -0.02, 0.09);
    this.setRope(this.ropes.back, -0.02, -poleLength);
    this.setHoist(1);
  }

  private rope(seed: number): Rope {
    const geo = new THREE.CylinderGeometry(ROPE_RADIUS, ROPE_RADIUS, 1, 6, 48, true);
    geo.translate(0, -0.5, 0);
    const len = { value: 1 };
    const mat = new THREE.MeshStandardMaterial({ color: 0xe9e1d2, roughness: 0.92, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        uTime: this.uniforms.uTime, uWind: this.uniforms.uWind, uRopeLen: len, uRopeSeed: { value: seed },
      });
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${ROPE_GLSL}`)
        .replace("#include <begin_vertex>", ROPE_BEGIN);
    };
    mat.customProgramCacheKey = () => "flag-rope";
    this.ropeMaterials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    this.group.add(mesh);
    return { mesh, len };
  }

  /** Stretches a rope between two local heights (top > bottom). Zero length hides it. */
  private setRope(rope: Rope, top: number, bottom: number) {
    const len = top - bottom;
    rope.mesh.visible = this.poleVisible && len > 0.05;
    rope.mesh.position.y = top;
    rope.mesh.scale.y = Math.max(len, 0.001);
    rope.len.value = len;
  }

  /** 0 = lowered to the foot of the pole, 1 = at the top. */
  setHoist(f: number) {
    this.cloth.position.y = this.bottom + (this.top - this.bottom) * f;
    this.cloth.visible = f > 0.001;
    const y = this.cloth.position.y;
    const { up, down } = this.ropes;
    up.mesh.position.x = down.mesh.position.x = this.ropeX;
    if (this.cloth.visible) {
      this.setRope(up, -0.02, y - CLIP_INSET);
      this.setRope(down, y - this.opts.height + CLIP_INSET, -this.opts.poleLength);
    } else {
      this.setRope(up, -0.02, -this.opts.poleLength);
      this.setRope(down, 0, 0);
    }
  }

  /** Hides the pole when this flag rides on another flag's pole. */
  setPoleVisible(v: boolean) {
    this.pole.visible = v;
    // On a shared pole the other flag's halyard carries this one too.
    this.poleVisible = v;
    for (const rope of Object.values(this.ropes)) rope.mesh.visible = v && rope.len.value > 0.05;
  }

  /** Repaint: call the painter on the canvas, then upload it. */
  paint(painter: (canvas: HTMLCanvasElement) => void) {
    painter(this.canvas);
    this.texture.needsUpdate = true;
  }

  setNormalMap(normal: THREE.Texture | null) {
    this.material.normalMap = normal;
    // Subtle: at this distance the weave is felt in the light, not seen as a grid.
    this.material.normalScale.set(0.28, 0.28);
    this.material.needsUpdate = true;
  }

  update(time: number, wind: number) {
    this.uniforms.uTime.value = time;
    this.uniforms.uWind.value = wind;
  }

  dispose() {
    disposePole(this.pole);
    this.cloth.geometry.dispose();
    this.material.dispose();
    (this.cloth.customDepthMaterial as THREE.Material).dispose();
    this.texture.dispose();
    for (const rope of Object.values(this.ropes)) rope.mesh.geometry.dispose();
    this.ropeMaterials.forEach((m) => m.dispose());
    const geos = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>();
    this.cloth.traverse((o) => {
      if (o !== this.cloth && o instanceof THREE.Mesh) {
        geos.add(o.geometry);
        mats.add(o.material as THREE.Material);
      }
    });
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    this.group.parent?.remove(this.group);
  }
}
