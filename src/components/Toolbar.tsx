"use client";

import { useState, type ReactNode, type RefObject } from "react";
import type { PairScene } from "@/lib/flag/scene";
import { saveBlob } from "@/lib/flag/downloads";
import Icon from "./Icon";

export interface ToolbarState {
  paused: boolean;
  togglePause: () => void;
}

/** Pause and wind state, shared by the toolbar and the Space key on the canvas. */
export function usePause(scene: RefObject<PairScene | null>): ToolbarState & { setPaused: (p: boolean) => void } {
  const [paused, setPaused] = useState(false);
  const togglePause = () => {
    const s = scene.current;
    if (!s) return;
    if (s.paused) s.play();
    else s.pause();
    setPaused(s.paused);
  };
  return { paused, togglePause, setPaused };
}

/** Floating bar: pause (with a frame slider while paused), screenshot, and extras. */
export default function Toolbar({
  scene, webgl, paused, togglePause, fileName, children,
}: {
  scene: RefObject<PairScene | null>;
  webgl: boolean | null;
  paused: boolean;
  togglePause: () => void;
  fileName: string;
  children?: ReactNode;
}) {
  const [frame, setFrame] = useState(1);
  const [busy, setBusy] = useState(false);

  async function capture() {
    if (!scene.current) return;
    setBusy(true);
    try {
      saveBlob(await scene.current.capture(), fileName);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="toolbar">
      {webgl && (
        <button
          className="btn ghost icon" onClick={() => { togglePause(); setFrame(1); }} aria-pressed={paused}
          aria-label={paused ? "Reanudar viento" : "Pausar viento"} title={paused ? "Reanudar (Espacio)" : "Pausar (Espacio)"}
        >
          <span className="glyph" key={paused ? "play" : "pause"}><Icon name={paused ? "play" : "pause"} /></span>
        </button>
      )}
      {webgl && paused && (
        <label className="slider" title="Elegí un cuadro">
          <Icon name="frames" size={15} />
          <input
            type="range" min={0} max={1} step={0.005} value={frame} aria-label="Cuadro"
            onChange={(e) => {
              const f = Number(e.target.value);
              setFrame(f);
              scene.current?.scrub(f);
            }}
          />
        </label>
      )}
      {webgl && (
        <button
          className="btn ghost icon" onClick={capture} disabled={busy} aria-busy={busy}
          aria-label="Descargar captura" title="Descargar captura"
        >
          {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="camera" />}
        </button>
      )}
      {children}
    </div>
  );
}
