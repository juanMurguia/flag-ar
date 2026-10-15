// Lucide icons (ISC). Each import is one small inline SVG: no icon font, no runtime, and CSP stays strict.
// Motion lives in globals.css ("Icon motion"): each icon plays a short CSS animation when its button is hovered or focused.
import {
  ArrowUpRight, Camera, ChevronLeft, ChevronRight, Copy, Download, Film, Heart, Pause, Play, Plus, Search, Trophy, Video, Volume2, VolumeX, X, type LucideIcon,
} from "lucide-react";

const ICONS = {
  play: Play,
  pause: Pause,
  camera: Camera,
  plus: Plus,
  close: X,
  search: Search,
  hall: Trophy,
  download: Download,
  video: Video,
  frames: Film,
  prev: ChevronLeft,
  next: ChevronRight,
  sound: Volume2,
  mute: VolumeX,
  heart: Heart,
  external: ArrowUpRight,
  copy: Copy,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export default function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  const Glyph = ICONS[name];
  return <Glyph className={`ico ico-${name}`} size={size} strokeWidth={2} aria-hidden="true" focusable="false" />;
}
