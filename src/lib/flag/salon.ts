// Hall of Fame: an endless grid of flagpoles rising out of a sea of golden sunset clouds. A central
// corridor runs toward the sun; the Argentine flag stands in it, a little larger and taller.
//
// Cost model, so it holds with thousands of flags:
// - Poles and finials: one InstancedMesh each, for every slot in the grid.
// - Flags, levels of detail:
//     near (closest startups in view): own cloth mesh, 512 px texture, physical fabric material;
//     far  (everything else):           one instanced low-poly plane; logos come from a shared atlas,
//                                        flags without a loaded logo show their flat color.
//   Both bend with the same vertex shader, so a flag does not jump when it changes level.
// - Logos load only for flags in view and close. Nothing else is fetched.
// - Empty slots hold muted "tu startup acá" flags, so the hall never looks empty.
import * as THREE from "three";
import type { PublicStartup } from "@/lib/startups/model";
import { CLOUD_BOTTOM, CLOUD_TOP, CloudSea } from "./cloudSea";
import { applyBacklight, weaveNormalMap, type BacklightUniforms } from "./fabric";
import { Post } from "./post";
import { SunsetSky, sunDirection } from "./sunsetSky";
import { createCanvas, drawArgentineFlag, drawStartupFlag, prepareLogo, type LogoImage } from "./texture";
import { applyWave, flagGeometry, waveUniforms, type WaveUniforms } from "./wave";

// ---------- Layout (meters) ----------
const FLAG_W = 3.1, FLAG_H = 2.0;
const POLE_H = 4; // above y = 0: the flag rides just over the cloud tops; the flags matter, not the poles
const POLE_DEPTH = CLOUD_TOP - CLOUD_BOTTOM + 3; // below them, out of sight
const ARG_POLE_H = POLE_H * 1.25;
const ARG_W = FLAG_W * 1.5, ARG_H = FLAG_H * 1.5;
const CORRIDOR = 6; // half-width of the empty corridor down the middle
const DX = 5, DZ = 5.5;
const FIRST_Z = -2;
const ARG_ROWS_IN = 3.5; // the Argentine flag stands this many rows down the corridor
const ARG_Z = FIRST_Z - ARG_ROWS_IN * DZ;
const ARG_X = -ARG_W * 0.45; // pole left of center, so the cloth sits near the middle of the corridor

// ---------- Look ----------
const SUN_ELEVATION = 12;
const SUN_AZIMUTH = 250; // behind the camera and to the right: lights the flag faces, rakes the cloud tops
const HORIZON = new THREE.Color(0xf2b49c);
const FOG_DENSITY = 0.0042;

// ---------- Camera ----------
const START = new THREE.Vector3(0, 4.3, 12);
const START_PITCH = -0.03;
const FOV = 40;
const IDLE_AFTER = 6; // seconds without input before the drift resumes
const DRIFT_SPEED = 0.35; // m/s
const DRIFT_STOP_Z = ARG_Z + 14;
const YAW_LIMIT = 1.15; // rad either side of the corridor axis: you can look at the flags, never back
const PITCH_MIN = -0.3, PITCH_MAX = 0.35;
const EASE_MOVE = 4; // 1/s: how fast position catches its goal
const EASE_LOOK = 9; // 1/s: how fast yaw and pitch catch theirs

const ATLAS_COLS = 8;
const ATLAS_TILE: [number, number] = [256, 168];
const TILE_BLANK = 0, TILE_PLACEHOLDER = 1;
// Empty slots: plain undyed cloth, a few warm whites so the field does not look printed. The color
// belongs to the startups and the Argentine flag.
const PLACEHOLDER_COLORS = ["#fbfaf8", "#f6f5f3", "#fdfcfb", "#f3f2f1"]; // near white: the warm sunset tints them cream on its own
const PLACEHOLDER_LIFT = 1.7; // over 1 on purpose: Lambert under the low sun reads white cloth as cardboard
const FRONT_MARKS = 8; // the first empty slots (the best seats) show the "tu startup acá" mark; the rest only on hover
const HOVER_GLOW = 0.1;
const EASE_HOVER = 7; // 1/s

type Tier = "high" | "low";
const TIERS = {
  high: { steps: 72, dpr: 2, cloth: [32, 20] as const, near: 24, lodRange: 300, godRays: false },
  low: { steps: 28, dpr: 1.5, cloth: [16, 10] as const, near: 10, lodRange: 150, godRays: false },
};

export interface SalonEvents {
  /** A startup was picked (after the camera arrives), or the selection was cleared (null). */
  onSelect?: (index: number | null) => void;
  /** An empty "tu startup acá" flag was clicked. */
  onPlaceholder?: () => void;
}

interface Slot {
  x: number;
  z: number;
  side: 1 | -1;
}

/** Grid size for n startups: at least 10 columns per side and 60 rows, growing with n. */
export function gridSize(n: number) {
  const cols = Math.max(10, Math.ceil(Math.sqrt(n / 6)));
  const rows = Math.max(60, Math.ceil(n / (2 * cols)) + 8);
  return { cols, rows };
}

/**
 * Every slot of a `cols` x `rows` grid (per side), best seats first: the ones the start view sees well,
 * close to the corridor and to the front. Outer columns cost more than deeper rows, because the start view
 * looks down the corridor. Sides alternate, so both sides fill evenly. Startup i takes slot i.
 */
export function gridSlots(cols: number, rows: number): Slot[] {
  const seats: (Slot & { score: number })[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      for (const side of [-1, 1] as const) {
        seats.push({ x: side * (CORRIDOR + col * DX), z: FIRST_Z - row * DZ, side, score: col * 2.2 + row + (side > 0 ? 0.01 : 0) });
      }
    }
  }
  seats.sort((a, b) => a.score - b.score);
  return seats.map(({ x, z, side }) => ({ x, z, side }));
}

/** Wave phase per flag: golden-angle steps, so neighbors never move in step. */
export function phaseOf(i: number) {
  return (i * 2.39996) % (Math.PI * 2);
}

interface NearFlag {
  mesh: THREE.Mesh;
  material: THREE.MeshPhysicalMaterial;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  uniforms: WaveUniforms & BacklightUniforms;
  index: number; // startup index, -1 when free
  painted: "none" | "color" | "logo";
}

export class SalonScene {
  private renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  sky: SunsetSky;
  clouds: CloudSea;
  post: Post;
  private tier: Tier;
  private sunDir: THREE.Vector3;
  private sunColor = new THREE.Color(1.0, 0.8, 0.64);
  private list: PublicStartup[] = [];
  private slots: Slot[] = [];
  private cols = 10;
  private time = 0;
  private raf = 0;
  private last = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver;

  // Instanced layers
  private shafts: THREE.InstancedMesh | null = null;
  private finials: THREE.InstancedMesh | null = null;
  private far: THREE.InstancedMesh | null = null;
  private farUniforms: WaveUniforms & BacklightUniforms;
  private farMaterial: THREE.MeshLambertMaterial;
  private atlasCanvas: HTMLCanvasElement;
  private atlas: THREE.CanvasTexture;
  private atlasSlots = new Map<number, number>(); // startup index -> tile
  private atlasDirty = false;
  private aAtlas: THREE.InstancedBufferAttribute | null = null;
  private aGlow: THREE.InstancedBufferAttribute | null = null;
  private aMark: THREE.InstancedBufferAttribute | null = null; // atlas alpha scale: shows or hides the placeholder mark
  private hovered = -1; // empty slot under the mouse
  private hoverFade = new Map<number, number>(); // empty slot -> 0..1, easing in or out
  private hoverAt: { clientX: number; clientY: number } | null = null; // last mouse position to pick, once per frame
  private hidden = new Set<number>(); // slots drawn by a near flag, or out of range

  private near: NearFlag[] = [];
  private argUniforms: WaveUniforms & BacklightUniforms;
  private images = new Map<string, LogoImage | "loading" | "error">();
  private lodTimer = 0;
  private knownIds: Set<string> | null = null;
  private rising = new Map<number, number>(); // slot -> start time
  private highlight = new Set<number>();

  // Camera
  private pos = START.clone();
  private yaw = 0; // 0 looks down the corridor (-z), toward the sun
  private pitch = START_PITCH;
  // Input moves these goals; the camera eases toward them each frame.
  private goalPos = START.clone();
  private goalYaw = 0;
  private goalPitch = START_PITCH;
  private floatPhase = 0;
  private idle = 0;
  private flight: { from: THREE.Vector3; to: THREE.Vector3; yaw0: number; yaw1: number; p0: number; p1: number; t: number; dur: number; select: number | null } | null = null;
  private pointers = new Map<number, { x: number; y: number; sx: number; sy: number }>();
  private pinch = 0;
  private moved = false;
  private raycaster = new THREE.Raycaster();
  private keys = new Set<string>();

  // FPS watch, for the automatic drop to the low tier.
  private fpsFrames = 0;
  private fpsTime = 0;
  private fpsChecks = 0;

  constructor(private container: HTMLElement, private events: SalonEvents = {}) {
    const coarse = window.matchMedia?.("(pointer: coarse)").matches;
    const small = window.matchMedia?.("(max-width: 767px)").matches;
    this.tier = coarse || small ? "low" : "high";
    const t = TIERS[this.tier];

    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance", stencil: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, t.dpr));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    this.renderer = renderer;
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "application");
    canvas.setAttribute("aria-label", "Salón de la Fama en 3D. Arrastrá para mirar, rueda para avanzar por el pasillo, click en una bandera para ver su ficha.");
    Object.assign(canvas.style, { display: "block", width: "100%", height: "100%", touchAction: "none", cursor: "grab" });
    container.appendChild(canvas);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 40000);
    // Sun low and behind the camera: it lights the flags from the front, and it is never in the start view.
    this.sunDir = sunDirection(SUN_ELEVATION, SUN_AZIMUTH);

    this.scene.fog = new THREE.FogExp2(HORIZON.clone(), FOG_DENSITY);
    this.scene.background = HORIZON.clone();
    this.sky = new SunsetSky({ sunDir: this.sunDir, sunColor: this.sunColor, horizon: HORIZON }, 1);
    this.scene.add(this.sky.group);
    this.scene.environment = this.sky.environment(renderer);
    this.scene.environmentIntensity = 0.55; // low fill, so the sun shapes the folds
    this.clouds = new CloudSea({ sunDir: this.sunDir, sunColor: this.sunColor, horizon: HORIZON, fogDensity: FOG_DENSITY }, t.steps);
    this.scene.add(this.clouds.group);

    const sun = new THREE.DirectionalLight(0xffdcc4, 3);
    sun.position.copy(this.sunDir).multiplyScalar(100);
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0xdcd6ea, 0xf0cdb8, 0.25));

    const bl = (): BacklightUniforms => ({
      uSunDir: { value: this.sunDir }, uSunColor: { value: this.sunColor }, uBacklight: { value: 1.6 }, uGlow: { value: 0 },
    });
    this.argUniforms = { ...waveUniforms(ARG_W, ARG_H, 0.6), ...bl() };
    this.farUniforms = { ...waveUniforms(FLAG_W, FLAG_H), ...bl() };
    this.buildArgentina();

    this.atlasCanvas = createCanvas(ATLAS_TILE[0] * ATLAS_COLS, ATLAS_TILE[1] * ATLAS_COLS);
    this.atlas = new THREE.CanvasTexture(this.atlasCanvas);
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    this.atlas.generateMipmaps = false; // mipmaps would bleed between tiles
    this.atlas.minFilter = THREE.LinearFilter;
    this.drawPlaceholderTile();
    this.farMaterial = this.atlasMaterial();

    this.post = new Post(renderer, this.scene, this.camera, this.sky.raySun, { godRays: t.godRays });

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.bindInput(canvas);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
    if (process.env.NODE_ENV !== "production") (window as unknown as { __salon?: SalonScene }).__salon = this; // tuning from devtools
  }

  // ---------- Public API ----------

  /** Lays out the grid. New startups (not in the previous call) rise up their pole. */
  setStartups(list: PublicStartup[]) {
    const prevIds = this.knownIds;
    this.list = list;
    this.knownIds = new Set(list.map((s) => s.id));
    for (const n of this.near) this.freeNear(n);
    this.atlasSlots.clear();
    this.hidden.clear();
    this.rising.clear();
    for (const m of [this.shafts, this.finials, this.far]) {
      if (!m) continue;
      this.scene.remove(m);
      m.geometry.dispose();
    }
    const { cols, rows } = gridSize(list.length);
    this.cols = cols;
    const count = cols * 2 * rows;
    this.slots = gridSlots(cols, rows);

    const metal = new THREE.MeshStandardMaterial({ color: 0xd9dce2, metalness: 1, roughness: 0.3 });
    const shaftGeo = new THREE.CylinderGeometry(0.055, 0.075, POLE_H + POLE_DEPTH, 8, 1, true);
    shaftGeo.translate(0, (POLE_H - POLE_DEPTH) / 2, 0);
    this.shafts = new THREE.InstancedMesh(shaftGeo, metal, count);
    const finialGeo = new THREE.SphereGeometry(0.12, 10, 6);
    finialGeo.translate(0, POLE_H + 0.1, 0);
    this.finials = new THREE.InstancedMesh(finialGeo, metal.clone(), count);

    const farGeo = flagGeometry(FLAG_W, FLAG_H, 14, 7);
    const phases = new Float32Array(count);
    const atlasAttr = new Float32Array(count * 2);
    farGeo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
    this.aAtlas = new THREE.InstancedBufferAttribute(atlasAttr, 2);
    this.aGlow = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    farGeo.setAttribute("aAtlas", this.aAtlas);
    farGeo.setAttribute("aGlow", this.aGlow);
    const marks = new Float32Array(count);
    for (let i = 0; i < count; i++) marks[i] = this.baseMark(i, list.length);
    this.aMark = new THREE.InstancedBufferAttribute(marks, 1);
    farGeo.setAttribute("aMark", this.aMark);
    this.hovered = -1;
    this.hoverFade.clear();
    this.far = new THREE.InstancedMesh(farGeo, this.farMaterial, count);
    this.far.frustumCulled = false;

    const m = new THREE.Matrix4();
    const color = new THREE.Color();
    const blank = this.tileOffset(TILE_BLANK), ph = this.tileOffset(TILE_PLACEHOLDER);
    for (let i = 0; i < count; i++) {
      const p = this.slots[i];
      m.makeTranslation(p.x, 0, p.z);
      this.shafts.setMatrixAt(i, m);
      this.finials.setMatrixAt(i, m);
      this.far.setMatrixAt(i, this.flagMatrix(i, m));
      phases[i] = phaseOf(i);
      const real = i < list.length;
      if (real) color.set(list[i].bgColor);
      else color.set(PLACEHOLDER_COLORS[(i * 7 + (i >> 3)) % PLACEHOLDER_COLORS.length]).multiplyScalar(PLACEHOLDER_LIFT);
      this.far.setColorAt(i, color);
      const o = real ? blank : ph;
      atlasAttr[i * 2] = o[0];
      atlasAttr[i * 2 + 1] = o[1];
    }
    if (prevIds) {
      list.forEach((s, i) => {
        if (!prevIds.has(s.id)) this.rising.set(i, this.time);
      });
    }
    for (const mesh of [this.shafts, this.finials, this.far]) this.scene.add(mesh);
    this.lodTimer = 0;
  }

  /** Flies to stand in front of startup flag `i`, highlights it, and reports the selection on arrival. */
  focus(i: number) {
    const p = this.slots[i];
    if (!p || i >= this.list.length) return;
    // Stand halfway to the next row toward the start (nothing in between), at flag height. Look a little
    // to the right of the flag so it sits left of center, clear of the card.
    const center = new THREE.Vector3(p.x + FLAG_W / 2, POLE_H - FLAG_H / 2, p.z);
    const stand = new THREE.Vector3(center.x + 0.4, center.y + 0.3, p.z + DZ * 0.55);
    const look = center.clone().add(new THREE.Vector3(1.1, 0, 0));
    this.flyTo(stand, look, i);
    this.setHighlight([i]);
  }

  /** Glows these startup flags (search, city filter). Empty clears. */
  setHighlight(indices: number[]) {
    this.highlight = new Set(indices.filter((i) => i >= 0 && i < this.list.length));
    if (this.aGlow) {
      (this.aGlow.array as Float32Array).fill(0);
      this.aGlow.needsUpdate = true;
    }
  }

  /** Flies to the nearest of these flags (city filter) and highlights all of them. */
  focusAny(indices: number[]) {
    if (!indices.length) {
      this.setHighlight([]);
      return;
    }
    let best = indices[0], bd = Infinity;
    for (const i of indices) {
      const p = this.slots[i];
      if (!p) continue;
      const d = (p.x - this.pos.x) ** 2 + (p.z - this.pos.z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    this.focus(best);
    this.setHighlight(indices);
  }

  /** Back to the start view, facing the sun and the Argentine flag. */
  home() {
    const look = this.lookFrom(START, 0, START_PITCH);
    this.flyTo(START.clone(), look, null);
    this.setHighlight([]);
  }

  walk(meters: number) {
    this.flight = null;
    this.goalPos.x -= Math.sin(this.goalYaw) * meters;
    this.goalPos.z -= Math.cos(this.goalYaw) * meters;
    this.clampPos();
  }

  private turn(dYaw: number, dPitch: number) {
    this.flight = null;
    this.goalYaw = THREE.MathUtils.clamp(this.goalYaw + dYaw, -YAW_LIMIT, YAW_LIMIT);
    this.goalPitch = THREE.MathUtils.clamp(this.goalPitch + dPitch, PITCH_MIN, PITCH_MAX);
  }

  /** Offscreen render at full quality, whatever the tier. Returns a JPEG. */
  async snapshot(width: number, height: number): Promise<Blob> {
    const prevTier = this.tier;
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    const prevDpr = this.renderer.getPixelRatio();
    if (prevTier !== "high") this.applyTier("high");
    this.renderer.setPixelRatio(1);
    this.post.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.updateLod();
    this.post.render(1 / 60);
    const blob = await new Promise<Blob | null>((res) => this.renderer.domElement.toBlob(res, "image/jpeg", 0.92));
    this.renderer.setPixelRatio(prevDpr);
    if (prevTier !== "high") this.applyTier(prevTier);
    this.post.setSize(size.x, size.y);
    this.resize();
    if (!blob) throw new Error("No se pudo generar la imagen.");
    return blob;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.post.dispose();
    this.clouds.dispose();
    this.sky.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((mm) => mm.dispose());
      }
    });
    for (const n of this.near) n.texture.dispose();
    this.atlas.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------- Build ----------

  private buildArgentina() {
    const metal = new THREE.MeshStandardMaterial({ color: 0xdfe2e8, metalness: 1, roughness: 0.28 });
    const gold = new THREE.MeshStandardMaterial({ color: 0xe0b040, metalness: 1, roughness: 0.2 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.1, ARG_POLE_H + POLE_DEPTH, 12, 1, true), metal);
    shaft.position.set(ARG_X, (ARG_POLE_H - POLE_DEPTH) / 2, ARG_Z);
    const finial = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 10), gold);
    finial.position.set(ARG_X, ARG_POLE_H + 0.17, ARG_Z);
    this.scene.add(shaft, finial);

    const canvas = createCanvas(1400, 900);
    drawArgentineFlag(canvas);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const mat = this.fabricMaterial(tex, this.argUniforms);
    const flag = new THREE.Mesh(flagGeometry(ARG_W, ARG_H, 48, 30), mat);
    flag.frustumCulled = false;
    flag.position.set(ARG_X + 0.08, ARG_POLE_H - 0.25, ARG_Z);
    this.scene.add(flag);
  }

  private fabricMaterial(map: THREE.Texture, uniforms: WaveUniforms & BacklightUniforms) {
    const normal = weaveNormalMap();
    const mat = new THREE.MeshPhysicalMaterial({
      map, side: THREE.DoubleSide, roughness: 0.94, metalness: 0, specularIntensity: 0.12,
      sheen: 0.5, sheenColor: new THREE.Color(0xf4ece6), sheenRoughness: 0.9,
      normalMap: normal, normalScale: new THREE.Vector2(0.12, 0.12),
    });
    mat.normalMap!.repeat.set(36, 24);
    applyWave(mat, uniforms, false, true);
    return applyBacklight(mat, uniforms);
  }

  /**
   * Far flags: Lambert, wave, instanced, with a per-instance atlas tile. The tile's alpha mixes the logo
   * over the instance color: blank tile = flat color, placeholder tile = white mark on a muted color.
   */
  private atlasMaterial(): THREE.MeshLambertMaterial {
    const mat = new THREE.MeshLambertMaterial({ map: this.atlas, side: THREE.DoubleSide });
    applyWave(mat, this.farUniforms, true, true);
    const waveCompile = mat.onBeforeCompile;
    const scale = { value: new THREE.Vector2(1 / ATLAS_COLS - 0.002, 1 / ATLAS_COLS - 0.002) };
    mat.onBeforeCompile = (shader, r) => {
      waveCompile.call(mat, shader, r);
      shader.uniforms.uAtlasScale = scale;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute vec2 aAtlas;\nattribute float aMark;\nvarying float vMark;\nuniform vec2 uAtlasScale;")
        .replace("#include <uv_vertex>", "#include <uv_vertex>\nvMark = aMark;\n#ifdef USE_MAP\n  vMapUv = uv * uAtlasScale + aAtlas;\n#endif");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vMark;")
        .replace("#include <map_fragment>", "")
        .replace(
          "#include <color_fragment>",
          "vec4 atlasTexel = texture2D(map, vMapUv);\n#ifdef USE_COLOR\n  diffuseColor.rgb = mix(vColor.rgb, atlasTexel.rgb, atlasTexel.a * vMark);\n#else\n  diffuseColor.rgb = atlasTexel.rgb;\n#endif",
        );
    };
    mat.customProgramCacheKey = () => "flag-wave-atlas";
    return applyBacklight(mat, this.farUniforms, true);
  }

  private drawPlaceholderTile() {
    const [tw, th] = ATLAS_TILE;
    const ctx = this.atlasCanvas.getContext("2d")!;
    const col = TILE_PLACEHOLDER % ATLAS_COLS, row = Math.floor(TILE_PLACEHOLDER / ATLAS_COLS);
    const x0 = col * tw, y0 = row * th;
    ctx.save();
    ctx.translate(x0, y0);
    ctx.clearRect(0, 0, tw, th);
    // A thin ring with a plus, like a logo mark, and the invitation under it. Warm grey ink on the cream cloth.
    ctx.strokeStyle = "rgba(110,100,96,0.45)";
    ctx.fillStyle = "rgba(110,100,96,0.45)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(tw / 2, th * 0.42, th * 0.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillRect(tw / 2 - 2.5, th * 0.42 - th * 0.1, 5, th * 0.2);
    ctx.fillRect(tw / 2 - th * 0.1, th * 0.42 - 2.5, th * 0.2, 5);
    ctx.font = "500 18px system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(110,100,96,0.5)";
    ctx.fillText("tu startup acá", tw / 2, th * 0.83);
    ctx.restore();
    this.atlas.needsUpdate = true;
  }

  // ---------- Levels of detail ----------

  private flagMatrix(i: number, m: THREE.Matrix4) {
    const p = this.slots[i];
    if (this.hidden.has(i)) return m.makeScale(0, 0, 0);
    return m.makeTranslation(p.x + 0.06, POLE_H - 0.2 - this.riseDrop(i), p.z);
  }

  /** Mark strength for slot i at rest: startups 1 (their tile is the logo), front empty slots 1, the rest 0. */
  private baseMark(i: number, startups = this.list.length) {
    return i < startups + FRONT_MARKS ? 1 : 0;
  }

  /** Eases the hovered empty slot in (mark and a faint warm glow) and the previous one back out. */
  private updateHover(dt: number) {
    if (this.hoverAt) {
      const hit = this.pointers.size === 0 && !this.flight ? this.pick(this.hoverAt) : null;
      const next = hit?.kind === "placeholder" ? hit.index : -1;
      if (next !== this.hovered) {
        this.hovered = next;
        if (next >= 0 && !this.hoverFade.has(next)) this.hoverFade.set(next, 0);
        this.renderer.domElement.style.cursor = next >= 0 || hit?.kind === "startup" ? "pointer" : "grab";
      }
      this.hoverAt = null;
    }
    if (!this.hoverFade.size || !this.aMark || !this.aGlow) return;
    const k = 1 - Math.exp(-EASE_HOVER * dt);
    for (const [i, v] of this.hoverFade) {
      const goal = i === this.hovered ? 1 : 0;
      const nv = Math.abs(goal - v) < 0.002 ? goal : v + (goal - v) * k;
      this.aMark.setX(i, Math.max(this.baseMark(i), nv));
      this.aGlow.setX(i, nv * HOVER_GLOW);
      if (nv === 0) this.hoverFade.delete(i);
      else this.hoverFade.set(i, nv);
    }
    this.aMark.needsUpdate = true;
    this.aGlow.needsUpdate = true;
  }

  /** How far below its top position flag i is, while it rises. */
  private riseDrop(i: number) {
    const t0 = this.rising.get(i);
    if (t0 === undefined) return 0;
    const k = Math.min(1, (this.time - t0) / 4);
    const ease = 1 - Math.pow(1 - k, 3);
    return (POLE_H + 1) * (1 - ease);
  }

  private tileOffset(tile: number): [number, number] {
    const col = tile % ATLAS_COLS, row = Math.floor(tile / ATLAS_COLS);
    return [col / ATLAS_COLS + 0.001, 1 - (row + 1) / ATLAS_COLS + 0.001];
  }

  /** Picks the near set and the atlas set: startup flags in view, closest first. Runs 4 times a second. */
  private updateLod() {
    if (!this.far) return;
    const t = TIERS[this.tier];
    this.camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse),
    );
    const sphere = new THREE.Sphere(new THREE.Vector3(), 4);
    const visible: { i: number; d: number }[] = [];
    for (let i = 0; i < this.list.length; i++) {
      const p = this.slots[i];
      sphere.center.set(p.x + FLAG_W / 2, POLE_H - FLAG_H / 2, p.z);
      const d = sphere.center.distanceToSquared(this.pos);
      if (d < t.lodRange * t.lodRange && frustum.intersectsSphere(sphere)) visible.push({ i, d });
    }
    visible.sort((a, b) => a.d - b.d);
    const nearSet = new Set(visible.slice(0, t.near).map((v) => v.i));
    const midSet = visible.slice(t.near, t.near + ATLAS_COLS * ATLAS_COLS - 2).map((v) => v.i);

    for (const n of this.near) if (n.index >= 0 && !nearSet.has(n.index)) this.freeNear(n);
    const held = new Set(this.near.filter((n) => n.index >= 0).map((n) => n.index));
    for (const i of nearSet) {
      if (held.has(i)) continue;
      const n = this.near.find((x) => x.index < 0) ?? this.makeNear();
      this.assignNear(n, i);
    }

    // Hidden: near flags (drawn by their own mesh), and on the low tier, everything past the range.
    this.hidden = new Set(nearSet);
    if (this.tier === "low") {
      const r2 = t.lodRange * t.lodRange * 1.6;
      for (let i = 0; i < this.slots.length; i++) {
        const p = this.slots[i];
        if ((p.x - this.pos.x) ** 2 + (p.z - this.pos.z) ** 2 > r2) this.hidden.add(i);
      }
    }
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.slots.length; i++) this.far.setMatrixAt(i, this.flagMatrix(i, m));
    this.far.instanceMatrix.needsUpdate = true;

    // Atlas: logos for the next closest flags.
    const midKeep = new Set(midSet);
    for (const [i] of this.atlasSlots) if (!midKeep.has(i)) this.atlasSlots.delete(i);
    const used = new Set(this.atlasSlots.values());
    const attr = this.aAtlas!;
    for (let i = 0; i < this.list.length; i++) {
      const o = this.tileOffset(this.atlasSlots.get(i) ?? TILE_BLANK);
      attr.setXY(i, o[0], o[1]);
    }
    for (const i of midSet) {
      if (this.atlasSlots.has(i)) continue;
      const img = this.logoFor(i);
      if (!img) continue; // flat color until the logo loads
      let tile = 2;
      while (used.has(tile) && tile < ATLAS_COLS * ATLAS_COLS) tile++;
      if (tile >= ATLAS_COLS * ATLAS_COLS) break;
      used.add(tile);
      this.atlasSlots.set(i, tile);
      this.drawTile(tile, i, img);
      const o = this.tileOffset(tile);
      attr.setXY(i, o[0], o[1]);
    }
    attr.needsUpdate = true;
    if (this.atlasDirty) {
      this.atlas.needsUpdate = true;
      this.atlasDirty = false;
    }
    for (const n of this.near) if (n.index >= 0 && n.painted !== "logo") this.paintNear(n);
  }

  private drawTile(tile: number, i: number, img: LogoImage) {
    const [tw, th] = ATLAS_TILE;
    const c = createCanvas(tw, th);
    drawStartupFlag(c, { logo: img, bg: this.list[i].bgColor });
    const col = tile % ATLAS_COLS, row = Math.floor(tile / ATLAS_COLS);
    this.atlasCanvas.getContext("2d")!.drawImage(c, col * tw, row * th);
    this.atlasDirty = true;
  }

  /** The logo for flag i, or null while it loads. Starts the load on first ask. */
  private logoFor(i: number): LogoImage | null {
    const url = this.list[i]?.logoUrl;
    if (!url) return null;
    const v = this.images.get(url);
    if (v === "loading" || v === "error") return null;
    if (v) return v;
    this.images.set(url, "loading");
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (this.disposed) return;
      try {
        this.images.set(url, prepareLogo(img).logo);
      } catch {
        this.images.set(url, img);
      }
      this.lodTimer = 0;
    };
    img.onerror = () => this.images.set(url, "error");
    img.src = url;
    return null;
  }

  private makeNear(): NearFlag {
    const canvas = createCanvas(512, 336);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const uniforms = { ...waveUniforms(FLAG_W, FLAG_H), ...this.backlight() };
    const material = this.fabricMaterial(texture, uniforms);
    const [sx, sy] = TIERS[this.tier].cloth;
    const mesh = new THREE.Mesh(flagGeometry(FLAG_W, FLAG_H, sx, sy), material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    const n: NearFlag = { mesh, material, texture, canvas, uniforms, index: -1, painted: "none" };
    this.near.push(n);
    return n;
  }

  private backlight(): BacklightUniforms {
    return { uSunDir: { value: this.sunDir }, uSunColor: { value: this.sunColor }, uBacklight: { value: 1.6 }, uGlow: { value: 0 } };
  }

  private assignNear(n: NearFlag, i: number) {
    n.index = i;
    n.painted = "none";
    n.uniforms.uPhase.value = phaseOf(i);
    n.mesh.userData.index = i;
    n.mesh.visible = true;
    this.placeNear(n);
    this.paintNear(n);
  }

  private placeNear(n: NearFlag) {
    const p = this.slots[n.index];
    n.mesh.position.set(p.x + 0.06, POLE_H - 0.2 - this.riseDrop(n.index), p.z);
  }

  private paintNear(n: NearFlag) {
    const s = this.list[n.index];
    const img = this.logoFor(n.index);
    drawStartupFlag(n.canvas, { logo: img, bg: s.bgColor });
    n.texture.needsUpdate = true;
    n.painted = img ? "logo" : "color";
  }

  private freeNear(n: NearFlag) {
    n.index = -1;
    n.mesh.visible = false;
  }

  // ---------- Quality ----------

  private applyTier(tier: Tier) {
    this.tier = tier;
    const t = TIERS[tier];
    this.clouds.setSteps(t.steps);
    this.post.setGodRays(t.godRays);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, t.dpr));
    this.lodTimer = 0;
  }

  /** Drops to the low tier when the high tier cannot hold ~45 fps. Checks a few times, then stops. */
  private watchFps(rawDt: number) {
    // Real frame time, not the clamped step. Gaps over half a second are a hidden tab, not a slow GPU.
    if (this.tier === "low" || this.fpsChecks >= 4 || document.hidden || rawDt > 0.5) return;
    this.fpsFrames++;
    this.fpsTime += rawDt;
    if (this.fpsTime < 2.5) return;
    const fps = this.fpsFrames / this.fpsTime;
    this.fpsFrames = 0;
    this.fpsTime = 0;
    this.fpsChecks++;
    if (this.fpsChecks > 1 && fps < 45) {
      this.applyTier("low");
      this.resize();
    }
  }

  // ---------- Loop and camera ----------

  private lookFrom(from: THREE.Vector3, yaw: number, pitch: number) {
    return new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).add(from);
  }

  private flyTo(to: THREE.Vector3, look: THREE.Vector3, select: number | null) {
    const d = look.clone().sub(to);
    const yaw1 = this.yaw + angleDelta(this.yaw, Math.atan2(-d.x, -d.z));
    const p1 = Math.atan2(d.y, Math.hypot(d.x, d.z));
    const dist = to.distanceTo(this.pos);
    this.flight = {
      from: this.pos.clone(), to, yaw0: this.yaw, yaw1, p0: this.pitch, p1, t: 0,
      dur: THREE.MathUtils.clamp(1.2 + dist / 40, 1.4, 4.5), select,
    };
    this.idle = 0;
  }

  private loop = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const rawDt = (now - this.last) / 1000;
    const dt = Math.min(rawDt, 0.1);
    this.last = now;
    this.time += dt;
    this.watchFps(rawDt);
    for (const u of [this.farUniforms, this.argUniforms, ...this.near.map((n) => n.uniforms)]) u.uTime.value = this.time;

    const speed = 10 * dt;
    if (this.keys.has("ArrowUp") || this.keys.has("w")) this.walk(speed);
    if (this.keys.has("ArrowDown") || this.keys.has("s")) this.walk(-speed);
    if (this.keys.has("ArrowLeft") || this.keys.has("a")) this.turn(1.2 * dt, 0);
    if (this.keys.has("ArrowRight") || this.keys.has("d")) this.turn(-1.2 * dt, 0);

    this.idle += dt;
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.dur);
      const k = f.t < 0.5 ? 4 * f.t ** 3 : 1 - Math.pow(-2 * f.t + 2, 3) / 2;
      this.pos.lerpVectors(f.from, f.to, k);
      this.pos.y += Math.sin(Math.PI * k) * Math.min(6, f.from.distanceTo(f.to) * 0.08); // a gentle arc
      this.yaw = f.yaw0 + (f.yaw1 - f.yaw0) * k;
      this.pitch = f.p0 + (f.p1 - f.p0) * k;
      this.goalPos.copy(this.pos);
      this.goalYaw = this.yaw;
      this.goalPitch = this.pitch;
      if (f.t >= 1) {
        this.flight = null;
        this.idle = -30; // stay put a while after arriving
        if (f.select !== null) this.events.onSelect?.(f.select);
      }
    } else if (this.idle > IDLE_AFTER && this.pointers.size === 0) {
      // Idle: drift slowly down the corridor and float.
      const ramp = Math.min(1, (this.idle - IDLE_AFTER) / 3);
      if (this.goalPos.z > DRIFT_STOP_Z) this.goalPos.z -= DRIFT_SPEED * dt * ramp;
      this.floatPhase += dt * ramp;
    }
    if (!this.flight) {
      // Frame-rate independent ease toward the goals.
      this.pos.lerp(this.goalPos, 1 - Math.exp(-EASE_MOVE * dt));
      const look = 1 - Math.exp(-EASE_LOOK * dt);
      this.yaw += (this.goalYaw - this.yaw) * look;
      this.pitch += (this.goalPitch - this.pitch) * look;
    }
    const float = this.flight ? 0 : Math.sin((this.floatPhase / 30) * Math.PI * 2) * 0.3;

    this.camera.position.set(this.pos.x, this.pos.y + float, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.updateMatrixWorld();
    this.sky.update(this.time, this.camera);
    this.clouds.update(this.time, this.camera);

    // Rising flags and highlight pulse.
    if (this.rising.size && this.far) {
      const m = new THREE.Matrix4();
      for (const [i, t0] of this.rising) {
        this.far.setMatrixAt(i, this.flagMatrix(i, m));
        if (this.time - t0 > 4) this.rising.delete(i);
      }
      this.far.instanceMatrix.needsUpdate = true;
      for (const n of this.near) if (n.index >= 0) this.placeNear(n);
    }
    const pulse = 0.35 + 0.25 * Math.sin(this.time * 3.2);
    if (this.highlight.size && this.aGlow) {
      for (const i of this.highlight) this.aGlow.setX(i, pulse);
      this.aGlow.needsUpdate = true;
    }
    for (const n of this.near) n.uniforms.uGlow.value = n.index >= 0 && this.highlight.has(n.index) ? pulse : 0;
    this.updateHover(dt);

    this.lodTimer -= dt;
    if (this.lodTimer <= 0) {
      this.updateLod();
      this.lodTimer = 0.25;
    }
    this.post.render(dt);
  };

  private clampPos() {
    const rows = Math.ceil(this.slots.length / (this.cols * 2));
    const end = FIRST_Z - rows * DZ;
    const w = CORRIDOR + this.cols * DX;
    const g = this.goalPos;
    g.x = Math.max(-w, Math.min(w, g.x));
    g.z = Math.max(end, Math.min(START.z + 8, g.z));
    g.y = Math.max(CLOUD_TOP + 1.5, g.y);
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h);
    this.camera.aspect = w / h;
    // Narrow screens: widen the view so the corridor and the Argentine flag still fit.
    this.camera.fov = w / h < 1 ? Math.min(70, FOV * (1 / (w / h)) * 0.75) : FOV;
    this.camera.updateProjectionMatrix();
    this.lodTimer = 0;
  }

  private pick(e: { clientX: number; clientY: number }): { kind: "startup" | "placeholder"; index: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets: THREE.Object3D[] = this.near.filter((n) => n.index >= 0).map((n) => n.mesh);
    if (this.far) targets.push(this.far);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit) return null;
    const index = hit.object === this.far ? hit.instanceId ?? -1 : (hit.object.userData.index as number);
    if (index < 0) return null;
    return { kind: index < this.list.length ? "startup" : "placeholder", index };
  }

  private interact() {
    this.idle = 0;
  }

  private bindInput(canvas: HTMLCanvasElement) {
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
      this.moved = false;
      this.pinch = 0;
      this.interact();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse") this.hoverAt = { clientX: e.clientX, clientY: e.clientY }; // picked in the loop, once per frame
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 6) this.moved = true;
      if (!this.moved) return;
      this.interact();
      this.flight = null;
      if (this.pointers.size >= 2) {
        // Two fingers: pinch to fly along the view.
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinch) this.walk((d - this.pinch) * 0.08);
        this.pinch = d;
        return;
      }
      canvas.style.cursor = "grabbing";
      // Drag to look around.
      this.turn(dx * 0.0026, dy * 0.0022);
    });
    const end = (e: PointerEvent) => {
      const had = this.pointers.delete(e.pointerId);
      canvas.style.cursor = "grab";
      this.pinch = 0;
      if (had && !this.moved && e.type === "pointerup") {
        const hit = this.pick(e);
        if (hit?.kind === "startup") this.focus(hit.index);
        else if (hit?.kind === "placeholder") this.events.onPlaceholder?.();
        else {
          this.setHighlight([]);
          this.events.onSelect?.(null);
        }
      }
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("pointerleave", () => {
      this.hovered = -1;
      if (!this.pointers.size) canvas.style.cursor = "grab";
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.interact();
      // Cap each event: trackpad flings send huge deltas. The ease turns the step into a glide.
      this.walk(-THREE.MathUtils.clamp(e.deltaY, -120, 120) * 0.025);
    }, { passive: false });
    canvas.addEventListener("keydown", (e) => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d"].includes(e.key)) {
        this.keys.add(e.key);
        this.flight = null;
        this.interact();
        e.preventDefault();
      }
    });
    canvas.addEventListener("keyup", (e) => this.keys.delete(e.key));
    canvas.addEventListener("blur", () => this.keys.clear());
  }
}

function angleDelta(from: number, to: number) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
