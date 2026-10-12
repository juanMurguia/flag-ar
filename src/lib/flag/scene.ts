// Two poles at sunset: the Argentine flag (observer's right, higher: place of honor) and a startup's
// flag beside it. Renderer, lights, camera orbit, hoist animation, still and video export.
import * as THREE from "three";
import { FlagStaff } from "./staff";
import {
  LAYOUT_H, LAYOUT_W, buildWeave, createCanvas, drawArgentineFlag, drawStartupFlag, type LogoImage,
} from "./texture";
import { LOOP_SECONDS, foldUniforms } from "./wave";
import {
  SUN_DIR, buildSkyDome, buildSunsetEnvironment, disposeSkyDome, setAuraFrom, setSkyTime, type SkyDome,
} from "./sky";

export const FLAG_WIDTH = 14;
export const FLAG_HEIGHT = 9;
const FOV = 32;
const ZOOM_MIN = 0.45;
const ZOOM_MAX = 1.5;
const PITCH_LIMIT = 0.7;
const DEFAULT_PITCH = -0.16;
const DEFAULT_YAW = 0.05;
const EASE = 0.12;
const EXPORT_WIDTH = 2400;
export const HOIST_SECONDS = 2;
const STARTUP_PHASE = 1.9; // radians: the two flags never move in step

// Poles. Argentina on the right (+x is the observer's right) and 0.8 higher.
const AR_X = 1.5;
const AR_TOP = 5.4;
const SU_X = -FLAG_WIDTH - 2.5;
const SU_TOP = 4.6;
const POLE_LENGTH = 40;
// Stacked layout (portrait screens): one shared pole, Argentina at the peak, the startup below it.
// That is the real protocol when two flags fly on one halyard: the national flag goes on top.
const STACK_GAP = 2;
/** Free areas narrower than this (width / height) use the stacked layout. */
const STACK_BELOW = 0.9;

export type Layout = "side" | "stacked";

interface Box { x0: number; x1: number; y0: number; y1: number }
// Framing boxes around both flags and the finials.
const BOXES: Record<Layout, Box> = {
  side: { x0: SU_X - 0.6, x1: AR_X + FLAG_WIDTH + 0.3, y0: SU_TOP - FLAG_HEIGHT - 1.4, y1: AR_TOP + 1.3 },
  stacked: { x0: -0.7, x1: FLAG_WIDTH + 0.6, y0: AR_TOP - FLAG_HEIGHT * 2 - STACK_GAP - 0.9, y1: AR_TOP + 1.3 },
};

export const PAGE_BACKGROUND = ["#6f62a3", "#d99aa6"] as const;

export function supportsWebGL2(): boolean {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

export interface PairSceneEvents {
  onTogglePause?: () => void;
}

/** Free area of an export, in output pixels. The flags fit and center inside it. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function isMobile() {
  return window.matchMedia?.("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 820;
}

export class PairScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private keyLight: THREE.DirectionalLight;
  private dome: SkyDome;
  private argentina: FlagStaff;
  private startup: FlagStaff;
  private logo: LogoImage | null = null;
  private bg = "#ffffff";
  private hasStartup = false;
  private weave: HTMLCanvasElement | null = null;
  private normalMap: THREE.Texture | null = null;

  private time = 0;
  private wind = 1;
  private windShown = 1; // eased toward `wind`, so the slider never makes the cloth jump
  private isPaused = false;
  private pausedAt = 0;
  private hoist = 0;
  private hoistFrom = 0;
  private hoistTarget = 0;
  private hoistStart = 0;
  private hoistDone: (() => void) | null = null;
  private motionScale = 1;

  private yaw = DEFAULT_YAW; private pitch = DEFAULT_PITCH;
  private targetYaw = DEFAULT_YAW; private targetPitch = DEFAULT_PITCH;
  private zoom = 1;
  private view = { w: 1, h: 1 };
  private insetBottom = 0;
  private insetTarget: number | null = null;
  private insetTop = 0;
  private insetRight = 0;
  private insetRightTarget = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchStart = 0;
  private zoomAtPinch = 1;
  private recording = false;

  private raf = 0;
  private lastTime = 0;
  private resizeObserver: ResizeObserver;
  private disposed = false;

  constructor(private container: HTMLElement, private events: PairSceneEvents = {}) {
    const mobile = isMobile();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    // Phones: device pixel ratio at most 2, fewer cloth segments, smaller textures and shadows.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Bandera argentina flameando junto a un segundo mástil. Arrastrá para girar.");
    canvas.style.touchAction = "none";
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    container.appendChild(canvas);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 2000);
    this.scene.environment = buildSunsetEnvironment(renderer);
    this.dome = buildSkyDome(renderer);
    this.scene.add(this.dome);

    const key = new THREE.DirectionalLight(0xffb27a, 1.5 * Math.PI); // three r155+ lights are physical: × π keeps the pre-r155 look
    key.castShadow = true;
    key.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
    const sc = key.shadow.camera as THREE.OrthographicCamera;
    sc.left = -20; sc.right = 20; sc.top = 12; sc.bottom = -12; sc.near = 1; sc.far = 60;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 5;
    key.shadow.intensity = 0.75; // folds shade each other, but sky light still reaches inside them
    key.position.set(8, 4, 14);
    this.keyLight = key;
    this.scene.add(key, key.target);
    const backLight = new THREE.DirectionalLight(0xffd2a0, 1.7 * Math.PI);
    backLight.position.copy(SUN_DIR).multiplyScalar(30);
    this.scene.add(backLight);
    // Low fill: too much sky light washes the folds flat.
    this.scene.add(new THREE.HemisphereLight(0x7a6aa8, 0x9a80b0, 0.3 * Math.PI));
    this.scene.environmentIntensity = 0.7;
    // Air between the camera and the poles: a thin warm haze lowers contrast with distance, so the
    // shafts fade as they run down and away. The sky dome ignores fog.
    this.scene.fog = new THREE.FogExp2(0xe6c2bd, 0.0042);
    // Sun behind the flags: it shows through the cloth, and fold shading needs its direction.
    const fold = foldUniforms(SUN_DIR, new THREE.Color(0xffc896), 0.32);

    const aniso = renderer.capabilities.getMaxAnisotropy();
    const seg: [number, number] = mobile ? [40, 26] : [80, 52];
    const tex: [number, number] = mobile ? [1400, 900] : [2048, 1317];
    this.argentina = new FlagStaff({ width: FLAG_WIDTH, height: FLAG_HEIGHT, poleLength: POLE_LENGTH, segments: seg, texture: tex, anisotropy: aniso, fold });
    this.argentina.setHoist(1);
    this.startup = new FlagStaff({
      width: FLAG_WIDTH, height: FLAG_HEIGHT, poleLength: POLE_LENGTH, segments: seg, texture: tex,
      anisotropy: aniso, phase: STARTUP_PHASE, fold,
    });
    this.startup.setHoist(0);
    this.scene.add(this.argentina.group, this.startup.group);
    this.applyLayout("side");
    this.argentina.paint((c) => drawArgentineFlag(c));
    this.paintStartup();

    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) this.motionScale = 20;
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.bindInput(canvas);
    if (process.env.NODE_ENV !== "production" && location.search.includes("debug")) (window as unknown as { __pair: unknown }).__pair = this;
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this.loop);
    // Fabric detail after the first frame, so the flags show at once.
    requestAnimationFrame(() => setTimeout(() => this.loadWeave(tex), 0));
  }

  // ---------- Public API ----------

  setWind(w: number) {
    this.wind = clamp(w, 0, 2);
  }

  /** Logo and color for the second flag. Repaints at once (live preview). */
  setStartup(logo: LogoImage | null, bg: string, name?: string) {
    this.logo = logo;
    this.bg = bg;
    this.hasStartup = true;
    this.paintStartup();
    if (name) {
      this.renderer.domElement.setAttribute("aria-label", `Bandera de ${name} junto a la bandera argentina. Arrastrá para girar.`);
    }
  }

  /** Moves the second flag up (1) or down (0) the pole. `seconds` 0 jumps. Resolves when it arrives. */
  hoistTo(target: number, seconds = HOIST_SECONDS): Promise<void> {
    this.hoistDone?.();
    this.hoistFrom = this.hoist;
    this.hoistTarget = clamp(target, 0, 1);
    this.hoistStart = performance.now();
    const ms = (seconds * 1000) / this.motionScale;
    if (ms <= 0 || this.hoist === this.hoistTarget) {
      this.hoist = this.hoistTarget;
      this.startup.setHoist(this.hoist);
      return Promise.resolve();
    }
    this.hoistDuration = ms;
    return new Promise((resolve) => (this.hoistDone = resolve));
  }
  private hoistDuration = 1;

  resetView() {
    this.targetYaw = DEFAULT_YAW;
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

  get paused() {
    return this.isPaused;
  }

  pause() {
    this.isPaused = true;
    this.pausedAt = this.time;
  }

  play() {
    this.isPaused = false;
    this.lastTime = performance.now();
  }

  /** While paused: 0 to 1 moves through one full 4 s cycle of the wind (the motion repeats after it). */
  scrub(f: number) {
    if (!this.isPaused) return;
    this.time = this.pausedAt - (1 - clamp(f, 0, 1)) * LOOP_SECONDS;
  }

  /**
   * Screen pixels at the bottom covered by UI. The flags fit and center above them.
   * The first value applies at once; later changes ease in.
   */
  setInsetBottom(px: number) {
    const v = Math.max(0, px);
    if (this.insetTarget === null) this.insetBottom = v;
    this.insetTarget = v;
  }

  /** Screen pixels at the top covered by UI (corner links). */
  setInsetTop(px: number) {
    this.insetTop = Math.max(0, px);
  }

  /**
   * Screen pixels at the right covered by a side panel. The canvas stays full width under it, so the
   * panel's glass blurs the sky and not the page. Changes ease in.
   */
  setInsetRight(px: number) {
    this.insetRightTarget = Math.max(0, px);
  }

  /**
   * The part of the screen the flags may use: below the top UI, above the bottom UI, left of a side panel.
   * At least 40% of the height and 50% of the width. Exports skip the side panel: it is not in the image.
   */
  private freeArea(w: number, h: number, withSide = true): Rect {
    const bottom = Math.min(this.insetBottom, h * 0.6);
    const top = Math.min(this.insetTop, Math.max(0, h - bottom - h * 0.4));
    const right = withSide ? Math.min(this.insetRight, w * 0.5) : 0;
    return { x: 0, y: top, w: w - right, h: h - bottom - top };
  }

  // ---------- Export ----------

  /** What the screen shows (same angle and zoom), 2400 px wide, with the watermark. */
  async capture(): Promise<Blob> {
    const { w: cw, h: ch } = this.view;
    const w = EXPORT_WIDTH, h = Math.round((EXPORT_WIDTH * ch) / Math.max(1, cw));
    const k = w / cw;
    const f = this.freeArea(cw, ch, false);
    return this.still(w, h, { x: f.x * k, y: f.y * k, w: f.w * k, h: f.h * k }, true, "image/png");
  }

  /**
   * Fixed composition for a download (header, banner, wallpaper). `free` is the area the flags may use:
   * a LinkedIn banner keeps the profile photo corner clear, a phone wallpaper keeps the clock clear.
   */
  poster(w: number, h: number, free: Rect, type: "image/png" | "image/jpeg" = "image/jpeg"): Promise<Blob> {
    return this.still(w, h, free, false, type);
  }

  /** Records one 4 s wind cycle: it loops without a seam. MP4 where the browser can, else WebM. */
  async recordLoop(w = 1280, h = 720): Promise<{ blob: Blob; ext: "mp4" | "webm" }> {
    const canvas = this.renderer.domElement;
    const type = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"]
      .find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
    if (!type || !canvas.captureStream) throw new Error("Este navegador no puede grabar video.");
    this.recording = true;
    const pr = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    const stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    const t0 = this.time;
    const start = performance.now();
    const free = { x: w * 0.06, y: h * 0.08, w: w * 0.88, h: h * 0.84 };
    rec.start();
    await new Promise<void>((resolve) => {
      const frame = () => {
        const s = Math.min((performance.now() - start) / 1000, LOOP_SECONDS);
        this.time = t0 + s;
        this.renderFixed(w, h, free);
        this.watermarkOnCanvas();
        if (s >= LOOP_SECONDS) return resolve();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    rec.stop();
    await done;
    stream.getTracks().forEach((t) => t.stop());
    this.renderer.setPixelRatio(pr);
    this.recording = false;
    this.resize();
    return { blob: new Blob(chunks, { type: type.split(";")[0] }), ext: type.startsWith("video/mp4") ? "mp4" : "webm" };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.argentina.dispose();
    this.startup.dispose();
    this.normalMap?.dispose();
    this.scene.environment?.dispose();
    disposeSkyDome(this.dome);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------- Internals ----------

  private paintStartup() {
    const show = this.hasStartup ? this.bg : "#f4f1ec";
    this.startup.paint((c) => drawStartupFlag(c, { logo: this.logo, bg: show, weave: this.weave }));
  }

  private loadWeave(tex: [number, number]) {
    if (this.disposed) return;
    const { overlay, normal } = buildWeave(tex[0], tex[1]);
    this.weave = overlay;
    this.normalMap = new THREE.CanvasTexture(normal);
    this.normalMap.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.argentina.paint((c) => drawArgentineFlag(c, overlay));
    this.paintStartup();
    this.argentina.setNormalMap(this.normalMap);
    this.startup.setNormalMap(this.normalMap);
  }

  private async still(w: number, h: number, free: Rect, sameView: boolean, type: string): Promise<Blob> {
    const pr = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    if (sameView) this.placeCamera(w, h, free, this.yaw, this.pitch, this.zoom);
    else this.placeCamera(w, h, free, DEFAULT_YAW, DEFAULT_PITCH, 1);
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
      out.toBlob((b) => (b ? resolve(b) : reject(new Error("export failed"))), type, 0.92),
    );
  }

  private renderFixed(w: number, h: number, free: Rect) {
    this.argentina.update(this.time, this.windShown);
    this.startup.update(this.time, this.windShown);
    this.placeCamera(w, h, free, DEFAULT_YAW, DEFAULT_PITCH, 1);
    this.renderFrame();
  }

  /** The video track has no 2D layer, so the watermark is a tiny overlay scene drawn after the 3D. */
  private watermarkScene: { scene: THREE.Scene; camera: THREE.OrthographicCamera; tex: THREE.Texture } | null = null;
  private watermarkOnCanvas() {
    if (!this.watermarkScene) {
      const c = createCanvas(256, 64);
      const ctx = c.getContext("2d")!;
      ctx.font = "700 34px system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(255, 244, 228, 0.85)";
      ctx.shadowColor = "rgba(60, 25, 20, 0.45)";
      ctx.shadowBlur = 8;
      ctx.fillText("flag.ar", 128, 32);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const scene = new THREE.Scene();
      const sprite = new THREE.Mesh(
        new THREE.PlaneGeometry(0.22, 0.055),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }),
      );
      sprite.position.set(0, -0.92, 0);
      scene.add(sprite);
      this.watermarkScene = { scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2), tex };
    }
    const { scene, camera } = this.watermarkScene;
    const aspect = this.renderer.domElement.width / this.renderer.domElement.height;
    camera.left = -aspect; camera.right = aspect; camera.updateProjectionMatrix();
    this.renderer.autoClear = false;
    this.renderer.render(scene, camera);
    this.renderer.autoClear = true;
  }

  private renderFrame() {
    this.dome.position.copy(this.camera.position);
    setAuraFrom(this.dome, this.camera);
    this.renderer.render(this.scene, this.camera);
  }

  private loop = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.recording) return; // the recorder drives frames itself
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;

    if (!this.isPaused) {
      this.time += dt;
      setSkyTime(this.dome, this.time);
    }
    this.windShown += (this.wind - this.windShown) * Math.min(1, dt * 2.5);
    this.argentina.update(this.time, this.windShown);
    this.startup.update(this.time, this.windShown);

    if (this.hoist !== this.hoistTarget) {
      const f = Math.min(1, (now - this.hoistStart) / this.hoistDuration);
      this.hoist = this.hoistFrom + (this.hoistTarget - this.hoistFrom) * easeInOutCubic(f);
      if (f >= 1) {
        this.hoist = this.hoistTarget;
        this.hoistDone?.();
        this.hoistDone = null;
      }
      this.startup.setHoist(this.hoist);
    }

    this.yaw += (this.targetYaw - this.yaw) * EASE;
    this.pitch += (this.targetPitch - this.pitch) * EASE;
    if (this.insetTarget !== null) this.insetBottom += (this.insetTarget - this.insetBottom) * EASE;
    this.insetRight += (this.insetRightTarget - this.insetRight) * EASE;
    const { w, h } = this.view;
    this.placeCamera(w, h, this.freeArea(w, h), this.yaw, this.pitch, this.zoom);
    this.handheld(now / 1000);
    this.renderFrame();
  };

  /**
   * Live view only: a slow drift of a few pixels, like a camera held by hand. Exports skip it (the
   * video must loop), and reduced motion turns it off.
   */
  private handheld(t: number) {
    if (this.motionScale !== 1) return;
    const yaw = Math.sin(t * 0.53) + 0.6 * Math.sin(t * 1.31 + 1.0);
    const pitch = Math.sin(t * 0.71 + 2.0) + 0.5 * Math.sin(t * 1.77);
    this.camera.rotateY(yaw * 0.0012);
    this.camera.rotateX(pitch * 0.0009);
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.view = { w, h };
  }

  /** Moves the flags for a layout. Cheap (two group positions), so it can change per export. */
  private applyLayout(layout: Layout) {
    if (layout === this.layout) return;
    this.layout = layout;
    if (layout === "side") {
      this.argentina.group.position.set(AR_X, AR_TOP, 0);
      this.startup.group.position.set(SU_X, SU_TOP, 0);
    } else {
      this.argentina.group.position.set(0, AR_TOP, 0);
      // Same pole: the startup flag rides below Argentina. Its own pole is hidden.
      this.startup.group.position.set(0, AR_TOP - FLAG_HEIGHT - STACK_GAP, 0);
    }
    this.startup.setPoleVisible(layout === "side");
    const b = BOXES[layout];
    this.keyLight.target.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, 0);
    // From the side, low: the folds catch light on one flank and shade on the other.
    this.keyLight.position.set(this.keyLight.target.position.x + 16, this.keyLight.target.position.y + 7, 10);
  }
  private layout: Layout | null = null;

  /** Fits the framing box into `free` (pixels of a w × h image), seen from yaw and pitch. */
  private placeCamera(w: number, h: number, free: Rect, yaw: number, pitch: number, zoom: number) {
    this.applyLayout(free.w / free.h < STACK_BELOW ? "stacked" : "side");
    const BOX = BOXES[this.layout!];
    const tanV = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    const tanH = tanV * (w / h);
    const bw = BOX.x1 - BOX.x0, bh = BOX.y1 - BOX.y0;
    const fitW = (bw * 1.12) / 2 / (tanH * (free.w / w));
    const fitH = (bh * 1.1) / 2 / (tanV * (free.h / h));
    const dist = Math.max(fitW, fitH) * zoom;
    const center = new THREE.Vector3((BOX.x0 + BOX.x1) / 2, (BOX.y0 + BOX.y1) / 2, 0);
    this.camera.aspect = w / h;
    const ox = w / 2 - (free.x + free.w / 2), oy = h / 2 - (free.y + free.h / 2);
    if (ox !== 0 || oy !== 0) this.camera.setViewOffset(w, h, ox, oy, w, h);
    else this.camera.clearViewOffset();
    this.camera.position.set(
      center.x + dist * Math.sin(yaw) * Math.cos(pitch),
      center.y + dist * Math.sin(pitch),
      dist * Math.cos(yaw) * Math.cos(pitch),
    );
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();
  }

  private bindInput(canvas: HTMLCanvasElement) {
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        this.pinchStart = this.pinchDistance();
        this.zoomAtPinch = this.zoom;
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 2) {
        const d = this.pinchDistance();
        if (this.pinchStart > 0) this.zoom = clamp(this.zoomAtPinch * (this.pinchStart / d), ZOOM_MIN, ZOOM_MAX);
        return;
      }
      canvas.style.cursor = "grabbing";
      this.rotateBy(-dx * 0.005, dy * 0.005);
    });
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
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
}

/** Canvas aspect used by the 2D fallback and the OG image. */
export const TEXTURE_ASPECT = LAYOUT_W / LAYOUT_H;

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number) {
  // Small: 1.6% of the short side, bottom right, out of the way of the flags.
  const size = Math.round(Math.max(14, Math.min(w, h) * 0.022));
  ctx.save();
  ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(255, 244, 228, 0.78)";
  ctx.shadowColor = "rgba(60, 25, 20, 0.45)";
  ctx.shadowBlur = size * 0.35;
  ctx.fillText("flag.ar", w - size * 1.2, h - size * 1.1);
  ctx.restore();
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
