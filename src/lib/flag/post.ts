// Post-processing for the Hall of Fame (pmndrs "postprocessing", half-float buffers).
//
// Pass 0, AO:   N8AO screen-space ambient occlusion (optional). It reads the depth of the RenderPass and
//               rebuilds normals from it, so the waving cloth (vertex displacement) gets correct contact shade.
// Pass 1, HDR:  exposure -> Bloom (mipmap blur, optional) -> God rays from the sun mesh (optional) -> ACES tone mapping.
// Pass 2, LDR:  SMAA -> saturation -> Vignette -> Noise.
// SMAA runs after tone mapping on purpose: edge detection on HDR values misses the bright, thin poles
// against the sun. The renderer itself does no tone mapping (NoToneMapping); ACES happens here, once. ACES, not AgX: AgX greys out
// the blue and gold of the golden-hour grade; ACES keeps them saturated, with a filmic contrast.
import * as THREE from "three";
import {
  BlendFunction, BloomEffect, Effect, EffectAttribute, EffectComposer, EffectPass, GodRaysEffect, KernelSize, NoiseEffect, RenderPass,
  HueSaturationEffect, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode, VignetteEffect,
} from "postprocessing";
import { N8AOPostPass } from "n8ao";

/** Scales the HDR image before tone mapping. postprocessing has no exposure control for its tone mappers. */
class ExposureEffect extends Effect {
  constructor(exposure: THREE.Uniform<number>) {
    super(
      "ExposureEffect",
      `uniform float exposure;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = vec4(inputColor.rgb * exposure, inputColor.a);
}`,
      { uniforms: new Map([["exposure", exposure]]) },
    );
  }
}

/**
 * Veiling glare: the sun's light scattering in the lens, on top of everything near it. A low sun in a
 * photo has no edge: it burns out the sky and washes over whatever stands close to it. A disc drawn in the
 * sky reads as a sticker. Three falloffs, a hot core, a halo, and a wide veil, around the sun's screen
 * position, added before tone mapping, so ACES rolls the core off to white. It dims when something stands
 * in front of the sun: five depth reads around the sun's position; sky depth (1.0) means a clear view.
 */
class SunGlareEffect extends Effect {
  constructor(uniforms: Map<string, THREE.Uniform>) {
    super(
      "SunGlareEffect",
      `uniform vec2 sunUv;
uniform float aspect;
uniform float strength;
uniform vec3 glareColor;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 d = (uv - sunUv) * vec2(aspect, 1.0);
  float r = length(d);
  float g = exp(-r * r * 900.0) * 2.2 + exp(-r * r * 60.0) * 0.55 + exp(-r * 4.5) * 0.18;
  float vis = 1.0;
  if (sunUv.x > 0.0 && sunUv.x < 1.0 && sunUv.y > 0.0 && sunUv.y < 1.0) {
    vec2 o = vec2(0.006 / aspect, 0.006);
    vis = (step(0.9999, readDepth(sunUv)) + step(0.9999, readDepth(sunUv + vec2(o.x, 0.0)))
      + step(0.9999, readDepth(sunUv - vec2(o.x, 0.0))) + step(0.9999, readDepth(sunUv + vec2(0.0, o.y)))
      + step(0.9999, readDepth(sunUv - vec2(0.0, o.y)))) / 5.0;
  }
  outputColor = vec4(inputColor.rgb + glareColor * g * strength * (0.25 + 0.75 * vis), inputColor.a);
}`,
      { uniforms, attributes: EffectAttribute.DEPTH },
    );
  }
}

/** The effects a visitor can switch on and off. Each one costs GPU time; all off is the fast path. */
export interface PostFx {
  ao: boolean;
  bloom: boolean;
  godRays: boolean;
}

export class Post {
  readonly composer: EffectComposer;
  private ao: N8AOPostPass | null = null;
  private hdrPass: EffectPass | null = null;
  private ldrPass: EffectPass;
  private fx: PostFx;
  private size = { w: 1, h: 1 };
  readonly exposure = new THREE.Uniform(0.38);
  readonly saturation = new HueSaturationEffect({ saturation: 0.28 });
  private glare = new Map<string, THREE.Uniform>([
    ["sunUv", new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
    ["aspect", new THREE.Uniform(1)],
    ["strength", new THREE.Uniform(0)],
    ["glareColor", new THREE.Uniform(new THREE.Color(1, 0.72, 0.42))],
  ]);
  private sunNdc = new THREE.Vector3();

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private sun: THREE.Mesh,
    fx: PostFx,
  ) {
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
    this.composer.addPass(new RenderPass(scene, camera));
    const noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    noise.blendMode.opacity.value = 0.035;
    this.ldrPass = new EffectPass(
      camera,
      new SMAAEffect({ preset: SMAAPreset.HIGH }),
      this.saturation,
      new VignetteEffect({ offset: 0.3, darkness: 0.45 }),
      noise,
    );
    this.fx = { ...fx };
    this.build();
  }

  setFx(fx: PostFx) {
    if (fx.ao === this.fx.ao && fx.bloom === this.fx.bloom && fx.godRays === this.fx.godRays) return;
    this.fx = { ...fx };
    this.build();
  }

  /** Rebuilds every pass after the RenderPass. Cheap: it runs only when a toggle changes. */
  private build() {
    for (const p of [this.ao, this.hdrPass, this.ldrPass]) if (p) this.composer.removePass(p);
    this.ao?.dispose();
    this.hdrPass?.dispose();
    this.ao = null;

    if (this.fx.ao) {
      const ao = new N8AOPostPass(this.scene, this.camera, this.size.w, this.size.h);
      // The cloud sea writes ray-marched depth (gl_FragDepth), so AO sees every billow. A radius over ~0.5 m
      // turns those billows into dark speckles; 0.35 m keeps soft cloth folds and a light shade on the clouds.
      ao.configuration.aoRadius = 0.35;
      ao.configuration.distanceFalloff = 0.5;
      ao.configuration.intensity = 1.5;
      ao.configuration.halfRes = true; // depth-aware upsampling keeps edges clean at a quarter of the cost
      ao.configuration.gammaCorrection = false; // HDR, linear: tone mapping comes later
      ao.setQualityMode("Medium");
      this.ao = ao;
      this.composer.addPass(ao);
    }

    const effects: Effect[] = [new ExposureEffect(this.exposure)];
    // Bloom reads the scene before exposure, so its threshold is in raw scene units: 4 raw is about 1.5
    // after exposure. Only the sun, its corona and backlit cloth edges pass. A 0.8 raw threshold blooms the
    // whole sunset sky and veils the image in pink.
    if (this.fx.bloom) {
      effects.push(new BloomEffect({ mipmapBlur: true, luminanceThreshold: 4, luminanceSmoothing: 1, intensity: 1.4, radius: 0.75 }));
    }
    if (this.fx.godRays) {
      effects.push(new GodRaysEffect(this.camera, this.sun, {
        density: 0.96, decay: 0.93, weight: 0.45, exposure: 0.6, samples: 60, clampMax: 1, kernelSize: KernelSize.SMALL, blur: true,
      }));
    }
    // Always on, in every quality: without it the low-quality sun is a bare disc of sky glow.
    effects.push(new SunGlareEffect(this.glare));
    effects.push(new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
    this.hdrPass = new EffectPass(this.camera, ...effects);
    this.composer.addPass(this.hdrPass);
    this.composer.addPass(this.ldrPass);
    this.composer.setSize(this.size.w, this.size.h, false);
  }

  setSize(w: number, h: number) {
    this.size = { w, h };
    this.composer.setSize(w, h, false);
  }

  render(dt: number) {
    // Glare follows the sun on screen. It fades as the sun leaves the frame, and is off behind the camera.
    const p = this.sunNdc.copy(this.sun.position).project(this.camera);
    const off = Math.max(Math.abs(p.x), Math.abs(p.y));
    this.glare.get("strength")!.value = p.z < 1 ? 1 - THREE.MathUtils.smoothstep(off, 1.1, 2.2) : 0;
    (this.glare.get("sunUv")!.value as THREE.Vector2).set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    this.glare.get("aspect")!.value = this.size.w / this.size.h;
    this.composer.render(dt);
  }

  dispose() {
    this.ao?.dispose();
    this.composer.dispose();
  }
}
