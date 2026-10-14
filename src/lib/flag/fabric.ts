// Fabric look for the Hall of Fame flags: a woven normal map, and backlight translucency.
//
// Backlight: thin cloth between the eye and the sun glows with its own color. The extra emission is
// diffuse * sunColor * strength * max(0, dot(viewDir, -sunDir))^k, where viewDir points from the
// surface to the eye. It is strongest when the flag covers the sun, as in a real sunset photo.
import * as THREE from "three";
import { SUN_GLOW_GLSL } from "./sunsetSky";
import { createCanvas } from "./texture";

let weave: THREE.CanvasTexture | null = null;

/** Tile repeats per flag for `clothNormalMap`: one tile is about half the flag. */
export const CLOTH_NORMAL_REPEAT: [number, number] = [2, 1.3];

/**
 * Tileable cloth normal map, 512², drawn once: plain weave, 128 threads per tile. Seen up close only;
 * mipmaps fade it out far away. No painted creases: they are fixed to the cloth and do not move with
 * the wind, so they read as stains. The folds come from the geometry (cloth sim, or the wave's curvature).
 */
export function clothNormalMap(): THREE.CanvasTexture {
  if (weave) return weave;
  const S = 512, threads = 128;
  // Lookup table: a thread depends only on its own coordinate.
  const pitch = S / threads;
  const bump = Float32Array.from({ length: S }, (_, k) => Math.sin((((k % pitch) + 0.5) / pitch) * Math.PI));
  const height = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const over = (((x / pitch) | 0) + ((y / pitch) | 0)) % 2 === 0;
      const warp = bump[x], weft = bump[y];
      const thread = over ? warp * 0.7 + weft * 0.3 : weft * 0.7 + warp * 0.3;
      height[y * S + x] = thread * 0.6;
    }
  }
  const c = createCanvas(S, S);
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(S, S);
  const h = (x: number, y: number) => height[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (h(x - 1, y) - h(x + 1, y)) * 0.5, dy = (h(x, y - 1) - h(x, y + 1)) * 0.5;
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
  /** Share of the sun the cloth lets through: about 0.35 for flag fabric, less for a denser weave. */
  uTransmit: { value: number };
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
uniform float uTransmit;
${SUN_GLOW_GLSL}
${instanced ? "varying float vGlow;" : ""}`,
      )
      .replace(
        "#include <aomap_fragment>",
        `#include <aomap_fragment>
{
  vec3 viewDirV = normalize(vViewPosition);
  vec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  float back = max(dot(viewDirV, -sunV), 0.0);
  // How much light comes through this part of the cloth: most where the fold faces away from the sun (the
  // light enters its back), little in the folds turned toward it. Without it the glow is flat, like card.
  float thru = 0.25 + 0.75 * pow(max(dot(-normal, sunV), 0.0), 2.0);
  // Broad: the bright sky around a low sun lights the cloth from behind too, not only the disc. A narrow
  // lobe made two flags a few degrees apart read as different fabrics (one glowing, one flat).
  totalEmissiveRadiance += diffuseColor.rgb * uSunColor * uBacklight * thru * (pow(back, 3.0) * 0.6 + pow(back, 6.0) * 1.4);
  // The sun right behind the cloth shines through it in the cloth's own colors, deeper than the surface
  // (light crosses the dye). Thin cloth passes only part of the light behind it, so the spot is the sun as
  // the sky draws it, times uTransmit: it never outshines the bare sun beside the flag. (A fixed hot
  // spot did, about 5x, and the sun looked stronger through the cloth than in the open sky.)
  vec3 dyed = diffuseColor.rgb * sqrt(diffuseColor.rgb);
  totalEmissiveRadiance += dyed * uSunColor * uTransmit * thru * sunGlow(back);
  // Gold rim: edges and fold crests seen at a grazing angle catch the light behind them, in the sun's color.
  float edgeRim = pow(1.0 - abs(dot(normal, viewDirV)), 3.0);
  totalEmissiveRadiance += uSunColor * uBacklight * 0.5 * edgeRim * pow(back, 4.0);
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

export interface SunRimUniforms {
  uRimSunDir: { value: THREE.Vector3 };
  uRimSunColor: { value: THREE.Color };
  uSunRim: { value: number };
}

/**
 * Gold rim on any lit material (the poles): its outline glows where it stands against the sun, as a
 * backlit pole does in a photo. Strongest when the eye looks toward the sun; zero with the sun behind.
 */
export function applySunRim<M extends THREE.Material>(material: M, uniforms: SunRimUniforms): M {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uRimSunDir;\nuniform vec3 uRimSunColor;\nuniform float uSunRim;")
      .replace(
        "#include <aomap_fragment>",
        `#include <aomap_fragment>
{
  vec3 toEye = normalize(vViewPosition);
  vec3 sunV = normalize((viewMatrix * vec4(uRimSunDir, 0.0)).xyz);
  float against = pow(max(dot(toEye, -sunV), 0.0), 4.0);
  totalEmissiveRadiance += uRimSunColor * uSunRim * against * pow(1.0 - abs(dot(normal, toEye)), 2.5);
}`,
      );
  };
  material.customProgramCacheKey = () => `${prevKey.call(material)}-sunrim`;
  return material;
}
