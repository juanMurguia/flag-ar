// Three.js scene: renderer, lights, the Argentine flag, an optional startup flag beside it,
// camera controls, picking, export.
import * as THREE from "three";
import { FLAG_HEIGHT, FLAG_WIDTH } from "./cloth";
import { ClothFlag, type Grid } from "./clothFlag";
import { hitLogo, uvToLayout, type ManifestLogo } from "./layout";
import type { Startup } from "./startup";
import { buildWeave, createCanvas, drawFlag, drawStartupFlag, prepareLogo, type LogoImage } from "./texture";
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
const FULL_GRID: Grid = { cols: 65, rows: 43, passes: 10 };
export const PAGE_BACKGROUND = ["#6f62a3", "#d99aa6"] as const; // fallback only; the sky is drawn by WebGL

// Startup flag: same size as the Argentine flag, beside it on its fly side, in the same wind.
const PAIR_GAP = 3.5;
const STARTUP_X = FLAG_WIDTH + PAIR_GAP;
const PAIR_WIDTH = FLAG_WIDTH * 2 + PAIR_GAP;
// The pair view looks from a little to the right: the startup flag comes forward, Argentina recedes.
const PAIR_YAW = 0.06;
const CAMERA_SECONDS = 1.6;
const HOIST_SECONDS = 1.5;
const LOWER_SECONDS = 0.9;
const HOIST_DROP = 26; // world units below its place: out of view
const LOGO_TIMEOUT_MS = 2500; // hoist anyway if the logo is slow
const MAIN_LABEL =
  "Argentine flag waving in the wind, with startup logos. Drag or use the arrow keys to rotate. Use plus and minus to zoom. Press Space to pause.";

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

interface StartupEntry {
  id: string;
  flag: ClothFlag;
  /** Hoist progress, 0 (lowered) to 1 (up). Starts below 0 to wait for a flag that is coming down. */
  raise: number;
  up: boolean;
  ready: boolean; // logo loaded (or timed out): the flag can rise
  logo: LogoImage | null;
  accent: string | null;
}

export class FlagScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private group = new THREE.Group();
  private keyLight: THREE.DirectionalLight;
  private argentina: ClothFlag;
  private startups: StartupEntry[] = []; // the last one with up = true is the current one
  private grid: Grid = { ...FULL_GRID };
  private wind = 1;
  private weave: { overlay: HTMLCanvasElement; normal: THREE.Texture } | null = null;
  private dome: SkyDome;
  private skyTime = 0; // mist drift; stops with the wind

  private logos: ManifestLogo[] = [];
  private images: (LogoImage | null)[] = [];
  private soloIndex: number | null = null;

  // Pair view progress, 0 (Argentina alone) to 1 (Argentina and a startup). Eased for the camera.
  private pair = 0;
  private motionScale = 1; // reduced motion: transitions finish almost at once

  // Camera orbit around the flag. The world (sun, lights, clouds) stays fixed, so rotating changes the light.
  private yaw = 0; private pitch = DEFAULT_PITCH;
  private targetYaw = 0; private targetPitch = DEFAULT_PITCH;
  private zoom = 1;
  private view = { w: 1, h: 1 };
  private insetBottom = 0;
  private insetTarget: number | null = null;
  private pointers = new Map<number, { x: number; y: number; startX: number; startY: number }>();
  private pinchStart = 0;
  private zoomAtPinch = 1;
  private moved = false;
  private raycaster = new THREE.Raycaster();

  private isPaused = false;

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
    canvas.setAttribute("aria-label", MAIN_LABEL);
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
    this.scene.add(key, key.target); // the target moves with the view, so it must be in the scene
    // Sun: the same direction as the sun in the backdrop. From the default view it backlights the flag;
    // orbit toward it and the cloth glows at the edges, orbit away and the front catches it.
    const backLight = new THREE.DirectionalLight(0xffd2a0, 1.8);
    backLight.position.copy(SUN_DIR).multiplyScalar(30);
    this.scene.add(backLight);
    // Fill: indigo from above, lilac haze from below. Keeps shadows soft and colored, never black.
    this.scene.add(new THREE.HemisphereLight(0x7a6aa8, 0x9a80b0, 0.35));

    this.argentina = new ClothFlag(
      (c, weave) => drawFlag(c, { logos: this.images, soloIndex: this.soloIndex, weave }),
      this.grid, renderer.capabilities.getMaxAnisotropy(),
    );
    this.group.add(this.argentina.group);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) this.motionScale = 20;

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
    this.wind = clamp(w, 0, 2);
    for (const f of this.flags()) f.wind = this.wind;
  }

  setLogos(logos: ManifestLogo[], filesBase: string) {
    this.logos = logos;
    this.images = logos.map(() => null);
    this.argentina.invalidate();
    logos.forEach((logo, i) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        if (this.logos !== logos) return;
        this.images[i] = img;
        this.argentina.invalidate();
      };
      img.src = `${filesBase}/${encodeURIComponent(logo.image)}`;
    });
  }

  setSolo(index: number | null) {
    this.soloIndex = index;
    this.argentina.invalidate();
  }

  /**
   * Shows a startup's flag beside the Argentine flag, or null to go back to Argentina alone.
   * A new startup replaces the current one: the old flag comes down, then the new one goes up.
   */
  showStartup(startup: Startup | null) {
    const current = this.currentStartup();
    if ((current?.id ?? null) === (startup?.id ?? null)) return;
    if (current) current.up = false;
    this.renderer.domElement.setAttribute(
      "aria-label",
      startup ? `Argentine flag beside the flag of ${startup.name}. Drag or use the arrow keys to rotate.` : MAIN_LABEL,
    );
    if (!startup) return;

    const entry: StartupEntry = {
      id: startup.id, raise: current ? -0.6 : 0, up: true, ready: false, logo: null, accent: null,
      flag: null as unknown as ClothFlag,
    };
    entry.flag = new ClothFlag(
      (c, weave) => drawStartupFlag(c, { logo: entry.logo, accent: entry.accent, weave }),
      this.grid, this.renderer.capabilities.getMaxAnisotropy(), this.wind,
    );
    if (this.weave) entry.flag.setWeave(this.weave.overlay, this.weave.normal);
    entry.flag.group.position.set(STARTUP_X, -HOIST_DROP, 0);
    entry.flag.group.visible = false;
    this.group.add(entry.flag.group);
    this.startups.push(entry);

    // Hold the hoist until the logo is in, so the flag never rises blank and then changes color.
    const timer = setTimeout(() => (entry.ready = true), LOGO_TIMEOUT_MS);
    const load = (cors: boolean) => {
      const img = new Image();
      img.decoding = "async";
      // CORS lets prepareLogo read the pixels when the files live on another origin.
      if (cors) img.crossOrigin = "anonymous";
      img.onload = () => {
        clearTimeout(timer);
        // Runs once per startup: background removal reads every pixel, so never per frame.
        const { logo, accent } = prepareLogo(img);
        entry.logo = logo;
        entry.accent = accent;
        entry.ready = true;
        entry.flag.invalidate();
      };
      img.onerror = () => {
        // A host without CORS headers fails the CORS request: retry plain, and show the logo uncleaned.
        if (cors) return load(false);
        clearTimeout(timer);
        entry.ready = true;
      };
      img.src = startup.logo;
    };
    load(true);
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

  private currentStartup(): StartupEntry | null {
    const last = this.startups[this.startups.length - 1];
    return last?.up ? last : null;
  }

  private flags(): ClothFlag[] {
    return [this.argentina, ...this.startups.map((s) => s.flag)];
  }

  // ---------- Pause and frame history ----------

  get paused() {
    return this.isPaused;
  }

  /** Number of saved frames of the Argentine flag (the last 6 seconds of motion). */
  get frameCount() {
    return this.argentina.frameCount;
  }

  /** Stops the wind. Every flag freezes on its current frame. Camera controls still work. */
  pause(): number {
    this.isPaused = true;
    for (const f of this.flags()) f.freeze(); // so the newest slider position is exactly the frozen pose
    return this.argentina.frameCount - 1;
  }

  /** Resumes from the frame shown now. Frames after it are dropped. */
  play() {
    if (!this.isPaused) return;
    for (const f of this.flags()) f.resume();
    this.isPaused = false;
    this.lastTime = performance.now();
  }

  /** While paused: shows saved frame `index` (0 = oldest). All flags step back together. */
  showFrame(index: number) {
    if (!this.isPaused) return;
    const fromNewest = this.argentina.frameCount - 1 - index;
    for (const f of this.flags()) f.showFrame(fromNewest);
  }

  // ---------- Capture ----------

  /**
   * Captures exactly what the screen shows (same camera, angle, zoom, and framing),
   * at 2400 px wide, on the page background, with a "flag.ar" watermark at the bottom.
   */
  async capture(): Promise<Blob> {
    for (const f of this.flags()) if (f.textureDirty) f.redraw();
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
    for (const f of this.flags()) f.dispose();
    this.startups = [];
    this.weave?.normal.dispose();
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

  private renderFrame() {
    this.dome.position.copy(this.camera.position); // the backdrop is infinitely far: it never gets closer
    setAuraFrom(this.dome, this.camera);
    this.renderer.render(this.scene, this.camera);
  }

  private loadWeave() {
    if (this.disposed) return;
    const { overlay, normal } = buildWeave();
    const normalTex = new THREE.CanvasTexture(normal);
    normalTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.weave = { overlay, normal: normalTex };
    for (const f of this.flags()) f.setWeave(overlay, normalTex);
  }

  // ---------- Loop ----------

  private loop = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min((now - this.lastTime) / 1000, 0.25);
    this.lastTime = now;

    if (!this.isPaused) setSkyTime(this.dome, (this.skyTime += dt));
    this.argentina.update(dt, this.isPaused);
    this.updateStartups(dt);

    this.yaw += (this.targetYaw - this.yaw) * EASE;
    this.pitch += (this.targetPitch - this.pitch) * EASE;
    if (this.insetTarget !== null) this.insetBottom += (this.insetTarget - this.insetBottom) * EASE;
    this.updateCamera();
    this.renderFrame();
    this.tuneQuality(dt);
  };

  /** Hoists and lowers startup flags, and moves the pair view toward its target. */
  private updateStartups(dt: number) {
    const move = dt * this.motionScale;
    const pairTarget = this.currentStartup() ? 1 : 0;
    this.pair = pairTarget === 1
      ? Math.min(1, this.pair + move / CAMERA_SECONDS)
      : Math.max(0, this.pair - move / CAMERA_SECONDS);

    for (const s of [...this.startups]) {
      if (s.up && s.ready) s.raise = Math.min(1, s.raise + move / HOIST_SECONDS);
      if (!s.up) s.raise -= move / LOWER_SECONDS;
      if (!s.up && s.raise <= 0) {
        s.flag.dispose();
        this.startups.splice(this.startups.indexOf(s), 1);
        continue;
      }
      const r = smoothstep(clamp(s.raise, 0, 1));
      s.flag.group.visible = r > 0;
      s.flag.group.position.y = -HOIST_DROP * (1 - r);
      if (r > 0) s.flag.update(dt, this.isPaused);
    }
  }

  /** On a slow device: lower the cloth grid first, then the pass count, then the shadow size. */
  private tuneQuality(dt: number) {
    if (this.isPaused) return; // a rebuild would drop the saved frames
    this.frames++;
    if (dt > 1 / 30) this.slowFrames++;
    if (this.frames < 120) return;
    const slowSim = this.argentina.cloth.stepMs > 6;
    const slowFrames = this.slowFrames > 60;
    this.frames = 0;
    this.slowFrames = 0;
    if (!slowSim && !slowFrames) return;
    if (this.quality === 0) {
      this.grid = { cols: 48, rows: 32, passes: 10 };
      for (const f of this.flags()) f.rebuild(this.grid);
    } else if (this.quality === 1) {
      this.grid.passes = 6;
      for (const f of this.flags()) f.cloth.passes = 6;
    } else if (this.quality === 2) {
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

  /**
   * Screen pixels at the bottom covered by UI (toolbar, startup details). The flags fit and center above them.
   * The first value applies at once; later changes ease in, so the camera glides instead of jumping.
   */
  setInsetBottom(px: number) {
    const v = Math.max(0, px);
    if (this.insetTarget === null) this.insetBottom = v;
    this.insetTarget = v;
    this.updateCamera();
  }

  private updateCamera(w = this.view.w, h = this.view.h, inset = this.insetBottom) {
    inset = Math.min(inset, h * 0.55);
    const availH = h - inset;
    const tanV = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    const tanH = tanV * (w / h);
    // Pair view: the framed width grows to hold both flags, and the view centers between them.
    const p = smoothstep(this.pair);
    const width = FLAG_WIDTH + (PAIR_WIDTH - FLAG_WIDTH) * p;
    const center = new THREE.Vector3((STARTUP_X / 2) * p, 0, 0);
    const yaw = this.yaw + PAIR_YAW * p;
    // Fit the flags to any screen: the larger of a width fit and a height fit, inside the free area.
    // The pair gets a wider margin: the nearer startup flag looks larger in perspective.
    const fitW = (width * (1.1 + 0.08 * p)) / 2 / tanH;
    const fitH = (FLAG_HEIGHT * 1.55) / 2 / (tanV * (availH / h));
    const dist = Math.max(fitW, fitH) * this.zoom;
    this.camera.aspect = w / h;
    // Shift the view so the flags center in the free area above the bottom UI.
    if (inset > 0) this.camera.setViewOffset(w, h, 0, inset / 2, w, h);
    else this.camera.clearViewOffset();
    // Orbit: yaw around the vertical axis, pitch up and down.
    this.camera.position.set(
      center.x + dist * Math.sin(yaw) * Math.cos(this.pitch),
      dist * Math.sin(this.pitch),
      dist * Math.cos(yaw) * Math.cos(this.pitch),
    );
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();

    // The key light and its shadow box follow the view, so both flags cast soft shadows.
    this.keyLight.position.set(center.x + 10, 3.2, 9);
    this.keyLight.target.position.copy(center);
    const sc = this.keyLight.shadow.camera as THREE.OrthographicCamera;
    const half = 11 + (width - FLAG_WIDTH) / 2;
    if (sc.right !== half) {
      sc.left = -half;
      sc.right = half;
      sc.updateProjectionMatrix();
    }
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

  /** Returns the logo index under the pointer, or -1. Only the Argentine flag carries logos. */
  private pick(e: { clientX: number; clientY: number }): number {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects([this.argentina.front, this.argentina.back], false)[0];
    if (!hit?.uv) return -1;
    return hitLogo(uvToLayout(hit.uv.x, hit.uv.y), this.logos.length, this.soloIndex);
  }
}

function smoothstep(t: number) {
  return t * t * (3 - 2 * t);
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
