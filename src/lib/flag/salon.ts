// Hall of Fame: a short row of flagpoles rising out of a sea of golden sunset clouds. A central
// corridor runs toward the sun; the Argentine flag stands in it, a little larger and taller.
//
// Cost model: one pole per approved startup (at most SALON_SEATS), plus one empty pole while seats are left.
// Most likes stand in the front row; fewer likes, further back. Only the Argentine flag and the showcase
// flag are real cloth simulations (cloth.ts). Hall flags wave in the vertex shader (wave.ts, gust mode),
// each on its own beat: no CPU cost per flag, so the frame time does not grow with the hall.
// - Logos load only for flags on a pole or in the showcase. Nothing else is fetched.
// - Empty slots hold plain white "tu startup acá" flags, so the hall never looks empty.
// - Every pole stands on a crag that breaks through the clouds; far spires out in the sea give the scale.
import * as THREE from "three";
import { SALON_SEATS, type PublicStartup } from "@/lib/startups/model";
import { Birds } from "./birds";
import { FrameAverage, applyFinish, canvasToBlob } from "./finish";
import { ClothSim, type WindLook } from "./cloth";
import { CLOUD_TOP, CloudSea } from "./cloudSea";
import { CLOTH_NORMAL_REPEAT, applyBacklight, applyMapFade, applyRim, applySunRim, clothNormalMap, type BacklightUniforms, type MapFadeUniforms } from "./fabric";
import { farCrags, poleIsland, stoneMaterial } from "./islands";
import { Motes } from "./motes";
import { buildPole, poleMaterials } from "./pole";
import { Post, type PostFx, type StillFocus } from "./post";
import { SunsetSky, sunDirection } from "./sunsetSky";
import { clothFinish, createCanvas, drawArgentineFlag, drawPlaceholderFlag, drawStartupFlag, prepareLogo, type LogoImage } from "./texture";
import { applyWave, flagGeometry, type WaveUniforms } from "./wave";

// ---------- Layout (meters) ----------
const FLAG_W = 3.1, FLAG_H = 2.0;
const POLE_H = 4; // above y = 0: the flag rides just over the cloud tops; the flags matter, not the poles
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
const SWAP_S = 0.5; // s for one showcase flag to turn into the next (the tour arrows)
const POLE_RIM = 1.6; // gold outline on the poles against the sun
const BIRD_FLOCKS = 3;
const MOTE_GAIN = 1.0; // HDR, added per speck. Deep amber: bright points tone-map to white, and white specks read as snow
const FOG_DENSITY = 0.0024; // aerial perspective: far crags fade into the amber haze. Much more washes the whole frame out
// The crags the poles stand on: their planed tops just clear the cloud tops.
const HALL_ROCK = { radius: 0.95, top: CLOUD_TOP + 0.2 };
const ARG_ROCK = { radius: 2.0, top: CLOUD_TOP + 0.6 };
const HALL_POLE_R = 0.07, ARG_POLE_R = 0.13;
// Hall cloth: light bunting, waved on the GPU. Each pole gets its own phase (phaseOf), so no two flags move alike.
const HALL_RIM = 0.22;
const HALL_BACKLIGHT = 1.2; // thin cloth: the low sun shows through it
const HALL_TRANSMIT = 0.16; // a little of the sun through it: more, and a red flag near the sun burns like neon

// ---------- Camera ----------
// Back, on a long lens, a little above the flags and looking slightly down: the back rows show over the
// front ones instead of hiding behind them, the Argentine flag flies high above the field, and the
// telephoto packs the rows behind it.
const START = new THREE.Vector3(0, 5.2, 26);
const START_PITCH = -0.06;
const START_YAW = 0; // straight down the corridor: the Argentine flag on the center line
const FOV = 32;
// Opening shot: the camera cranes down from high and far back to the start view.
const INTRO_FROM = new THREE.Vector3(0, 11, 54);
const INTRO_PITCH = -0.05;
const INTRO_DUR = 8; // s
const YAW_LIMIT = 1.15; // rad either side of the corridor axis: you can look at the flags, never back
const PITCH_MIN = -0.3, PITCH_MAX = 0.35;
// Middle-button drag raises and lowers the eye, to see over the front rows. The top stays under the
// Argentine flag's top, so the view never turns into a map.
const EYE_MAX = 10;
// The floor is the start view's height: any lower and the eye dips into the cloud tops.
const EYE_MIN = START.y;
const LIFT_PER_PX = 0.03; // m of height per pixel of drag
const EASE_MOVE = 4; // 1/s: how fast position catches its goal
const EASE_LOOK = 9; // 1/s: how fast yaw and pitch catch theirs
// Showcase orbit: the camera circles the pair, never turns away from it. Limits keep the sun behind the
// cloths (it backlights them) and the eye above the cloud tops.
const ORBIT_AZ = 0.6; // rad either side of the straight-on view
const ORBIT_EL_MIN = -0.06, ORBIT_EL_MAX = 0.3; // rad below and above it
const ORBIT_ZOOM_MIN = 0.7, ORBIT_ZOOM_MAX = 1.35; // times the framing distance
const EASE_ORBIT = 7; // 1/s

const HALL_INNER = 4.5; // m from the axis to the center of the inner cloths
const HALL_DX = 4.5; // m between neighbors in a row: a cloth is 3.1 wide, so a gap of about 1.4 m
const HOVER_GLOW = 0.1;

// Row view: every flag in one line, most likes on the left, fewest on the right, each one sized by its likes,
// like a "size comparison" video. The camera slides along the row and comes closer as the flags shrink.
const ROW_Z = FIRST_Z;
// Flag scale at zero likes and at the most likes. Not smaller: about 3 m of crag shows above the clouds
// whatever its scale, and under a smaller flag it reads as a wall.
const ROW_MIN = 0.8, ROW_MAX = 2.4;
const ROW_GAP = 1.6; // m of sky between two cloths, times the bigger one's scale
// Flags scale around this height, so every crag top stays just over the clouds whatever the size.
const ROW_PIVOT = CLOUD_TOP;
const ROW_CRAG_DEPTH = 0.3; // crag height below its top in the row view, against the hall's
const ROW_PAN = 6; // m/s per unit of scale: the opening slide from #1 down the row
const ROW_DIST_MIN = 28; // m from the row: the hall start view's distance to its front row, where the clouds hide the crags' feet

export type Layout = "hall" | "row";
const EASE_HOVER = 7; // 1/s

// Sky and cloud sea resolution, per axis, against the drawing buffer. Both are soft: half resolution measured
// 45 dB PSNR against full (no visible change) and cut the frame time by a third on an integrated GPU.
const BACKDROP_SCALE = 0.5;

// Wallpaper still: jittered frames averaged (16 is where the edges stop changing), and cloud ray-march steps.
const STILL_SAMPLES = 16;
const STILL_CLOUD_STEPS = 128;
const STILL_FOCUS_RANGE = 1.5;
const STILL_BOKEH = 16;
// The live hall uses a softer lens than the wallpaper, so the far flags stay readable.
const LIVE_BOKEH_SCALE = 0.6;

/** Low-discrepancy sequence in [0, 1): sub-pixel offsets that cover the pixel evenly. */
function halton(i: number, base: number) {
  let f = 1, r = 0;
  for (; i > 0; i = Math.floor(i / base)) {
    f /= base;
    r += f * (i % base);
  }
  return r;
}

const SUN_FOCUS = new THREE.Vector3(0, 2, (FIRST_Z + ARG_Z) / 2); // center of the hall's shadow box
const SUN_P = new THREE.Vector3();
const FOCUS_DIR = new THREE.Vector3();
const FOCUS_P = new THREE.Vector3();
const FOCUS_NDC = new THREE.Vector3();

type Tier = "high" | "low";
const TIERS = {
  high: { steps: 72, cloth: [30, 19] as const, motes: 450, shadows: true },
  low: { steps: 28, cloth: [16, 10] as const, motes: 180, shadows: false },
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
  return { ao: high, bloom: true, godRays: high, hd: high, cinema: high };
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
  /** Size of the whole stand (crag, pole and cloth). 1 in the hall. */
  s?: number;
  /** Off the row: a category filter leaves this flag out. */
  hidden?: boolean;
}

/** Row r's depth. Rows from the third on skip one step, so the Argentine flag stands in an open gap. */
function rowZ(r: number) {
  return FIRST_Z - (r < 2 ? r : r + 1) * DZ;
}

/**
 * The hall: rows of `perSide` cloths each side of the hero, best seats first (front row, inner, then outer,
 * left before right). Cloths fly to the right of their pole, so each pole stands half a cloth left of the
 * cloth center: the row looks even around the axis. Further rows stand DZ behind. Odd rows shift half a
 * step outward, like bricks: each back flag shows in the gap between two in front.
 */
export function hallSlots(n: number, perSide: number): Slot[] {
  const perRow = perSide * 2;
  return Array.from({ length: n }, (_, i) => {
    const side: 1 | -1 = i % 2 === 0 ? -1 : 1;
    const col = Math.floor((i % perRow) / 2);
    const row = Math.floor(i / perRow);
    const shift = row % 2 === 1 ? HALL_DX / 2 : 0;
    return { x: side * (HALL_INNER + shift + col * HALL_DX) - FLAG_W / 2, z: rowZ(row), side };
  });
}

/**
 * The row view. `likes` is in seat order (index 0 has the most), and the row keeps that order: most likes
 * on the left, fewest on the right. Scale follows log(likes), so one big flag does not flatten the rest; it
 * never grows to the right, even when a visitor's own like reordered the seats before the counts caught up.
 * The row centers on x = 0.
 */
export function rowSlots(likes: number[]): Slot[] {
  const n = likes.length;
  const top = Math.log1p(Math.max(0, ...likes));
  const out: Slot[] = new Array(n);
  let x = 0, prev = 0, last = Infinity;
  for (let i = 0; i < n; i++) {
    const raw = top > 0 ? ROW_MIN + ((ROW_MAX - ROW_MIN) * Math.log1p(Math.max(0, likes[i]))) / top : 1;
    const s = Math.min(raw, last);
    if (i > 0) x += prev * FLAG_W + ROW_GAP * prev;
    out[i] = { x, z: ROW_Z, side: 1, s };
    prev = last = s;
  }
  const mid = n ? (x + prev * FLAG_W) / 2 : 0;
  for (const p of out) p.x -= mid;
  return out;
}

/** Wave phase per flag: golden-angle steps, so neighbors never move in step. */
export function phaseOf(i: number) {
  return (i * 2.39996) % (Math.PI * 2);
}

/** The pair shot: the picked startup's cloth next to the Argentine flag. */
interface Showcase {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  tex: THREE.CanvasTexture; // the print on screen
  canvas: HTMLCanvasElement;
  back: { tex: THREE.CanvasTexture; canvas: HTMLCanvasElement }; // the previous print, during a swap
  fade: MapFadeUniforms;
  fadeT: number; // 0..1 through a swap, linear; 1 at rest
  geo: THREE.BufferGeometry;
  cloth: ClothSim | null;
  parts: THREE.Object3D[]; // pole, finial, cloth, spot: shown and hidden together
  painted: "none" | "color" | "logo";
}

/** A GPU-waved cloth on a hall pole (or the visitor's own flag), with its own canvas texture. */
interface HallFlag {
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  material: THREE.MeshPhysicalMaterial;
  depth: THREE.MeshDepthMaterial; // shadow, bent by the same wave
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  uniforms: BacklightUniforms;
  painted: string; // what is on the canvas: "", "empty", "<id>:color" or "<id>:logo"
}

/** The visitor's own flag on an empty pole, while the hoist sheet is open (and after, until the layout changes). */
interface Claim {
  slot: number;
  flag: HallFlag;
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
  private hallLayout: Slot[] = []; // the hall's seats, kept while the row view shows
  private layout: Layout = "hall";
  private category: string | null = null; // only this category's flags show, in either layout; null shows all
  private rowCenters: { x: number; s: number }[] = []; // cloth centers left to right, for the row camera
  private rowPan = false; // the opening slide along the row runs until any input
  private cols = 10;
  private time = 0;
  private raf = 0;
  private last = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver;

  // The hall: poles on their crags, and one simulated cloth per slot. Built once; a new list repaints it.
  private poleMats: { metal: THREE.MeshStandardMaterial; gold: THREE.MeshStandardMaterial } | null = null;
  private stone: THREE.MeshStandardMaterial;
  private plinth = new THREE.MeshStandardMaterial({ color: 0x9a948c, roughness: 0.85, metalness: 0 });
  private hall = new THREE.Group();
  private flags: HallFlag[] = []; // built once per slot and kept: a shorter list only hides the extra ones
  private stands: THREE.Object3D[] = []; // crag and pole per built slot
  // Wind clock and strength shared by every hall flag's wave shader: one write a frame moves them all.
  private hallTime = { value: 0 };
  private hallWindK = { value: 1 };
  private sunLight: THREE.DirectionalLight;
  private hovered = -1; // slot under the mouse
  private hoverFade = new Map<number, number>(); // slot -> 0..1, easing in or out
  private hoverAt: { clientX: number; clientY: number } | null = null; // last mouse position to pick, once per frame

  private argUniforms: BacklightUniforms;
  private argCloth: ClothSim | null = null;
  private argGeo: THREE.BufferGeometry | null = null;
  private argFlag: THREE.Mesh | null = null;
  // Cinema mode's live focus: Post reads this object every frame; updateFocus moves it.
  private liveFocus: StillFocus = { target: ARG_CENTER.clone(), range: 40, bokeh: 6 };
  private focusGoal = ARG_CENTER.clone();
  private focusTick = 0;
  private focusRangeGoal = 40;
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
  // `lift`: the middle mouse button, whose drag moves the eye up and down instead of turning it.
  private pointers = new Map<number, { x: number; y: number; sx: number; sy: number; lift: boolean }>();
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

    // The low sun casts long shadows toward the viewer: the poles across their crags, the cloths on the rock.
    // One map over the hall and the hero only; the far crags take no part.
    const sun = new THREE.DirectionalLight(0xffc27a, 2.1);
    sun.position.copy(this.sunDir).multiplyScalar(90).add(SUN_FOCUS);
    sun.target.position.copy(SUN_FOCUS);
    sun.castShadow = t.shadows;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 16, bottom: -12, near: 40, far: 150 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 3;
    renderer.shadowMap.enabled = t.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.sunLight = sun;
    this.scene.add(sun, sun.target);
    // A cool sky fill over a warm cloud bounce: the cool keeps the shadows from going muddy orange.
    this.scene.add(new THREE.HemisphereLight(0xc4cbe0, 0xf2b070, 0.35));

    this.stone = stoneMaterial({ sunDir: this.sunDir, sunColor: this.sunColor, fogDensity: FOG_DENSITY });
    this.argUniforms = this.backlight();
    this.buildArgentina();
    this.hall.name = "hall";
    this.scene.add(this.hall);
    this.scene.add(farCrags(this.stone, START));

    this.post = new Post(renderer, this.scene, this.camera, this.sky.raySun, this.fx, this.backdrop, BACKDROP_SCALE);
    this.post.setLiveFocus(this.liveFocus);
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
    // Likes reorder the seats, so the showcase follows its startup by id, not by index.
    const showingId = this.showing >= 0 ? this.list[this.showing]?.id : undefined;
    this.list = list;
    if (showingId !== undefined) this.showing = list.findIndex((s) => s.id === showingId);
    this.knownIds = new Set(list.map((s) => s.id));
    this.rising.clear();
    this.poled = Math.min(list.length, SALON_SEATS);
    const count = this.poled < SALON_SEATS ? this.poled + 1 : this.poled; // one pole free while seats are left: the hoist needs it
    this.cols = 2;
    // Phones are narrow: a third cloth each side would start out of frame.
    const narrow = window.matchMedia?.("(max-width: 767px)").matches;
    this.hallLayout = hallSlots(count, narrow ? 2 : 3);
    this.buildHall();
    this.setSlots();
    if (prevIds) {
      for (let i = 0; i < this.poled; i++) if (!prevIds.has(list[i].id)) this.rising.set(i, this.time);
    }
    for (let i = 0; i < count; i++) {
      this.paintFlag(i);
      this.placeStand(i);
      this.placeFlag(i);
    }
    if (this.layout === "row") this.clampPos();
    // In the showcase, the new hall stays hidden. Its startup left the list: back to the hall.
    if (showingId !== undefined && this.showing < 0) {
      this.showing = 0; // leaveShowcase only runs from an open showcase
      this.leaveShowcase();
    } else if (this.showing >= 0) {
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
    this.refreshFlags();
    this.lodTimer = 0;
  }

  // ---------- Hoist in place ----------
  // The same calls as the two-pole scene, so the hoist sheet drives either one.

  /**
   * Takes empty slot `slot` (default: the best free seat) for the visitor's flag and flies to look at it from
   * above the row in front. A second call moves the flag to the new slot and keeps its paint.
   */
  claimSlot(slot = this.poled) {
    // The hoist happens in the whole hall: no row, no filter.
    if (this.layout === "row" || this.category !== null) {
      this.category = null;
      this.applyLayout("hall");
    }
    if (slot < this.poled || !this.slots[slot]) slot = this.poled;
    const p = this.slots[slot];
    if (!p) return;
    if (this.claim?.released) this.dropClaim();
    this.leaveShowcase(); // the hoist happens in the hall
    // Remember the view on the first claim, so closing the sheet flies back to it.
    if (!this.claim) this.beforeClaim = { pos: this.pos.clone(), yaw: this.yaw, pitch: this.pitch };
    if (!this.claim) {
      const flag = this.makeFlag(slot);
      drawStartupFlag(flag.canvas, { logo: null, bg: "#ffffff", weave: clothFinish(flag.canvas.width, flag.canvas.height) });
      flag.texture.needsUpdate = true;
      this.scene.add(flag.mesh);
      this.claim = { slot, flag, hoist: 1, from: 1, target: 1, start: 0, dur: 1, done: null, released: false };
    }
    this.claim.slot = slot;
    this.claim.flag.mesh.visible = true;
    this.placeClaim();
    this.refreshFlags();
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
    c.flag.mesh.position.set(p.x + HALL_POLE_R + 0.02, POLE_H - 0.2 - (POLE_H + 1) * (1 - c.hoist), p.z);
  }

  private dropClaim() {
    const c = this.claim;
    if (!c) return;
    c.done?.();
    this.scene.remove(c.flag.mesh);
    c.flag.geo.dispose();
    c.flag.material.dispose();
    c.flag.depth.dispose();
    c.flag.texture.dispose();
    this.claim = null;
    this.refreshFlags();
    this.lodTimer = 0;
  }

  private updateClaim(dt: number) {
    const c = this.claim;
    if (!c) return;
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
    if (this.showing >= 0) {
      this.swapShowcase(i);
      this.events.onSelect?.(i);
      return;
    }
    this.cut(() => {
      this.enterShowcase(i);
      this.events.onSelect?.(i);
    });
  }

  /** The hall's empty poles, in seat order: the tour visits them after the startups. */
  emptySlots(): number[] {
    const out: number[] = [];
    if (this.layout === "row" || this.category !== null) return out; // the row and a filter show only startups
    for (let i = this.poled; i < this.slots.length; i++) out.push(i);
    return out;
  }

  /** Flies to empty pole `slot` (the tour), leaving the showcase first if it is open. No selection event. */
  focusSlot(slot: number) {
    if (!this.slots[slot]) return;
    this.setHighlight([]);
    const go = () => this.flyToFlag(slot, null);
    if (this.showing >= 0) {
      this.cut(() => {
        this.leaveShowcase();
        go();
      });
    } else go();
  }

  /** Flies through the hall to stand in front of startup flag `i`, and reports the selection on arrival. */
  private flyToFlag(i: number, select: number | null = i) {
    const p = this.slots[i];
    if (!p) return;
    if (this.layout === "row") {
      const v = this.rowView(p.x + ((p.s ?? 1) * FLAG_W) / 2);
      this.flyTo(v.pos, v.look, select);
      return;
    }
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
    this.flyTo(stand, look, select);
  }

  /** Glows these startup flags (search, city filter), the ones on a hall pole. Empty clears. */
  setHighlight(indices: number[]) {
    this.highlight = new Set(indices.filter((i) => i >= 0 && i < this.poled));
  }

  /**
   * Flies through the hall to the nearest of these flags (city filter, search) and highlights all of them.
   * Several matches only make sense among the others, so this leaves the showcase. Startups off the poles
   * have no hall flag to fly to: when none is on a pole, the first match opens in the showcase.
   */
  focusAny(indices: number[]) {
    const onPole = indices.filter((i) => i < this.poled && !this.slots[i]?.hidden); // the category filter hides some
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
    const go = () => {
      if (this.layout === "row") {
        const v = this.rowView(this.rowStart());
        this.flyTo(v.pos, v.look, null);
      } else this.flyTo(START.clone(), this.lookFrom(START, START_YAW, START_PITCH), null);
    };
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
    if (this.layout === "row") {
      this.slide(-meters * this.scaleAt(this.goalPos.x));
      return;
    }
    this.flight = null;
    this.goalPos.z -= meters;
    this.clampPos();
  }

  // ---------- Row view ----------

  /**
   * Switches between the hall and the row view. `category` keeps only that category's flags, in either view;
   * null shows them all. A quick fade hides the cut.
   */
  setLayout(mode: Layout, category: string | null = null) {
    if (mode === this.layout && category === this.category) return;
    this.cut(() => {
      this.category = category;
      this.applyLayout(mode);
    });
  }

  private applyLayout(mode: Layout) {
    this.leaveShowcase();
    if (mode === "row" && this.claim) this.dropClaim();
    this.layout = mode;
    this.setSlots();
    for (let i = 0; i < this.flags.length; i++) {
      this.placeStand(i);
      this.placeFlag(i);
    }
    this.refreshFlags();
    this.setHighlight([]);
    this.flight = null;
    if (this.hovered >= 0) {
      this.hovered = -1;
      this.events.onHover?.(null);
    }
    if (mode === "row") {
      // Start on #1 and slide down the row. Reduced motion stays on #1.
      const c = this.rowCenters;
      this.goalPos.x = this.rowStart();
      this.clampPos();
      this.pos.copy(this.goalPos);
      this.aimRow();
      this.rowPan = !this.reducedMotion() && c.length > 1;
    } else {
      this.rowPan = false;
      this.aimSun(SUN_FOCUS);
      this.pos.copy(START);
      this.goalPos.copy(START);
      this.yaw = this.goalYaw = START_YAW;
      this.pitch = this.goalPitch = START_PITCH;
    }
  }

  /** Slots for the current layout, and the row camera's cloth centers. */
  private setSlots() {
    // The category filter. If the category empties out, every flag shows.
    const poled = this.list.slice(0, this.poled);
    let keep = poled.flatMap((s, i) => (this.category === null || s.category === this.category ? [i] : []));
    if (!keep.length) keep = poled.map((_, i) => i);
    if (this.layout === "row") {
      // The row sizes the kept flags against each other.
      const row = rowSlots(keep.map((i) => poled[i].likes));
      this.slots = poled.map((): Slot => ({ x: 0, z: ROW_Z, side: 1, hidden: true }));
      keep.forEach((i, k) => (this.slots[i] = row[k]));
      this.rowCenters = row.map((p) => ({ x: p.x + ((p.s ?? 1) * FLAG_W) / 2, s: p.s ?? 1 })).sort((a, b) => a.x - b.x);
    } else {
      // The hall keeps every seat in place and hides the rest. A filtered hall hides its empty poles too.
      const shown = new Set(keep), all = shown.size === poled.length;
      this.slots = all ? this.hallLayout : this.hallLayout.map((p, i) => (shown.has(i) ? p : { ...p, hidden: true }));
      this.rowCenters = [];
    }
  }

  /** #1's center, the biggest flag, on the left: where the row view starts and rests. */
  private rowStart() {
    return this.rowCenters[0]?.x ?? 0;
  }

  /** The last flag's center, on the right: where the opening slide stops. */
  private rowEnd() {
    return this.rowCenters.at(-1)?.x ?? 0;
  }

  /** Flag scale at x along the row, eased between neighbors, so the camera pulls back smoothly. */
  private scaleAt(x: number) {
    const c = this.rowCenters;
    if (!c.length) return 1;
    if (x <= c[0].x) return c[0].s;
    for (let k = 1; k < c.length; k++) {
      if (x <= c[k].x) return c[k - 1].s + (c[k].s - c[k - 1].s) * ((x - c[k - 1].x) / (c[k].x - c[k - 1].x));
    }
    return c[c.length - 1].s;
  }

  /** Row camera at x: square in front of the row, back far enough for the local flags to fit the height. */
  private rowView(x: number) {
    const s = this.scaleAt(x);
    const cy = ROW_PIVOT + s * (POLE_H - 0.2 - FLAG_H / 2 - ROW_PIVOT);
    // About three flag heights of view: four or five flags across, so neighbors read side by side. Never
    // closer than ROW_DIST_MIN: small flags then look small, and the crags' feet stay hidden in the clouds.
    const tall = s * (POLE_H - ROW_PIVOT) * 3 + 2;
    const dist = Math.max(ROW_DIST_MIN, tall / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    return {
      pos: new THREE.Vector3(x, Math.max(EYE_MIN, cy + dist * 0.12), ROW_Z + dist),
      look: new THREE.Vector3(x, cy, ROW_Z),
    };
  }

  /** Looks at the row from where the camera is. */
  private aimRow() {
    const d = this.rowView(this.pos.x).look.sub(this.pos);
    this.yaw = this.goalYaw = 0;
    this.pitch = this.goalPitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  }

  /** Moves the row camera `meters` to the right. Any input stops the opening slide. */
  private slide(meters: number) {
    this.flight = null;
    this.rowPan = false;
    this.goalPos.x += meters;
    this.clampPos();
  }

  /** A drag of `px` screen pixels: the row follows the finger. */
  private pan(px: number) {
    const d = this.goalPos.z - ROW_Z;
    this.slide((px * 2 * d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / this.size.h);
  }

  /** Points the sun's shadow box (40 m wide) at `focus`. The row view moves it with the camera. */
  private aimSun(focus: THREE.Vector3) {
    this.sunLight.position.copy(this.sunDir).multiplyScalar(90).add(focus);
    this.sunLight.target.position.copy(focus);
    this.sunLight.target.updateMatrixWorld();
  }

  private turn(dYaw: number, dPitch: number) {
    if (this.layout === "row" && this.showing < 0) return; // the row view slides instead (pan, slide)
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
  // simulated cloth at the same size, the same material, rim, and spot. The hall (its crags, poles and
  // cloths) is hidden. Built once on first use, then repainted for each startup.

  /** The pair's pole and cloth, built like the hero's (buildArgentina). */
  private showcaseParts(): Showcase {
    if (this.show) return this.show;
    const stand = this.standPole(SHOW_X, ARG_Z, SHOW_POLE_H, ARG_POLE_R, ARG_ROCK.radius * 0.75, ARG_ROCK.top - 0.3, 41);

    // Two prints: the tour paints the next flag on the hidden one and cross-fades to it (swapShowcase).
    const print = () => {
      const canvas = createCanvas(2100, 1350); // 1.5x the hero's canvas: the logo stays sharp at 4K
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      return { canvas, tex };
    };
    const { canvas, tex } = print();
    const back = print();
    const fade: MapFadeUniforms = { uPrevMap: { value: back.tex }, uFade: { value: 1 } };
    const mat = applyMapFade(this.fabricMaterial(tex, this.backlight()), fade);
    applyRim(mat, { uRimColor: { value: this.sunColor.clone().multiplyScalar(ARG_RIM) } });
    const geo = flagGeometry(ARG_W, ARG_H, ARG_SEGS[0], ARG_SEGS[1]);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.position.set(SHOW_X + ARG_POLE_R + 0.03, SHOW_POLE_H - 0.25, ARG_Z);

    const center = new THREE.Vector3(SHOW_X + ARG_W / 2, SHOW_POLE_H - 0.25 - ARG_H / 2, ARG_Z);
    const spot = new THREE.SpotLight(0xffd08a, SPOT_GAIN, 0, 0.16, 0.85, 0);
    spot.position.copy(center).add(new THREE.Vector3(0, 30, 18));
    spot.target.position.copy(center);

    const parts = [stand, mesh, spot, spot.target];
    for (const p of parts) p.visible = false;
    this.scene.add(...parts);
    this.show = { mesh, tex, canvas, back, fade, fadeT: 1, geo, cloth: null, parts, painted: "none" };
    return this.show;
  }

  /** Hides or shows the hall: its crags, poles and cloths, and the visitor's flag. */
  private setHall(on: boolean) {
    this.hall.visible = on;
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
    this.endSwap();
    // A fresh cloth each time, flown for a few seconds while the view is faded out: it arrives flying.
    s.cloth = new ClothSim(ARG_W, ARG_H, ARG_SEGS[0], ARG_SEGS[1], ARG_CLOTH);
    for (let t = 0; t < SHOW_WARMUP; t += 1 / 60) s.cloth.update(1 / 60, s.geo);
    for (const p of s.parts) p.visible = true;
    this.setHall(false);
    if (aim) this.aimShowcase();
  }

  /**
   * Showcase to showcase (the tour arrows): no fade to black, no fresh cloth, no camera reset. The same cloth
   * keeps flying where the visitor left the view, and the next print fades in over the last one.
   */
  private swapShowcase(i: number) {
    const s = this.show;
    if (!s) return;
    if (this.hovered >= 0) {
      this.hovered = -1;
      this.events.onHover?.(null);
    }
    // The print on screen becomes the fade's start; the hidden one takes the new flag.
    [s.tex, s.back.tex] = [s.back.tex, s.tex];
    [s.canvas, s.back.canvas] = [s.back.canvas, s.canvas];
    s.mesh.material.map = s.tex;
    s.mesh.material.sheenColorMap = s.tex;
    s.fade.uPrevMap.value = s.back.tex;
    this.showing = i;
    s.mesh.userData.index = i;
    this.paintShowcase();
    s.fadeT = 0;
    s.fade.uFade.value = 0;
    if (this.reducedMotion()) this.endSwap();
  }

  /** Jumps a running swap to its end: the current print alone. */
  private endSwap() {
    if (!this.show) return;
    this.show.fadeT = 1;
    this.show.fade.uFade.value = 1;
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
    const fill = aspect < 1 ? 0.84 : 0.75; // portrait: nearly the full width, with a margin so no pole touches the edge
    const dist = Math.max(18, (right - left) / fill / (2 * Math.tan(halfW)));
    // The eye stands square in front of the Argentine flag, as in the start view: the low sun sits right
    // behind the hero's cloth and shines through it. Between the two flags, it washes the whole frame out.
    // Portrait is the exception: from there the oblique view cut the hero off the left edge, so the eye moves
    // to the middle of the pair.
    // High enough to clear the billows: lower, the eye sinks into a cloud and the frame turns to haze.
    const x = aspect < 1 ? look.x : ARG_CENTER.x;
    return { pos: new THREE.Vector3(x, SHOW_EYE_Y, ARG_Z + dist), look };
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
    this.endSwap(); // a still image shows one flag, never two half-faded
    // The hero can still hang flat (a fresh load, or a tab in the background stalls its sim): fly it a little.
    if (this.argCloth && this.argGeo) for (let t = 0; t < SHOW_WARMUP; t += 1 / 60) this.argCloth.update(1 / 60, this.argGeo);
    const { pos, look } = this.showcaseView(width / height);
    this.camera.position.copy(pos);
    this.camera.lookAt(look);
    this.camera.updateMatrixWorld();
    this.sky.update(this.time, this.camera);
    this.clouds.update(this.time, this.camera);
    // A still has no frame budget: every effect on at its top quality, whatever the visitor picked.
    this.post.setFx({ ao: true, bloom: true, godRays: true, cinema: false }); // the CPU finish grades the still
    // Focus on the two flags; the sky and the far cloud sea fall out of focus. The camera sees the startup's
    // flag at an angle, so its far end is well past the focus point: under ~1.5 times the distance, that end
    // went soft (a light cloth melted into the sky). The sky and the horizon still go soft at 1.5.
    // Bokeh is in pixels: 16 at 4K is a lens near f/2.
    const dist = pos.distanceTo(look);
    this.post.setStill(true, { target: look.clone(), range: dist * STILL_FOCUS_RANGE, bokeh: STILL_BOKEH });
    this.clouds.setSteps(STILL_CLOUD_STEPS);
    const shadow = this.sunLight.shadow;
    if (this.sunLight.castShadow) {
      shadow.mapSize.set(4096, 4096);
      shadow.map?.dispose();
      shadow.map = null; // three builds a new one at the new size
    }
    try {
      // Supersampling: the same frame many times, the camera shifted by a fraction of a pixel each time,
      // then averaged. Thin poles, cloth edges and the sun's rim come out clean, at no extra GPU memory.
      const avg = new FrameAverage(width, height);
      for (let s = 0; s < STILL_SAMPLES; s++) {
        const jx = halton(s + 1, 2) - 0.5, jy = halton(s + 1, 3) - 0.5;
        this.camera.setViewOffset(width, height, jx, jy, width, height);
        this.post.render(1 / 60);
        avg.add(this.renderer.domElement); // same task as the render: WebGL drops the buffer after
        await new Promise((r) => setTimeout(r)); // let the page breathe between samples
      }
      // Finish it like a frame of film. The light leak and halation lean toward the sun.
      this.camera.clearViewOffset();
      const sun = this.sky.raySun.position.clone().project(this.camera);
      applyFinish(avg.resolve(), width, height, { sun: { x: (sun.x + 1) / 2, y: (1 - sun.y) / 2 } });
      return await canvasToBlob(avg.canvas, "image/jpeg", 0.95);
    } finally {
      this.camera.clearViewOffset();
      if (this.sunLight.castShadow) {
        shadow.mapSize.set(2048, 2048);
        shadow.map?.dispose();
        shadow.map = null;
      }
      this.post.setStill(false);
      this.post.setFx(this.fx);
      if (prevShowing < 0) this.leaveShowcase();
      else if (prevShowing !== i) this.enterShowcase(prevShowing, false);
      this.renderer.setPixelRatio(prevDpr);
      this.applyTier(prevTier); // also puts the cloud steps back
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
    this.show?.back.tex.dispose();
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
    for (const f of this.flags) {
      f.texture.dispose();
      f.depth.dispose();
    }
    this.claim?.flag.texture.dispose();
    this.claim?.flag.depth.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------- Build ----------

  /**
   * Pole materials with a gold rim against the sun, built once. Brushed aluminium (pole.ts) with its streaks,
   * smoother and brighter than the pair page's: against a low sun, rough metal goes near black, and a pole
   * reads as metal by the long soft highlight the sky draws down it. Satin gilt on the finials.
   */
  private rimmed() {
    if (!this.poleMats) {
      const { metal, gold } = poleMaterials();
      const rim = () => ({ uRimSunDir: { value: this.sunDir }, uRimSunColor: { value: this.sunColor }, uSunRim: { value: POLE_RIM } });
      const m = metal.clone();
      // Strong reflections: the scene's sky fill is low (contre-jour), and a pole is mostly what it reflects.
      // The env map is set on the material: with scene.environment, three uses the scene's intensity instead.
      const envMap = this.scene.environment;
      // Kept moderate: without tone mapping, a stronger reflection of the bright sky clips the pole to flat white.
      Object.assign(m, { color: new THREE.Color(0xe0e3e8), metalness: 0.9, roughness: 0.3, envMap, envMapIntensity: 1.4 });
      const g = gold.clone();
      Object.assign(g, { roughness: 0.36, envMap, envMapIntensity: 2.2 });
      this.poleMats = { metal: applySunRim(m, rim()), gold: applySunRim(g, rim()) };
    }
    return this.poleMats;
  }

  /**
   * A pole on its crag: the island (rock and plinth) at (x, z) with its planed top at `rockTop`, and a
   * brushed metal pole with truck, collar and gilt ball rising to `poleH`, with the clips for a flag.
   */
  private standPole(x: number, z: number, poleH: number, radius: number, rockR: number, rockTop: number, seed: number, flagH = ARG_H) {
    const g = new THREE.Group();
    const island = poleIsland(this.stone, this.plinth, rockR, rockTop, seed, radius);
    island.position.set(x, 0, z);
    const foot = island.userData.foot as number;
    const pole = buildPole(poleH - foot + 0.3, [-0.25, -0.25 - flagH], radius, this.rimmed());
    pole.position.set(x, poleH, z);
    pole.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = true;
    });
    g.add(island, pole);
    return g;
  }

  private buildArgentina() {
    this.scene.add(this.standPole(ARG_X, ARG_Z, ARG_POLE_H, ARG_POLE_R, ARG_ROCK.radius, ARG_ROCK.top, 7));

    const canvas = createCanvas(1400, 900);
    drawArgentineFlag(canvas, clothFinish(canvas.width, canvas.height));
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    // The hero is simulated cloth (cloth.ts): the CPU moves the vertices each frame, so the material has no
    // wave. Translucency and a gold rim, as for the hall flags.
    const mat = this.fabricMaterial(tex, this.argUniforms);
    applyRim(mat, { uRimColor: { value: this.sunColor.clone().multiplyScalar(ARG_RIM) } });
    this.argGeo = flagGeometry(ARG_W, ARG_H, ARG_SEGS[0], ARG_SEGS[1]);
    this.argCloth = new ClothSim(ARG_W, ARG_H, ARG_SEGS[0], ARG_SEGS[1], ARG_CLOTH);
    const flag = new THREE.Mesh(this.argGeo, mat);
    this.argFlag = flag;
    flag.frustumCulled = false;
    flag.castShadow = true;
    flag.position.set(ARG_X + ARG_POLE_R + 0.03, ARG_POLE_H - 0.25, ARG_Z);
    this.scene.add(flag);

    // A warm spot on its face from above and in front: the brightest thing in the view.
    const spot = new THREE.SpotLight(0xffd08a, SPOT_GAIN, 0, 0.16, 0.85, 0);
    spot.position.copy(ARG_CENTER).add(new THREE.Vector3(0, 30, 18));
    spot.target.position.copy(ARG_CENTER);
    this.scene.add(spot, spot.target);
  }

  /**
   * Cloth for a flag: woven normal map, print-tinted sheen, and the sun through it. With `wave`, the vertex
   * shader bends it (hall flags); without, a ClothSim writes the positions.
   */
  private fabricMaterial(map: THREE.Texture, uniforms: BacklightUniforms, wave?: WaveUniforms) {
    const normal = clothNormalMap();
    normal.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const mat = new THREE.MeshPhysicalMaterial({
      // Sheen tinted by the print (sheenColorMap): a white sheen read as milky glare on dark and blue cloth.
      map, side: THREE.DoubleSide, roughness: 0.94, metalness: 0, specularIntensity: 0.05, envMapIntensity: 0.5,
      sheen: 0.35, sheenColor: new THREE.Color(0xffffff), sheenColorMap: map, sheenRoughness: 0.9,
      normalMap: normal, normalScale: new THREE.Vector2(0.9, 0.9),
    });
    mat.normalMap!.repeat.set(...CLOTH_NORMAL_REPEAT);
    // applyWave sets onBeforeCompile outright, so it goes first; the others chain onto it.
    if (wave) applyWave(mat, wave, false, true);
    return applyBacklight(mat, uniforms);
  }

  // ---------- Hall flags ----------

  /**
   * Builds a crag, a pole and a waving cloth for each new slot. Slots stay built
   * once made: when the list shrinks, the extra ones only hide (refreshFlags).
   */
  private buildHall() {
    for (let i = this.flags.length; i < this.hallLayout.length; i++) {
      const p = this.hallLayout[i];
      // Crags vary a little in size and height, as real rock does.
      const k = 0.5 + 0.5 * Math.sin(phaseOf(i) * 3.1);
      const stand = this.standPole(p.x, p.z, POLE_H, HALL_POLE_R, HALL_ROCK.radius * (0.85 + 0.3 * k), HALL_ROCK.top - 0.25 * k, 11 + i, FLAG_H - 0.05);
      stand.userData.base = { x: p.x, z: p.z };
      this.hall.add(stand);
      this.stands.push(stand);
      const f = this.makeFlag(i);
      f.mesh.userData.index = i;
      this.hall.add(f.mesh);
      this.flags.push(f);
    }
  }

  /** Paints slot i: the startup on it (its logo once loaded), or the empty pole's own design. */
  private paintFlag(i: number) {
    const f = this.flags[i];
    if (!f) return;
    const st = i < this.poled ? this.list[i] : null;
    const logo = st ? this.logoFor(i) : null;
    const key = st ? `${st.id}:${st.bgColor}:${logo ? "logo" : "color"}` : "empty";
    if (f.painted === key) return;
    const weave = clothFinish(f.canvas.width, f.canvas.height);
    if (st) drawStartupFlag(f.canvas, { logo, bg: st.bgColor, weave });
    else drawPlaceholderFlag(f.canvas, weave);
    f.texture.needsUpdate = true;
    f.painted = key;
  }

  private placeFlag(i: number) {
    const f = this.flags[i], p = this.slots[i];
    if (!f || !p) return;
    const s = p.s ?? 1;
    f.mesh.scale.setScalar(s);
    f.mesh.position.set(p.x + s * (HALL_POLE_R + 0.02), ROW_PIVOT + s * (POLE_H - 0.2 - ROW_PIVOT) - this.riseDrop(i), p.z);
  }

  /**
   * Moves stand i (built at its hall seat) to its slot, scaled around ROW_PIVOT. In the row view the crag is
   * also squashed below its top: the long row crosses cloud troughs, and a full crag shows there as a wall.
   */
  private placeStand(i: number) {
    const st = this.stands[i], p = this.slots[i];
    if (!st || !p) return;
    const s = p.s ?? 1, b = st.userData.base as { x: number; z: number };
    st.scale.setScalar(s);
    st.position.set(p.x - s * b.x, ROW_PIVOT - s * ROW_PIVOT, p.z - s * b.z);
    const island = st.children[0], k = this.layout === "row" ? ROW_CRAG_DEPTH : 1;
    island.scale.y = k;
    island.position.y = ROW_PIVOT * (1 - k);
  }

  /** The visitor's own flag covers the claimed slot's cloth. */
  private refreshFlags() {
    const n = this.slots.length, on = (i: number) => i < n && !this.slots[i].hidden;
    this.stands.forEach((s, i) => (s.visible = on(i)));
    this.flags.forEach((f, i) => (f.mesh.visible = on(i) && !(this.claim && this.claim.slot === i)));
  }

  /** Eases the hovered flag in (a faint warm glow) and the previous one back out. */
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
    if (!this.hoverFade.size) return;
    const k = 1 - Math.exp(-EASE_HOVER * dt);
    for (const [i, v] of this.hoverFade) {
      const goal = i === this.hovered ? 1 : 0;
      const nv = Math.abs(goal - v) < 0.002 ? goal : v + (goal - v) * k;
      if (nv === 0) this.hoverFade.delete(i);
      else this.hoverFade.set(i, nv);
    }
  }

  /** How far below its top position flag i is, while it rises. */
  private riseDrop(i: number) {
    const t0 = this.rising.get(i);
    if (t0 === undefined) return 0;
    const k = Math.min(1, (this.time - t0) / 4);
    const ease = 1 - Math.pow(1 - k, 3);
    return (POLE_H + 1) * (1 - ease);
  }

  /** Repaints hall flags whose logo has loaded since. Runs 4 times a second. */
  private updateLod() {
    for (let i = 0; i < this.flags.length; i++) this.paintFlag(i);
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

  /** A GPU-waved flag of light bunting with its own canvas texture. The caller adds it to the scene. */
  private makeFlag(slot: number): HallFlag {
    const canvas = createCanvas(768, 496);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    const uniforms = this.backlight();
    uniforms.uBacklight.value = HALL_BACKLIGHT;
    uniforms.uTransmit.value = HALL_TRANSMIT;
    // Shared clock and wind, own size and phase: each flag on its own beat, all moved by one uniform write.
    const wave: WaveUniforms = {
      uTime: this.hallTime, uWind: this.hallWindK, uSize: { value: new THREE.Vector2(FLAG_W, FLAG_H) }, uPhase: { value: phaseOf(slot) },
    };
    const material = this.fabricMaterial(texture, uniforms, wave);
    applyRim(material, { uRimColor: { value: this.sunColor.clone().multiplyScalar(HALL_RIM) } });
    const [sx, sy] = TIERS[this.tier].cloth;
    const geo = flagGeometry(FLAG_W, FLAG_H, sx, sy);
    // The shader moves the cloth off the flat plane: a sphere around its whole reach keeps culling and
    // picking from missing its fly end.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(FLAG_W / 2, -FLAG_H / 2, 0), FLAG_W);
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    const depth = applyWave(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), wave, false, true);
    mesh.customDepthMaterial = depth;
    return { mesh, geo, material, depth, texture, canvas, uniforms, painted: "" };
  }

  private backlight(): BacklightUniforms {
    return {
      uSunDir: { value: this.sunDir }, uSunColor: { value: this.sunColor }, uBacklight: { value: BACKLIGHT }, uGlow: { value: 0 },
      uTransmit: { value: 0.35 },
    };
  }

  // ---------- Quality ----------

  private applyTier(tier: Tier) {
    this.tier = tier;
    const t = TIERS[tier];
    this.clouds.setSteps(t.steps);
    this.sunLight.castShadow = t.shadows && this.renderer.shadowMap.enabled;
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
      this.setFx({ ...this.fx, ao: false, godRays: false, hd: false, cinema: false });
      this.events.onFx?.(this.fx);
    }
  }

  // ---------- Loop and camera ----------

  /**
   * Cinema mode's autofocus, like a camera operator pulling focus. The subject: the showcase pair, else
   * the flag under the mouse, else the hall's flags from the nearest one back to the Argentine flag (checked
   * five times a second). The focus eases to it over about half a second.
   */
  private updateFocus(dt: number) {
    if (!this.fx.cinema) return;
    const cam = this.camera.position;
    if (this.showing >= 0) {
      this.focusGoal.copy(this.showcaseView(this.camera.aspect).look);
      this.focusRangeGoal = cam.distanceTo(this.focusGoal) * STILL_FOCUS_RANGE;
    } else if (this.hovered >= 0 && this.flags[this.hovered]?.mesh.visible) {
      this.flags[this.hovered].mesh.getWorldPosition(this.focusGoal);
      this.focusRangeGoal = cam.distanceTo(this.focusGoal) * STILL_FOCUS_RANGE;
    } else if (--this.focusTick <= 0) {
      this.focusTick = 12;
      // The hall: the startups are the subject, not the hero behind them. Focus on the nearest flag in view
      // and keep everything from it back to the Argentine flag sharp; only the sky, the far clouds and the
      // rocks right in front of the lens go soft. (Focusing on the middle of the view picked the hero, and
      // left every startup flag blurred.)
      let near: THREE.Vector3 | null = null, nd = Infinity;
      if (this.hall.visible) {
        for (const f of this.flags) {
          if (!f.mesh.visible) continue;
          f.mesh.getWorldPosition(FOCUS_P);
          const d = cam.distanceTo(FOCUS_P);
          FOCUS_NDC.copy(FOCUS_P).project(this.camera);
          if (FOCUS_NDC.z < 1 && Math.abs(FOCUS_NDC.x) < 1 && Math.abs(FOCUS_NDC.y) < 1 && d < nd) {
            nd = d;
            near = (near ?? new THREE.Vector3()).copy(FOCUS_P);
          }
        }
      }
      const da = cam.distanceTo(ARG_CENTER);
      if (near) {
        this.focusGoal.copy(near).lerp(ARG_CENTER, 0.35);
        this.focusRangeGoal = Math.max(nd * STILL_FOCUS_RANGE, (da - nd) * 1.6);
      } else {
        this.focusGoal.copy(cam).addScaledVector(this.camera.getWorldDirection(FOCUS_DIR), da);
        this.focusRangeGoal = da * STILL_FOCUS_RANGE;
      }
    }
    const k = 1 - Math.exp(-5 * dt);
    this.liveFocus.target.lerp(this.focusGoal, k);
    this.liveFocus.range += (this.focusRangeGoal - this.liveFocus.range) * k;
    // Bokeh is in pixels: scale the wallpaper's 16 at 2160 rows to this canvas, then soften it for live view.
    this.liveFocus.bokeh = (STILL_BOKEH * LIVE_BOKEH_SCALE * this.renderer.domElement.height) / 2160;
  }

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

    const speed = 10 * dt;
    if (this.keys.has("ArrowUp") || this.keys.has("w")) this.walk(speed);
    if (this.keys.has("ArrowDown") || this.keys.has("s")) this.walk(-speed);
    // Left and right arrows step from flag to flag (SalonApp); A and D turn the view.
    if (this.layout === "row" && this.showing < 0) {
      if (this.keys.has("a")) this.slide(-speed * this.scaleAt(this.goalPos.x));
      if (this.keys.has("d")) this.slide(speed * this.scaleAt(this.goalPos.x));
    } else {
      if (this.keys.has("a")) this.turn(1.2 * dt, 0);
      if (this.keys.has("d")) this.turn(-1.2 * dt, 0);
    }

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
    } else if (!this.flight && this.layout === "row") {
      if (this.rowPan) {
        this.goalPos.x += ROW_PAN * this.scaleAt(this.goalPos.x) * dt;
        if (this.goalPos.x >= this.rowEnd()) this.rowPan = false;
        this.clampPos();
      }
      this.pos.lerp(this.goalPos, 1 - Math.exp(-EASE_MOVE * dt));
      this.aimRow();
    } else if (!this.flight) {
      // Frame-rate independent ease toward the goals.
      this.pos.lerp(this.goalPos, 1 - Math.exp(-EASE_MOVE * dt));
      this.clampLook(); // walking changes the angles to the flags
      const look = 1 - Math.exp(-EASE_LOOK * dt);
      this.yaw += (this.goalYaw - this.yaw) * look;
      this.pitch += (this.goalPitch - this.pitch) * look;
    }

    if (this.layout === "row" && this.showing < 0) this.aimSun(SUN_P.set(this.pos.x, 2, ROW_Z));
    this.updateInset(dt);
    this.updateClaim(dt);
    this.camera.position.copy(this.pos); // the camera moves only with input, flights, and the intro
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.updateMatrixWorld();
    this.sky.update(this.time, this.camera);
    this.clouds.update(this.time, this.camera);
    this.motes.update(this.time);
    this.birds.update(this.time);
    if (this.argCloth && this.argGeo) this.argCloth.update(dt, this.argGeo);
    if (this.showing >= 0 && this.show?.cloth) this.show.cloth.update(dt, this.show.geo);
    if (this.show && this.show.fadeT < 1) {
      const t = (this.show.fadeT = Math.min(1, this.show.fadeT + dt / SWAP_S));
      this.show.fade.uFade.value = t * t * (3 - 2 * t);
    }

    this.hallTime.value = this.time;

    // Rising flags and highlight pulse.
    for (const [i, t0] of this.rising) {
      this.placeFlag(i);
      if (this.time - t0 > 4) this.rising.delete(i);
    }
    const pulse = 0.35 + 0.25 * Math.sin(this.time * 3.2);
    this.flags.forEach((f, i) => {
      // The highlight pulse wins, else the hover glow.
      f.uniforms.uGlow.value = this.highlight.has(i) ? pulse : (this.hoverFade.get(i) ?? 0) * HOVER_GLOW;
    });
    this.updateHover(dt);

    this.lodTimer -= dt;
    if (this.lodTimer <= 0) {
      this.updateLod();
      if (this.showing >= 0 && this.show?.painted !== "logo" && this.logoFor(this.showing)) this.paintShowcase();
      this.lodTimer = 0.25;
    }
    this.updateFocus(dt);
    this.post.render(dt);
    // Fade in once real frames are on screen: the first ones compile shaders and can stall.
    if (++this.frames === 3) {
      this.renderer.domElement.style.opacity = "1";
      this.events.onReady?.();
    }
  };

  private clampPos() {
    if (this.layout === "row") {
      const c = this.rowCenters, g = this.goalPos;
      if (!c.length) return;
      g.x = THREE.MathUtils.clamp(g.x, c[0].x, c[c.length - 1].x);
      const v = this.rowView(g.x);
      g.y = v.pos.y;
      g.z = v.pos.z;
      return;
    }
    const rows = Math.ceil(this.slots.length / (this.cols * 2));
    const end = rowZ(Math.max(rows, 1)); // one step behind the last row
    const w = CORRIDOR + this.cols * DX;
    const g = this.goalPos;
    g.x = Math.max(-w, Math.min(w, g.x));
    g.z = Math.max(end, Math.min(START.z + 8, g.z));
    g.y = THREE.MathUtils.clamp(g.y, EYE_MIN, EYE_MAX);
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
    const targets: THREE.Object3D[] = this.hall.visible ? this.flags.filter((f) => f.mesh.visible).map((f) => f.mesh) : [];
    if (this.claim?.flag.mesh.visible) {
      this.claim.flag.mesh.userData.index = this.claim.slot;
      targets.push(this.claim.flag.mesh);
    }
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit) return null;
    const index = hit.object.userData.index as number;
    if (index < 0) return null;
    return { kind: index < this.poled ? "startup" : "placeholder", index };
  }

  private bindInput(canvas: HTMLCanvasElement) {
    // The middle button would start the browser's autoscroll.
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    canvas.addEventListener("pointerdown", (e) => {
      // The right button opens the context menu, which swallows the pointerup and leaves a drag stuck on.
      if (e.pointerType === "mouse" && e.button > 1) return;
      canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, lift: e.pointerType === "mouse" && e.button === 1 });
      this.moved = false;
      this.pinch = 0;
    });
    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse") this.hoverAt = { clientX: e.clientX, clientY: e.clientY }; // picked in the loop, once per frame
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      // A mouse with no button down is no drag, whatever release went missing.
      if (e.pointerType === "mouse" && e.buttons === 0) return end(e);
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
      if (p.lift) {
        // Middle drag: up raises the eye, down lowers it. The showcase orbit has its own height.
        canvas.style.cursor = "ns-resize";
        if (this.showing >= 0 || this.layout === "row") return;
        this.goalPos.y -= dy * LIFT_PER_PX;
        this.clampPos();
        return;
      }
      canvas.style.cursor = "grabbing";
      // The row view: drag slides along the row.
      if (this.layout === "row" && this.showing < 0) {
        this.pan(-dx);
        return;
      }
      // Drag to look around.
      this.turn(dx * 0.0026, dy * 0.0022);
    });
    const end = (e: PointerEvent) => {
      const lift = this.pointers.get(e.pointerId)?.lift;
      const had = this.pointers.delete(e.pointerId) && !lift; // a middle click picks nothing
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
      // The row view also takes sideways scrolls (trackpads, shift + wheel).
      const d = this.layout === "row" && Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this.walk(-THREE.MathUtils.clamp(d, -120, 120) * 0.025);
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
