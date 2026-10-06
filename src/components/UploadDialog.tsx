"use client";

import { useEffect, useRef, useState } from "react";
import HCaptcha from "./HCaptcha";
import Icon from "./Icon";

const MAX_SIDE = 512;
const MAX_BYTES = 512 * 1024;

/** Turns any image (PNG, JPG, WebP, SVG) into a PNG of at most 512 px. */
async function toPng(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    // An SVG without a size reports 0; give it a square box.
    const w0 = img.naturalWidth || MAX_SIDE;
    const h0 = img.naturalHeight || MAX_SIDE;
    let side = MAX_SIDE;
    for (let attempt = 0; attempt < 4; attempt++) {
      const k = Math.min(1, side / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * k));
      const h = Math.max(1, Math.round(h0 * k));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d")!.drawImage(img, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
      if (!blob) throw new Error("convert");
      if (blob.size <= MAX_BYTES) return blob;
      side = Math.round(side * 0.75);
    }
    throw new Error("too big");
  } finally {
    URL.revokeObjectURL(url);
  }
}

type State = { kind: "idle" } | { kind: "sending" } | { kind: "done" } | { kind: "error"; message: string };

export default function UploadDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const openedAt = useRef(Date.now());
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [drag, setDrag] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    const d = dialog.current;
    d?.showModal();
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    d?.addEventListener("cancel", onCancel);
    return () => d?.removeEventListener("cancel", onCancel);
  }, [onClose]);

  useEffect(() => {
    if (!file) return setPreview(null);
    const u = URL.createObjectURL(file);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  function pick(f: File | undefined | null) {
    if (!f) return;
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(f.type)) {
      setState({ kind: "error", message: "Use a PNG, JPG, WebP, or SVG file." });
      return;
    }
    setState({ kind: "idle" });
    setFile(f);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file || !link.trim()) return;
    if (!token) {
      setState({ kind: "error", message: "Complete the check first." });
      return;
    }
    setState({ kind: "sending" });
    try {
      const png = await toPng(file);
      const form = new FormData();
      form.set("logo", png, "logo.png");
      form.set("link", link.trim());
      form.set("captcha", token);
      form.set("company", (e.currentTarget.elements.namedItem("company") as HTMLInputElement).value);
      form.set("elapsed", String(Date.now() - openedAt.current));
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (res.ok) {
        setState({ kind: "done" });
        return;
      }
      setState({ kind: "error", message: body.message || "Upload failed. Try again later." });
    } catch {
      setState({ kind: "error", message: "We could not read that image. Try another file." });
    }
    setCaptchaReset((n) => n + 1);
  }

  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="upload-title">
      <button className="card-close" onClick={onClose} aria-label="Close" title="Close"><Icon name="close" /></button>
      <h2 id="upload-title">Add your logo</h2>
      {state.kind === "done" ? (
        <div className="done" role="status">
          <p>Sent for review. We show it after approval.</p>
          <button className="btn primary" onClick={onClose}>Close</button>
        </div>
      ) : (
        <form onSubmit={submit}>
          <label
            className={`drop${drag ? " over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0]); }}
          >
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="Logo preview" />
            ) : (
              <span>Drop your logo here, or choose a file</span>
            )}
            <input
              type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="sr-only"
              onChange={(e) => pick(e.target.files?.[0])} required={!file}
            />
          </label>
          <label className="field">
            <span>Website link</span>
            <input
              type="text" inputMode="url" autoComplete="url" placeholder="yourstartup.com"
              value={link} onChange={(e) => setLink(e.target.value)} required maxLength={2048}
            />
          </label>
          {/* Honeypot: people never see or fill this. */}
          <input type="text" name="company" tabIndex={-1} autoComplete="off" className="hp" aria-hidden="true" />
          <HCaptcha onToken={setToken} resetKey={captchaReset} />
          {state.kind === "error" && <p className="error" role="alert">{state.message}</p>}
          <button className="btn primary wide" type="submit" disabled={state.kind === "sending" || !file || !link}>
            {state.kind === "sending" ? "Sending…" : "Add to flag"}
          </button>
        </form>
      )}
    </dialog>
  );
}
