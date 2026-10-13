// Cloth simulation for the hero flag: real physics instead of a wave formula.
//
// A grid of particles (Verlet integration) held together by distance constraints: structural (each
// neighbor), shear (diagonals), and bend (two apart, soft). The hoist column is pinned to the pole.
// Forces per particle: gravity, drag toward the wind's velocity (it carries the cloth downwind), and
// pressure along the cloth's normal (wind hitting a tilted patch pushes it). The wind is turbulent: gusts
// and side eddies that vary in time and along the flag, so the cloth billows, folds, and snaps at the
// free end on its own. One flag: ~900 particles, ~10 constraint passes, well under a millisecond a frame.
//
// Local space matches flagGeometry(): hoist edge at x = 0, top edge at y = 0, the cloth toward +x and -y.
// Particle i = row * nx + col, the same order as the PlaneGeometry vertices, so positions copy straight in.
import * as THREE from "three";

const STEP = 1 / 60; // fixed physics step, s
const MAX_STEPS = 3; // per frame: a stalled frame never runs the sim far ahead
const ITERATIONS = 16; // fewer and the cloth stretches under the wind like rubber
const DAMPING = 0.985; // velocity kept per step: air and cloth losses
const GRAVITY = -9.8;

export interface WindLook {
  /** Mean wind speed, m/s, along +x. */
  speed: number;
  /** Drag toward the wind's velocity, per second: how hard the air carries the cloth. */
  drag: number;
  /** Pressure along the normal, per second: how hard the wind pushes a tilted patch. */
  lift: number;
}

export class ClothSim {
  readonly nx: number;
  readonly ny: number;
  private pos: Float32Array;
  private prev: Float32Array;
  private rest: Float32Array; // pinned positions (the hoist column)
  private normal: Float32Array;
  private links: Int32Array; // pairs of particle indices
  private lengths: Float32Array;
  private stiff: Float32Array;
  private acc = 0;
  private time = 0;

  constructor(width: number, height: number, segX: number, segY: number, private wind: WindLook) {
    this.nx = segX + 1;
    this.ny = segY + 1;
    const n = this.nx * this.ny;
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.rest = new Float32Array(n * 3);
    this.normal = new Float32Array(n * 3);
    for (let r = 0; r < this.ny; r++) {
      for (let c = 0; c < this.nx; c++) {
        const i = (r * this.nx + c) * 3;
        this.pos[i] = (c / segX) * width;
        this.pos[i + 1] = -(r / segY) * height;
        this.pos[i + 2] = 0;
      }
    }
    this.prev.set(this.pos);
    this.rest.set(this.pos);

    const links: number[] = [], lengths: number[] = [], stiff: number[] = [];
    const id = (r: number, c: number) => r * this.nx + c;
    const add = (a: number, b: number, k: number) => {
      const dx = this.pos[a * 3] - this.pos[b * 3], dy = this.pos[a * 3 + 1] - this.pos[b * 3 + 1];
      links.push(a, b);
      lengths.push(Math.hypot(dx, dy));
      stiff.push(k);
    };
    for (let r = 0; r < this.ny; r++) {
      for (let c = 0; c < this.nx; c++) {
        if (c + 1 < this.nx) add(id(r, c), id(r, c + 1), 1);
        if (r + 1 < this.ny) add(id(r, c), id(r + 1, c), 1);
        if (c + 1 < this.nx && r + 1 < this.ny) {
          add(id(r, c), id(r + 1, c + 1), 0.6);
          add(id(r, c + 1), id(r + 1, c), 0.6);
        }
        // Bend: soft, so the cloth folds but does not crumple like paper.
        if (c + 2 < this.nx) add(id(r, c), id(r, c + 2), 0.07);
        if (r + 2 < this.ny) add(id(r, c), id(r + 2, c), 0.07);
      }
    }
    this.links = Int32Array.from(links);
    this.lengths = Float32Array.from(lengths);
    this.stiff = Float32Array.from(stiff);
  }

  /** Advances the simulation by `dt` seconds (fixed sub-steps) and writes the positions into `geo`. */
  update(dt: number, geo: THREE.BufferGeometry) {
    this.acc = Math.min(this.acc + dt, STEP * MAX_STEPS);
    while (this.acc >= STEP) {
      this.step();
      this.acc -= STEP;
    }
    const attr = geo.getAttribute("position") as THREE.BufferAttribute;
    (attr.array as Float32Array).set(this.pos);
    attr.needsUpdate = true;
    geo.computeVertexNormals();
  }

  private step() {
    const { nx, ny, pos, prev, normal } = this;
    this.time += STEP;
    const t = this.time;
    this.computeNormals();
    const { speed, drag, lift } = this.wind;
    const dt2 = STEP * STEP;
    for (let r = 0; r < ny; r++) {
      for (let c = 1; c < nx; c++) {
        const i = (r * nx + c) * 3;
        const x = pos[i], y = pos[i + 1], z = pos[i + 2];
        const vx = (x - prev[i]) / STEP, vy = (y - prev[i + 1]) / STEP, vz = (z - prev[i + 2]) / STEP;
        // Turbulent wind: slow gusts in strength, and eddies that roll down the flag across it (z) and
        // up and down (y). The phase runs along x, so the disturbance travels from the hoist to the fly end.
        const gust = 1 + 0.3 * Math.sin(t * 0.55) + 0.18 * Math.sin(t * 1.7 + 1.3) + 0.08 * Math.sin(t * 4.1);
        const wx = speed * gust;
        const wy = speed * 0.12 * Math.sin(t * 2.3 - x * 0.9 + r * 0.2);
        const wz = speed * (0.4 * Math.sin(t * 4.2 - x * 1.9) + 0.18 * Math.sin(t * 7.3 - x * 3.1 + y) + 0.15 * Math.sin(t * 1.1 + y * 0.8));
        const rx = wx - vx, ry = wy - vy, rz = wz - vz;
        const nxv = normal[i], nyv = normal[i + 1], nzv = normal[i + 2];
        const press = (rx * nxv + ry * nyv + rz * nzv) * lift;
        const ax = drag * rx + press * nxv;
        const ay = drag * ry + press * nyv + GRAVITY;
        const az = drag * rz + press * nzv;
        prev[i] = x;
        prev[i + 1] = y;
        prev[i + 2] = z;
        pos[i] = x + vx * STEP * DAMPING + ax * dt2;
        pos[i + 1] = y + vy * STEP * DAMPING + ay * dt2;
        pos[i + 2] = z + vz * STEP * DAMPING + az * dt2;
      }
    }
    for (let k = 0; k < ITERATIONS; k++) {
      this.satisfy();
      this.pin();
    }
  }

  private satisfy() {
    const { links, lengths, stiff, pos } = this;
    for (let k = 0; k < lengths.length; k++) {
      const a = links[k * 2] * 3, b = links[k * 2 + 1] * 3;
      const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      const f = ((d - lengths[k]) / d) * 0.5 * stiff[k];
      pos[a] += dx * f;
      pos[a + 1] += dy * f;
      pos[a + 2] += dz * f;
      pos[b] -= dx * f;
      pos[b + 1] -= dy * f;
      pos[b + 2] -= dz * f;
    }
  }

  /** The hoist column stays on the pole. */
  private pin() {
    const { nx, ny, pos, prev, rest } = this;
    for (let r = 0; r < ny; r++) {
      const i = r * nx * 3;
      pos[i] = prev[i] = rest[i];
      pos[i + 1] = prev[i + 1] = rest[i + 1];
      pos[i + 2] = prev[i + 2] = rest[i + 2];
    }
  }

  /** Per-particle normals from the neighbors (central differences), for the wind pressure. */
  private computeNormals() {
    const { nx, ny, pos, normal } = this;
    for (let r = 0; r < ny; r++) {
      for (let c = 0; c < nx; c++) {
        const i = (r * nx + c) * 3;
        const l = (r * nx + Math.max(c - 1, 0)) * 3, rr = (r * nx + Math.min(c + 1, nx - 1)) * 3;
        const u = (Math.max(r - 1, 0) * nx + c) * 3, d = (Math.min(r + 1, ny - 1) * nx + c) * 3;
        const ax = pos[rr] - pos[l], ay = pos[rr + 1] - pos[l + 1], az = pos[rr + 2] - pos[l + 2];
        const bx = pos[u] - pos[d], by = pos[u + 1] - pos[d + 1], bz = pos[u + 2] - pos[d + 2];
        let x = ay * bz - az * by, y = az * bx - ax * bz, z = ax * by - ay * bx;
        const len = Math.hypot(x, y, z) || 1;
        x /= len;
        y /= len;
        z /= len;
        normal[i] = x;
        normal[i + 1] = y;
        normal[i + 2] = z;
      }
    }
  }
}
