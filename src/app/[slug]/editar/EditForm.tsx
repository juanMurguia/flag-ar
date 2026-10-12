"use client";

import { useEffect, useState } from "react";
import { ACCEPT, prepareUpload, type PreparedLogo } from "@/lib/flag/logoUpload";
import { CATEGORIES } from "@/lib/startups/model";

let captured: string | null = null;

interface Current {
  slug: string;
  name: string;
  category: string | null;
  bgColor: string;
  logoUrl: string | null;
}

/** Magic-link edit form. One edit per link: the server bumps the version on save. */
export default function EditForm({ slug }: { slug: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [cur, setCur] = useState<Current | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [bg, setBg] = useState("#ffffff");
  const [logo, setLogo] = useState<PreparedLogo | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // Kept in module scope: dev Strict Mode runs this effect twice, and the hash is gone the second time.
    const t = captured ?? new URLSearchParams(location.hash.slice(1)).get("t");
    captured = t;
    // Drop the token from the address bar and history.
    history.replaceState(null, "", location.pathname);
    if (!t) {
      setMsg("Falta el link mágico. Pedilo desde la página de tu bandera.");
      return;
    }
    setToken(t);
    fetch("/api/startups/edit", { headers: { "x-edit-token": t } })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.message);
        setCur(body);
        setName(body.name);
        setCategory(body.category ?? "");
        setBg(body.bgColor);
      })
      .catch((e: Error) => setMsg(e.message || "El link venció o ya se usó."));
  }, []);

  async function pick(f: File | undefined) {
    if (!f) return;
    setStage("Procesando…");
    try {
      setLogo(await prepareUpload(f, true, setStage));
    } catch {
      setMsg("No pudimos leer esa imagen.");
    } finally {
      setStage(null);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    const form = new FormData();
    form.set("token", token);
    form.set("name", name);
    form.set("category", category);
    form.set("bg", bg);
    if (logo) form.set("logo", logo.png, "logo.png");
    const res = await fetch("/api/startups/edit", { method: "POST", body: form }).catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as { message?: string } | undefined;
    setMsg(body?.message ?? "Error de red.");
    setBusy(false);
    if (res?.ok) setDone(true);
  }

  return (
    <main className="page-narrow">
      <h1>Editar bandera</h1>
      {msg && <p role="status" className={done ? "" : "error"}>{msg}</p>}
      {done && <a className="btn primary" href={`/${slug}`}>Ver mi bandera</a>}
      {cur && !done && (
        <form onSubmit={save} className="panel-form">
          <div className="drop-preview big" style={{ background: bg }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {(logo || cur.logoUrl) && <img src={logo ? logo.logo.toDataURL() : cur.logoUrl!} alt="Logo" />}
          </div>
          <label className="field">
            <span>Logo nuevo (opcional; vuelve a revisión)</span>
            <input type="file" accept={ACCEPT} onChange={(e) => pick(e.target.files?.[0])} />
          </label>
          {stage && <p className="muted small">{stage}</p>}
          <label className="field">
            <span>Nombre</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
          </label>
          <label className="field">
            <span>¿A qué se dedica?</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)} required>
              <option value="" disabled>Elegí una categoría</option>
              {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          <label className="field color">
            <span>Color de la bandera</span>
            <input type="color" value={bg} onChange={(e) => setBg(e.target.value)} />
          </label>
          <button className="btn primary wide" disabled={busy || !!stage}>Guardar</button>
        </form>
      )}
    </main>
  );
}
