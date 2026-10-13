// Post-processing for the Hall of Fame (pmndrs "postprocessing", half-float buffers).
//
// Pass 0, AO:   N8AO screen-space ambient occlusion (optional). It reads the depth of the RenderPass and
//               rebuilds normals from it, so the waving cloth (vertex displacement) gets correct contact shade.
// Pass 1, HDR:  exposure -> Bloom (mipmap blur, optional) -> God rays from the sun mesh (optional) -> AgX tone mapping.
// Pass 2, LDR:  SMAA -> saturation -> Vignette -> Noise.
// SMAA runs after tone mapping on purpose: edge detection on HDR values misses the bright, thin poles
// against the sun. The renderer itself does no tone mapping (NoToneMapping); AgX happens here, once.
import * as THREE from "three";
import {
  BlendFunction, BloomEffect, Effect, EffectComposer, EffectPass, GodRaysEffect, KernelSize, NoiseEffect, RenderPass,
  HueSaturationEffect, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode, VignetteEffect,
} from "postprocessing";
import { N8AOPostPass } from "n8ao";

/** Scales the HDR image before tone mapping. postprocessing has no exposure control for AgX. */
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
  readonly exposure = new THREE.Uniform(0.7);
  readonly saturation = new HueSaturationEffect({ saturation: 0.28 });

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
    // Bloom reads the scene before exposure, so its threshold is in raw scene units: 4 raw is about 2.2
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
    effects.push(new ToneMappingEffect({ mode: ToneMappingMode.AGX }));
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
    this.composer.render(dt);
  }

  dispose() {
    this.ao?.dispose();
    this.composer.dispose();
  }
}
