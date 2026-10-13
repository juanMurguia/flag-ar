// Hall of Fame: a short row of flagpoles rising out of a sea of golden sunset clouds. A central
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
// - Home stays light: the hall is one row of HALL_POLES poles. Startups take the best seats, and at least
//   one pole stays empty for the next one. The rest show in the showcase (tour, search, link), one cloth at a time.
import * as THREE from "three";
import type { PublicStartup } from "@/lib/startups/model";
import { Birds } from "./birds";
import { ClothSim, type WindLook } from "./cloth";
import { CLOUD_BOTTOM, CLOUD_TOP, CloudSea } from "./cloudSea";
import { CLOTH_NORMAL_REPEAT, applyBacklight, applyRim, applySunRim, clothNormalMap, type BacklightUniforms } from "./fabric";
import { Motes } from "./motes";
import { poleMaterials } from "./pole";
import { Post, type PostFx } from "./post";
import { SunsetSky, sunDirection } from "./sunsetSky";
import { clothFinish, createCanvas, drawArgentineFlag, drawStartupFlag, prepareLogo, type LogoImage } from "./texture";
import { applyWave, flagGeometry, waveUniforms, type FoldUniforms, type WaveUniforms } from "./wave";

// ---------- Layout (meters) ----------
const FLAG_W = 3.1, FLAG_H = 2.0;
const POLE_H = 4; // above y = 0: the flag rides just over the cloud tops; the flags matter, not the poles
const POLE_DEPTH = CLOUD_TOP - CLOUD_BOTTOM + 3; // below them, out of sight
// The hero: its pole rises far above the field, so the flag flies high in the frame, over every other
// flag, like a flag on a summit. The cloth is about twice the size of the others.
const ARG_POLE_H = POLE_H * 2.7;
const ARG_W = FLAG_W * 2.2, ARG_H = FLAG_H * 2.2;
const CORRIDOR = 7.5; // half-width of the empty corridor down the middle
// Wide gaps between poles: each flag reads on its own, with sky around it, and the eye can rest on it.
const DX = 8.5, DZ = 10;
const FIRST_Z = -2;
const ARG_Z = FIRST_Z - 19.25; // the Argentine flag stands this far down the corridor, whatever the row spacing
const ARG_X = -ARG_W / 2; // pole left of the axis by half the cloth: the cloth centers on the corridor
const ARG_CENTER = new THREE.Vector3(ARG_X + ARG_W / 2, ARG_POLE_H - 0.25 - ARG_H / 2, ARG_Z);

// ---------- Look ----------
// Contre-jour, as in a golden-hour photo: the sun sits low in the start view, right behind the Argentine
// flag. The cloth is translucent (fabric.ts): the sun shines through it in its own colors, and peeks out
// past the fly end as it waves. A warm spot keeps the face readable.
const SUN_ELEVATION = 6.5;
const SUN_AZIMUTH = 3.5; // behind the fly end of the Argentine flag in the start view: it peeks out as the cloth waves
const HORIZON = new THREE.Color(0xf6c07a); // golden hour: amber haze, not the rose of late dusk
// A warm spot on the Argentine flag keeps its face readable against the sun.
const SPOT_GAIN = 2.0; // low: more, and the front light flattens the light coming through the cloth (contre-jour)
// The hero is a cloth simulation (cloth.ts), not a wave formula: wind speed in m/s, how hard the air carries
// the cloth downwind, and how hard it pushes tilted patches. Tuned so the flag flies near level and billows.
const ARG_CLOTH: WindLook = { speed: 11, drag: 2.2, lift: 3.2 };
const ARG_SEGS: [number, number] = [35, 23];
const ARG_RIM = 0.35;
const BACKLIGHT = 1.85; // sun through the cloth: with the low spot, the flag glows from behind as in a sunset photo
// Showcase (a picked flag, and the wallpaper): the startup's flag on its own pole right of the Argentine flag,
// the same cloth at the same size. Its pole is a little shorter: the national flag keeps the place of honor
// (higher, on the viewer's left). 3 m of sky between the Argentine fly end and the startup pole.
const SHOW_X = ARG_X + ARG_W + 3;
const SHOW_POLE_H = ARG_POLE_H - 1.2;
const SHOW_WARMUP = 4; // s of simulated wind before the flag shows, so it flies instead of hanging flat
const SHOW_EYE_Y = 6.2; // m, camera height in the showcase
const CUT_MS = 260; // fade out, and back in, around a jump between the hall and the showcase
const POLE_RIM = 1.6; // gold outline on the poles against the sun
const BIRD_FLOCKS = 3;
const MOTE_GAIN = 1.0; // HDR, added per speck. Deep amber: bright points tone-map to white, and white specks read as snow
const FOG_DENSITY = 0.002; // aerial perspective: far rows fade into the amber haze. Much more washes the whole frame out

// ---------- Camera ----------
// Low and back, on a long lens, looking level: the eye sits just over the cloud tops, so the dark backlit
// billows fill the foreground (the frame's shadow), the Argentine flag flies high above the field, and the
// telephoto packs the rows behind it.
const START = new THREE.Vector3(0, 2.9, 26);
const START_PITCH = 0.04;
const START_YAW = 0; // straight down the corridor: the Argentine flag on the center line
const FOV = 32;
// Opening shot: the camera cranes down from high and far back to the start view.
const INTRO_FROM = new THREE.Vector3(0, 11, 54);
const INTRO_PITCH = -0.05;
const INTRO_DUR = 8; // s
const YAW_LIMIT = 1.15; // rad either side of the corridor axis: you can look at the flags, never back
const PITCH_MIN = -0.3, PITCH_MAX = 0.35;
const EASE_MOVE = 4; // 1/s: how fast position catches its goal
const EASE_LOOK = 9; // 1/s: how fast yaw and pitch catch theirs
// Showcase orbit: the camera circles the pair, never turns away from it. Limits keep the sun behind the
// cloths (it backlights them) and the eye above the cloud tops.
const ORBIT_AZ = 0.6; // rad either side of the straight-on view
const ORBIT_EL_MIN = -0.06, ORBIT_EL_MAX = 0.3; // rad below and above it
const ORBIT_ZOOM_MIN = 0.7, ORBIT_ZOOM_MAX = 1.35; // times the framing distance
const EASE_ORBIT = 7; // 1/s

const ATLAS_COLS = 8;
const ATLAS_TILE: [number, number] = [256, 168];
const TILE_BLANK = 0, TILE_PLACEHOLDER = 1;
// Empty slots: plain undyed cloth, a few warm whites so the field does not look printed. The color
// belongs to the startups and the Argentine flag.
const PLACEHOLDER_COLORS = ["#fbfaf8", "#f6f5f3", "#fdfcfb", "#f3f2f1"]; // near white: the warm sunset tints them cream on its own
const PLACEHOLDER_LIFT = 0.8; // under 1: backlit, the empty field glows gold but stays darker than the hero
const FRONT_MARKS = 8; // the first empty slots (the best seats) show the "tu startup acá" mark; the rest only on hover
// The hall, small on purpose: a big field of poles and cloths cost too much GPU and CPU on the home page.
const HALL_POLES = 4;
const HALL_INNER = 4.5; // m from the axis to the center of the inner cloths
const HALL_DX = 4.5; // m between neighbors in a row: a cloth is 3.1 wide, so a gap of about 1.4 m
const HOVER_GLOW = 0.1;
const EASE_HOVER = 7; // 1/s

// Sky and cloud sea resolution, per axis, against the drawing buffer. Both are soft: half resolution measured
// 45 dB PSNR against full (no visible change) and cut the frame time by a third on an integrated GPU.
const BACKDROP_SCALE = 0.5;

type Tier = "high" | "low";
const TIERS = {
  high: { steps: 72, cloth: [32, 20] as const, near: 24, lodRange: 300, motes: 450 },
  low: { steps: 28, cloth: [16, 10] as const, near: 10, lodRange: 150, motes: 180 },
};

/** Visitor-facing effects. `hd` renders at up to 2x device pixels; off renders at 1x. */
export interface SalonFx extends PostFx {
  hd: boolean;
}

function startTier(): Tier {
  const coarse = window.matchMedia?.("(pointer: coarse)").matches;
  const small = window.matchMedia?.("(max-width: 767px)").matches;
  return coarse || small ? "low" : "high";
}

/** Default effects for this device: everything on desktops, only bloom on phones. */
export function defaultFx(): SalonFx {
  const high = startTier() === "high";
  return { ao: high, bloom: true, godRays: high, hd: high };
}

export interface SalonEvents {
  /** A startup was picked (after the camera arrives), or the selection was cleared (null). */
  onSelect?: (index: number | null) => void;
  /** An empty "tu startup acá" flag was clicked. `slot` is its grid slot, for `claimSlot`. */
  onPlaceholder?: (slot: number) => void;
  /** The scene switched effects off on its own (slow GPU). The UI mirrors the new state. */
  onFx?: (fx: SalonFx) => void;
  /** The mouse moved onto a flag (or off every flag: null). For the hover label. */
  onHover?: (target: { kind: "startup" | "placeholder"; index: number } | null) => void;
  /** The first real frames are on screen and the canvas starts to fade in. The UI drops its loader. */
  onReady?: () => void;
}

interface Slot {
  x: number;
  z: number;
  side: 1 | -1;
}

/**
 * The hall: rows of four in front, two cloths each side of the hero, best seats first (inner, then outer,
 * left before right). Cloths fly to the right of their pole, so each pole stands half a cloth left of the
 * cloth center: the row looks even around the axis. Further rows stand DZ behind.
 */
export function hallSlots(n: number): Slot[] {
  return Array.from({ length: n }, (_, i) => {
    const side: 1 | -1 = i % 2 === 0 ? -1 : 1;
    const col = Math.floor((i % 4) / 2);
    return { x: side * (HALL_INNER + col * HALL_DX) - FLAG_W / 2, z: FIRST_Z - Math.floor(i / 4) * DZ, side };
  });
}

/** Wave phase per flag: golden-angle steps, so neighbors never move in step. */
export function phaseOf(i: number) {
  return (i * 2.39996) % (Math.PI * 2);
}

/** The pair shot: the picked startup's cloth next to the Argentine flag. */
interface Showcase {
  mesh: THREE.Mesh;
  tex: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  geo: THREE.BufferGeometry;
  cloth: ClothSim | null;
  parts: THREE.Object3D[]; // pole, finial, cloth, spot: shown and hidden together
  painted: "none" | "color" | "logo";
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

/** The visitor's own flag on an empty pole, while the hoist sheet is open (and after, until the layout changes). */
interface Claim {
  slot: number;
  flag: NearFlag;
  hoist: number; // 1 at the top of the pole, 0 down in the clouds
  from: number;
  target: number;
  start: number;
  dur: number;
  done: (() => void) | null;
  released: boolean; // the sheet closed: drop the flag once it is down
}

export class SalonScene {
  private renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  // Sky and cloud sea: ray-marched and soft, so they render at a lower resolution (Post, backdrop).
  private backdrop = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  sky: SunsetSky;
  clouds: CloudSea;
  private motes: Motes;
  private birds: Birds;
  post: Post;
  private tier: Tier;
  private fx: SalonFx;
  private sunDir: THREE.Vector3;
  private sunColor = new THREE.Color(1.0, 0.7, 0.42);
  private list: PublicStartup[] = [];
  private poled = 0; // startups on a hall pole: list[i] stands in slot i for i < poled. The rest show only in the showcase
  private slots: Slot[] = [];
  private cols = 10;
  private time = 0;
  private raf = 0;
  private last = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver;

  // Instanced layers
  private poleMats: { metal: THREE.MeshStandardMaterial; gold: THREE.MeshStandardMaterial; finial: THREE.MeshStandardMaterial } | null = null;
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
  private argCloth: ClothSim | null = null;
  private argGeo: THREE.BufferGeometry | null = null;
  private images = new Map<string, LogoImage | "loading" | "error">();
  private lodTimer = 0;
  private knownIds: Set<string> | null = null;
  private rising = new Map<number, number>(); // slot -> start time
  private highlight = new Set<number>();
  private claim: Claim | null = null;
  private beforeClaim: { pos: THREE.Vector3; yaw: number; pitch: number } | null = null;
  // Screen pixels covered by the hoist sheet. The view shifts so the claimed flag sits in the free part.
  private inset = { right: 0, bottom: 0, goalRight: 0, goalBottom: 0 };
  private size = { w: 1, h: 1 };
  private frames = 0; // the canvas fades in after the first frames, so shader compiles never show
  private show: Showcase | null = null;
  private showing = -1; // startup index in the showcase, -1 = the hall
  private cutTimer = 0;
  private capturing = false; // a wallpaper shot owns the canvas: the loop skips its frames until it is done

  // Camera
  private pos = START.clone();
  private yaw = START_YAW; // 0 looks straight down the corridor (-z)
  private pitch = START_PITCH;
  // Input moves these goals; the camera eases toward them each frame.
  private goalPos = START.clone();
  private goalYaw = START_YAW;
  private goalPitch = START_PITCH;
  private orbit = { az: 0, el: 0, zoom: 1, goalAz: 0, goalEl: 0, goalZoom: 1 };
  private flight: {
    from: THREE.Vector3; to: THREE.Vector3; yaw0: number; yaw1: number; p0: number; p1: number; t: number; dur: number;
    select: number | null; intro?: boolean;
  } | null = null;
  private pointers = new Map<number, { x: number; y: number; sx: number; sy: number }>();
  private pinch = 0;
  private moved = false;
  private raycaster = new THREE.Raycaster();
  private keys = new Set<string>();

  // FPS watch, for the automatic drop to the low tier.
  private fpsFrames = 0;
  private fpsTime = 0;
  private fpsChecks = 0;

  constructor(private container: HTMLElement, private events: SalonEvents = {}, fx: SalonFx = defaultFx()) {
    this.tier = startTier();
    this.fx = { ...fx };
    const t = TIERS[this.tier];

    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance", stencil: false });
    renderer.setPixelRatio(this.dpr());
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    this.renderer = renderer;
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "application");
    canvas.setAttribute("aria-label", "Salón de la Fama en 3D. Arrastrá para mirar, rueda para avanzar por el pasillo, click en una bandera para ver su ficha.");
    Object.assign(canvas.style, {
      display: "block", width: "100%", height: "100%", touchAction: "none", cursor: "grab", opacity: "0", transition: "opacity 700ms ease",
    });
    container.appendChild(canvas);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 40000);
    this.sunDir = sunDirection(SUN_ELEVATION, SUN_AZIMUTH);

    this.scene.fog = new THREE.FogExp2(HORIZON.clone(), FOG_DENSITY);
    this.scene.background = HORIZON.clone();
    this.sky = new SunsetSky({ sunDir: this.sunDir, sunColor: this.sunColor, horizon: HORIZON });
    this.backdrop.background = HORIZON.clone();
    this.backdrop.add(this.sky.group);
    this.scene.environment = this.sky.environment(renderer);
    // Low sky fill: contre-jour needs real shadow. More fill flattens it back to a grey haze.
    this.scene.environmentIntensity = 0.45;
    this.clouds = new CloudSea({ sunDir: this.sunDir, sunColor: this.sunColor, fogDensity: FOG_DENSITY }, t.steps);
    this.backdrop.add(this.clouds.group);
    // Golden dust in the air, lit by the low sun. Count by device tier, fixed for the session.
    this.motes = new Motes(t.motes, new THREE.Color(1, 0.5, 0.15).multiplyScalar(MOTE_GAIN));
    this.scene.add(this.motes.points);
    // Far flocks crossing the sky, as silhouettes against the sun. Random per visit.
    this.birds = new Birds(BIRD_FLOCKS, START.z, new THREE.Color(0.05, 0.04, 0.05), HORIZON.clone().multiplyScalar(1.2));
    this.scene.add(this.birds.mesh);

    const sun = new THREE.DirectionalLight(0xffc27a, 2.1);
    sun.position.copy(this.sunDir).multiplyScalar(100);
    this.scene.add(sun);
    // A cool sky fill over a warm cloud bounce: the cool keeps the shadows from going muddy orange.
    this.scene.add(new THREE.HemisphereLight(0xc4cbe0, 0xf2b070, 0.35));

    const bl = (): BacklightUniforms => ({
      uSunDir: { value: this.sunDir }, uSunColor: { value: this.sunColor }, uBacklight: { value: BACKLIGHT }, uGlow: { value: 0 },
    });
    this.argUniforms = { ...waveUniforms(ARG_W, ARG_H, 0.6), ...bl() };
    this.farUniforms = { ...waveUniforms(FLAG_W, FLAG_H), ...bl() };
    // The field glows a little less than the hero: backlit cloth, but the hero stays the brightest flag.
    this.farUniforms.uBacklight.value = 1.1;
    this.buildArgentina();

    this.atlasCanvas = createCanvas(ATLAS_TILE[0] * ATLAS_COLS, ATLAS_TILE[1] * ATLAS_COLS);
    this.atlas = new THREE.CanvasTexture(this.atlasCanvas);
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    this.atlas.generateMipmaps = false; // mipmaps would bleed between tiles
    this.atlas.minFilter = THREE.LinearFilter;
    this.drawPlaceholderTile();
    this.farMaterial = this.atlasMaterial();

    this.post = new Post(renderer, this.scene, this.camera, this.sky.raySun, this.fx, this.backdrop, BACKDROP_SCALE);
    this.intro();

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.bindInput(canvas);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
    if (process.env.NODE_ENV !== "production") (window as unknown as { __salon?: SalonScene }).__salon = this; // tuning from devtools
  }

  // ---------- Public API ----------

  /** Lays out the hall. New startups on a pole (not in the previous call) rise up it. */
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
    this.poled = Math.min(list.length, HALL_POLES - 1); // one pole always free: the hoist needs it
    const count = HALL_POLES;
    this.cols = 2;
    this.slots = hallSlots(count);

    // Brushed, weathered aluminium (shared with the pair page), not chrome: at this distance a mirror finish reads as CG.
    const metal = this.rimmed().metal;
    const shaftGeo = new THREE.CylinderGeometry(0.055, 0.075, POLE_H + POLE_DEPTH, 12, 1, true);
    shaftGeo.translate(0, (POLE_H - POLE_DEPTH) / 2, 0);
    this.shafts = new THREE.InstancedMesh(shaftGeo, metal, count);
    const finialGeo = new THREE.SphereGeometry(0.12, 10, 6);
    finialGeo.translate(0, POLE_H + 0.1, 0);
    this.finials = new THREE.InstancedMesh(finialGeo, this.rimmed().finial, count);

    const farGeo = flagGeometry(FLAG_W, FLAG_H, 14, 7);
    const phases = new Float32Array(count);
    const atlasAttr = new Float32Array(count * 2);
    farGeo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
    this.aAtlas = new THREE.InstancedBufferAttribute(atlasAttr, 2);
    this.aGlow = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    farGeo.setAttribute("aAtlas", this.aAtlas);
    farGeo.setAttribute("aGlow", this.aGlow);
    const marks = new Float32Array(count);
    for (let i = 0; i < count; i++) marks[i] = this.baseMark(i);
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
      const real = i < this.poled;
      if (real) color.set(list[i].bgColor);
      else color.set(PLACEHOLDER_COLORS[(i * 7 + (i >> 3)) % PLACEHOLDER_COLORS.length]).multiplyScalar(PLACEHOLDER_LIFT);
      this.far.setColorAt(i, color);
      const o = real ? blank : ph;
      atlasAttr[i * 2] = o[0];
      atlasAttr[i * 2 + 1] = o[1];
    }
    if (prevIds) {
      for (let i = 0; i < this.poled; i++) if (!prevIds.has(list[i].id)) this.rising.set(i, this.time);
    }
    for (const mesh of [this.shafts, this.finials, this.far]) this.scene.add(mesh);
    // In the showcase, the new hall stays hidden. Its startup left the list: back to the hall.
    if (this.showing >= list.length) this.leaveShowcase();
    else if (this.showing >= 0) {
      this.setHall(false);
      this.paintShowcase();
    }
    // A new startup took the claimed slot: an open sheet moves to the next free seat, a closed one lets go.
    if (this.claim && (this.claim.slot < this.poled || this.claim.slot >= count)) {
      if (this.claim.released) this.dropClaim();
      else {
        this.claim.slot = this.poled;
        this.placeClaim();
      }
    }
    this.lodTimer = 0;
  }

  // ---------- Hoist in place ----------
  // The same calls as the two-pole scene, so the hoist sheet drives either one.

  /**
   * Takes empty slot `slot` (default: the best free seat) for the visitor's flag and flies to look at it from
   * above the row in front. A second call moves the flag to the new slot and keeps its paint.
   */
  claimSlot(slot = this.poled) {
    if (slot < this.poled || !this.slots[slot]) slot = this.poled;
    const p = this.slots[slot];
    if (!p) return;
    if (this.claim?.released) this.dropClaim();
    this.leaveShowcase(); // the hoist happens in the hall
    // Remember the view on the first claim, so closing the sheet flies back to it.
    if (!this.claim) this.beforeClaim = { pos: this.pos.clone(), yaw: this.yaw, pitch: this.pitch };
    if (!this.claim) {
      const flag = this.makeFlag();
      drawStartupFlag(flag.canvas, { logo: null, bg: "#ffffff", weave: clothFinish(flag.canvas.width, flag.canvas.height) });
      flag.texture.needsUpdate = true;
      this.claim = { slot, flag, hoist: 1, from: 1, target: 1, start: 0, dur: 1, done: null, released: false };
    }
    this.claim.slot = slot;
    this.claim.flag.uniforms.uPhase.value = phaseOf(slot);
    this.claim.flag.mesh.visible = true;
    this.placeClaim();
    this.setHighlight([]);
    this.lodTimer = 0;
    // Above and in front, a little toward the corridor: the line of sight clears the flags of the row in front.
    const center = new THREE.Vector3(p.x + FLAG_W / 2, POLE_H - FLAG_H / 2, p.z);
    const stand = new THREE.Vector3(center.x - p.side * 2, center.y + 2.2, p.z + 11);
    this.flyTo(stand, center, null);
  }

  /** Lets the claimed slot go: the flag leaves once it is down (closing before the hoist lowers it). */
  release() {
    if (this.claim) this.claim.released = true;
    const b = this.beforeClaim;
    if (b) this.flyTo(b.pos, this.lookFrom(b.pos, b.yaw, b.pitch), null);
    this.beforeClaim = null;
    this.inset.goalRight = 0;
    this.inset.goalBottom = 0;
  }

  /** Logo and color for the claimed flag. Repaints at once (live preview). */
  setStartup(logo: LogoImage | null, bg: string) {
    const c = this.claim;
    if (!c) return;
    drawStartupFlag(c.flag.canvas, { logo, bg, weave: clothFinish(c.flag.canvas.width, c.flag.canvas.height) });
    c.flag.texture.needsUpdate = true;
  }

  /** Moves the claimed flag up (1) or down into the clouds (0). Resolves when it arrives. */
  hoistTo(target: number, seconds = 2): Promise<void> {
    const c = this.claim;
    if (!c) return Promise.resolve();
    c.done?.();
    c.done = null;
    c.from = c.hoist;
    c.target = THREE.MathUtils.clamp(target, 0, 1);
    c.start = this.time;
    c.dur = seconds;
    if (seconds <= 0 || c.hoist === c.target) {
      c.hoist = c.target;
      this.placeClaim();
      return Promise.resolve();
    }
    return new Promise((resolve) => (c.done = resolve));
  }

  /** Screen pixels at the right covered by a side panel. The view eases aside. */
  setInsetRight(px: number) {
    this.inset.goalRight = Math.max(0, Math.min(px, this.size.w * 0.5));
  }

  /** Screen pixels at the bottom covered by a bottom sheet. The view eases up. */
  setInsetBottom(px: number) {
    this.inset.goalBottom = Math.max(0, Math.min(px, this.size.h * 0.6));
  }

  private get claiming() {
    return !!this.claim && !this.claim.released;
  }

  private placeClaim() {
    const c = this.claim;
    if (!c) return;
    const p = this.slots[c.slot];
    c.flag.mesh.position.set(p.x + 0.06, POLE_H - 0.2 - (POLE_H + 1) * (1 - c.hoist), p.z);
  }

  private dropClaim() {
    const c = this.claim;
    if (!c) return;
    c.done?.();
    this.scene.remove(c.flag.mesh);
    c.flag.mesh.geometry.dispose();
    c.flag.material.dispose();
    c.flag.texture.dispose();
    this.claim = null;
    this.lodTimer = 0;
  }

  private updateClaim() {
    const c = this.claim;
    if (!c) return;
    c.flag.uniforms.uTime.value = this.time;
    if (c.hoist !== c.target) {
      const f = Math.min(1, (this.time - c.start) / c.dur);
      const k = f < 0.5 ? 4 * f ** 3 : 1 - Math.pow(-2 * f + 2, 3) / 2;
      c.hoist = c.from + (c.target - c.from) * k;
      if (f >= 1) {
        c.hoist = c.target;
        const done = c.done;
        c.done = null;
        done?.();
      }
      this.placeClaim();
    }
    if (c.released && c.hoist === 0 && !c.done) this.dropClaim();
  }

  /** Eases the sheet insets and shifts the projection, so the world glides aside as the sheet slides in. */
  private updateInset(dt: number) {
    const s = this.inset;
    const k = 1 - Math.exp(-7 * dt);
    s.right += (s.goalRight - s.right) * k;
    s.bottom += (s.goalBottom - s.bottom) * k;
    if (Math.abs(s.goalRight - s.right) < 0.5) s.right = s.goalRight;
    if (Math.abs(s.goalBottom - s.bottom) < 0.5) s.bottom = s.goalBottom;
    const { w, h } = this.size;
    if (s.right > 0 || s.bottom > 0) this.camera.setViewOffset(w, h, s.right / 2, s.bottom / 2, w, h);
    else if (this.camera.view?.enabled) this.camera.clearViewOffset();
  }

  /**
   * Shows startup flag `i` alone with the Argentine flag: the showcase (see `enterShowcase`). A quick fade
   * hides the cut, and the card opens as the view fades back in.
   */
  focus(i: number) {
    if (i < 0 || i >= this.list.length) return;
    this.setHighlight([i]);
    if (this.showing === i) {
      this.events.onSelect?.(i);
      return;
    }
    this.cut(() => {
      this.enterShowcase(i);
      this.events.onSelect?.(i);
    });
  }

  /** Flies through the hall to stand in front of startup flag `i`, and reports the selection on arrival. */
  private flyToFlag(i: number) {
    const p = this.slots[i];
    if (!p) return;
    // Frame the flag at about half the screen width, whatever the lens and the screen shape: on the long lens
    // a fixed distance either crops it (portrait) or leaves it small (wide screens). From that far back the
    // row in front can stand in the way, so the eye rises a little and leans toward the corridor: the line of
    // sight clears the flag in front of this one.
    const center = new THREE.Vector3(p.x + FLAG_W / 2, POLE_H - FLAG_H / 2, p.z);
    const halfH = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const halfW = Math.atan(Math.tan(halfH) * this.camera.aspect);
    const dist = THREE.MathUtils.clamp((FLAG_W / 0.5) / (2 * Math.tan(halfW)), 7, 22);
    const stand = new THREE.Vector3(center.x - p.side * 1.5, center.y + 2.6, p.z + dist);
    // Aim a touch to the right of the flag on wide screens, so it sits left of center, clear of the card.
    const look = center.clone().add(new THREE.Vector3(this.camera.aspect > 1 ? 0.8 : 0, 0, 0));
    this.flyTo(stand, look, i);
  }

  /** Glows these startup flags (search, city filter), the ones on a hall pole. Empty clears. */
  setHighlight(indices: number[]) {
    this.highlight = new Set(indices.filter((i) => i >= 0 && i < this.poled));
    if (this.aGlow) {
      (this.aGlow.array as Float32Array).fill(0);
      this.aGlow.needsUpdate = true;
    }
  }

  /**
   * Flies through the hall to the nearest of these flags (city filter, search) and highlights all of them.
   * Several matches only make sense among the others, so this leaves the showcase. Startups off the poles
   * have no hall flag to fly to: when none is on a pole, the first match opens in the showcase.
   */
  focusAny(indices: number[]) {
    const onPole = indices.filter((i) => i < this.poled);
    if (!onPole.length && indices.length) {
      this.focus(indices[0]);
      return;
    }
    indices = onPole;
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
    const go = () => {
      this.flyToFlag(best);
      this.setHighlight(indices);
    };
    if (this.showing >= 0) {
      this.cut(() => {
        this.leaveShowcase();
        go();
      });
    } else go();
  }

  /** Back to the start view, facing the sun and the Argentine flag. From the showcase: the hall fades back first. */
  home() {
    this.setHighlight([]);
    const go = () => this.flyTo(START.clone(), this.lookFrom(START, START_YAW, START_PITCH), null);
    if (this.showing >= 0) {
      this.cut(() => {
        this.leaveShowcase();
        go();
      });
    } else go();
  }

  /**
   * Opening shot: cranes down from high and far back to the start view.
   * Any input takes over at once. Skipped for visitors who ask for reduced motion.
   */
  private intro() {
    if (this.reducedMotion()) return;
    this.pos.copy(INTRO_FROM);
    this.goalPos.copy(INTRO_FROM);
    this.pitch = this.goalPitch = INTRO_PITCH;
    this.flight = {
      from: INTRO_FROM.clone(), to: START.clone(), yaw0: START_YAW, yaw1: START_YAW, p0: INTRO_PITCH, p1: START_PITCH, t: 0, dur: INTRO_DUR,
      select: null, intro: true,
    };
  }

  private reducedMotion() {
    return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }

  /** Along the corridor axis only, whatever the yaw: at either end the camera stops, it never slides sideways. */
  walk(meters: number) {
    if (this.showing >= 0) {
      // The showcase: closer to or further from the pair, along the line to it.
      const o = this.orbit;
      o.goalZoom = THREE.MathUtils.clamp(o.goalZoom * Math.exp(-meters * 0.04), ORBIT_ZOOM_MIN, ORBIT_ZOOM_MAX);
      return;
    }
    this.flight = null;
    this.goalPos.z -= meters;
    this.clampPos();
  }

  private turn(dYaw: number, dPitch: number) {
    this.flight = null;
    if (this.showing >= 0) {
      // The showcase: drag circles the pair. Drag right, the pair turns right (the camera goes left).
      const o = this.orbit;
      o.goalAz = THREE.MathUtils.clamp(o.goalAz - dYaw, -ORBIT_AZ, ORBIT_AZ);
      o.goalEl = THREE.MathUtils.clamp(o.goalEl + dPitch, ORBIT_EL_MIN, ORBIT_EL_MAX);
      return;
    }
    this.goalYaw += dYaw;
    this.goalPitch += dPitch;
    this.clampLook();
  }

  /**
   * Keeps the center of the hall view on the flags: yaw and pitch stay inside the angles, seen from the
   * camera's goal, of the box around every cloth and the Argentine flag. The view turns around the flags,
   * never off into empty sky. The fixed limits still apply on top.
   */
  private clampLook() {
    const xs = this.slots.map((s) => s.x);
    const zs = this.slots.map((s) => s.z);
    const x0 = Math.min(ARG_X, ...xs), x1 = Math.max(ARG_X + ARG_W, ...xs.map((x) => x + FLAG_W));
    const z0 = Math.min(ARG_Z, ...zs), z1 = Math.max(ARG_Z, ...zs);
    const y0 = POLE_H - FLAG_H, y1 = ARG_POLE_H;
    const g = this.goalPos;
    let yawMin = Infinity, yawMax = -Infinity, pitchMin = Infinity, pitchMax = -Infinity;
    for (const x of [x0, x1]) for (const z of [z0, z1]) for (const y of [y0, y1]) {
      const dx = x - g.x, dy = y - g.y, dz = z - g.z;
      const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
      yawMin = Math.min(yawMin, yaw); yawMax = Math.max(yawMax, yaw);
      pitchMin = Math.min(pitchMin, pitch); pitchMax = Math.max(pitchMax, pitch);
    }
    yawMin = Math.max(yawMin, -YAW_LIMIT); yawMax = Math.min(yawMax, YAW_LIMIT);
    pitchMin = Math.max(pitchMin, PITCH_MIN); pitchMax = Math.min(pitchMax, PITCH_MAX);
    this.goalYaw = yawMin <= yawMax ? THREE.MathUtils.clamp(this.goalYaw, yawMin, yawMax) : 0;
    this.goalPitch = pitchMin <= pitchMax ? THREE.MathUtils.clamp(this.goalPitch, pitchMin, pitchMax) : START_PITCH;
  }

  /** Fades the canvas out, runs `apply` (a scene change), and fades back in. Reduced motion: a plain cut. */
  private cut(apply: () => void) {
    const c = this.renderer.domElement;
    clearTimeout(this.cutTimer);
    if (this.reducedMotion() || this.frames < 3) {
      apply();
      return;
    }
    c.style.transition = `opacity ${CUT_MS}ms ease`;
    c.style.opacity = "0";
    this.cutTimer = window.setTimeout(() => {
      if (this.disposed) return;
      apply();
      c.style.opacity = "1";
    }, CUT_MS + 20);
  }

  // ---------- Showcase ----------
  // A picked startup flag stands alone with the Argentine flag: its own pole right of the hero, the same
  // simulated cloth at the same size, the same material, rim, and spot. The hall (field, poles, the cheap
  // wave flags) is hidden. Built once on first use, then repainted for each startup.

  /** The pair's pole and cloth, built like the hero's (buildArgentina). */
  private showcaseParts(): Showcase {
    if (this.show) return this.show;
    const { metal, gold } = this.rimmed();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.15, SHOW_POLE_H + POLE_DEPTH, 16, 1, true), metal);
    shaft.position.set(SHOW_X, (SHOW_POLE_H - POLE_DEPTH) / 2, ARG_Z);
    const finial = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 10), gold);
    finial.position.set(SHOW_X, SHOW_POLE_H + 0.24, ARG_Z);

    const canvas = createCanvas(2100, 1350); // 1.5x the hero's canvas: the logo stays sharp at 4K
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const mat = this.fabricMaterial(tex, { ...waveUniforms(ARG_W, ARG_H, 0.6), ...this.backlight() }, null, false);
    applyRim(mat, { uRimColor: { value: this.sunColor.clone().multiplyScalar(ARG_RIM) } });
    const geo = flagGeometry(ARG_W, ARG_H, ARG_SEGS[0], ARG_SEGS[1]);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.position.set(SHOW_X + 0.12, SHOW_POLE_H - 0.25, ARG_Z);

    const center = new THREE.Vector3(SHOW_X + ARG_W / 2, SHOW_POLE_H - 0.25 - ARG_H / 2, ARG_Z);
    const spot = new THREE.SpotLight(0xffd08a, SPOT_GAIN, 0, 0.16, 0.85, 0);
    spot.position.copy(center).add(new THREE.Vector3(0, 30, 18));
    spot.target.position.copy(center);

    const parts = [shaft, finial, mesh, spot, spot.target];
    for (const p of parts) p.visible = false;
    this.scene.add(...parts);
    this.show = { mesh, tex, canvas, geo, cloth: null, parts, painted: "none" };
    return this.show;
  }

  /** Hides or shows the hall: the field, its poles, the near flags, and the visitor's flag. */
  private setHall(on: boolean) {
    for (const m of [this.far, this.shafts, this.finials]) if (m) m.visible = on;
    for (const n of this.near) n.mesh.visible = on && n.index >= 0;
    if (this.claim) this.claim.flag.mesh.visible = on;
  }

  /** Puts startup `i` in the showcase. `aim`: also moves the camera to the showcase view. */
  private enterShowcase(i: number, aim = true) {
    const s = this.showcaseParts();
    if (this.hovered >= 0) {
      this.hovered = -1;
      this.events.onHover?.(null);
    }
    this.showing = i;
    s.mesh.userData.index = i;
    this.paintShowcase();
    // A fresh cloth each time, flown for a few seconds while the view is faded out: it arrives flying.
    s.cloth = new ClothSim(ARG_W, ARG_H, ARG_SEGS[0], ARG_SEGS[1], ARG_CLOTH);
    for (let t = 0; t < SHOW_WARMUP; t += 1 / 60) s.cloth.update(1 / 60, s.geo);
    for (const p of s.parts) p.visible = true;
    this.setHall(false);
    if (aim) this.aimShowcase();
  }

  /** Puts the camera on the showcase view for the current screen shape. */
  private aimShowcase() {
    this.orbit = { az: 0, el: 0, zoom: 1, goalAz: 0, goalEl: 0, goalZoom: 1 };
    this.placeOrbit();
  }

  /**
   * Puts the camera on the showcase orbit: the straight-on framing (showcaseView), turned by the orbit angles
   * around the point between the two cloths, and always looking at it.
   */
  private placeOrbit() {
    const { pos: base, look } = this.showcaseView(this.camera.aspect);
    const o = this.orbit;
    const off = base.sub(look);
    const r = off.length() * o.zoom;
    const az = Math.atan2(off.x, off.z) + o.az;
    const el = Math.asin(off.y / off.length()) + o.el;
    const pos = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(r).add(look);
    pos.y = Math.max(pos.y, CLOUD_TOP + 3);
    const d = look.clone().sub(pos);
    this.flight = null;
    this.pos.copy(pos);
    this.goalPos.copy(pos);
    this.yaw = this.goalYaw = Math.atan2(-d.x, -d.z);
    this.pitch = this.goalPitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  }

  /** Back to the hall. The camera stays put: the caller moves it. */
  private leaveShowcase() {
    if (this.showing < 0) return;
    this.showing = -1;
    if (this.show) for (const p of this.show.parts) p.visible = false;
    this.setHall(true);
    this.lodTimer = 0;
  }

  /** Paints the showcase cloth for the current startup. Called again once its logo loads. */
  private paintShowcase() {
    const s = this.show, st = this.list[this.showing];
    if (!s || !st) return;
    const logo = this.logoFor(this.showing);
    drawStartupFlag(s.canvas, { logo, bg: st.bgColor, weave: clothFinish(s.canvas.width, s.canvas.height) });
    s.tex.needsUpdate = true;
    s.painted = logo ? "logo" : "color";
  }

  /** Camera for the showcase: both cloths across most of the width, from just over the clouds, looking up a little. */
  private showcaseView(aspect: number) {
    const left = ARG_X, right = SHOW_X + ARG_W * 1.05;
    const look = new THREE.Vector3((left + right) / 2, ARG_POLE_H - ARG_H * 0.55, ARG_Z);
    const halfW = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * aspect);
    const fill = aspect < 1 ? 0.92 : 0.75; // portrait: as wide as it goes, the pair is wide
    const dist = Math.max(18, (right - left) / fill / (2 * Math.tan(halfW)));
    // The eye stands square in front of the Argentine flag, as in the start view: the low sun sits right
    // behind the hero's cloth and shines through it. Between the two flags, it washes the whole frame out.
    // High enough to clear the billows: lower, the eye sinks into a cloud and the frame turns to haze.
    return { pos: new THREE.Vector3(ARG_CENTER.x, SHOW_EYE_Y, ARG_Z + dist), look };
  }

  /**
   * A wallpaper for startup `i`: the showcase, rendered offscreen at `width` x `height` with the high tier,
   * whatever the screen. The live view goes back as it was. Returns a JPEG.
   */
  async wallpaper(i: number, width: number, height: number): Promise<Blob> {
    const st = this.list[i];
    if (!st) throw new Error("No se encontró la bandera.");
    // The logo usually loaded already (the flag is on screen). If not, give it a moment.
    for (let k = 0; !this.logoFor(i) && st.logoUrl && this.images.get(st.logoUrl) === "loading" && k < 40; k++) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const prevShowing = this.showing;
    const prevTier = this.tier;
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    const prevDpr = this.renderer.getPixelRatio();
    this.capturing = true;
    this.camera.clearViewOffset(); // the loop puts it back next frame
    if (prevTier !== "high") this.applyTier("high");
    this.post.setBackdropScale(1); // a still image: the sky and clouds at full resolution
    this.renderer.setPixelRatio(1);
    this.post.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.showing !== i) this.enterShowcase(i, false);
    else if (this.show?.painted !== "logo") this.paintShowcase();
    // The hero can still hang flat (a fresh load, or a tab in the background stalls its sim): fly it a little.
    if (this.argCloth && this.argGeo) for (let t = 0; t < SHOW_WARMUP; t += 1 / 60) this.argCloth.update(1 / 60, this.argGeo);
    const { pos, look } = this.showcaseView(width / height);
    this.camera.position.copy(pos);
    this.camera.lookAt(look);
    this.camera.updateMatrixWorld();
    this.sky.update(this.time, this.camera);
    this.clouds.update(this.time, this.camera);
    try {
      this.post.render(1 / 60);
      const blob = await new Promise<Blob | null>((res) => this.renderer.domElement.toBlob(res, "image/jpeg", 0.95));
      if (!blob) throw new Error("No se pudo generar la imagen.");
      return blob;
    } finally {
      if (prevShowing < 0) this.leaveShowcase();
      else if (prevShowing !== i) this.enterShowcase(prevShowing, false);
      this.renderer.setPixelRatio(prevDpr);
      if (prevTier !== "high") this.applyTier(prevTier);
      this.post.setBackdropScale(BACKDROP_SCALE);
      this.post.setSize(size.x, size.y);
      this.resize();
      this.capturing = false;
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.cutTimer);
    this.show?.tex.dispose();
    this.resizeObserver.disconnect();
    this.post.dispose();
    this.clouds.dispose();
    this.motes.dispose();
    this.birds.dispose();
    this.sky.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((mm) => mm.dispose());
      }
    });
    for (const n of this.near) n.texture.dispose();
    this.claim?.flag.texture.dispose();
    this.atlas.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------- Build ----------

  /**
   * Pole materials with a gold rim against the sun, built once and kept across layouts. Shafts and field
   * finials are painted white: bare metal goes near black against the sun. A faint warm emissive stands for
   * the sky light a white pole picks up. The hero keeps its gilt finial (a copy of the pair page one).
   */
  private rimmed() {
    if (!this.poleMats) {
      const { gold } = poleMaterials();
      const rim = () => ({ uRimSunDir: { value: this.sunDir }, uRimSunColor: { value: this.sunColor }, uSunRim: { value: POLE_RIM } });
      const paint = () => new THREE.MeshStandardMaterial({ color: 0xf2f2f0, metalness: 0.05, roughness: 0.45, emissive: 0x2a2826 });
      this.poleMats = {
        metal: applySunRim(paint(), rim()),
        gold: applySunRim(gold.clone(), rim()),
        finial: applySunRim(paint(), rim()),
      };
    }
    return this.poleMats;
  }

  private buildArgentina() {
    const { metal, gold } = this.rimmed();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.15, ARG_POLE_H + POLE_DEPTH, 16, 1, true), metal);
    shaft.position.set(ARG_X, (ARG_POLE_H - POLE_DEPTH) / 2, ARG_Z);
    const finial = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 10), gold);
    finial.position.set(ARG_X, ARG_POLE_H + 0.24, ARG_Z);
    this.scene.add(shaft, finial);

    const canvas = createCanvas(1400, 900);
    drawArgentineFlag(canvas, clothFinish(canvas.width, canvas.height));
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    // The hero is simulated cloth (cloth.ts): the CPU moves the vertices each frame, so the material has no
    // wave. Translucency and a gold rim as for the field. The field keeps the cheap vertex-shader wave.
    const mat = this.fabricMaterial(tex, this.argUniforms, null, false);
    applyRim(mat, { uRimColor: { value: this.sunColor.clone().multiplyScalar(ARG_RIM) } });
    this.argGeo = flagGeometry(ARG_W, ARG_H, ARG_SEGS[0], ARG_SEGS[1]);
    this.argCloth = new ClothSim(ARG_W, ARG_H, ARG_SEGS[0], ARG_SEGS[1], ARG_CLOTH);
    const flag = new THREE.Mesh(this.argGeo, mat);
    flag.frustumCulled = false;
    flag.position.set(ARG_X + 0.12, ARG_POLE_H - 0.25, ARG_Z);
    this.scene.add(flag);

    // A warm spot on its face from above and in front: the brightest thing in the view.
    const spot = new THREE.SpotLight(0xffd08a, SPOT_GAIN, 0, 0.16, 0.85, 0);
    spot.position.copy(ARG_CENTER).add(new THREE.Vector3(0, 30, 18));
    spot.target.position.copy(ARG_CENTER);
    this.scene.add(spot, spot.target);
  }

  /** `fold`: fold shading and sun through the cloth. Without it, the field's gust wave. `wave` false: no motion (simulated cloth). */
  private fabricMaterial(map: THREE.Texture, uniforms: WaveUniforms & BacklightUniforms, fold: FoldUniforms | null = null, wave = true) {
    const normal = clothNormalMap();
    normal.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const mat = new THREE.MeshPhysicalMaterial({
      // Sheen tinted by the print (sheenColorMap): a white sheen read as milky glare on dark and blue cloth.
      map, side: THREE.DoubleSide, roughness: 0.94, metalness: 0, specularIntensity: 0.05, envMapIntensity: 0.5,
      sheen: 0.35, sheenColor: new THREE.Color(0xffffff), sheenColorMap: map, sheenRoughness: 0.9,
      normalMap: normal, normalScale: new THREE.Vector2(0.9, 0.9),
    });
    mat.normalMap!.repeat.set(...CLOTH_NORMAL_REPEAT);
    if (wave) applyWave(mat, uniforms, false, !fold, fold);
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
  private baseMark(i: number) {
    return i < this.poled + FRONT_MARKS ? 1 : 0;
  }

  /** Eases the hovered empty slot in (mark and a faint warm glow) and the previous one back out. */
  private updateHover(dt: number) {
    if (this.hoverAt) {
      const hit = this.pointers.size === 0 && !this.flight ? this.pick(this.hoverAt) : null;
      // Every flag answers the mouse, startups and empty poles alike: a pointer cursor, a faint glow, and
      // the label (SalonApp). Before, only empty poles did, and a startup flag gave no sign it was clickable.
      const next = hit ? hit.index : -1;
      if (next !== this.hovered) {
        this.hovered = next;
        if (next >= 0 && !this.hoverFade.has(next)) this.hoverFade.set(next, 0);
        this.events.onHover?.(hit);
      }
      if (this.pointers.size === 0) this.renderer.domElement.style.cursor = hit ? "pointer" : "grab";
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
    for (let i = 0; i < this.poled; i++) {
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
    if (this.claim) this.hidden.add(this.claim.slot); // the visitor's own flag covers it
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
    for (let i = 0; i < this.poled; i++) {
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
    drawStartupFlag(c, { logo: img, bg: this.list[i].bgColor, weave: clothFinish(tw, th) });
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
    const n = this.makeFlag();
    this.near.push(n);
    return n;
  }

  /** A cloth flag with its own canvas texture, added to the scene. */
  private makeFlag(): NearFlag {
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
    return { mesh, material, texture, canvas, uniforms, index: -1, painted: "none" };
  }

  private backlight(): BacklightUniforms {
    return { uSunDir: { value: this.sunDir }, uSunColor: { value: this.sunColor }, uBacklight: { value: BACKLIGHT }, uGlow: { value: 0 } };
  }

  private assignNear(n: NearFlag, i: number) {
    n.index = i;
    n.painted = "none";
    n.uniforms.uPhase.value = phaseOf(i);
    n.mesh.userData.index = i;
    n.mesh.visible = this.showing < 0;
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
    drawStartupFlag(n.canvas, { logo: img, bg: s.bgColor, weave: clothFinish(n.canvas.width, n.canvas.height) });
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
    this.lodTimer = 0;
  }

  private dpr() {
    return Math.min(window.devicePixelRatio || 1, this.fx.hd ? 2 : 1);
  }

  /** Switches post effects and render resolution. The visitor's toggles land here. */
  setFx(fx: SalonFx) {
    this.fx = { ...fx };
    this.post.setFx(this.fx);
    this.renderer.setPixelRatio(this.dpr());
    this.resize();
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
      // The costly effects go too. The UI shows it, and the visitor can switch them back on.
      this.setFx({ ...this.fx, ao: false, godRays: false, hd: false });
      this.events.onFx?.(this.fx);
    }
  }

  // ---------- Loop and camera ----------

  private lookFrom(from: THREE.Vector3, yaw: number, pitch: number) {
    return new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).add(from);
  }

  private flyTo(to: THREE.Vector3, look: THREE.Vector3, select: number | null) {
    // The view is about to move under a still mouse: drop the hover, or its label would hang mid-air.
    if (this.hovered >= 0) {
      this.hovered = -1;
      this.events.onHover?.(null);
    }
    const d = look.clone().sub(to);
    const yaw1 = this.yaw + angleDelta(this.yaw, Math.atan2(-d.x, -d.z));
    const p1 = Math.atan2(d.y, Math.hypot(d.x, d.z));
    const dist = to.distanceTo(this.pos);
    this.flight = {
      from: this.pos.clone(), to, yaw0: this.yaw, yaw1, p0: this.pitch, p1, t: 0,
      dur: THREE.MathUtils.clamp(1.2 + dist / 40, 1.4, 4.5), select,
    };
  }

  private loop = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.capturing) {
      this.last = now;
      return;
    }
    const rawDt = (now - this.last) / 1000;
    const dt = Math.min(rawDt, 0.1);
    this.last = now;
    this.time += dt;
    this.watchFps(rawDt);
    for (const u of [this.farUniforms, this.argUniforms, ...this.near.map((n) => n.uniforms)]) u.uTime.value = this.time;

    const speed = 10 * dt;
    if (this.keys.has("ArrowUp") || this.keys.has("w")) this.walk(speed);
    if (this.keys.has("ArrowDown") || this.keys.has("s")) this.walk(-speed);
    // Left and right arrows step from flag to flag (SalonApp); A and D turn the view.
    if (this.keys.has("a")) this.turn(1.2 * dt, 0);
    if (this.keys.has("d")) this.turn(-1.2 * dt, 0);

    if (this.flight) {
      const f = this.flight;
      // The intro waits for the canvas to fade in, so its first meters are on screen.
      if (!f.intro || this.frames >= 3) f.t = Math.min(1, f.t + dt / f.dur);
      // Intro: moves at once and settles slowly, like a crane. Other flights: ease in and out, on a gentle arc.
      const k = f.intro ? 1 - Math.pow(1 - f.t, 3) : f.t < 0.5 ? 4 * f.t ** 3 : 1 - Math.pow(-2 * f.t + 2, 3) / 2;
      this.pos.lerpVectors(f.from, f.to, k);
      if (!f.intro) this.pos.y += Math.sin(Math.PI * k) * Math.min(6, f.from.distanceTo(f.to) * 0.08);
      this.yaw = f.yaw0 + (f.yaw1 - f.yaw0) * k;
      this.pitch = f.p0 + (f.p1 - f.p0) * k;
      this.goalPos.copy(this.pos);
      this.goalYaw = this.yaw;
      this.goalPitch = this.pitch;
      if (f.t >= 1) {
        this.flight = null;
        if (f.select !== null) this.events.onSelect?.(f.select);
      }
    }
    if (!this.flight && this.showing >= 0) {
      const o = this.orbit, k = 1 - Math.exp(-EASE_ORBIT * dt);
      if (Math.abs(o.goalAz - o.az) + Math.abs(o.goalEl - o.el) + Math.abs(o.goalZoom - o.zoom) > 1e-5) {
        o.az += (o.goalAz - o.az) * k;
        o.el += (o.goalEl - o.el) * k;
        o.zoom += (o.goalZoom - o.zoom) * k;
        this.placeOrbit();
      }
    } else if (!this.flight) {
      // Frame-rate independent ease toward the goals.
      this.pos.lerp(this.goalPos, 1 - Math.exp(-EASE_MOVE * dt));
      this.clampLook(); // walking changes the angles to the flags
      const look = 1 - Math.exp(-EASE_LOOK * dt);
      this.yaw += (this.goalYaw - this.yaw) * look;
      this.pitch += (this.goalPitch - this.pitch) * look;
    }

    this.updateInset(dt);
    this.updateClaim();
    this.camera.position.copy(this.pos); // the camera moves only with input, flights, and the intro
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.updateMatrixWorld();
    this.sky.update(this.time, this.camera);
    this.clouds.update(this.time, this.camera);
    this.motes.update(this.time);
    this.birds.update(this.time);
    if (this.argCloth && this.argGeo) this.argCloth.update(dt, this.argGeo);
    if (this.showing >= 0 && this.show?.cloth) this.show.cloth.update(dt, this.show.geo);

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
    for (const n of this.near) {
      // Near flags are their own meshes: the highlight pulse wins, else the hover glow.
      n.uniforms.uGlow.value = n.index < 0 ? 0 : this.highlight.has(n.index) ? pulse : (this.hoverFade.get(n.index) ?? 0) * HOVER_GLOW;
    }
    this.updateHover(dt);

    this.lodTimer -= dt;
    if (this.lodTimer <= 0) {
      this.updateLod();
      if (this.showing >= 0 && this.show?.painted !== "logo" && this.logoFor(this.showing)) this.paintShowcase();
      this.lodTimer = 0.25;
    }
    this.post.render(dt);
    // Fade in once real frames are on screen: the first ones compile shaders and can stall.
    if (++this.frames === 3) {
      this.renderer.domElement.style.opacity = "1";
      this.events.onReady?.();
    }
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
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h);
    this.motes.setPixelRatio(this.renderer.getPixelRatio());
    this.camera.aspect = w / h;
    // Narrow screens: widen the view so the corridor and the Argentine flag still fit.
    this.camera.fov = w / h < 1 ? Math.min(70, FOV * (1 / (w / h)) * 0.75) : FOV;
    this.camera.updateProjectionMatrix();
    this.lodTimer = 0;
    if (this.showing >= 0) this.placeOrbit(); // a new screen shape needs a new framing; the orbit stays
  }

  private pick(e: { clientX: number; clientY: number }): { kind: "startup" | "placeholder"; index: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    if (this.showing >= 0) {
      // The showcase cloth is the only flag to pick. The raycaster does not skip hidden meshes.
      const hit = this.show && this.raycaster.intersectObject(this.show.mesh, false)[0];
      return hit ? { kind: "startup", index: this.showing } : null;
    }
    const targets: THREE.Object3D[] = this.near.filter((n) => n.index >= 0).map((n) => n.mesh);
    if (this.far) targets.push(this.far);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit) return null;
    const index = hit.object === this.far ? hit.instanceId ?? -1 : (hit.object.userData.index as number);
    if (index < 0) return null;
    return { kind: index < this.poled ? "startup" : "placeholder", index };
  }

  private bindInput(canvas: HTMLCanvasElement) {
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
      this.moved = false;
      this.pinch = 0;
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
        // While a flag is being hoisted, other flags do not steal the view; another empty pole moves it there.
        if (hit?.kind === "startup") {
          if (!this.claiming) this.focus(hit.index);
        } else if (hit?.kind === "placeholder") this.events.onPlaceholder?.(hit.index);
        else {
          this.setHighlight([]);
          this.events.onSelect?.(null);
          if (this.showing >= 0) this.home(); // the showcase without its card: back to the hall
        }
      }
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("pointerleave", () => {
      if (this.hovered >= 0) this.events.onHover?.(null);
      this.hovered = -1;
      if (!this.pointers.size) canvas.style.cursor = "grab";
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      // Cap each event: trackpad flings send huge deltas. The ease turns the step into a glide.
      this.walk(-THREE.MathUtils.clamp(e.deltaY, -120, 120) * 0.025);
    }, { passive: false });
    canvas.addEventListener("keydown", (e) => {
      if (["ArrowUp", "ArrowDown", "w", "a", "s", "d"].includes(e.key)) {
        this.keys.add(e.key);
        this.flight = null;
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
