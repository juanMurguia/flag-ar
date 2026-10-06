// Verlet cloth simulation for the flag. No framework or Three.js code here,
// so plain Three.js and React Three Fiber can both drive it.

export const FLAG_WIDTH = 14;
export const FLAG_HEIGHT = 9;
export const STEP = 1 / 60;
const STEP2 = STEP * STEP;
const DAMPING = 0.986;
const GRAVITY = -8;
const MAX_STEPS_PER_FRAME = 2;
const WARMUP_STEPS = 80;

export interface ClothOptions {
  cols?: number; // particles per row (default 65)
  rows?: number; // particles per column (default 43)
  passes?: number; // constraint passes per step (default 10)
}

export class Cloth {
  readonly cols: number;
  readonly rows: number;
  passes: number;
  /** Wind strength, 0 to 2. */
  wind = 1;
  /** Simulated time in seconds. */
  time = 0;

  /** Current positions, xyz per particle, in PlaneGeometry vertex order. */
  readonly pos: Float32Array;
  private readonly prev: Float32Array;
  private readonly rest: Float32Array; // rest x, y, z per particle
  private readonly x0: Float32Array; // column × spacing
  private readonly y0: Float32Array; // row × spacing
  private readonly ramp: Float32Array;
  private readonly pinned: Uint8Array;
  private readonly linkA: Uint32Array;
  private readonly linkB: Uint32Array;
  private readonly linkRest: Float32Array;
  private readonly weightA: Float32Array;
  private readonly weightB: Float32Array;
  private accumulator = 0;
  /** Average milliseconds spent per simulation step (for quality tuning). */
  stepMs = 0;

  constructor(opts: ClothOptions = {}) {
    this.cols = opts.cols ?? 65;
    this.rows = opts.rows ?? 43;
    this.passes = opts.passes ?? 10;
    const n = this.cols * this.rows;
    const sx = FLAG_WIDTH / (this.cols - 1);
    const sy = FLAG_HEIGHT / (this.rows - 1);

    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.rest = new Float32Array(n * 3);
    this.x0 = new Float32Array(n);
    this.y0 = new Float32Array(n);
    this.ramp = new Float32Array(n);
    this.pinned = new Uint8Array(n);

    // Vertex order matches THREE.PlaneGeometry: rows top to bottom, columns left to right.
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c;
        const x = -FLAG_WIDTH / 2 + c * sx;
        const y = FLAG_HEIGHT / 2 - r * sy;
        this.rest[i * 3] = x;
        this.rest[i * 3 + 1] = y;
        this.rest[i * 3 + 2] = 0;
        this.x0[i] = c * sx;
        this.y0[i] = r * sy;
        this.ramp[i] = c / (this.cols - 1);
        this.pinned[i] = c === 0 ? 1 : 0;
      }
    }
    this.pos.set(this.rest);
    this.prev.set(this.rest);

    // Links: structural, shear, bend. Sorted from the held edge outward,
    // so each pass carries the pinned edge's motion through the cloth.
    const links: [number, number, number][] = [];
    const idx = (r: number, c: number) => r * this.cols + c;
    const add = (a: number, b: number) => {
      const dx = this.rest[a * 3] - this.rest[b * 3];
      const dy = this.rest[a * 3 + 1] - this.rest[b * 3 + 1];
      links.push([a, b, Math.hypot(dx, dy)]);
    };
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = idx(r, c);
        if (c + 1 < this.cols) add(i, idx(r, c + 1));
        if (r + 1 < this.rows) add(i, idx(r + 1, c));
        if (c + 1 < this.cols && r + 1 < this.rows) {
          add(i, idx(r + 1, c + 1));
          add(idx(r, c + 1), idx(r + 1, c));
        }
        if (c + 2 < this.cols) add(i, idx(r, c + 2));
        if (r + 2 < this.rows) add(i, idx(r + 2, c));
      }
    }
    const col = (i: number) => i % this.cols;
    const live = links.filter((l) => !(this.pinned[l[0]] && this.pinned[l[1]]));
    live.sort((p, q) => Math.min(col(p[0]), col(p[1])) - Math.min(col(q[0]), col(q[1])));
    // Store array offsets (index × 3) and per-end weights, so the hot loop has no branches.
    // A link with one pinned end moves only the free end (weight 1 on that end, 0 on the pinned one).
    this.linkA = new Uint32Array(live.map((l) => l[0] * 3));
    this.linkB = new Uint32Array(live.map((l) => l[1] * 3));
    this.linkRest = new Float32Array(live.map((l) => l[2]));
    this.weightA = new Float32Array(live.map((l) => (this.pinned[l[0]] ? 0 : this.pinned[l[1]] ? 1 : 0.5)));
    this.weightB = new Float32Array(live.map((l) => (this.pinned[l[1]] ? 0 : this.pinned[l[0]] ? 1 : 0.5)));

    for (let i = 0; i < WARMUP_STEPS; i++) this.step();
    this.stepMs = 0;
  }

  /** Advance by real elapsed seconds. Runs at most 2 fixed steps; extra time is dropped. */
  advance(dt: number): number {
    this.accumulator = Math.min(this.accumulator + dt, STEP * MAX_STEPS_PER_FRAME);
    let steps = 0;
    while (this.accumulator >= STEP) {
      const t0 = performance.now();
      this.step();
      const ms = performance.now() - t0;
      this.stepMs = this.stepMs === 0 ? ms : this.stepMs * 0.95 + ms * 0.05;
      this.accumulator -= STEP;
      steps++;
    }
    return steps;
  }

  /** Jumps to a saved frame. Velocity restarts at zero, so motion resumes smoothly from that pose. */
  restore(pos: Float32Array, time: number): void {
    this.pos.set(pos);
    this.prev.set(pos);
    this.time = time;
    this.accumulator = 0;
  }

  step(): void {
    this.time += STEP;
    const t = this.time;
    const W = this.wind;
    const { pos, prev, rest, x0, y0, ramp, pinned } = this;
    const gust = 0.78 + 0.22 * Math.sin(t * 0.37) + 0.12 * Math.sin(t * 0.91 + 1.3);
    const n = this.cols * this.rows;

    for (let i = 0; i < n; i++) {
      const k = i * 3;
      if (pinned[i]) {
        // Held edge: floats and flutters a little. No pole.
        const row = Math.floor(i / this.cols);
        const nx = rest[k];
        const ny = rest[k + 1] + 0.05 * Math.sin(0.8 * t + 0.02 * row);
        const nz = 0.14 * Math.sin(1.15 * t + 0.045 * row) * (0.4 + 0.6 * W);
        prev[k] = pos[k];
        prev[k + 1] = pos[k + 1];
        prev[k + 2] = pos[k + 2];
        pos[k] = nx;
        pos[k + 1] = ny;
        pos[k + 2] = nz;
        continue;
      }
      const fx = W * gust * (18 + 6 * Math.sin(t * 0.7 + y0[i] * 0.5));
      const fy = GRAVITY;
      const fz =
        W *
        gust *
        ramp[i] *
        (24 * Math.sin(x0[i] * 0.8 - t * 2.8 + y0[i] * 0.35) +
          9 * Math.sin(t * 1.1 + y0[i] * 0.6) +
          6 * Math.sin(x0[i] * 2.1 - t * 4.3 + y0[i] * 1.3));
      const px = pos[k], py = pos[k + 1], pz = pos[k + 2];
      pos[k] = px + (px - prev[k]) * DAMPING + fx * STEP2;
      pos[k + 1] = py + (py - prev[k + 1]) * DAMPING + fy * STEP2;
      pos[k + 2] = pz + (pz - prev[k + 2]) * DAMPING + fz * STEP2;
      prev[k] = px;
      prev[k + 1] = py;
      prev[k + 2] = pz;
    }

    const { linkA, linkB, linkRest, weightA, weightB } = this;
    const m = linkA.length;
    for (let pass = 0; pass < this.passes; pass++) {
      for (let l = 0; l < m; l++) {
        const ka = linkA[l], kb = linkB[l];
        const dx = pos[kb] - pos[ka];
        const dy = pos[kb + 1] - pos[ka + 1];
        const dz = pos[kb + 2] - pos[ka + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-9;
        const diff = (len - linkRest[l]) / len;
        const sa = diff * weightA[l], sb = diff * weightB[l];
        pos[ka] += dx * sa;
        pos[ka + 1] += dy * sa;
        pos[ka + 2] += dz * sa;
        pos[kb] -= dx * sb;
        pos[kb + 1] -= dy * sb;
        pos[kb + 2] -= dz * sb;
      }
    }
  }
}
