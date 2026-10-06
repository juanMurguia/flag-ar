// Three.js scene for the flag: renderer, lights, cloth meshes, controls, picking, export.
import * as THREE from "three";
import { Cloth, FLAG_HEIGHT, FLAG_WIDTH } from "./cloth";
import { LAYOUT_H, LAYOUT_W, TEX_SCALE, hitLogo, uvToLayout, type ManifestLogo } from "./layout";
import { buildWeave, createCanvas, drawFlag, type LogoImage } from "./texture";
import {
  SUN_DIR, buildSkyDome, disposeSkyDome, setAuraFrom, setSkyTime, type SkyDome,
} from "./sky";

const FOV = 32;
const ZOOM_MIN = 0.45;
const ZOOM_MAX = 1.5;
const PITCH_LIMIT = 0.7;
// Camera starts a little below the flag, looking up: hero angle, horizon in the lower third.
const DEFAULT_PITCH = -0.2;
const EASE = 0.12;
const TAP_SLOP = 6;
const EXPORT_WIDTH = 2400;
// Frame history for scrubbing while paused: 6 s at 30 frames per second.
// Full grid: 180 frames × 65 × 43 × 3 floats ≈ 6 MB.
const HISTORY_SECONDS = 6;
const HISTORY_FPS = 30;
const HISTORY_FRAMES = HISTORY_SECONDS * HISTORY_FPS;
export const PAGE_BACKGROUND = ["#6f62a3", "#d99aa6"] as const; // fallback only; the sky is drawn by WebGL

export function supportsWebGL2(): boolean {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

export interface FlagSceneEvents {
  onSelect?: (index: number | null) => void;
  /** Space on the focused flag. */
  onTogglePause?: () => void;
}

export class FlagScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private group = new THREE.Group();
  private keyLight: THREE.DirectionalLight;
  private cloth!: Cloth;
  private geometry!: THREE.PlaneGeometry;
  private front!: THREE.Mesh;
  private back!: THREE.Mesh;
  private frontMat: THREE.MeshPhysicalMaterial;
  private backMat: THREE.MeshPhysicalMaterial;
  private colorCanvas: HTMLCanvasElement;
  private frontTex: THREE.CanvasTexture;
  private backTex: THREE.CanvasTexture;
  private weave: HTMLCanvasElement | null = null;
  private dome: SkyDome;
  private skyTime = 0; // mist drift; stops with the wind

  private logos: ManifestLogo[] = [];
  private images: (LogoImage | null)[] = [];
  private soloIndex: number | null = null;
  private textureDirty = true;

  // Camera orbit around the flag. The world (sun, lights, clouds) stays fixed, so rotating changes the light.
  private yaw = 0; private pitch = DEFAULT_PITCH;
  private targetYaw = 0; private targetPitch = DEFAULT_PITCH;
  private zoom = 1;
  private view = { w: 1, h: 1 };
  private insetBottom = 0;
  private pointers = new Map<number, { x: number; y: number; startX: number; startY: number }>();
  private pinchStart = 0;
  private zoomAtPinch = 1;
  private moved = false;
  private raycaster = new THREE.Raycaster();

  private isPaused = false;
  private history: Float32Array[] = [];
  private historyTime = new Float64Array(HISTORY_FRAMES);
  private historyHead = 0; // next slot to write
  private historyCount = 0;
  private frameIndex = 0;
  private lastRecord = -Infinity;

  private raf = 0;
  private lastTime = 0;
  private frames = 0;
  private slowFrames = 0;
  private quality = 0; // 0 full, 1 smaller grid, 2 fewer passes, 3 smaller shadows
  private resizeObserver: ResizeObserver;
  private disposed = false;

  constructor(private container: HTMLElement, private events: FlagSceneEvents = {}) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      "Argentine flag waving in the wind, with startup logos. Drag or use the arrow keys to rotate. Use plus and minus to zoom. Press Space to pause.",
    );
    canvas.style.touchAction = "none";
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    container.appendChild(canvas);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 2000);
    this.scene.add(this.group);
    this.scene.environment = this.buildEnvironment();
    this.dome = buildSkyDome(renderer);
    this.scene.add(this.dome);

    // Key: warm light from the front right, long soft shadows. Keeps the logos readable.
    const key = new THREE.DirectionalLight(0xffb27a, 1.55);
    key.position.set(10, 3.2, 9);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera as THREE.OrthographicCamera;
    sc.left = -11; sc.right = 11; sc.top = 9; sc.bottom = -9; sc.near = 1; sc.far = 45;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 5;
    this.keyLight = key;
    this.scene.add(key);
    // Sun: the same direction as the sun in the backdrop. From the default view it backlights the flag;
    // orbit toward it and the cloth glows at the edges, orbit away and the front catches it.
    const backLight = new THREE.DirectionalLight(0xffd2a0, 1.8);
    backLight.position.copy(SUN_DIR).multiplyScalar(30);
    this.scene.add(backLight);
    // Fill: indigo from above, lilac haze from below. Keeps shadows soft and colored, never black.
    this.scene.add(new THREE.HemisphereLight(0x7a6aa8, 0x9a80b0, 0.35));

    this.colorCanvas = createCanvas(LAYOUT_W * TEX_SCALE, LAYOUT_H * TEX_SCALE);
    drawFlag(this.colorCanvas, { logos: [], soloIndex: null });
    const aniso = renderer.capabilities.getMaxAnisotropy();
    this.frontTex = new THREE.CanvasTexture(this.colorCanvas);
    this.frontTex.encoding = THREE.sRGBEncoding;
    this.frontTex.anisotropy = aniso;
    this.backTex = this.frontTex.clone();
    this.backTex.wrapS = THREE.RepeatWrapping;
    this.backTex.repeat.x = -1;
    this.backTex.offset.x = 1;
    this.backTex.needsUpdate = true;

    const matOpts: THREE.MeshPhysicalMaterialParameters = { roughness: 0.9, metalness: 0 };
    this.frontMat = new THREE.MeshPhysicalMaterial({ ...matOpts, map: this.frontTex, side: THREE.FrontSide });
    this.backMat = new THREE.MeshPhysicalMaterial({ ...matOpts, map: this.backTex, side: THREE.BackSide });
    for (const m of [this.frontMat, this.backMat]) {
      // r128: sheen is a color.
      (m as unknown as { sheen: THREE.Color }).sheen = new THREE.Color(0x3a3f48);
    }

    this.buildCloth(65, 43, 10);
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.bindInput(canvas);

    if (process.env.NODE_ENV !== "production" && location.search.includes("debug")) (window as unknown as { __flag: unknown }).__flag = { self: this, THREE };
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this.loop);
    // Fabric detail arrives after the first frame, so the flag shows at once.
    requestAnimationFrame(() => setTimeout(() => this.loadWeave(), 0));
  }

  // ---------- Public API ----------

  setWind(w: number) {
    this.cloth.wind = Math.max(0, Math.min(2, w));
  }

  setLogos(logos: ManifestLogo[], filesBase: string) {
    this.logos = logos;
    this.images = logos.map(() => null);
    this.textureDirty = true;
    logos.forEach((logo, i) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        if (this.logos !== logos) return;
        this.images[i] = img;
        this.textureDirty = true;
      };
      img.src = `${filesBase}/${encodeURIComponent(logo.image)}`;
    });
  }

  setSolo(index: number | null) {
    this.soloIndex = index;
    this.textureDirty = true;
  }

  resetView() {
    this.targetYaw = 0;
    this.targetPitch = DEFAULT_PITCH;
    this.zoom = 1;
  }

  rotateBy(dYaw: number, dPitch: number) {
    this.targetYaw += dYaw;
    this.targetPitch = clamp(this.targetPitch + dPitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  zoomBy(factor: number) {
    this.zoom = clamp(this.zoom * factor, ZOOM_MIN, ZOOM_MAX);
  }

  // ---------- Pause and frame history ----------

  get paused() {
    return this.isPaused;
  }

  /** Number of saved frames (the last HISTORY_SECONDS of motion). */
  get frameCount() {
    return this.historyCount;
  }

  /** Stops the wind. The cloth freezes on the current frame. Camera controls still work. */
  pause(): number {
    this.isPaused = true;
    this.recordFrame(); // so the newest slider position is exactly the frozen pose
    this.frameIndex = this.historyCount - 1;
    return this.frameIndex;
  }

  /** Resumes from the frame shown now. Frames after it are dropped. */
  play() {
    if (!this.isPaused) return;
    if (this.historyCount > 0) {
      const slot = this.slotOf(this.frameIndex);
      this.cloth.restore(this.history[slot], this.historyTime[slot]);
      this.historyCount = this.frameIndex + 1;
      this.historyHead = (slot + 1) % HISTORY_FRAMES;
    }
    this.isPaused = false;
    this.lastTime = performance.now();
  }

  /** While paused: shows saved frame `index` (0 = oldest). */
  showFrame(index: number) {
    if (!this.isPaused || this.historyCount === 0) return;
    this.frameIndex = clamp(Math.round(index), 0, this.historyCount - 1);
    this.cloth.pos.set(this.history[this.slotOf(this.frameIndex)]);
    this.syncGeometry();
  }

  private slotOf(index: number) {
    return (this.historyHead - this.historyCount + index + HISTORY_FRAMES * 2) % HISTORY_FRAMES;
  }

  private recordFrame() {
    const n = this.cloth.pos.length;
    const slot = this.historyHead;
    if (!this.history[slot] || this.history[slot].length !== n) this.history[slot] = new Float32Array(n);
    this.history[slot].set(this.cloth.pos);
    this.historyTime[slot] = this.cloth.time;
    this.historyHead = (slot + 1) % HISTORY_FRAMES;
    this.historyCount = Math.min(this.historyCount + 1, HISTORY_FRAMES);
    this.lastRecord = this.cloth.time;
  }

  private clearHistory() {
    this.historyCount = 0;
    this.historyHead = 0;
    this.frameIndex = 0;
  }

  // ---------- Capture ----------

  /**
   * Captures exactly what the screen shows (same camera, angle, zoom, and framing),
   * at 2400 px wide, on the page background, with a "flag.ar" watermark at the bottom.
   */
  async capture(): Promise<Blob> {
    if (this.textureDirty) this.redrawTexture();
    const { w: cw, h: ch } = this.view;
    const w = EXPORT_WIDTH;
    const h = Math.round((EXPORT_WIDTH * ch) / Math.max(1, cw));
    const k = w / cw;
    const pr = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.updateCamera(w, h, this.insetBottom * k);
    this.renderFrame();

    // Copy in the same task: the WebGL buffer is not kept after this frame.
    const out = createCanvas(w, h);
    const ctx = out.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, PAGE_BACKGROUND[0]);
    g.addColorStop(1, PAGE_BACKGROUND[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(this.renderer.domElement, 0, 0);
    drawWatermark(ctx, w, h);

    this.renderer.setPixelRatio(pr);
    this.resize();
    return new Promise((resolve, reject) =>
      out.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG export failed"))), "image/png"),
    );
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.geometry.dispose();
    this.frontMat.dispose();
    this.backMat.dispose();
    this.frontTex.dispose();
    this.backTex.dispose();
    this.scene.environment?.dispose();
    disposeSkyDome(this.dome);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------- Build ----------

  private buildEnvironment(): THREE.Texture {
    // Sunset studio: dusk gradient, a hot sun box low behind the flag, a soft pink fill in front.
    const env = new THREE.Scene();
    // Built-in material on purpose: r128 PMREM encodes RGBE, and only built-in materials apply it.
    const skyGeo = new THREE.SphereGeometry(50, 32, 16);
    const zenith = new THREE.Color(0x2c2c5c), horizon = new THREE.Color(0xf08a4e), ground = new THREE.Color(0x8a74a8);
    const pos = skyGeo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 50; // -1 bottom, 1 top
      const c = y >= 0
        ? horizon.clone().lerp(zenith, THREE.MathUtils.smoothstep(y, 0, 0.7))
        : horizon.clone().lerp(ground, THREE.MathUtils.smoothstep(-y, 0, 0.35));
      colors.set([c.r, c.g, c.b], i * 3);
    }
    skyGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    env.add(new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    const box = (x: number, y: number, z: number, w: number, h: number, power: number, color = 0xffffff) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(power), side: THREE.DoubleSide }),
      );
      m.position.set(x, y, z);
      m.lookAt(0, 0, 0);
      env.add(m);
    };
    const sun = SUN_DIR.clone().multiplyScalar(22);
    box(sun.x, sun.y + 1, sun.z, 14, 8, 5, 0xffa060);
    box(12, 4, 16, 16, 10, 1.6, 0xffb48a);
    box(-14, 12, 14, 14, 10, 0.7, 0xb9a6e0);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const tex = pmrem.fromScene(env, 0.04).texture;
    pmrem.dispose();
    return tex;
  }

  private buildCloth(cols: number, rows: number, passes: number) {
    const wind = this.cloth?.wind ?? 1;
    this.cloth = new Cloth({ cols, rows, passes });
    this.cloth.wind = wind;
    this.clearHistory(); // saved frames belong to the old grid size
    this.lastRecord = -Infinity;
    if (this.front) {
      this.group.remove(this.front, this.back);
      this.geometry.dispose();
    }
    this.geometry = new THREE.PlaneGeometry(FLAG_WIDTH, FLAG_HEIGHT, cols - 1, rows - 1);
    this.front = new THREE.Mesh(this.geometry, this.frontMat);
    this.back = new THREE.Mesh(this.geometry, this.backMat);
    this.front.castShadow = true;
    this.front.receiveShadow = true;
    this.back.receiveShadow = true;
    this.group.add(this.front, this.back);
    this.syncGeometry();
  }

  private renderFrame() {
    this.dome.position.copy(this.camera.position); // the backdrop is infinitely far: it never gets closer
    setAuraFrom(this.dome, this.camera);
    this.renderer.render(this.scene, this.camera);
  }

  private loadWeave() {
    if (this.disposed) return;
    const { overlay, normal } = buildWeave();
    this.weave = overlay;
    const normalTex = new THREE.CanvasTexture(normal);
    normalTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.frontMat.normalMap = normalTex;
    this.frontMat.normalScale.set(0.9, 0.9);
    this.backMat.normalMap = normalTex;
    this.backMat.normalScale.set(-0.9, 0.9); // back side is mirrored
    this.frontMat.needsUpdate = true;
    this.backMat.needsUpdate = true;
    this.textureDirty = true;
  }

  private redrawTexture() {
    drawFlag(this.colorCanvas, { logos: this.images, soloIndex: this.soloIndex, weave: this.weave });
    this.frontTex.needsUpdate = true;
    this.backTex.needsUpdate = true;
    this.textureDirty = false;
  }

  private syncGeometry() {
    const attr = this.geometry.attributes.position as THREE.BufferAttribute;
    (attr.array as Float32Array).set(this.cloth.pos);
    attr.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere(); // picking needs it
  }

  // ---------- Loop ----------

  private loop = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min((now - this.lastTime) / 1000, 0.25);
    this.lastTime = now;

    if (!this.isPaused) setSkyTime(this.dome, (this.skyTime += dt));
    if (!this.isPaused && this.cloth.advance(dt) > 0) {
      this.syncGeometry();
      if (this.cloth.time - this.lastRecord >= 1 / HISTORY_FPS - 1e-6) this.recordFrame();
    }
    if (this.textureDirty) this.redrawTexture();

    this.yaw += (this.targetYaw - this.yaw) * EASE;
    this.pitch += (this.targetPitch - this.pitch) * EASE;
    this.updateCamera();
    this.renderFrame();
    this.tuneQuality(dt);
  };

  /** On a slow device: lower the cloth grid first, then the pass count, then the shadow size. */
  private tuneQuality(dt: number) {
    if (this.isPaused) return; // a rebuild would drop the saved frames
    this.frames++;
    if (dt > 1 / 30) this.slowFrames++;
    if (this.frames < 120) return;
    const slowSim = this.cloth.stepMs > 6;
    const slowFrames = this.slowFrames > 60;
    this.frames = 0;
    this.slowFrames = 0;
    if (!slowSim && !slowFrames) return;
    if (this.quality === 0) this.buildCloth(48, 32, 10);
    else if (this.quality === 1) this.cloth.passes = 6;
    else if (this.quality === 2) {
      this.keyLight.shadow.mapSize.set(1024, 1024);
      // r128 types the map loosely; it is a WebGLRenderTarget. Null makes the renderer rebuild it.
      (this.keyLight.shadow.map as unknown as THREE.WebGLRenderTarget | null)?.dispose();
      (this.keyLight.shadow as unknown as { map: null }).map = null;
    } else return;
    this.quality++;
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.view = { w, h };
    this.updateCamera();
  }

  /** Screen pixels at the bottom covered by UI (the toolbar). The flag fits and centers above them. */
  setInsetBottom(px: number) {
    this.insetBottom = Math.max(0, px);
    this.updateCamera();
  }

  private updateCamera(w = this.view.w, h = this.view.h, inset = this.insetBottom) {
    inset = Math.min(inset, h * 0.4);
    const availH = h - inset;
    const tanV = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    const tanH = tanV * (w / h);
    // Fit the flag to any screen: the larger of a width fit and a height fit, inside the free area.
    const fitW = (FLAG_WIDTH * 1.1) / 2 / tanH;
    const fitH = (FLAG_HEIGHT * 1.55) / 2 / (tanV * (availH / h));
    const dist = Math.max(fitW, fitH) * this.zoom;
    this.camera.aspect = w / h;
    // Shift the view so the flag centers in the free area above the toolbar.
    if (inset > 0) this.camera.setViewOffset(w, h, 0, inset / 2, w, h);
    else this.camera.clearViewOffset();
    // Orbit: yaw around the vertical axis, pitch up and down.
    this.camera.position.set(
      dist * Math.sin(this.yaw) * Math.cos(this.pitch),
      dist * Math.sin(this.pitch),
      dist * Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }

  // ---------- Input ----------

  private bindInput(canvas: HTMLCanvasElement) {
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
      if (this.pointers.size === 1) this.moved = false;
      if (this.pointers.size === 2) {
        this.pinchStart = this.pinchDistance();
        this.zoomAtPinch = this.zoom;
        this.moved = true;
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) {
        if (e.pointerType === "mouse") canvas.style.cursor = this.pick(e) >= 0 ? "pointer" : "grab";
        return;
      }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 2) {
        const d = this.pinchDistance();
        if (this.pinchStart > 0) this.zoom = clamp(this.zoomAtPinch * (this.pinchStart / d), ZOOM_MIN, ZOOM_MAX);
        return;
      }
      if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > TAP_SLOP) this.moved = true;
      if (this.moved) {
        canvas.style.cursor = "grabbing";
        this.rotateBy(-dx * 0.005, dy * 0.005);
      }
    });
    const end = (e: PointerEvent) => {
      const had = this.pointers.delete(e.pointerId);
      if (had && this.pointers.size === 0 && !this.moved && e.type === "pointerup") {
        const i = this.pick(e);
        this.events.onSelect?.(i >= 0 ? i : null);
      }
      if (this.pointers.size < 2) this.pinchStart = 0;
      canvas.style.cursor = "grab";
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoomBy(Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
    canvas.addEventListener("dblclick", () => this.resetView());
    canvas.addEventListener("keydown", (e) => {
      const step = 0.12;
      switch (e.key) {
        case "ArrowLeft": this.rotateBy(-step, 0); break;
        case "ArrowRight": this.rotateBy(step, 0); break;
        case "ArrowUp": this.rotateBy(0, -step); break;
        case "ArrowDown": this.rotateBy(0, step); break;
        case "+": case "=": this.zoomBy(0.9); break;
        case "-": case "_": this.zoomBy(1 / 0.9); break;
        case "0": this.resetView(); break;
        case " ": this.events.onTogglePause?.(); break;
        default: return;
      }
      e.preventDefault();
    });
  }

  private pinchDistance(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  /** Returns the logo index under the pointer, or -1. */
  private pick(e: { clientX: number; clientY: number }): number {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects([this.front, this.back], false)[0];
    if (!hit?.uv) return -1;
    return hitLogo(uvToLayout(hit.uv.x, hit.uv.y), this.logos.length, this.soloIndex);
  }
}

function drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const size = Math.round(Math.max(18, Math.min(w, h) * 0.032));
  ctx.save();
  ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(255, 244, 228, 0.82)"; // warm white, reads on the golden horizon
  ctx.shadowColor = "rgba(60, 25, 20, 0.45)";
  ctx.shadowBlur = size * 0.35;
  ctx.fillText("flag.ar", w / 2, h - size * 1.2);
  ctx.restore();
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
