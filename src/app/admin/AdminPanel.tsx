"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browserClient } from "@/lib/client/supabase";
import { ACCEPT, prepareUpload } from "@/lib/flag/logoUpload";
import { categoryLabel } from "@/lib/startups/model";
import EditQueue from "./EditQueue";

type Status = "pending" | "approved" | "rejected";
type Filter = Status | "reported" | "edits";

interface Row {
  id: string;
  slug: string;
  name: string;
  city: string | null;
  category: string | null;
  link: string;
  domain: string;
  logo_path: string | null;
  bg_color: string;
  order_number: number;
  status: Status;
  featured: boolean;
  created_at: string;
  nsfw_score: number | null;
  report_count: number;
  reject_reason: string | null;
}

const FILES_BASE = process.env.NEXT_PUBLIC_FILES_BASE || "/files";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "reported", label: "Reported" },
  { key: "edits", label: "Edits" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

function age(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

export default function AdminPanel() {
  const sb = useMemo(() => browserClient(), []);
  const [filter, setFilter] = useState<Filter>("pending");
  const [rows, setRows] = useState<Row[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploadsOn, setUploadsOn] = useState<boolean | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [blockDomain, setBlockDomain] = useState(false);
  const [blockHash, setBlockHash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);

  const selected = rows.find((r) => r.id === selectedId) ?? null;

  const load = useCallback(async () => {
    if (filter === "edits") {
      // Change requests have their own list (EditQueue); the flag list and its keys stand down.
      setRows([]);
      return;
    }
    let q = sb.from("startups")
      .select("id, slug, name, city, category, link, domain, logo_path, bg_color, order_number, status, featured, created_at, nsfw_score, report_count, reject_reason");
    q = filter === "reported" ? q.gt("report_count", 0).neq("status", "rejected") : q.eq("status", filter);
    const { data, error } = await q.order("created_at", { ascending: filter === "pending" }).limit(300);
    if (error) {
      setNotice(error.message);
      return;
    }
    const list = (data ?? []) as Row[];
    setRows(list);
    setSelectedId((id) => (id && list.some((r) => r.id === id) ? id : list[0]?.id ?? null));
  }, [sb, filter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    sb.from("settings").select("value").eq("key", "uploads_enabled").maybeSingle()
      .then(({ data }) => setUploadsOn(data ? data.value !== false : null));
  }, [sb]);

  useEffect(() => {
    setRejectOpen(false);
    setReason("");
    setBlockDomain(false);
    setBlockHash(false);
  }, [selectedId]);

  async function act(action: string, extra: Record<string, unknown> = {}) {
    if (!selected || busy) return;
    setBusy(true);
    const res = await fetch("/api/admin/startups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: selected.id, action, ...extra }),
    });
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    setNotice(body.message || (res.ok ? "Done." : `Error ${res.status}`));
    setBusy(false);
    if (res.ok) await load();
  }

  // Same browser pipeline as the public form (background removal, trim), then the admin route stores it.
  async function replaceLogo(file: File | undefined) {
    if (!selected || !file || busy) return;
    setBusy(true);
    setNotice("Processing logo…");
    try {
      const { png } = await prepareUpload(file, true, setNotice);
      const form = new FormData();
      form.set("id", selected.id);
      form.set("logo", png, "logo.png");
      const res = await fetch("/api/admin/logo", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setNotice(body.message || (res.ok ? "Done." : `Error ${res.status}`));
      if (res.ok) await load();
    } catch {
      setNotice("Could not read that image.");
    } finally {
      setBusy(false);
      if (logoInput.current) logoInput.current.value = "";
    }
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

  // Keyboard: A approves, R rejects, arrows move.
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
      } else if ((e.key === "a" || e.key === "A") && selected?.status === "pending") {
        e.preventDefault();
        act("approve");
      } else if ((e.key === "r" || e.key === "R") && selected && selected.status !== "rejected") {
        e.preventDefault();
        setRejectOpen(true);
        setTimeout(() => reasonRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const logo = (r: Row) => (r.logo_path ? `${FILES_BASE}/${r.logo_path}` : null);

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
          <span>New flags {uploadsOn ? "on" : "off"}</span>
        </label>
        <button className="btn ghost" onClick={signOut}>Sign out</button>
      </header>

      {notice && <p className="notice" role="status" onClick={() => setNotice(null)}>{notice}</p>}

      {filter === "edits" && <EditQueue sb={sb} onNotice={setNotice} />}

      {filter !== "edits" && <div className="admin-body">
        <ul className="queue" aria-label="Flags">
          {rows.length === 0 && <li className="empty">Nothing here.</li>}
          {rows.map((r) => (
            <li key={r.id}>
              <button
                className={`queue-row${r.id === selectedId ? " on" : ""}`} onClick={() => setSelectedId(r.id)}
                aria-current={r.id === selectedId}
              >
                {logo(r)
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={logo(r)!} alt="" width={40} height={40} style={{ background: r.bg_color }} />
                  : <span className="thumb-empty" />}
                <span className="queue-domain">#{r.order_number} {r.name}</span>
                <span className="queue-age">
                  {r.report_count > 0 && `⚑${r.report_count} `}
                  {r.nsfw_score !== null && r.nsfw_score > 0.3 && `NSFW ${r.nsfw_score.toFixed(2)} `}
                  {age(r.created_at)}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {selected && (
          <aside className="side" aria-label={`Flag ${selected.name}`}>
            <div className="previews">
              {logo(selected) ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <div className="preview" style={{ background: selected.bg_color }}><img src={logo(selected)!} alt="Logo on its flag color" /></div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <div className="preview dark"><img src={logo(selected)!} alt="Logo on dark" /></div>
                </>
              ) : (
                <p className="muted">No logo (rejected logos are deleted).</p>
              )}
            </div>
            <dl className="facts">
              <dt>Name</dt><dd>{selected.name}</dd>
              <dt>Page</dt><dd><a href={`/${selected.slug}`} target="_blank" rel="noreferrer">/{selected.slug}</a></dd>
              <dt>Category</dt><dd>{categoryLabel(selected.category) ?? "—"}</dd>
              <dt>Domain</dt><dd>{selected.domain}</dd>
              <dt>Link</dt><dd className="mono">{selected.link}</dd>
              <dt>Sent</dt><dd>{new Date(selected.created_at).toLocaleString()}</dd>
              <dt>NSFW</dt><dd>{selected.nsfw_score === null ? "not checked yet" : selected.nsfw_score.toFixed(3)}</dd>
              <dt>Reports</dt><dd>{selected.report_count}</dd>
              {selected.reject_reason && (<><dt>Reason</dt><dd>{selected.reject_reason}</dd></>)}
            </dl>
            <button className="btn ghost" onClick={() => window.open(selected.link, "_blank", "noopener,noreferrer")}>
              Open link in new tab
            </button>

            <div className="actions">
              {selected.status === "pending" && (
                <button className="btn primary" onClick={() => act("approve")} disabled={busy}>Approve (A)</button>
              )}
              {selected.status !== "rejected" && (
                <button className="btn danger" onClick={() => setRejectOpen(true)} disabled={busy}>Reject (R)</button>
              )}
              {selected.status === "approved" && (
                <button className="btn ghost" onClick={() => act(selected.featured ? "unfeature" : "feature")} disabled={busy}>
                  {selected.featured ? "Unfeature" : "Feature"}
                </button>
              )}
              {selected.status !== "rejected" && (
                <>
                  <button className="btn ghost" onClick={() => logoInput.current?.click()} disabled={busy}>Replace logo</button>
                  <input
                    ref={logoInput} type="file" accept={ACCEPT} hidden
                    onChange={(e) => replaceLogo(e.target.files?.[0])}
                  />
                </>
              )}
              {selected.report_count > 0 && (
                <button className="btn ghost" onClick={() => act("clear-reports")} disabled={busy}>Clear reports</button>
              )}
            </div>
            {rejectOpen && selected.status !== "rejected" && (
              <form className="deny" onSubmit={(e) => { e.preventDefault(); act("reject", { reason, blockDomain, blockHash }); }}>
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
                <button className="btn danger" disabled={busy}>Confirm reject</button>
              </form>
            )}
          </aside>
        )}
      </div>}
    </div>
  );
}
