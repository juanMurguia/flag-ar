// One physical flag: cloth simulation, front and back meshes, fabric materials, painted texture, saved frames.
// The scene can hold several. Each paints its own texture through a Painter callback.
import * as THREE from "three";
import { Cloth, FLAG_HEIGHT, FLAG_WIDTH } from "./cloth";
import { LAYOUT_H, LAYOUT_W, TEX_SCALE } from "./layout";
import { createCanvas } from "./texture";

// Frame history for scrubbing while paused: 6 s at 30 frames per second.
// Full grid: 180 frames × 65 × 43 × 3 floats ≈ 6 MB per flag.
const HISTORY_SECONDS = 6;
const HISTORY_FPS = 30;
const HISTORY_FRAMES = HISTORY_SECONDS * HISTORY_FPS;

export interface Grid {
  cols: number;
  rows: number;
  passes: number;
}

/** Paints the flag face on a LAYOUT_W × LAYOUT_H × TEX_SCALE canvas. `weave` is multiplied over it when present. */
export type Painter = (canvas: HTMLCanvasElement, weave: HTMLCanvasElement | null) => void;

export class ClothFlag {
  readonly group = new THREE.Group();
  cloth!: Cloth;
  front!: THREE.Mesh;
  back!: THREE.Mesh;
  private geometry!: THREE.PlaneGeometry;
  private frontMat: THREE.MeshPhysicalMaterial;
  private backMat: THREE.MeshPhysicalMaterial;
  private canvas: HTMLCanvasElement;
  private frontTex: THREE.CanvasTexture;
  private backTex: THREE.CanvasTexture;
  private weave: HTMLCanvasElement | null = null;
  private dirty = true;

  private history: Float32Array[] = [];
  private historyTime = new Float64Array(HISTORY_FRAMES);
  private historyHead = 0; // next slot to write
  private historyCount = 0;
  private frameIndex = 0;
  private lastRecord = -Infinity;

  constructor(private painter: Painter, grid: Grid, anisotropy: number, wind = 1) {
    this.canvas = createCanvas(LAYOUT_W * TEX_SCALE, LAYOUT_H * TEX_SCALE);
    this.frontTex = new THREE.CanvasTexture(this.canvas);
    this.frontTex.encoding = THREE.sRGBEncoding;
    this.frontTex.anisotropy = anisotropy;
    this.backTex = this.frontTex.clone();
    this.backTex.wrapS = THREE.RepeatWrapping;
    this.backTex.repeat.x = -1;
    this.backTex.offset.x = 1;

    const matOpts: THREE.MeshPhysicalMaterialParameters = { roughness: 0.9, metalness: 0 };
    this.frontMat = new THREE.MeshPhysicalMaterial({ ...matOpts, map: this.frontTex, side: THREE.FrontSide });
    this.backMat = new THREE.MeshPhysicalMaterial({ ...matOpts, map: this.backTex, side: THREE.BackSide });
    for (const m of [this.frontMat, this.backMat]) {
      // r128: sheen is a color.
      (m as unknown as { sheen: THREE.Color }).sheen = new THREE.Color(0x3a3f48);
    }
    this.rebuild(grid, wind);
    this.redraw();
  }

  get wind() {
    return this.cloth.wind;
  }
  set wind(w: number) {
    this.cloth.wind = w;
  }

  /** Marks the texture for a repaint on the next frame. */
  invalidate() {
    this.dirty = true;
  }

  /** Fabric detail: a gray overlay for the colors and a shared normal map. */
  setWeave(overlay: HTMLCanvasElement, normal: THREE.Texture) {
    this.weave = overlay;
    this.frontMat.normalMap = normal;
    this.frontMat.normalScale.set(0.9, 0.9);
    this.backMat.normalMap = normal;
    this.backMat.normalScale.set(-0.9, 0.9); // back side is mirrored
    this.frontMat.needsUpdate = true;
    this.backMat.needsUpdate = true;
    this.dirty = true;
  }

  /** New cloth grid. Saved frames belong to the old grid size, so they are dropped. */
  rebuild(grid: Grid, wind = this.cloth?.wind ?? 1) {
    this.cloth = new Cloth(grid);
    this.cloth.wind = wind;
    this.clearHistory();
    if (this.front) {
      this.group.remove(this.front, this.back);
      this.geometry.dispose();
    }
    this.geometry = new THREE.PlaneGeometry(FLAG_WIDTH, FLAG_HEIGHT, grid.cols - 1, grid.rows - 1);
    this.front = new THREE.Mesh(this.geometry, this.frontMat);
    this.back = new THREE.Mesh(this.geometry, this.backMat);
    this.front.castShadow = true;
    this.front.receiveShadow = true;
    this.back.receiveShadow = true;
    this.group.add(this.front, this.back);
    this.syncGeometry();
  }

  /** Advances the cloth (unless paused) and repaints if needed. */
  update(dt: number, paused: boolean) {
    if (!paused && this.cloth.advance(dt) > 0) {
      this.syncGeometry();
      if (this.cloth.time - this.lastRecord >= 1 / HISTORY_FPS - 1e-6) this.recordFrame();
    }
    if (this.dirty) this.redraw();
  }

  redraw() {
    this.painter(this.canvas, this.weave);
    this.frontTex.needsUpdate = true;
    this.backTex.needsUpdate = true;
    this.dirty = false;
  }

  get textureDirty() {
    return this.dirty;
  }

  // ---------- Pause and frame history ----------

  get frameCount() {
    return this.historyCount;
  }

  /** Freezes on the current pose. It becomes the newest saved frame. */
  freeze() {
    this.recordFrame();
    this.frameIndex = this.historyCount - 1;
  }

  /** Resumes from the frame shown now. Frames after it are dropped. */
  resume() {
    if (this.historyCount === 0) return;
    const slot = this.slotOf(this.frameIndex);
    this.cloth.restore(this.history[slot], this.historyTime[slot]);
    this.historyCount = this.frameIndex + 1;
    this.historyHead = (slot + 1) % HISTORY_FRAMES;
  }

  /** Shows the saved frame `fromNewest` steps back (0 = newest). Clamps to the oldest frame. */
  showFrame(fromNewest: number) {
    if (this.historyCount === 0) return;
    this.frameIndex = Math.max(0, Math.min(this.historyCount - 1, this.historyCount - 1 - Math.round(fromNewest)));
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
    this.lastRecord = -Infinity;
  }

  private syncGeometry() {
    const attr = this.geometry.attributes.position as THREE.BufferAttribute;
    (attr.array as Float32Array).set(this.cloth.pos);
    attr.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere(); // picking needs it
  }

  /** Frees GPU resources. The shared normal map belongs to the scene, so it stays. */
  dispose() {
    this.group.parent?.remove(this.group);
    this.geometry.dispose();
    this.frontMat.dispose();
    this.backMat.dispose();
    this.frontTex.dispose();
    this.backTex.dispose();
    this.history = [];
  }
}
