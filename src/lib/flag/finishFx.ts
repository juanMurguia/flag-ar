// The wallpaper's film finish (finish.ts), live, on the GPU, for the HD view. Same steps in the same order:
// lens aberration, mist, sun streak, halation, highlight shoulder, S-curve, vibrance, split-tone, light leak,
// vignette, grain. The CPU version runs once per download; this one runs every frame, so its wide blur comes
// from a mipmap blur pass, as in postprocessing's own bloom. Halation reads the same blur: the excess over
// the threshold of the blurred image is the glow that spills from bright areas.
//
// It runs last, on the tone-mapped image. The buffers are linear; the finish was tuned on sRGB pixels, so
// the shader works in sRGB and converts back at the end.
import * as THREE from "three";
import { Effect, MipmapBlurPass } from "postprocessing";
import { FINISH_DEFAULTS } from "./finish";

const FRAG = /* glsl */ `
uniform sampler2D tMist;
uniform vec2 uSun;
uniform float uSunOn;
uniform float uAspect;
uniform vec2 uRes;
uniform float uSeed;
uniform float uVignette;
uniform float uGrain;
uniform float uAberration;
uniform float uHalation;
uniform float uHalationThreshold;
uniform float uDiffusion;
uniform float uContrast;
uniform float uTone;
uniform float uLeak;
uniform float uVibrance;
uniform float uStreak;

vec3 toS(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
vec3 toL(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
float shoulder(float x) { return x <= 0.75 ? max(x, 0.0) : 0.75 + 0.25 * (1.0 - exp(-(x - 0.75) / 0.25)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 c = (uv - 0.5) * vec2(uAspect, 1.0);
  float r2 = dot(c, c) / (0.25 * (uAspect * uAspect + 1.0)); // 0 in the middle, 1 at the corners

  // Lens: red pushed out, blue pulled in, growing with the square of the distance from the middle.
  vec2 off = (uv - 0.5) * 2.0 * uAberration * r2;
  vec3 col = vec3(texture2D(inputBuffer, uv + off).r, inputColor.g, texture2D(inputBuffer, uv - off).b);
  col = toS(col);

  // Film: mist (screen blend), the sun's anamorphic streak, halation that spills past bright areas only.
  vec3 mist = toS(texture2D(tMist, uv).rgb);
  col = 1.0 - (1.0 - col) * (1.0 - mist * uDiffusion);
  float sunMist = max(texture2D(tMist, uSun).r, texture2D(tMist, uSun).g);
  float sunHot = clamp((pow(sunMist, 1.0 / 2.2) - uHalationThreshold) / (1.0 - uHalationThreshold) * 3.0, 0.0, 1.0) * uSunOn;
  if (uStreak * sunHot > 0.0) {
    float dy = uv.y - uSun.y, dx = abs(uv.x - uSun.x) * uAspect;
    float t1 = dy / 0.0035, t2 = dy / 0.022;
    float s = (exp(-t1 * t1) + 0.25 * exp(-t2 * t2)) * exp(-dx / (0.42 * uAspect)) * uStreak * sunHot;
    col += s * vec3(1.0, 0.72, 0.5);
  }
  float around = max(0.0, (max(mist.r, mist.g) - uHalationThreshold) / (1.0 - uHalationThreshold));
  float own = max(0.0, (max(col.r, max(col.g, col.b)) - uHalationThreshold) / (1.0 - uHalationThreshold));
  float hl = max(0.0, around - own);
  col += hl * uHalation * vec3(1.0, 0.36, 0.12);

  // Grade: shoulder, S-curve, vibrance, split-tone, a little less color in the deepest shadows.
  col = vec3(shoulder(col.r), shoulder(col.g), shoulder(col.b));
  col += uContrast * (col * col * (3.0 - 2.0 * col) - col);
  float mx = max(col.r, max(col.g, col.b)), mn = min(col.r, min(col.g, col.b));
  float l0 = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = l0 + (col - l0) * (1.0 + uVibrance * (1.0 - (mx - mn)));
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float sh = (1.0 - lum) * (1.0 - lum) * uTone, hi = lum * lum * uTone;
  col += vec3(-0.035, 0.01, 0.045) * sh + vec3(0.045, 0.018, -0.05) * hi;
  col += (lum - col) * max(0.0, 0.25 - lum) * 1.2;

  // Light leak: warm glow from the sun's side.
  if (uLeak > 0.0) {
    float k = 1.0 / (0.75 * sqrt(uAspect * uAspect + 1.0));
    vec2 d = vec2((uv.x - uSun.x) * uAspect, (uv.y - uSun.y) * uAspect * 0.6) * k;
    float l = exp(-dot(d, d) * 6.0) * uLeak * uSunOn;
    col = 1.0 - (1.0 - col) * (1.0 - l * vec3(1.0, 0.62, 0.32));
  }

  // Vignette, then grain: monochrome, strongest in the midtones, a new pattern every frame like film.
  float vk = clamp((r2 - 0.18) / 0.82, 0.0, 1.0);
  float vig = 1.0 - uVignette * vk * vk * (3.0 - 2.0 * vk);
  col *= vec3(vig, vig * 0.995, vig * 0.985) + vec3(0.0, 0.0, 0.012 * (1.0 - vig));
  vec2 cell = floor(uv * uRes / max(1.0, floor(max(uRes.x, uRes.y) / 2400.0 + 0.5)));
  float n = hash(cell + uSeed) + hash(cell + uSeed + 17.0) + hash(cell + uSeed + 41.0) - 1.5;
  float l2 = dot(col, vec3(0.299, 0.587, 0.114));
  col += n * 2.0 * uGrain * (0.35 + 2.6 * l2 * (1.0 - l2)) / 255.0;

  outputColor = vec4(toL(col), inputColor.a);
}`;

export class FilmFinishEffect extends Effect {
  private mist = new MipmapBlurPass();
  private frame = 0;

  constructor() {
    const d = FINISH_DEFAULTS;
    super("FilmFinishEffect", FRAG, {
      uniforms: new Map<string, THREE.Uniform>([
        ["tMist", new THREE.Uniform(null)],
        ["uSun", new THREE.Uniform(new THREE.Vector2(0.5, 0.65))],
        ["uSunOn", new THREE.Uniform(0)],
        ["uAspect", new THREE.Uniform(1)],
        ["uRes", new THREE.Uniform(new THREE.Vector2(1, 1))],
        ["uSeed", new THREE.Uniform(0)],
        ["uVignette", new THREE.Uniform(d.vignette)],
        // Live grain moves every frame, so it reads stronger than the same amount in a still.
        ["uGrain", new THREE.Uniform(d.grain * 0.75)],
        ["uAberration", new THREE.Uniform(d.aberration)],
        ["uHalation", new THREE.Uniform(d.halation)],
        ["uHalationThreshold", new THREE.Uniform(d.halationThreshold)],
        ["uDiffusion", new THREE.Uniform(d.diffusion)],
        ["uContrast", new THREE.Uniform(d.contrast)],
        ["uTone", new THREE.Uniform(d.tone)],
        ["uLeak", new THREE.Uniform(d.leak)],
        ["uVibrance", new THREE.Uniform(d.vibrance)],
        ["uStreak", new THREE.Uniform(d.streak)],
      ]),
    });
    // Mist and halation: the whole image, blurred wide.
    this.mist.radius = 0.85;
    this.mist.levels = 6;
    this.uniforms.get("tMist")!.value = this.mist.texture;
  }

  /** Where the sun is on screen (uv, y up) and how much of it shows, 0..1. Post computes both for its glare. */
  setSun(uv: THREE.Vector2, on: number) {
    (this.uniforms.get("uSun")!.value as THREE.Vector2).copy(uv);
    this.uniforms.get("uSunOn")!.value = on;
  }

  update(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget) {
    this.mist.render(renderer, inputBuffer, null);
    this.uniforms.get("uSeed")!.value = (this.frame++ % 997) * 1.618;
  }

  setSize(width: number, height: number) {
    this.mist.setSize(width, height);
    this.uniforms.get("uAspect")!.value = width / Math.max(1, height);
    (this.uniforms.get("uRes")!.value as THREE.Vector2).set(width, height);
  }

  initialize(renderer: THREE.WebGLRenderer, alpha: boolean, frameBufferType: number) {
    this.mist.initialize(renderer, alpha, frameBufferType);
  }

  dispose() {
    this.mist.dispose();
    super.dispose();
  }
}
