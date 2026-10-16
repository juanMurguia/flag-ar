"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { LogoImage } from "@/lib/flag/texture";
import { ACCEPT, lookupLogo, prepareUpload, type PreparedLogo } from "@/lib/flag/logoUpload";
import { CATEGORIES, SALON_SEATS } from "@/lib/startups/model";
import { toast } from "./Toast";
import Icon from "./Icon";

type Phase = "form" | "sending" | "hoisting";

/** What the sheet drives: the two-pole scene on /izar, or the Hall of Fame when hoisting in place. */
export interface HoistStage {
  setStartup(logo: LogoImage | null, bg: string, name?: string): void;
  hoistTo(target: number, seconds?: number): Promise<void>;
  setInsetRight(px: number): void;
  setInsetBottom(px: number): void;
}

/**
 * "Izar mi bandera": side panel (bottom sheet on phones). A pole shows a live preview while
 * the form fills in. No sign-in: the server limits by IP. Later changes go through a change request
 * that an admin approves. After the hoist, a toast says we review the flag and the visitor lands on the
 * Hall of Fame.
 */
export default function HoistPanel({
  scene, webgl, taken = null, closing = false, onClose, onClosed,
}: {
  scene: RefObject<HoistStage | null>;
  webgl: boolean | null;
  /** Approved flags (seats taken). Null while unknown. */
  taken?: number | null;
  closing?: boolean;
  /** `instant` skips the exit animation (keyboard close). */
  onClose: (instant?: boolean) => void;
  /** Called when the exit animation ends, so the parent can unmount the panel. */
  onClosed?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const openedAt = useRef(Date.now());
  const panel = useRef<HTMLElement>(null);
  const [file, setFile] = useState<File | null>(null);
  // True when `file` came from the link lookup, not from the visitor. A picked file always wins.
  const [autoFile, setAutoFile] = useState(false);
  const [removeBg, setRemoveBg] = useState(true);
  const [prepared, setPrepared] = useState<PreparedLogo | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [link, setLink] = useState("");
  const [bg, setBg] = useState("#ffffff");
  const [bgTouched, setBgTouched] = useState(false);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("form");
  const previewUrl = useMemo(() => prepared?.logo.toDataURL() ?? null, [prepared]);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("input, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Unmount after the exit animation. The timer covers browsers where animationend never fires.
  useEffect(() => {
    if (!closing || !onClosed) return;
    const t = setTimeout(onClosed, 400);
    return () => clearTimeout(t);
  }, [closing, onClosed]);

  // Keep the flags in the free space beside the panel (wide screens) or above it (phones: bottom sheet).
  // The scene runs full size under the panel, so the glass blurs the sky.
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const phone = window.matchMedia("(max-width: 767px)");
    const update = () => {
      // offsetLeft/offsetHeight ignore the slide-in transform, so the first value is already final.
      if (phone.matches) {
        scene.current?.setInsetRight(0);
        scene.current?.setInsetBottom(el.offsetHeight + 8);
      } else {
        scene.current?.setInsetRight(window.innerWidth - el.offsetLeft);
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      scene.current?.setInsetRight(0);
    };
  }, [scene, webgl]);

  // Logo processing: runs again when the file or the background switch changes.
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setStage("Leyendo el logo…");
    setError(null);
    prepareUpload(file, removeBg, (s) => !cancelled && setStage(s))
      .then((p) => {
        if (cancelled) return;
        setPrepared(p);
        if (!bgTouched) setBg(p.bg);
      })
      .catch(() => {
        if (cancelled) return;
        // A found logo that does not decode is dropped silently: the visitor uploads one.
        if (autoFile) {
          setFile(null);
          setPrepared(null);
        } else setError("No pudimos leer esa imagen. Probá con otro archivo.");
      })
      .finally(() => !cancelled && setStage(null));
    return () => {
      cancelled = true;
    };
    // bgTouched is read once per file on purpose: a later color pick must not re-run the model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, removeBg]);

  // Logo from the link: once the link stops changing, look up the X avatar or the site icon.
  // Silent: a miss leaves the drop zone empty. Never replaces a file the visitor picked.
  useEffect(() => {
    if (file && !autoFile) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      const found = await lookupLogo(link, ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (found) {
        setAutoFile(true);
        setFile(found);
      } else if (autoFile) {
        // The link changed and the new one has no logo: the old one belongs to another startup.
        setFile(null);
        setPrepared(null);
      }
    }, 700);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // Runs on link changes only. A picked file stops it through the early return.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);

  // Live preview on the second pole, at the top from the first moment: a plain flag in the chosen color,
  // then the logo once it is ready. "Izar" lowers it and runs the 2 s hoist.
  useEffect(() => {
    const s = scene.current;
    if (!s || phase !== "form") return;
    s.setStartup(prepared?.logo ?? null, bg, name || undefined);
    s.hoistTo(1, 0.8);
  }, [scene, webgl, prepared, bg, name, phase]);

  // Closing takes the flag down: it is not in the hall until an admin approves it.
  useEffect(() => () => {
    scene.current?.hoistTo(0, 0.6);
  }, [scene]);

  function pick(f: File | null | undefined) {
    if (!f) return;
    if (!ACCEPT.split(",").includes(f.type)) {
      setError("Usá un PNG, JPG o SVG.");
      return;
    }
    if (f.size > 8 * 1024 * 1024) {
      setError("El archivo es muy grande (máximo 8 MB).");
      return;
    }
    setAutoFile(false);
    setFile(f);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!prepared) return;
    const honeypot = (e.currentTarget.elements.namedItem("company") as HTMLInputElement | null)?.value ?? "";
    setError(null);
    setPhase("sending");
    try {
      const form = new FormData();
      form.set("logo", prepared.png, "logo.png");
      form.set("name", name.trim());
      form.set("category", category);
      form.set("link", link.trim());
      form.set("bg", bg);
      // Consent is the notice above the submit button: hoisting means accepting it.
      form.set("rights", "1");
      form.set("company", honeypot);
      form.set("elapsed", String(Date.now() - openedAt.current));
      const res = await fetch("/api/startups", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { message?: string; slug?: string };
      if (!res.ok || !body.slug) {
        setError(body.message || "No pudimos izar la bandera. Probá más tarde.");
        setPhase("form");
        return;
      }
      setPhase("hoisting");
      const s = scene.current;
      if (s) {
        await s.hoistTo(0, 0.5);
        await s.hoistTo(1, 2);
      }
      toast(taken !== null && taken >= SALON_SEATS
        ? "¡Listo! Recibimos tu bandera. El Salón está completo: queda en lista de espera hasta que se libere un lugar."
        : "¡Listo! Recibimos tu bandera. La vamos a revisar y, cuando la aprobemos, aparece en el Salón de la Fama.");
      if (pathname === "/") onClose();
      else router.push("/");
    } catch {
      setError("Error de red. Revisá la conexión y probá de nuevo.");
      setPhase("form");
    }
  }

  const sending = phase !== "form";
  const ready = !!prepared && !stage && name.trim() && category && link.trim();

  return (
    <aside
      ref={panel} className="sheet" aria-labelledby="hoist-title" role="dialog" aria-modal="false"
      data-state={closing ? "closing" : "open"}
      onAnimationEnd={(e) => { if (closing && e.target === e.currentTarget) onClosed?.(); }}
    >
      <button className="card-close" onClick={() => onClose()} aria-label="Cerrar" title="Cerrar"><Icon name="close" /></button>
      <h2 id="hoist-title">Izá tu bandera</h2>
      <form onSubmit={submit}>
        <label
          className={`drop${drag ? " over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0]); }}
        >
          {prepared ? (
            <span className="drop-preview" style={{ background: bg }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl ?? ""} alt="Vista previa del logo" />
            </span>
          ) : (
            <span className="swap" key={stage ?? "idle"}>
              {stage && <span className="spinner" aria-hidden="true" />}
              {stage ?? "Arrastrá tu logo o elegí un archivo (PNG, JPG o SVG)"}
            </span>
          )}
          <input type="file" accept={ACCEPT} className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
        </label>
        {stage && prepared && <p className="muted small" role="status">{stage}</p>}
        {file && (
          <label className="check">
            <input type="checkbox" checked={removeBg} onChange={(e) => setRemoveBg(e.target.checked)} />
            Quitar el fondo del logo
          </label>
        )}
        <label className="field">
          <span>Nombre de la startup</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoComplete="organization" />
        </label>
        <label className="field">
          <span>¿A qué se dedica?</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} required>
            <option value="" disabled>Elegí una categoría</option>
            {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Link (web o X)</span>
          <input
            type="text" inputMode="url" placeholder="tustartup.com o x.com/tustartup" value={link}
            onChange={(e) => setLink(e.target.value)} required maxLength={2048}
          />
        </label>
        <label className="field color">
          <span>Color de la bandera</span>
          <input type="color" value={bg} onChange={(e) => { setBg(e.target.value); setBgTouched(true); }} />
          <button type="button" className="btn ghost small-btn" onClick={() => { setBg("#ffffff"); setBgTouched(true); }}>Blanco</button>
          {prepared && (
            <button type="button" className="btn ghost small-btn" onClick={() => { setBg(prepared.bg); setBgTouched(false); }}>Automático</button>
          )}
        </label>
        {/* Honeypot: people never see or fill this. */}
        <input type="text" name="company" tabIndex={-1} autoComplete="off" className="hp" aria-hidden="true" />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary wide" type="submit" disabled={!ready || sending}>
          <span className="swap" key={phase}>
            {sending && <span className="spinner" aria-hidden="true" />}
            {phase === "sending" ? "Enviando…" : phase === "hoisting" ? "Izando…" : "Izar mi bandera"}
          </span>
        </button>
        <p className="consent">Al izarla, confirmás que podés usar este logo.</p>
      </form>
    </aside>
  );
}
