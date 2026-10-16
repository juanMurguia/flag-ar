"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import HoistPanel from "./HoistPanel";
import Toolbar, { usePause } from "./Toolbar";
import { useDockInset, usePairScene } from "./usePairScene";
import Icon from "./Icon";

/** /izar: the Argentine flag and a second pole that previews yours while the hoist panel fills in. */
export default function FlagApp() {
  const holder = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const togglePauseRef = useRef<() => void>(() => {});
  const { scene, webgl } = usePairScene(holder, () => togglePauseRef.current());
  const { paused, togglePause } = usePause(scene);
  togglePauseRef.current = togglePause;
  // Every "+" in the site leads here, so the form opens at once. "+" in the dock reopens it after closing.
  // "closing" keeps the sheet mounted while it slides out along its entry path.
  const [panel, setPanel] = useState<"open" | "closing" | "closed">("open");
  const panelOpen = panel !== "closed";
  useDockInset(dock, scene, !!webgl, panelOpen);
  // Keyboard closes (Escape) skip the exit animation: they repeat often and must feel instant.
  const close = useCallback((instant?: boolean) => setPanel(instant ? "closed" : "closing"), []);
  const closed = useCallback(() => setPanel((p) => (p === "closing" ? "closed" : p)), []);
  // Approved flags, so the sheet knows when the hall is full. /izar is static, so it asks the CDN-cached hall endpoint.
  const [taken, setTaken] = useState<number | null>(null);
  useEffect(() => {
    fetch("/api/salon").then((r) => (r.ok ? r.json() : null)).then((d) => typeof d?.count === "number" && setTaken(d.count))
      .catch(() => {});
  }, []);

  return (
    <main className={`stage${panelOpen ? " with-sheet" : ""}`}>
      <h1 className="sr-only">flag.ar: izá la bandera de tu startup al lado de la argentina</h1>
      <div ref={holder} className="flag-holder" />
      {webgl === false && (
        <div className="still">
          <p className="still-note">Tu navegador no puede mostrar la escena 3D.</p>
        </div>
      )}

      <Link className="corner-link" href="/" aria-label="Salón de la Fama" title="Salón de la Fama">
        <Icon name="hall" size={15} />
      </Link>

      <div className="dock" ref={dock}>
        <Toolbar scene={scene} webgl={webgl} paused={paused} togglePause={togglePause} fileName="flag-ar.png">
          <button
            className="btn ghost icon" onClick={() => setPanel("open")}
            aria-label="Izar mi bandera" title="Izar mi bandera" aria-expanded={panel === "open"}
          >
            <Icon name="plus" />
          </button>
        </Toolbar>
      </div>

      {panelOpen && (
        <HoistPanel scene={scene} webgl={webgl} taken={taken} closing={panel === "closing"} onClose={close} onClosed={closed} />
      )}
    </main>
  );
}
