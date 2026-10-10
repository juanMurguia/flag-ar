"use client";

import { useState } from "react";
import { browserClient } from "@/lib/client/supabase";

type Step =
  | { kind: "password" }
  | { kind: "verify"; factorId: string }
  | { kind: "enroll"; factorId: string; qr: string; secret: string };

export default function LoginForm() {
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; next?: string; factorId?: string };
      if (!res.ok) {
        setError(body.message || "Sign-in failed.");
        return;
      }
      setPassword("");
      const sb = browserClient();
      if (body.next === "verify" && body.factorId) {
        setStep({ kind: "verify", factorId: body.factorId });
        return;
      }
      // First sign-in: enroll a TOTP factor. Drop any unfinished enrollment first.
      const { data: list } = await sb.auth.mfa.listFactors();
      for (const f of list?.all ?? []) {
        if (f.status === "unverified") await sb.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error: enrollErr } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "owner" });
      if (enrollErr || !data) {
        setError(enrollErr?.message || "Could not start TOTP setup.");
        return;
      }
      setStep({ kind: "enroll", factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (step.kind === "password") return;
    setBusy(true);
    setError(null);
    const { error: err } = await browserClient().auth.mfa.challengeAndVerify({
      factorId: step.factorId,
      code: code.trim(),
    });
    setBusy(false);
    if (err) {
      setError("The code is not correct.");
      return;
    }
    window.location.assign("/admin");
  }

  if (step.kind === "password") {
    return (
      <form className="panel" onSubmit={signIn}>
        <h1>Sign in</h1>
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} required
          />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary wide" disabled={busy}>Continue</button>
      </form>
    );
  }

  return (
    <form className="panel" onSubmit={verify}>
      <h1>{step.kind === "enroll" ? "Set up your authenticator" : "Enter your code"}</h1>
      {step.kind === "enroll" && (
        <>
          <p>Scan this code with your authenticator app. Then enter the 6-digit code.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="qr" src={step.qr} alt="TOTP QR code" width={180} height={180} />
          <p className="mono">{step.secret}</p>
        </>
      )}
      <label className="field">
        <span>6-digit code</span>
        <input
          inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
          value={code} onChange={(e) => setCode(e.target.value)} required autoFocus
        />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn primary wide" disabled={busy}>Verify</button>
    </form>
  );
}
