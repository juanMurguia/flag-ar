"use client";

import { useState } from "react";
import { ACCEPT, prepareUpload, type PreparedLogo } from "@/lib/flag/logoUpload";
import { CATEGORIES } from "@/lib/startups/model";

interface Current {
  slug: string;
  name: string;
  category: string | null;
  bgColor: string;
  logoUrl: string | null;
}

/** Change request form. Sends the flag as the founder wants it; an admin applies it or not. */
export default function EditForm({ current: cur }: { current: Current }) {
  const [name, setName] = useState(cur.name);
  const [category, setCategory] = useState(cur.category ?? "");
  const [bg, setBg] = useState(cur.bgColor);
  const [note, setNote] = useState("");
  const [logo, setLogo] = useState<PreparedLogo | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

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

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const form = new FormData();
    form.set("slug", cur.slug);
    form.set("name", name);
    form.set("category", category);
    form.set("bg", bg);
    form.set("note", note);
    if (logo) form.set("logo", logo.png, "logo.png");
    const res = await fetch("/api/startups/edit", { method: "POST", body: form }).catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as { message?: string } | undefined;
    setMsg(body?.message ?? "Error de red.");
    setBusy(false);
    if (res?.ok) setDone(true);
  }

  return (
    <main className="page-narrow">
      <h1>Pedir un cambio</h1>
      <p className="muted">Dejá la bandera como la querés. La revisamos y, si está bien, la actualizamos.</p>
      {msg && <p role="status" className={done ? "" : "error"}>{msg}</p>}
      {done && <a className="btn primary" href={`/${cur.slug}`}>Volver a la bandera</a>}
      {!done && (
        <form onSubmit={send} className="panel-form">
          <div className="drop-preview big" style={{ background: bg }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {(logo || cur.logoUrl) && <img src={logo ? logo.logo.toDataURL() : cur.logoUrl!} alt="Logo" />}
          </div>
          <label className="field">
            <span>Logo nuevo (opcional)</span>
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
          <label className="field">
            <span>¿Algo más que tengamos que saber? (opcional)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </label>
          <button className="btn primary wide" disabled={busy || !!stage}>Enviar pedido</button>
        </form>
      )}
    </main>
  );
}
