// Fabric look for the Hall of Fame flags: a woven normal map, and backlight translucency.
//
// Backlight: thin cloth between the eye and the sun glows with its own color. The extra emission is
// diffuse * sunColor * strength * max(0, dot(viewDir, -sunDir))^k, where viewDir points from the
// surface to the eye. It is strongest when the flag covers the sun, as in a real sunset photo.
import * as THREE from "three";
import { createCanvas } from "./texture";

let weave: THREE.CanvasTexture | null = null;

/** Tileable plain-weave normal map, 128², drawn once. */
export function weaveNormalMap(): THREE.CanvasTexture {
  if (weave) return weave;
  const S = 128, threads = 16;
  const height = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x / S) * threads, v = (y / S) * threads;
      const over = (Math.floor(u) + Math.floor(v)) % 2 === 0;
      const warp = Math.sin((u % 1) * Math.PI), weft = Math.sin((v % 1) * Math.PI);
      height[y * S + x] = over ? warp * 0.7 + weft * 0.3 : weft * 0.7 + warp * 0.3;
    }
  }
  const c = createCanvas(S, S);
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(S, S);
  const h = (x: number, y: number) => height[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (h(x - 1, y) - h(x + 1, y)) * 1.5, dy = (h(x, y - 1) - h(x, y + 1)) * 1.5;
      const len = Math.hypot(dx, dy, 1);
      const k = (y * S + x) * 4;
      img.data[k] = ((dx / len) * 0.5 + 0.5) * 255;
      img.data[k + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      img.data[k + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  weave = new THREE.CanvasTexture(c);
  weave.wrapS = weave.wrapT = THREE.RepeatWrapping;
  weave.colorSpace = THREE.NoColorSpace;
  return weave;
}

export interface BacklightUniforms {
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uBacklight: { value: number };
  uGlow: { value: number };
}

/**
 * Adds backlight translucency (and an optional highlight glow) on top of the material's current
 * onBeforeCompile. Instanced variants read the glow per instance from `aGlow`.
 */
export function applyBacklight<M extends THREE.Material>(material: M, uniforms: BacklightUniforms, instanced = false): M {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    if (instanced) {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float aGlow;\nvarying float vGlow;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGlow = aGlow;");
    }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        // The fold shading (wave.ts) may have declared the sun uniforms already.
        `#include <common>
${shader.fragmentShader.includes("uniform vec3 uSunDir;") ? "" : "uniform vec3 uSunDir;\nuniform vec3 uSunColor;"}
uniform float uBacklight;
uniform float uGlow;
${instanced ? "varying float vGlow;" : ""}`,
      )
      .replace(
        "#include <aomap_fragment>",
        `#include <aomap_fragment>
{
  vec3 viewDirV = normalize(vViewPosition);
  vec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  float back = max(dot(viewDirV, -sunV), 0.0);
  totalEmissiveRadiance += diffuseColor.rgb * uSunColor * uBacklight * (pow(back, 3.0) * 0.6 + pow(back, 12.0) * 1.4);
  float glow = ${instanced ? "max(uGlow, vGlow)" : "uGlow"};
  totalEmissiveRadiance += (diffuseColor.rgb * 0.6 + vec3(0.5, 0.42, 0.3)) * glow;
}`,
      );
  };
  material.customProgramCacheKey = () => `${prevKey.call(material)}-backlight${instanced ? "-i" : ""}`;
  return material;
}

export interface RimUniforms {
  uRimColor: { value: THREE.Color };
}

/**
 * Warm light on the edges the eye sees at a grazing angle: fold crests and the outline. It reads as
 * light wrapping around the cloth from behind, without moving the sun behind the flag (that would put
 * the face in shadow). Chain it after the wave and the backlight.
 */
export function applyRim<M extends THREE.Material>(material: M, uniforms: RimUniforms): M {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uRimColor;")
      .replace(
        "#include <aomap_fragment>",
        `#include <aomap_fragment>
{
  float facing = abs(dot(normal, normalize(vViewPosition)));
  totalEmissiveRadiance += uRimColor * pow(1.0 - facing, 3.0);
}`,
      );
  };
  material.customProgramCacheKey = () => `${prevKey.call(material)}-rim`;
  return material;
}
