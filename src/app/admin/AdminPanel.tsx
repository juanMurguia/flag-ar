"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browserClient } from "@/lib/client/supabase";

type Status = "pending" | "approved" | "denied" | "removed";

interface Row {
  id: string;
  website_url: string;
  domain: string;
  status: Status;
  created_at: string;
  reviewed_at: string | null;
  deny_reason: string | null;
  file_path: string | null;
}

const FILES_BASE = process.env.NEXT_PUBLIC_FILES_BASE || "/files";
const FILTERS: { key: Status; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "denied", label: "Denied" },
];

function age(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

export default function AdminPanel() {
  const sb = useMemo(() => browserClient(), []);
  const [filter, setFilter] = useState<Status>("pending");
  const [rows, setRows] = useState<Row[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploadsOn, setUploadsOn] = useState<boolean | null>(null);
  const [denyOpen, setDenyOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [blockDomain, setBlockDomain] = useState(false);
  const [blockHash, setBlockHash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const selected = rows.find((r) => r.id === selectedId) ?? null;

  // Pending files are private: signed links that expire in 60 seconds.
  const sign = useCallback(async (list: Row[]) => {
    const paths = list.filter((r) => r.status === "pending" && r.file_path).map((r) => r.file_path!);
    const map: Record<string, string> = {};
    if (paths.length > 0) {
      const { data } = await sb.storage.from("logos-pending").createSignedUrls(paths, 60);
      const byPath = new Map((data ?? []).map((d) => [d.path, d.signedUrl]));
      for (const r of list) if (r.file_path && byPath.get(r.file_path)) map[r.id] = byPath.get(r.file_path)!;
    }
    for (const r of list) if (r.status === "approved") map[r.id] = `${FILES_BASE}/${r.id}.png`;
    setThumbs(map);
  }, [sb]);

  const load = useCallback(async () => {
    const { data, error } = await sb
      .from("logo_requests")
      .select("id, website_url, domain, status, created_at, reviewed_at, deny_reason, file_path")
      .eq("status", filter)
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) {
      setNotice(error.message);
      return;
    }
    const list = (data ?? []) as Row[];
    setRows(list);
    setSelectedId((id) => (id && list.some((r) => r.id === id) ? id : list[0]?.id ?? null));
    await sign(list);
  }, [sb, filter, sign]);

  useEffect(() => {
    load();
  }, [load]);

  // Re-sign before the 60 s links expire.
  useEffect(() => {
    if (filter !== "pending") return;
    const t = setInterval(() => sign(rows), 50_000);
    return () => clearInterval(t);
  }, [filter, rows, sign]);

  useEffect(() => {
    sb.from("settings").select("value").eq("key", "uploads_enabled").maybeSingle()
      .then(({ data }) => setUploadsOn(data ? data.value !== false : null));
  }, [sb]);

  useEffect(() => {
    setDenyOpen(false);
    setReason("");
    setBlockDomain(false);
    setBlockHash(false);
  }, [selectedId]);

  async function post(path: string, id: string) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    return { ok: res.ok, message: body.message || (res.ok ? "Done." : `Error ${res.status}`) };
  }

  async function approve() {
    if (!selected || selected.status !== "pending" || busy) return;
    setBusy(true);
    const r = await post("/api/admin/approve", selected.id);
    setNotice(r.message);
    setBusy(false);
    if (r.ok) await load();
  }

  async function remove() {
    if (!selected || selected.status !== "approved" || busy) return;
    if (!window.confirm(`Remove ${selected.domain} from the flag?`)) return;
    setBusy(true);
    const r = await post("/api/admin/remove", selected.id);
    setNotice(r.message);
    setBusy(false);
    if (r.ok) await load();
  }

  async function deny() {
    if (!selected || selected.status !== "pending" || busy) return;
    setBusy(true);
    const { error } = await sb.rpc("deny_request", {
      p_id: selected.id,
      p_reason: reason.trim() || null,
      p_block_domain: blockDomain,
      p_block_hash: blockHash,
    });
    setBusy(false);
    setNotice(error ? error.message : "Denied.");
    if (!error) await load();
  }

  async function toggleUploads() {
    if (uploadsOn === null) return;
    const next = !uploadsOn;
    const { error } = await sb.rpc("set_setting", { p_key: "uploads_enabled", p_value: next });
    if (error) setNotice(error.message);
    else setUploadsOn(next);
  }

  async function signOut() {
    await sb.auth.signOut({ scope: "global" });
    window.location.assign("/admin/login");
  }

  // Keyboard: A approves, D denies, arrows move.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const i = rows.findIndex((r) => r.id === selectedId);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const j = Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
        if (rows[j]) setSelectedId(rows[j].id);
      } else if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        approve();
      } else if ((e.key === "d" || e.key === "D") && selected?.status === "pending") {
        e.preventDefault();
        setDenyOpen(true);
        setTimeout(() => reasonRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="admin">
      <header className="admin-head">
        <strong>flag.ar admin</strong>
        <nav className="tabs" aria-label="Filter">
          {FILTERS.map((f) => (
            <button
              key={f.key} className={`tab${filter === f.key ? " on" : ""}`} aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </nav>
        <label className="switch">
          <input type="checkbox" checked={uploadsOn === true} disabled={uploadsOn === null} onChange={toggleUploads} />
          <span>Uploads {uploadsOn ? "on" : "off"}</span>
        </label>
        <button className="btn ghost" onClick={signOut}>Sign out</button>
      </header>

      {notice && (
        <p className="notice" role="status" onClick={() => setNotice(null)}>{notice}</p>
      )}

      <div className="admin-body">
        <ul className="queue" aria-label="Requests">
          {rows.length === 0 && <li className="empty">Nothing here.</li>}
          {rows.map((r) => (
            <li key={r.id}>
              <button
                className={`queue-row${r.id === selectedId ? " on" : ""}`} onClick={() => setSelectedId(r.id)}
                aria-current={r.id === selectedId}
              >
                {thumbs[r.id]
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={thumbs[r.id]} alt="" width={40} height={40} />
                  : <span className="thumb-empty" />}
                <span className="queue-domain">{r.domain}</span>
                <span className="queue-age">{age(r.created_at)}</span>
              </button>
            </li>
          ))}
        </ul>

        {selected && (
          <aside className="side" aria-label={`Request ${selected.domain}`}>
            <div className="previews">
              {thumbs[selected.id] ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <div className="preview light"><img src={thumbs[selected.id]} alt="Logo on white" /></div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <div className="preview dark"><img src={thumbs[selected.id]} alt="Logo on dark" /></div>
                </>
              ) : (
                <p className="muted">No file. Denied files are deleted by the hourly job.</p>
              )}
            </div>
            <dl className="facts">
              <dt>Domain</dt><dd>{selected.domain}</dd>
              <dt>Link</dt><dd className="mono">{selected.website_url}</dd>
              <dt>Sent</dt><dd>{new Date(selected.created_at).toLocaleString()}</dd>
              {selected.reviewed_at && (<><dt>Reviewed</dt><dd>{new Date(selected.reviewed_at).toLocaleString()}</dd></>)}
              {selected.deny_reason && (<><dt>Reason</dt><dd>{selected.deny_reason}</dd></>)}
            </dl>
            <button
              className="btn ghost"
              onClick={() => window.open(selected.website_url, "_blank", "noopener,noreferrer")}
            >
              Open link in new tab
            </button>

            {selected.status === "pending" && (
              <div className="actions">
                <button className="btn primary" onClick={approve} disabled={busy}>Approve (A)</button>
                <button className="btn danger" onClick={() => setDenyOpen(true)} disabled={busy}>Deny (D)</button>
              </div>
            )}
            {selected.status === "pending" && denyOpen && (
              <form className="deny" onSubmit={(e) => { e.preventDefault(); deny(); }}>
                <label className="field">
                  <span>Reason (optional)</span>
                  <textarea ref={reasonRef} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={blockDomain} onChange={(e) => setBlockDomain(e.target.checked)} />
                  Block this domain
                </label>
                <label className="check">
                  <input type="checkbox" checked={blockHash} onChange={(e) => setBlockHash(e.target.checked)} />
                  Block this image
                </label>
                <button className="btn danger" disabled={busy}>Confirm deny</button>
              </form>
            )}
            {selected.status === "approved" && (
              <div className="actions">
                <button className="btn danger" onClick={remove} disabled={busy}>Remove from flag</button>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
