"use client";

import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { categoryLabel } from "@/lib/startups/model";

interface Flag {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  bg_color: string;
  logo_path: string | null;
}

interface Request {
  id: string;
  name: string;
  category: string | null;
  bg_color: string;
  logo_path: string | null;
  note: string | null;
  created_at: string;
  startup: Flag | null;
}

const FILES_BASE = process.env.NEXT_PUBLIC_FILES_BASE || "/files";
const file = (path: string | null) => (path ? `${FILES_BASE}/${path}` : null);

/** "Edits" tab: change requests from founders, the flag as it is next to the flag as they want it. */
export default function EditQueue({ sb, onNotice }: { sb: SupabaseClient; onNotice: (m: string) => void }) {
  const [rows, setRows] = useState<Request[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  const load = useCallback(async () => {
    const { data, error } = await sb
      .from("edit_requests")
      .select("id, name, category, bg_color, logo_path, note, created_at, startup:startups(id, slug, name, category, bg_color, logo_path)")
      .order("created_at", { ascending: true })
      .limit(300);
    if (error) {
      onNotice(error.message);
      return;
    }
    const list = (data ?? []) as unknown as Request[];
    setRows(list);
    setSelectedId((id) => (id && list.some((r) => r.id === id) ? id : list[0]?.id ?? null));
  }, [sb, onNotice]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(action: "apply" | "discard") {
    if (!selected || busy) return;
    setBusy(true);
    const res = await fetch("/api/admin/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: selected.id, action }),
    });
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    onNotice(body.message || (res.ok ? "Done." : `Error ${res.status}`));
    setBusy(false);
    if (res.ok) await load();
  }

  const cur = selected?.startup ?? null;
  const changed = (a: unknown, b: unknown) => (a !== b ? " changed" : "");

  return (
    <div className="admin-body">
      <ul className="queue" aria-label="Change requests">
        {rows.length === 0 && <li className="empty">No change requests.</li>}
        {rows.map((r) => (
          <li key={r.id}>
            <button
              className={`queue-row${r.id === selectedId ? " on" : ""}`} onClick={() => setSelectedId(r.id)}
              aria-current={r.id === selectedId}
            >
              {file(r.logo_path ?? r.startup?.logo_path ?? null)
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={file(r.logo_path ?? r.startup?.logo_path ?? null)!} alt="" width={40} height={40} style={{ background: r.bg_color }} />
                : <span className="thumb-empty" />}
              <span className="queue-domain">{r.startup?.name ?? "(flag gone)"}</span>
              <span className="queue-age">{new Date(r.created_at).toLocaleDateString()}</span>
            </button>
          </li>
        ))}
      </ul>

      {selected && (
        <aside className="side" aria-label="Change request">
          <div className="previews">
            {cur && (
              <figure>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <div className="preview" style={{ background: cur.bg_color }}>{file(cur.logo_path) && <img src={file(cur.logo_path)!} alt="Now" />}</div>
                <figcaption className="muted">Now</figcaption>
              </figure>
            )}
            <figure>
              <div className="preview" style={{ background: selected.bg_color }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {file(selected.logo_path ?? cur?.logo_path ?? null) && <img src={file(selected.logo_path ?? cur?.logo_path ?? null)!} alt="Requested" />}
              </div>
              <figcaption className="muted">Requested{selected.logo_path ? " (new logo)" : ""}</figcaption>
            </figure>
          </div>
          <dl className="facts">
            <dt>Page</dt><dd>{cur ? <a href={`/${cur.slug}`} target="_blank" rel="noreferrer">/{cur.slug}</a> : "—"}</dd>
            <dt>Name</dt><dd className={changed(selected.name, cur?.name)}>{cur?.name} → {selected.name}</dd>
            <dt>Category</dt>
            <dd className={changed(selected.category, cur?.category)}>
              {categoryLabel(cur?.category ?? null) ?? "—"} → {categoryLabel(selected.category) ?? "—"}
            </dd>
            <dt>Color</dt><dd className={changed(selected.bg_color, cur?.bg_color)}>{cur?.bg_color} → {selected.bg_color}</dd>
            {selected.note && (<><dt>Note</dt><dd>{selected.note}</dd></>)}
          </dl>
          <div className="actions">
            <button className="btn primary" onClick={() => act("apply")} disabled={busy || !cur}>Apply</button>
            <button className="btn danger" onClick={() => act("discard")} disabled={busy}>Discard</button>
          </div>
        </aside>
      )}
    </div>
  );
}
