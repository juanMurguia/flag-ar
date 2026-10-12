// Post-processing for the Hall of Fame (pmndrs "postprocessing", half-float buffers).
//
// Pass 1, HDR:  exposure -> Bloom (mipmap blur) -> God rays from the sun mesh (high tier only) -> AgX tone mapping.
// Pass 2, LDR:  SMAA -> saturation -> Vignette -> Noise.
// SMAA runs after tone mapping on purpose: edge detection on HDR values misses the bright, thin poles
// against the sun. The renderer itself does no tone mapping (NoToneMapping); AgX happens here, once.
import * as THREE from "three";
import {
  BlendFunction, BloomEffect, Effect, EffectComposer, EffectPass, GodRaysEffect, KernelSize, NoiseEffect, RenderPass,
  HueSaturationEffect, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode, VignetteEffect,
} from "postprocessing";

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

export interface PostOptions {
  godRays: boolean;
}

export class Post {
  readonly composer: EffectComposer;
  private hdrPass: EffectPass | null = null;
  private ldrPass: EffectPass;
  readonly exposure = new THREE.Uniform(0.62);
  readonly saturation = new HueSaturationEffect({ saturation: 0.5 });

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private sun: THREE.Mesh,
    opts: PostOptions,
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
    this.setGodRays(opts.godRays);
  }

  setGodRays(on: boolean) {
    if (this.hdrPass) {
      this.composer.removePass(this.hdrPass);
      this.hdrPass.dispose();
    }
    this.composer.removePass(this.ldrPass);
    const effects = [
      new ExposureEffect(this.exposure),
      // Bloom reads the scene before exposure, so its threshold is in raw scene units: 4 raw is about 2.2
      // after exposure. Only the sun, its corona and backlit cloth edges pass. A 0.8 raw threshold blooms the
      // whole sunset sky and veils the image in pink.
      new BloomEffect({ mipmapBlur: true, luminanceThreshold: 4, luminanceSmoothing: 1, intensity: 1.4, radius: 0.75 }),
      ...(on
        ? [new GodRaysEffect(this.camera, this.sun, {
          density: 0.96, decay: 0.93, weight: 0.45, exposure: 0.6, samples: 60, clampMax: 1, kernelSize: KernelSize.SMALL, blur: true,
        })]
        : []),
      new ToneMappingEffect({ mode: ToneMappingMode.AGX }),
    ];
    this.hdrPass = new EffectPass(this.camera, ...effects);
    this.composer.addPass(this.hdrPass);
    this.composer.addPass(this.ldrPass);
  }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h, false);
  }

  render(dt: number) {
    this.composer.render(dt);
  }

  dispose() {
    this.composer.dispose();
  }
}
